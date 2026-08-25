#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  deriveSegmentTargetStatus,
  deriveTargetState,
} from "../../reconciliation/funding-reducer.js";
import type {
  FundingObservationRow,
  FundingOperationRow,
} from "../../persistence/funding-operation-repository.js";

const destinationAsset = {
  networkId: "evm:137",
  assetId: "0x3333333333333333333333333333333333333333",
  decimals: 6,
};
const money = (raw: string) => ({ asset: destinationAsset, raw });
const operation = {
  id: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  quoteId: "00000000-0000-4000-8000-000000000003",
  purpose: "trade_shortfall",
  status: "in_progress",
  progressStage: "committed",
  experienceMode: "prepare_first",
  planKind: "composite_route",
  idempotencyKey: "idempotency_multi_leg_12345678",
  commitRequestHash: "a".repeat(64),
  planHash: "b".repeat(64),
  policyVersion: 1,
  policyRevision: "policy_multi_leg_12345678",
  sourceSnapshot: { kind: "composite" },
  destinationTargetSnapshot: {
    componentId: "destination_component_12345678",
    locationId: "destination_location_12345678",
  },
  externalRecipientId: null,
  venueId: "polymarket",
  marketId: null,
  requestedSourceAmount: null,
  requestedDestinationAmount: money("10000000"),
  actualSourceAmount: null,
  actualDestinationAmount: null,
  errorCode: null,
  recoveryMode: null,
  supportMetadata: {},
  version: 1,
  createdAt: new Date("2026-07-24T10:00:00.000Z"),
  updatedAt: new Date("2026-07-24T10:00:00.000Z"),
  expiresAt: new Date("2026-07-24T10:15:00.000Z"),
  completedAt: null,
} satisfies FundingOperationRow;
const segments = [
  {
    id: "00000000-0000-4000-8000-000000000011",
    ordinal: 0,
    status: "planned" as const,
    quoted_input: {
      asset: {
        networkId: "evm:8453",
        assetId: "0x4444444444444444444444444444444444444444",
        decimals: 6,
      },
      raw: "6100000",
    },
    quoted_min_output: money("6000000"),
  },
  {
    id: "00000000-0000-4000-8000-000000000012",
    ordinal: 1,
    status: "planned" as const,
    quoted_input: {
      asset: {
        networkId: "solana:mainnet",
        assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
      },
      raw: "4100000",
    },
    quoted_min_output: money("4000000"),
  },
];
const step = (
  id: string,
  segmentId: string | null,
  state:
    | "planned"
    | "action_required"
    | "submitted"
    | "succeeded"
    | "reconcile_required"
    | "recovery_required"
    | "failed"
    | "cancelled",
) => ({
  id,
  segment_id: segmentId,
  state,
  executor_id: "wallet_profile_evm_v1",
  action_validation_result: {},
});
const destinationObservation = (
  segmentId: string | null,
  rawAmount: string,
  eventIndex: string,
  kind: FundingObservationRow["kind"] = "destination_credit",
): FundingObservationRow => ({
  id: `00000000-0000-4000-8000-${eventIndex.padStart(12, "0")}`,
  operationId: operation.id,
  segmentId,
  kind,
  networkId: destinationAsset.networkId,
  assetId: destinationAsset.assetId,
  assetDecimals: destinationAsset.decimals,
  txHash: `0x${eventIndex.padStart(64, "0")}`,
  eventIndex,
  fromAddress: null,
  toAddress: "0x5555555555555555555555555555555555555555",
  rawAmount,
  observedAt: new Date("2026-07-24T10:01:00.000Z"),
  ledgerHeight: "100",
  blockHash: `0x${"66".repeat(32)}`,
  finalityStatus: "finalized",
  canonical: true,
  reorgedAt: null,
  finalizedAt: new Date("2026-07-24T10:01:00.000Z"),
  metadata: {},
});

const legOne = destinationObservation(segments[0].id, "6000000", "1");
const legTwo = destinationObservation(segments[1].id, "4000000", "2");
assert.equal(
  deriveSegmentTargetStatus(
    "planned",
    [destinationObservation(segments[0].id, "5999999", "3")],
    segments[0].quoted_min_output,
  ),
  "settling",
);
assert.deepEqual(
  deriveTargetState(operation, [legOne], segments, [
    step("00000000-0000-4000-8000-000000000021", segments[0].id, "succeeded"),
    step(
      "00000000-0000-4000-8000-000000000022",
      segments[1].id,
      "action_required",
    ),
  ]).target,
  { status: "in_progress", stage: "routing" },
);
assert.deepEqual(
  deriveTargetState(operation, [legOne, legTwo], segments, [
    step("00000000-0000-4000-8000-000000000021", segments[0].id, "succeeded"),
    step("00000000-0000-4000-8000-000000000022", segments[1].id, "succeeded"),
  ]).target,
  { status: "ready", stage: "ready_for_consumer" },
);

const exactPreparedOperation = {
  ...operation,
  id: "00000000-0000-4000-8000-000000000031",
  requestedDestinationAmount: money("4227649"),
  supportMetadata: {
    containsVenuePreparation: true,
  },
} satisfies FundingOperationRow;
const exactRelaySegment = {
  ...segments[0],
  id: "00000000-0000-4000-8000-000000000032",
  quoted_min_output: money("658574"),
};
const exactRelayCredit = {
  ...destinationObservation(exactRelaySegment.id, "658574", "31"),
  operationId: exactPreparedOperation.id,
};
const exactPreparationReadiness = {
  ...destinationObservation(null, "3569075", "32", "venue_readiness"),
  operationId: exactPreparedOperation.id,
};
assert.deepEqual(
  deriveTargetState(
    exactPreparedOperation,
    [exactRelayCredit, exactPreparationReadiness],
    [exactRelaySegment],
    [
      step(
        "00000000-0000-4000-8000-000000000033",
        exactRelaySegment.id,
        "succeeded",
      ),
      step("00000000-0000-4000-8000-000000000034", null, "succeeded"),
    ],
  ).target,
  { status: "ready", stage: "ready_for_consumer" },
);
const mixedCaseAssetId = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const mixedCasePreparedOperation = {
  ...exactPreparedOperation,
  id: "00000000-0000-4000-8000-000000000041",
  requestedDestinationAmount: {
    asset: { ...destinationAsset, assetId: mixedCaseAssetId },
    raw: "4723189",
  },
} satisfies FundingOperationRow;
const mixedCaseRelaySegment = {
  ...exactRelaySegment,
  id: "00000000-0000-4000-8000-000000000042",
  quoted_min_output: {
    asset: { ...destinationAsset, assetId: mixedCaseAssetId.toLowerCase() },
    raw: "3749387",
  },
};
const mixedCaseRelayCredit = {
  ...destinationObservation(mixedCaseRelaySegment.id, "3749387", "41"),
  operationId: mixedCasePreparedOperation.id,
  assetId: mixedCaseAssetId.toLowerCase(),
};
const mixedCasePreparationReadiness = {
  ...destinationObservation(null, "973802", "42", "venue_readiness"),
  operationId: mixedCasePreparedOperation.id,
  assetId: mixedCaseAssetId,
};
assert.notEqual(
  mixedCaseRelayCredit.assetId,
  mixedCasePreparationReadiness.assetId,
);
assert.deepEqual(
  deriveTargetState(
    mixedCasePreparedOperation,
    [mixedCaseRelayCredit, mixedCasePreparationReadiness],
    [mixedCaseRelaySegment],
    [
      step(
        "00000000-0000-4000-8000-000000000043",
        mixedCaseRelaySegment.id,
        "succeeded",
      ),
      step("00000000-0000-4000-8000-000000000044", null, "succeeded"),
    ],
  ).target,
  { status: "ready", stage: "ready_for_consumer" },
);
assert.deepEqual(
  deriveTargetState(
    exactPreparedOperation,
    [exactRelayCredit],
    [exactRelaySegment],
    [
      step(
        "00000000-0000-4000-8000-000000000033",
        exactRelaySegment.id,
        "succeeded",
      ),
      step("00000000-0000-4000-8000-000000000034", null, "submitted"),
    ],
  ).target,
  { status: "in_progress", stage: "routing" },
);
assert.deepEqual(
  deriveTargetState(
    { ...operation, progressStage: "routing" },
    [legOne],
    segments,
    [
      step("00000000-0000-4000-8000-000000000021", segments[0].id, "succeeded"),
      step("00000000-0000-4000-8000-000000000022", segments[1].id, "failed"),
    ],
  ).target,
  { status: "recovery_required", stage: "routing" },
);
assert.deepEqual(
  deriveTargetState(
    {
      ...operation,
      status: "completed",
      progressStage: "terminal",
      completedAt: new Date("2026-07-24T10:02:00.000Z"),
    },
    [legOne, legTwo],
    segments.map((segment) => ({ ...segment, status: "succeeded" as const })),
    [
      step("00000000-0000-4000-8000-000000000021", segments[0].id, "succeeded"),
      step("00000000-0000-4000-8000-000000000022", segments[1].id, "succeeded"),
    ],
  ).target,
  { status: "completed", stage: "terminal" },
);

const delegatedDepositOnlyOperation = {
  ...operation,
  supportMetadata: { routeId: "base-usdc-to-polygon-pusd" },
};
const delegatedDepositOnlySourceDebit = {
  ...destinationObservation(null, "10000000", "51", "source_debit"),
  operationId: delegatedDepositOnlyOperation.id,
  networkId: "evm:8453",
};
assert.deepEqual(
  deriveTargetState(
    delegatedDepositOnlyOperation,
    [legOne, legTwo, delegatedDepositOnlySourceDebit],
    segments.map((segment) => ({ ...segment, status: "succeeded" as const })),
    [
      {
        ...step("00000000-0000-4000-8000-000000000051", null, "succeeded"),
        executor_id: "telegram_relay_evm_funding_v1",
        action_validation_result: {
          relayStepKind: "deposit",
          relayAllowanceMode: "preexisting",
        },
      },
    ],
  ).target,
  { status: "ready", stage: "ready_for_consumer" },
  "a canonical deposit-only Relay source debit is sufficient for a preexisting allowance route",
);

const clientAtomicRelayOperation = {
  ...operation,
  planKind: "wallet_route" as const,
  supportMetadata: { routeId: "polygon-pusd-to-base-usdc" },
};
const clientAtomicRelayDestination = {
  ...destinationObservation(segments[0].id, "10000000", "52"),
  operationId: clientAtomicRelayOperation.id,
};
assert.deepEqual(
  deriveTargetState(
    clientAtomicRelayOperation,
    [clientAtomicRelayDestination],
    [{ ...segments[0], status: "succeeded" as const }],
    [
      {
        ...step(
          "00000000-0000-4000-8000-000000000052",
          segments[0].id,
          "succeeded",
        ),
        action_validation_result: {
          relayStepKind: "deposit",
          sourceActionValidations: [
            { actionId: "relay:quote:approve" },
            { actionId: "relay:quote:deposit" },
          ],
        },
      },
    ],
  ).target,
  { status: "ready", stage: "ready_for_consumer" },
  "a client-signed atomic approve/deposit Relay step is not gated by delegated allowance shape",
);

console.log(
  "[funding-multi-leg-reducer-tests] partial coverage, per-leg minimum, aggregate readiness, partial failure recovery, and terminal idempotency passed",
);
