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
import { ProductionFundingSourcePlanner } from "../../funding/planner/production-source-planner.js";
import { resolveRelayHypercoreContracts } from "./hypercore-quote.js";

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
  const wire = structuredClone(captured.routes[index].response.body);
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
        : "polygon-usdc-to-hypercore-spot-usdc"
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

for (const [index, name] of ["Base", "Polygon"].entries()) {
  test(`production planner ${name} inbound uses USDC6 fees and the owned zero-balance Core destination`, async (context) => {
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

for (const [index, name] of ["Base", "Polygon"].entries()) {
  test(`${name} -> HyperCore quote keeps common EVM source actions, precision and immutable refunds`, async () => {
    const f = fixture(index);
    const quote = await f.adapter.quoteHypercoreInbound(f.input);
    assert.equal(f.calls.length, 2);
    const request = f.calls.find((call) => call.path === "/quote/v2")?.body;
    assert.equal(request?.originChainId, index === 0 ? 8453 : 137);
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

test("inbound expected-output uses USDC8 floor and common bounded source-cap fallback signal", async () => {
  const f = fixture();
  f.input.route.quoteMode = "expected_output";
  await f.adapter.quoteHypercoreInbound(f.input);
  const request = f.calls.find((call) => call.path === "/quote/v2")?.body;
  assert.equal(request?.tradeType, "EXPECTED_OUTPUT");
  assert.equal(request?.amount, "858585859");
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
