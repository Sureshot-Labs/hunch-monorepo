import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  classifyOwnedRouteCanonicalDestinationEvents,
  destinationObservationEvidence,
  observeOwnedRouteDestination,
  ownedRouteExactDestinationCredits,
  ownedRouteProviderCredits,
  ownedRouteSatisfiedAmount,
  OwnedRouteDestinationObserver,
  type OwnedRouteDestinationTarget,
} from "../../reconciliation/owned-route-destination-observer.js";

const target: OwnedRouteDestinationTarget = {
  operationId: "00000000-0000-4000-8000-000000000001",
  providerSegments: [
    {
      segmentId: "00000000-0000-4000-8000-000000000002",
      ordinal: 0,
      asset: {
        networkId: "evm:8453",
        assetId: "0x0000000000000000000000000000000000000005",
        decimals: 6,
      },
      expectedRaw: "1010102",
      minimumRaw: "1000000",
      providerRawStatus: "pending",
      providerDestinationReferenceCount: 0,
    },
  ],
  userId: "00000000-0000-4000-8000-000000000003",
  purpose: "trade_shortfall",
  marketId: "limitless:258338",
  venueBindingOptionId: "binding-option",
  destinationLocationId: "limitless-usdc-location",
  destinationAddress: "0x0000000000000000000000000000000000000004",
  asset: {
    networkId: "evm:8453",
    assetId: "0x0000000000000000000000000000000000000005",
    decimals: 6,
  },
  requestedRaw: "1000000",
  observationThresholdRaw: "1000000",
  baselineRaw: "0",
  baselineRevision: "baseline-revision",
  operationVersion: 4,
  operationState: {
    status: "in_progress",
    stage: "source_action",
  },
};

assert.equal(
  ownedRouteSatisfiedAmount({
    baselineRaw: "0",
    observedRaw: "1000000",
    requestedRaw: "1000000",
  }),
  "1000000",
);

let narrowObservationCalls = 0;
const narrowObservation = await observeOwnedRouteDestination(
  target,
  async (input) => {
    narrowObservationCalls += 1;
    assert.equal(input.networkId, target.asset.networkId);
    assert.deepEqual(input.asset, target.asset);
    assert.equal(input.destinationAddress, target.destinationAddress);
    return "1000000";
  },
);
assert.equal(narrowObservationCalls, 1);
assert.equal(narrowObservation?.observedRaw, "1000000");
assert.match(narrowObservation?.revision ?? "", /^[a-f0-9]{64}$/);
assert.equal(
  ownedRouteSatisfiedAmount({
    baselineRaw: "0",
    observedRaw: "999999",
    requestedRaw: "1000000",
  }),
  null,
);
assert.equal(
  ownedRouteSatisfiedAmount({
    baselineRaw: "500000",
    observedRaw: "1500001",
    requestedRaw: "1000000",
  }),
  "1000000",
);

const primaryProviderSegment = target.providerSegments[0];
assert.ok(primaryProviderSegment);
assert.deepEqual(ownedRouteProviderCredits(target), [
  {
    segmentId: primaryProviderSegment.segmentId,
    ordinal: 0,
    rawAmount: "1000000",
    providerRawStatus: "pending",
    providerDestinationReferenceCount: 0,
  },
]);
assert.deepEqual(
  ownedRouteProviderCredits({
    observationThresholdRaw: "1750000",
    providerSegments: [
      primaryProviderSegment,
      {
        ...primaryProviderSegment,
        segmentId: "00000000-0000-4000-8000-000000000004",
        ordinal: 1,
        expectedRaw: "800000",
        minimumRaw: "750000",
      },
    ],
  }),
  [
    {
      segmentId: primaryProviderSegment.segmentId,
      ordinal: 0,
      rawAmount: "1000000",
      providerRawStatus: "pending",
      providerDestinationReferenceCount: 0,
    },
    {
      segmentId: "00000000-0000-4000-8000-000000000004",
      ordinal: 1,
      rawAmount: "750000",
      providerRawStatus: "pending",
      providerDestinationReferenceCount: 0,
    },
  ],
);

const destinationTransactionHash = `0x${"ab".repeat(32)}`;
const exactReceiptTarget: OwnedRouteDestinationTarget = {
  ...target,
  providerSegments: [
    {
      ...primaryProviderSegment,
      providerRawStatus: "success",
      providerStatusCategory: "provider_success",
      providerDestinationReferenceCount: 1,
      transactionReferenceFingerprints: [`fp:${destinationTransactionHash}`],
    },
  ],
  destinationReceipts: [
    {
      receiptId: "00000000-0000-4000-8000-000000000010",
      receiveSessionId: "00000000-0000-4000-8000-000000000011",
      networkId: target.asset.networkId,
      assetId: target.asset.assetId,
      assetDecimals: target.asset.decimals,
      destinationAddress: target.destinationAddress,
      rawAmount: "1010102",
      txHash: destinationTransactionHash,
      eventIndex: "7",
      ledgerHeight: "123",
      blockHash: `0x${"cd".repeat(32)}`,
      observedAt: "2026-08-14T17:20:15.873Z",
    },
  ],
};
assert.deepEqual(
  ownedRouteExactDestinationCredits(exactReceiptTarget, {
    fingerprint: (reference) => `fp:${reference}`,
  })?.map((credit) => ({
    segmentId: credit.segmentId,
    receiptId: credit.receipt.receiptId,
  })),
  [
    {
      segmentId: primaryProviderSegment.segmentId,
      receiptId: "00000000-0000-4000-8000-000000000010",
    },
  ],
);
assert.equal(
  ownedRouteExactDestinationCredits(exactReceiptTarget, {
    fingerprint: () => "unrelated",
  }),
  null,
  "an unrelated ready receipt cannot satisfy Relay destination evidence",
);

const exactCanonicalTransactionHash = `0x${"12".repeat(32)}`;
const ambiguousCanonicalTransactionHash = `0x${"34".repeat(32)}`;
const externalCanonicalTransactionHash = `0x${"56".repeat(32)}`;
const pendingCanonicalTransactionHash = `0x${"67".repeat(32)}`;
const canonicalDestinationEvents = [
  exactCanonicalTransactionHash,
  ambiguousCanonicalTransactionHash,
  externalCanonicalTransactionHash,
  pendingCanonicalTransactionHash,
].map((transactionHash, eventIndex) => ({
  networkId: target.asset.networkId,
  asset: target.asset,
  destinationAddress: target.destinationAddress,
  sourceAddress: "0x0000000000000000000000000000000000000006",
  rawAmount: "1010102",
  transactionHash,
  eventIndex: String(eventIndex),
  ledgerHeight: String(200 + eventIndex),
  blockHash: `0x${"78".repeat(32)}`,
  observedAt: new Date(`2026-08-14T17:20:1${eventIndex}.873Z`),
}));
const canonicalClassifications =
  await classifyOwnedRouteCanonicalDestinationEvents(
    {
      query: async (sql: string, values?: readonly unknown[]) => {
        assert.match(sql, /relayTransactionReferenceFingerprints/);
        assert.match(sql, /destinationTransactionReferenceCount/);
        assert.match(sql, /funding_account_identifier_equal/);
        assert.match(sql, /candidate_rank <= 2/);
        assert.match(sql, /operation_status not in/);
        const lookups = JSON.parse(String(values?.[1])) as Array<{
          identity: string;
          transactionReferenceFingerprint: string;
        }>;
        assert.deepEqual(
          lookups.map((lookup) => lookup.transactionReferenceFingerprint),
          canonicalDestinationEvents.map(
            (event) => `fingerprint:${event.transactionHash}`,
          ),
        );
        return {
          rows: [
            {
              event_identity: lookups[0]?.identity,
              match_kind: "exact",
              operation_id: target.operationId,
              segment_id: primaryProviderSegment.segmentId,
            },
            {
              event_identity: lookups[1]?.identity,
              match_kind: "exact",
              operation_id: target.operationId,
              segment_id: primaryProviderSegment.segmentId,
            },
            {
              event_identity: lookups[1]?.identity,
              match_kind: "exact",
              operation_id: "00000000-0000-4000-8000-000000000020",
              segment_id: "00000000-0000-4000-8000-000000000021",
            },
            {
              event_identity: lookups[3]?.identity,
              match_kind: "possible",
              operation_id: target.operationId,
              segment_id: primaryProviderSegment.segmentId,
            },
          ],
        };
      },
    } as never,
    {
      userId: target.userId,
      events: canonicalDestinationEvents,
      referenceCodec: {
        fingerprint: (reference) => `fingerprint:${reference}`,
      },
    },
  );
const canonicalIdentity = (transactionHash: string, eventIndex: string) =>
  `${target.asset.networkId}:${transactionHash}:${eventIndex}`;
assert.deepEqual(
  canonicalClassifications.get(
    canonicalIdentity(exactCanonicalTransactionHash, "0"),
  ),
  {
    kind: "internal",
    operationId: target.operationId,
    segmentId: primaryProviderSegment.segmentId,
    transactionReferenceFingerprint: `fingerprint:${exactCanonicalTransactionHash}`,
  },
);
assert.deepEqual(
  canonicalClassifications.get(
    canonicalIdentity(ambiguousCanonicalTransactionHash, "1"),
  ),
  {
    kind: "recovery_required",
    reason: "owned_route_destination_ambiguous",
  },
);
assert.deepEqual(
  canonicalClassifications.get(
    canonicalIdentity(externalCanonicalTransactionHash, "2"),
  ),
  { kind: "external" },
);
assert.deepEqual(
  canonicalClassifications.get(
    canonicalIdentity(pendingCanonicalTransactionHash, "3"),
  ),
  {
    kind: "recovery_required",
    reason: "owned_route_destination_correlation_pending",
  },
);

let persisted = 0;
const observer = new OwnedRouteDestinationObserver({
  loadTarget: async () => target,
  observe: async () => ({
    observedRaw: "1010102",
    revision: "destination-revision",
    observedAt: "2026-07-27T01:58:00.000Z",
  }),
  persist: async (_pool, input) => {
    assert.equal(
      input.target.providerSegments[0]?.segmentId,
      target.providerSegments[0]?.segmentId,
    );
    assert.equal(
      input.target.providerSegments[0]?.providerRawStatus,
      "pending",
    );
    assert.equal(
      input.target.providerSegments[0]?.providerDestinationReferenceCount,
      0,
    );
    assert.equal(input.observation.observedRaw, "1010102");
    persisted += 1;
    return true;
  },
});
assert.equal(observer.observerId, "relay_owned_destination_observation_v1");
assert.deepEqual(await observer.pollOperation({} as Pool, target.operationId), {
  destinationsPolled: 1,
  destinationSatisfied: true,
});
assert.equal(persisted, 1);

const waitingForObservation = new OwnedRouteDestinationObserver({
  loadTarget: async () => target,
  observe: async () => null,
  persist: async () => {
    throw new Error("an absent observation must not persist");
  },
});
assert.deepEqual(
  await waitingForObservation.pollOperation({} as Pool, target.operationId),
  { destinationsPolled: 1, destinationSatisfied: false },
);

const unrelated = new OwnedRouteDestinationObserver({
  loadTarget: async () => null,
});
assert.deepEqual(
  await unrelated.pollOperation({} as Pool, target.operationId),
  { destinationsPolled: 0, destinationSatisfied: false },
);

assert.deepEqual(
  destinationObservationEvidence({}, null, {
    locationId: target.destinationLocationId,
    asset: target.asset,
    baselineRaw: "500000",
    baselineRevision: "immutable-receive-baseline",
  }),
  {
    locationId: target.destinationLocationId,
    asset: target.asset,
    baselineRaw: "500000",
    baselineRevision: "immutable-receive-baseline",
  },
  "the immutable receive-session baseline remains a valid fallback",
);

console.log(
  "[funding-owned-route-destination-observer-tests] exact balance delta, canonical ownership, receive baseline, and scoped polling passed",
);
