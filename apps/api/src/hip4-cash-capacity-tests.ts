import assert from "node:assert/strict";
import { test } from "node:test";
import { hypercoreSpotCashCapacity } from "./funding/domain/hypercore-cash-capacity.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import {
  projectHip4AccountValue,
  collectHip4CashHoldAdjustments,
} from "./account-value/hip4-account-value.js";
import type { Pool } from "pg";
import { projectCashAvailability } from "./account-value/cash-availability-projector.js";
import {
  applyFundingSourceDebitSuppression,
  loadFundingNativeSnapshotDebits,
  loadFundingSnapshotDebits,
  fundingSnapshotDebitComponents,
  fundingRefundSnapshotLagOperations,
  fundingInvalidatedRefundComponentIds,
  fundingInvalidSourceComponentIds,
  fundingMovementErrors,
  buildFundingInTransitObservations,
  type FundingInTransitFact,
} from "./account-value/funding-movement-feed.js";
import { ExistingFactsOwnershipResolver } from "./account-value/ownership-resolver.js";
import { projectAccountValue } from "./account-value/account-value-projector.js";
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
  ValuationService,
} from "./account-value/valuation-service.js";
import { RELAY_ROUTE_SPECS } from "./funding-providers/relay/mappings.js";
import { POLYGON_USDCE_LEGACY } from "./funding-providers/relay/rehearsal.js";

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
const qualifiedDefaultSnapshot = (total = "2.990872", held = "0") =>
  projectHip4Account({
    environment: "mainnet",
    role: "user",
    mode: "default",
    observedAt: new Date(now).toISOString(),
    quote: {
      tokenId: HYPERCORE_MAINNET_USDC.assetId,
      index: 0,
      weiDecimals: 8,
    },
    state: {
      balances: [{ coin: "USDC", token: 0, total, hold: held, entryNtl: "0" }],
    },
    defaultSpotCashEvidence: {
      legacyDexAbstraction: null,
      borrowLendState: {
        tokenToState: [],
        health: "healthy",
        healthFactor: null,
      },
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

test("qualified default cash enters common availability without native-send authority or a second identity", () => {
  const observation = qualifiedDefaultSnapshot();
  const projected = projectHip4AccountValue({
    userId,
    read: read(observation),
    now,
  });
  const source = projected.assets[0];
  const available = projectCashAvailability({
    components: projected.assets,
    adjustments: projected.availability.map((row) => ({
      ...row,
      reservedRaw: "10000000",
      submittedDebitRaw: "20000000",
    })),
    asOf: new Date(now).toISOString(),
  });
  assert.equal(
    source.componentId,
    projectHip4AccountValue({ userId, read: read(), now }).assets[0]
      .componentId,
  );
  assert.equal(source.amount.raw, "299087200");
  assert.equal(source.observedAt, observation.observedAt);
  assert.equal(
    source.location.details.validUntil,
    new Date(now + 60000).toISOString(),
  );
  assert.equal(source.location.details.nativeAccountMode, "default");
  assert.equal(source.location.details.nativeOrderCashCapacityKnown, true);
  assert.equal(source.location.details.nativeOrderCashCapacityReason, null);
  assert.equal(
    source.location.details.cashAvailabilityPolicyId,
    "hypercore-order-cash-v1",
  );
  assert.equal(
    source.location.details.cashCapacityReason,
    "unsupported_cash_mode",
  );
  assert.equal(source.executionEligibility, "ineligible");
  assert.equal(capacity(observation).known, false);
  assert.equal(available.components[0].availableRaw, "269087200");
  assert.equal(available.cashAvailableEstimatedUsd, "2.690872");
  assert.equal(available.byVenueEstimatedUsd.hyperliquid, "2.690872");
  assert.equal(available.freshness, "fresh");
  assert.equal(available.completeness, "complete");
});

test("qualified default order cash keeps exact hold subtraction and known zero", () => {
  for (const [total, held, expected] of [
    ["2.990872", "0.09", "0.900872"],
    ["0", "0", "0"],
  ]) {
    const projected = projectHip4AccountValue({
      userId,
      read: read(qualifiedDefaultSnapshot(total, held)),
      now,
    });
    const available = projectCashAvailability({
      components: projected.assets,
      adjustments: projected.availability.map((row) => ({
        ...row,
        reservedRaw: "100000000",
        submittedDebitRaw: "100000000",
      })),
      asOf: new Date(now).toISOString(),
    });
    assert.equal(
      projected.assets[0].location.details.nativeOrderCashCapacityKnown,
      true,
    );
    assert.equal(available.cashAvailableEstimatedUsd, expected);
    assert.equal(available.freshness, "fresh");
  }
});

test("unverified, stale, borrowed and supplied default cash remain unknown; normal evidence refresh recovers", () => {
  const variants = [
    { cash: { ownedCash: null } },
    { cash: { unheld: null } },
    { cash: { borrowed: "0.00000001" } },
    { cash: { supplied: "0.00000001" } },
    { cash: { unheld: "999" } },
    { role: "missing" as const, cash: {} },
    { observedAt: new Date(now - 60000).toISOString(), cash: {} },
    { observedAt: new Date(now + 1).toISOString(), cash: {} },
  ];
  for (const variant of variants) {
    const observation = qualifiedDefaultSnapshot();
    const cashPatch = variant.cash;
    Object.assign(observation, variant, {
      cash: { ...observation.cash, ...cashPatch },
    });
    const projected = projectHip4AccountValue({
      userId,
      read: read(observation),
      now,
    });
    assert.equal(
      projected.assets[0].location.details.nativeOrderCashCapacityKnown,
      false,
    );
    const available = projectCashAvailability({
      components: projected.assets,
      adjustments: projected.availability.map((row) => ({
        ...row,
        reservedRaw: "0",
        submittedDebitRaw: "0",
      })),
      asOf: new Date(now).toISOString(),
    });
    assert.equal(available.cashAvailableEstimatedUsd, "0");
    assert.equal(available.components[0].availableEstimatedUsd, null);
    assert.equal(available.freshness, "stale");
  }
  assert.equal(
    projectHip4AccountValue({
      userId,
      read: read(qualifiedDefaultSnapshot()),
      now,
    }).availability[0].availabilityKnown,
    true,
  );
});

test("unsupported default perps remain unknown without making verified spot cash stale", () => {
  const observation = qualifiedDefaultSnapshot();
  observation.perpsCash = {
    observedAt: observation.observedAt,
    state: "unsupported",
    totalRaw: null,
    availableRaw: null,
    reason: "unsupported_cash_mode",
  };
  const projected = projectHip4AccountValue({
    userId,
    read: read(observation),
    now,
  });
  assert.equal(projected.assets.length, 1);
  assert.ok(
    projected.errors.some(
      (error) => error.code === "perps_unsupported_cash_mode",
    ),
  );
  const account = projectAccountValue({
    accountId: userId,
    headlineMode: "liquid_plus_positions",
    components: projected.assets,
    positionComponents: [],
    collectorErrors: projected.errors,
    asOf: new Date(now).toISOString(),
  });
  assert.equal(account.valuationCompleteness, "partial");
  // Runtime routes perps/position coverage errors to Account Value, not cash holds.
  const available = projectCashAvailability({
    components: projected.assets,
    adjustments: projected.availability.map((row) => ({
      ...row,
      reservedRaw: "0",
      submittedDebitRaw: "0",
    })),
    asOf: new Date(now).toISOString(),
  });
  assert.equal(available.cashAvailableEstimatedUsd, "2.990872");
  assert.equal(available.freshness, "fresh");
});

test("native Account Value hold-read failure makes availability unknown and recovers through the same preparation query", async () => {
  const projected = projectHip4AccountValue({ userId, read: read(), now });
  let failed = true;
  let queryCalls = 0;
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      queryCalls++;
      assert.equal(params[0], userId);
      assert.equal(
        JSON.parse(params[1] as string)[0].snapshot_at,
        new Date(now).toISOString(),
      );
      if (failed) throw new Error("private database detail must not leak");
      return {
        rows: [
          {
            reserved_raw: "200000000",
            submitted_debit_raw: "100000000",
            debit_alias_candidates: [],
          },
        ],
      };
    },
  } as unknown as Pick<Pool, "query">;
  const collect = () =>
    collectHip4CashHoldAdjustments({
      pool,
      userId,
      components: projected.assets,
      availability: projected.availability,
    });
  const broken = await collect();
  assert.deepEqual(broken.errors, [
    {
      collectorId: "hypercore-cash-holds",
      code: "cash_lock_collection_failed",
      retryable: true,
    },
  ]);
  const value = (facts: Awaited<ReturnType<typeof collect>>) =>
    projectCashAvailability({
      components: projected.assets,
      adjustments: [...facts.byComponent.values()],
      collectorErrors: facts.errors,
      asOf: new Date(now).toISOString(),
    });
  assert.equal(value(broken).cashAvailableEstimatedUsd, "0");
  assert.equal(value(broken).components[0].availableEstimatedUsd, null);
  assert.equal(projected.assets[0].estimatedUsd?.value, "100.00000001");
  failed = false;
  const repaired = await collect();
  assert.deepEqual(repaired.errors, []);
  assert.equal(value(repaired).cashAvailableEstimatedUsd, "94.00000001");
  const invalidSnapshot = projected.assets.map((asset) => ({
    ...asset,
    observedAt: new Date(Date.now() + 60000).toISOString(),
  }));
  const callsBeforeInvalidSnapshot = queryCalls;
  assert.equal(
    (
      await collectHip4CashHoldAdjustments({
        pool,
        userId,
        components: invalidSnapshot,
        availability: projected.availability,
      })
    ).byComponent.get(invalidSnapshot[0].componentId)?.availabilityKnown,
    false,
  );
  assert.equal(queryCalls, callsBeforeInvalidSnapshot);
});

test("invalid unregistered source claims keep the headline partial without relabeling the asset", async () => {
  const assets = projectHip4AccountValue({ userId, read: read(), now }).assets;
  const fact: FundingInTransitFact = {
    operationId: "unknown-source",
    segmentId: "segment",
    sourceComponentId: null,
    sourceLocationId: null,
    amount: {
      asset: {
        networkId: "evm:8453",
        assetId: `0x${"ab".repeat(20)}`,
        decimals: 6,
      },
      raw: "10000000",
    },
    observedAt: new Date(now).toISOString(),
    observationError: "funding_source_evidence_invalid",
  };
  const claim = await new ValuationService({
    policies: [],
    adapters: [],
  }).value(buildFundingInTransitObservations(userId, [fact]), new Date(now));
  assert.equal(claim[0].valuationEligibility, "excluded");
  assert.deepEqual(claim[0].amount.asset, fact.amount.asset);
  const projection = projectAccountValue({
    accountId: userId,
    headlineMode: "liquid_plus_positions",
    components: [...assets, ...claim],
    positionComponents: [],
    asOf: new Date(now).toISOString(),
    collectorErrors: fundingMovementErrors([fact, fact]),
  });
  assert.equal(projection.totalPortfolioEstimatedUsd, "100.00000001");
  assert.equal(projection.valuationCompleteness, "partial");
  assert.deepEqual(projection.collectorErrors, [
    {
      collectorId: "funding-in-transit",
      code: "funding_source_evidence_invalid",
      retryable: true,
    },
  ]);
  assert.equal(
    fundingMovementErrors([{ ...fact, observationError: null }]).length,
    0,
  );
});

test("missing reservation fences only the frozen owned physical source, with repair recovery", () => {
  const source = projectHip4AccountValue({ userId, read: read(), now })
    .assets[0];
  const unrelated = {
    ...source,
    componentId: "unrelated",
    location: { ...source.location, locationId: "other-location" },
  };
  const fact: FundingInTransitFact = {
    operationId: "missing-reservation",
    segmentId: "segment",
    sourceComponentId: null,
    sourceLocationId: null,
    committedSourceLocation: source.location,
    // The actual evidence is bad; do not use it to identify the frozen cash source.
    amount: { asset: { ...source.amount.asset, decimals: 6 }, raw: "10000000" },
    observedAt: new Date(now + 1000).toISOString(),
    observationError: "funding_source_evidence_invalid",
  };
  const project = (facts: readonly FundingInTransitFact[]) => {
    const invalid = fundingInvalidSourceComponentIds(userId, facts, [
      source,
      unrelated,
    ]);
    return projectCashAvailability({
      components: [source, unrelated],
      asOf: new Date(now).toISOString(),
      adjustments: [source, unrelated].map((component) => ({
        componentId: component.componentId,
        venueId: null,
        venueBindingId: null,
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw: "0",
        availabilityKnown: !invalid.has(component.componentId),
      })),
    });
  };
  const invalid = project([fact]);
  assert.equal(invalid.components[0].availableEstimatedUsd, null);
  assert.equal(invalid.components[0].availableRaw, "0");
  assert.equal(invalid.components[1].availableEstimatedUsd, "100.00000001");
  const repaired = project([{ ...fact, observationError: null }]);
  assert.equal(repaired.components[0].availableEstimatedUsd, "100.00000001");
  assert.equal(
    fundingInvalidSourceComponentIds(
      userId,
      [fact],
      [{ ...source, observedAt: new Date(now + 2000).toISOString() }],
    ).size,
    0,
    "a normal physical balance refresh restores cash independently of attribution repair",
  );
  const refreshed = {
    ...source,
    observedAt: new Date(now + 2000).toISOString(),
  };
  for (const snapshot of [
    { ...refreshed, observationFreshness: "stale" as const },
    { ...refreshed, observationFreshness: "unknown" as const },
    {
      ...refreshed,
      observationError: { code: "balance_read_failed", retryable: true },
    },
    { ...refreshed, observedAt: "invalid" },
  ])
    assert.equal(
      fundingInvalidSourceComponentIds(userId, [fact], [snapshot]).size,
      1,
    );
  assert.equal(
    fundingInvalidSourceComponentIds(
      userId,
      [{ ...fact, observedAt: "invalid" }],
      [refreshed],
    ).size,
    1,
  );
  assert.equal(
    fundingInvalidSourceComponentIds(
      userId,
      [
        fact,
        {
          ...fact,
          segmentId: "newer-sibling",
          observedAt: new Date(now + 3000).toISOString(),
        },
      ],
      [refreshed],
    ).size,
    1,
  );
  for (const location of [
    { ...source.location, accountId: "foreign" },
    { ...source.location, kind: "wrong-kind" },
    { ...source.location, asset: { ...source.location.asset, decimals: 6 } },
    {
      ...source.location,
      details: { ...source.location.details, address: `0x${"ef".repeat(20)}` },
    },
  ])
    assert.equal(
      fundingInvalidSourceComponentIds(
        userId,
        [{ ...fact, committedSourceLocation: location }],
        [source],
      ).size,
      0,
    );
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
    native_source_dex: "spot",
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

test("Shared snapshot debits admit registered Base/Polygon stable sources without merging their token identities", async () => {
  const native = projectHip4AccountValue({ userId, read: read(), now })
    .assets[0];
  const base = RELAY_ROUTE_SPECS["base-usdc-to-hypercore-spot-usdc"].source;
  const component = {
    ...native,
    componentId: "base-cash",
    location: {
      ...native.location,
      kind: "wallet" as const,
      locationId: "base-location",
      asset: base,
    },
    amount: { asset: base, raw: "100000000" },
  };
  const polygon =
    RELAY_ROUTE_SPECS["polygon-usdc-to-hypercore-spot-usdc"].source;
  assert.equal(
    fundingSnapshotDebitComponents(userId, [
      component,
      {
        ...component,
        location: { ...component.location, asset: polygon },
        amount: { asset: polygon, raw: "100000000" },
      },
      {
        ...component,
        location: {
          ...component.location,
          asset:
            RELAY_ROUTE_SPECS["polygon-pusd-to-hypercore-spot-usdc"].source,
        },
        amount: {
          asset:
            RELAY_ROUTE_SPECS["polygon-pusd-to-hypercore-spot-usdc"].source,
          raw: "100000000",
        },
      },
    ]).length,
    3,
  );
  for (const asset of [
    { ...base, decimals: 8 },
    { networkId: "evm:137", assetId: POLYGON_USDCE_LEGACY, decimals: 6 },
    { ...base, networkId: "evm:1" },
    { ...base, assetId: `0x${"ab".repeat(20)}` },
  ])
    assert.equal(
      fundingSnapshotDebitComponents(userId, [
        {
          ...component,
          location: { ...component.location, asset },
          amount: { asset, raw: "100000000" },
        },
      ]).length,
      0,
    );
  assert.equal(
    fundingSnapshotDebitComponents("wrong-owner", [component]).length,
    0,
  );
  assert.equal(
    fundingSnapshotDebitComponents(userId, [
      {
        ...component,
        observationError: { code: "read_failed", retryable: true },
      },
    ]).length,
    0,
  );
  let calls = 0;
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      calls++;
      assert.equal(values[0], userId);
      const [identity] = JSON.parse(String(values[1]));
      assert.equal(identity.network_id, base.networkId);
      assert.equal(identity.asset_id, base.assetId.toLowerCase());
      assert.equal(identity.asset_decimals, 6);
      return {
        rows: [
          {
            operation_id: "op",
            debit_id: "debit",
            strict_match: true,
            segment_id: null,
            source_component_id: component.componentId,
            source_location_id: component.location.locationId,
            network_id: base.networkId,
            asset_id: base.assetId,
            asset_decimals: 6,
            raw_amount: "10000000",
            observed_at: new Date(now + 1000),
          },
        ],
      };
    },
  };
  const debits = await loadFundingSnapshotDebits(pool as never, userId, [
    component,
  ]);
  assert.equal(calls, 1);
  assert.equal(
    applyFundingSourceDebitSuppression([component], debits)[0].amount.raw,
    "90000000",
  );
  assert.equal(
    applyFundingSourceDebitSuppression(
      [component],
      debits.map((row) => ({ ...row, sourceLocationId: "foreign" })),
    )[0].amount.raw,
    "100000000",
  );
  assert.equal(
    applyFundingSourceDebitSuppression(
      [component],
      debits.map((row) => ({
        ...row,
        amount: { ...row.amount, asset: { ...base, decimals: 8 } },
      })),
    )[0].amount.raw,
    "100000000",
  );
  const credit = {
    operationId: "op",
    locationId: component.location.locationId,
    asset: base,
    observedAt: new Date(now + 2000).toISOString(),
    invalidated: false,
    nativeDestinationDex: null,
  };
  assert.equal(
    fundingInvalidatedRefundComponentIds([credit], [component]).size,
    0,
  );
  assert.deepEqual(
    [
      ...fundingInvalidatedRefundComponentIds(
        [{ ...credit, invalidated: true }],
        [
          component,
          {
            ...component,
            componentId: "other-cash",
            location: { ...component.location, locationId: "other-location" },
          },
        ],
      ),
    ],
    [component.componentId],
  );
  assert.equal(
    fundingInvalidatedRefundComponentIds(
      [{ ...credit, invalidated: true }],
      [{ ...component, observedAt: new Date(now + 3000).toISOString() }],
    ).size,
    0,
  );
  assert.deepEqual(
    [...fundingRefundSnapshotLagOperations([credit], [component])],
    ["op"],
  );
  assert.equal(
    fundingRefundSnapshotLagOperations(
      [credit],
      [{ ...component, observedAt: new Date(now + 3000).toISOString() }],
    ).size,
    0,
  );
  assert.equal(
    fundingRefundSnapshotLagOperations(
      [{ ...credit, locationId: "perps" }],
      [{ ...component, observedAt: new Date(now + 3000).toISOString() }],
    ).size,
    1,
  );
  const uncertain = buildFundingInTransitObservations(userId, [
    { ...debits[0], observationError: "funding_refund_value_unknown" },
  ])[0];
  assert.equal(uncertain.observationFreshness, "unknown");
  assert.deepEqual(uncertain.observationError, {
    code: "funding_refund_value_unknown",
    retryable: true,
  });
});
