#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assetLocationSchema,
  fundingCommitRequestSchema,
  fundingDiscoveryRequestSchema,
  fundingQuoteRequestSchema,
  moneySchema,
  rawAmountSchema,
} from "./funding/domain/schemas.js";
import {
  selectFundingDestination,
  selectVenueBindingForCurrentIntent,
} from "./funding/domain/selections.js";
import {
  FUNDING_OPERATION_TRANSITIONS,
  assertFundingOperationTransition,
  canTransitionFundingOperation,
  canTransitionSegment,
  isValidFundingOperationState,
  type FundingOperationState,
  type FundingStateKey,
} from "./funding/domain/transitions.js";
import type {
  AssetLocation,
  FundingCommitRequest,
} from "./funding/domain/types.js";
import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  createFundingStaticRegistry,
  diffFundingPolicies,
  fundingPolicyRevision,
  isFundingPolicyGateOpen,
  validateFundingRuntimePolicy,
  type FundingRuntimePolicy,
  type FundingStaticRegistry,
} from "./funding/policies/funding-policy.js";
import {
  FundingPolicyPublishError,
  previewFundingPolicy,
  publishFundingPolicy,
  resolveFundingPolicy,
} from "./funding/policies/funding-policy-service.js";

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

type MutableFundingPolicy = DeepMutable<FundingRuntimePolicy>;
type PolicyDb = Parameters<typeof resolveFundingPolicy>[0];

async function test(
  name: string,
  run: () => Promise<void> | void,
): Promise<void> {
  await run();
  console.log(`[funding-domain-tests] ok ${name}`);
}

function mutableDefaultPolicy(): MutableFundingPolicy {
  return structuredClone(
    DEFAULT_FUNDING_RUNTIME_POLICY,
  ) as MutableFundingPolicy;
}

const polygonPusd = {
  networkId: "evm:137",
  assetId: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  decimals: 6,
};
const baseUsdc = {
  networkId: "evm:8453",
  assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  decimals: 6,
};

function productionTestRegistry(
  locationKinds: readonly string[] = [
    "wallet",
    "venue_account",
    "in_transit_claim",
  ],
): FundingStaticRegistry {
  return createFundingStaticRegistry({
    locationKinds,
    providerAdapters: [
      {
        id: "relay-quote-v2",
        providerId: "relay",
        runtimeKind: "production",
        capabilities: ["cross_network_swap", "deposit_address"],
      },
    ],
    actionValidators: [
      { id: "normalized-action-v1", runtimeKind: "production" },
    ],
    networkExecutors: [{ id: "evm-network-v1", runtimeKind: "production" }],
    reconcilers: [{ id: "relay-status-v3", runtimeKind: "production" }],
    refundSemantics: [
      { id: "relay-user-refund-v1", runtimeKind: "production" },
    ],
    destinationObservers: [
      { id: "owned-balance-v1", runtimeKind: "production" },
    ],
    fixtureIds: ["relay-live-evm-v1"],
  });
}

function activeRoutePolicy(): MutableFundingPolicy {
  const policy = mutableDefaultPolicy();
  policy.creationMode = "on";
  policy.gates.quoteCreation = true;
  policy.gates.commit = true;
  policy.gates.startUnsubmittedAction = true;
  policy.placement.maximumFeeUsd = "2";
  policy.assets = [
    {
      asset: polygonPusd,
      enabled: true,
      observationEnabled: true,
      valuationEnabled: true,
      pricePolicyId: "polygon-pusd-price-v1",
    },
    {
      asset: baseUsdc,
      enabled: true,
      observationEnabled: true,
      valuationEnabled: true,
      pricePolicyId: "base-usdc-price-v1",
    },
  ];
  policy.locations = [
    {
      locationPatternId: "wallet-polygon-pusd",
      locationKind: "wallet",
      asset: polygonPusd,
      ownership: "owned",
      observable: true,
      capabilities: ["observe", "value", "execution_source"],
      enabled: true,
    },
    {
      locationPatternId: "venue-limitless-base-usdc",
      locationKind: "venue_account",
      asset: baseUsdc,
      ownership: "owned",
      observable: true,
      capabilities: ["observe", "value", "venue_settlement"],
      enabled: true,
    },
  ];
  policy.venues = [
    {
      venueId: "limitless",
      lifecycleEnabled: true,
      destinationReadinessEnabled: true,
      balanceEnabled: true,
      fundingEnabled: true,
      tradingEnabled: false,
      withdrawalEnabled: false,
      delegatedExecutionEnabled: false,
      delegatedPolicyIds: [],
      delegatedDailyCapUsd: null,
      positionValue: {
        enabled: false,
        identityPolicyId: null,
        freshnessMs: null,
        valuationMethodId: null,
        deduplicationPolicyId: null,
      },
    },
  ];
  policy.providers = [
    {
      providerId: "relay",
      enabledCapabilities: ["cross_network_swap"],
    },
  ];
  policy.routes = [
    {
      routeId: "polygon-pusd-to-base-usdc",
      enabled: true,
      providerId: "relay",
      capability: "cross_network_swap",
      adapterId: "relay-quote-v2",
      adapterVersion: 2,
      sourceLocationPatternId: "wallet-polygon-pusd",
      destinationLocationPatternId: "venue-limitless-base-usdc",
      sourceAsset: polygonPusd,
      destinationAsset: baseUsdc,
      fixtureIds: ["relay-live-evm-v1"],
      actionValidatorId: "normalized-action-v1",
      networkExecutorId: "evm-network-v1",
      reconcilerId: "relay-status-v3",
      refundSemanticsId: "relay-user-refund-v1",
      destinationObserverId: "owned-balance-v1",
      experienceMode: "prepare_first",
      measuredObservationCount: 1,
      minimumInlineObservationCount: 20,
      fallbackKind: null,
      depositAddress: null,
    },
  ];
  policy.genericAddFundsRecommendationOrder = ["limitless"];
  return policy;
}

function issueCodes(candidate: unknown, registry = productionTestRegistry()) {
  const result = validateFundingRuntimePolicy(candidate, registry);
  return result.ok ? [] : result.issues.map(({ code }) => code);
}

await test("accepts only unsigned raw-unit strings", () => {
  assert.equal(rawAmountSchema.safeParse("0").success, true);
  assert.equal(rawAmountSchema.safeParse("1000000").success, true);
  for (const invalid of ["", "-1", "+1", "01", "1.1", 1, 1n]) {
    assert.equal(rawAmountSchema.safeParse(invalid).success, false);
  }
  assert.equal(
    moneySchema.safeParse({ asset: polygonPusd, raw: "1000000" }).success,
    true,
  );
});

await test("freezes authenticated discovery, quote, and commit boundaries", () => {
  const tradeDiscovery = {
    purpose: "trade_shortfall",
    requestedDestinationAmount: { asset: polygonPusd, raw: "5000000" },
    confirmedSourceAmount: null,
    marketContextId: "marketctx_12345678",
    destinationOptionId: "destination_12345678",
    withdrawalRecipientId: null,
    venueBindingOptionId: "bindingopt_12345678",
    maxFeeUsd: "1.25",
    maxSlippageBps: 100,
    deadline: "2026-07-24T00:00:00.000Z",
  };
  assert.equal(
    fundingDiscoveryRequestSchema.safeParse(tradeDiscovery).success,
    true,
  );
  assert.equal(
    fundingDiscoveryRequestSchema.safeParse({
      ...tradeDiscovery,
      marketContextId: null,
    }).success,
    false,
  );
  assert.equal(
    fundingDiscoveryRequestSchema.safeParse({
      ...tradeDiscovery,
      purpose: "withdrawal",
      marketContextId: null,
      destinationOptionId: null,
      venueBindingOptionId: null,
      withdrawalRecipientId: null,
    }).success,
    false,
  );

  assert.equal(
    fundingQuoteRequestSchema.safeParse({
      liquidityProjectionId: "projection_12345678",
      selectedSourceOptionId: "sourceopt_12345678",
      confirmedSourceAmount: { asset: polygonPusd, raw: "1000000" },
      requestedDestinationAmount: null,
    }).success,
    true,
  );
  assert.equal(
    fundingQuoteRequestSchema.safeParse({
      liquidityProjectionId: "projection_12345678",
      selectedSourceOptionId: "sourceopt_12345678",
      confirmedSourceAmount: null,
      requestedDestinationAmount: null,
    }).success,
    false,
  );

  const commit: FundingCommitRequest = {
    quoteId: "quote_id_12345678",
    consentToken: "consent_12345678",
    idempotencyKey: "idempotency-key-12345678",
  };
  assert.equal(fundingCommitRequestSchema.safeParse(commit).success, true);
  assert.equal(
    fundingCommitRequestSchema.safeParse({
      ...commit,
      accountId: "attacker_user_12345678",
    }).success,
    false,
    "commit must not accept client authority fields",
  );
});

await test("accepts a registered future location without a core branch", () => {
  const customLocation: AssetLocation<
    "protocol_subaccount",
    { protocol: string; subaccountRef: string }
  > = {
    kind: "protocol_subaccount",
    locationId: "location_12345678",
    accountId: "account_12345678",
    asset: baseUsdc,
    details: {
      protocol: "future",
      subaccountRef: "opaque-ref",
    },
  };
  assert.equal(assetLocationSchema.safeParse(customLocation).success, true);

  const policy = mutableDefaultPolicy();
  policy.assets = [
    {
      asset: baseUsdc,
      enabled: true,
      observationEnabled: true,
      valuationEnabled: true,
      pricePolicyId: "base-usdc-price-v1",
    },
  ];
  policy.locations = [
    {
      locationPatternId: "future-protocol-usdc",
      locationKind: "protocol_subaccount",
      asset: baseUsdc,
      ownership: "owned",
      observable: true,
      capabilities: ["observe", "value", "venue_settlement"],
      enabled: true,
    },
  ];
  const registry = productionTestRegistry([
    "wallet",
    "venue_account",
    "in_transit_claim",
    "protocol_subaccount",
  ]);
  assert.equal(validateFundingRuntimePolicy(policy, registry).ok, true);
});

await test("selects only current-intent opaque Trading Wallet options", () => {
  const options = [
    {
      venueBindingOptionId: "binding_hunch_12345678",
      safeLabel: "Hunch Trading Wallet",
      readinessClass: "internal_managed" as const,
      preparationPurpose: "buy" as const,
      selectable: true,
      reasonCodes: [],
    },
    {
      venueBindingOptionId: "binding_external_12345678",
      safeLabel: "External wallet …1234",
      readinessClass: "external_ready" as const,
      preparationPurpose: "buy" as const,
      selectable: true,
      reasonCodes: [],
    },
  ];
  const defaultSelection = selectVenueBindingForCurrentIntent({
    purpose: "buy",
    options,
    explicitVenueBindingOptionId: null,
    positionOwnerVenueBindingOptionId: null,
  });
  assert.equal(
    defaultSelection.selected?.venueBindingOptionId,
    "binding_hunch_12345678",
  );
  assert.equal(defaultSelection.reason, "internal_default");

  const explicit = selectVenueBindingForCurrentIntent({
    purpose: "buy",
    options,
    explicitVenueBindingOptionId: "binding_external_12345678",
    positionOwnerVenueBindingOptionId: null,
  });
  assert.equal(
    explicit.selected?.venueBindingOptionId,
    "binding_external_12345678",
  );
  assert.equal(explicit.reason, "explicit_current_intent");

  const ownerRequired = selectVenueBindingForCurrentIntent({
    purpose: "redeem",
    options: options.map((option) => ({
      ...option,
      preparationPurpose: "redeem" as const,
    })),
    explicitVenueBindingOptionId: "binding_hunch_12345678",
    positionOwnerVenueBindingOptionId: "binding_external_12345678",
  });
  assert.equal(
    ownerRequired.selected?.venueBindingOptionId,
    "binding_external_12345678",
  );
  assert.equal(ownerRequired.reason, "position_owner");
});

await test("never auto-commits a recommended destination", () => {
  const destinations = [
    {
      destinationOptionId: "destination_poly_12345678",
      venueId: "polymarket",
      venueBindingOptionId: "binding_poly_12345678",
      safeLabel: "Polymarket · Hunch Trading Wallet",
      requiredAsset: polygonPusd,
      networkLabel: "Polygon",
      readinessClass: "internal_managed" as const,
      recommended: true,
      selectable: true,
      reasonCodes: [],
    },
    {
      destinationOptionId: "destination_limitless_12345678",
      venueId: "limitless",
      venueBindingOptionId: "binding_limitless_12345678",
      safeLabel: "Limitless · Hunch Trading Wallet",
      requiredAsset: baseUsdc,
      networkLabel: "Base",
      readinessClass: "internal_managed" as const,
      recommended: false,
      selectable: true,
      reasonCodes: [],
    },
  ];
  const unselected = selectFundingDestination({
    options: destinations,
    explicitDestinationOptionId: null,
  });
  assert.equal(unselected.selected, null);
  assert.deepEqual(unselected.reasonCodes, ["destination_not_selected"]);

  const explicit = selectFundingDestination({
    options: destinations,
    explicitDestinationOptionId: "destination_limitless_12345678",
  });
  assert.equal(explicit.selected?.venueId, "limitless");

  const only = selectFundingDestination({
    options: [destinations[0]],
    explicitDestinationOptionId: null,
  });
  assert.equal(only.reason, "single_valid_option");
});

await test("declares every valid state and rejects regressions", () => {
  for (const [from, destinations] of Object.entries(
    FUNDING_OPERATION_TRANSITIONS,
  )) {
    const [fromStatus, fromStage] = from.split(":");
    const fromState = {
      status: fromStatus,
      stage: fromStage,
    } as FundingOperationState;
    assert.equal(isValidFundingOperationState(fromState), true);
    assert.equal(canTransitionFundingOperation(fromState, fromState), true);
    for (const destination of destinations) {
      const [status, stage] = (destination as FundingStateKey).split(":");
      const toState = { status, stage } as FundingOperationState;
      assert.equal(isValidFundingOperationState(toState), true);
      assert.equal(canTransitionFundingOperation(fromState, toState), true);
    }
  }

  assert.equal(
    canTransitionFundingOperation(
      { status: "completed", stage: "terminal" },
      { status: "in_progress", stage: "routing" },
    ),
    false,
  );
  assert.throws(
    () =>
      assertFundingOperationTransition(
        { status: "ready", stage: "ready_for_consumer" },
        { status: "in_progress", stage: "source_action" },
      ),
    /invalid funding operation transition/,
  );
  assert.equal(canTransitionSegment("submitted", "settling"), true);
  assert.equal(canTransitionSegment("succeeded", "submitted"), false);
});

await test("default policy is immutable and fail-closed for creation only", () => {
  const validated = validateFundingRuntimePolicy(
    DEFAULT_FUNDING_RUNTIME_POLICY,
  );
  assert.equal(validated.ok, true);
  assert.equal(Object.isFrozen(DEFAULT_FUNDING_RUNTIME_POLICY), true);
  assert.equal(Object.isFrozen(DEFAULT_FUNDING_RUNTIME_POLICY.gates), true);
  assert.equal(
    isFundingPolicyGateOpen(DEFAULT_FUNDING_RUNTIME_POLICY, "quote_creation"),
    false,
  );
  assert.equal(
    isFundingPolicyGateOpen(DEFAULT_FUNDING_RUNTIME_POLICY, "commit"),
    false,
  );
  assert.equal(
    isFundingPolicyGateOpen(
      DEFAULT_FUNDING_RUNTIME_POLICY,
      "start_unsubmitted_action",
    ),
    false,
  );
  for (const gate of [
    "reconciliation",
    "webhook_ingestion",
    "polling",
    "refund",
    "recovery",
    "worker_drain",
  ] as const) {
    assert.equal(
      isFundingPolicyGateOpen(DEFAULT_FUNDING_RUNTIME_POLICY, gate),
      true,
    );
  }
});

await test("rejects retired rollout modes", () => {
  for (const creationMode of ["shadow", "internal", "cohort"]) {
    const policy = mutableDefaultPolicy() as unknown as Record<string, unknown>;
    policy.creationMode = creationMode;
    const result = validateFundingRuntimePolicy(policy);
    assert.equal(
      result.ok,
      false,
      `${creationMode} must not remain publishable`,
    );
    assert.ok(
      !result.ok &&
        result.issues.some(
          (issue) =>
            issue.code === "schema_invalid" && issue.path === "creationMode",
        ),
    );
  }
});

await test("accepts a fully registered production route", () => {
  const result = validateFundingRuntimePolicy(
    activeRoutePolicy(),
    productionTestRegistry(),
  );
  assert.equal(
    result.ok,
    true,
    result.ok ? undefined : JSON.stringify(result.issues),
  );
});

await test("rejects section 21 cross-field failures", () => {
  const creationMismatch = mutableDefaultPolicy();
  creationMismatch.gates.quoteCreation = true;
  assert.ok(issueCodes(creationMismatch).includes("creation_gate_mismatch"));

  const evidenceDisabled = mutableDefaultPolicy();
  evidenceDisabled.gates.polling = false;
  assert.ok(
    issueCodes(evidenceDisabled).includes("evidence_gate_must_remain_open"),
  );

  const valuedWithoutPrice = mutableDefaultPolicy();
  valuedWithoutPrice.assets = [
    {
      asset: baseUsdc,
      enabled: true,
      observationEnabled: true,
      valuationEnabled: true,
      pricePolicyId: null,
    },
  ];
  assert.ok(
    issueCodes(valuedWithoutPrice).includes("asset_price_policy_required"),
  );

  const unsafeLocation = mutableDefaultPolicy();
  unsafeLocation.assets = [
    {
      asset: baseUsdc,
      enabled: true,
      observationEnabled: true,
      valuationEnabled: false,
      pricePolicyId: null,
    },
  ];
  unsafeLocation.locations = [
    {
      locationPatternId: "unsafe-external-usdc",
      locationKind: "wallet",
      asset: baseUsdc,
      ownership: "external_recipient",
      observable: false,
      capabilities: ["venue_settlement"],
      enabled: true,
    },
  ];
  assert.ok(
    issueCodes(unsafeLocation).includes(
      "capability_requires_owned_observable_location",
    ),
  );

  const venueDependency = mutableDefaultPolicy();
  venueDependency.venues = [
    {
      venueId: "limitless",
      lifecycleEnabled: false,
      destinationReadinessEnabled: false,
      balanceEnabled: false,
      fundingEnabled: true,
      tradingEnabled: false,
      withdrawalEnabled: false,
      delegatedExecutionEnabled: false,
      delegatedPolicyIds: [],
      delegatedDailyCapUsd: null,
      positionValue: {
        enabled: false,
        identityPolicyId: null,
        freshnessMs: null,
        valuationMethodId: null,
        deduplicationPolicyId: null,
      },
    },
  ];
  assert.ok(
    issueCodes(venueDependency).includes("venue_funding_dependency_missing"),
  );

  const delegatedWithoutCaps = structuredClone(
    venueDependency,
  ) as MutableFundingPolicy;
  const venue = delegatedWithoutCaps.venues[0];
  assert.ok(venue);
  venue.fundingEnabled = false;
  venue.delegatedExecutionEnabled = true;
  assert.ok(
    issueCodes(delegatedWithoutCaps).includes("delegated_policy_incomplete"),
  );

  const forbiddenVenue = mutableDefaultPolicy();
  forbiddenVenue.venues = [
    {
      venueId: "kalshi",
      lifecycleEnabled: true,
      destinationReadinessEnabled: false,
      balanceEnabled: true,
      fundingEnabled: false,
      tradingEnabled: false,
      withdrawalEnabled: false,
      delegatedExecutionEnabled: false,
      delegatedPolicyIds: [],
      delegatedDailyCapUsd: null,
      positionValue: {
        enabled: false,
        identityPolicyId: null,
        freshnessMs: null,
        valuationMethodId: null,
        deduplicationPolicyId: null,
      },
    },
  ];
  assert.ok(issueCodes(forbiddenVenue).includes("forbidden_venue_active"));

  for (const mutation of [
    (policy: MutableFundingPolicy) => {
      policy.automation.automaticRebalance = true;
    },
    (policy: MutableFundingPolicy) => {
      policy.automation.stagedContinuation = true;
    },
    (policy: MutableFundingPolicy) => {
      policy.headline.userOverrideEnabled = true;
    },
    (policy: MutableFundingPolicy) => {
      policy.headline.referencedByExecutableLiquidity = true;
    },
    (policy: MutableFundingPolicy) => {
      policy.tradingWallet.rememberedSelectionEnabled = true;
    },
    (policy: MutableFundingPolicy) => {
      policy.placement.requireExplicitNoTradeDestinationSelection = false;
    },
  ]) {
    const policy = mutableDefaultPolicy();
    mutation(policy);
    assert.equal(validateFundingRuntimePolicy(policy).ok, false);
  }
});

await test("rejects fixture adapters and incomplete active routes", () => {
  const candidate = activeRoutePolicy();
  const fixtureRegistry = createFundingStaticRegistry({
    ...productionTestRegistry(),
    providerAdapters: [
      {
        id: "relay-quote-v2",
        providerId: "relay",
        runtimeKind: "fixture",
        capabilities: ["cross_network_swap"],
      },
    ],
  });
  assert.ok(
    issueCodes(candidate, fixtureRegistry).includes(
      "fixture_adapter_forbidden",
    ),
  );

  const missingFixture = activeRoutePolicy();
  const route = missingFixture.routes[0];
  assert.ok(route);
  route.fixtureIds = [];
  assert.ok(issueCodes(missingFixture).includes("route_fixture_missing"));

  const deprecatedFallback = activeRoutePolicy();
  const fallbackRoute = deprecatedFallback.routes[0];
  assert.ok(fallbackRoute);
  fallbackRoute.fallbackKind = "across_suggested_fees";
  assert.ok(
    issueCodes(deprecatedFallback).includes("deprecated_fallback_forbidden"),
  );
});

await test("requires strict controlled deposit-address policy", () => {
  const candidate = activeRoutePolicy();
  const route = candidate.routes[0];
  assert.ok(route);
  route.capability = "deposit_address";
  candidate.providers[0]?.enabledCapabilities.push("deposit_address");
  route.depositAddress = {
    mode: "open",
    senderKinds: ["exchange"],
    refundOwnership: "app_controlled",
    refundLocationPatternId: null,
    transferObserverId: null,
    requestTracking: "request_only",
    wrongAssetRecoveryPolicyId: null,
    privyIngressAllowed: true,
  };
  assert.ok(issueCodes(candidate).includes("deposit_address_policy_invalid"));
});

await test("builds deterministic revisions and structural diffs", () => {
  const before = mutableDefaultPolicy();
  const after = mutableDefaultPolicy();
  after.placement.maximumFeeUsd = "2.50";
  assert.equal(
    fundingPolicyRevision(before),
    fundingPolicyRevision(structuredClone(before)),
  );
  assert.notEqual(fundingPolicyRevision(before), fundingPolicyRevision(after));
  assert.deepEqual(diffFundingPolicies(before, after), [
    {
      path: "placement.maximumFeeUsd",
      before: "0",
      after: "2.50",
    },
  ]);
});

type StoredPolicyRow = {
  id: string;
  policy_key: string;
  effective_at: Date;
  payload: unknown;
  created_by: string | null;
  created_at: Date;
};

function createPolicyDb() {
  const rows: StoredPolicyRow[] = [];
  const calls: string[] = [];
  const db = {
    async query<T extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ rows: T[] }> {
      calls.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [{ locked: true } as unknown as T] };
      }
      if (sql.includes("insert into runtime_policies")) {
        const row: StoredPolicyRow = {
          id: `policy_${rows.length + 1}`,
          policy_key: String(params[0]),
          effective_at: params[1] as Date,
          payload: JSON.parse(String(params[2])) as unknown,
          created_by: params[3] == null ? null : String(params[3]),
          created_at: params[1] as Date,
        };
        rows.push(row);
        return { rows: [row as unknown as T] };
      }
      if (sql.includes("from runtime_policies")) {
        const key = String(params[0]);
        const active = rows
          .filter((row) => row.policy_key === key)
          .sort(
            (left, right) =>
              right.effective_at.getTime() - left.effective_at.getTime(),
          )[0];
        return { rows: active ? [active as unknown as T] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as PolicyDb;
  return { calls, db, rows };
}

await test("previews, confirms, and append-publishes immutable policy", async () => {
  const fixture = createPolicyDb();
  const initial = await resolveFundingPolicy(fixture.db);
  assert.equal(initial.source, "default");

  const candidate = mutableDefaultPolicy();
  candidate.placement.maximumFeeUsd = "1";
  const preview = await previewFundingPolicy(fixture.db, candidate);
  assert.equal(preview.valid, true);
  if (!preview.valid) throw new Error("valid preview expected");
  assert.equal(preview.diff.length, 1);

  await assert.rejects(
    () =>
      publishFundingPolicy(fixture.db, {
        candidate,
        expectedCurrentRevision: preview.current.revision,
        candidateRevision: preview.candidateRevision,
        confirmation: "wrong confirmation",
        createdBy: "admin_12345678",
      }),
    (error: unknown) =>
      error instanceof FundingPolicyPublishError &&
      error.code === "confirmation_mismatch",
  );
  assert.equal(fixture.rows.length, 0);

  const published = await publishFundingPolicy(fixture.db, {
    candidate,
    expectedCurrentRevision: preview.current.revision,
    candidateRevision: preview.candidateRevision,
    confirmation: preview.confirmation,
    createdBy: "admin_12345678",
    now: new Date("2026-07-23T17:00:00.000Z"),
  });
  assert.equal(published.source, "db");
  assert.equal(published.revision, preview.candidateRevision);
  assert.equal(fixture.rows.length, 1);
  assert.equal(
    fixture.calls.some((sql) => sql.includes("pg_advisory_xact_lock")),
    true,
  );

  await assert.rejects(
    () =>
      publishFundingPolicy(fixture.db, {
        candidate,
        expectedCurrentRevision: initial.revision,
        candidateRevision: preview.candidateRevision,
        confirmation: preview.confirmation,
        createdBy: "admin_12345678",
      }),
    (error: unknown) =>
      error instanceof FundingPolicyPublishError &&
      error.code === "current_revision_mismatch",
  );
});

await test("falls back closed when stored policy is invalid", async () => {
  const fixture = createPolicyDb();
  fixture.rows.push({
    id: "policy_invalid",
    policy_key: "funding_control_plane",
    effective_at: new Date("2026-07-23T16:00:00.000Z"),
    payload: { version: 99, creationMode: "on" },
    created_by: "admin_12345678",
    created_at: new Date("2026-07-23T16:00:00.000Z"),
  });
  const resolved = await resolveFundingPolicy(fixture.db);
  assert.equal(resolved.source, "default");
  assert.equal(resolved.invalidStoredPolicy, true);
  assert.equal(resolved.policy.creationMode, "off");
  assert.ok(resolved.validationIssues.length > 0);
});

await test("keeps core provider-neutral and simulator out of production registry", () => {
  for (const relative of [
    "./funding/domain/types.ts",
    "./funding/domain/schemas.ts",
    "./funding/domain/selections.ts",
    "./funding/domain/transitions.ts",
    "./funding/domain/contracts.ts",
  ]) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /funding-providers|venue-capabilities/);
  }
  const productionPolicySource = readFileSync(
    new URL("./funding/policies/funding-policy.ts", import.meta.url),
    "utf8",
  );
  const productionServiceSource = readFileSync(
    new URL("./funding/policies/funding-policy-service.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(productionPolicySource, /local-simulator/);
  assert.doesNotMatch(productionServiceSource, /local-simulator/);
});

await test("protects funding admin routes with dedicated permissions", () => {
  const routesSource = readFileSync(
    new URL("./routes/admin-funding.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    routesSource,
    /z\.get\(\s*"\/admin\/funding\/policy"[\s\S]*?dependencies\.authorize\("funding:read"\)/,
  );
  assert.match(
    routesSource,
    /z\.post\(\s*"\/admin\/funding\/policy\/diff"[\s\S]*?dependencies\.authorize\("funding:write"\)/,
  );
  assert.match(
    routesSource,
    /z\.post\(\s*"\/admin\/funding\/policy\/publish"[\s\S]*?dependencies\.authorize\("funding:write"\)/,
  );
  assert.match(
    routesSource,
    /const actorId = request\.adminActor\?\.id \?\? request\.user\?\.id;/,
  );
  const adminRoutesSource = readFileSync(
    new URL("./routes/admin.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    adminRoutesSource,
    /registerAdminFundingRoutes\(app,[\s\S]*?requiredAdminPermission: permission/,
  );
});

console.log("[funding-domain-tests] complete");
