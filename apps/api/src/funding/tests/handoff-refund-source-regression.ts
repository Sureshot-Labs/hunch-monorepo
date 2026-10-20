import assert from "node:assert/strict";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import { FUNDING_CURRENT_REFUND_FIRST_PAGE_SQL } from "../persistence/funding-operation-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { readFrozenPolymarketHandoffBinding } from "../domain/polymarket-handoff-binding.js";
import { FUNDING_CLASSIFICATION_REVISION_SQL } from "../persistence/funding-classification-revisions.js";
import {
  matchRefundSourceEnvelope,
  REFUND_SOURCE_EXACT_SQL,
  type RefundSourceCandidateRow,
} from "../reconciliation/relay-refund-source-candidates.js";
import { readRefundSourceActionPage } from "../reconciliation/relay-refund-source-action-scan.js";
import {
  REFUND_SOURCE_ACTION_FACTS_SQL,
  type RefundSourceActionRow,
} from "../reconciliation/relay-refund-source-actions.js";
import { REFUND_OBSERVATION_FIRST_PAGE_SQL } from "../reconciliation/relay-refund-observation-scan.js";
import { REFUND_DESTINATION_REFERENCES_SQL } from "../reconciliation/relay-refund-destination-settlement.js";
import { arbitrateReceiveRoleCandidates } from "../receive/receive-role-arbitration.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import { receiveHandoffReferenceContext } from "../receive/receive-handoff-action-scan.js";
import { RELAY_DEPOSITORY_V2 } from "../../funding-providers/relay/rehearsal.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const operationId = id(2),
  segmentId = id(3),
  reservationId = id(4);
const transactionHash = `0x${"a1".repeat(32)}`;
const blockHash = `0x${"b1".repeat(32)}`;

/** Called with the ACTUAL production planner's selected quote, rather than a
 * hand-assembled happy-path topology. All database and transport facts here
 * are in-memory; nothing can submit an action or reconcile an operation. */
export async function verifyPlannerHandoffRefundSourceRegression(
  plan: FundingCommitPlan,
  userId: string,
) {
  const binding = readFrozenPolymarketHandoffBinding({
    currentUserId: userId,
    plan,
    segmentOrdinal: 0,
  });
  assert.ok(binding);
  const segment = plan.segments[0];
  const actualReservation = (
    reservation: FundingCommitPlan["reservations"][number],
    n: number,
  ) => ({
    id: id(n),
    user_id: userId,
    operation_id: operationId,
    segment_id: reservation.segmentOrdinal === null ? null : segmentId,
    component_id: reservation.componentId,
    location_id: reservation.locationId,
    network_id: reservation.networkId,
    asset_id: reservation.assetId,
    asset_decimals: reservation.assetDecimals,
    raw_amount: reservation.rawAmount,
    mode: reservation.mode,
    economic_role: reservation.economicRole ?? "source_input",
    state: "released",
  });
  const row: RefundSourceCandidateRow = {
    reservation_id: reservationId,
    reservation_created_at: "2026-10-20T00:00:00.000000Z",
    operation_id: operationId,
    segment_id: segmentId,
    user_id: userId,
    operation_user_id: userId,
    operation_plan_kind: "wallet_route",
    operation_source_snapshot: plan.operation.sourceSnapshot,
    operation_destination_target_snapshot:
      plan.operation.destinationTargetSnapshot,
    location_id: binding.economicSource.locationId,
    network_id: binding.economicSource.asset.networkId,
    asset_id: binding.economicSource.asset.assetId,
    asset_decimals: binding.economicSource.asset.decimals,
    raw_amount: binding.rawAmount,
    mode: "subtract_available",
    provider_id: "relay",
    source_snapshot: segment.sourceSnapshot,
    quoted_input: segment.quotedInput,
    destination_target_snapshot: segment.destinationTargetSnapshot,
    quoted_min_output: segment.quotedMinOutput,
    refund_location_snapshot: segment.refundLocationSnapshot,
    provider_quote_ref_lookup_hmac: segment.providerQuoteRefLookupHmac,
    lookup_key_version: segment.lookupKeyVersion,
    polymarket_handoff_binding: {
      source_snapshot: plan.operation.sourceSnapshot,
      wallet_execution_snapshot: plan.operation.walletExecutionSnapshot,
      plan_hash: canonicalJsonHash(plan),
      plan_snapshot: plan,
      segment_ordinal: 0,
      segment_source: segment.sourceSnapshot,
      quoted_input: segment.quotedInput,
      source_reservation: actualReservation(binding.sourceReservation, 4),
      controller_fences: [actualReservation(binding.controllerFence, 5)],
    },
  };
  const event = {
    networkId: binding.executionSource.asset.networkId,
    asset: binding.executionSource.asset,
    destinationAddress: String(binding.executionSource.details.address),
    sourceAddress: `0x${"ef".repeat(20)}`,
    rawAmount: "1000000",
    transactionHash: `0x${"a2".repeat(32)}`,
    eventIndex: "7",
    ledgerHeight: "200",
    blockHash,
    observedAt: new Date("2026-10-20T01:00:00Z"),
  };
  assert.equal(matchRefundSourceEnvelope(userId, event, row).kind, "candidate");
  assert.notEqual(row.location_id, binding.executionSource.locationId);
  const mutate = (edit: (candidate: RefundSourceCandidateRow) => void) => {
    const candidate = structuredClone(row);
    edit(candidate);
    return candidate;
  };
  const frozenBinding = (candidate: RefundSourceCandidateRow) => {
    assert.ok(candidate.polymarket_handoff_binding);
    return candidate.polymarket_handoff_binding;
  };
  for (const invalid of [
    { ...row, polymarket_handoff_binding: null },
    { ...row, operation_user_id: id(90) },
    { ...row, location_id: "unrelated-location" },
    { ...row, raw_amount: "1" },
    { ...row, asset_id: `0x${"ff".repeat(20)}` },
    mutate((candidate) => {
      frozenBinding(candidate).controller_fences = [];
    }),
    mutate((candidate) => {
      (
        frozenBinding(candidate).controller_fences as Record<string, unknown>[]
      )[0].user_id = id(90);
    }),
    mutate((candidate) => {
      (
        frozenBinding(candidate).controller_fences as Record<string, unknown>[]
      )[0].raw_amount = "1";
    }),
    mutate((candidate) => {
      (
        frozenBinding(candidate).controller_fences as Record<string, unknown>[]
      )[0].location_id = "other-controller";
    }),
    mutate((candidate) => {
      (
        frozenBinding(candidate).source_reservation as Record<string, unknown>
      ).location_id = "other-economic-source";
    }),
    mutate((candidate) => {
      const frozen = frozenBinding(candidate);
      const changedPlan = frozen.plan_snapshot as FundingCommitPlan;
      Object.assign(changedPlan.steps[0], {
        actionFingerprint: "wrong-action",
      });
      frozen.plan_hash = canonicalJsonHash(changedPlan);
    }),
  ])
    assert.equal(
      matchRefundSourceEnvelope(userId, event, invalid).kind,
      "invalid",
    );
  // Recovering the exact immutable binding needs no housekeeping delay.
  assert.equal(matchRefundSourceEnvelope(userId, event, row).kind, "candidate");

  const rows: RefundSourceActionRow[] = plan.steps
    .filter((step) => step.segmentOrdinal === 0)
    .map((step) => ({
      operation_id: operationId,
      segment_id: segmentId,
      step_id: id(20 + step.ordinal),
      step_ordinal: step.ordinal,
      step_kind: step.stepKind,
      executor_id: step.executorId,
      action_fingerprint: step.actionFingerprint,
      normalized_action: step.normalizedAction,
      action_validation_result: step.actionValidationResult,
      attempt_id: null,
      attempt_number: 0,
      attempt_fingerprint: null,
      attempt_executor_id: null,
      attempt_outcome: null,
      broadcast_may_have_occurred: null,
      synthetic_cancellation: false,
      unreferenced_attempt: true,
      attempt_costs: {},
      receipt_status: null,
      receipt_canonical: null,
      receipt_action_match: null,
      receipt_evidence: null,
      receipt_network_id: null,
      receipt_ledger_height: null,
      receipt_block_hash: null,
      source_debit: null,
    }));
  const deposit = rows.find(
    (action) =>
      (action.action_validation_result as Record<string, unknown>)
        .relayStepKind === "deposit",
  );
  assert.ok(deposit);
  const debit = {
    id: id(8),
    operationId,
    segmentId,
    kind: "source_debit",
    networkId: event.networkId,
    assetId: event.asset.assetId,
    decimals: 6,
    raw: binding.rawAmount,
    txHash: transactionHash,
    eventIndex: "4",
    fromAddress: event.destinationAddress,
    toAddress: RELAY_DEPOSITORY_V2,
    ledgerHeight: "123",
    blockHash,
    canonical: true,
    finality: "finalized",
    observerId: "relay_client_receipt_source_debit_v1",
    originStepId: deposit.step_id,
    originFingerprint: deposit.action_fingerprint,
    originExecutor: deposit.executor_id,
  };
  Object.assign(deposit, {
    attempt_id: id(9),
    attempt_number: 1,
    attempt_fingerprint: deposit.action_fingerprint,
    attempt_executor_id: deposit.executor_id,
    attempt_outcome: "submitted",
    broadcast_may_have_occurred: true,
    unreferenced_attempt: false,
    receipt_status: "finalized",
    receipt_canonical: true,
    receipt_action_match: true,
    receipt_evidence: {
      transactionHash,
      sourceDebitEventIndex: "4",
      attributedSourceRaw: binding.rawAmount,
    },
    receipt_network_id: event.networkId,
    receipt_ledger_height: "123",
    receipt_block_hash: blockHash,
    source_debit: debit,
  });
  const target = segment.destinationTargetSnapshot.location as Record<
    string,
    unknown
  >;
  const targetAsset = target.asset as {
    networkId: string;
    assetId: string;
    decimals: number;
  };
  const observations = [
    {
      id: id(8),
      operation_id: operationId,
      segment_id: segmentId,
      kind: "source_debit",
      network_id: event.networkId,
      tx_hash: transactionHash,
      event_index: "4",
      canonical: true,
      finality_status: "finalized",
    },
    {
      id: id(10),
      operation_id: operationId,
      segment_id: segmentId,
      kind: "destination_credit",
      network_id: targetAsset.networkId,
      asset_id: targetAsset.assetId,
      asset_decimals: targetAsset.decimals,
      tx_hash: `0x${"aa".repeat(32)}`,
      event_index: "hypercore:send:destination_credit",
      canonical: true,
      finality_status: "finalized",
      from_address: `0x${"12".repeat(20)}`,
      to_address: (target.details as Record<string, unknown>).address,
      raw_amount: String(segment.quotedMinOutput.raw),
      ledger_height: null,
      block_hash: null,
      observer_id: "relay_owned_destination_observation_v1",
      native_destination_dex: "spot",
    },
  ];
  let revision = "99",
    changeDuringPage = false;
  const queried: string[] = [];
  const db = {
    query: async (sql: string) => {
      queried.push(sql);
      if (sql === FUNDING_CLASSIFICATION_REVISION_SQL)
        return { rows: [{ revision }] };
      if (sql === REFUND_SOURCE_EXACT_SQL) return { rows: [row] };
      if (sql === REFUND_SOURCE_ACTION_FACTS_SQL) {
        if (changeDuringPage) {
          revision = "100";
          changeDuringPage = false;
        }
        return { rows };
      }
      if (sql === FUNDING_CURRENT_REFUND_FIRST_PAGE_SQL) return { rows: [] };
      if (sql === REFUND_OBSERVATION_FIRST_PAGE_SQL)
        return { rows: observations };
      if (sql === REFUND_DESTINATION_REFERENCES_SQL)
        return { rows: [{ id: id(10) }] };
      assert.fail(`Unexpected offline query: ${sql}`);
    },
  };
  const identity = { userId, operationId, segmentId, reservationId };
  const read = (completed?: unknown) =>
    readRefundSourceActionPage(db as never, {
      identity,
      event,
      continuation: null,
      completed,
      limit: 25,
    });
  changeDuringPage = true;
  assert.deepEqual(await read(), { kind: "restart" });
  const initial = await read();
  assert.equal(initial.kind, "complete");
  if (initial.kind !== "complete") assert.fail("expected action completion");
  assert.equal(initial.accounting.kind, "single_debit");
  const refundChecked = await read(initial);
  assert.equal(refundChecked.kind, "complete");
  const complete = await read(refundChecked);
  assert.equal(complete.kind, "complete");
  if (complete.kind !== "complete")
    assert.fail("expected delivered completion");
  assert.deepEqual(complete.observations, { kind: "delivered" });
  assert.ok(queried.includes(REFUND_SOURCE_ACTION_FACTS_SQL));
  assert.ok(queried.includes(REFUND_OBSERVATION_FIRST_PAGE_SQL));

  const transactionReferenceCodec = {
    keyVersion: 1,
    fingerprint: () => "c".repeat(64),
  };
  const candidate = {
    reservation_id: reservationId,
    operation_id: operationId,
    segment_id: segmentId,
    envelope_kind: "candidate" as const,
    handoff_possible: true,
    destination_possible: false,
    action_result: complete,
    destination_progress: null,
    handoff_progress: {
      version: 1,
      kind: "complete",
      role: "handoff",
      facts: complete.facts,
      eventFingerprint: receiveRoleEventFingerprint(event),
      cursor: null,
      codecContext: receiveHandoffReferenceContext(
        event,
        transactionReferenceCodec,
      ).codecContext,
      referenceRetryRequired: false,
      classification: { kind: "external", reason: null },
    },
  };
  const evaluate = (refundInternal = false, handoffInternal = false) =>
    arbitrateReceiveRoleCandidates({
      userId,
      event,
      enumerationComplete: true,
      candidates: [
        {
          ...candidate,
          handoff_progress: {
            ...candidate.handoff_progress,
            classification: handoffInternal
              ? {
                  kind: "internal",
                  operationId,
                  attemptId: id(30),
                  reason: null,
                  reference: "exact",
                }
              : candidate.handoff_progress.classification,
          },
        },
      ],
      transactionReferenceCodec,
      refundEvidence: {
        kind: "recorded",
        eventFingerprint: receiveRoleEventFingerprint(event),
        classification: refundInternal
          ? { kind: "internal", operationId, segmentId }
          : { kind: "unmatched" },
        dependencies: refundInternal ? [complete.facts] : [],
      },
    });
  assert.deepEqual(await evaluate(), {
    kind: "ready_for_fence",
    classification: { kind: "external" },
    dependencies: [complete.facts],
  });
  const internalRefund = await evaluate(true);
  assert.equal(
    internalRefund.kind === "ready_for_fence" &&
      internalRefund.classification.kind,
    "internal_refund",
  );
  const internalHandoff = await evaluate(false, true);
  assert.equal(
    internalHandoff.kind === "ready_for_fence" &&
      internalHandoff.classification.kind,
    "internal_handoff",
  );
  const conflict = await evaluate(true, true);
  assert.deepEqual(
    conflict.kind === "ready_for_fence" && conflict.classification,
    {
      kind: "recovery_required",
      reason: "internal_event_classification_conflict",
    },
  );
  // An earlier derived positive cannot survive a current receipt reorg.
  Object.assign(deposit, {
    receipt_status: "reorged",
    receipt_canonical: false,
  });
  revision = "101";
  assert.deepEqual(await read(complete), { kind: "restart" });
  const reorged = await read();
  assert.equal(
    reorged.kind === "complete" && reorged.accounting.kind,
    "unaccounted",
  );
}
