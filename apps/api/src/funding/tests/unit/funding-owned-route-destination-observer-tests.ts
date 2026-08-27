import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
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

let inspectedCompetitionQuery = false;
const baselineAwareObserver = new OwnedRouteDestinationObserver();
assert.deepEqual(
  await baselineAwareObserver.pollOperation(
    {
      query: async (sql: string) => {
        inspectedCompetitionQuery = true;
        assert.match(sql, /providerUpdatedAt/);
        assert.match(sql, /destinationObservation,baselineAsOf/);
        assert.match(sql, /destination,spendability,asOf/);
        assert.match(sql, /observation_start_variants/);
        assert.match(sql, /receive_session\.opened_at/);
        assert.match(sql, /direct_destination_credit/);
        assert.match(
          sql,
          /receive_receipt\.child_funding_operation_id = operation\.id/,
        );
        assert.match(sql, /receive_destination_baseline\.baseline_as_of/);
        assert.match(sql, /coalesce\(/);
        assert.match(sql, /destination_baseline\.baseline_as_of/);
        assert.match(sql, /destinationTransactionReferenceCount/);
        assert.match(sql, /competing_attempt\.broadcast_may_have_occurred/);
        assert.match(sql, /originTransactionReferenceCount/);
        assert.doesNotMatch(sql, /competing\.updated_at >=/);
        assert.match(sql, /to_timestamp/);
        assert.match(sql, /competing_preparation\.kind = 'venue_readiness'/);
        assert.match(sql, /competing_credit\.kind = 'destination_credit'/);
        assert.match(
          sql,
          /competing\.status = 'ready'[\s\S]+settled_competing_credit\.observed_at <=[\s\S]+destination_baseline\.baseline_as_of/,
        );
        assert.match(
          sql,
          /not exists \([\s\S]+unsettled_competing_credit\.observed_at >[\s\S]+destination_baseline\.baseline_as_of/,
        );
        assert.match(sql, /'reconcile_required'/);
        assert.match(sql, /'recovery_required'/);
        assert.match(
          sql,
          /competing\.status = 'recovery_required'[\s\S]+segment\.raw_status = 'success'[\s\S]+relayStatusCategory[\s\S]+provider_success/,
        );
        assert.match(
          sql,
          /competing_segment\.support_metadata[\s\S]+destinationTransactionReferenceCount[\s\S]+::integer = 0/,
        );
        assert.match(sql, /exists \(\s+select 1[\s\S]+competing_segment/);
        assert.match(
          sql,
          /then to_timestamp\([\s\S]+providerUpdatedAt[\s\S]+>\s+destination_baseline\.baseline_as_of/,
        );
        assert.doesNotMatch(sql, /and not \(\s+case/);
        const preparationAfterBaseline = sql.indexOf(
          "competing_preparation.observed_at >",
        );
        const preparationAtOrBeforeBaseline = sql.indexOf(
          "competing_preparation.observed_at <=",
        );
        assert.ok(preparationAfterBaseline >= 0);
        assert.ok(
          preparationAtOrBeforeBaseline > preparationAfterBaseline,
          "a post-baseline preparation observation must take precedence over historical readiness",
        );
        assert.doesNotMatch(sql, /competing_segment\.ordinal = 0/);
        assert.doesNotMatch(sql, /\n\s+and segment\.raw_status = 'success'/);
        assert.match(
          sql,
          /operation\.status not in \([^)]*'completed'[^)]*'cancelled'[^)]*\)/,
        );
        assert.doesNotMatch(
          sql,
          /operation\.status not in \([^)]*'reconcile_required'/,
        );
        assert.match(
          sql,
          /operation\.status <> 'recovery_required'[\s\S]*operation\.recovery_mode = 'automatic_evidence'/,
        );
        return { rows: [] };
      },
    } as unknown as Pool,
    target.operationId,
  ),
  { destinationsPolled: 0, destinationSatisfied: false },
);
assert.equal(inspectedCompetitionQuery, true);

const receiveBaselineObserver = new OwnedRouteDestinationObserver({
  observe: async (_pool, loaded) => {
    assert.equal(loaded.baselineRaw, "500000");
    assert.equal(loaded.baselineRevision, "immutable-receive-baseline");
    assert.equal(loaded.destinationLocationId, "limitless-usdc-location");
    return {
      observedRaw: "1500000",
      revision: "destination-after-relay",
      observedAt: "2026-08-14T17:20:15.873Z",
    };
  },
  persist: async (_pool, input) => {
    assert.equal(input.target.baselineRaw, "500000");
    assert.equal(input.target.baselineRevision, "immutable-receive-baseline");
    return true;
  },
});
assert.deepEqual(
  await receiveBaselineObserver.pollOperation(
    {
      query: async (sql: string) => {
        if (sql.includes("from funding_receive_receipts source_receipt")) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              operation_id: target.operationId,
              user_id: target.userId,
              purpose: target.purpose,
              market_id: target.marketId,
              status: "recovery_required",
              progress_stage: "source_observed",
              version: 10,
              venue_binding_snapshot: {
                venueBindingOptionId: target.venueBindingOptionId,
              },
              destination_target_snapshot: {
                kind: "owned_location",
                location: {
                  kind: "venue_account",
                  locationId: target.destinationLocationId,
                  accountId: target.userId,
                  asset: target.asset,
                  details: { address: target.destinationAddress },
                },
              },
              operation_support_metadata: {
                fundingReceiveReceiptId: "00000000-0000-4000-8000-000000000012",
              },
              planner_snapshot: null,
              receive_destination_observation: {
                locationId: target.destinationLocationId,
                asset: target.asset,
                baselineRaw: "500000",
                baselineRevision: "immutable-receive-baseline",
                baselineAsOf: "2026-08-14T17:19:15.000Z",
              },
              quoted_min_output: {
                asset: target.asset,
                raw: "1000000",
              },
              requested_destination_amount: {
                asset: target.asset,
                raw: "1000000",
              },
              provider_segments: [
                {
                  segmentId: target.providerSegments[0]?.segmentId,
                  ordinal: 0,
                  expectedOutput: {
                    asset: target.asset,
                    raw: "1000000",
                  },
                  minimumOutput: {
                    asset: target.asset,
                    raw: "1000000",
                  },
                  rawStatus: "success",
                  destinationTransactionReferenceCount: 0,
                },
              ],
              competing_count: "0",
            },
          ],
        };
      },
    } as unknown as Pool,
    target.operationId,
  ),
  { destinationsPolled: 1, destinationSatisfied: true },
);

console.log(
  "[funding-owned-route-destination-observer-tests] exact balance delta, baseline-aware competition, and scoped polling passed",
);
