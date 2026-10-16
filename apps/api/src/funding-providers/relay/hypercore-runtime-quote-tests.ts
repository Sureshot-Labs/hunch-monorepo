import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RelayClient, type RelayQuoteRequest } from "./client.js";
import {
  RelayWalletQuoteAdapter,
  RelayQuoteEconomicsError,
  RelayQuoteValidationError,
} from "./wallet-adapter.js";
import { hypercorePlanTestFixture } from "./hypercore-plan-test-fixture.js";
import {
  RELAY_ROUTE_SPECS,
  resolveRelayRouteSpec,
  relayRuntimeRoute,
} from "./mappings.js";
import { hypercorePerpsRefundLocation } from "../../account-value/canonical.js";
import { buildRelayPlanningQuote } from "./operation-plan.js";
import { compileFundingIntentPolicy } from "../../funding/policies/funding-policy-v2.js";
import { withWithdrawalPlanningContract } from "../../funding/domain/withdrawal-contract.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "../../funding/policies/funding-policy.js";
import {
  zeroNativeTransferFeeObservation,
  NativeTransferFeeCapabilityError,
} from "../../services/hip4-transfer-fee-capability.js";

function fixture(
  options: {
    mode?: "exact_input" | "expected_output";
    lagMs?: number;
    cap?: string;
    sourceDex?: "spot" | "";
    nativeFee?: string;
    sourceHasSentTx?: boolean;
  } = {},
) {
  const now = new Date();
  const f = hypercorePlanTestFixture(
    now,
    undefined,
    undefined,
    undefined,
    options.sourceDex,
  );
  const destination = f.input.destination;
  const calls: { path: string; body?: RelayQuoteRequest }[] = [];
  const chains = JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/hip4/relay-native-quote-20261014.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).chains;
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
            path === "/chains" ? { chains } : f.quoteInput.validation.quote,
          ),
          { status: 200 },
        );
      },
    }),
    // The client timestamps /chains with the real clock. Under parallel test
    // load simulated completion must not precede that observation.
    () => new Date(Math.max(Date.now(), now.getTime() + (options.lagMs ?? 50))),
    async (binding) =>
      zeroNativeTransferFeeObservation({
        binding,
        sourceCheck: {
          fee: options.nativeFee ?? "0",
          userExists: true,
          userHasSentTx: options.sourceHasSentTx ?? true,
          isSanctioned: false,
        },
        destinationCheck: {
          fee: "0",
          userExists: true,
          userHasSentTx: true,
          isSanctioned: false,
        },
        observedAt: Date.now(),
        expiresAt: Date.now() + 60000,
        now: Date.now(),
      }),
  );
  const input = {
    route: {
      ...resolveRelayRouteSpec(f.input.route),
      quoteMode: options.mode ?? ("exact_input" as const),
    },
    source: f.quoteInput.source,
    destination: destination.target,
    resolvedDestination: destination,
    sourceAmount: {
      ...f.input.quote.sourceAmount,
      raw: options.cap ?? f.input.quote.sourceAmount.raw,
    },
    minimumOutput: { asset: destination.requiredAsset, raw: "9700000" },
    userAddress: f.input.profile.address,
    recipientAddress: f.quoteInput.validation.recipient,
    senderWalletId: f.input.profile.walletId,
    quoteCorrelationId: f.quoteInput.quoteCorrelationId,
    deadline: new Date(now.getTime() + 30000),
    maximumQuoteTtlMs: 30000,
    maximumContractAgeMs: 60000,
    maximumFeeRaw: "10000000",
    maximumSlippageBps: 100,
    nativeRefundLocation: hypercorePerpsRefundLocation({
      accountId: f.quoteInput.source.location.accountId,
      address: f.input.profile.address,
      controllerWalletId: f.input.profile.walletId,
    }),
    now,
  };
  return { f, adapter, input, calls };
}

test("common Relay adapter requests native v2 and produces ordinary commit/reservation with a distinct owned refund", async () => {
  const { f, adapter, input, calls } = fixture();
  const quote = await adapter.quoteHypercore(input);
  const request = calls.find((call) => call.path === "/quote/v2")?.body;
  assert.equal(calls.length, 2);
  assert.equal(request?.originChainId, 1337);
  assert.equal(request?.originCurrency, input.sourceAmount.asset.assetId);
  assert.equal(request?.protocolVersion, "v2");
  assert.equal(request?.includeProtocolData, true);
  assert.equal(request?.refundTo, input.userAddress.toLowerCase());
  assert.equal(request?.tradeType, "EXACT_INPUT");
  assert.equal(request?.amount, input.sourceAmount.raw);
  assert.equal(quote.nativeRefundLocation?.details.nativeSourceDex, "");
  assert.notEqual(
    quote.nativeRefundLocation?.locationId,
    input.source.location.locationId,
  );
  assert.equal(
    quote.nativeRefundLocation?.details.controllerWalletId,
    input.senderWalletId,
  );
  assert.equal(quote.candidate.expiresAt, input.deadline.toISOString());
  const result = await buildRelayPlanningQuote({ ...f.input, quote });
  assert.equal(result.commitPlan.reservations.length, 1);
  assert.equal(
    result.commitPlan.reservations[0].locationId,
    input.source.location.locationId,
  );
  assert.equal(result.commitPlan.reservations[0].assetDecimals, 8);
  assert.equal(result.commitPlan.steps.length, 2);
  assert.deepEqual(
    result.commitPlan.steps.map((step) => step.executorId),
    ["relay_hypercore_native_v1", "relay_hypercore_native_v1"],
  );
});

test("native quotes exclude unverified activation fees before Review and recover on explicit refresh", async () => {
  const options = { nativeFee: "1.00", sourceHasSentTx: true };
  const f = fixture(options);
  await assert.rejects(
    f.adapter.quoteHypercore(f.input),
    NativeTransferFeeCapabilityError,
  );
  options.nativeFee = "0";
  options.sourceHasSentTx = false;
  await assert.rejects(
    f.adapter.quoteHypercore(f.input),
    NativeTransferFeeCapabilityError,
  );
  options.sourceHasSentTx = true;
  assert.ok((await f.adapter.quoteHypercore(f.input)).candidate);
  const withoutObserver = new RelayWalletQuoteAdapter(
    f.adapter.client,
    f.adapter.clock,
  );
  await assert.rejects(
    withoutObserver.quoteHypercore(f.input),
    NativeTransferFeeCapabilityError,
  );
});

test("perps recovery quotes the exact class selector and uses the same commit, source reservation and sign-only actions", async () => {
  const { f, adapter, input, calls } = fixture({ sourceDex: "" });
  const quote = await adapter.quoteHypercore(input);
  assert.equal(
    calls.find((call) => call.path === "/quote/v2")?.body?.originCurrency,
    `0x${"0".repeat(32)}`,
  );
  assert.equal(
    input.source.location.asset.assetId,
    "0x6d1e7cde53ba9467b783cb7c530ce054",
  );
  const result = await buildRelayPlanningQuote({ ...f.input, quote });
  assert.equal(result.commitPlan.reservations.length, 1);
  assert.equal(
    result.commitPlan.reservations[0].locationId,
    input.source.location.locationId,
  );
  assert.equal(result.commitPlan.reservations[0].assetDecimals, 8);
  assert.deepEqual(
    result.commitPlan.steps.map((step) => step.executorId),
    ["relay_hypercore_native_v1", "relay_hypercore_native_v1"],
  );
  await assert.rejects(
    adapter.quoteHypercore({
      ...input,
      route: RELAY_ROUTE_SPECS["hypercore-spot-usdc-to-base-usdc"],
    }),
    /native quote binding/,
  );
});

test("native expected-output quote uses common slippage buffer and cap overflow signals bounded exact-input fallback", async () => {
  const ok = fixture({ mode: "expected_output" });
  await ok.adapter.quoteHypercore(ok.input);
  const request = ok.calls.find((call) => call.path === "/quote/v2")?.body;
  assert.equal(request?.tradeType, "EXPECTED_OUTPUT");
  assert.equal(request?.amount, "9797980");
  const capped = fixture({ mode: "expected_output", cap: "999999999" });
  await assert.rejects(
    capped.adapter.quoteHypercore(capped.input),
    (error: unknown) =>
      error instanceof RelayQuoteEconomicsError &&
      error.reason === "source_cap_exceeded",
  );
});

test("native delayed response, fee cap and output floor are not accepted as usable quotes", async () => {
  const delayed = fixture({ lagMs: 30000 });
  await assert.rejects(
    delayed.adapter.quoteHypercore(delayed.input),
    /deadline expired/,
  );
  const fee = fixture();
  await assert.rejects(
    fee.adapter.quoteHypercore({ ...fee.input, maximumFeeRaw: "0" }),
    RelayQuoteValidationError,
  );
  const floor = fixture();
  await assert.rejects(
    floor.adapter.quoteHypercore({
      ...floor.input,
      minimumOutput: { ...floor.input.minimumOutput, raw: "20000000" },
    }),
    (error: unknown) =>
      error instanceof RelayQuoteEconomicsError &&
      error.reason === "minimum_floor",
  );
});

test("native route never falls through legacy EVM/SVM methods or sends a quote for another owner", async () => {
  const f = fixture();
  await assert.rejects(f.adapter.quote(f.input), /exact protocol adapter/);
  await assert.rejects(
    f.adapter.quoteHypercore({ ...f.input, senderWalletId: "wrong" }),
    /source owner/,
  );
  await assert.rejects(
    f.adapter.quoteHypercore({
      ...f.input,
      userAddress: `0x${"ab".repeat(20)}`,
    }),
    /source owner/,
  );
  await assert.rejects(
    f.adapter.quoteHypercore({
      ...f.input,
      source: {
        ...f.input.source,
        location: {
          ...f.input.source.location,
          details: { ...f.input.source.location.details, nativeSourceDex: "" },
        },
      },
    }),
    /binding/,
  );
  assert.equal(f.calls.length, 0);
});

test("native specs preserve default funding policy; withdrawal uses a native account, never a wallet pattern", () => {
  for (const spec of Object.values(RELAY_ROUTE_SPECS).filter(
    (row) => row.sourceVm === "hypercore",
  )) {
    assert.equal(
      relayRuntimeRoute(spec, {
        sourceLocationPatternId: "native",
        destinationLocationPatternId: "destination",
      }).networkExecutorId,
      "relay_hypercore_native_v1",
    );
  }
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
      (route) => route.sourceAsset.networkId !== "hyperliquid:mainnet",
    ),
  );
  const withdrawal = withWithdrawalPlanningContract(
    DEFAULT_FUNDING_RUNTIME_POLICY,
    RELAY_ROUTE_SPECS["hypercore-spot-usdc-to-base-usdc"].destination,
  );
  const nativeRoutes = withdrawal.routes.filter(
    (route) => route.sourceAsset.networkId === "hyperliquid:mainnet",
  );
  assert.equal(nativeRoutes.length, 2);
  assert.deepEqual(
    new Set(nativeRoutes.map((route) => route.sourceLocationPatternId)),
    new Set(["hypercore-spot-usdc-v1", "hypercore-perps-usdc-v1"]),
  );
  assert.equal(nativeRoutes[0].networkExecutorId, "relay_hypercore_native_v1");
  const nativeLocation = withdrawal.locations.find(
    (location) =>
      location.locationPatternId === nativeRoutes[0].sourceLocationPatternId,
  );
  assert.equal(nativeLocation?.locationKind, "venue_account");
  assert.ok(nativeLocation?.capabilities.includes("withdrawal_source"));
  assert.equal(withdrawal.creationMode, "off");
});
