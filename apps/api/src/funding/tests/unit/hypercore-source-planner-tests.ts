import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerAccountValueRoutes } from "../../../routes/account-value.js";
import {
  projectAccountValue,
  resolveEffectiveHeadline,
} from "../../../account-value/account-value-projector.js";
import type { Pool } from "@hunch/infra";
import { RelayClient } from "../../../funding-providers/relay/client.js";
import { relayHexOrderId } from "../../../funding-providers/relay/order-hash.js";
import { fundingDiscoveryRequestSchema } from "../../domain/schemas.js";
import {
  commitPlanRunsWithoutUserWalletAction,
  plannedSourceRunsWithClientWalletActions,
} from "../../planner/planning-types.js";
import type { AccountValueReadModel } from "../../../account-value/runtime-service.js";
import { projectHip4AccountValue } from "../../../account-value/hip4-account-value.js";
import { withdrawalOptionsForAsset } from "../../../account-value/withdrawal-options.js";
import { projectCashAvailability } from "../../../account-value/cash-availability-projector.js";
import { projectHip4Account } from "../../../services/hip4-account-projection.js";
import { hypercorePlanTestFixture } from "../../../funding-providers/relay/hypercore-plan-test-fixture.js";
import { HYPERCORE_MAINNET_USDC } from "../../domain/hypercore-identity.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "../../policies/funding-policy.js";
import {
  deriveProductionRelayEligibleSourceFacts,
  resolveProductionOwnedSourceExecution,
  ProductionFundingSourcePlanner,
} from "../../planner/production-source-planner.js";
import { sessionSourceAccount } from "../../planner/session-source-account.js";
import {
  withWithdrawalPlanningContract,
  withdrawalRecipientLocationPatternId,
} from "../../domain/withdrawal-contract.js";

function fixture(
  now = new Date("2026-10-14T16:00:00Z"),
  reservedRaw = "9000000000",
) {
  const plan = hypercorePlanTestFixture(now);
  const { profile, route, destination } = plan.input;
  const userId =
    destination.target.kind === "owned_location"
      ? destination.target.location.accountId
      : "unused";
  const observation = projectHip4Account({
    environment: "mainnet",
    role: "user",
    mode: "disabled",
    observedAt: now.toISOString(),
    quote: {
      tokenId: HYPERCORE_MAINNET_USDC.assetId,
      index: 0,
      weiDecimals: 8,
    },
    state: {
      balances: [
        { coin: "USDC", token: 0, total: "100", hold: "3", entryNtl: "0" },
      ],
    },
  });
  const projection = projectHip4AccountValue({
    userId,
    now: now.getTime(),
    wallets: [profile],
    read: {
      environment: "mainnet",
      snapshotMaxAgeMs: 60000,
      accounts: [{ address: profile.address, observation }],
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
    },
  });
  const policy = {
    ...DEFAULT_FUNDING_RUNTIME_POLICY,
    // Captured unsigned quote uses 2% slippage; runtime defaults stay unchanged.
    placement: {
      ...DEFAULT_FUNDING_RUNTIME_POLICY.placement,
      minimumDestinationUsd: "1",
      maximumSlippageBps: 200,
    },
    providers: [
      { providerId: "relay", enabledCapabilities: [route.capability] },
    ],
    routes: [route],
    locations: [
      {
        locationPatternId: route.sourceLocationPatternId,
        locationKind: "venue_account" as const,
        ownership: "owned" as const,
        asset: HYPERCORE_MAINNET_USDC,
        enabled: true,
        observable: true,
        capabilities: [
          "observe",
          "value",
          "execution_source",
          "withdrawal_source",
        ] as const,
      },
    ],
  };
  // Exercise the actual P2 projection and shared reservation/debit adjustment.
  const account = {
    projection: { components: projection.assets, collectorErrors: [] },
    cashAvailability: projectCashAvailability({
      components: projection.assets,
      adjustments: projection.availability.map((row) => ({
        ...row,
        reservedRaw,
        submittedDebitRaw: "100000000",
      })),
      asOf: now.toISOString(),
    }),
    ownership: {
      accountId: userId,
      wallets: [profile],
      venueBindings: [],
      evidenceRevision: "test",
      asOf: now.toISOString(),
    },
    assetPreferences: {},
    runtimePolicy: policy,
  } as unknown as AccountValueReadModel;
  const input = {
    accountId: userId,
    account,
    policy,
    now,
    requiredAmount: { asset: route.destinationAsset, raw: "10000000" },
    destinationLocationPatternId: route.destinationLocationPatternId,
  };
  return { input, profile, projection, plan };
}

test("withdrawal UI options reuse owned-source and cash capacity without enabling funding", () => {
  const { input, projection } = fixture();
  const ownership = input.account.ownership;
  assert.ok(ownership);
  const component = projection.assets[0];
  const options = withdrawalOptionsForAsset(
    input.account,
    component,
    input.now.getTime(),
  );
  assert.equal(options?.maximumSourceRaw, "600000000");
  assert.equal(options?.destinations.length, 3);
  assert.ok(
    options?.destinations.every((asset) =>
      ["evm:8453", "evm:137"].includes(asset.networkId),
    ),
  );
  assert.equal(component.executionEligibility, "ineligible");
  for (const variant of [
    { ...component, observationFreshness: "stale" as const },
    {
      ...component,
      location: {
        ...component.location,
        details: {
          ...component.location.details,
          nativeAccountMode: "unifiedAccount",
        },
      },
    },
    {
      ...component,
      location: {
        ...component.location,
        details: { ...component.location.details, nativeSourceDex: "" },
      },
    },
    {
      ...component,
      amount: {
        ...component.amount,
        asset: { ...component.amount.asset, decimals: 6 },
      },
    },
  ]) {
    assert.deepEqual(
      withdrawalOptionsForAsset(input.account, variant, input.now.getTime())
        ?.destinations,
      [],
    );
  }
  assert.equal(
    withdrawalOptionsForAsset(
      input.account,
      component,
      input.now.getTime() + 60000,
    )?.maximumSourceRaw,
    null,
  );
  assert.deepEqual(
    withdrawalOptionsForAsset(
      {
        ...input.account,
        ownership: { ...ownership, wallets: [] },
      },
      component,
      input.now.getTime(),
    )?.destinations,
    [],
  );
  const externalProfile = {
    ...ownership.wallets[0],
    source: "external" as const,
    signingModes: ["web_client" as const],
  };
  assert.deepEqual(
    withdrawalOptionsForAsset(
      {
        ...input.account,
        connectedExternalWalletRefs: [
          externalProfile.controllerWalletRef ?? "",
        ],
        ownership: { ...ownership, wallets: [externalProfile] },
      },
      component,
      input.now.getTime(),
    )?.destinations,
    [],
  );
  assert.equal(
    withdrawalOptionsForAsset(
      input.account,
      { ...component, amount: { asset: input.requiredAmount.asset, raw: "1" } },
      input.now.getTime(),
    ),
    undefined,
  );
});

test("account/assets serves native withdrawal hints without mutating the common snapshot or exposing signing profiles", async () => {
  const { input, projection } = fixture(new Date());
  const projected = projectAccountValue({
    accountId: input.accountId,
    headlineMode: "liquid_only",
    components: projection.assets,
    positionComponents: [],
    asOf: input.now.toISOString(),
  });
  const account: AccountValueReadModel = {
    ...input.account,
    projection: projected,
    headline: resolveEffectiveHeadline(projected),
    venues: {},
    policy: {
      creationMode: "off",
      revision: "offline-policy",
      source: "default",
      invalidStoredPolicy: false,
    },
    ownershipEvidenceRevision: "a".repeat(64),
    duplicateAssetObservationCount: 0,
  };
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAccountValueRoutes(app, {
    authenticate: async (request) => {
      request.user = { id: input.accountId } as NonNullable<
        typeof request.user
      >;
    },
    build: async () => account,
    setPreference: async () => {
      throw new Error("not_used");
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/account/assets?limit=1",
    });
    assert.equal(response.statusCode, 200, response.body);
    const item = response.json().items[0];
    assert.equal(item.withdrawal.maximumSourceRaw, "600000000");
    assert.equal(item.withdrawal.destinations.length, 3);
    assert.equal(item.executionEligibility, "ineligible");
    assert.equal("withdrawal" in account.projection.components[0], false);
    assert.equal(response.body.includes("serverWalletRef"), false);
    const empty = await app.inject({
      method: "GET",
      url: `/account/assets?limit=1&cursor=${encodeURIComponent(item.componentId)}`,
    });
    assert.deepEqual(empty.json().items, []);
    const value = await app.inject({ method: "GET", url: "/account/value" });
    assert.equal(value.statusCode, 200, value.body);
    assert.equal(
      "withdrawal" in value.json().account.projection.components[0],
      false,
    );
  } finally {
    await app.close();
  }
});

test("actual common production planner keeps native user signing out of automatic funding and retains internal source preference", async (context) => {
  const { input, plan } = fixture(new Date(), "8000000000");
  const oldEnv = Object.fromEntries(
    [
      "RELAY_API_KEY",
      "CREDENTIALS_ENCRYPTION_KEY",
      "FUNDING_REFERENCE_LOOKUP_HMAC_KEY",
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    RELAY_API_KEY: "offline-test-only",
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    FUNDING_REFERENCE_LOOKUP_HMAC_KEY:
      "offline-native-plan-test-key-at-least-32-chars",
  });
  context.after(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  context.mock.method(RelayClient.prototype, "quote", async () => plan.wire);
  context.mock.method(
    RelayClient.prototype,
    "hypercoreContracts",
    async () => ({
      ...plan.quoteInput.validation.contracts,
      observedAt: input.now.toISOString(),
    }),
  );
  const db = {
    query: async (sql: string) => {
      assert.match(sql.trim(), /^select/i);
      return { rows: [] };
    },
  } as unknown as Pool;
  const requiredAmount = {
    asset: plan.input.route.destinationAsset,
    raw: "9700000",
  };
  const request = fundingDiscoveryRequestSchema.parse({
    purpose: "add_funds",
    requestedDestinationAmount: requiredAmount,
    confirmedSourceAmount: { asset: HYPERCORE_MAINNET_USDC, raw: "1000000000" },
    marketContextId: null,
    consumerIntent: null,
    destinationOptionId: plan.input.destination.destinationId,
    withdrawalRecipientId: null,
    venueBindingOptionId: null,
    maxFeeUsd: null,
    maxSlippageBps: null,
    deadline: null,
  });
  assert.ok(request.confirmedSourceAmount);
  const planningInput = {
    ...input,
    request,
    requiredAmount,
    marketContext: null,
    destinationFacts: null,
    destination: plan.input.destination,
    policyRevision: plan.input.policyRevision,
    placement: {
      mode: "confirmed_deposit_amount" as const,
      sourceAmount: request.confirmedSourceAmount,
      destinationRequirement: requiredAmount,
      targetVenueId: null,
      target: plan.input.destination.target,
      boundedBuffer: null,
      reason: "explicit" as const,
      policyVersion: 1,
    },
  };
  const result = await new ProductionFundingSourcePlanner(
    db,
    input.account,
  ).discover(planningInput);
  assert.equal(result.sources.length, 1);
  const source = result.sources[0];
  assert.equal(
    source.option.selectable,
    true,
    JSON.stringify(source.option.reasonCodes),
  );
  assert.deepEqual(source.sourcePreferenceCost, ["0", "0", "0"]);
  assert.equal(commitPlanRunsWithoutUserWalletAction(source.commitPlan), false);
  assert.equal(source.compositeEligible, false);
  assert.equal(plannedSourceRunsWithClientWalletActions(source), true);
  assert.deepEqual(
    source.option.requiredActions.map(({ kind, valueMoving, actor }) => ({
      kind,
      valueMoving,
      actor,
    })),
    [
      { kind: "signature", valueMoving: false, actor: "user" },
      { kind: "external_handoff", valueMoving: true, actor: "user" },
    ],
  );
  for (const changed of [
    {
      ...source,
      commitPlan: { ...source.commitPlan, steps: [source.commitPlan.steps[1]] },
    },
    {
      ...source,
      commitPlan: {
        ...source.commitPlan,
        steps: [...source.commitPlan.steps].reverse(),
      },
    },
    {
      ...source,
      commitPlan: {
        ...source.commitPlan,
        steps: source.commitPlan.steps.map((step) => ({
          ...step,
          executorId: "wallet_profile_evm_v1",
        })),
      },
    },
    {
      ...source,
      option: {
        ...source.option,
        requiredActions: source.option.requiredActions.map((action) => ({
          ...action,
          valueMoving: true,
        })),
      },
    },
    {
      ...source,
      option: {
        ...source.option,
        requiredActions: source.option.requiredActions.map((action) => ({
          ...action,
          kind: "external_handoff" as const,
        })),
      },
    },
  ])
    assert.equal(plannedSourceRunsWithClientWalletActions(changed), false);

  // The same common fee and slippage checks still reject unsafe economics.
  for (const [patch, reason] of [
    [{ maxFeeUsd: "0.001" }, "fee_limit_exceeded"],
    [{ maxSlippageBps: 100 }, "minimum_output_not_met"],
  ] as const) {
    const rejected = await new ProductionFundingSourcePlanner(
      db,
      input.account,
    ).discover({ ...planningInput, request: { ...request, ...patch } });
    assert.ok(rejected.sources.length);
    assert.ok(
      rejected.sources.every(
        (row) =>
          !row.option.selectable && row.option.reasonCodes.includes(reason),
      ),
    );
  }
  const ownership = input.account.ownership;
  assert.ok(ownership);
  const externalProfile = {
    ...plan.input.profile,
    source: "external" as const,
    serverWalletRef: null,
    signingModes: ["web_client"] as const,
  };
  assert.ok(externalProfile.controllerWalletRef);
  const externalAccount = sessionSourceAccount(
    {
      ...input.account,
      ownership: { ...ownership, wallets: [externalProfile] },
    },
    [externalProfile.controllerWalletRef],
  );
  const external = await new ProductionFundingSourcePlanner(
    db,
    externalAccount,
  ).discover(planningInput);
  assert.equal(external.sources[0]?.option.selectable, true);
  assert.deepEqual(external.sources[0]?.sourcePreferenceCost, ["0", "10", "0"]);

  // Re-encode the unsigned offline quote at the unchanged 1% withdrawal
  // contract. No signature, transport or production policy changes.
  const withdrawalWire = structuredClone(plan.wire);
  const minimum = (
    (BigInt(withdrawalWire.details.currencyOut.amount) * 99n) /
    100n
  ).toString();
  withdrawalWire.details.currencyOut.minimumAmount = minimum;
  withdrawalWire.protocol.v2.orderData.output.payments[0].minimumAmount =
    minimum;
  const orderId = relayHexOrderId(withdrawalWire.protocol.v2.orderData);
  withdrawalWire.protocol.v2.orderId = orderId;
  withdrawalWire.steps[0].items[0].data.sign.value.id = orderId;
  withdrawalWire.steps[0].items[0].data.post.body.id = orderId;
  context.mock.method(
    RelayClient.prototype,
    "quote",
    async () => withdrawalWire,
  );
  const fundingOff = {
    ...DEFAULT_FUNDING_RUNTIME_POLICY,
    placement: {
      ...DEFAULT_FUNDING_RUNTIME_POLICY.placement,
      maximumFeeUsd: "0",
    },
    ttl: { ...DEFAULT_FUNDING_RUNTIME_POLICY.ttl, quoteMs: 1, collectorMs: 1 },
  };
  const withdrawalPolicy = withWithdrawalPlanningContract(
    fundingOff,
    requiredAmount.asset,
  );
  const destinationLocationPatternId = withdrawalRecipientLocationPatternId(
    requiredAmount.asset,
  );
  assert.ok(destinationLocationPatternId);
  const withdrawalDestination = {
    ...plan.input.destination,
    destinationLocationPatternId,
  };
  const withdrawalPlanner = new ProductionFundingSourcePlanner(db, {
    ...input.account,
    runtimePolicy: fundingOff,
  });
  const withdrawalInput = {
    ...planningInput,
    policy: withdrawalPolicy,
    destination: withdrawalDestination,
    request: {
      ...request,
      purpose: "withdrawal" as const,
      maxFeeUsd: "0.1",
      withdrawalSourceComponentId:
        input.account.projection.components[0].componentId,
    },
  };
  const withdrawal = await withdrawalPlanner.discover(withdrawalInput);
  assert.equal(withdrawal.sources.length, 1);
  assert.equal(
    withdrawal.sources[0].option.selectable,
    true,
    JSON.stringify(withdrawal.sources[0].option.reasonCodes),
  );
  const tooTight = await withdrawalPlanner.discover({
    ...withdrawalInput,
    request: { ...withdrawalInput.request, maxFeeUsd: "0.001" },
  });
  assert.ok(tooTight.sources.length);
  assert.ok(
    tooTight.sources.every(
      (source) =>
        !source.option.selectable &&
        source.option.reasonCodes.includes("fee_limit_exceeded"),
    ),
  );
});

test("native source uses shared adjusted USDC8 capacity, no gas or wallet alias", () => {
  const { input, projection } = fixture();
  const [source] = deriveProductionRelayEligibleSourceFacts(input);
  assert.ok(source);
  assert.equal(source.maximumSourceRaw, "600000000");
  assert.equal(source.quoteInputAmount.raw, "600000000");
  assert.equal(source.quoteModeOverride, "exact_input");
  assert.equal(
    source.reservationLocationId,
    projection.assets[0].location.locationId,
  );
  assert.deepEqual(source.source, {
    kind: "owned_location",
    location: projection.assets[0].location,
  });
  assert.equal(source.nativeGasReady, true);
  assert.equal(source.walletExecutionReady, true);
  assert.equal(source.preRouteHandoff, undefined);
  const [full] = deriveProductionRelayEligibleSourceFacts({
    ...input,
    quoteAvailableSourceCapacity: true,
  });
  assert.equal(full.quoteInputAmount.raw, "600000000");
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({
      ...input,
      confirmedSourceAmount: {
        asset: HYPERCORE_MAINNET_USDC,
        raw: "600000001",
      },
    }).length,
    0,
  );
});

test("ordinary withdrawal contract discovers the same native spot capacity without enabling funding or reclassifying perps", () => {
  const { input, projection } = fixture();
  const asset = input.requiredAmount.asset;
  const policy = withWithdrawalPlanningContract(
    DEFAULT_FUNDING_RUNTIME_POLICY,
    asset,
  );
  const destinationLocationPatternId =
    withdrawalRecipientLocationPatternId(asset);
  assert.ok(destinationLocationPatternId);
  const args = {
    ...input,
    policy,
    destinationLocationPatternId,
    purpose: "withdrawal" as const,
    withdrawalSourceComponentId: projection.assets[0].componentId,
  };
  const sources = deriveProductionRelayEligibleSourceFacts(args);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].maximumSourceRaw, "600000000");
  assert.equal(sources[0].source.kind, "owned_location");
  assert.equal(sources[0].sourceLocationPatternId, "hypercore-spot-usdc-v1");
  assert.equal(
    sources[0].reservationLocationId,
    projection.assets[0].location.locationId,
  );
  assert.equal(policy.creationMode, "off");
  assert.equal(policy.gates.startUnsubmittedAction, false);
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({
      ...args,
      withdrawalSourceComponentId: "another",
    }).length,
    0,
  );
  const perpsAccount = {
    ...input.account,
    projection: {
      ...input.account.projection,
      components: input.account.projection.components.map((component) => ({
        ...component,
        location: {
          ...component.location,
          details: { ...component.location.details, nativeSourceDex: "" },
        },
      })),
    },
  };
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({ ...args, account: perpsAccount })
      .length,
    0,
  );
});

test("native source rejects stale, unknown capacity, changed mode/identity and recovers on refreshed facts", () => {
  const patches: Record<string, string>[] = [
    { nativeAccountMode: "unifiedAccount" },
    { nativeSourceDex: "" },
    { cashCapacityReason: "unverified_cash" },
    { controllerWalletId: "another" },
    { address: `0x${"cc".repeat(20)}` },
    { environment: "testnet" },
    { validUntil: "bad" },
    { validUntil: "2026-10-14T16:00:00Z" },
  ];
  for (const patch of patches) {
    const { input } = fixture();
    const component = input.account.projection.components[0];
    const altered = {
      ...component,
      location: {
        ...component.location,
        details: { ...component.location.details, ...patch },
      },
    };
    const account = {
      ...input.account,
      projection: { ...input.account.projection, components: [altered] },
    };
    assert.equal(
      deriveProductionRelayEligibleSourceFacts({ ...input, account }).length,
      0,
      JSON.stringify(patch),
    );
    assert.equal(deriveProductionRelayEligibleSourceFacts(input).length, 1);
  }
  const { input } = fixture();
  const account = {
    ...input.account,
    cashAvailability: {
      ...input.account.cashAvailability,
      components: input.account.cashAvailability.components.map((row) => ({
        ...row,
        freshness: "stale" as const,
      })),
    },
  };
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({ ...input, account }).length,
    0,
  );
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({
      ...input,
      now: new Date(input.now.getTime() + 60000),
    }).length,
    0,
  );
});

test("native signing requires exact unique owned controller and connected external session", () => {
  const { input, profile } = fixture();
  const ownership = input.account.ownership;
  assert.ok(ownership);
  assert.ok(profile.controllerWalletRef);
  const component = input.account.projection.components[0];
  for (const changed of [
    { ...profile, source: "smart" as const },
    { ...profile, serverWalletRef: null },
    { ...profile, controllerWalletRef: null },
    { ...profile, signingModes: [] },
  ]) {
    const account: AccountValueReadModel = {
      ...input.account,
      ownership: { ...ownership, wallets: [changed] },
    };
    assert.equal(
      resolveProductionOwnedSourceExecution({ account, component }),
      null,
    );
  }
  const duplicate = {
    ...input.account,
    ownership: { ...ownership, wallets: [profile, profile] },
  };
  assert.equal(
    resolveProductionOwnedSourceExecution({ account: duplicate, component }),
    null,
  );
  const external = {
    ...profile,
    source: "external" as const,
    serverWalletRef: null,
    signingModes: ["web_client"] as const,
  };
  const disconnected = {
    ...input.account,
    ownership: { ...ownership, wallets: [external] },
  };
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({
      ...input,
      account: disconnected,
    }).length,
    0,
  );
  const connected = sessionSourceAccount(disconnected, [
    profile.controllerWalletRef,
  ]);
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({ ...input, account: connected })
      .length,
    1,
  );
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({
      ...input,
      account: sessionSourceAccount(connected, []),
    }).length,
    0,
  );
});

test("native source respects exact policy route, preferences and source capability", () => {
  const { input } = fixture();
  for (const policy of [
    { ...input.policy, routes: [] },
    {
      ...input.policy,
      routes: [...input.policy.routes, input.policy.routes[0]],
    },
    {
      ...input.policy,
      locations: input.policy.locations.map((row) => ({
        ...row,
        enabled: false,
      })),
    },
    {
      ...input.policy,
      locations: input.policy.locations.map((row) => ({
        ...row,
        locationKind: "wallet" as const,
      })),
    },
    {
      ...input.policy,
      locations: input.policy.locations.map((row) => ({
        ...row,
        locationPatternId: "wrong",
      })),
    },
    {
      ...input.policy,
      locations: input.policy.locations.map((row) => ({
        ...row,
        capabilities: ["observe"] as const,
      })),
    },
  ])
    assert.equal(
      deriveProductionRelayEligibleSourceFacts({ ...input, policy }).length,
      0,
    );
  const id = input.account.projection.components[0].componentId;
  const account = {
    ...input.account,
    assetPreferences: {
      [id]: {
        componentId: id,
        userId: input.accountId,
        preference: "never_suggest" as const,
        revision: "test-preference",
        createdAt: input.now,
        updatedAt: input.now,
      },
    },
  };
  assert.equal(
    deriveProductionRelayEligibleSourceFacts({ ...input, account }).length,
    0,
  );
});
