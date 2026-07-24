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
  supportMetadata: {},
  version: 1,
  createdAt: new Date("2026-07-24T10:00:00.000Z"),
  updatedAt: new Date("2026-07-24T10:00:00.000Z"),
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
  segmentId: string,
  state:
    | "planned"
    | "action_required"
    | "submitted"
    | "succeeded"
    | "reconcile_required"
    | "recovery_required"
    | "failed"
    | "cancelled",
) => ({ id, segment_id: segmentId, state });
const destinationObservation = (
  segmentId: string,
  rawAmount: string,
  eventIndex: string,
): FundingObservationRow => ({
  id: `00000000-0000-4000-8000-${eventIndex.padStart(12, "0")}`,
  operationId: operation.id,
  segmentId,
  kind: "destination_credit",
  networkId: destinationAsset.networkId,
  assetId: destinationAsset.assetId,
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

console.log(
  "[funding-multi-leg-reducer-tests] partial coverage, per-leg minimum, aggregate readiness, and partial failure recovery passed",
);
