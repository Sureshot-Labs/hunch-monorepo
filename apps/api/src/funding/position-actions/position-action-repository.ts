import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type { JsonObject, JsonValue } from "../domain/types.js";
import { canonicalJsonEqual } from "../persistence/canonical.js";

export type PositionActionStatus =
  | "prepared"
  | "awaiting_user"
  | "submitting"
  | "submitted"
  | "reconcile_required"
  | "confirmed"
  | "completed"
  | "failed"
  | "cancelled";

export type StoredPositionAction = Readonly<{
  id: string;
  userId: string;
  marketId: string | null;
  venueId: string;
  action: "sell" | "redeem";
  positionRef: string;
  ownerBindingId: string;
  ownerAddress: string;
  executionWalletId: string;
  executionAddress: string;
  executionMode:
    | "web_client"
    | "privy_authorization"
    | "privy_delegated"
    | "venue_relayer";
  inspectionRevision: string;
  actionDigest: string;
  idempotencyKey: string;
  status: PositionActionStatus;
  planSnapshot: JsonObject;
  evidenceSnapshot: JsonObject;
  normalizedActions: readonly JsonValue[];
  postconditions: readonly JsonValue[];
  submissionFingerprint: string | null;
  broadcastMayHaveOccurred: boolean;
  receiptStatus: "unobserved" | "pending" | "success" | "reverted" | "unknown";
  receiptObservedAt: Date | null;
  postconditionStatus: "pending" | "satisfied" | "failed" | "unavailable";
  lastErrorCode: string | null;
  submittedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type PositionActionRow = Readonly<{
  id: string;
  user_id: string;
  market_id: string | null;
  venue_id: string;
  action: "sell" | "redeem";
  position_ref: string;
  owner_binding_id: string;
  owner_address: string;
  execution_wallet_id: string;
  execution_address: string;
  execution_mode: StoredPositionAction["executionMode"];
  inspection_revision: string;
  action_digest: string;
  idempotency_key: string;
  status: PositionActionStatus;
  plan_snapshot: JsonObject;
  evidence_snapshot: JsonObject;
  normalized_actions: readonly JsonValue[];
  postconditions: readonly JsonValue[];
  submission_fingerprint: string | null;
  broadcast_may_have_occurred: boolean;
  receipt_status: StoredPositionAction["receiptStatus"];
  receipt_observed_at: Date | null;
  postcondition_status: StoredPositionAction["postconditionStatus"];
  last_error_code: string | null;
  submitted_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}>;

const COLUMNS = `
  id, user_id, market_id, venue_id, action, position_ref, owner_binding_id,
  owner_address, execution_wallet_id, execution_address, execution_mode,
  inspection_revision, action_digest, idempotency_key, status, plan_snapshot,
  evidence_snapshot, normalized_actions, postconditions,
  submission_fingerprint, broadcast_may_have_occurred, receipt_status,
  receipt_observed_at, postcondition_status, last_error_code, submitted_at,
  completed_at, created_at, updated_at
`;

function mapRow(row: PositionActionRow): StoredPositionAction {
  return {
    id: row.id,
    userId: row.user_id,
    marketId: row.market_id,
    venueId: row.venue_id,
    action: row.action,
    positionRef: row.position_ref,
    ownerBindingId: row.owner_binding_id,
    ownerAddress: row.owner_address,
    executionWalletId: row.execution_wallet_id,
    executionAddress: row.execution_address,
    executionMode: row.execution_mode,
    inspectionRevision: row.inspection_revision,
    actionDigest: row.action_digest,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    planSnapshot: row.plan_snapshot,
    evidenceSnapshot: row.evidence_snapshot,
    normalizedActions: row.normalized_actions,
    postconditions: row.postconditions,
    submissionFingerprint: row.submission_fingerprint,
    broadcastMayHaveOccurred: row.broadcast_may_have_occurred,
    receiptStatus: row.receipt_status,
    receiptObservedAt: row.receipt_observed_at,
    postconditionStatus: row.postcondition_status,
    lastErrorCode: row.last_error_code,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type PositionActionCreateInput = Readonly<{
  userId: string;
  marketId: string | null;
  venueId: string;
  action: "sell" | "redeem";
  positionRef: string;
  ownerBindingId: string;
  ownerAddress: string;
  executionWalletId: string;
  executionAddress: string;
  executionMode: StoredPositionAction["executionMode"];
  inspectionRevision: string;
  actionDigest: string;
  idempotencyKey: string;
  status: "prepared" | "awaiting_user";
  planSnapshot: JsonObject;
  evidenceSnapshot: JsonObject;
  normalizedActions: readonly JsonValue[];
  postconditions: readonly JsonValue[];
}>;

export class PositionActionPersistenceError extends Error {
  constructor(
    readonly code:
      | "idempotency_conflict"
      | "invalid_state"
      | "operation_not_found"
      | "submission_conflict",
    message: string,
  ) {
    super(message);
    this.name = "PositionActionPersistenceError";
  }
}

function sameCreate(
  existing: StoredPositionAction,
  input: PositionActionCreateInput,
): boolean {
  return (
    existing.userId === input.userId &&
    existing.venueId === input.venueId &&
    existing.action === input.action &&
    existing.positionRef === input.positionRef &&
    existing.ownerBindingId === input.ownerBindingId &&
    existing.ownerAddress.toLowerCase() === input.ownerAddress.toLowerCase() &&
    existing.executionWalletId === input.executionWalletId &&
    existing.executionAddress.toLowerCase() ===
      input.executionAddress.toLowerCase() &&
    existing.executionMode === input.executionMode &&
    existing.inspectionRevision === input.inspectionRevision &&
    existing.actionDigest === input.actionDigest &&
    canonicalJsonEqual(existing.planSnapshot, input.planSnapshot) &&
    canonicalJsonEqual(existing.evidenceSnapshot, input.evidenceSnapshot) &&
    canonicalJsonEqual(existing.normalizedActions, input.normalizedActions) &&
    canonicalJsonEqual(existing.postconditions, input.postconditions)
  );
}

async function fetchForUpdate(
  client: Pick<PoolClient, "query">,
  userId: string,
  operationId: string,
): Promise<StoredPositionAction> {
  const { rows } = await client.query<PositionActionRow>(
    `
      select ${COLUMNS}
      from position_action_operations
      where user_id = $1 and id = $2
      for update
    `,
    [userId, operationId],
  );
  const row = rows[0];
  if (!row) {
    throw new PositionActionPersistenceError(
      "operation_not_found",
      "position action operation not found",
    );
  }
  return mapRow(row);
}

async function refetch(
  client: Pick<PoolClient, "query">,
  operationId: string,
): Promise<StoredPositionAction> {
  const { rows } = await client.query<PositionActionRow>(
    `select ${COLUMNS} from position_action_operations where id = $1`,
    [operationId],
  );
  const row = rows[0];
  if (!row) {
    throw new PositionActionPersistenceError(
      "operation_not_found",
      "position action operation disappeared",
    );
  }
  return mapRow(row);
}

export async function createOrReplayPositionAction(
  pool: Pool,
  input: PositionActionCreateInput,
): Promise<Readonly<{ operation: StoredPositionAction; replayed: boolean }>> {
  return tx(pool, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`position-action:${input.userId}:${input.idempotencyKey}`],
    );
    const { rows: existingRows } = await client.query<PositionActionRow>(
      `
        select ${COLUMNS}
        from position_action_operations
        where user_id = $1
          and (
            idempotency_key = $2
            or (
              venue_id = $3
              and action = $4
              and owner_binding_id = $5
              and action_digest = $6
            )
          )
        order by (idempotency_key = $2) desc
        limit 1
        for update
      `,
      [
        input.userId,
        input.idempotencyKey,
        input.venueId,
        input.action,
        input.ownerBindingId,
        input.actionDigest,
      ],
    );
    const existingRow = existingRows[0];
    if (existingRow) {
      const existing = mapRow(existingRow);
      if (!sameCreate(existing, input)) {
        throw new PositionActionPersistenceError(
          "idempotency_conflict",
          "position action idempotency key or action digest was reused with different inputs",
        );
      }
      return { operation: existing, replayed: true };
    }

    const { rows } = await client.query<PositionActionRow>(
      `
        insert into position_action_operations (
          user_id, market_id, venue_id, action, position_ref,
          owner_binding_id, owner_address, execution_wallet_id,
          execution_address, execution_mode, inspection_revision,
          action_digest, idempotency_key, status, plan_snapshot,
          evidence_snapshot, normalized_actions, postconditions
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb
        )
        returning ${COLUMNS}
      `,
      [
        input.userId,
        input.marketId,
        input.venueId,
        input.action,
        input.positionRef,
        input.ownerBindingId,
        input.ownerAddress,
        input.executionWalletId,
        input.executionAddress,
        input.executionMode,
        input.inspectionRevision,
        input.actionDigest,
        input.idempotencyKey,
        input.status,
        JSON.stringify(input.planSnapshot),
        JSON.stringify(input.evidenceSnapshot),
        JSON.stringify(input.normalizedActions),
        JSON.stringify(input.postconditions),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("position action insert returned no row");
    return { operation: mapRow(row), replayed: false };
  });
}

export type PositionActionSubmissionClaim = Readonly<{
  claimed: boolean;
  operation: StoredPositionAction;
  attemptNumber: number | null;
  reason: "claimed" | "already_broadcast" | "terminal";
}>;

export async function claimPositionActionSubmission(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    canonicalActionFingerprint: string;
    executorId: string;
  }>,
): Promise<PositionActionSubmissionClaim> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    if (
      operation.broadcastMayHaveOccurred ||
      operation.status === "submitting" ||
      operation.status === "submitted" ||
      operation.status === "reconcile_required" ||
      operation.status === "confirmed"
    ) {
      return {
        claimed: false,
        operation,
        attemptNumber: null,
        reason: "already_broadcast",
      };
    }
    if (
      operation.status === "completed" ||
      operation.status === "failed" ||
      operation.status === "cancelled"
    ) {
      return {
        claimed: false,
        operation,
        attemptNumber: null,
        reason: "terminal",
      };
    }
    const { rows } = await client.query<{ attempt_number: number }>(
      `
        select coalesce(max(attempt_number), 0)::integer + 1 as attempt_number
        from position_action_attempts
        where action_operation_id = $1
      `,
      [operation.id],
    );
    const attemptNumber = rows[0]?.attempt_number ?? 1;
    await client.query(
      `
        insert into position_action_attempts (
          action_operation_id, attempt_number, canonical_action_fingerprint,
          executor_id
        )
        values ($1, $2, $3, $4)
      `,
      [
        operation.id,
        attemptNumber,
        input.canonicalActionFingerprint,
        input.executorId,
      ],
    );
    await client.query(
      `
        update position_action_operations
        set status = 'submitting', last_error_code = null
        where id = $1
      `,
      [operation.id],
    );
    return {
      claimed: true,
      operation: await refetch(client, operation.id),
      attemptNumber,
      reason: "claimed",
    };
  });
}

async function finishAttempt(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    operationId: string;
    attemptNumber: number;
    outcome:
      | "not_broadcast"
      | "submitted"
      | "ambiguous"
      | "confirmed"
      | "reverted"
      | "failed";
    broadcastMayHaveOccurred: boolean;
    submissionFingerprint: string | null;
    receiptEvidence?: JsonObject;
    errorCode?: string | null;
  }>,
): Promise<void> {
  const result = await client.query(
    `
      update position_action_attempts
      set outcome = $3,
          broadcast_may_have_occurred = $4,
          submission_fingerprint = $5,
          receipt_evidence = $6::jsonb,
          error_code = $7,
          finished_at = now()
      where action_operation_id = $1
        and attempt_number = $2
        and outcome = 'started'
    `,
    [
      input.operationId,
      input.attemptNumber,
      input.outcome,
      input.broadcastMayHaveOccurred,
      input.submissionFingerprint,
      input.receiptEvidence ?? {},
      input.errorCode ?? null,
    ],
  );
  if (result.rowCount !== 1) {
    throw new PositionActionPersistenceError(
      "invalid_state",
      "position action attempt is not active",
    );
  }
}

export async function recordPositionActionSubmission(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    attemptNumber: number;
    outcome: "submitted" | "ambiguous" | "not_broadcast" | "failed";
    submissionFingerprint: string | null;
    errorCode?: string | null;
  }>,
): Promise<StoredPositionAction> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    if (operation.status !== "submitting") {
      if (
        operation.submissionFingerprint &&
        operation.submissionFingerprint === input.submissionFingerprint
      ) {
        return operation;
      }
      throw new PositionActionPersistenceError(
        "invalid_state",
        "position action is not awaiting a submission result",
      );
    }
    const broadcast =
      input.outcome === "submitted" || input.outcome === "ambiguous";
    await finishAttempt(client, {
      operationId: operation.id,
      attemptNumber: input.attemptNumber,
      outcome: input.outcome,
      broadcastMayHaveOccurred: broadcast,
      submissionFingerprint: input.submissionFingerprint,
      errorCode: input.errorCode,
    });
    const status =
      input.outcome === "submitted"
        ? "submitted"
        : input.outcome === "ambiguous"
          ? "reconcile_required"
          : "failed";
    await client.query(
      `
        update position_action_operations
        set status = $2,
            submission_fingerprint = $3,
            broadcast_may_have_occurred = $4,
            receipt_status = case when $4 then 'pending' else 'unobserved' end,
            receipt_observed_at = case when $4 then now() else null end,
            last_error_code = $5,
            submitted_at = case when $4 then now() else null end,
            completed_at = case when $2 = 'failed' then now() else null end
        where id = $1
      `,
      [
        operation.id,
        status,
        input.submissionFingerprint,
        broadcast,
        input.errorCode ?? null,
      ],
    );
    return refetch(client, operation.id);
  });
}

export async function recordPositionActionReceipt(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    receipt: "success" | "reverted" | "unknown";
    receiptEvidence: JsonObject;
    errorCode?: string | null;
  }>,
): Promise<StoredPositionAction> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    if (!operation.broadcastMayHaveOccurred) {
      throw new PositionActionPersistenceError(
        "invalid_state",
        "receipt cannot be recorded before possible broadcast",
      );
    }
    if (operation.receiptStatus === "success" && input.receipt === "success") {
      return operation;
    }
    if (
      operation.status === "completed" ||
      operation.status === "failed" ||
      operation.status === "cancelled"
    ) {
      throw new PositionActionPersistenceError(
        "invalid_state",
        "terminal position action receipt cannot be rewritten",
      );
    }
    const status =
      input.receipt === "success"
        ? "confirmed"
        : input.receipt === "reverted"
          ? "failed"
          : "reconcile_required";
    await client.query(
      `
        update position_action_operations
        set status = $2,
            receipt_status = $3,
            receipt_observed_at = now(),
            last_error_code = $4,
            completed_at = case when $2 = 'failed' then now() else null end
        where id = $1
      `,
      [operation.id, status, input.receipt, input.errorCode ?? null],
    );
    const attemptOutcome =
      input.receipt === "success"
        ? "confirmed"
        : input.receipt === "reverted"
          ? "reverted"
          : "ambiguous";
    await client.query(
      `
        update position_action_attempts
        set outcome = $2,
            receipt_evidence = $3::jsonb,
            error_code = $4,
            finished_at = coalesce(finished_at, now())
        where id = (
          select id
          from position_action_attempts
          where action_operation_id = $1
            and broadcast_may_have_occurred
          order by attempt_number desc
          limit 1
        )
      `,
      [
        operation.id,
        attemptOutcome,
        input.receiptEvidence,
        input.errorCode ?? null,
      ],
    );
    if (input.receipt === "success") {
      for (const kind of ["position_refresh", "collateral_refresh"] as const) {
        await client.query(
          `
            insert into position_action_effects (
              action_operation_id, effect_kind
            )
            values ($1, $2)
            on conflict (action_operation_id, effect_kind) do nothing
          `,
          [operation.id, kind],
        );
      }
    }
    return refetch(client, operation.id);
  });
}

async function maybeCompleteConfirmedAction(
  client: Pick<PoolClient, "query">,
  operationId: string,
): Promise<void> {
  const result = await client.query(
    `
      update position_action_operations operation
      set status = 'completed',
          completed_at = now(),
          last_error_code = null
      where operation.id = $1
        and operation.status = 'confirmed'
        and operation.receipt_status = 'success'
        and operation.postcondition_status = 'satisfied'
        and not exists (
          select 1
          from position_action_effects effect
          where effect.action_operation_id = operation.id
            and effect.effect_kind in (
              'position_refresh', 'collateral_refresh'
            )
            and effect.status <> 'completed'
        )
    `,
    [operationId],
  );
  if (result.rowCount === 1) {
    for (const kind of ["activity", "notification"] as const) {
      await client.query(
        `
          insert into position_action_effects (
            action_operation_id, effect_kind
          )
          values ($1, $2)
          on conflict (action_operation_id, effect_kind) do nothing
        `,
        [operationId, kind],
      );
    }
  }
}

export async function recordPositionActionPostconditions(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    status: "satisfied" | "failed" | "unavailable";
    errorCode?: string | null;
  }>,
): Promise<StoredPositionAction> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    if (operation.receiptStatus !== "success") {
      throw new PositionActionPersistenceError(
        "invalid_state",
        "postconditions require a successful receipt",
      );
    }
    await client.query(
      `
        update position_action_operations
        set postcondition_status = $2,
            last_error_code = $3
        where id = $1
      `,
      [operation.id, input.status, input.errorCode ?? null],
    );
    await maybeCompleteConfirmedAction(client, operation.id);
    return refetch(client, operation.id);
  });
}

export async function completePositionActionEffect(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    effectKind:
      | "position_refresh"
      | "collateral_refresh"
      | "activity"
      | "notification";
    evidence: JsonObject;
  }>,
): Promise<StoredPositionAction> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    const result = await client.query(
      `
        update position_action_effects
        set status = 'completed',
            attempt_count = attempt_count + 1,
            evidence = $3::jsonb,
            last_error_code = null,
            completed_at = now()
        where action_operation_id = $1
          and effect_kind = $2
          and status <> 'completed'
      `,
      [operation.id, input.effectKind, input.evidence],
    );
    if (result.rowCount === 0) {
      const existing = await client.query<{ status: string }>(
        `
          select status
          from position_action_effects
          where action_operation_id = $1 and effect_kind = $2
        `,
        [operation.id, input.effectKind],
      );
      if (existing.rows[0]?.status !== "completed") {
        throw new PositionActionPersistenceError(
          "invalid_state",
          "position action effect is unavailable",
        );
      }
    }
    await maybeCompleteConfirmedAction(client, operation.id);
    return refetch(client, operation.id);
  });
}

export async function failPositionActionEffect(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    effectKind:
      | "position_refresh"
      | "collateral_refresh"
      | "activity"
      | "notification";
    errorCode: string;
    retryAt?: Date;
  }>,
): Promise<StoredPositionAction> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    const result = await client.query(
      `
        update position_action_effects
        set status = 'failed',
            attempt_count = attempt_count + 1,
            last_error_code = $3,
            next_attempt_at = $4,
            completed_at = null
        where action_operation_id = $1
          and effect_kind = $2
          and status <> 'completed'
      `,
      [
        operation.id,
        input.effectKind,
        input.errorCode,
        input.retryAt ?? new Date(),
      ],
    );
    if (result.rowCount === 0) {
      const existing = await client.query<{ status: string }>(
        `
          select status
          from position_action_effects
          where action_operation_id = $1 and effect_kind = $2
        `,
        [operation.id, input.effectKind],
      );
      if (existing.rows[0]?.status !== "completed") {
        throw new PositionActionPersistenceError(
          "invalid_state",
          "position action effect is unavailable",
        );
      }
    }
    return refetch(client, operation.id);
  });
}

export async function fetchPositionActionForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; operationId: string }>,
): Promise<StoredPositionAction | null> {
  const { rows } = await db.query<PositionActionRow>(
    `
      select ${COLUMNS}
      from position_action_operations
      where user_id = $1 and id = $2
    `,
    [input.userId, input.operationId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
