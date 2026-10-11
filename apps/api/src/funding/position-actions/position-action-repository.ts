import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { isRecord } from "../../lib/type-guards.js";
import type { JsonObject, JsonValue } from "../domain/types.js";
import { parsePrivyFundingTransactionReference } from "../execution/privy-transaction-reference.js";
import { canonicalRedemptionIdentity } from "./canonical-redemption-evidence.js";
import { polymarketV2RedemptionIdentity } from "./polymarket-v2-redemption-evidence.js";

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

export type PositionActionRequestIdentity = Readonly<{
  userId: string;
  venueId: string;
  action: "sell" | "redeem";
  positionRef: string;
  ownerBindingId: string;
  inspectionRevision: string;
}>;

function sameRequestIdentity(
  existing: StoredPositionAction,
  input: PositionActionRequestIdentity,
): boolean {
  return (
    existing.userId === input.userId &&
    existing.venueId === input.venueId &&
    existing.action === input.action &&
    existing.positionRef === input.positionRef &&
    existing.ownerBindingId === input.ownerBindingId &&
    existing.inspectionRevision === input.inspectionRevision
  );
}

function assertSameRequestIdentity(
  existing: StoredPositionAction,
  input: PositionActionRequestIdentity,
): void {
  if (!sameRequestIdentity(existing, input)) {
    throw new PositionActionPersistenceError(
      "idempotency_conflict",
      "position action idempotency key was reused with different request identity",
    );
  }
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
    // A request key deduplicates transport retries. The position lock is a
    // separate boundary: two fresh keys (for example from two tabs) must not
    // create two simultaneously actionable operations for one position.
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`position-action:${input.userId}:${input.idempotencyKey}`],
    );
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`position-action-position:${input.userId}:${input.positionRef}`],
    );
    const { rows: requestRows } = await client.query<PositionActionRow>(
      `
        select ${COLUMNS}
        from position_action_operations
        where user_id = $1 and idempotency_key = $2
        limit 1
        for update
      `,
      [input.userId, input.idempotencyKey],
    );
    const requestOperation = requestRows[0];
    if (requestOperation) {
      const existing = mapRow(requestOperation);
      assertSameRequestIdentity(existing, input);
      return { operation: existing, replayed: true };
    }

    const { rows: activeRows } = await client.query<PositionActionRow>(
      `
        select ${COLUMNS}
        from position_action_operations
        where user_id = $1
          and position_ref = $2
          and status in (
            'prepared',
            'awaiting_user',
            'submitting',
            'submitted',
            'reconcile_required',
            'confirmed'
          )
        order by created_at desc
        limit 1
        for update
      `,
      [input.userId, input.positionRef],
    );
    const activeRow = activeRows[0];
    if (activeRow) {
      const existing = mapRow(activeRow);
      if (
        existing.venueId !== input.venueId ||
        existing.action !== input.action
      ) {
        throw new PositionActionPersistenceError(
          "idempotency_conflict",
          "position already has a different active action",
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
    embeddedDispatchProtocol?: "privy_position_v1";
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
          executor_id, receipt_evidence, started_at
        )
        values ($1, $2, $3, $4, $5::jsonb, clock_timestamp())
      `,
      [
        operation.id,
        attemptNumber,
        input.canonicalActionFingerprint,
        input.executorId,
        JSON.stringify(
          operation.executionMode === "privy_authorization" &&
            input.embeddedDispatchProtocol
            ? { embeddedDispatchProtocol: input.embeddedDispatchProtocol }
            : {},
        ),
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
    allowUnreferencedAmbiguity?: boolean;
  }>,
): Promise<void> {
  const result = await client.query(
    `
      update position_action_attempts
      set outcome = $3,
          broadcast_may_have_occurred = $4,
          submission_fingerprint = $5,
          receipt_evidence = $6::jsonb || jsonb_build_object('quarantinedSubmission', receipt_evidence->'quarantinedSubmission'),
          error_code = $7,
          finished_at = now()
      where action_operation_id = $1
        and attempt_number = $2
        and (outcome = 'started' or (
          $8::boolean and outcome = 'ambiguous' and submission_fingerprint is null
        ))
    `,
    [
      input.operationId,
      input.attemptNumber,
      input.outcome,
      input.broadcastMayHaveOccurred,
      input.submissionFingerprint,
      input.receiptEvidence ?? {},
      input.errorCode ?? null,
      input.allowUnreferencedAmbiguity === true,
    ],
  );
  if (result.rowCount !== 1) {
    throw new PositionActionPersistenceError(
      "invalid_state",
      "position action attempt is not active",
    );
  }
}

async function assertPositionReferenceAttribution(
  client: Pick<PoolClient, "query">,
  operation: StoredPositionAction,
  reference: string,
): Promise<void> {
  const normalized = reference.toLowerCase();
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `position-submission:${normalized}`,
  ]);
  const peers = await client.query<PositionActionRow>(
    `select ${COLUMNS} from position_action_operations
      where submission_fingerprint is not null
        and lower(submission_fingerprint) = $1 and id <> $2`,
    [normalized, operation.id],
  );
  const exactIdentity = (candidate: StoredPositionAction) => {
    const plan = candidate.planSnapshot.plan;
    return isRecord(plan) && typeof plan.targetAddress === "string"
      ? canonicalRedemptionIdentity(candidate, plan.targetAddress)
      : null;
  };
  const expected = /^0x[0-9a-f]{64}$/i.test(reference)
    ? exactIdentity(operation)
    : null;
  const conflict = peers.rows.some((row) => {
    const peer = mapRow(row);
    const expectedV2 = /^0x[0-9a-f]{64}$/i.test(reference)
      ? polymarketV2RedemptionIdentity(operation)
      : null;
    const peerV2 = polymarketV2RedemptionIdentity(peer);
    // V2 exact-amount receipts independently attribute each position in a
    // bundle. Same owner/asset cannot be reused by another operation.
    if (expectedV2 && peerV2)
      return (
        peer.ownerAddress.toLowerCase() ===
          operation.ownerAddress.toLowerCase() &&
        peerV2.positionId === expectedV2.positionId
      );
    const identity = exactIdentity(peer);
    // Shared hashes require exact CTF settlement for both actions. Keep the
    // original exclusive fence for adapter/other unsupported receipt shapes.
    if (!expected || !identity) return true;
    if (
      peer.ownerAddress.toLowerCase() !== operation.ownerAddress.toLowerCase()
    )
      return false;
    return (
      (peer.venueId === operation.venueId &&
        identity.tokenId === expected.tokenId) ||
      (identity.ctf.toLowerCase() === expected.ctf.toLowerCase() &&
        identity.conditionId === expected.conditionId &&
        identity.parentId === expected.parentId &&
        identity.indexSets.length === expected.indexSets.length &&
        identity.indexSets.every(
          (value, index) => value === expected.indexSets[index],
        ))
    );
  });
  if (conflict)
    throw new PositionActionPersistenceError(
      "submission_conflict",
      "Position submission reference is already attributed to another action",
    );
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
    // A server-observed authorization denial is terminal. A late weak browser
    // report may read it, but cannot turn it back into broadcast ambiguity.
    if (
      operation.status === "failed" &&
      operation.lastErrorCode === "position_action_authorization_rejected" &&
      input.submissionFingerprint === null
    ) {
      const denied = await client.query(
        `select 1 from position_action_attempts
          where action_operation_id = $1 and attempt_number = $2
            and outcome = 'not_broadcast' and not broadcast_may_have_occurred
            and error_code = 'position_action_authorization_rejected'`,
        [operation.id, input.attemptNumber],
      );
      if (denied.rowCount === 1) return operation;
    }
    // Once the API durably claimed the provider POST, a disconnected browser
    // cannot prove non-broadcast or overwrite its recovery marker. Only an
    // exact positive reference can strengthen the journal at this boundary.
    if (
      operation.executionMode === "privy_authorization" &&
      operation.status === "reconcile_required" &&
      operation.broadcastMayHaveOccurred &&
      operation.lastErrorCode === POSITION_ACTION_MISSING_REFERENCE_CODE &&
      operation.submissionFingerprint === null &&
      input.submissionFingerprint === null
    )
      return operation;
    // A stale client claim remains open to a late positive submission report.
    // Never turn the recovery marker into permission for another broadcast.
    const lateUncertainSubmission =
      operation.status === "reconcile_required" &&
      operation.lastErrorCode === POSITION_ACTION_MISSING_REFERENCE_CODE &&
      operation.submissionFingerprint === null &&
      (input.outcome === "submitted" || input.outcome === "ambiguous");
    if (operation.status !== "submitting" && !lateUncertainSubmission) {
      // The server already journaled provider acceptance. A late browser
      // cancellation/report cannot erase it or replace it with an unverified
      // hash; the existing resolver binds the canonical transaction instead.
      if (
        operation.executionMode === "privy_authorization" &&
        operation.submissionFingerprint
      ) {
        const acceptedAttempt = await client.query<{
          submission_fingerprint: string | null;
        }>(
          `select submission_fingerprint from position_action_attempts
            where action_operation_id = $1 and attempt_number = $2`,
          [operation.id, input.attemptNumber],
        );
        const original = acceptedAttempt.rows[0]?.submission_fingerprint;
        if (original && parsePrivyFundingTransactionReference(original))
          return operation;
      }
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
    if (input.submissionFingerprint) {
      // Share the receipt fence with both late client reports and background
      // discovery. A read-only precheck outside this transaction would race.
      await assertPositionReferenceAttribution(
        client,
        operation,
        input.submissionFingerprint,
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
      allowUnreferencedAmbiguity:
        lateUncertainSubmission && input.submissionFingerprint !== null,
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

export const POSITION_ACTION_MISSING_REFERENCE_CODE =
  "position_action_submission_reference_missing";
export const POSITION_ACTION_SUBMISSION_REPORT_GRACE_MS = 5 * 60_000;

export async function fetchPositionActionSubmissionStartedAt(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; operationId: string }>,
): Promise<Date | null> {
  const { rows } = await db.query<{ started_at: Date }>(
    `select attempt_row.started_at
     from position_action_operations operation_row
     join position_action_attempts attempt_row on attempt_row.action_operation_id = operation_row.id
     where operation_row.user_id = $1 and operation_row.id = $2
       and attempt_row.broadcast_may_have_occurred
     order by attempt_row.attempt_number desc limit 1`,
    [input.userId, input.operationId],
  );
  return rows[0]?.started_at ?? null;
}

/** A proven pre-claim hash is not evidence of this send. Keep the broadcast
 * fence and same attempt; quarantine the unrelated reference so canonical
 * discovery or a late positive report can repair attribution without resending.
 */
export async function quarantinePreClaimPositionActionReference(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    expectedTransactionHash: string;
    receiptEvidence: JsonObject;
  }>,
): Promise<StoredPositionAction> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    if (
      !operation.broadcastMayHaveOccurred ||
      operation.submissionFingerprint !== input.expectedTransactionHash ||
      ["completed", "failed", "cancelled"].includes(operation.status)
    )
      return operation;
    const evidence = {
      ...input.receiptEvidence,
      rejectedSubmissionFingerprint: input.expectedTransactionHash,
    };
    await client.query(
      `update position_action_attempts
       set outcome = 'ambiguous', submission_fingerprint = null,
           receipt_evidence = receipt_evidence || jsonb_build_object('quarantinedSubmission', $2::jsonb),
           error_code = $3, finished_at = coalesce(finished_at, now())
       where id = (
         select id from position_action_attempts
         where action_operation_id = $1 and broadcast_may_have_occurred
         order by attempt_number desc limit 1
       )`,
      [operation.id, evidence, POSITION_ACTION_MISSING_REFERENCE_CODE],
    );
    await client.query(
      `update position_action_operations
       set status = 'reconcile_required', submission_fingerprint = null,
           receipt_status = 'unknown', receipt_observed_at = now(),
           postcondition_status = 'unavailable', last_error_code = $2
       where id = $1`,
      [operation.id, POSITION_ACTION_MISSING_REFERENCE_CODE],
    );
    return refetch(client, operation.id);
  });
}

/** Only the server's exact single-POST authorization denial can clear this fence. */
export async function recordPositionActionAuthorizationRejection(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    attemptNumber: number;
    httpStatus: 401 | 403;
  }>,
): Promise<StoredPositionAction> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    if (
      operation.executionMode !== "privy_authorization" ||
      operation.status !== "reconcile_required" ||
      operation.submissionFingerprint ||
      operation.lastErrorCode !== POSITION_ACTION_MISSING_REFERENCE_CODE
    )
      return operation;
    const attempt = await client.query<{
      attempt_number: number;
      outcome: string;
      submission_fingerprint: string | null;
    }>(
      `select attempt_number, outcome, submission_fingerprint from position_action_attempts
        where action_operation_id = $1 order by attempt_number desc limit 1`,
      [operation.id],
    );
    const latest = attempt.rows[0];
    if (
      latest?.attempt_number !== input.attemptNumber ||
      !["started", "ambiguous"].includes(latest.outcome) ||
      latest.submission_fingerprint
    )
      return operation;
    const errorCode = "position_action_authorization_rejected";
    await finishAttempt(client, {
      operationId: operation.id,
      attemptNumber: input.attemptNumber,
      outcome: "not_broadcast",
      broadcastMayHaveOccurred: false,
      submissionFingerprint: null,
      errorCode,
      allowUnreferencedAmbiguity: true,
      receiptEvidence: {
        provider: "privy",
        httpStatus: input.httpStatus,
        definitiveNoBroadcast: true,
      },
    });
    await client.query(
      `update position_action_operations set status = 'failed',
          broadcast_may_have_occurred = false, receipt_status = 'unobserved',
          receipt_observed_at = null, submitted_at = null, completed_at = now(), last_error_code = $2
        where id = $1`,
      [operation.id, errorCode],
    );
    return refetch(client, operation.id);
  });
}

function isUndispatchedEmbeddedAttempt(attempt: {
  outcome: string;
  broadcast_may_have_occurred: boolean;
  receipt_evidence: JsonObject;
}): boolean {
  // Only an explicitly opted-in new client uses the API's durable POST
  // boundary. Historical/client-owned submissions cannot inherit this proof.
  return (
    attempt.outcome === "started" &&
    !attempt.broadcast_may_have_occurred &&
    attempt.receipt_evidence.embeddedDispatchProtocol === "privy_position_v1"
  );
}

async function closeExpiredUndispatchedAttempt(
  client: Pick<PoolClient, "query">,
  operation: StoredPositionAction,
  attemptNumber: number,
): Promise<void> {
  const errorCode = "position_action_claim_expired_before_dispatch";
  await finishAttempt(client, {
    operationId: operation.id,
    attemptNumber,
    outcome: "not_broadcast",
    broadcastMayHaveOccurred: false,
    submissionFingerprint: null,
    errorCode,
  });
  await client.query(
    `update position_action_operations set status = 'failed', last_error_code = $2,
        completed_at = now() where id = $1`,
    [operation.id, errorCode],
  );
}

async function markUnreferencedAttemptForRecovery(
  client: Pick<PoolClient, "query">,
  operationId: string,
  attemptId: string,
): Promise<void> {
  await client.query(
    `update position_action_attempts
        set broadcast_may_have_occurred = true, error_code = $2
      where id = $1 and outcome in ('started', 'ambiguous')`,
    [attemptId, POSITION_ACTION_MISSING_REFERENCE_CODE],
  );
  await client.query(
    `update position_action_operations
        set status = 'reconcile_required', broadcast_may_have_occurred = true,
            last_error_code = $2
      where id = $1`,
    [operationId, POSITION_ACTION_MISSING_REFERENCE_CODE],
  );
}

/** One provider dispatch per client claim, even when its response is lost. */
export async function claimPositionActionEmbeddedDispatch(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    attemptNumber: number;
  }>,
): Promise<boolean> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    if (
      operation.executionMode !== "privy_authorization" ||
      operation.status !== "submitting" ||
      operation.broadcastMayHaveOccurred ||
      operation.submissionFingerprint
    )
      return false;
    const attempt = (
      await client.query<{
        id: string;
        attempt_number: number;
        outcome: string;
        broadcast_may_have_occurred: boolean;
        receipt_evidence: JsonObject;
        fresh: boolean;
      }>(
        `select id, attempt_number, outcome, broadcast_may_have_occurred, receipt_evidence,
          started_at > clock_timestamp() - ($2::integer * interval '1 millisecond') as fresh
        from position_action_attempts where action_operation_id = $1
        order by attempt_number desc limit 1 for update`,
        [operation.id, POSITION_ACTION_SUBMISSION_REPORT_GRACE_MS],
      )
    ).rows[0];
    if (
      !attempt ||
      attempt.attempt_number !== input.attemptNumber ||
      attempt.outcome !== "started" ||
      attempt.broadcast_may_have_occurred
    )
      return false;
    if (!attempt.fresh && isUndispatchedEmbeddedAttempt(attempt)) {
      await closeExpiredUndispatchedAttempt(
        client,
        operation,
        attempt.attempt_number,
      );
      return false;
    }
    // Legacy unmarked claims are uncertain; new first sends record the POST
    // boundary. Neither interrupted dispatch can authorize a second send.
    await markUnreferencedAttemptForRecovery(client, operation.id, attempt.id);
    return attempt.fresh;
  });
}

/** An abandoned claim is uncertainty, never proof that signing did not occur. */
export async function markStalePositionActionClaimForRecovery(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    staleBefore: Date;
  }>,
): Promise<StoredPositionAction> {
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    if (
      !["submitting", "reconcile_required"].includes(operation.status) ||
      operation.submissionFingerprint ||
      operation.lastErrorCode === POSITION_ACTION_MISSING_REFERENCE_CODE
    ) {
      return operation;
    }
    const pending = await client.query<{
      id: string;
      attempt_number: number;
      outcome: string;
      broadcast_may_have_occurred: boolean;
      receipt_evidence: JsonObject;
    }>(
      `select id, attempt_number, outcome, broadcast_may_have_occurred, receipt_evidence
         from position_action_attempts
        where action_operation_id = $1
          and outcome in ('started', 'ambiguous')
          and started_at <= $2
        order by attempt_number desc
        limit 1
        for update`,
      [operation.id, input.staleBefore],
    );
    const attempt = pending.rows[0];
    if (!attempt) return operation;
    if (
      operation.executionMode === "privy_authorization" &&
      isUndispatchedEmbeddedAttempt(attempt)
    ) {
      await closeExpiredUndispatchedAttempt(
        client,
        operation,
        attempt.attempt_number,
      );
      return refetch(client, operation.id);
    }
    await markUnreferencedAttemptForRecovery(client, operation.id, attempt.id);
    return refetch(client, operation.id);
  });
}

export async function bindPositionActionSubmissionTransactionHash(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    expectedSubmissionReference: string;
    transactionHash: string;
  }>,
): Promise<StoredPositionAction> {
  const transactionHash = input.transactionHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(transactionHash)) {
    throw new PositionActionPersistenceError(
      "submission_conflict",
      "position action transaction hash is invalid",
    );
  }
  return tx(pool, async (client) => {
    const operation = await fetchForUpdate(
      client,
      input.userId,
      input.operationId,
    );
    if (operation.submissionFingerprint?.toLowerCase() === transactionHash) {
      return operation;
    }
    if (
      !operation.broadcastMayHaveOccurred ||
      operation.submissionFingerprint !== input.expectedSubmissionReference ||
      operation.status === "failed" ||
      operation.status === "cancelled"
    ) {
      throw new PositionActionPersistenceError(
        "submission_conflict",
        "position action provider reference no longer matches",
      );
    }
    await assertPositionReferenceAttribution(
      client,
      operation,
      transactionHash,
    );
    await client.query(
      `
        update position_action_operations
        set submission_fingerprint = $2
        where id = $1
      `,
      [operation.id, transactionHash],
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
            receipt_evidence = $3::jsonb || jsonb_build_object('quarantinedSubmission', receipt_evidence->'quarantinedSubmission'),
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

export async function fetchPositionActionNotificationFacts(
  db: Pick<Pool, "query">,
  userId: string,
  operationId: string,
): Promise<{
  existingDedupeKey: string | null;
  actualPayoutRaw: string | null;
}> {
  const result = await db.query<{
    dedupe_key: string | null;
    actual_payout: string | null;
  }>(
    `select coalesce(
        case when notification_effect.status = 'completed' then
          coalesce(notification_effect.evidence->>'dedupeKey', 'redemption:position-action:' || operation_row.id::text)
        end, notification_row.dedupe_key) as dedupe_key,
        collateral_effect.evidence->>'actualPayoutRaw' as actual_payout
      from position_action_operations operation_row
      left join position_action_effects notification_effect
        on notification_effect.action_operation_id = operation_row.id
        and notification_effect.effect_kind = 'notification'
      left join position_action_effects collateral_effect
        on collateral_effect.action_operation_id = operation_row.id
        and collateral_effect.effect_kind = 'collateral_refresh' and collateral_effect.status = 'completed'
      left join notifications notification_row
        on notification_row.user_id = operation_row.user_id
        and notification_row.type = 'redemption_completed'
        and lower(notification_row.dedupe_key) = lower('redemption:' || operation_row.submission_fingerprint)
        and notification_row.data->>'venue' = operation_row.venue_id
        and lower(notification_row.data->>'walletAddress') = lower(operation_row.owner_address)
        and notification_row.data->>'tokenId' = operation_row.plan_snapshot->>'tokenId'
      where operation_row.user_id = $1 and operation_row.id = $2 limit 1`,
    [userId, operationId],
  );
  return {
    existingDedupeKey: result.rows[0]?.dedupe_key ?? null,
    actualPayoutRaw: result.rows[0]?.actual_payout ?? null,
  };
}

export async function hasCompletedPositionActionNotification(
  db: Pick<Pool, "query">,
  userId: string,
  operationId: string,
): Promise<boolean> {
  return (
    (await fetchPositionActionNotificationFacts(db, userId, operationId))
      .existingDedupeKey !== null
  );
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

/**
 * Reads the immutable result of a prepare request before any live evidence is
 * collected. A retry after a lost HTTP response must replay the stored action,
 * even when the market or RPC is temporarily unavailable on the retry.
 */
export async function fetchPositionActionByIdempotencyKey(
  db: Pick<Pool, "query">,
  input: PositionActionRequestIdentity & Readonly<{ idempotencyKey: string }>,
): Promise<StoredPositionAction | null> {
  const { rows } = await db.query<PositionActionRow>(
    `
      select ${COLUMNS}
      from position_action_operations
      where user_id = $1 and idempotency_key = $2
      limit 1
    `,
    [input.userId, input.idempotencyKey],
  );
  const row = rows[0];
  if (!row) return null;
  const operation = mapRow(row);
  assertSameRequestIdentity(operation, input);
  return operation;
}
