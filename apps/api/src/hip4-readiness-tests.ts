import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { DEFAULT_VENUE_LIFECYCLE_POLICY, hip4Identity } from "@hunch/shared";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { HIP4_ORDER_CONTROLLER_SQL } from "./repos/hip4-order-controller.js";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import { createHyperliquidTradingExecutionService } from "./services/hyperliquid-trading-execution-service.js";
import type { TradingReadinessInput } from "./services/trading-types.js";

const userId = "00000000-0000-4000-8000-000000000001";
const controllerWalletRef = "00000000-0000-4000-8000-000000000002";
const address = `0x${"Ab".repeat(20)}`;
const identity = hip4Identity("mainnet", 1473);
const defaultSpotFixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/hip4/default-spot-cash-observations-20261018.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function storedObservation(observedAt = Date.now() - 1000) {
  return projectHip4Account({
    environment: "mainnet",
    role: "user",
    mode: "default",
    observedAt: new Date(observedAt).toISOString(),
    quote: {
      tokenId: HYPERCORE_MAINNET_USDC.assetId,
      index: 0,
      weiDecimals: 8,
    },
    state: defaultSpotFixture.spotClearinghouseState,
    defaultSpotCashEvidence: {
      legacyDexAbstraction: null,
      borrowLendState: defaultSpotFixture.borrowLendUserState,
    },
  });
}

function fixture() {
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "full" };
  const policies: Record<string, unknown> = {
    venue_lifecycle: lifecycle,
    hip4_read: {},
    hip4_account: { snapshotMaxAgeMs: 60000 },
  };
  const calls: string[] = [];
  const weights: number[] = [];
  const state = {
    owned: true,
    observation: storedObservation() as unknown,
    snapshotError: null as Error | null,
    snapshotReads: 0,
  };
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      if (sql === HIP4_ORDER_CONTROLLER_SQL) {
        assert.deepEqual(args, [controllerWalletRef, userId]);
        return {
          rows: state.owned
            ? [
                {
                  wallet_address: address,
                  wallet_source: "external",
                  privy_wallet_id: null,
                },
              ]
            : [],
        };
      }
      if (sql.includes("from runtime_policies")) {
        const key = String(args[0]);
        assert.ok(Object.hasOwn(policies, key));
        return { rows: [{ id: key, payload: policies[key] }] };
      }
      if (sql.includes("from hip4_account_snapshots")) {
        assert.deepEqual(args, ["mainnet", address.toLowerCase()]);
        state.snapshotReads++;
        if (state.snapshotError) throw state.snapshotError;
        return { rows: [{ observation: state.observation }] };
      }
      assert.ok(sql.includes("insert into hip4_request_budget"));
      weights.push(Number(args[0]));
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  const responses: Record<string, unknown> = {
    ...defaultSpotFixture,
    spotMeta: {
      tokens: [
        {
          name: "USDC",
          index: 0,
          tokenId: HYPERCORE_MAINNET_USDC.assetId,
          szDecimals: 8,
          weiDecimals: 8,
        },
      ],
    },
    spotClearinghouseState: {
      balances: [
        { coin: "USDC", token: 0, total: "9", hold: "0", entryNtl: "0" },
        { coin: "+14731", total: "2", hold: "0.5", entryNtl: "0" },
      ],
    },
  };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.hyperliquid.xyz/info");
    const request = JSON.parse(String(init?.body));
    assert.ok(Object.hasOwn(responses, request.type));
    if (request.type !== "spotMeta")
      assert.equal(request.user, address.toLowerCase());
    calls.push(request.type);
    return Response.json(responses[request.type]);
  };
  const service = createHyperliquidTradingExecutionService(
    { pool },
    { fetcher },
  );
  const request: TradingReadinessInput = {
    actor: { kind: "web_app", userId },
    venue: "hyperliquid",
    walletAddress: address,
    controllerWalletRef,
    action: "BUY",
    target: {
      venue: "hyperliquid",
      marketId: identity.marketId,
      venueMarketId: null,
      eventId: null,
      tokenId: identity.sides[1].tokenId,
      outcome: "NO",
      title: null,
    },
  };
  return { service, request, state, policies, calls, weights };
}

test("BUY readiness reuses only the owned exact-address qualified default cash with its original deadline", async () => {
  const f = fixture();
  const observation = storedObservation();
  f.state.observation = observation;
  const readiness = await f.service.getReadiness(f.request);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.executable, true);
  const raw = readiness.raw as {
    observation: {
      availableRaw: string;
      observedAt: string;
      expiresAt: string;
    };
    admissionRequired: boolean;
  };
  assert.equal(raw.admissionRequired, true);
  assert.equal(raw.observation.availableRaw, "712345678");
  assert.equal(raw.observation.observedAt, observation.observedAt);
  assert.equal(
    raw.observation.expiresAt,
    new Date(Date.parse(observation.observedAt) + 60000).toISOString(),
  );
  assert.equal(f.state.snapshotReads, 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.weights, []);
});

test("BUY readiness falls back to fresh native facts for absent, stale, unknown or malformed stored cash", async () => {
  const unknown = storedObservation();
  unknown.cash.ownedCash = null;
  const wrongAsset = storedObservation();
  wrongAsset.cash.assetId = "wrong";
  const plainBalance = { cash: { total: "7.12345678" } };
  for (const observation of [
    null,
    {},
    storedObservation(Date.now() - 60001),
    unknown,
    wrongAsset,
    plainBalance,
  ]) {
    const f = fixture();
    f.state.observation = observation;
    const readiness = await f.service.getReadiness(f.request);
    assert.equal(readiness.ready, true);
    assert.equal(
      (readiness.raw as { observation: { availableRaw: string } }).observation
        .availableRaw,
      "900000000",
    );
    assert.ok(f.calls.includes("userRole"));
    assert.equal(
      f.calls.filter((type) => type === "userAbstraction").length,
      2,
    );
    assert.equal(
      f.calls.filter((type) => type === "userDexAbstraction").length,
      2,
    );
    assert.equal(
      f.weights.reduce((sum, weight) => sum + weight, 0),
      182,
    );
  }
});

test("SELL readiness never substitutes stored USDC for fresh exact-outcome inventory", async () => {
  const f = fixture();
  const readiness = await f.service.getReadiness({
    ...f.request,
    action: "SELL",
  });
  assert.equal(readiness.ready, true);
  assert.equal(f.state.snapshotReads, 0);
  assert.equal(
    (readiness.raw as { observation: { availableRaw: string } }).observation
      .availableRaw,
    "150000",
  );
  assert.equal(
    f.weights.reduce((sum, weight) => sum + weight, 0),
    182,
  );
});

test("stored BUY readiness cannot bypass controller ownership, wallet matching or exact outcome identity", async () => {
  const f = fixture();
  const target = f.request.target;
  assert.ok(target);
  f.state.owned = false;
  await assert.rejects(
    f.service.getReadiness(f.request),
    /hip4_controller_unavailable/u,
  );
  f.state.owned = true;
  assert.equal(
    (
      await f.service.getReadiness({
        ...f.request,
        walletAddress: `0x${"cd".repeat(20)}`,
      })
    ).reasonCode,
    "wallet_mismatch",
  );
  for (const marketId of ["other:1473", "hyperliquid:testnet:outcome:1473"]) {
    await assert.rejects(
      f.service.getReadiness({
        ...f.request,
        target: { ...target, marketId },
      }),
      /hip4_capacity_identity_invalid/u,
    );
  }
  assert.equal(
    (
      await f.service.getReadiness({
        ...f.request,
        target: { ...target, outcome: "UNKNOWN" },
      })
    ).reasonCode,
    "invalid_trade_request",
  );
  assert.equal(f.state.snapshotReads, 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.weights, []);
});

test("BUY readiness respects the current read environment and freshness policy", async () => {
  const f = fixture();
  f.policies.hip4_read = { environment: "testnet" };
  await assert.rejects(
    f.service.getReadiness(f.request),
    /native_account_read_unavailable/u,
  );
  assert.equal(f.state.snapshotReads, 0);
  assert.equal(f.calls.length, 0);
  f.policies.hip4_read = {};
  f.policies.hip4_account = { snapshotMaxAgeMs: 1000 };
  f.state.observation = storedObservation(Date.now() - 1500);
  const readiness = await f.service.getReadiness(f.request);
  assert.equal(readiness.ready, true);
  assert.ok(f.calls.includes("spotClearinghouseState"));
});

test("operational snapshot failures are not mistaken for an invalid legacy observation", async () => {
  const f = fixture();
  f.state.snapshotError = new Error("snapshot_database_unavailable");
  await assert.rejects(
    f.service.getReadiness(f.request),
    /snapshot_database_unavailable/u,
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.weights, []);
});
