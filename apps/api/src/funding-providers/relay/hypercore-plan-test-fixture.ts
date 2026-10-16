import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  AssetLocation,
  FundingSourceRef,
  WalletExecutionProfile,
} from "../../funding/domain/types.js";
import type { RelayEligibleSourceFact } from "../../funding/planner/source-options.js";
import type { ResolvedRouteDestination } from "../../funding/planner/destination-adapters.js";
import type { FundingRuntimePolicy } from "../../funding/policies/funding-policy.js";
import {
  HYPERCORE_MAINNET_USDC,
  hypercoreSourceLocationPattern,
  RELAY_HYPERCORE_PERPS_CURRENCY,
} from "../../funding/domain/hypercore-identity.js";
import {
  resolveRelayHypercoreContracts,
  type RelayHypercoreQuoteInput,
} from "./hypercore-quote.js";
import { normalizeRelayHypercoreWalletQuote } from "./wallet-adapter.js";
import { createRelayReferenceCodec } from "./reference-codec.js";
import { RELAY_HYPERCORE_EXECUTOR } from "./hypercore-operation-plan.js";
import { relayHexOrderId } from "./order-hash.js";
import {
  hypercoreSpotAccountLocation,
  hypercorePerpsRefundLocation,
} from "../../account-value/canonical.js";

/** Offline fixture only. A fresh synthetic nonce/deadline makes PG integration
 * independent of the captured quote's lifetime; no signature or request runs. */
export function hypercorePlanTestFixture(
  now?: Date,
  accountId: string = randomUUID(),
  offlineOwner?: string,
  quoteLifetimeMs = 60_000,
  sourceDex: "spot" | "" = "spot",
  walletIdOverride?: string,
) {
  let captured = JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/hip4/relay-native-quote-20261014.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  // Multi-session DB tests commit their fixtures. Give them an isolated
  // offline owner instead of colliding with the fixed public SDK example.
  if (offlineOwner) {
    const previousOwner = String(captured.request.user).toLowerCase();
    captured = JSON.parse(JSON.stringify(captured), (_key, value: unknown) =>
      typeof value === "string" && value.toLowerCase() === previousOwner
        ? offlineOwner.toLowerCase()
        : value,
    );
  }
  now ??= new Date(captured.capturedAt);
  const wire = captured.quote;
  if (sourceDex === "") {
    wire.details.currencyIn.currency.address = RELAY_HYPERCORE_PERPS_CURRENCY;
    wire.steps[1].items[0].data.action.parameters.sourceDex = "";
  }
  const nonce = now.getTime();
  wire.steps[0].items[0].data.sign.value.nonce = nonce;
  wire.steps[0].items[0].data.post.body.nonce = nonce;
  wire.steps[1].items[0].data.nonce = nonce;
  wire.steps[1].items[0].data.action.parameters.nonce = nonce;
  const deadline = Math.floor(nonce / 1000) + 86400;
  wire.protocol.v2.orderData.output.deadline = deadline;
  for (const refund of wire.protocol.v2.orderData.inputs[0].refunds)
    refund.deadline = deadline;
  const orderId = relayHexOrderId(wire.protocol.v2.orderData);
  wire.protocol.v2.orderId = orderId;
  wire.steps[0].items[0].data.sign.value.id = orderId;
  wire.steps[0].items[0].data.post.body.id = orderId;
  const walletId = walletIdOverride ?? randomUUID();
  const profile: WalletExecutionProfile = {
    walletId,
    controllerWalletRef: walletId,
    networkId: HYPERCORE_MAINNET_USDC.networkId,
    address: captured.request.user,
    source: "embedded",
    signingModes: ["privy_authorization"],
    serverWalletRef: `offline-wallet-${walletId}`,
    sponsorshipPolicyIds: [],
  };
  const nativeLocationInput = {
    accountId,
    address: profile.address,
    controllerWalletId: walletId,
  };
  const sourceLocation: AssetLocation =
    sourceDex === "spot"
      ? hypercoreSpotAccountLocation(nativeLocationInput).location
      : hypercorePerpsRefundLocation(nativeLocationInput);
  const nativeRefundLocation: AssetLocation = {
    ...sourceLocation,
    locationId: randomUUID(),
    details: {
      ...sourceLocation.details,
      nativeSourceDex: "",
      balanceClass: "perp",
    },
  };
  const sourceRef: Extract<FundingSourceRef, { kind: "owned_location" }> = {
    kind: "owned_location",
    location: sourceLocation,
  };
  const outputAsset = {
    networkId: "evm:8453",
    assetId: captured.request.destinationCurrency as string,
    decimals: 6,
  };
  const destination: ResolvedRouteDestination = {
    destinationId: randomUUID(),
    destinationLocationPatternId: "wallet-base-usdc",
    target: {
      kind: "owned_location",
      location: {
        kind: "wallet",
        locationId: randomUUID(),
        accountId,
        asset: outputAsset,
        details: { walletId, address: captured.request.recipient },
      },
    },
    requiredAsset: outputAsset,
    spendability: null,
    venueId: null,
    venueBindingOption: null,
    externalRecipientId: null,
    recipientAddress: captured.request.recipient,
  };
  const validation: RelayHypercoreQuoteInput = {
    quote: wire,
    contracts: resolveRelayHypercoreContracts(
      { chains: captured.chains },
      8453,
    ),
    contractsObservedAt: now,
    maximumContractAgeMs: Math.max(60000, quoteLifetimeMs),
    owner: profile.address,
    recipient: captured.request.recipient,
    destinationRefundRecipient: profile.address,
    destinationCurrency: captured.request.destinationCurrency,
    sourceDex,
    amountMode: "exact_input",
    authorizedSourceRaw: "1000000000",
    minimumOutputRaw: "9700000",
    expectedOutputTargetRaw: "9700000",
    maximumFeeRaw: "10000000",
    now,
    deadline: new Date(now.getTime() + Math.max(120000, quoteLifetimeMs)),
    maximumQuoteTtlMs: quoteLifetimeMs,
  };
  const quoteInput = {
    validation,
    source: sourceRef,
    destination,
    nativeRefundLocation,
    actorWalletId: walletId,
    quoteCorrelationId: randomUUID(),
  };
  const quote = normalizeRelayHypercoreWalletQuote(quoteInput);
  const route: FundingRuntimePolicy["routes"][number] = {
    routeId:
      sourceDex === "spot"
        ? "hypercore-spot-usdc-to-base-usdc"
        : "hypercore-perps-usdc-to-base-usdc",
    enabled: true,
    providerId: "relay",
    capability: quote.candidate.capability,
    adapterId: "relay_quote_v2",
    adapterVersion: 1,
    sourceLocationPatternId: hypercoreSourceLocationPattern(sourceDex),
    destinationLocationPatternId: destination.destinationLocationPatternId,
    sourceAsset: HYPERCORE_MAINNET_USDC,
    destinationAsset: outputAsset,
    actionValidatorId: RELAY_HYPERCORE_EXECUTOR,
    networkExecutorId: RELAY_HYPERCORE_EXECUTOR,
    reconcilerId: "relay_status_v3",
    refundSemanticsId: "relay_owned_refund_observation_v1",
    destinationObserverId: "relay_owned_destination_observation_v1",
    experienceMode: "prepare_first",
    measuredObservationCount: 0,
    minimumInlineObservationCount: 1,
    fallbackKind: null,
    depositAddress: null,
  };
  const source: RelayEligibleSourceFact = {
    componentId: randomUUID(),
    sourceLocationPatternId: route.sourceLocationPatternId,
    safeLabel: "Hyperliquid USDC",
    source: sourceRef,
    quoteInputAmount: quote.sourceAmount,
    maximumSourceRaw: quote.sourceAmount.raw,
    maximumSlippageBps: 200,
    estimatedUsd: "10",
    transferable: true,
    riskEligible: true,
    walletExecutionReady: true,
    nativeGasReady: true,
    freshness: "fresh",
  };
  const codec = createRelayReferenceCodec({
    encryptionKey: Buffer.alloc(32, 7),
    lookupHmacKey: "offline-native-plan-test-key-at-least-32-chars",
    keyVersion: 1,
  });
  const input = {
    codec,
    destination,
    policyRevision: "test-native-policy",
    profile,
    quote,
    quoteCorrelationId: quoteInput.quoteCorrelationId,
    route,
    source,
    now,
  };
  return { input, quoteInput, wire };
}
