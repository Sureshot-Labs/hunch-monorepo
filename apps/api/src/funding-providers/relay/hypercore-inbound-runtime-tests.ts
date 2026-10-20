import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Interface } from "ethers";
import { relayHexOrderId } from "./order-hash.js";
import { RelayClient, type RelayQuoteRequest } from "./client.js";
import {
  RelayWalletQuoteAdapter,
  RelayQuoteEconomicsError,
  RelayQuoteValidationError,
} from "./wallet-adapter.js";
import {
  RELAY_ROUTE_SPECS,
  relayRuntimeRoute,
  assertRelayRouteAssets,
} from "./mappings.js";
import { hypercorePlanTestFixture } from "./hypercore-plan-test-fixture.js";
import {
  hypercorePerpsRefundLocation,
  hypercoreSpotAccountLocation,
  stableOpaqueId,
  canonicalLocationKey,
  stableWalletAssetLocationIdentity,
} from "../../account-value/canonical.js";
import { buildRelayPlanningQuote } from "./operation-plan.js";
import { compileFundingIntentPolicy } from "../../funding/policies/funding-policy-v2.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "../../funding/policies/funding-policy.js";
import { buildRelayWalletSourceOption } from "../../funding/planner/source-options.js";
import type { WalletExecutionProfile } from "../../funding/domain/types.js";
import { withRelayClientSourceDebitPostcondition } from "../../funding/execution/relay-client-source-debit.js";
import type { Pool } from "@hunch/infra";
import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import {
  projectAccountValue,
  resolveEffectiveHeadline,
} from "../../account-value/account-value-projector.js";
import { projectCashAvailability } from "../../account-value/cash-availability-projector.js";
import { HYPERCORE_SPOT_LOCATION_PATTERN } from "../../funding/domain/hypercore-identity.js";
import { fundingDiscoveryRequestSchema } from "../../funding/domain/schemas.js";
import {
  ProductionFundingSourcePlanner,
  resolveProductionOwnedSourceExecution,
  deriveProductionRelayEligibleSourceFacts,
  planProductionFundingSourceBoundaries,
} from "../../funding/planner/production-source-planner.js";
import { resolveRelayHypercoreContracts } from "./hypercore-quote.js";
import { POLYGON_PUSD } from "./rehearsal.js";
import { readFrozenPolymarketHandoffBinding } from "../../funding/domain/polymarket-handoff-binding.js";
import type { FundingCommitPlan } from "../../funding/persistence/funding-operation-repository.js";
import { maximumInternalFundingDestinationRaw } from "../../funding/planner/composite-source-options.js";
import { validateRelayHypercoreInboundQuote } from "./hypercore-inbound-quote.js";
import { formatUnsignedDecimal } from "../../account-value/decimal.js";
import { verifyPlannerHandoffRefundSourceRegression } from "../../funding/tests/handoff-refund-source-regression.js";

const captured = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/hip4/relay-native-routes-20261014.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function fixture(index = 0, lagMs = 20, nativeOwner?: string) {
  let wire = structuredClone(
    captured.routes[index === 2 ? 1 : index].response.body,
  );
  if (index === 2) {
    // Synthetic pUSD protocol shape, not an additional live quote. Keep the
    // captured Polygon wire's complete source/refund/fee binding and rebuild
    // its order commitment/calldata below. Historical pUSD receipt evidence is
    // separate; these tests prove exact runtime token selection and rejection.
    const originalCurrency = String(wire.details.currencyIn.currency.address);
    wire = JSON.parse(JSON.stringify(wire), (_key, value: unknown) =>
      typeof value === "string" &&
      value.toLowerCase() === originalCurrency.toLowerCase()
        ? POLYGON_PUSD
        : value,
    );
  }
  // Synthetic owned destination distinct from the EVM source signer.
  if (nativeOwner) {
    wire.details.recipient = nativeOwner;
    wire.protocol.v2.orderData.output.payments[0].recipient = nativeOwner;
    wire.protocol.v2.orderData.inputs[0].refunds[1].recipient = nativeOwner;
  }
  const now = new Date();
  // Offline quote refresh only: synthesize a deadline/commitment so this test
  // stays reproducible after the captured provider quote expires.
  const deadline = Math.floor(now.getTime() / 1000) + 86400;
  wire.protocol.v2.orderData.output.deadline = deadline;
  for (const refund of wire.protocol.v2.orderData.inputs[0].refunds)
    refund.deadline = deadline;
  wire.protocol.v2.orderId = relayHexOrderId(wire.protocol.v2.orderData);
  wire.steps.find(
    (s: { id: string }) => s.id === "deposit",
  ).items[0].data.data = new Interface([
    "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
  ]).encodeFunctionData("depositErc20", [
    wire.details.sender,
    wire.details.currencyIn.currency.address,
    wire.details.currencyIn.amount,
    wire.protocol.v2.orderId,
  ]);
  const f = hypercorePlanTestFixture(now);
  const spec =
    RELAY_ROUTE_SPECS[
      index === 0
        ? "base-usdc-to-hypercore-spot-usdc"
        : index === 1
          ? "polygon-usdc-to-hypercore-spot-usdc"
          : "polygon-pusd-to-hypercore-spot-usdc"
    ];
  const source = {
    kind: "owned_location" as const,
    location: {
      kind: "wallet" as const,
      accountId: f.quoteInput.source.location.accountId,
      locationId: "evm-source",
      asset: spec.source,
      details: { address: wire.details.sender, walletId: "evm-controller" },
    },
  };
  const destination = {
    ...f.input.destination,
    requiredAsset: spec.destination,
    destinationLocationPatternId: "hypercore-spot-usdc",
    target: {
      kind: "owned_location" as const,
      location: hypercoreSpotAccountLocation({
        accountId: source.location.accountId,
        address: wire.details.recipient,
        controllerWalletId: "native-controller",
      }).location,
    },
    recipientAddress: wire.details.recipient,
    venueId: "hyperliquid",
  };
  const calls: { path: string; body?: RelayQuoteRequest }[] = [];
  const adapter = new RelayWalletQuoteAdapter(
    new RelayClient({
      apiKey: "offline-test-only",
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        calls.push({
          path,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        assert.ok(path === "/chains" || path === "/quote/v2");
        return new Response(
          JSON.stringify(
            path === "/chains" ? { chains: captured.chains } : wire,
          ),
          { status: 200 },
        );
      },
    }),
    () => new Date(Math.max(Date.now(), now.getTime() + lagMs)),
  );
  const input = {
    route: {
      ...spec,
      quoteMode: "exact_input" as "exact_input" | "expected_output",
    },
    source,
    destination: destination.target,
    resolvedDestination: destination,
    sourceAmount: { asset: spec.source, raw: "10000000" },
    minimumOutput: { asset: spec.destination, raw: "850000000" },
    userAddress: wire.details.sender as string,
    recipientAddress: wire.details.recipient as string,
    senderWalletId: "evm-controller",
    quoteCorrelationId: "offline-native-inbound",
    deadline: new Date(now.getTime() + 30000),
    maximumQuoteTtlMs: 30000,
    maximumContractAgeMs: 60000,
    maximumFeeRaw: "1500000",
    maximumSlippageBps: 100,
    nativeRefundLocation: hypercorePerpsRefundLocation({
      accountId: source.location.accountId,
      address: wire.details.recipient,
      controllerWalletId: "native-controller",
    }),
    now,
  };
  return { f, wire, spec, source, destination, adapter, input, calls };
}

function productionInboundFixture(index: number) {
  const f = fixture(index, 20, `0x${"b".repeat(40)}`);
  const now = f.input.now;
  const accountId = f.source.location.accountId;
  const destination = {
    ...f.destination,
    destinationLocationPatternId: HYPERCORE_SPOT_LOCATION_PATTERN,
  };
  const route = relayRuntimeRoute(f.spec, {
    sourceLocationPatternId: "evm-source-usdc",
    destinationLocationPatternId: destination.destinationLocationPatternId,
  });
  const policy = {
    ...DEFAULT_FUNDING_RUNTIME_POLICY,
    placement: {
      ...DEFAULT_FUNDING_RUNTIME_POLICY.placement,
      maximumFeeUsd: "2",
      maximumFeeBps: 2000,
      // Captured minimum is rounded down to six decimal places by Relay;
      // use a policy above its ~200 bps boundary, not an invalid exact floor.
      maximumSlippageBps: 201,
      minimumDestinationUsd: "1",
    },
    providers: [
      { providerId: "relay", enabledCapabilities: [route.capability] },
    ],
    routes: [route],
    locations: [
      {
        locationPatternId: route.sourceLocationPatternId,
        locationKind: "wallet" as const,
        ownership: "owned" as const,
        asset: f.spec.source,
        enabled: true,
        observable: true,
        capabilities: ["observe", "value", "execution_source"] as const,
      },
    ],
  };
  const component = {
    componentId: "offline-inbound-source",
    location: f.source.location,
    amount: { asset: f.spec.source, raw: "12000000" },
    category: "cash" as const,
    estimatedUsd: {
      value: "12",
      asOf: now.toISOString(),
      priceSource: "exact_stable",
      confidence: "high" as const,
      policyId: "exact_stable",
    },
    observedAt: now.toISOString(),
    observationFreshness: "fresh" as const,
    observationError: null,
    valuationEligibility: "included" as const,
    executionEligibility: "eligible" as const,
    reasonCodes: [],
  };
  const profile: WalletExecutionProfile = {
    walletId: "evm-controller",
    controllerWalletRef: "evm-controller",
    address: f.input.userAddress,
    networkId: f.spec.source.networkId,
    source: "external",
    signingModes: ["web_client"],
    serverWalletRef: null,
    sponsorshipPolicyIds: [],
  };
  const nativeProfile: WalletExecutionProfile = {
    ...profile,
    walletId: "native-controller",
    controllerWalletRef: "native-controller",
    address: f.input.recipientAddress,
    networkId: f.spec.destination.networkId,
  };
  const projection = projectAccountValue({
    accountId,
    headlineMode: "liquid_only",
    components: [component],
    positionComponents: [],
    asOf: now.toISOString(),
  });
  const account: AccountValueReadModel = {
    projection,
    headline: resolveEffectiveHeadline(projection),
    cashAvailability: projectCashAvailability({
      components: [component],
      asOf: now.toISOString(),
      adjustments: [
        {
          componentId: component.componentId,
          venueId: null,
          venueBindingId: null,
          lockedRaw: "0",
          reservedRaw: "1000000",
          submittedDebitRaw: "1000000",
        },
      ],
    }),
    nativeGasBalances: [
      {
        networkId: profile.networkId,
        address: profile.address,
        raw: "1000000000000000000",
      },
    ],
    connectedExternalWalletRefs: [profile.walletId, nativeProfile.walletId],
    venues: {},
    policy: {
      creationMode: "off",
      revision: "offline-inbound-policy",
      source: "default",
      invalidStoredPolicy: false,
    },
    runtimePolicy: policy,
    ownership: {
      accountId,
      wallets: [profile, nativeProfile],
      venueBindings: [],
      evidenceRevision: "offline-owned",
      asOf: now.toISOString(),
    },
    ownershipEvidenceRevision: "offline-owned",
    duplicateAssetObservationCount: 0,
    assetPreferences: {},
  };
  const requiredAmount = { asset: f.spec.destination, raw: "850000000" };
  const request = fundingDiscoveryRequestSchema.parse({
    purpose: "add_funds",
    requestedDestinationAmount: requiredAmount,
    confirmedSourceAmount: f.input.sourceAmount,
    destinationOptionId: destination.destinationId,
    marketContextId: null,
    consumerIntent: null,
    withdrawalRecipientId: null,
    venueBindingOptionId: null,
    maxFeeUsd: null,
    maxSlippageBps: null,
    deadline: null,
  });
  const input = {
    accountId,
    account,
    policy,
    policyRevision: account.policy.revision,
    now,
    request,
    requiredAmount,
    marketContext: null,
    destinationFacts: null,
    destination,
    placement: {
      mode: "confirmed_deposit_amount" as const,
      sourceAmount: f.input.sourceAmount,
      destinationRequirement: requiredAmount,
      targetVenueId: null,
      target: destination.target,
      boundedBuffer: null,
      reason: "explicit" as const,
      policyVersion: 1,
    },
  };
  return { ...f, account, input, route, nativeProfile };
}

for (const [index, name] of [
  "Base",
  "Polygon USDC",
  "Polygon pUSD (synthetic)",
].entries()) {
  test(`production planner ${name} inbound uses source-unit fees and the owned zero-balance Core destination`, async (context) => {
    const f = productionInboundFixture(index);
    const keys = [
      "RELAY_API_KEY",
      "CREDENTIALS_ENCRYPTION_KEY",
      "FUNDING_REFERENCE_LOOKUP_HMAC_KEY",
    ];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, {
      RELAY_API_KEY: "offline-inbound-test-only",
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      FUNDING_REFERENCE_LOOKUP_HMAC_KEY:
        "offline-inbound-test-key-at-least-32-chars",
    });
    context.after(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    let quoteCalls = 0;
    let oversizedExpectedQuote = false;
    const requests: RelayQuoteRequest[] = [];
    context.mock.method(
      RelayClient.prototype,
      "quote",
      async (request: RelayQuoteRequest) => {
        quoteCalls++;
        requests.push(request);
        assert.equal(request.originChainId, index === 0 ? 8453 : 137);
        assert.equal(
          request.originCurrency.toLowerCase(),
          f.spec.source.assetId.toLowerCase(),
        );
        assert.equal(request.destinationChainId, 1337);
        if (request.tradeType === "EXACT_INPUT") {
          assert.equal(request.amount, "10000000");
        } else {
          assert.equal(request.tradeType, "EXPECTED_OUTPUT");
          // Target amount is native USDC8, never source USDC6.
          assert.ok(BigInt(request.amount) > 850000000n);
          assert.ok(BigInt(request.amount) < 1000000000n);
        }
        assert.equal(request.protocolVersion, "v2");
        assert.equal(request.includeProtocolData, true);
        assert.equal(request.user, f.wire.details.sender.toLowerCase());
        assert.equal(request.recipient, f.wire.details.recipient.toLowerCase());
        if (oversizedExpectedQuote && request.tradeType === "EXPECTED_OUTPUT") {
          const rejectedQuote = structuredClone(f.wire);
          rejectedQuote.details.currencyIn.amount = "10000001";
          rejectedQuote.details.currencyIn.minimumAmount = "10000001";
          return rejectedQuote;
        }
        return f.wire;
      },
    );
    context.mock.method(
      RelayClient.prototype,
      "hypercoreContracts",
      async () => ({
        ...resolveRelayHypercoreContracts(
          { chains: captured.chains },
          index === 0 ? 8453 : 137,
        ),
        observedAt: f.input.now.toISOString(),
      }),
    );
    context.mock.method(globalThis, "fetch", async () => {
      throw new Error("No external reads in offline planner test");
    });
    const db = {
      query: async (sql: string) => {
        assert.match(sql.trim(), /^select/i);
        return { rows: [] };
      },
    } as unknown as Pool;
    const discover = (account = f.account, request = f.input.request) => {
      assert.ok(account.runtimePolicy);
      return new ProductionFundingSourcePlanner(db, account).discover({
        ...f.input,
        policy: account.runtimePolicy,
        request,
      });
    };
    const result = await discover();
    assert.equal(result.sources.length, 1, JSON.stringify(result));
    const source = result.sources[0];
    assert.equal(
      source.option.selectable,
      true,
      JSON.stringify(source.option.reasonCodes),
    );
    assert.equal(source.option.minimumDestination?.raw, "860341800");
    assert.equal(source.commitPlan.reservations[0].rawAmount, "10000000");
    assert.equal(source.commitPlan.reservations[0].assetDecimals, 6);
    if (index === 2) {
      const controllerAddress = String(f.wire.details.sender);
      const originalComponent = f.account.projection.components[0];
      const funderAddress = `0x${"ac".repeat(20)}`;
      const originLocation = {
        ...originalComponent.location,
        kind: "venue_account",
        locationId: stableOpaqueId(
          "location",
          `${f.input.accountId}:venue_account:${funderAddress}:${f.spec.source.networkId}:${f.spec.source.assetId}`,
        ),
        details: {
          address: funderAddress,
          walletId: "offline-deposit-wallet",
          linkedAddress: controllerAddress,
          controllerWalletId: "evm-controller",
          venueId: "polymarket",
          polymarketFunderKind: "deposit_wallet",
          balanceClass: "polymarket",
        },
      };
      const originComponent = {
        ...originalComponent,
        componentId: stableOpaqueId(
          "asset",
          canonicalLocationKey(originLocation),
        ),
        location: originLocation,
      };
      assert.ok(f.account.ownership);
      const handoffAccount: AccountValueReadModel = {
        ...f.account,
        projection: projectAccountValue({
          accountId: f.input.accountId,
          headlineMode: "liquid_only",
          components: [originComponent],
          positionComponents: [],
          asOf: f.input.now.toISOString(),
        }),
        cashAvailability: projectCashAvailability({
          components: [originComponent],
          adjustments: [],
          asOf: f.input.now.toISOString(),
        }),
        ownership: {
          ...f.account.ownership,
          wallets: [
            ...f.account.ownership.wallets.map((profile) =>
              profile.networkId === "evm:137"
                ? {
                    ...profile,
                    source: "embedded" as const,
                    serverWalletRef: "offline-privy-controller",
                  }
                : profile,
            ),
            {
              walletId: "offline-deposit-wallet",
              networkId: "evm:137",
              address: funderAddress,
              source: "smart",
              signingModes: [],
              serverWalletRef: null,
              controllerWalletRef: "evm-controller",
              sponsorshipPolicyIds: [],
            },
          ],
        },
      };
      assert.ok(
        resolveProductionOwnedSourceExecution({
          account: handoffAccount,
          component: originComponent,
        }),
      );
      const handoffFacts = deriveProductionRelayEligibleSourceFacts({
        accountId: f.input.accountId,
        account: handoffAccount,
        policy: f.input.policy,
        requiredAmount: f.input.requiredAmount,
        confirmedSourceAmount: f.input.request.confirmedSourceAmount,
        destinationLocationPatternId:
          f.input.destination.destinationLocationPatternId,
        purpose: "add_funds",
        now: f.input.now,
      });
      assert.equal(
        handoffFacts.length,
        1,
        JSON.stringify({
          availability: handoffAccount.cashAvailability,
          profile: handoffAccount.ownership?.wallets,
        }),
      );
      assert.equal(handoffFacts[0].nativeGasReady, true);
      assert.equal(handoffFacts[0].walletExecutionReady, true);
      const beforeHandoffQuotes = quoteCalls;
      const handoffResult = await discover(handoffAccount);
      assert.ok(quoteCalls > beforeHandoffQuotes, JSON.stringify(handoffFacts));
      assert.equal(
        handoffResult.sources.length,
        1,
        JSON.stringify(handoffResult),
      );
      const selected = handoffResult.sources[0];
      const frozenBinding = (plan: FundingCommitPlan) =>
        readFrozenPolymarketHandoffBinding({
          currentUserId: f.input.accountId,
          plan,
          segmentOrdinal: 0,
        });
      assert.ok(
        frozenBinding(selected.commitPlan),
        "final selected option retains the exact handoff binding",
      );
      await verifyPlannerHandoffRefundSourceRegression(
        selected.commitPlan,
        f.input.accountId,
      );
      assert.ok(
        readFrozenPolymarketHandoffBinding({
          currentUserId: "merged-current-owner",
          plan: selected.commitPlan,
          segmentOrdinal: 0,
        }),
        "original economic subject survives relational owner migration",
      );
      const mutate = (edit: (plan: FundingCommitPlan) => void) => {
        const plan = structuredClone(selected.commitPlan);
        edit(plan);
        return plan;
      };
      for (const plan of [
        {
          ...selected.commitPlan,
          reservations: selected.commitPlan.reservations.filter(
            (res) => res.economicRole !== "future_credit_fence",
          ),
        },
        {
          ...selected.commitPlan,
          reservations: [
            ...selected.commitPlan.reservations,
            selected.commitPlan.reservations[1],
          ],
        },
        {
          ...selected.commitPlan,
          reservations: selected.commitPlan.reservations.map((res) =>
            res.economicRole === "future_credit_fence"
              ? { ...res, segmentOrdinal: 0 }
              : res,
          ),
        },
        {
          ...selected.commitPlan,
          reservations: selected.commitPlan.reservations.map((res) =>
            res.economicRole === "future_credit_fence"
              ? { ...res, rawAmount: "10000001" }
              : res,
          ),
        },
        {
          ...selected.commitPlan,
          reservations: selected.commitPlan.reservations.map((res) =>
            res.economicRole === "future_credit_fence"
              ? { ...res, componentId: "wrong-controller-component" }
              : res,
          ),
        },
        {
          ...selected.commitPlan,
          reservations: selected.commitPlan.reservations.map((res) =>
            res.economicRole !== "future_credit_fence"
              ? { ...res, locationId: "wrong-economic-source" }
              : res,
          ),
        },
        {
          ...selected.commitPlan,
          steps: selected.commitPlan.steps.map((step) =>
            step.segmentOrdinal === 0
              ? { ...step, dependsOnOrdinal: null }
              : step,
          ),
        },
        {
          ...selected.commitPlan,
          steps: selected.commitPlan.steps.map((step) =>
            step.ordinal === 0
              ? { ...step, actionFingerprint: "wrong-action" }
              : step,
          ),
        },
        {
          ...selected.commitPlan,
          steps: selected.commitPlan.steps.map((step) =>
            step.ordinal === 0
              ? { ...step, executorId: "polymarket_safe_relayer_v1" }
              : step,
          ),
        },
        {
          ...selected.commitPlan,
          operation: {
            ...selected.commitPlan.operation,
            walletExecutionSnapshot: {},
          },
        },
        mutate((plan) => {
          Object.assign(plan.segments[0].sourceSnapshot.location as object, {
            accountId: "wrong-source-owner",
          });
        }),
      ])
        assert.equal(
          frozenBinding(plan),
          null,
          "nearby addresses/amounts, aliases and orphan actions are not handoff authority",
        );
      assert.equal(
        selected.commitPlan.reservations.length,
        2,
        "economic source plus canonical controller future-credit fence",
      );
      assert.deepEqual(
        selected.option.source,
        { kind: "owned_location", location: originLocation },
        "selected option freezes economic venue, not physical controller",
      );
      assert.deepEqual(
        selected.commitPlan.operation.sourceSnapshot,
        selected.option,
      );
      const controller = stableWalletAssetLocationIdentity({
        accountId: f.input.accountId,
        address: controllerAddress,
        asset: f.spec.source,
        balanceClass: "polymarket",
      });
      const execution = selected.commitPlan.segments[0]
        .sourceSnapshot as unknown as {
        location: { locationId: string; details: Record<string, unknown> };
      };
      assert.equal(execution.location.locationId, controller.locationId);
      assert.equal(
        execution.location.details.balanceLocationId,
        undefined,
        "two physical locations are not one alias",
      );
      assert.equal(execution.location.details.balanceClass, "polymarket");
      assert.deepEqual(
        selected.commitPlan.reservations.map((res) => ({
          componentId: res.componentId,
          locationId: res.locationId,
          segment: res.segmentOrdinal,
          role: res.economicRole ?? "source_input",
          raw: res.rawAmount,
        })),
        [
          {
            componentId: originComponent.componentId,
            locationId: originLocation.locationId,
            segment: 0,
            role: "source_input",
            raw: "10000000",
          },
          {
            componentId: controller.componentId,
            locationId: controller.locationId,
            segment: null,
            role: "future_credit_fence",
            raw: "10000000",
          },
        ],
      );
      assert.equal(selected.commitPlan.steps[0].stepKind, "external_handoff");
      assert.equal(selected.commitPlan.steps[0].segmentOrdinal, null);
      await context.test(
        "partial production handoff and Base quotes compose without counting the controller fence twice",
        async (child) => {
          const base = productionInboundFixture(0);
          const partialOrigin = {
            ...originComponent,
            amount: { asset: f.spec.source, raw: "6000000" },
          };
          const baseComponent = {
            ...base.account.projection.components[0],
            location: { ...base.source.location, accountId: f.input.accountId },
            amount: { asset: base.spec.source, raw: "4000000" },
          };
          const components = [partialOrigin, baseComponent];
          const policy = {
            ...f.input.policy,
            routes: [f.route, base.route],
            locations: [
              ...f.input.policy.locations,
              ...base.input.policy.locations,
            ],
          };
          assert.ok(handoffAccount.ownership);
          assert.ok(base.account.ownership);
          const account: AccountValueReadModel = {
            ...handoffAccount,
            runtimePolicy: policy,
            projection: projectAccountValue({
              accountId: f.input.accountId,
              headlineMode: "liquid_only",
              components,
              positionComponents: [],
              asOf: f.input.now.toISOString(),
            }),
            cashAvailability: projectCashAvailability({
              components,
              adjustments: [],
              asOf: f.input.now.toISOString(),
            }),
            nativeGasBalances: [
              ...(handoffAccount.nativeGasBalances ?? []),
              ...(base.account.nativeGasBalances ?? []),
            ],
            ownership: {
              ...handoffAccount.ownership,
              wallets: [
                ...handoffAccount.ownership.wallets,
                ...base.account.ownership.wallets.filter(
                  (profile) => profile.networkId === "evm:8453",
                ),
              ],
            },
          };
          const requiredAmount = {
            asset: f.spec.destination,
            raw: "950000000",
          };
          const destination = {
            ...f.input.destination,
            spendability: {
              observedAmount: { asset: f.spec.destination, raw: "0" },
              availableAmount: { asset: f.spec.destination, raw: "0" },
              lockedRaw: "0",
              reservedRaw: "0",
              submittedDebitRaw: "0",
              revision: "offline-native-zero-baseline",
              asOf: f.input.now.toISOString(),
              expiresAt: new Date(f.input.now.getTime() + 60000).toISOString(),
            },
          };
          const quotedAmounts: string[] = [];
          child.mock.method(
            RelayClient.prototype,
            "quote",
            async (request: RelayQuoteRequest) => {
              assert.ok(
                request.tradeType === "EXACT_INPUT" ||
                  request.tradeType === "EXPECTED_OUTPUT",
              );
              assert.ok(
                request.originChainId === 137 || request.originChainId === 8453,
              );
              const wire = structuredClone(
                request.originChainId === 8453 ? base.wire : f.wire,
              );
              const raw =
                  request.tradeType === "EXACT_INPUT"
                    ? BigInt(request.amount)
                    : request.originChainId === 8453
                      ? 4000000n
                      : 6000000n,
                expected = raw * 100n - 10000000n,
                minimum = (expected * 99n) / 100n;
              assert.ok(raw === 4000000n || raw === 6000000n);
              quotedAmounts.push(raw.toString());
              wire.details.currencyIn.amount =
                wire.details.currencyIn.minimumAmount = raw.toString();
              wire.details.currencyOut.amount = expected.toString();
              wire.details.currencyOut.minimumAmount = minimum.toString();
              if (wire.details.refundCurrency)
                wire.details.refundCurrency.amount =
                  wire.details.refundCurrency.minimumAmount = raw.toString();
              const protocol = wire.protocol.v2;
              protocol.orderData.inputs[0].payment.amount =
                protocol.paymentDetails.amount = raw.toString();
              protocol.orderData.output.payments[0].expectedAmount =
                expected.toString();
              protocol.orderData.output.payments[0].minimumAmount =
                minimum.toString();
              for (const [kind, fee] of Object.entries(wire.fees) as [
                string,
                Record<string, string>,
              ][])
                if (kind !== "gas") {
                  fee.amount = fee.minimumAmount =
                    kind === "relayer" || kind === "relayerGas"
                      ? "100000"
                      : "0";
                  delete fee.amountUsd;
                }
              protocol.orderId = relayHexOrderId(protocol.orderData);
              const erc20 = new Interface([
                "function approve(address spender,uint256 amount)",
                "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
              ]);
              const approve = wire.steps.find(
                (step: { id: string }) => step.id === "approve",
              );
              if (approve) {
                const decoded = erc20.decodeFunctionData(
                  "approve",
                  approve.items[0].data.data,
                );
                approve.items[0].data.data = erc20.encodeFunctionData(
                  "approve",
                  [decoded[0], raw],
                );
              }
              wire.steps.find(
                (step: { id: string }) => step.id === "deposit",
              ).items[0].data.data = erc20.encodeFunctionData("depositErc20", [
                wire.details.sender,
                wire.details.currencyIn.currency.address,
                raw,
                protocol.orderId,
              ]);
              validateRelayHypercoreInboundQuote({
                quote: wire,
                contracts: resolveRelayHypercoreContracts(
                  { chains: captured.chains },
                  request.originChainId,
                ),
                contractsObservedAt: f.input.now,
                maximumContractAgeMs: 60000,
                owner: request.user,
                recipient: request.recipient,
                sourceCurrency: request.originCurrency,
                amountMode:
                  request.tradeType === "EXACT_INPUT"
                    ? "exact_input"
                    : "expected_output",
                authorizedSourceRaw: raw.toString(),
                minimumOutputRaw: "1",
                expectedOutputTargetRaw:
                  request.tradeType === "EXACT_INPUT" ? "1" : request.amount,
                maximumFeeRaw: "2000000",
                now: f.input.now,
                deadline: new Date(f.input.now.getTime() + 30000),
                maximumQuoteTtlMs: 30000,
              });
              return wire;
            },
          );
          child.mock.method(
            RelayClient.prototype,
            "hypercoreContracts",
            async (chainId: 137 | 8453) => ({
              ...resolveRelayHypercoreContracts(
                { chains: captured.chains },
                chainId,
              ),
              observedAt: f.input.now.toISOString(),
            }),
          );
          const result = await new ProductionFundingSourcePlanner(
            db,
            account,
          ).discover({
            ...f.input,
            policy,
            requiredAmount,
            destination,
            request: {
              ...f.input.request,
              confirmedSourceAmount: null,
              requestedDestinationAmount: requiredAmount,
            },
            placement: {
              ...f.input.placement,
              destinationRequirement: requiredAmount,
            },
          });
          assert.equal(
            result.sources.length,
            2,
            JSON.stringify(result.reasonCodes),
          );
          assert.ok(
            quotedAmounts.includes("4000000") &&
              quotedAmounts.includes("6000000"),
          );
          const composite = await planProductionFundingSourceBoundaries({
            adapted: [],
            requiredAmount,
            destinationUnitPriceUsd: "1",
            maximumFeeUsd: "2",
            maximumFeeBps: 2000,
            discoverRelay: async () => result,
          });
          const selectedComposite = composite.sources.find(
            (source) => source.option.source.kind === "composite",
          );
          assert.ok(
            selectedComposite,
            JSON.stringify(
              composite.sources.map((source) => ({
                kind: source.option.kind,
                min: source.option.minimumDestination?.raw,
                reasons: source.option.reasonCodes,
              })),
            ),
          );
          assert.equal(
            selectedComposite.option.minimumDestination?.raw,
            "970200000",
          );
          assert.equal(
            selectedComposite.option.minimumDestination?.asset.decimals,
            8,
          );
          assert.equal(selectedComposite.commitPlan.reservations.length, 3);
          const handoffSegmentOrdinal =
            selectedComposite.commitPlan.segments.findIndex(
              (segment) =>
                segment.sourceSnapshot.kind === "owned_location" &&
                (segment.sourceSnapshot.location as Record<string, unknown>)
                  .locationId === controller.locationId,
            );
          const binding = readFrozenPolymarketHandoffBinding({
            currentUserId: f.input.accountId,
            plan: selectedComposite.commitPlan,
            segmentOrdinal: handoffSegmentOrdinal,
          });
          assert.ok(binding);
          assert.equal(binding.controllerFence.segmentOrdinal, null);
          assert.equal(
            binding.sourceReservation.segmentOrdinal,
            handoffSegmentOrdinal,
          );
          assert.equal(
            binding.economicSource.locationId,
            originLocation.locationId,
          );
          assert.equal(
            maximumInternalFundingDestinationRaw({
              candidates: result.sources,
              destinationAsset: f.spec.destination,
              destinationUnitPriceUsd: "1",
              maximumFeeUsd: "2",
              maximumFeeBps: 2000,
              maximumSlippageBps: 201,
              executionBoundary: "client_handoff",
            }),
            970200000n,
          );
        },
      );
    }
    assert.deepEqual(source.commitPlan.segments[0].quotedMinOutput, {
      asset: f.spec.destination,
      raw: "860341800",
    });
    assert.ok(
      source.commitPlan.steps.every(
        (step) => step.executorId === "wallet_profile_evm_v1",
      ),
    );
    const refund = source.commitPlan.segments[0].refundLocationSnapshot;
    assert.equal(refund?.locationId, f.source.location.locationId);
    assert.deepEqual(refund?.alternativeRefundLocations, {
      version: 1,
      locations: [
        hypercorePerpsRefundLocation({
          accountId: f.input.accountId,
          address: f.nativeProfile.address,
          controllerWalletId: f.nativeProfile.walletId,
        }),
      ],
    });
    assert.equal(
      f.account.projection.components.some(
        (row) => row.amount.asset.networkId === "hyperliquid:mainnet",
      ),
      false,
    );
    for (const maxFeeUsd of ["0.01", "0.000001"]) {
      const rejected = await discover(f.account, {
        ...f.input.request,
        maxFeeUsd,
      });
      assert.ok(rejected.sources.length > 0);
      assert.ok(
        rejected.sources.every(
          (row) =>
            !row.option.selectable &&
            row.option.reasonCodes.includes("fee_limit_exceeded"),
        ),
      );
    }
    const strictSlippage = await discover(f.account, {
      ...f.input.request,
      maxSlippageBps: 199,
    });
    assert.ok(strictSlippage.sources.length > 0);
    assert.ok(
      strictSlippage.sources.every(
        (row) =>
          !row.option.selectable &&
          row.option.reasonCodes.includes("minimum_output_not_met"),
      ),
    );
    // Exercise the adapter's source-unit cap, not just the later shared USD
    // check. Treating USDC6 as USDC8 would admit this captured $1.22 fee.
    const strictPolicyFee = await discover({
      ...f.account,
      runtimePolicy: {
        ...f.input.policy,
        placement: { ...f.input.policy.placement, maximumFeeUsd: "0.02" },
      },
    });
    assert.equal(strictPolicyFee.sources.length, 0);
    assert.ok(strictPolicyFee.reasonCodes.includes("provider_quote_invalid"));
    const beforeRejected = quoteCalls;
    const ownership = f.account.ownership;
    assert.ok(ownership);
    for (const wallets of [
      ownership.wallets.filter(
        (wallet) => wallet.walletId !== f.nativeProfile.walletId,
      ),
      ownership.wallets.map((wallet) =>
        wallet.walletId === f.nativeProfile.walletId
          ? { ...wallet, address: `0x${"f".repeat(40)}` }
          : wallet,
      ),
      [...ownership.wallets, f.nativeProfile],
      ownership.wallets.map((wallet) =>
        wallet.walletId === f.nativeProfile.walletId
          ? { ...wallet, networkId: "hyperliquid:testnet" }
          : wallet,
      ),
    ]) {
      const rejected = await discover({
        ...f.account,
        ownership: { ...ownership, wallets },
      });
      assert.equal(
        rejected.sources.some((row) => row.option.selectable),
        false,
      );
      assert.ok(rejected.reasonCodes.includes("destination_unavailable"));
    }
    const disabled = await discover({
      ...f.account,
      runtimePolicy: {
        ...f.input.policy,
        routes: [{ ...f.route, enabled: false }],
      },
    });
    assert.equal(disabled.sources.length, 0);
    assert.equal(quoteCalls, beforeRejected);
    assert.equal((await discover()).sources[0]?.option.selectable, true);

    const expectedRequest = { ...f.input.request, confirmedSourceAmount: null };
    const requestStart = requests.length;
    const expected = await discover(f.account, expectedRequest);
    assert.equal(expected.sources.length, 1, JSON.stringify(expected));
    assert.equal(expected.sources[0].option.selectable, true);
    assert.equal(expected.sources[0].option.amountMode, "exact_output");
    assert.equal(
      expected.sources[0].commitPlan.reservations[0].rawAmount,
      "10000000",
    );
    assert.deepEqual(
      requests.slice(requestStart).map((request) => request.tradeType),
      ["EXPECTED_OUTPUT"],
    );

    // A quote advertising one source unit beyond the available balance is
    // never committed. The existing bounded retry must validate a fresh exact
    // input quote and expose only its genuine partial output, not $9 funded.
    oversizedExpectedQuote = true;
    const fallbackStart = requests.length;
    const requiredAmount = { asset: f.spec.destination, raw: "900000000" };
    const partial = await new ProductionFundingSourcePlanner(
      db,
      f.account,
    ).discover({
      ...f.input,
      request: {
        ...expectedRequest,
        requestedDestinationAmount: requiredAmount,
      },
      requiredAmount,
      placement: {
        ...f.input.placement,
        destinationRequirement: requiredAmount,
      },
    });
    assert.deepEqual(
      requests.slice(fallbackStart).map((request) => request.tradeType),
      ["EXPECTED_OUTPUT", "EXACT_INPUT"],
    );
    assert.equal(partial.sources.length, 1, JSON.stringify(partial));
    assert.equal(partial.sources[0].option.amountMode, "exact_input");
    assert.equal(
      partial.sources[0].option.minimumDestination?.raw,
      "860341800",
    );
    assert.equal(
      partial.sources[0].commitPlan.reservations[0].rawAmount,
      "10000000",
    );
  });
}

for (const [index, name] of [
  "Base",
  "Polygon USDC",
  "Polygon pUSD (synthetic)",
].entries()) {
  test(`${name} -> HyperCore quote keeps common EVM source actions, precision and immutable refunds`, async () => {
    const f = fixture(index);
    const quote = await f.adapter.quoteHypercoreInbound(f.input);
    assert.equal(f.calls.length, 2);
    const request = f.calls.find((call) => call.path === "/quote/v2")?.body;
    assert.equal(request?.originChainId, index === 0 ? 8453 : 137);
    assert.equal(
      request?.originCurrency.toLowerCase(),
      f.spec.source.assetId.toLowerCase(),
    );
    assert.equal(request?.destinationChainId, 1337);
    assert.equal(request?.destinationCurrency, f.spec.destination.assetId);
    assert.equal(request?.protocolVersion, "v2");
    assert.equal(request?.includeProtocolData, true);
    assert.equal(request?.useDepositAddress, false);
    assert.equal(request?.refundTo, f.input.userAddress.toLowerCase());
    assert.equal(request?.amount, "10000000");
    assert.equal(quote.sourceAmount.asset.decimals, 6);
    assert.equal(quote.candidate.minimumOutput.asset.decimals, 8);
    assert.equal(quote.candidate.minimumOutput.raw, "860341800");
    assert.equal(quote.candidate.expiresAt, f.input.deadline.toISOString());
    assert.deepEqual(
      quote.actions.map((a) => a.kind),
      ["evm_transaction", "evm_transaction"],
    );
    assert.equal(
      quote.candidate.fees.find((fee) => fee.kind === "gas")?.amount.asset
        .decimals,
      18,
    );
    assert.equal(quote.sourceEstimatedUsd, "10");
    const profile: WalletExecutionProfile = {
      walletId: "evm-controller",
      controllerWalletRef: "evm-controller",
      address: f.input.userAddress,
      networkId: f.spec.source.networkId,
      source: "external",
      signingModes: ["web_client"],
      serverWalletRef: null,
      sponsorshipPolicyIds: [],
    };
    const route = relayRuntimeRoute(f.spec, {
      sourceLocationPatternId: "evm-wallet",
      destinationLocationPatternId: f.destination.destinationLocationPatternId,
    });
    const result = await buildRelayPlanningQuote({
      ...f.f.input,
      quote,
      profile,
      route,
      destination: f.destination,
      source: {
        ...f.f.input.source,
        source: f.source,
        sourceLocationPatternId: route.sourceLocationPatternId,
        quoteInputAmount: quote.sourceAmount,
        maximumSourceRaw: quote.sourceAmount.raw,
      },
    });
    assert.equal(result.commitPlan.reservations.length, 1);
    assert.equal(result.commitPlan.reservations[0].locationId, "evm-source");
    assert.equal(result.commitPlan.reservations[0].assetDecimals, 6);
    assert.deepEqual(
      result.commitPlan.steps.map((s) => s.executorId),
      ["wallet_profile_evm_v1", "wallet_profile_evm_v1"],
    );
    assert.equal(
      result.commitPlan.steps[0].actionValidationResult
        ?.postconditionEvidenceKind,
      undefined,
    );
    assert.equal(
      result.commitPlan.steps[0].actionValidationResult?.relayNativeApproval,
      "exact_erc20_approval_v1",
    );
    const deposit = result.commitPlan.steps[1].actionValidationResult;
    assert.equal(
      deposit?.postconditionEvidenceKind,
      "exact_erc20_source_debit_v1",
    );
    assert.equal(deposit?.relayNativeDestination, "hyperliquid:mainnet");
    assert.equal(deposit?.expectedSourceRaw, "10000000");
    assert.equal(deposit?.expectedSourceAssetDecimals, 6);
    const snapshot = result.commitPlan.segments[0].refundLocationSnapshot;
    assert.equal(
      snapshot?.relayProtocolOrderId,
      f.wire.protocol.v2.orderId.toLowerCase(),
    );
    assert.ok(snapshot);
    assert.equal(snapshot.locationId, "evm-source");
    assert.deepEqual(snapshot.alternativeRefundLocations, {
      version: 1,
      locations: [f.input.nativeRefundLocation],
    });
  });
}

test("inbound Polygon stablecoins cannot substitute a different registered source asset", async () => {
  for (const [sourceIndex, quoteIndex] of [
    [1, 2],
    [2, 1],
  ] as const) {
    const source = fixture(sourceIndex);
    const incompatible = fixture(quoteIndex);
    // HTTP is replaced only; the selected source, owned locations, planner
    // amounts and production protocol validation stay real.
    source.adapter.client.quote = async () => incompatible.wire;
    await assert.rejects(
      source.adapter.quoteHypercoreInbound(source.input),
      RelayQuoteValidationError,
    );
  }
});

test("inbound expected-output uses USDC8 floor and common bounded source-cap fallback signal", async () => {
  const f = fixture();
  f.input.route.quoteMode = "expected_output";
  await f.adapter.quoteHypercoreInbound(f.input);
  const request = f.calls.find((call) => call.path === "/quote/v2")?.body;
  assert.equal(request?.tradeType, "EXPECTED_OUTPUT");
  assert.equal(request?.amount, "858499200");
  assert.equal(request?.slippageTolerance, "99");
  const capped = fixture();
  capped.input.route.quoteMode = "expected_output";
  capped.input.sourceAmount.raw = "9999999";
  await assert.rejects(
    capped.adapter.quoteHypercoreInbound(capped.input),
    (error: unknown) =>
      error instanceof RelayQuoteEconomicsError &&
      error.reason === "source_cap_exceeded",
  );
});

test("inbound expected-output rounding preserves the original floor and strict common slippage limit", async (context) => {
  for (const [index, name] of [
    "Base USDC",
    "Polygon USDC",
    "Polygon pUSD",
  ].entries()) {
    for (const [floor, slippage, providerSlippage, target, minimum] of [
      ["197450000", 0, 0, "197450000", "197450000"],
      ["197450000", 1, 0, "197450000", "197450000"],
      ["197450000", 100, 99, "199424400", "197450000"],
      ["197450000", 500, 499, "207820300", "197450000"],
      ["197450001", 0, 0, "197450100", "197450100"],
      ["197450001", 1, 0, "197450100", "197450100"],
      ["197450001", 100, 99, "199424500", "197450100"],
      ["197450001", 500, 499, "207820400", "197450100"],
      ["1", 0, 0, "100", "100"],
      ["1", 1, 0, "100", "100"],
      ["1", 100, 0, "100", "100"],
      ["1", 500, 0, "100", "100"],
      ["101", 0, 0, "200", "200"],
      ["101", 1, 0, "200", "200"],
      ["101", 100, 0, "200", "200"],
      ["101", 500, 0, "200", "200"],
    ] as const) {
      await context.test(
        `${name}: floor ${floor}, ${slippage} bps`,
        async (child) => {
          const f = fixture(index);
          f.input.route.quoteMode = "expected_output";
          f.input.minimumOutput.raw = floor;
          f.input.maximumSlippageBps = slippage;
          f.input.sourceAmount.raw = "5560163";
          const requests: RelayQuoteRequest[] = [];
          child.mock.method(
            f.adapter.client,
            "quote",
            async (request: RelayQuoteRequest) => {
              requests.push(request);
              // Synthetic rounding response, not another provider capture. Keep
              // USDC8 wire/protocol units and rebuild their exact commitments.
              assert.ok(request.slippageTolerance !== undefined);
              const expected = (BigInt(request.amount) / 100n) * 100n;
              const roundedMinimum =
                ((expected * (10000n - BigInt(request.slippageTolerance))) /
                  10000n /
                  100n) *
                100n;
              const wire = structuredClone(f.wire);
              const feeRaw =
                BigInt(wire.fees.relayer.amount) + BigInt(wire.fees.app.amount);
              const sourceRaw = (expected / 100n + feeRaw).toString();
              wire.details.currencyIn.amount =
                wire.details.currencyIn.minimumAmount = sourceRaw;
              wire.details.currencyOut.amount = expected.toString();
              wire.details.currencyOut.minimumAmount =
                roundedMinimum.toString();
              if (wire.details.refundCurrency)
                wire.details.refundCurrency.amount =
                  wire.details.refundCurrency.minimumAmount = sourceRaw;
              const protocol = wire.protocol.v2;
              protocol.orderData.inputs[0].payment.amount =
                protocol.paymentDetails.amount = sourceRaw;
              protocol.orderData.output.payments[0].expectedAmount =
                expected.toString();
              protocol.orderData.output.payments[0].minimumAmount =
                roundedMinimum.toString();
              protocol.orderId = relayHexOrderId(protocol.orderData);
              const erc20 = new Interface([
                "function approve(address spender,uint256 amount)",
                "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
              ]);
              const approve = wire.steps.find(
                (step: { id: string }) => step.id === "approve",
              );
              if (approve) {
                const decoded = erc20.decodeFunctionData(
                  "approve",
                  approve.items[0].data.data,
                );
                approve.items[0].data.data = erc20.encodeFunctionData(
                  "approve",
                  [decoded[0], sourceRaw],
                );
              }
              wire.steps.find(
                (step: { id: string }) => step.id === "deposit",
              ).items[0].data.data = erc20.encodeFunctionData("depositErc20", [
                wire.details.sender,
                wire.details.currencyIn.currency.address,
                sourceRaw,
                protocol.orderId,
              ]);
              return wire;
            },
          );
          const quote = await f.adapter.quoteHypercoreInbound(f.input);
          assert.equal(requests.length, 1);
          assert.equal(requests[0].tradeType, "EXPECTED_OUTPUT");
          assert.equal(requests[0].amount, target);
          assert.equal(
            requests[0].slippageTolerance,
            providerSlippage.toString(),
          );
          assert.equal(quote.candidate.minimumOutput.raw, minimum);
          assert.ok(BigInt(minimum) >= BigInt(floor));
          assert.equal(f.input.minimumOutput.raw, floor);
          assert.equal(f.input.sourceAmount.raw, "5560163");
          const option = buildRelayWalletSourceOption({
            sourceOptionId: "rounding-inbound-source",
            safeLabel: name,
            maximumSourceRaw: f.input.sourceAmount.raw,
            quotedSourceAmount: quote.sourceAmount,
            estimatedUsd: quote.sourceEstimatedUsd,
            quote: quote.candidate,
            feeUsd: quote.feeUsd,
            route: relayRuntimeRoute(f.spec, {
              sourceLocationPatternId: "source",
              destinationLocationPatternId: "destination",
            }),
            routeObservation: null,
            routeExperiencePolicy:
              DEFAULT_FUNDING_RUNTIME_POLICY.routeExperience,
            maximumFeeUsd: "10",
            maximumFeeBps: 10000,
            warningFeeUsd: "5",
            warningFeeBps: 10000,
            minimumDestinationUsd: "0",
            maximumSlippageBps: slippage,
            minimumDestinationEstimatedUsd: formatUnsignedDecimal(
              BigInt(minimum),
              f.spec.destination.decimals,
            ),
          });
          assert.equal(
            option.reasonCodes.includes("minimum_output_not_met"),
            false,
          );
          assert.equal(
            option.reasonCodes.includes("provider_quote_invalid"),
            false,
          );
        },
      );
    }
  }
});

test("inbound expected-output still rejects a provider minimum one native atom below the original floor", async () => {
  const f = fixture();
  f.input.route.quoteMode = "expected_output";
  f.input.minimumOutput.raw = (
    BigInt(f.wire.details.currencyOut.minimumAmount) + 1n
  ).toString();
  await assert.rejects(
    f.adapter.quoteHypercoreInbound(f.input),
    (error: unknown) =>
      error instanceof RelayQuoteEconomicsError &&
      error.reason === "minimum_floor",
  );
  assert.equal(f.calls.filter((call) => call.path === "/quote/v2").length, 1);
});

test("inbound rounding cannot turn an invalid user slippage limit into an allowed provider request", async () => {
  for (const maximumSlippageBps of [-1, 501, 0.5, Number.NaN]) {
    const f = fixture();
    await assert.rejects(
      f.adapter.quoteHypercoreInbound({ ...f.input, maximumSlippageBps }),
      /slippage limit is outside hard policy/,
    );
    assert.equal(f.calls.length, 0);
  }
});

test("inbound atomic deposit freezes one exact source debit; approval and incompatible asset do not", async () => {
  const f = fixture();
  const quote = await f.adapter.quoteHypercoreInbound(f.input);
  const calls = quote.actions.map((action) => {
    assert.equal(action.kind, "evm_transaction");
    if (action.kind !== "evm_transaction")
      throw new Error("bad fixture action");
    return {
      actionId: action.actionId,
      to: action.to,
      valueRaw: action.valueRaw,
      data: action.data,
    };
  });
  const input = {
    action: {
      kind: "evm_transaction_batch" as const,
      actionId: "batch",
      networkId: f.spec.source.networkId,
      senderWalletId: f.input.senderWalletId,
      calls,
    },
    actionValidationResult: {
      signerAddress: f.input.userAddress,
      relayStepKind: "deposit",
    },
    routeId: f.spec.routeId,
    sourceAmount: quote.sourceAmount,
  };
  assert.equal(
    withRelayClientSourceDebitPostcondition(input).postconditionEvidenceKind,
    "exact_erc20_source_debit_v1",
  );
  assert.equal(
    withRelayClientSourceDebitPostcondition(input).relayNativeApproval,
    undefined,
  );
  for (const sourceAmount of [
    {
      ...quote.sourceAmount,
      asset: { ...quote.sourceAmount.asset, decimals: 8 },
    },
    {
      ...quote.sourceAmount,
      asset: { ...quote.sourceAmount.asset, networkId: "evm:137" },
    },
  ])
    assert.equal(
      withRelayClientSourceDebitPostcondition({ ...input, sourceAmount })
        .postconditionEvidenceKind,
      undefined,
    );
  assert.equal(
    withRelayClientSourceDebitPostcondition({
      ...input,
      action: { ...input.action, calls: [calls[0]] },
    }).postconditionEvidenceKind,
    undefined,
  );
});

test("only a separate exact native-inbound approve is classified non-money", async () => {
  const f = fixture();
  const quote = await f.adapter.quoteHypercoreInbound(f.input);
  const action = quote.actions[0];
  assert.equal(action.kind, "evm_transaction");
  if (action.kind !== "evm_transaction")
    throw new Error("bad approval fixture");
  const input = {
    action,
    routeId: f.spec.routeId,
    sourceAmount: quote.sourceAmount,
    actionValidationResult: {
      signerAddress: f.input.userAddress,
      relayStepKind: "approve",
    },
  };
  assert.equal(
    withRelayClientSourceDebitPostcondition(input).relayNativeApproval,
    "exact_erc20_approval_v1",
  );
  const approval = new Interface([
    "function approve(address spender,uint256 amount)",
  ]);
  for (const changed of [
    { ...action, valueRaw: "1" },
    { ...action, data: "0x" },
    { ...action, data: action.data + "00" },
    { ...action, to: `0x${"f".repeat(40)}` },
    {
      ...action,
      data: approval.encodeFunctionData("approve", [
        `0x${"f".repeat(40)}`,
        "10000000",
      ]),
    },
    {
      ...action,
      data: approval.encodeFunctionData("approve", [
        "0x0000000000001ff3684f28c67538d4d072c22734",
        "10000001",
      ]),
    },
    quote.actions[1],
  ])
    assert.equal(
      withRelayClientSourceDebitPostcondition({ ...input, action: changed })
        .relayNativeApproval,
      undefined,
    );
  assert.equal(
    withRelayClientSourceDebitPostcondition({
      ...input,
      routeId: "base-usdc-to-polygon-usdc",
    }).relayNativeApproval,
    undefined,
  );
});

test("inbound stale, missing floor, malformed protocol and fee cap remain diagnostic errors", async () => {
  const delayed = fixture(0, 30000);
  await assert.rejects(
    delayed.adapter.quoteHypercoreInbound(delayed.input),
    /deadline expired/,
  );
  const f = fixture();
  await assert.rejects(
    f.adapter.quoteHypercoreInbound({ ...f.input, maximumFeeRaw: "0" }),
    RelayQuoteValidationError,
  );
  await assert.rejects(
    f.adapter.quoteHypercoreInbound({
      ...f.input,
      minimumOutput: { ...f.input.minimumOutput, raw: "2000000000" },
    }),
    (error: unknown) =>
      error instanceof RelayQuoteEconomicsError &&
      error.reason === "minimum_floor",
  );
  f.wire.protocol.v2.orderId = "untrusted-provider-payload";
  await assert.rejects(
    f.adapter.quoteHypercoreInbound(f.input),
    (error: unknown) =>
      error instanceof RelayQuoteValidationError &&
      !error.message.includes("untrusted-provider-payload"),
  );
});

test("invalid native inbound ownership/refund/precision never starts provider reads", async () => {
  const f = fixture();
  for (const input of [
    { ...f.input, senderWalletId: "wrong-controller" },
    { ...f.input, userAddress: `0x${"b".repeat(40)}` },
    { ...f.input, recipientAddress: `0x${"b".repeat(40)}` },
    { ...f.input, nativeRefundLocation: f.destination.target.location },
    {
      ...f.input,
      nativeRefundLocation: {
        ...f.input.nativeRefundLocation,
        accountId: "another-account",
      },
    },
    {
      ...f.input,
      minimumOutput: {
        ...f.input.minimumOutput,
        asset: { ...f.spec.destination, decimals: 6 },
      },
    },
    {
      ...f.input,
      resolvedDestination: {
        ...f.destination,
        target: {
          ...f.destination.target,
          location: {
            ...f.destination.target.location,
            details: {
              ...f.destination.target.location.details,
              address: `0x${"b".repeat(40)}`,
            },
          },
        },
      },
    },
  ])
    await assert.rejects(f.adapter.quoteHypercoreInbound(input));
  await assert.rejects(f.adapter.quote(f.input), /exact protocol adapter/);
  assert.equal(f.calls.length, 0);
});

test("registered inbound contracts neither enable policy nor allow counterfeit assets/VMs", () => {
  const f = fixture();
  const compiled = compileFundingIntentPolicy({
    version: 2,
    venues: ["polymarket", "limitless"],
    receive: {
      assets: ["base:usdc", "polygon:usdc", "solana:usdc"],
      privy: false,
    },
    paused: false,
  });
  assert.ok(
    compiled.routes.every(
      (route) =>
        route.sourceAsset.networkId !== "hyperliquid:mainnet" &&
        route.destinationAsset.networkId !== "hyperliquid:mainnet",
    ),
  );
  assert.equal(
    relayRuntimeRoute(f.spec, {
      sourceLocationPatternId: "a",
      destinationLocationPatternId: "b",
    }).networkExecutorId,
    "wallet_profile_evm_v1",
  );
  assert.throws(() =>
    assertRelayRouteAssets(
      {
        ...f.spec,
        source:
          RELAY_ROUTE_SPECS["hypercore-spot-usdc-to-polygon-pusd"].destination,
      },
      f.spec.source,
      f.spec.destination,
    ),
  );
  assert.throws(() =>
    assertRelayRouteAssets(
      { ...f.spec, sourceVm: "hypercore" },
      f.spec.source,
      f.spec.destination,
    ),
  );
});

test("inbound USDC fee USD/BPS limits use exact raw fees, not provider amountUsd", async () => {
  for (const displayedUsd of ["0", undefined]) {
    const f = fixture();
    for (const [kind, fee] of Object.entries(f.wire.fees) as [
      string,
      Record<string, unknown>,
    ][]) {
      if (kind === "gas") continue;
      if (displayedUsd === undefined) delete fee.amountUsd;
      else fee.amountUsd = displayedUsd;
    }
    const quote = await f.adapter.quoteHypercoreInbound(f.input);
    const relayerIndex = quote.candidate.fees.findIndex(
      (fee) => fee.kind === "relayer",
    );
    assert.equal(quote.feeUsd[relayerIndex], "1.221002");
    const build = (maximumFeeUsd: string, maximumFeeBps: number) =>
      buildRelayWalletSourceOption({
        sourceOptionId: "inbound-offline-source",
        safeLabel: "USDC",
        maximumSourceRaw: f.input.sourceAmount.raw,
        quotedSourceAmount: quote.sourceAmount,
        estimatedUsd: quote.sourceEstimatedUsd,
        quote: quote.candidate,
        feeUsd: quote.feeUsd,
        route: relayRuntimeRoute(f.spec, {
          sourceLocationPatternId: "source",
          destinationLocationPatternId: "destination",
        }),
        routeObservation: null,
        routeExperiencePolicy: DEFAULT_FUNDING_RUNTIME_POLICY.routeExperience,
        maximumFeeUsd,
        maximumFeeBps,
        warningFeeUsd: "2",
        warningFeeBps: 2000,
        minimumDestinationUsd: "0",
        maximumSlippageBps: 201,
        minimumDestinationEstimatedUsd: "8.603418",
      });
    assert.equal(build("0.01", 10000).selectable, false, "absolute user cap");
    assert.equal(build("2", 1).selectable, false, "BPS policy cap");
    const recovered = build("2", 2000);
    assert.equal(
      recovered.selectable,
      true,
      JSON.stringify(recovered.reasonCodes),
    );
  }
});

test("pUSD conversion cost is part of the quoted source debit and common fee limits", async () => {
  const f = fixture(2);
  f.input.route.quoteMode = "expected_output";
  f.input.sourceAmount.raw = "5560163";
  f.input.minimumOutput.raw = "197450000";
  const sourceRaw = "3215010";
  const wire = f.wire;
  wire.details.currencyIn.amount = wire.details.currencyIn.minimumAmount =
    sourceRaw;
  wire.details.currencyOut.amount = "199444500";
  // Preserve the observed source/expected-output economics and simulate the
  // provider minimum at the now-tighter 99 bps, not the old 100 bps wire.
  wire.details.currencyOut.minimumAmount = "197469900";
  if (wire.details.refundCurrency)
    wire.details.refundCurrency.amount =
      wire.details.refundCurrency.minimumAmount = sourceRaw;
  const protocol = wire.protocol.v2;
  protocol.orderData.inputs[0].payment.amount = protocol.paymentDetails.amount =
    sourceRaw;
  protocol.orderData.output.payments[0].expectedAmount = "199444500";
  protocol.orderData.output.payments[0].minimumAmount = "197469900";
  protocol.orderId = relayHexOrderId(protocol.orderData);
  const erc20 = new Interface([
    "function approve(address spender,uint256 amount)",
    "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
  ]);
  const approve = wire.steps.find(
    (step: { id: string }) => step.id === "approve",
  );
  if (approve) {
    const decoded = erc20.decodeFunctionData(
      "approve",
      approve.items[0].data.data,
    );
    approve.items[0].data.data = erc20.encodeFunctionData("approve", [
      decoded[0],
      sourceRaw,
    ]);
  }
  wire.steps.find(
    (step: { id: string }) => step.id === "deposit",
  ).items[0].data.data = erc20.encodeFunctionData("depositErc20", [
    wire.details.sender,
    wire.details.currencyIn.currency.address,
    sourceRaw,
    protocol.orderId,
  ]);
  for (const [kind, fee] of Object.entries(wire.fees) as [
    string,
    Record<string, string>,
  ][]) {
    fee.amount = fee.minimumAmount =
      kind === "relayer"
        ? "1220130"
        : kind === "relayerGas"
          ? "1199730"
          : kind === "relayerService"
            ? "20400"
            : "0";
    fee.amountUsd = "0";
  }
  const originalWire = structuredClone(wire);
  const quote = await f.adapter.quoteHypercoreInbound(f.input);
  assert.equal(f.calls.filter((call) => call.path === "/quote/v2").length, 1);
  assert.equal(
    f.calls.find((call) => call.path === "/quote/v2")?.body?.slippageTolerance,
    "99",
  );
  assert.deepEqual(
    wire,
    originalWire,
    "normalization must not alter provider wire",
  );
  assert.equal(quote.sourceAmount.raw, sourceRaw);
  assert.equal(quote.actions.length, 2, "derived cost adds no money action");
  assert.deepEqual(quote.candidate.fees, [
    { kind: "relayer", amount: { asset: f.spec.source, raw: "1220130" } },
    { kind: "swap", amount: { asset: f.spec.source, raw: "435" } },
  ]);
  assert.deepEqual(quote.feeUsd, ["1.22013", "0.000435"]);
  const option = buildRelayWalletSourceOption({
    sourceOptionId: "pusd-inbound-source",
    safeLabel: "pUSD",
    maximumSourceRaw: f.input.sourceAmount.raw,
    quotedSourceAmount: quote.sourceAmount,
    estimatedUsd: quote.sourceEstimatedUsd,
    quote: quote.candidate,
    feeUsd: quote.feeUsd,
    route: relayRuntimeRoute(f.spec, {
      sourceLocationPatternId: "source",
      destinationLocationPatternId: "destination",
    }),
    routeObservation: null,
    routeExperiencePolicy: DEFAULT_FUNDING_RUNTIME_POLICY.routeExperience,
    maximumFeeUsd: "10",
    maximumFeeBps: 2000,
    warningFeeUsd: "5",
    warningFeeBps: 1000,
    minimumDestinationUsd: "0.5",
    maximumSlippageBps: 100,
    minimumDestinationEstimatedUsd: "1.9745",
  });
  assert.equal(option.selectable, false);
  assert.ok(option.reasonCodes.includes("fee_limit_exceeded"));
  assert.equal(option.reasonCodes.includes("minimum_output_not_met"), false);
  assert.equal(option.reasonCodes.includes("provider_quote_invalid"), false);
  assert.deepEqual(
    option.fees.map((fee) => fee.estimatedUsd),
    ["1.22013", "0.000435"],
  );
  const route = relayRuntimeRoute(f.spec, {
    sourceLocationPatternId: "evm-wallet",
    destinationLocationPatternId: f.destination.destinationLocationPatternId,
  });
  const planned = await buildRelayPlanningQuote({
    ...f.f.input,
    quote,
    route,
    destination: f.destination,
    profile: {
      walletId: "evm-controller",
      controllerWalletRef: "evm-controller",
      address: f.input.userAddress,
      networkId: f.spec.source.networkId,
      source: "external",
      signingModes: ["web_client"],
      serverWalletRef: null,
      sponsorshipPolicyIds: [],
    },
    source: {
      ...f.f.input.source,
      source: f.source,
      sourceLocationPatternId: route.sourceLocationPatternId,
      quoteInputAmount: quote.sourceAmount,
      maximumSourceRaw: f.input.sourceAmount.raw,
    },
  });
  assert.equal(planned.commitPlan.reservations.length, 1);
  assert.equal(planned.commitPlan.reservations[0].rawAmount, sourceRaw);
  assert.equal(planned.commitPlan.segments[0].quotedInput.raw, sourceRaw);
  assert.equal(planned.commitPlan.steps.length, 2);
  assert.deepEqual(planned.candidate.fees, quote.candidate.fees);
  assert.deepEqual(planned.feeUsd, ["1.22013", "0.000435"]);
});
