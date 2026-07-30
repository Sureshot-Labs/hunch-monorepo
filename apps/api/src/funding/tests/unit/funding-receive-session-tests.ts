#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import type {
  DirectIngressObservationVariant,
  DirectIngressVariantObservation,
} from "../../reconciliation/direct-ingress-observer.js";
import type { FundingQuoteSummary } from "../../domain/types.js";
import { SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS } from "../../domain/network-fees.js";
import {
  fundingSidecarRuntimeConfig,
  loadFundingSidecarRuntimeConfig,
} from "../../runtime/sidecar-runtime-config.js";
import { buildFundingReceiveTargets } from "../../planner/receive-targets.js";
import {
  deriveActiveFundingReceiveSessionStatus,
  selectFundingReceiveCanonicalEventTarget,
} from "../../persistence/funding-receive-session-repository.js";
import {
  fundingReceiveChildOperationDisposition,
  fundingReceiveRoutingErrorCode,
  fundingReceiveRoutingNeedsRecovery,
  quoteFundingReceiveReceipt,
  quoteWithinReceiveAutomationPolicy,
  receiveReceiptRoutingAmounts,
} from "../../receive/receive-receipt-router.js";
import type { FundingReceiveReceiptRoutingTarget } from "../../persistence/funding-receive-session-repository.js";
import { fetchSolanaFinalizedSlot } from "../../../services/solana-rpc.js";
import { verifyFundingReceiveVariants } from "../../receive/receive-session-service.js";
import {
  initializeFundingReceiveEventCursors,
  scanFundingReceiveCanonicalEvents,
  type FundingReceiveEventRpc,
} from "../../receive/evm-receive-event-scanner.js";
import {
  initializeSolanaFundingReceiveEventCursors,
  scanSolanaFundingReceiveCanonicalEvents,
} from "../../receive/solana-receive-event-scanner.js";
import {
  advanceFundingReceiveObservationBaselines,
  fundingReceiveObservationDisposition,
  selectFundingReceiveSessionsForPolling,
  selectFundingReceiveSessionObservation,
} from "../../receive/receive-session-observer.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";

const ASSET = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
};

assert.deepEqual(
  loadFundingSidecarRuntimeConfig({
    SOLANA_RPC_URL: "https://primary-solana-rpc.example",
  }).solanaRpcUrls,
  ["https://primary-solana-rpc.example", "https://api.mainnet-beta.solana.com"],
  "a single configured Solana provider must retain an independent fallback",
);
assert.deepEqual(
  loadFundingSidecarRuntimeConfig({
    SOLANA_RPC_URLS:
      "https://primary-solana-rpc.example,https://fallback-solana-rpc.example",
    SOLANA_RPC_URL: "https://ignored-solana-rpc.example",
  }).solanaRpcUrls,
  ["https://primary-solana-rpc.example", "https://fallback-solana-rpc.example"],
  "an explicit ordered Solana RPC list must remain authoritative",
);

const originalFetch = globalThis.fetch;
const rpcCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  rpcCalls.push(url);
  if (url === "https://primary-solana-rpc.example") {
    return new Response("provider unavailable", {
      status: 503,
      statusText: "Service Unavailable",
    });
  }
  return Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: 123_456,
  });
}) as typeof fetch;
try {
  assert.equal(
    await fetchSolanaFinalizedSlot({
      rpcUrls: [
        "https://primary-solana-rpc.example",
        "https://fallback-solana-rpc.example",
      ],
      timeoutMs: 1_000,
    }),
    123_456n,
  );
  assert.deepEqual(
    rpcCalls,
    [
      "https://primary-solana-rpc.example",
      "https://fallback-solana-rpc.example",
    ],
    "a provider-local failure must fail over before the receive capability is discarded",
  );
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(
  fundingReceiveRoutingErrorCode({ code: "preparation_unavailable" }),
  "routing_preparation_unavailable",
);
assert.equal(
  fundingReceiveRoutingErrorCode(new Error("provider details stay private")),
  "routing_attempt_failed",
);
assert.equal(
  fundingReceiveRoutingErrorCode({ code: "INVALID CODE" }),
  "routing_attempt_failed",
);
assert.equal(
  fundingReceiveRoutingErrorCode({
    code: "quote_mismatch",
    message: "quote request raw amounts differ from the selected source plan",
  }),
  "routing_quote_amount_mismatch",
);
assert.equal(
  fundingReceiveRoutingErrorCode({
    code: "quote_mismatch",
    message: "selected source plan differs from frozen facts: source,binding",
  }),
  "routing_quote_frozen_facts_mismatch",
);
assert.equal(
  fundingReceiveRoutingNeedsRecovery("routing_preparation_unavailable", 500),
  false,
  "temporary destination inspection failures must keep automatic conversion alive",
);
assert.equal(
  fundingReceiveRoutingNeedsRecovery("route_unavailable", 500),
  false,
  "an accepted automatic receive asset must keep checking for a route",
);
assert.equal(
  fundingReceiveRoutingNeedsRecovery("routing_binding_mismatch", 5),
  true,
  "a non-transient exact-binding contradiction requires recovery",
);
assert.equal(
  fundingReceiveRoutingNeedsRecovery("routing_attempt_failed", 4),
  false,
);
assert.equal(
  fundingReceiveRoutingNeedsRecovery("routing_attempt_failed", 5),
  true,
);
assert.equal(
  fundingReceiveChildOperationDisposition({
    childOperationStatus: "completed",
    broadcastMayHaveOccurred: true,
    hasUnfinishedAttempt: false,
  }),
  "ready",
);
for (const childOperationStatus of ["failed", "cancelled"]) {
  assert.equal(
    fundingReceiveChildOperationDisposition({
      childOperationStatus,
      broadcastMayHaveOccurred: false,
      hasUnfinishedAttempt: false,
    }),
    "review_retry",
  );
  assert.equal(
    fundingReceiveChildOperationDisposition({
      childOperationStatus,
      broadcastMayHaveOccurred: true,
      hasUnfinishedAttempt: false,
    }),
    "recovery",
  );
  assert.equal(
    fundingReceiveChildOperationDisposition({
      childOperationStatus,
      broadcastMayHaveOccurred: false,
      hasUnfinishedAttempt: true,
    }),
    "recovery",
  );
}
for (const childOperationStatus of [
  "refunded",
  "reconcile_required",
  "recovery_required",
]) {
  assert.equal(
    fundingReceiveChildOperationDisposition({
      childOperationStatus,
      broadcastMayHaveOccurred: false,
      hasUnfinishedAttempt: false,
    }),
    "recovery",
  );
}
assert.equal(
  fundingReceiveChildOperationDisposition({
    childOperationStatus: "in_progress",
    broadcastMayHaveOccurred: false,
    hasUnfinishedAttempt: false,
  }),
  "waiting",
);

let routedQuoteRequest:
  | Readonly<{
      selectedSourceOptionId: string;
      confirmedSourceAmount: unknown;
      requestedDestinationAmount: unknown;
    }>
  | undefined;
const routedReceiptAsset = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonPusd,
  decimals: 6,
};
const routedReceiptTarget = {
  userId: "user_receive_route_12345678",
  receiptDestinationLocationId: "location_receive_route_exact_receipt_12345678",
  destinationOptionId: "destination_receive_route_12345678",
  venueBindingOptionId: "binding_receive_route_12345678",
  destinationAsset: {
    networkId: "evm:8453",
    assetId: RELAY_PINNED_ASSETS.baseUsdc,
    decimals: 6,
  },
  automationPolicy: {
    stableConversion: "automatic_within_caps",
    volatileConversion: "review_required",
    maximumFeeUsd: "1",
    maximumFeeBps: 500,
    maximumSlippageBps: 100,
  },
  receipt: {
    rawAmount: "1000000",
    asset: routedReceiptAsset,
    destinationAddress: "0x0000000000000000000000000000000000000003",
  },
} as unknown as FundingReceiveReceiptRoutingTarget;
await quoteFundingReceiveReceipt(
  {
    async liquidity() {
      return {
        liquidityProjectionId: "projection_receive_route_12345678",
        sourceOptions: [
          {
            sourceOptionId: "source_receive_route_same_address_other_location",
            selectable: true,
            amountMode: "exact_input",
            kind: "wallet_asset",
            source: {
              kind: "owned_location",
              location: {
                locationId: "location_receive_route_other_balance_12345678",
                asset: routedReceiptAsset,
                details: {
                  address: "0x0000000000000000000000000000000000000003",
                },
              },
            },
          },
          {
            sourceOptionId: "source_receive_route_12345678",
            selectable: true,
            amountMode: "exact_input",
            kind: "wallet_asset",
            source: {
              kind: "owned_location",
              location: {
                locationId: "location_receive_route_exact_receipt_12345678",
                asset: routedReceiptAsset,
                details: {
                  address: "0x0000000000000000000000000000000000000003",
                },
              },
            },
          },
        ],
      } as never;
    },
    async quote(_userId, request) {
      routedQuoteRequest = request;
      return { quoteId: "quote_receive_route_12345678" } as never;
    },
  },
  routedReceiptTarget,
);
assert.deepEqual(routedQuoteRequest?.confirmedSourceAmount, {
  asset: routedReceiptAsset,
  raw: "1000000",
});
assert.equal(
  routedQuoteRequest?.selectedSourceOptionId,
  "source_receive_route_12345678",
  "receipt routing must bind to the frozen observation variant location, not another balance at the same address",
);
assert.equal(
  routedQuoteRequest?.requestedDestinationAmount,
  null,
  "an automatic exact-input receipt route must not turn the discovery floor into an exact-output quote",
);

function variant(
  variantId: string,
  baselineRaw: string,
  automatic = false,
): DirectIngressObservationVariant {
  return {
    variantId,
    networkId: ASSET.networkId,
    asset: {
      ...ASSET,
      assetId: automatic ? RELAY_PINNED_ASSETS.polygonUsdce : ASSET.assetId,
    },
    destinationAddress: "0x0000000000000000000000000000000000000003",
    destinationLocationId: "location_receive_test_12345678",
    baselineRaw,
    baselineRevision: `baseline_${variantId}_12345678`,
    observation: {
      adapterId: "polymarket_deposit_wallet_assets_v1",
      payload: { field: automatic ? "depositUsdceRaw" : "depositPusdRaw" },
    },
    completion: automatic
      ? { kind: "committed_venue_preparation", stepOrdinal: 0 }
      : { kind: "direct_destination_credit" },
  };
}

function observation(
  variantId: string,
  observedRaw: string,
): DirectIngressVariantObservation {
  return {
    variantId,
    observedRaw,
    revision: `observation_${variantId}_${observedRaw}`,
    observedAt: "2026-07-27T12:00:00.000Z",
  };
}

const direct = variant("ingress_variant_direct_12345678", "100");
const convertible = variant(
  "ingress_variant_convertible_12345678",
  "200",
  true,
);
const solanaUsdc: DirectIngressObservationVariant = {
  ...convertible,
  variantId: "ingress_variant_solana_usdc_12345678",
  networkId: "solana:mainnet",
  asset: {
    networkId: "solana:mainnet",
    assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  destinationAddress: "9xQeWvG816bUx9EPfB1G6QxgXLKWMuD5YpLQwJwN6JY",
  observation: {
    adapterId: "owned_wallet_liquid_balances_v1",
    payload: { balanceKey: "usdc" },
  },
};
const solanaNative: DirectIngressObservationVariant = {
  ...solanaUsdc,
  variantId: "ingress_variant_solana_native_12345678",
  asset: {
    networkId: "solana:mainnet",
    assetId: RELAY_PINNED_ASSETS.solanaNative,
    decimals: 9,
  },
};
const baseUsdc: DirectIngressObservationVariant = {
  ...direct,
  variantId: "ingress_variant_base_usdc_12345678",
  networkId: "evm:8453",
  asset: {
    networkId: "evm:8453",
    assetId: "0x0000000000000000000000000000000000000011",
    decimals: 6,
  },
  destinationAddress: "0x0000000000000000000000000000000000000012",
  destinationLocationId: "location_receive_base_test_12345678",
  observation: {
    adapterId: "owned_destination_spendability_v1",
    payload: {},
  },
};

const targets = buildFundingReceiveTargets([direct, convertible, solanaUsdc]);
assert.equal(targets.length, 2);
assert.deepEqual(
  targets[0]?.acceptedAssets.map((accepted) => accepted.handling),
  ["direct", "automatic_conversion"],
);

assert.deepEqual(
  fundingReceiveObservationDisposition({
    sessionStatus: "expired",
    completion: direct.completion,
  }),
  {
    receiptStatus: "ready",
    sessionStatus: "open",
    late: true,
  },
);
assert.deepEqual(
  fundingReceiveObservationDisposition({
    sessionStatus: "cancelled",
    completion: convertible.completion,
  }),
  {
    receiptStatus: "recovery_required",
    sessionStatus: "recovery_required",
    late: true,
  },
);
assert.equal(targets[1]?.networkId, "solana:mainnet");
assert.equal(targets[1]?.acceptedAssets[0]?.handling, "automatic_conversion");
assert.deepEqual(targets[1]?.acceptedAssets[0]?.senderNativeFeeRequirement, {
  asset: {
    networkId: "solana:mainnet",
    assetId: RELAY_PINNED_ASSETS.solanaNative,
    decimals: 9,
  },
  raw: SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS.toString(),
});

assert.deepEqual(
  receiveReceiptRoutingAmounts({
    receiptAsset: solanaUsdc.asset,
    destinationAsset: {
      networkId: "evm:137",
      assetId: RELAY_PINNED_ASSETS.polygonPusd,
      decimals: 6,
    },
    rawAmount: "3000000",
  }),
  {
    confirmedSourceAmount: {
      asset: solanaUsdc.asset,
      raw: "3000000",
    },
    requestedDestinationAmount: {
      asset: {
        networkId: "evm:137",
        assetId: RELAY_PINNED_ASSETS.polygonPusd,
        decimals: 6,
      },
      raw: "1",
    },
    venuePreparation: false,
  },
);

assert.deepEqual(
  receiveReceiptRoutingAmounts({
    receiptAsset: solanaNative.asset,
    destinationAsset: {
      networkId: "evm:137",
      assetId: RELAY_PINNED_ASSETS.polygonPusd,
      decimals: 6,
    },
    rawAmount: "12500000",
  }),
  {
    confirmedSourceAmount: {
      asset: solanaNative.asset,
      raw: "9500000",
    },
    requestedDestinationAmount: {
      asset: {
        networkId: "evm:137",
        assetId: RELAY_PINNED_ASSETS.polygonPusd,
        decimals: 6,
      },
      raw: "1",
    },
    venuePreparation: false,
  },
);

assert.deepEqual(
  receiveReceiptRoutingAmounts({
    receiptAsset: {
      networkId: "evm:137",
      assetId: RELAY_PINNED_ASSETS.polygonUsdce,
      decimals: 6,
    },
    destinationAsset: {
      networkId: "evm:137",
      assetId: RELAY_PINNED_ASSETS.polygonPusd,
      decimals: 6,
    },
    rawAmount: "3000000",
  }),
  {
    confirmedSourceAmount: null,
    requestedDestinationAmount: {
      asset: {
        networkId: "evm:137",
        assetId: RELAY_PINNED_ASSETS.polygonPusd,
        decimals: 6,
      },
      raw: "3000000",
    },
    venuePreparation: true,
  },
);

assert.deepEqual(
  selectFundingReceiveSessionObservation(
    [direct, convertible],
    [
      observation(direct.variantId, "100"),
      observation(convertible.variantId, "200"),
    ],
  ),
  { kind: "waiting" },
);

const received = selectFundingReceiveSessionObservation(
  [direct, convertible],
  [
    observation(direct.variantId, "123"),
    observation(convertible.variantId, "200"),
  ],
);
assert.equal(received.kind, "received");
if (received.kind === "received") {
  assert.equal(received.variant.variantId, direct.variantId);
  assert.equal(received.delta, 23n);
}

assert.deepEqual(
  selectFundingReceiveSessionObservation(
    [direct, convertible],
    [
      observation(direct.variantId, "123"),
      observation(convertible.variantId, "201"),
    ],
  ),
  {
    kind: "ambiguous",
    variantIds: [direct.variantId, convertible.variantId],
  },
);

const rebased = advanceFundingReceiveObservationBaselines(
  [variant("ingress_variant_rebase_12345678", "500")],
  [observation("ingress_variant_rebase_12345678", "100")],
  "negative_only",
);
assert.equal(rebased?.[0]?.baselineRaw, "100");
assert.equal(
  advanceFundingReceiveObservationBaselines(
    [variant("ingress_variant_positive_12345678", "100")],
    [observation("ingress_variant_positive_12345678", "500")],
    "negative_only",
  ),
  null,
);
assert.equal(
  advanceFundingReceiveObservationBaselines(
    [variant("ingress_variant_positive_12345678", "100")],
    [observation("ingress_variant_positive_12345678", "500")],
    "all_changed",
  )?.[0]?.baselineRaw,
  "500",
);

const overlappingOlder = {
  candidateId: "older",
  userId: "user_receive_overlap_12345678",
  session: {
    receiveSessionId: "receive_session_older_12345678",
    status: "expired" as const,
    openedAt: "2026-07-27T10:00:00.000Z",
  },
  observationVariants: [variant("ingress_variant_overlap_old_12345678", "0")],
};
const overlappingActive = {
  candidateId: "active",
  userId: "user_receive_overlap_12345678",
  session: {
    receiveSessionId: "receive_session_active_12345678",
    status: "open" as const,
    openedAt: "2026-07-27T11:00:00.000Z",
  },
  observationVariants: [variant("ingress_variant_overlap_new_12345678", "0")],
};
const separateStream = {
  candidateId: "separate",
  userId: "user_receive_overlap_12345678",
  session: {
    receiveSessionId: "receive_session_separate_12345678",
    status: "expired" as const,
    openedAt: "2026-07-27T09:00:00.000Z",
  },
  observationVariants: [
    {
      ...variant("ingress_variant_separate_12345678", "0"),
      asset: {
        ...ASSET,
        assetId: "0x0000000000000000000000000000000000000009",
      },
    },
  ],
};
const otherUserSameStream = {
  ...overlappingOlder,
  candidateId: "other-user",
  userId: "user_receive_overlap_other_12345678",
  session: {
    ...overlappingOlder.session,
    receiveSessionId: "receive_session_other_user_12345678",
  },
};
assert.deepEqual(
  selectFundingReceiveSessionsForPolling([
    overlappingOlder,
    separateStream,
    overlappingActive,
    otherUserSameStream,
  ]).map((candidate) => candidate.candidateId),
  ["active", "older", "other-user", "separate"],
);
const sameTimeLargerId = {
  ...overlappingActive,
  candidateId: "same-time-z",
  session: {
    ...overlappingActive.session,
    receiveSessionId: "receive_session_z_12345678",
  },
};
const sameTimeSmallerId = {
  ...overlappingActive,
  candidateId: "same-time-a",
  session: {
    ...overlappingActive.session,
    receiveSessionId: "receive_session_a_12345678",
  },
};
assert.deepEqual(
  selectFundingReceiveSessionsForPolling([
    sameTimeLargerId,
    sameTimeSmallerId,
  ]).map((candidate) => candidate.candidateId),
  ["same-time-a", "same-time-z"],
);
const invalidPersistedSession = {
  ...overlappingActive,
  candidateId: "invalid-persisted",
  session: {
    ...overlappingActive.session,
    receiveSessionId: "receive_session_invalid_persisted_12345678",
  },
  observationVariants: [
    {
      variantId: "ingress_variant_invalid_persisted_12345678",
      networkId: "evm:137",
    },
  ],
};
assert.deepEqual(
  selectFundingReceiveSessionsForPolling([
    invalidPersistedSession,
    separateStream,
  ]).map((candidate) => candidate.candidateId),
  ["separate"],
);

const olderCursorSession = {
  ...overlappingOlder,
  candidateId: "older-cursor",
  observationVariants: [
    {
      ...overlappingOlder.observationVariants[0],
      observation: {
        ...overlappingOlder.observationVariants[0]?.observation,
        payload: {
          ...overlappingOlder.observationVariants[0]?.observation?.payload,
          eventCursorBlock: "100",
          eventIdentity: "evm_erc20_transfer_v1",
        },
      },
    },
  ],
};
const newerCursorSession = {
  ...overlappingActive,
  candidateId: "newer-cursor",
  observationVariants: [
    {
      ...overlappingActive.observationVariants[0],
      observation: {
        ...overlappingActive.observationVariants[0]?.observation,
        payload: {
          ...overlappingActive.observationVariants[0]?.observation?.payload,
          eventCursorBlock: "102",
          eventIdentity: "evm_erc20_transfer_v1",
        },
      },
    },
  ],
};
assert.deepEqual(
  selectFundingReceiveSessionsForPolling([
    newerCursorSession,
    olderCursorSession,
  ]).map((candidate) => candidate.candidateId),
  ["older-cursor", "newer-cursor"],
  "the older stream cursor must scan first so an event at block 101 cannot be skipped",
);

function allocationStartVariant(variantId: string, eventCursorBlock: string) {
  return {
    ...variant(variantId, "0"),
    observation: {
      ...variant(variantId, "0").observation,
      payload: {
        eventCursorBlock,
        eventIdentity: "evm_erc20_transfer_v1",
      },
    },
  };
}

const allocationCandidates = [
  {
    receiveSessionId: "00000000-0000-4000-8000-000000000101",
    userId: "00000000-0000-4000-8000-000000000001",
    openedAt: new Date("2026-07-27T11:00:00.000Z"),
    observationStartVariants: [
      allocationStartVariant("ingress_variant_allocation_old_12345678", "100"),
    ],
  },
  {
    receiveSessionId: "00000000-0000-4000-8000-000000000102",
    userId: "00000000-0000-4000-8000-000000000001",
    openedAt: new Date("2026-07-27T12:00:00.000Z"),
    observationStartVariants: [
      allocationStartVariant("ingress_variant_allocation_new_12345678", "102"),
    ],
  },
] as const;
const allocationInput = {
  networkId: ASSET.networkId,
  assetId: ASSET.assetId,
  destinationAddress: direct.destinationAddress,
  candidates: allocationCandidates,
};
assert.deepEqual(
  selectFundingReceiveCanonicalEventTarget({
    ...allocationInput,
    ledgerHeight: "101",
  }),
  {
    targetReceiveSessionId: "00000000-0000-4000-8000-000000000101",
    errorCode: null,
  },
  "a late-finalized event before the newer start cursor belongs to the older session",
);
assert.deepEqual(
  selectFundingReceiveCanonicalEventTarget({
    ...allocationInput,
    ledgerHeight: "103",
  }),
  {
    targetReceiveSessionId: "00000000-0000-4000-8000-000000000102",
    errorCode: null,
  },
  "an event after the newer start cursor belongs to the newer session",
);
assert.deepEqual(
  selectFundingReceiveCanonicalEventTarget({
    ...allocationInput,
    ledgerHeight: "103",
    candidates: [
      ...allocationCandidates,
      {
        ...allocationCandidates[0],
        receiveSessionId: "00000000-0000-4000-8000-000000000103",
        userId: "00000000-0000-4000-8000-000000000002",
      },
    ],
  }),
  {
    targetReceiveSessionId: null,
    errorCode: "ambiguous_receive_session_owner",
  },
  "a shared canonical stream across users must quarantine instead of assigning by race order",
);

const eventRpc: FundingReceiveEventRpc = {
  async blockNumber() {
    return 100n;
  },
  async transferLogs() {
    return [];
  },
};
const [eventInitialized] = await initializeFundingReceiveEventCursors(
  [direct],
  eventRpc,
);
assert.equal(eventInitialized?.observation.payload.eventCursorBlock, "100");
const initializedNetworkUrls: string[] = [];
const initializedEvmVariants = await initializeFundingReceiveEventCursors(
  [direct, baseUsdc],
  {
    async blockNumber(network) {
      initializedNetworkUrls.push(network.rpcUrl);
      return 101n;
    },
    async transferLogs() {
      return [];
    },
  },
);
assert.deepEqual(
  initializedNetworkUrls.sort(),
  [
    fundingSidecarRuntimeConfig.baseRpcUrl,
    fundingSidecarRuntimeConfig.polygonRpcUrl,
  ].sort(),
);
assert.deepEqual(
  initializedEvmVariants.map(
    (candidate) => candidate.observation.payload.eventCursorBlock,
  ),
  ["101", "101"],
);
await assert.rejects(
  initializeFundingReceiveEventCursors([solanaUsdc], eventRpc),
  /canonical receive-event scanner is unavailable for solana:mainnet/,
);
const initializedSolana = await initializeSolanaFundingReceiveEventCursors(
  [solanaUsdc],
  {
    async finalizedSlot() {
      return 500n;
    },
    async signatures() {
      return [];
    },
    async transaction() {
      return null;
    },
    async blockhash() {
      return null;
    },
  },
);
assert.equal(initializedSolana[0]?.observation.payload.eventCursorSlot, "500");
assert.equal(
  initializedSolana[0]?.observation.payload.eventIdentity,
  "solana_transfer_v1",
);
const solanaSignature = "solana_signature_receive_12345678";
const solanaBlockhash = "solana_blockhash_receive_12345678";
let observedSolanaTokenAccount: string | null = null;
const solanaScan = await scanSolanaFundingReceiveCanonicalEvents(
  initializedSolana,
  new Date("2026-07-27T12:00:00.000Z"),
  {
    async finalizedSlot() {
      return 501n;
    },
    async signatures(input) {
      observedSolanaTokenAccount = input.address;
      return [
        {
          signature: solanaSignature,
          slot: 501n,
          blockTime: 1_785_139_200,
          failed: false,
        },
      ];
    },
    async transaction() {
      return {
        transaction: {
          message: {
            instructions: [
              {
                program: "spl-token",
                parsed: {
                  type: "transferChecked",
                  info: {
                    source: "solana_source_token_account_12345678",
                    destination: observedSolanaTokenAccount,
                    mint: solanaUsdc.asset.assetId,
                    tokenAmount: {
                      amount: "2500000",
                      decimals: 6,
                    },
                  },
                },
              },
            ],
          },
        },
        meta: { err: null, innerInstructions: [] },
      };
    },
    async blockhash() {
      return solanaBlockhash;
    },
  },
);
assert.ok(observedSolanaTokenAccount);
assert.equal(solanaScan?.events[0]?.transactionHash, solanaSignature);
assert.equal(solanaScan?.events[0]?.eventIndex, "outer:0");
assert.equal(solanaScan?.events[0]?.rawAmount, "2500000");
assert.equal(solanaScan?.events[0]?.blockHash, solanaBlockhash);
assert.equal(
  solanaScan?.variants[0]?.observation.payload.eventCursorSignature,
  solanaSignature,
);
const initializedNativeSolana =
  await initializeSolanaFundingReceiveEventCursors([solanaNative], {
    async finalizedSlot() {
      return 700n;
    },
    async signatures() {
      return [];
    },
    async transaction() {
      return null;
    },
    async blockhash() {
      return null;
    },
  });
let observedNativeSolanaAddress: string | null = null;
const nativeSolanaScan = await scanSolanaFundingReceiveCanonicalEvents(
  initializedNativeSolana,
  new Date("2026-07-27T12:00:00.000Z"),
  {
    async finalizedSlot() {
      return 701n;
    },
    async signatures(input) {
      observedNativeSolanaAddress = input.address;
      return [
        {
          signature: "solana_native_signature_receive_12345678",
          slot: 701n,
          blockTime: 1_785_139_200,
          failed: false,
        },
      ];
    },
    async transaction() {
      return {
        transaction: {
          message: {
            instructions: [
              {
                program: "system",
                parsed: {
                  type: "transfer",
                  info: {
                    source: "solana_native_source_receive_12345678",
                    destination: solanaNative.destinationAddress,
                    lamports: 12_500_000,
                  },
                },
              },
            ],
          },
        },
        meta: { err: null, innerInstructions: [] },
      };
    },
    async blockhash() {
      return "solana_native_blockhash_receive_12345678";
    },
  },
);
assert.equal(observedNativeSolanaAddress, solanaNative.destinationAddress);
assert.equal(nativeSolanaScan?.events[0]?.rawAmount, "12500000");
assert.equal(nativeSolanaScan?.events[0]?.eventIndex, "outer:0");
assert.deepEqual(
  fundingReceiveObservationDisposition({
    sessionStatus: "open",
    completion: solanaNative.completion,
    handling: "review_required",
  }),
  {
    receiptStatus: "review_required",
    sessionStatus: "review_required",
    late: false,
  },
);
const scanCalls: Array<Readonly<{ fromBlock: bigint; toBlock: bigint }>> = [];
const eventScan = await scanFundingReceiveCanonicalEvents(
  eventInitialized ? [eventInitialized] : [],
  new Date("2026-07-27T12:00:00.000Z"),
  {
    async blockNumber() {
      return 103n;
    },
    async transferLogs(input) {
      scanCalls.push({
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
      });
      return [
        {
          transactionHash: `0x${"1".repeat(64)}`,
          logIndex: 7,
          blockNumber: 101n,
          blockHash: `0x${"2".repeat(64)}`,
          fromAddress: "0x0000000000000000000000000000000000000004",
          toAddress: direct.destinationAddress,
          rawAmount: 42n,
        },
      ];
    },
  },
);
assert.deepEqual(scanCalls, [{ fromBlock: 101n, toBlock: 102n }]);
assert.equal(eventScan?.events[0]?.eventIndex, "7");
assert.equal(eventScan?.events[0]?.rawAmount, "42");
assert.equal(
  eventScan?.variants[0]?.observation.payload.eventCursorBlock,
  "102",
);

const adaptiveRangeCalls: Array<
  Readonly<{ fromBlock: bigint; toBlock: bigint }>
> = [];
const adaptiveRangeScan = await scanFundingReceiveCanonicalEvents(
  eventInitialized ? [eventInitialized] : [],
  new Date("2026-07-27T12:00:01.000Z"),
  {
    async blockNumber() {
      return 131n;
    },
    async transferLogs(input) {
      adaptiveRangeCalls.push({
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
      });
      if (adaptiveRangeCalls.length === 1) {
        throw new Error(
          "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
        );
      }
      return [];
    },
  },
);
assert.deepEqual(adaptiveRangeCalls, [
  { fromBlock: 101n, toBlock: 130n },
  { fromBlock: 101n, toBlock: 110n },
]);
assert.equal(
  adaptiveRangeScan?.variants[0]?.observation.payload.eventCursorBlock,
  "110",
  "the cursor must advance only through the provider-accepted range",
);

let concurrentEvmScans = 0;
let maximumConcurrentEvmScans = 0;
const secondPolygonVariant = eventInitialized
  ? {
      ...eventInitialized,
      variantId: "ingress_variant_polygon_second_12345678",
      asset: {
        ...eventInitialized.asset,
        assetId: "0x0000000000000000000000000000000000000009",
      },
    }
  : null;
await scanFundingReceiveCanonicalEvents(
  eventInitialized && secondPolygonVariant
    ? [eventInitialized, secondPolygonVariant]
    : [],
  new Date("2026-07-27T12:00:02.000Z"),
  {
    async blockNumber() {
      return 103n;
    },
    async transferLogs() {
      concurrentEvmScans += 1;
      maximumConcurrentEvmScans = Math.max(
        maximumConcurrentEvmScans,
        concurrentEvmScans,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrentEvmScans -= 1;
      return [];
    },
  },
);
assert.equal(
  maximumConcurrentEvmScans,
  1,
  "accepted EVM assets must not burst the shared RPC endpoint",
);

let concurrentSolanaScans = 0;
let maximumConcurrentSolanaScans = 0;
await scanSolanaFundingReceiveCanonicalEvents(
  [initializedSolana[0], initializedSolana[0]]
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate),
    )
    .map((candidate, index) => ({
      ...candidate,
      variantId: `ingress_variant_solana_sequential_${index}_12345678`,
    })),
  new Date("2026-07-27T12:00:03.000Z"),
  {
    async finalizedSlot() {
      return 501n;
    },
    async signatures() {
      concurrentSolanaScans += 1;
      maximumConcurrentSolanaScans = Math.max(
        maximumConcurrentSolanaScans,
        concurrentSolanaScans,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrentSolanaScans -= 1;
      return [];
    },
    async transaction() {
      return null;
    },
    async blockhash() {
      return null;
    },
  },
);
assert.equal(
  maximumConcurrentSolanaScans,
  1,
  "accepted Solana assets must not burst provider compute units",
);

const quote = (feeUsd: string | null): FundingQuoteSummary =>
  ({
    minimumDestination: {
      asset: { ...ASSET, decimals: 6 },
      raw: "1000000",
    },
    fees: [
      {
        kind: "routing",
        amount: { asset: ASSET, raw: "0" },
        estimatedUsd: feeUsd,
      },
    ],
  }) as unknown as FundingQuoteSummary;
const automationPolicy = {
  stableConversion: "automatic_within_caps" as const,
  volatileConversion: "review_required" as const,
  maximumFeeUsd: "0.1",
  maximumFeeBps: 500,
  maximumSlippageBps: 100,
};
assert.equal(
  quoteWithinReceiveAutomationPolicy(quote("0.04"), automationPolicy),
  true,
);
assert.equal(
  quoteWithinReceiveAutomationPolicy(quote("0.06"), automationPolicy),
  false,
  "a fee below the absolute cap must still respect the frozen basis-point cap",
);
assert.equal(
  quoteWithinReceiveAutomationPolicy(quote(null), automationPolicy),
  false,
  "unknown economics must not auto-commit",
);
assert.equal(deriveActiveFundingReceiveSessionStatus([]), "open");
assert.equal(
  deriveActiveFundingReceiveSessionStatus(["ready", "routing"]),
  "processing",
);
assert.equal(
  deriveActiveFundingReceiveSessionStatus([
    "review_required",
    "routing",
    "ready",
  ]),
  "review_required",
  "an unresolved volatile-asset review must remain visible while a stable receipt routes",
);
assert.equal(
  deriveActiveFundingReceiveSessionStatus([
    "review_required",
    "recovery_required",
  ]),
  "recovery_required",
  "recovery must take precedence over every other active receipt state",
);

const availableVariant = variant(
  "ingress_variant_available_network_12345678",
  "0",
  true,
);
const unavailableVariant = {
  ...variant("ingress_variant_unavailable_network_12345678", "0", true),
  networkId: "solana:mainnet",
  asset: {
    networkId: "solana:mainnet",
    assetId: RELAY_PINNED_ASSETS.solanaUsdc,
    decimals: 6,
  },
};
const verifiedVariants = await verifyFundingReceiveVariants(
  {} as Pool,
  {
    operationId: "receive_baseline_resilience_12345678",
    userId: "user_receive_baseline_resilience_12345678",
    purpose: "add_funds",
    marketId: null,
    venueBindingOptionId: "binding_receive_baseline_resilience_12345678",
    requestedAsset: ASSET,
    requestedRaw: "1",
    operationVersion: 1,
    operationState: {
      status: "awaiting_external_funds",
      stage: "source_action",
    },
    variants: [availableVariant, unavailableVariant],
  },
  [availableVariant, unavailableVariant],
  {
    async initializeCursors(variants) {
      if (
        variants.some((candidate) => candidate.networkId === "solana:mainnet")
      ) {
        throw new Error("Solana RPC unavailable");
      }
      return variants;
    },
    async observe(_pool, target) {
      return {
        variants: target.variants.map((candidate) => ({
          variantId: candidate.variantId,
          observedRaw: "42",
          revision: `verified_${candidate.variantId}`,
          observedAt: "2026-07-27T12:00:00.000Z",
        })),
      };
    },
  },
);
assert.deepEqual(
  verifiedVariants.variants.map((candidate) => candidate.variantId),
  [availableVariant.variantId],
  "one unavailable network must not suppress independently verified receive targets",
);
assert.deepEqual(
  verifiedVariants.failures.map((failure) => [
    failure.variantId,
    failure.stage,
  ]),
  [[unavailableVariant.variantId, "cursor"]],
);

console.log(
  "[funding-receive-session-tests] canonical EVM events, amount-free deltas, overlap-safe polling, exact receipts, frozen automation caps, downward rebasing, and mixed-asset ambiguity passed",
);
