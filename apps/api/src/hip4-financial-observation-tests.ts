import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { DEFAULT_VENUE_LIFECYCLE_POLICY, hip4Identity } from "@hunch/shared";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { readNativeSendCapacity } from "./funding/execution/hypercore-send-capacity.js";
import {
  readHip4FinancialObservation,
  readHip4OrderCapacity,
  readHip4OrderQuoteCapacity,
} from "./services/hip4-financial-observation.js";

const address = `0x${"Ab".repeat(20)}`;
const market = hip4Identity("mainnet", 1473);
function fixture() {
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "full" };
  const policies: Record<string, unknown> = {
    venue_lifecycle: lifecycle,
    hip4_read: { environment: "mainnet", enabled: false, outcomeAllowlist: [] },
    hip4_account: { snapshotMaxAgeMs: 60000, enabled: false },
  };
  const responses: Record<string, unknown> = {
    userRole: { role: "user" },
    userAbstraction: "disabled",
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
        {
          coin: "USDC",
          token: 0,
          total: "8.00000001",
          hold: "3",
          entryNtl: "0",
        },
        { coin: "+14730", total: "100", hold: "30", entryNtl: "75" },
        { coin: "+14731", total: "0.12345", hold: "0.00001", entryNtl: "99" },
      ],
    },
  };
  const calls: string[] = [],
    weights: number[] = [];
  let budget = true;
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes("from runtime_policies")) {
        const key = String(args[0]);
        assert.ok(Object.hasOwn(policies, key));
        return { rows: [{ id: key, payload: policies[key] }] };
      }
      assert.ok(
        sql.includes("insert into hip4_request_budget"),
        "no history writes or account cache fallback",
      );
      weights.push(Number(args[0]));
      return { rows: [], rowCount: budget ? 1 : 0 };
    },
  } as unknown as Pick<Pool, "query">;
  let beforeResponse: ((type: string) => void) | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.hyperliquid.xyz/info");
    const request = JSON.parse(String(init?.body));
    calls.push(request.type);
    assert.ok(Object.hasOwn(responses, request.type));
    if (request.type !== "spotMeta")
      assert.equal(request.user, address.toLowerCase());
    beforeResponse?.(request.type);
    return Response.json(responses[request.type]);
  };
  const input = {
    address,
    marketId: market.marketId,
    outcomeSide: "NO" as const,
    side: "SELL" as const,
  };
  return {
    pool,
    fetcher,
    input,
    calls,
    weights,
    responses,
    policies,
    setBudget: (value: boolean) => {
      budget = value;
    },
    onResponse: (fn: (type: string) => void) => {
      beforeResponse = fn;
    },
  };
}

test("funding and BUY share exact native Standard cash and same budgeted fresh reads", async () => {
  const f = fixture();
  const capacity = await readNativeSendCapacity(f.pool, address, f.fetcher);
  assert.equal(capacity.availableRaw, "500000001");
  assert.equal(
    Date.parse(capacity.expiresAt) - Date.parse(capacity.observedAt),
    60000,
  );
  assert.deepEqual(f.calls, [
    "userRole",
    "userAbstraction",
    "spotMeta",
    "spotClearinghouseState",
    "userAbstraction",
  ]);
  assert.deepEqual(f.weights, [60, 20, 20, 2, 20]);
  const buy = await readHip4OrderCapacity(
    f.pool,
    { ...f.input, side: "BUY" },
    f.fetcher,
  );
  assert.equal(buy.assetId, HYPERCORE_MAINNET_USDC.assetId);
  assert.equal(buy.decimals, 8);
  assert.equal(buy.availableRaw, capacity.availableRaw);
  assert.match(buy.accountRevision, /^[0-9a-f]{64}$/u);
});

test("perps-source send observes its own Standard transferable cash; spot is not its capacity", async () => {
  const f = fixture();
  const now = Date.now();
  const summary = {
    accountValue: "9.962411",
    totalRawUsd: "9.962411",
    totalMarginUsed: "0",
    totalNtlPos: "0",
  };
  f.responses.clearinghouseState = {
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: "0",
    withdrawable: "9.96241099",
    assetPositions: [],
    time: now,
  };
  f.responses.spotClearinghouseState = { balances: [] };
  const cash = await readNativeSendCapacity(f.pool, address, f.fetcher, "");
  assert.equal(cash.availableRaw, "996241099");
  assert.deepEqual(f.calls, [
    "userRole",
    "userAbstraction",
    "spotMeta",
    "clearinghouseState",
    "userAbstraction",
  ]);
  assert.deepEqual(f.weights, [60, 20, 20, 2, 20]);
  assert.equal(
    (await readNativeSendCapacity(f.pool, address, f.fetcher)).availableRaw,
    "0",
  );
  f.responses.clearinghouseState = {
    ...(f.responses.clearinghouseState as object),
    assetPositions: [{}],
  };
  await assert.rejects(
    readNativeSendCapacity(f.pool, address, f.fetcher, ""),
    /native_perps_margin_inventory/,
  );
  f.responses.userAbstraction = "unifiedAccount";
  await assert.rejects(
    readNativeSendCapacity(f.pool, address, f.fetcher, ""),
    /native_cash_mode_unsupported/,
  );
});

test("SELL uses exact side's raw unheld quantity, not opposite shares or entry notional", async () => {
  const f = fixture();
  const no = await readHip4OrderCapacity(f.pool, f.input, f.fetcher);
  assert.equal(no.assetId, market.sides[1].tokenId);
  assert.equal(no.decimals, 5);
  assert.equal(no.availableRaw, "12344");
  const yes = await readHip4OrderCapacity(
    f.pool,
    { ...f.input, outcomeSide: "YES" },
    f.fetcher,
  );
  assert.equal(yes.availableRaw, "7000000");
  f.responses.spotClearinghouseState = { balances: [] };
  assert.equal(
    (await readHip4OrderCapacity(f.pool, f.input, f.fetcher)).availableRaw,
    "0",
  );
});

test("first BUY can quote zero before funding, while prepare/send/SELL still require Standard", async () => {
  const f = fixture();
  f.responses.userRole = { role: "missing" };
  f.responses.userAbstraction = "default";
  f.responses.spotClearinghouseState = { balances: [] };
  const input = { ...f.input, side: "BUY" as const };
  const capacity = await readHip4OrderQuoteCapacity(f.pool, input, f.fetcher);
  assert.equal(capacity.availableRaw, "0");
  assert.equal(capacity.decimals, 8);
  await assert.rejects(
    readHip4OrderCapacity(f.pool, input, f.fetcher),
    /native_account_role_unsupported/u,
  );
  await assert.rejects(
    readNativeSendCapacity(f.pool, address, f.fetcher),
    /native_account_role_unsupported/u,
  );
  await assert.rejects(
    readHip4OrderQuoteCapacity(f.pool, f.input, f.fetcher),
    /native_account_role_unsupported/u,
  );
  for (const balance of [
    { coin: "USDC", token: 0, total: "0", hold: "0", entryNtl: "0" },
    { coin: "+14730", total: "1", hold: "0", entryNtl: "0" },
    { coin: "UNKNOWN", token: 900, total: "0", hold: "0", entryNtl: "0" },
  ]) {
    f.responses.spotClearinghouseState = { balances: [balance] };
    await assert.rejects(
      readHip4OrderQuoteCapacity(f.pool, input, f.fetcher),
      /native_cash_/u,
    );
  }
  Object.assign(f.responses, {
    userRole: { role: "user" },
    userAbstraction: "disabled",
    spotClearinghouseState: {
      balances: [
        { coin: "USDC", token: 0, total: "10", hold: "0", entryNtl: "0" },
      ],
    },
  });
  assert.equal(
    (await readHip4OrderCapacity(f.pool, input, f.fetcher)).availableRaw,
    "1000000000",
  );
});

test("read policy does not override common lifecycle; disabled and malformed policies stop before provider IO", async () => {
  for (const value of ["unreleased", "broken"] as const) {
    const f = fixture();
    const policy = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
    f.policies.venue_lifecycle =
      value === "unreleased" ? policy : { invalid: true };
    await assert.rejects(readNativeSendCapacity(f.pool, address, f.fetcher));
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.policies.hip4_account = { snapshotMaxAgeMs: -1 };
  await assert.rejects(readHip4OrderCapacity(f.pool, f.input, f.fetcher));
  assert.deepEqual(f.calls, []);
  f.policies.hip4_account = { snapshotMaxAgeMs: 60000 };
  assert.equal(
    (await readHip4OrderCapacity(f.pool, f.input, f.fetcher)).availableRaw,
    "12344",
  );
});

test("unsupported cash modes/roles, mode changes and exhausted shared budget recover without cached balances", async () => {
  for (const mode of [
    "default",
    "unifiedAccount",
    "dexAbstraction",
    "portfolioMargin",
  ]) {
    const f = fixture();
    f.responses.userAbstraction = mode;
    await assert.rejects(
      readHip4OrderCapacity(f.pool, f.input, f.fetcher),
      /native_cash_mode_unsupported/u,
    );
  }
  const f = fixture();
  f.responses.userRole = { role: "vault" };
  await assert.rejects(
    readNativeSendCapacity(f.pool, address, f.fetcher),
    /native_account_role_unsupported/u,
  );
  f.responses.userRole = { role: "user" };
  f.setBudget(false);
  await assert.rejects(
    readNativeSendCapacity(f.pool, address, f.fetcher),
    /budget_exhausted/u,
  );
  f.setBudget(true);
  f.onResponse((type) => {
    if (type === "spotClearinghouseState")
      f.responses.userAbstraction = "unifiedAccount";
  });
  await assert.rejects(
    readNativeSendCapacity(f.pool, address, f.fetcher),
    /native_cash_mode_changed/u,
  );
  f.onResponse(() => {});
  f.responses.userAbstraction = "disabled";
  assert.equal(
    (await readNativeSendCapacity(f.pool, address, f.fetcher)).availableRaw,
    "500000001",
  );
});

test("no provider reads for wrong network/side/id, and ambiguous quote identity never supplies cash", async () => {
  for (const marketId of [
    "hyperliquid:testnet:outcome:1473",
    "hyperliquid:mainnet:outcome:01473",
    "hyperliquid:mainnet:outcome:9999999999999999",
  ]) {
    const f = fixture();
    await assert.rejects(
      readHip4OrderCapacity(f.pool, { ...f.input, marketId }, f.fetcher),
    );
    assert.deepEqual(f.calls, []);
  }
  for (const duplicate of [true, false]) {
    const f = fixture();
    const quote = {
      name: "USDC",
      index: 0,
      tokenId: HYPERCORE_MAINNET_USDC.assetId,
      szDecimals: 8,
      weiDecimals: 8,
    };
    f.responses.spotMeta = {
      tokens: duplicate ? [quote, quote] : [{ ...quote, weiDecimals: 6 }],
    };
    await assert.rejects(
      readNativeSendCapacity(f.pool, address, f.fetcher),
      /native_cash_identity_mismatch/u,
    );
  }
});

test("missing/malformed or debt-bearing snapshots are unavailable, not zero SELL capacity", async () => {
  for (const state of [
    null,
    {},
    { balances: [{ coin: "+14731", total: "1", hold: "2", entryNtl: "0" }] },
    {
      balances: [
        {
          coin: "USDC",
          token: 0,
          total: "9",
          hold: "0",
          entryNtl: "0",
          borrowed: "1",
        },
      ],
    },
  ]) {
    const f = fixture();
    f.responses.spotClearinghouseState = state;
    await assert.rejects(readHip4OrderCapacity(f.pool, f.input, f.fetcher));
  }
});

test("SELL rejects target-side borrowed/supplied inventory, not unrelated side's debt", async () => {
  for (const field of ["borrowed", "supplied"]) {
    const f = fixture();
    f.responses.spotClearinghouseState = {
      balances: [
        {
          coin: "+14731",
          total: "100",
          hold: "0",
          entryNtl: "0",
          [field]: "100",
        },
        { coin: "+14730", total: "5", hold: "2", entryNtl: "0" },
      ],
    };
    await assert.rejects(
      readHip4OrderCapacity(f.pool, f.input, f.fetcher),
      /position_capacity_unverified/u,
    );
    assert.equal(
      (
        await readHip4OrderCapacity(
          f.pool,
          { ...f.input, outcomeSide: "YES" },
          f.fetcher,
        )
      ).availableRaw,
      "300000",
    );
    assert.equal(
      (await readNativeSendCapacity(f.pool, address, f.fetcher)).availableRaw,
      "0",
      "outcome debt does not widen native cash rules",
    );
    f.responses.spotClearinghouseState = {
      balances: [
        {
          coin: "+14731",
          total: "100",
          hold: "1",
          entryNtl: "0",
          [field]: "0",
        },
      ],
    };
    assert.equal(
      (await readHip4OrderCapacity(f.pool, f.input, f.fetcher)).availableRaw,
      "9900000",
      "corrected target inventory recovers without housekeeping",
    );
  }
});

test("slow provider cannot timestamp an expired observation as fresh", async (t) => {
  const f = fixture();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.onResponse((type) => {
    if (type === "spotClearinghouseState")
      t.mock.method(Date, "now", () => now + 60000);
  });
  await assert.rejects(
    readHip4FinancialObservation(f.pool, address, f.fetcher),
    /native_cash_stale_snapshot/u,
  );
});
