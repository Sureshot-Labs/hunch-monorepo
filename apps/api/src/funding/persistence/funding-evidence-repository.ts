import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type { JsonValue } from "../domain/types.js";
import {
  consumeFundingReservationInTransaction,
  fetchFundingOperationForUser,
  FundingPersistenceError,
  releaseFundingReservationInTransaction,
  transitionFundingOperationInTransaction,
  wakeFundingReconciliationInTransaction,
} from "./funding-operation-repository.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type FundingOperationStepState =
  | "planned"
  | "action_required"
  | "submitted"
  | "succeeded"
  | "reconcile_required"
  | "recovery_required"
  | "failed"
  | "cancelled";

export type FundingOperationStep = Readonly<{
  id: string;
  operationId: string;
  segmentId: string | null;
  ordinal: number;
  stepKind:
    | "approval"
    | "transaction"
    | "signature"
    | "external_handoff"
    | "server_action"
    | "venue_preparation";
  state: FundingOperationStepState;
  actionFingerprint: string;
  executorId: string;
  payerRequirement:
    | "none"
    | "user"
    | "provider"
    | "privy_sponsor"
    | "hunch_sponsor";
  dependsOnStepId: string | null;
  dependencyState: FundingOperationStepState | null;
  normalizedAction: JsonRecord;
  actionValidationResult: JsonRecord;
}>;

type FundingOperationStepDbRow = {
  id: string;
  operation_id: string;
  segment_id: string | null;
  ordinal: number;
  step_kind: FundingOperationStep["stepKind"];
  state: FundingOperationStepState;
  action_fingerprint: string;
  executor_id: string;
  payer_requirement: FundingOperationStep["payerRequirement"];
  depends_on_step_id: string | null;
  dependency_state: FundingOperationStepState | null;
  normalized_action: JsonRecord;
  action_validation_result: JsonRecord;
};

function mapOperationStep(
  row: FundingOperationStepDbRow,
): FundingOperationStep {
  return {
    id: row.id,
    operationId: row.operation_id,
    segmentId: row.segment_id,
    ordinal: row.ordinal,
    stepKind: row.step_kind,
    state: row.state,
    actionFingerprint: row.action_fingerprint,
    executorId: row.executor_id,
    payerRequirement: row.payer_requirement,
    dependsOnStepId: row.depends_on_step_id,
    dependencyState: row.dependency_state,
    normalizedAction: row.normalized_action,
    actionValidationResult: row.action_validation_result,
  };
}

const operationStepColumns = `
  step.id,
  step.operation_id,
  step.segment_id,
  step.ordinal,
  step.step_kind,
  step.state,
  step.action_fingerprint,
  step.executor_id,
  step.payer_requirement,
  step.depends_on_step_id,
  dependency.state as dependency_state,
  step.normalized_action,
  step.action_validation_result
`;

export async function fetchFundingOperationStepForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    stepId: string;
  }>,
): Promise<FundingOperationStep | null> {
  const { rows } = await db.query<FundingOperationStepDbRow>(
    `
      select ${operationStepColumns}
      from funding_operation_steps step
      join funding_operations operation on operation.id = step.operation_id
      left join funding_operation_steps dependency
        on dependency.id = step.depends_on_step_id
       and dependency.operation_id = step.operation_id
      where operation.user_id = $1
        and operation.id = $2
        and step.id = $3
    `,
    [input.userId, input.operationId, input.stepId],
  );
  return rows[0] ? mapOperationStep(rows[0]) : null;
}

export type FundingWithdrawalDestination = Readonly<{
  id: string;
  userId: string;
  networkId: string;
  assetId: string;
  assetDecimals: number;
  addressCiphertext: string | null;
  addressLookupHmac: string;
  lookupKeyVersion: number;
  validationEvidence: JsonRecord;
  policyVersion: number;
  expiresAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
}>;

type FundingWithdrawalDestinationDbRow = {
  id: string;
  user_id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  address_ciphertext: string | null;
  address_lookup_hmac: string;
  lookup_key_version: number;
  validation_evidence: JsonRecord;
  policy_version: string | number;
  expires_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
};

const destinationColumns = `
  id,
  user_id,
  network_id,
  asset_id,
  asset_decimals,
  address_ciphertext,
  address_lookup_hmac,
  lookup_key_version,
  validation_evidence,
  policy_version,
  expires_at,
  revoked_at,
  revocation_reason
`;

function mapDestination(
  row: FundingWithdrawalDestinationDbRow,
): FundingWithdrawalDestination {
  return {
    id: row.id,
    userId: row.user_id,
    networkId: row.network_id,
    assetId: row.asset_id,
    assetDecimals: row.asset_decimals,
    addressCiphertext: row.address_ciphertext,
    addressLookupHmac: row.address_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
    validationEvidence: row.validation_evidence,
    policyVersion: Number(row.policy_version),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  };
}

export async function registerFundingWithdrawalDestinationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    networkId: string;
    assetId: string;
    assetDecimals: number;
    addressCiphertext: string;
    addressLookupHmac: string;
    lookupKeyVersion: number;
    validationEvidence: JsonRecord;
    policyVersion: number;
    expiresAt: Date;
    now?: Date;
  }>,
): Promise<
  Readonly<{ destination: FundingWithdrawalDestination; replayed: boolean }>
> {
  const existingResult = await client.query<FundingWithdrawalDestinationDbRow>(
    `
        select ${destinationColumns}
        from funding_withdrawal_destinations
        where user_id = $1
          and network_id = $2
          and asset_id = $3
          and address_lookup_hmac = $4
          and lookup_key_version = $5
          and revoked_at is null
        for update
      `,
    [
      input.userId,
      input.networkId,
      input.assetId,
      input.addressLookupHmac,
      input.lookupKeyVersion,
    ],
  );
  const existingRow = existingResult.rows[0];
  if (existingRow) {
    const existing = mapDestination(existingRow);
    const reusable =
      existing.assetDecimals === input.assetDecimals &&
      existing.policyVersion === input.policyVersion &&
      existing.expiresAt.getTime() > (input.now ?? new Date()).getTime();
    if (reusable) {
      return { destination: existing, replayed: true };
    }
    await client.query(
      `
        update funding_withdrawal_destinations
        set revoked_at = $2,
            revocation_reason = 'revalidated',
            address_ciphertext = null
        where id = $1 and revoked_at is null
      `,
      [existing.id, input.now ?? new Date()],
    );
  }

  const { rows } = await client.query<FundingWithdrawalDestinationDbRow>(
    `
      insert into funding_withdrawal_destinations (
        user_id,
        network_id,
        asset_id,
        asset_decimals,
        address_ciphertext,
        address_lookup_hmac,
        lookup_key_version,
        validation_evidence,
        policy_version,
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
      returning ${destinationColumns}
    `,
    [
      input.userId,
      input.networkId,
      input.assetId,
      input.assetDecimals,
      input.addressCiphertext,
      input.addressLookupHmac,
      input.lookupKeyVersion,
      input.validationEvidence,
      input.policyVersion,
      input.expiresAt,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("withdrawal destination insert returned no row");
  return { destination: mapDestination(row), replayed: false };
}

export async function registerFundingWithdrawalDestination(
  pool: Pool,
  input: Parameters<
    typeof registerFundingWithdrawalDestinationInTransaction
  >[1],
): Promise<
  Readonly<{ destination: FundingWithdrawalDestination; replayed: boolean }>
> {
  return tx(pool, (client) =>
    registerFundingWithdrawalDestinationInTransaction(client, input),
  );
}

export async function fetchFundingWithdrawalDestinationForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    destinationId: string;
    lockForShare?: boolean;
  }>,
): Promise<FundingWithdrawalDestination | null> {
  const { rows } = await db.query<FundingWithdrawalDestinationDbRow>(
    `
      select ${destinationColumns}
      from funding_withdrawal_destinations
      where user_id = $1 and id = $2
      ${input.lockForShare ? "for share" : ""}
    `,
    [input.userId, input.destinationId],
  );
  return rows[0] ? mapDestination(rows[0]) : null;
}

export async function revokeFundingWithdrawalDestinationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    destinationId: string;
    reason: string;
    cryptoShred: boolean;
    now?: Date;
  }>,
): Promise<FundingWithdrawalDestination> {
  const { rows } = await client.query<FundingWithdrawalDestinationDbRow>(
    `
      update funding_withdrawal_destinations
      set revoked_at = $4,
          revocation_reason = $3,
          address_ciphertext = case when $5 then null else address_ciphertext end
      where user_id = $1
        and id = $2
        and revoked_at is null
      returning ${destinationColumns}
    `,
    [
      input.userId,
      input.destinationId,
      input.reason,
      input.now ?? new Date(),
      input.cryptoShred,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "active withdrawal destination was not found for authenticated user",
    );
  }
  return mapDestination(row);
}

export type FundingStepAttemptOutcome =
  | "submitted"
  | "succeeded"
  | "failed"
  | "ambiguous"
  | "cancelled";

export type FundingStepAttempt = Readonly<{
  id: string;
  stepId: string;
  attemptNumber: number;
  canonicalActionFingerprint: string;
  executorId: string;
  outcome: "started" | FundingStepAttemptOutcome;
  broadcastMayHaveOccurred: boolean;
  referenceKind:
    | "transaction"
    | "signature"
    | "provider_receipt"
    | "external_handoff"
    | null;
  receiptRefCiphertext: string | null;
  receiptRefLookupHmac: string | null;
  lookupKeyVersion: number | null;
  actualCosts: JsonRecord;
  startedAt: Date;
  finishedAt: Date | null;
}>;

type FundingStepAttemptDbRow = {
  id: string;
  step_id: string;
  attempt_number: number;
  canonical_action_fingerprint: string;
  executor_id: string;
  outcome: FundingStepAttempt["outcome"];
  broadcast_may_have_occurred: boolean;
  reference_kind: FundingStepAttempt["referenceKind"];
  receipt_ref_ciphertext: string | null;
  receipt_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
  actual_costs: JsonRecord;
  started_at: Date;
  finished_at: Date | null;
};

const attemptColumns = `
  id,
  step_id,
  attempt_number,
  canonical_action_fingerprint,
  executor_id,
  outcome,
  broadcast_may_have_occurred,
  reference_kind,
  receipt_ref_ciphertext,
  receipt_ref_lookup_hmac,
  lookup_key_version,
  actual_costs,
  started_at,
  finished_at
`;

function mapAttempt(row: FundingStepAttemptDbRow): FundingStepAttempt {
  return {
    id: row.id,
    stepId: row.step_id,
    attemptNumber: row.attempt_number,
    canonicalActionFingerprint: row.canonical_action_fingerprint,
    executorId: row.executor_id,
    outcome: row.outcome,
    broadcastMayHaveOccurred: row.broadcast_may_have_occurred,
    referenceKind: row.reference_kind,
    receiptRefCiphertext: row.receipt_ref_ciphertext,
    receiptRefLookupHmac: row.receipt_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
    actualCosts: row.actual_costs,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function startFundingStepAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    stepId: string;
    canonicalActionFingerprint: string;
    executorId: string;
    now?: Date;
  }>,
): Promise<FundingStepAttempt> {
  const stepResult = await client.query<{
    action_fingerprint: string;
    executor_id: string;
  }>(
    `
      select action_fingerprint, executor_id
      from funding_operation_steps
      where id = $1 and operation_id = $2
      for update
    `,
    [input.stepId, input.operationId],
  );
  const step = stepResult.rows[0];
  if (!step) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation step was not found",
    );
  }
  if (
    step.action_fingerprint !== input.canonicalActionFingerprint ||
    step.executor_id !== input.executorId
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "attempt does not match the immutable committed action",
    );
  }

  const previousResult = await client.query<{
    attempt_number: number;
    broadcast_may_have_occurred: boolean;
    outcome: FundingStepAttempt["outcome"];
    receipt_status: string | null;
  }>(
    `
      select
        attempt.attempt_number,
        attempt.outcome,
        attempt.broadcast_may_have_occurred,
        receipt.status as receipt_status
      from funding_operation_step_attempts attempt
      left join funding_step_receipt_observations receipt
        on receipt.attempt_id = attempt.id
      where attempt.step_id = $1
      order by attempt.attempt_number desc
      limit 1
      for update of attempt
    `,
    [input.stepId],
  );
  const previous = previousResult.rows[0];
  const previousBroadcastProvenFailed = previous?.receipt_status === "failed";
  if (
    previous &&
    (previous.outcome === "started" ||
      previous.outcome === "succeeded" ||
      ((previous.outcome === "submitted" ||
        previous.outcome === "ambiguous" ||
        previous.broadcast_may_have_occurred) &&
        !previousBroadcastProvenFailed))
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "previous attempt may have broadcast; reconciliation is required before retry",
    );
  }
  const attemptNumber = (previous?.attempt_number ?? 0) + 1;
  const { rows } = await client.query<FundingStepAttemptDbRow>(
    `
      insert into funding_operation_step_attempts (
        step_id,
        attempt_number,
        canonical_action_fingerprint,
        executor_id,
        started_at
      )
      values ($1, $2, $3, $4, $5)
      returning ${attemptColumns}
    `,
    [
      input.stepId,
      attemptNumber,
      input.canonicalActionFingerprint,
      input.executorId,
      input.now ?? new Date(),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("funding attempt insert returned no row");
  return mapAttempt(row);
}

export async function startFundingStepAttemptForUserInTransaction(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    operationId: string;
    stepId: string;
    canonicalActionFingerprint: string;
    executorId: string;
    now?: Date;
  }>,
): Promise<
  Readonly<{
    attempt: FundingStepAttempt;
    step: FundingOperationStep;
  }>
> {
  const { rows } = await client.query<
    FundingOperationStepDbRow & {
      incomplete_prior_segment_count: string | number;
      operation_status: string;
    }
  >(
    `
        select
          ${operationStepColumns},
          (
            select count(*)
            from funding_operation_segments prior_segment
            join funding_operation_segments current_segment
              on current_segment.id = step.segment_id
             and current_segment.operation_id = step.operation_id
            where prior_segment.operation_id = step.operation_id
              and prior_segment.ordinal < current_segment.ordinal
              and prior_segment.status <> 'succeeded'
          ) as incomplete_prior_segment_count,
          operation.status as operation_status
        from funding_operation_steps step
        join funding_operations operation on operation.id = step.operation_id
        left join funding_operation_steps dependency
          on dependency.id = step.depends_on_step_id
         and dependency.operation_id = step.operation_id
        where operation.user_id = $1
          and operation.id = $2
          and step.id = $3
        for update of operation, step
    `,
    [input.userId, input.operationId, input.stepId],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation step was not found for authenticated user",
    );
  }
  if (
    ["completed", "refunded", "failed", "cancelled"].includes(
      row.operation_status,
    )
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "terminal funding operation cannot start an action",
    );
  }
  if (row.state !== "planned" && row.state !== "action_required") {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation step is not awaiting an action",
    );
  }
  if (row.depends_on_step_id && row.dependency_state !== "succeeded") {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation step dependency is not complete",
    );
  }
  if (Number(row.incomplete_prior_segment_count) > 0) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "a prior funding source leg has not settled",
    );
  }
  const attempt = await startFundingStepAttemptInTransaction(client, {
    operationId: input.operationId,
    stepId: input.stepId,
    canonicalActionFingerprint: input.canonicalActionFingerprint,
    executorId: input.executorId,
    now: input.now,
  });
  return { attempt, step: mapOperationStep(row) };
}

export async function startFundingStepAttemptForUser(
  pool: Pool,
  input: Parameters<typeof startFundingStepAttemptForUserInTransaction>[1],
): Promise<
  Awaited<ReturnType<typeof startFundingStepAttemptForUserInTransaction>>
> {
  return tx(pool, (client) =>
    startFundingStepAttemptForUserInTransaction(client, input),
  );
}

export async function finishFundingStepAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    attemptId: string;
    outcome: FundingStepAttemptOutcome;
    broadcastMayHaveOccurred: boolean;
    referenceKind: FundingStepAttempt["referenceKind"];
    receiptRefCiphertext: string | null;
    receiptRefLookupHmac: string | null;
    lookupKeyVersion: number | null;
    actualCosts: JsonRecord;
    now?: Date;
  }>,
): Promise<FundingStepAttempt> {
  const requiresAmbiguousBroadcastEvidence =
    input.outcome === "submitted" || input.outcome === "ambiguous";
  if (input.broadcastMayHaveOccurred !== requiresAmbiguousBroadcastEvidence) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "broadcast uncertainty is valid only for submitted or ambiguous attempts",
    );
  }
  const hasReference =
    input.referenceKind !== null ||
    input.receiptRefCiphertext !== null ||
    input.receiptRefLookupHmac !== null ||
    input.lookupKeyVersion !== null;
  if (
    hasReference &&
    (input.referenceKind === null ||
      input.receiptRefCiphertext === null ||
      input.receiptRefLookupHmac === null ||
      input.lookupKeyVersion === null)
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "attempt receipt reference must be supplied as an encrypted/HMAC tuple",
    );
  }
  const { rows } = await client.query<FundingStepAttemptDbRow>(
    `
      update funding_operation_step_attempts
      set outcome = $2,
          broadcast_may_have_occurred = $3,
          reference_kind = $4,
          receipt_ref_ciphertext = $5,
          receipt_ref_lookup_hmac = $6,
          lookup_key_version = $7,
          actual_costs = $8::jsonb,
          finished_at = $9
      where id = $1 and outcome = 'started'
      returning ${attemptColumns}
    `,
    [
      input.attemptId,
      input.outcome,
      input.broadcastMayHaveOccurred,
      input.referenceKind,
      input.receiptRefCiphertext,
      input.receiptRefLookupHmac,
      input.lookupKeyVersion,
      input.actualCosts,
      input.now ?? new Date(),
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding attempt is already finalized",
    );
  }
  return mapAttempt(row);
}

function stepStateForAttemptOutcome(
  outcome: FundingStepAttemptOutcome,
): "submitted" | "reconcile_required" | "failed" | "cancelled" {
  if (outcome === "submitted" || outcome === "succeeded") return "submitted";
  if (outcome === "ambiguous") return "reconcile_required";
  if (outcome === "failed") return "failed";
  return "cancelled";
}

export async function finishFundingStepAttemptForUserInTransaction(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    operationId: string;
    stepId: string;
    attemptId: string;
    outcome: FundingStepAttemptOutcome;
    broadcastMayHaveOccurred: boolean;
    referenceKind: FundingStepAttempt["referenceKind"];
    receiptRefCiphertext: string | null;
    receiptRefLookupHmac: string | null;
    lookupKeyVersion: number | null;
    actualCosts: JsonRecord;
    now?: Date;
  }>,
): Promise<
  Readonly<{
    attempt: FundingStepAttempt;
    stepState: "submitted" | "reconcile_required" | "failed" | "cancelled";
  }>
> {
  const scope = await client.query<{
    attempt_id: string;
    step_state: FundingOperationStepState;
  }>(
    `
        select attempt.id as attempt_id, step.state as step_state
        from funding_operation_step_attempts attempt
        join funding_operation_steps step on step.id = attempt.step_id
        join funding_operations operation on operation.id = step.operation_id
        where operation.user_id = $1
          and operation.id = $2
          and step.id = $3
          and attempt.id = $4
        for update of operation, step, attempt
    `,
    [input.userId, input.operationId, input.stepId, input.attemptId],
  );
  if (!scope.rows[0]) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding action attempt was not found for authenticated user",
    );
  }
  if (
    scope.rows[0].step_state !== "planned" &&
    scope.rows[0].step_state !== "action_required"
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation step is no longer awaiting this report",
    );
  }
  const attempt = await finishFundingStepAttemptInTransaction(client, input);
  const stepState = stepStateForAttemptOutcome(input.outcome);
  const updated = await client.query(
    `
        update funding_operation_steps
        set state = $2,
            updated_at = $3
        where id = $1
          and state in ('planned', 'action_required')
    `,
    [input.stepId, stepState, input.now ?? new Date()],
  );
  if (updated.rowCount !== 1) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation step changed while recording the report",
    );
  }
  await wakeFundingReconciliationInTransaction(client, {
    operationId: input.operationId,
    dueAt: input.now ?? new Date(),
  });
  return { attempt, stepState };
}

export async function finishFundingStepAttemptForUser(
  pool: Pool,
  input: Parameters<typeof finishFundingStepAttemptForUserInTransaction>[1],
): Promise<
  Awaited<ReturnType<typeof finishFundingStepAttemptForUserInTransaction>>
> {
  return tx(pool, (client) =>
    finishFundingStepAttemptForUserInTransaction(client, input),
  );
}

export type FundingReservationConsumer =
  | Readonly<{ kind: "web_order"; orderId: string }>
  | Readonly<{ kind: "execution"; executionId: string }>
  | Readonly<{ kind: "telegram_trade_intent"; intentId: string }>;

export type FundingTradeReservationLink = Readonly<{
  operationId: string;
  reservationId: string;
}>;

export type FundingConsumerReservation = Readonly<{
  operationId: string;
  reservationId: string;
  rawAmount: string;
  asset: Readonly<{
    networkId: string;
    assetId: string;
    decimals: number;
  }>;
  expiresAt: Date;
}>;

export async function fetchFundingConsumerReservationForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; operationId: string }>,
): Promise<FundingConsumerReservation | null> {
  const result = await db.query<{
    operation_id: string;
    reservation_id: string;
    raw_amount: string;
    network_id: string;
    asset_id: string;
    asset_decimals: number;
    expires_at: Date;
  }>(
    `
      select
        reservation.operation_id,
        reservation.id as reservation_id,
        reservation.raw_amount,
        reservation.network_id,
        reservation.asset_id,
        reservation.asset_decimals,
        reservation.expires_at
      from balance_reservations reservation
      join funding_operations operation
        on operation.id = reservation.operation_id
       and operation.user_id = reservation.user_id
      where reservation.user_id = $1
        and reservation.operation_id = $2
        and reservation.mode = 'settled_for_consumer'
        and reservation.state = 'active'
        and operation.status = 'ready'
        and operation.progress_stage = 'ready_for_consumer'
      order by reservation.id
      limit 2
    `,
    [input.userId, input.operationId],
  );
  if (result.rows.length > 1) {
    throw new FundingPersistenceError(
      "invalid_operation_state",
      "funding operation has ambiguous consumer reservations",
    );
  }
  const row = result.rows[0];
  return row
    ? {
        operationId: row.operation_id,
        reservationId: row.reservation_id,
        rawAmount: row.raw_amount,
        asset: {
          networkId: row.network_id,
          assetId: row.asset_id,
          decimals: row.asset_decimals,
        },
        expiresAt: row.expires_at,
      }
    : null;
}

type FundingTradeReservationScopeRow = Readonly<{
  operation_id: string;
  reservation_id: string;
  raw_amount: string;
  expires_at: Date;
  reservation_state: "active" | "consumed" | "released";
  consumer_kind: string | null;
  consumer_ref: string | null;
  operation_status: string;
  progress_stage: string;
  purpose: string;
  venue_id: string | null;
  market_id: string | null;
}>;

async function loadFundingTradeReservationScope(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId?: string | null;
    reservationId: string;
  }>,
): Promise<FundingTradeReservationScopeRow> {
  const result = await client.query<FundingTradeReservationScopeRow>(
    `
      select
        operation.id as operation_id,
        reservation.id as reservation_id,
        reservation.raw_amount,
        reservation.expires_at,
        reservation.state as reservation_state,
        reservation.consumer_kind,
        reservation.consumer_ref,
        operation.status as operation_status,
        operation.progress_stage,
        operation.purpose,
        operation.venue_id,
        operation.market_id
      from funding_operations operation
      join balance_reservations reservation
        on reservation.operation_id = operation.id
       and reservation.user_id = operation.user_id
      where ($1::uuid is null or operation.id = $1)
        and reservation.id = $2
        and operation.user_id = $3
        and reservation.mode = 'settled_for_consumer'
    `,
    [input.operationId ?? null, input.reservationId, input.userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "settled funding reservation is not linked to authenticated user",
    );
  }
  return row;
}

export async function assertFundingReservationReadyForTrade(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    link: FundingTradeReservationLink;
    venue: string;
    marketId: string | null;
    now?: Date;
  }>,
): Promise<Readonly<{ rawAmount: string; expiresAt: Date }>> {
  const row = await loadFundingTradeReservationScope(db, {
    userId: input.userId,
    operationId: input.link.operationId,
    reservationId: input.link.reservationId,
  });
  const now = input.now ?? new Date();
  if (
    row.operation_status !== "ready" ||
    row.progress_stage !== "ready_for_consumer" ||
    row.purpose !== "trade_shortfall" ||
    row.reservation_state !== "active" ||
    row.expires_at.getTime() <= now.getTime() ||
    row.venue_id !== input.venue ||
    row.market_id === null ||
    input.marketId === null ||
    row.market_id !== input.marketId
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding reservation is not ready for this exact trade",
    );
  }
  return { rawAmount: row.raw_amount, expiresAt: row.expires_at };
}

async function completeReadyFundingOperation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    resolution: "consumed_by_trade" | "released_to_venue_cash";
    now: Date;
  }>,
): Promise<void> {
  const operation = await fetchFundingOperationForUser(client, {
    userId: input.userId,
    operationId: input.operationId,
  });
  if (!operation) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding operation was not found for authenticated user",
    );
  }
  if (
    operation.status === "completed" &&
    operation.progressStage === "terminal"
  ) {
    return;
  }
  if (
    operation.status !== "ready" ||
    operation.progressStage !== "ready_for_consumer" ||
    operation.purpose !== "trade_shortfall"
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding operation is not awaiting a trade consumer",
    );
  }
  await transitionFundingOperationInTransaction(client, {
    operationId: operation.id,
    scope: { kind: "user", userId: input.userId },
    expectedVersion: operation.version,
    expectedState: {
      status: operation.status,
      stage: operation.progressStage,
    },
    nextState: { status: "completed", stage: "terminal" },
    supportMetadataPatch: {
      consumerResolution: input.resolution,
      consumerResolvedAt: input.now.toISOString(),
    },
    now: input.now,
  });
}

export async function consumeFundingReservationForLinkedConsumerInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    reservationId: string;
    consumer: FundingReservationConsumer;
    outcomeReason: string;
    now?: Date;
  }>,
) {
  const scope = await loadFundingTradeReservationScope(client, {
    userId: input.userId,
    reservationId: input.reservationId,
  });
  const operationId = scope.operation_id;
  if (!scope.venue_id || !scope.market_id) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "trade funding reservation is missing an exact venue and market binding",
    );
  }

  let consumerKind: string;
  let consumerRef: string;
  let linked = false;
  if (input.consumer.kind === "web_order") {
    consumerKind = "web_order";
    consumerRef = input.consumer.orderId;
    const result = await client.query(
      `
        select 1
        from orders
        where id = $1
          and user_id = $2
          and funding_operation_id = $3
          and funding_reservation_id = $4
          and venue = $5
          and side = 'BUY'
          and exists (
            select 1
            from unified_tokens token
            where token.market_id = $6
              and token.venue = $5
              and token.token_id = orders.token_id
          )
      `,
      [
        consumerRef,
        input.userId,
        operationId,
        input.reservationId,
        scope.venue_id,
        scope.market_id,
      ],
    );
    linked = result.rowCount === 1;
  } else if (input.consumer.kind === "execution") {
    consumerKind = "execution";
    consumerRef = input.consumer.executionId;
    const result = await client.query(
      `
        select 1
        from executions
        where id = $1
          and user_id = $2
          and funding_operation_id = $3
          and funding_reservation_id = $4
          and venue = $5
          and unified_market_id = $6
          and side = 'BUY'
      `,
      [
        consumerRef,
        input.userId,
        operationId,
        input.reservationId,
        scope.venue_id,
        scope.market_id,
      ],
    );
    linked = result.rowCount === 1;
  } else {
    consumerKind = "telegram_trade_intent";
    consumerRef = input.consumer.intentId;
    const result = await client.query(
      `
        select 1
        from telegram_trade_intents
        where id = $1
          and user_id = $2
          and funding_operation_id = $3
          and funding_reservation_id = $4
          and venue = $5
          and market_id = $6
          and action = 'buy'
      `,
      [
        consumerRef,
        input.userId,
        operationId,
        input.reservationId,
        scope.venue_id,
        scope.market_id,
      ],
    );
    linked = result.rowCount === 1;
  }
  if (!linked) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "reservation consumer is not linked to authenticated user and operation",
    );
  }

  const now = input.now ?? new Date();
  if (
    scope.reservation_state === "active" &&
    scope.expires_at.getTime() <= now.getTime()
  ) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding reservation expired before trade persistence",
    );
  }
  await completeReadyFundingOperation(client, {
    userId: input.userId,
    operationId,
    resolution: "consumed_by_trade",
    now,
  });
  return consumeFundingReservationInTransaction(client, {
    userId: input.userId,
    reservationId: input.reservationId,
    consumerKind,
    consumerRef,
    outcomeReason: input.outcomeReason,
    now,
  });
}

export async function releaseFundingReservationForAbandonedTradeInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    link: FundingTradeReservationLink;
    outcomeReason: string;
    now?: Date;
  }>,
): Promise<void> {
  const scope = await loadFundingTradeReservationScope(client, {
    userId: input.userId,
    operationId: input.link.operationId,
    reservationId: input.link.reservationId,
  });
  if (scope.reservation_state === "released") return;
  if (scope.reservation_state !== "active") {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "consumed funding reservation cannot be abandoned",
    );
  }
  const now = input.now ?? new Date();
  await completeReadyFundingOperation(client, {
    userId: input.userId,
    operationId: input.link.operationId,
    resolution: "released_to_venue_cash",
    now,
  });
  await releaseFundingReservationInTransaction(client, {
    reservationId: input.link.reservationId,
    outcomeReason: input.outcomeReason,
    now,
  });
}

export async function releaseFundingReservationForAbandonedTrade(
  pool: Pool,
  input: Parameters<
    typeof releaseFundingReservationForAbandonedTradeInTransaction
  >[1],
): Promise<void> {
  await tx(pool, (client) =>
    releaseFundingReservationForAbandonedTradeInTransaction(client, input),
  );
}

export type FundingRouteOutcome =
  | "succeeded"
  | "refunded"
  | "failed"
  | "reconcile_required"
  | "recovery_required"
  | "cancelled";

export async function startFundingRouteObservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    routeKeyHmac: string;
    routeKeyVersion: number;
    providerId: string;
    adapterVersion: number;
    amountBand: string;
    policyRevision: string;
    startedAt?: Date;
    supportMetadata?: JsonRecord;
  }>,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `
      insert into funding_route_observations (
        user_id,
        operation_id,
        route_key_hmac,
        route_key_version,
        provider_id,
        adapter_version,
        amount_band,
        started_at,
        outcome,
        policy_revision,
        support_metadata
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, 'in_progress', $9, $10::jsonb
      )
      returning id
    `,
    [
      input.userId,
      input.operationId,
      input.routeKeyHmac,
      input.routeKeyVersion,
      input.providerId,
      input.adapterVersion,
      input.amountBand,
      input.startedAt ?? new Date(),
      input.policyRevision,
      input.supportMetadata ?? {},
    ],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding route observation ownership was rejected",
    );
  }
  return id;
}

export async function finishFundingRouteObservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    routeObservationId: string;
    outcome: FundingRouteOutcome;
    latencyStages: JsonRecord;
    refundObserved: boolean;
    recoveryRequired: boolean;
    reasonCodes?: readonly string[];
    supportMetadata?: JsonRecord;
    finishedAt?: Date;
  }>,
): Promise<void> {
  const result = await client.query(
    `
      update funding_route_observations
      set finished_at = $4,
          latency_stages = $5::jsonb,
          outcome = $3,
          refund_observed = $6,
          recovery_required = $7,
          reason_codes = $8::text[],
          support_metadata = support_metadata || $9::jsonb
      where id = $1
        and user_id = $2
        and outcome = 'in_progress'
        and finished_at is null
    `,
    [
      input.routeObservationId,
      input.userId,
      input.outcome,
      input.finishedAt ?? new Date(),
      input.latencyStages,
      input.refundObserved,
      input.recoveryRequired,
      input.reasonCodes ?? [],
      input.supportMetadata ?? {},
    ],
  );
  if (result.rowCount !== 1) {
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "funding route observation is already terminal or out of scope",
    );
  }
}

export async function upsertFundingProviderRequestInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    segmentId: string;
    requestKind: "initial" | "child";
    requestRefCiphertext: string | null;
    requestRefLookupHmac: string;
    rawStatus: string | null;
    discoverySource: string;
    lookupKeyVersion: number;
    observedAt?: Date;
    supportMetadata?: JsonRecord;
  }>,
): Promise<Readonly<{ id: string; replayed: boolean }>> {
  const observedAt = input.observedAt ?? new Date();
  const { rows } = await client.query<{
    id: string;
    inserted: boolean;
    request_kind: "initial" | "child";
    request_ref_ciphertext: string | null;
    lookup_key_version: number;
    discovery_source: string;
  }>(
    `
      with owned_segment as (
        select segment.id
        from funding_operation_segments segment
        where segment.id = $1 and segment.operation_id = $2
      ),
      written as (
        insert into funding_provider_requests (
          segment_id,
          request_kind,
          request_ref_ciphertext,
          request_ref_lookup_hmac,
          raw_status,
          discovery_source,
          lookup_key_version,
          first_seen_at,
          last_seen_at,
          support_metadata
        )
        select
          owned_segment.id,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $9,
          $10::jsonb
        from owned_segment
        on conflict (segment_id, request_ref_lookup_hmac) do update set
          raw_status = excluded.raw_status,
          last_seen_at = greatest(
            funding_provider_requests.last_seen_at,
            excluded.last_seen_at
          ),
          support_metadata =
            funding_provider_requests.support_metadata
            || excluded.support_metadata
        returning
          id,
          request_kind,
          request_ref_ciphertext,
          lookup_key_version,
          discovery_source,
          (xmax = 0) as inserted
      )
      select * from written
    `,
    [
      input.segmentId,
      input.operationId,
      input.requestKind,
      input.requestRefCiphertext,
      input.requestRefLookupHmac,
      input.rawStatus,
      input.discoverySource,
      input.lookupKeyVersion,
      observedAt,
      input.supportMetadata ?? {},
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new FundingPersistenceError(
      "operation_not_found",
      "funding segment was not found for operation",
    );
  }
  const identityMismatches = [
    row.request_kind !== input.requestKind ? "request_kind" : null,
    row.request_ref_ciphertext !== input.requestRefCiphertext
      ? "request_ref_ciphertext"
      : null,
    row.lookup_key_version !== input.lookupKeyVersion
      ? "lookup_key_version"
      : null,
    row.discovery_source !== input.discoverySource ? "discovery_source" : null,
  ].filter((value): value is string => value !== null);
  if (identityMismatches.length > 0) {
    throw new FundingPersistenceError(
      "idempotency_conflict",
      `provider request fingerprint was reused with different identity (${identityMismatches.join(", ")})`,
    );
  }
  return { id: row.id, replayed: !row.inserted };
}
