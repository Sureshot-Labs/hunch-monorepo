import assert from "node:assert/strict";
import { test } from "node:test";
import { hypercoreSpotCashCapacity } from "./funding/domain/hypercore-cash-capacity.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import { projectHip4AccountValue } from "./account-value/hip4-account-value.js";
import { projectCashAvailability } from "./account-value/cash-availability-projector.js";
import {
  applyFundingSourceDebitSuppression,
  loadFundingNativeSnapshotDebits,
  type FundingInTransitFact,
} from "./account-value/funding-movement-feed.js";
import { ExistingFactsOwnershipResolver } from "./account-value/ownership-resolver.js";
import {
  canonicalLocationKey,
  stableOpaqueId,
  hypercoreSpotAccountLocation,
} from "./account-value/canonical.js";
import { unavailableSessionSourceLocationIds } from "./funding/planner/session-source-account.js";
import type { AccountValueReadModel } from "./account-value/runtime-service.js";
import type { Hip4OwnedPortfolioRead } from "./services/hip4-portfolio-positions.js";
import {
  resolveStableImpairmentState,
  STABLE_IMPAIRED_PRICE_POLICY_ID,
} from "./account-value/valuation-service.js";

const now = Date.parse("2026-10-14T16:00:00Z");
const userId = "cash-user";
const address = `0x${"Ab".repeat(20)}`;
const snapshot = () =>
  projectHip4Account({
    environment: "mainnet",
    role: "user",
    mode: "disabled",
    observedAt: new Date(now).toISOString(),
    quote: {
      tokenId: HYPERCORE_MAINNET_USDC.assetId,
      index: 0,
      weiDecimals: 8,
    },
    state: {
      balances: [
        {
          coin: "USDC",
          token: 0,
          total: "100.00000001",
          hold: "3",
          entryNtl: "0",
        },
      ],
    },
  });
const capacity = (observation = snapshot(), at = now) =>
  hypercoreSpotCashCapacity({
    observation,
    environment: "mainnet",
    snapshotMaxAgeMs: 60000,
    now: at,
  });
const read = (observation = snapshot()): Hip4OwnedPortfolioRead => ({
  environment: "mainnet",
  snapshotMaxAgeMs: 60000,
  accounts: [{ address, observation }],
  positions: [],
  coverage: {
    state: "ready",
    policyRevision: "test",
    accounts: 1,
    missingAccounts: 0,
    staleAccounts: 0,
    unresolvedBalances: 0,
    missingCostBasis: 0,
    unpricedPositions: 0,
  },
});

test("native cash follows the same stable impairment policy as in-transit cash", () => {
  const result = projectHip4AccountValue({
    userId,
    read: read(),
    now,
    stableState: resolveStableImpairmentState(
      STABLE_IMPAIRED_PRICE_POLICY_ID,
      new Date(now).toISOString(),
    ),
  });
  assert.equal(result.assets[0].amount.raw, "10000000001");
  assert.equal(result.assets[0].estimatedUsd, null);
  assert.ok(result.assets[0].reasonCodes.includes("stable_asset_impaired"));
  const available = projectCashAvailability({
    components: result.assets,
    adjustments: result.availability.map((row) => ({
      ...row,
      reservedRaw: "0",
      submittedDebitRaw: "0",
    })),
    asOf: new Date(now).toISOString(),
  });
  assert.equal(available.components[0].availableEstimatedUsd, null);
  assert.equal(available.components[0].freshness, "stale");
  assert.equal(
    projectHip4AccountValue({
      userId,
      read: read(),
      now,
      stableState: { status: "healthy" },
    }).assets[0].estimatedUsd?.value,
    "100.00000001",
  );
});

test("a valid native binding cannot lend its profile to a second foreign account", async () => {
  const binding = {
    venueId: "hyperliquid",
    controllerAddress: address,
    executionAddress: address,
    accountRef: address,
    settlementAsset: HYPERCORE_MAINNET_USDC,
    signingMode: "web_client" as const,
  };
  const ownership = await new ExistingFactsOwnershipResolver({
    wallets: [
      {
        address,
        walletType: "ethereum",
        source: "external",
        linkedAddress: address,
        controllerWalletRef: "controller",
        serverWalletRef: null,
      },
    ],
    venueBindings: [
      binding,
      { ...binding, accountRef: `0x${"cc".repeat(20)}` },
      { ...binding, executionAddress: `0x${"cc".repeat(20)}` },
    ],
  }).resolve(userId);
  assert.equal(ownership.venueBindings.length, 1);
  assert.equal(ownership.venueBindings[0].accountRef, address);
});

test("Standard spot capacity is exact USDC8, including holds and huge integers", () => {
  assert.deepEqual(capacity(), {
    known: true,
    totalRaw: "10000000001",
    lockedRaw: "300000000",
    availableRaw: "9700000001",
  });
  const row = snapshot();
  row.cash.total = "9007199254740993.00000001";
  row.cash.unheld = row.cash.ownedCash = "9007199254740990.00000001";
  assert.deepEqual(capacity(row), {
    known: true,
    totalRaw: "900719925474099300000001",
    lockedRaw: "300000000",
    availableRaw: "900719925474099000000001",
  });
});

test("No fallback to Standard for unverified modes, liabilities or missing facts; normal refresh recovers", () => {
  for (const mode of [
    "default",
    "dexAbstraction",
    "unifiedAccount",
    "portfolioMargin",
  ] as const) {
    const row = snapshot();
    row.mode = mode;
    row.cash.availableAfterMaintenance = "100";
    row.cash.borrowed = "0";
    assert.deepEqual(capacity(row), {
      known: false,
      reason: "unsupported_cash_mode",
    });
  }
  for (const patch of [
    { ownedCash: null },
    { unheld: "999" },
    { held: "101" },
    { borrowed: "0.00000001" },
    { supplied: "1" },
    { total: "-1" },
    { total: "1.000000001" },
  ]) {
    const row = snapshot();
    Object.assign(row.cash, patch);
    assert.equal(capacity(row).known, false);
  }
  assert.equal(capacity(snapshot(), now - 1).known, false);
  assert.equal(capacity(snapshot(), now + 60000).known, false);
  assert.equal(capacity().known, true);
});

test("Unknown/mismatched cash is not a valued or usable native stablecoin", () => {
  const row = snapshot();
  row.cash.assetId = `0x${"11".repeat(16)}`;
  assert.deepEqual(capacity(row), {
    known: false,
    reason: "invalid_cash_identity",
  });
  assert.equal(
    projectHip4AccountValue({ userId, read: read(row), now }).assets[0]
      .estimatedUsd,
    null,
  );
  assert.equal(
    hypercoreSpotCashCapacity({
      observation: snapshot(),
      environment: "testnet",
      snapshotMaxAgeMs: 60000,
      now,
    }).known,
    false,
  );
});

test("P2 physical identity survives controller and mode changes, without a perps mirror", async () => {
  const bare = projectHip4AccountValue({ userId, read: read(), now });
  const ownership = await new ExistingFactsOwnershipResolver({
    wallets: [
      {
        address,
        walletType: "ethereum",
        source: "external",
        linkedAddress: address,
        controllerWalletRef: "verified-controller",
        serverWalletRef: null,
      },
    ],
    venueBindings: [
      {
        venueId: "hyperliquid",
        controllerAddress: address,
        executionAddress: address,
        accountRef: address,
        settlementAsset: HYPERCORE_MAINNET_USDC,
        signingMode: "web_client",
      },
    ],
  }).resolve(userId);
  const native = ownership.wallets.find(
    (profile) => profile.networkId === HYPERCORE_MAINNET_USDC.networkId,
  );
  assert.ok(native);
  assert.equal(native.evmAtomicBatchMode, null);
  assert.deepEqual(native.sponsorshipPolicyIds, []);
  const bound = projectHip4AccountValue({
    userId,
    read: read(),
    now,
    wallets: ownership.wallets,
  });
  const row = snapshot();
  row.mode = "unifiedAccount";
  row.cash.borrowed = "0";
  const unified = projectHip4AccountValue({
    userId,
    read: read(row),
    now,
    wallets: ownership.wallets,
  });
  assert.equal(bound.assets.length, 1);
  assert.equal(bound.assets[0].componentId, bare.assets[0].componentId);
  assert.equal(unified.assets[0].componentId, bare.assets[0].componentId);
  assert.equal(
    bound.assets[0].location.locationId,
    ownership.venueBindings[0].settlementLocation.locationId,
  );
  assert.equal(
    bound.assets[0].location.details.controllerWalletId,
    native.walletId,
  );
  assert.equal(
    bound.assets[0].componentId,
    stableOpaqueId("asset", canonicalLocationKey(bound.assets[0].location)),
  );
  assert.equal(unified.availability[0].availabilityKnown, false);
  assert.equal(bound.availability[0].availabilityKnown, true);
  const account = {
    projection: { components: bound.assets },
    ownership,
  } as unknown as AccountValueReadModel;
  assert.deepEqual(unavailableSessionSourceLocationIds(account, []), [
    bound.assets[0].location.locationId,
  ]);
  assert.deepEqual(
    unavailableSessionSourceLocationIds(account, ["verified-controller"]),
    [],
  );
  assert.equal(
    hypercoreSpotAccountLocation({
      accountId: userId,
      address: address.toLowerCase(),
      controllerWalletId: null,
    }).location.locationId,
    bare.assets[0].location.locationId,
  );
});

test("Derived funders and missing controller bindings never gain native signing profiles", async () => {
  for (const source of ["smart", "external"] as const) {
    const ownership = await new ExistingFactsOwnershipResolver({
      wallets: [
        {
          address,
          walletType: "ethereum",
          source,
          linkedAddress: `0x${"cc".repeat(20)}`,
          controllerWalletRef: "controller",
          serverWalletRef: null,
        },
      ],
      venueBindings: [
        {
          venueId: "hyperliquid",
          controllerAddress: address,
          executionAddress: address,
          accountRef: address,
          settlementAsset: HYPERCORE_MAINNET_USDC,
          signingMode: "web_client",
        },
      ],
    }).resolve(userId);
    assert.ok(
      ownership.wallets.every(
        (row) => !row.networkId.startsWith("hyperliquid:"),
      ),
    );
    assert.equal(ownership.venueBindings.length, 0);
  }
});

test("Common adjustments subtract venue hold, Hunch reservation and newer debit once", () => {
  const projected = projectHip4AccountValue({ userId, read: read(), now });
  const source = projected.assets[0];
  const debit: FundingInTransitFact = {
    operationId: "op",
    segmentId: null,
    sourceComponentId: source.componentId,
    sourceLocationId: source.location.locationId,
    amount: { asset: HYPERCORE_MAINNET_USDC, raw: "500000000" },
    observedAt: new Date(now + 1000).toISOString(),
  };
  const headline = applyFundingSourceDebitSuppression(projected.assets, [
    debit,
  ]);
  assert.equal(headline[0].amount.raw, "9500000001");
  const available = projectCashAvailability({
    components: projected.assets,
    adjustments: projected.availability.map((row) => ({
      ...row,
      reservedRaw: "200000000",
      submittedDebitRaw: debit.amount.raw,
    })),
    asOf: new Date(now).toISOString(),
  });
  assert.equal(available.components[0].availableRaw, "9000000001");
  assert.equal(available.byVenueEstimatedUsd.hyperliquid, "90.00000001");
  const old = { ...debit, observedAt: new Date(now - 1000).toISOString() };
  assert.equal(
    applyFundingSourceDebitSuppression(projected.assets, [old, debit])[0].amount
      .raw,
    "9500000001",
  );
  const unknown = projectCashAvailability({
    components: projected.assets,
    adjustments: projected.availability.map((row) => ({
      ...row,
      availabilityKnown: false,
      reservedRaw: "0",
      submittedDebitRaw: "0",
    })),
    asOf: new Date(now).toISOString(),
  });
  assert.equal(unknown.components[0].availableEstimatedUsd, null);
  assert.ok(
    unknown.components[0].reasonCodes.includes("cash_availability_unknown"),
  );
});

test("Native debit read skips stale or foreign snapshots, and sends exact indexed identity", async () => {
  const projected = projectHip4AccountValue({ userId, read: read(), now });
  const calls: unknown[][] = [];
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      calls.push(values);
      return { rows: [] };
    },
  };
  await loadFundingNativeSnapshotDebits(
    pool as never,
    userId,
    projected.assets,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0][1]))[0], {
    component_id: projected.assets[0].componentId,
    location_id: projected.assets[0].location.locationId,
    address: address.toLowerCase(),
    asset_decimals: 8,
    snapshot_at: new Date(now).toISOString(),
  });
  await loadFundingNativeSnapshotDebits(
    pool as never,
    "other-user",
    projected.assets,
  );
  await loadFundingNativeSnapshotDebits(
    pool as never,
    userId,
    projected.assets.map((row) => ({ ...row, observationFreshness: "stale" })),
  );
  assert.equal(calls.length, 1);
});
