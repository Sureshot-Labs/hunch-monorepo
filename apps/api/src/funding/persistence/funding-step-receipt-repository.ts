import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import { FundingPersistenceError } from "./funding-operation-repository.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type FundingStepReceiptStatus =
  | "pending"
  | "confirmed"
  | "finalized"
  | "failed"
  | "mismatch"
  | "reorged";

export type FundingStepReceiptTarget = Readonly<{
  operationId: string;
  stepId: string;
  segmentId: string | null;
  attemptId: string;
  stepKind: "transaction" | "venue_preparation";
  stepState:
    | "submitted"
    | "succeeded"
    | "reconcile_required"
    | "recovery_required";
  networkId: string;
  action: NormalizedAction;
  actionValidationResult: JsonRecord;
  receiptRefCiphertext: string;
  receiptRefLookupHmac: string;
  lookupKeyVersion: number;
  previousReceipt: FundingStepReceiptObservation | null;
}>;

type ReceiptManagedStepState =
  | FundingStepReceiptTarget["stepState"]
  | "action_required";

export type FundingStepReceiptObservation = Readonly<{
  operationId: string;
  stepId: string;
  attemptId: string;
  networkId: string;
  status: FundingStepReceiptStatus;
  actionMatch: boolean | null;
  ledgerHeight: string | null;
  blockHash: string | null;
  canonical: boolean;
  failureCode: string | null;
  evidence: JsonRecord;
  firstSeenAt: Date;
  observedAt: Date;
  finalizedAt: Date | null;
  reorgedAt: Date | null;
}>;

type ReceiptDbRow = {
  operation_id: string;
  step_id: string;
  attempt_id: string;
  network_id: string;
  status: FundingStepReceiptStatus;
  action_match: boolean | null;
  ledger_height: string | null;
  block_hash: string | null;
  canonical: boolean;
  failure_code: string | null;
  evidence: JsonRecord;
  first_seen_at: Date;
  observed_at: Date;
  finalized_at: Date | null;
  reorged_at: Date | null;
};

const receiptColumns = `
  operation_id,
  step_id,
  attempt_id,
  network_id,
  status,
  action_match,
  ledger_height,
  block_hash,
  canonical,
  failure_code,
  evidence,
  first_seen_at,
  observed_at,
  finalized_at,
  reorged_at
`;

function mapReceipt(row: ReceiptDbRow): FundingStepReceiptObservation {
  return {
    operationId: row.operation_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    networkId: row.network_id,
    status: row.status,
    actionMatch: row.action_match,
    ledgerHeight: row.ledger_height,
    blockHash: row.block_hash,
    canonical: row.canonical,
    failureCode: row.failure_code,
    evidence: row.evidence,
    firstSeenAt: row.first_seen_at,
    observedAt: row.observed_at,
    finalizedAt: row.finalized_at,
    reorgedAt: row.reorged_at,
  };
}

export async function listFundingStepReceiptTargets(
  db: Pick<Pool, "query">,
  operationId: string,
): Promise<readonly FundingStepReceiptTarget[]> {
  const { rows } = await db.query<{
    operation_id: string;
    step_id: string;
    segment_id: string | null;
    attempt_id: string;
    step_kind: FundingStepReceiptTarget["stepKind"];
    step_state: FundingStepReceiptTarget["stepState"];
    normalized_action: JsonRecord;
    action_validation_result: JsonRecord;
    receipt_ref_ciphertext: string;
    receipt_ref_lookup_hmac: string;
    lookup_key_version: number;
    receipt_operation_id: string | null;
    receipt_step_id: string | null;
    receipt_attempt_id: string | null;
    receipt_network_id: string | null;
    receipt_status: FundingStepReceiptStatus | null;
    receipt_action_match: boolean | null;
    receipt_ledger_height: string | null;
    receipt_block_hash: string | null;
    receipt_canonical: boolean | null;
    receipt_failure_code: string | null;
    receipt_evidence: JsonRecord | null;
    receipt_first_seen_at: Date | null;
    receipt_observed_at: Date | null;
    receipt_finalized_at: Date | null;
    receipt_reorged_at: Date | null;
  }>(
    `
      select
        step.operation_id,
        step.id as step_id,
        step.segment_id,
        attempt.id as attempt_id,
        step.step_kind,
        step.state as step_state,
        step.normalized_action,
        step.action_validation_result,
        attempt.receipt_ref_ciphertext,
        attempt.receipt_ref_lookup_hmac,
        attempt.lookup_key_version,
        receipt.operation_id as receipt_operation_id,
        receipt.step_id as receipt_step_id,
        receipt.attempt_id as receipt_attempt_id,
        receipt.network_id as receipt_network_id,
        receipt.status as receipt_status,
        receipt.action_match as receipt_action_match,
        receipt.ledger_height as receipt_ledger_height,
        receipt.block_hash as receipt_block_hash,
        receipt.canonical as receipt_canonical,
        receipt.failure_code as receipt_failure_code,
        receipt.evidence as receipt_evidence,
        receipt.first_seen_at as receipt_first_seen_at,
        receipt.observed_at as receipt_observed_at,
        receipt.finalized_at as receipt_finalized_at,
        receipt.reorged_at as receipt_reorged_at
      from funding_operation_steps step
      join funding_operation_step_attempts attempt
        on attempt.step_id = step.id
       and attempt.outcome in ('submitted', 'ambiguous')
       and attempt.broadcast_may_have_occurred
       and attempt.receipt_ref_ciphertext is not null
       and attempt.receipt_ref_lookup_hmac is not null
       and attempt.lookup_key_version is not null
      left join funding_step_receipt_observations receipt
        on receipt.attempt_id = attempt.id
      join funding_operations operation
        on operation.id = step.operation_id
      where step.operation_id = $1
        and operation.status not in ('completed', 'refunded', 'failed', 'cancelled')
        and (
          step.state in ('submitted', 'reconcile_required')
          or (
            step.state = 'succeeded'
            and receipt.status = 'finalized'
          )
        )
      order by step.ordinal, attempt.attempt_number
    `,
    [operationId],
  );
  return rows.map((row) => {
    const action = normalizedActionSchema.parse(
      row.normalized_action,
    ) as unknown as NormalizedAction;
    if (
      action.kind !== "evm_transaction" &&
      action.kind !== "svm_transaction"
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "broadcast receipt is linked to a non-transaction action",
      );
    }
    const previousReceipt =
      row.receipt_status &&
      row.receipt_operation_id &&
      row.receipt_step_id &&
      row.receipt_attempt_id &&
      row.receipt_network_id &&
      row.receipt_canonical !== null &&
      row.receipt_evidence &&
      row.receipt_first_seen_at &&
      row.receipt_observed_at
        ? mapReceipt({
            operation_id: row.receipt_operation_id,
            step_id: row.receipt_step_id,
            attempt_id: row.receipt_attempt_id,
            network_id: row.receipt_network_id,
            status: row.receipt_status,
            action_match: row.receipt_action_match,
            ledger_height: row.receipt_ledger_height,
            block_hash: row.receipt_block_hash,
            canonical: row.receipt_canonical,
            failure_code: row.receipt_failure_code,
            evidence: row.receipt_evidence,
            first_seen_at: row.receipt_first_seen_at,
            observed_at: row.receipt_observed_at,
            finalized_at: row.receipt_finalized_at,
            reorged_at: row.receipt_reorged_at,
          })
        : null;
    return {
      operationId: row.operation_id,
      stepId: row.step_id,
      segmentId: row.segment_id,
      attemptId: row.attempt_id,
      stepKind: row.step_kind,
      stepState: row.step_state,
      networkId: action.networkId,
      action,
      actionValidationResult: row.action_validation_result,
      receiptRefCiphertext: row.receipt_ref_ciphertext,
      receiptRefLookupHmac: row.receipt_ref_lookup_hmac,
      lookupKeyVersion: row.lookup_key_version,
      previousReceipt,
    };
  });
}

export type FundingStepReceiptEvidence = Readonly<{
  status: FundingStepReceiptStatus;
  actionMatch: boolean | null;
  ledgerHeight: string | null;
  blockHash: string | null;
  canonical: boolean;
  failureCode: string | null;
  evidence: JsonRecord;
}>;

const receiptRank: Readonly<Record<FundingStepReceiptStatus, number>> = {
  pending: 0,
  confirmed: 1,
  finalized: 2,
  failed: 3,
  mismatch: 3,
  reorged: 4,
};

function shouldIgnoreReceiptUpdate(
  previous: FundingStepReceiptStatus,
  incoming: FundingStepReceiptStatus,
): boolean {
  if (previous === incoming) return false;
  if (["failed", "mismatch", "reorged"].includes(previous)) return true;
  if (previous === "finalized") return incoming !== "reorged";
  return receiptRank[incoming] < receiptRank[previous];
}

function stepStateForReceipt(
  receipt: FundingStepReceiptStatus,
  current: FundingStepReceiptTarget["stepState"],
  stepKind: FundingStepReceiptTarget["stepKind"],
): ReceiptManagedStepState {
  if (receipt === "finalized") {
    return stepKind === "venue_preparation" ? "submitted" : "succeeded";
  }
  if (receipt === "failed") return "action_required";
  if (receipt === "mismatch") return "recovery_required";
  if (receipt === "reorged") return "recovery_required";
  if (receipt === "confirmed" && current === "reconcile_required") {
    return "submitted";
  }
  return current;
}

export async function applyFundingStepReceiptEvidenceInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    stepId: string;
    attemptId: string;
    networkId: string;
    receipt: FundingStepReceiptEvidence;
    now?: Date;
  }>,
): Promise<FundingStepReceiptObservation> {
  const now = input.now ?? new Date();
  const scope = await client.query<{
    step_state: FundingStepReceiptTarget["stepState"];
    step_kind: FundingStepReceiptTarget["stepKind"];
  }>(
    `
      select step.state as step_state,
             step.step_kind
      from funding_operation_steps step
      join funding_operation_step_attempts attempt
        on attempt.step_id = step.id
      where step.operation_id = $1
        and step.id = $2
        and attempt.id = $3
        and attempt.outcome in ('submitted', 'ambiguous')
        and attempt.broadcast_may_have_occurred
      for update of step, attempt
    `,
    [input.operationId, input.stepId, input.attemptId],
  );
  const scoped = scope.rows[0];
  if (!scoped) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding step receipt target no longer exists",
    );
  }

  const existing = await client.query<ReceiptDbRow>(
    `
      select ${receiptColumns}
      from funding_step_receipt_observations
      where attempt_id = $1
      for update
    `,
    [input.attemptId],
  );
  const previous = existing.rows[0];
  if (
    previous &&
    shouldIgnoreReceiptUpdate(previous.status, input.receipt.status)
  ) {
    return mapReceipt(previous);
  }

  const finalizedAt = input.receipt.status === "finalized" ? now : null;
  const reorgedAt = input.receipt.status === "reorged" ? now : null;
  const stored = await client.query<ReceiptDbRow>(
    `
      insert into funding_step_receipt_observations (
        operation_id,
        step_id,
        attempt_id,
        network_id,
        status,
        action_match,
        ledger_height,
        block_hash,
        canonical,
        failure_code,
        evidence,
        first_seen_at,
        observed_at,
        finalized_at,
        reorged_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
        $12, $12, $13, $14
      )
      on conflict (attempt_id) do update
      set status = excluded.status,
          action_match = excluded.action_match,
          ledger_height = excluded.ledger_height,
          block_hash = excluded.block_hash,
          canonical = excluded.canonical,
          failure_code = excluded.failure_code,
          evidence = excluded.evidence,
          observed_at = excluded.observed_at,
          finalized_at = excluded.finalized_at,
          reorged_at = excluded.reorged_at
      returning ${receiptColumns}
    `,
    [
      input.operationId,
      input.stepId,
      input.attemptId,
      input.networkId,
      input.receipt.status,
      input.receipt.actionMatch,
      input.receipt.ledgerHeight,
      input.receipt.blockHash,
      input.receipt.canonical,
      input.receipt.failureCode,
      input.receipt.evidence,
      now,
      finalizedAt,
      reorgedAt,
    ],
  );
  const row = stored.rows[0];
  if (!row) throw new Error("funding step receipt upsert returned no row");

  if (
    scoped.step_kind === "venue_preparation" &&
    input.receipt.status === "reorged"
  ) {
    await client.query(
      `
        update funding_observations
        set finality_status = 'reorged',
            canonical = false,
            reorged_at = $2,
            metadata = metadata || jsonb_build_object(
              'receiptReorged', true,
              'receiptReorgedAt', $2::timestamptz
            ),
            updated_at = $2
        where operation_id = $1
          and kind = 'venue_readiness'
          and metadata->>'receiptAttemptId' = $3
          and canonical
          and finality_status = 'finalized'
      `,
      [input.operationId, now, input.attemptId],
    );
  }

  const nextStepState = stepStateForReceipt(
    input.receipt.status,
    scoped.step_state,
    scoped.step_kind,
  );
  if (nextStepState !== scoped.step_state) {
    const updated = await client.query(
      `
        update funding_operation_steps
        set state = $4,
            updated_at = $5
        where operation_id = $1
          and id = $2
          and state = $3
      `,
      [input.operationId, input.stepId, scoped.step_state, nextStepState, now],
    );
    if (updated.rowCount !== 1) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding step state changed while applying receipt evidence",
      );
    }
  }
  return mapReceipt(row);
}

export async function applyFundingStepReceiptEvidence(
  pool: Pool,
  input: Parameters<typeof applyFundingStepReceiptEvidenceInTransaction>[1],
): Promise<FundingStepReceiptObservation> {
  return tx(pool, (client) =>
    applyFundingStepReceiptEvidenceInTransaction(client, input),
  );
}
