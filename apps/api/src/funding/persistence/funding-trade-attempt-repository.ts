import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type { JsonValue } from "../domain/types.js";
import {
  deriveFundingLifecycle,
  type FundingLifecycleProjection,
} from "../lifecycle/funding-lifecycle-projector.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import {
  sameFundingTradeConsumerIntent,
  storedFundingTradeConsumerIntentFromRow,
  type FundingTradeConsumerIntent,
} from "./funding-trade-consumer-intent.js";

export type FundingTradeExecutionPath =
  | "polymarket_clob"
  | "limitless_clob"
  | "limitless_amm"
  | "kalshi_dflow";

export type FundingTradeAttemptState =
  | "claimed"
  | "submission_started"
  | "accepted"
  | "ambiguous"
  | "definitive_failure";

export type FundingTradeAttempt = Readonly<{
  id: string;
  userId: string;
  operationId: string;
  reservationId: string;
  attemptNumber: number;
  venueId: string;
  marketId: string;
  executionPath: FundingTradeExecutionPath;
  idempotencyKey: string;
  canonicalFingerprint: string;
  consumerIntent: FundingTradeConsumerIntent;
  state: FundingTradeAttemptState;
  broadcastMayHaveOccurred: boolean;
  externalReference: string | null;
  errorCode: string | null;
  claimToken: string;
  claimLeaseUntil: Date;
  consumerKind: string | null;
  consumerRef: string | null;
  claimedAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type FundingTradeAttemptRow = Readonly<{
  id: string;
  user_id: string;
  operation_id: string;
  reservation_id: string;
  attempt_number: number;
  venue_id: string;
  market_id: string;
  execution_path: FundingTradeExecutionPath;
  idempotency_key: string;
  canonical_fingerprint: string;
  consumer_intent: FundingTradeConsumerIntent;
  consumer_intent_fingerprint: string;
  state: FundingTradeAttemptState;
  broadcast_may_have_occurred: boolean;
  external_reference: string | null;
  error_code: string | null;
  claim_token: string;
  claim_lease_until: Date;
  consumer_kind: string | null;
  consumer_ref: string | null;
  claimed_at: Date;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}>;

type FundingTradeReservationScopeRow = Readonly<{
  operation_id: string;
  reservation_id: string;
  expires_at: Date;
  reservation_state: string;
  purpose: string;
  venue_id: string | null;
  market_id: string | null;
  raw_amount: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  market_context_snapshot: unknown;
  requested_destination_amount: unknown;
}>;

const ATTEMPT_COLUMNS = `
  id, user_id, operation_id, reservation_id, attempt_number, venue_id,
  market_id, execution_path, idempotency_key, canonical_fingerprint, state,
  consumer_intent, consumer_intent_fingerprint,
  broadcast_may_have_occurred, external_reference, error_code, consumer_kind,
  consumer_ref, claim_token, claim_lease_until, claimed_at, resolved_at,
  created_at, updated_at
`;

function mapAttempt(row: FundingTradeAttemptRow): FundingTradeAttempt {
  return {
    id: row.id,
    userId: row.user_id,
    operationId: row.operation_id,
    reservationId: row.reservation_id,
    attemptNumber: row.attempt_number,
    venueId: row.venue_id,
    marketId: row.market_id,
    executionPath: row.execution_path,
    idempotencyKey: row.idempotency_key,
    canonicalFingerprint: row.canonical_fingerprint,
    consumerIntent: row.consumer_intent,
    state: row.state,
    broadcastMayHaveOccurred: row.broadcast_may_have_occurred,
    externalReference: row.external_reference,
    errorCode: row.error_code,
    claimToken: row.claim_token,
    claimLeaseUntil: row.claim_lease_until,
    consumerKind: row.consumer_kind,
    consumerRef: row.consumer_ref,
    claimedAt: row.claimed_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FundingTradeAttemptError extends Error {
  constructor(
    readonly code:
      | "attempt_conflict"
      | "attempt_not_found"
      | "invalid_state"
      | "sealed_handoff_required"
      | "reservation_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "FundingTradeAttemptError";
  }
}

/**
 * A v2 Mini App funded Buy has one additional durable boundary: its handoff
 * claim sets the linked Telegram intent to `executing` before a venue request.
 * Do not let an ordinary web consumer bypass that boundary simply by omitting
 * the optional handoff fields from its request. The fence deliberately stays
 * in place after cancellation/terminalization until normal reservation
 * cleanup releases the row: otherwise a stale caller could submit in the gap.
 */
async function assertTelegramAppHandoffV2FundingClaimBoundary(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    allowTelegramAppHandoffV2?: boolean;
    operationId: string;
    reservationId: string;
    userId: string;
  }>,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `select intent.id::text as id
       from telegram_trade_intents intent
      where intent.user_id = $1::uuid
        and intent.funding_operation_id = $2::uuid
        and intent.funding_reservation_id = $3::uuid
        and intent.action = 'buy'
        and intent.delivery_mode = 'app_handoff'
        and intent.result -> 'appHandoffExecution' ->> 'version' = '2'
        and (
          intent.result -> 'appHandoffExecution' ->> 'kind' = 'funding'
          or (
            intent.result -> 'appHandoffExecution' ->> 'kind' is null
            and intent.result -> 'appHandoffFunding' ->> 'version' = '2'
            and intent.result -> 'appHandoffFunding' ->> 'operationId'
              = intent.funding_operation_id::text
            and intent.result -> 'appHandoffFunding' ->> 'handoffId'
              = intent.result -> 'appHandoffExecution' ->> 'handoffId'
          )
        )
      for update`,
    [input.userId, input.operationId, input.reservationId],
  );
  if (!result.rows[0] || input.allowTelegramAppHandoffV2) return;
  throw new FundingTradeAttemptError(
    "sealed_handoff_required",
    "funding reservation requires its sealed Telegram Mini App handoff binding",
  );
}

async function loadReservationForUpdate(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    reservationId: string;
  }>,
): Promise<FundingTradeReservationScopeRow> {
  const operation = await client.query<{ id: string }>(
    `
      select id
      from funding_operations
      where id = $1 and user_id = $2
      for update
    `,
    [input.operationId, input.userId],
  );
  if (!operation.rows[0]) {
    throw new FundingTradeAttemptError(
      "reservation_unavailable",
      "funding operation is not linked to authenticated user",
    );
  }
  const result = await client.query<FundingTradeReservationScopeRow>(
    `
      select
        operation.id as operation_id,
        reservation.id as reservation_id,
        reservation.expires_at,
        reservation.state as reservation_state,
        operation.purpose,
        operation.venue_id,
        operation.market_id,
        reservation.raw_amount,
        reservation.network_id,
        reservation.asset_id,
        reservation.asset_decimals,
        operation.market_context_snapshot,
        operation.requested_destination_amount
      from balance_reservations reservation
      join funding_operations operation
        on operation.id = reservation.operation_id
       and operation.user_id = reservation.user_id
      where reservation.id = $1
        and reservation.operation_id = $2
        and reservation.user_id = $3
        and reservation.mode = 'settled_for_consumer'
      for update of reservation
    `,
    [input.reservationId, input.operationId, input.userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FundingTradeAttemptError(
      "reservation_unavailable",
      "settled funding reservation is not linked to authenticated user",
    );
  }
  return row;
}

function assertReservationScope(
  row: FundingTradeReservationScopeRow,
  lifecycle: FundingLifecycleProjection,
  input: Readonly<{
    venueId: string;
    marketId: string;
    consumerIntent: FundingTradeConsumerIntent;
    now: Date;
  }>,
): void {
  if (
    lifecycle.status !== "ready" ||
    lifecycle.progressStage !== "ready_for_consumer" ||
    row.purpose !== "trade_shortfall" ||
    row.reservation_state !== "active" ||
    row.expires_at.getTime() <= input.now.getTime() ||
    row.venue_id !== input.venueId ||
    row.market_id !== input.marketId
  ) {
    throw new FundingTradeAttemptError(
      "reservation_unavailable",
      "funding reservation is not ready for this exact trade",
    );
  }
  const expectedIntent = storedFundingTradeConsumerIntentFromRow(row);
  if (
    !expectedIntent ||
    !sameFundingTradeConsumerIntent(expectedIntent, input.consumerIntent)
  ) {
    throw new FundingTradeAttemptError(
      "reservation_unavailable",
      "funding reservation does not match this exact normalized trade spend",
    );
  }
}

async function projectedFundingLifecycleForTradeAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{ operationId: string; now: Date }>,
): Promise<FundingLifecycleProjection> {
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(
    client,
    {
      operationId: input.operationId,
      now: input.now,
    },
  );
  if (!facts) {
    throw new FundingTradeAttemptError(
      "reservation_unavailable",
      "funding operation disappeared before trade claim",
    );
  }
  return deriveFundingLifecycle(facts);
}

async function fetchAttemptForUpdate(
  client: Pick<PoolClient, "query">,
  input: Readonly<{ attemptId: string; userId: string }>,
): Promise<FundingTradeAttempt> {
  const result = await client.query<FundingTradeAttemptRow>(
    `
      select ${ATTEMPT_COLUMNS}
      from funding_trade_attempts
      where id = $1 and user_id = $2
      for update
    `,
    [input.attemptId, input.userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FundingTradeAttemptError(
      "attempt_not_found",
      "funding trade attempt was not found",
    );
  }
  return mapAttempt(row);
}

async function lockFundingOperationForAttempt(
  client: Pick<PoolClient, "query">,
  input: Readonly<{ attemptId: string; userId: string }>,
): Promise<string> {
  const identity = await client.query<{
    operation_id: string;
    reservation_id: string;
  }>(
    `select operation_id, reservation_id
       from funding_trade_attempts
      where id = $1 and user_id = $2`,
    [input.attemptId, input.userId],
  );
  const operationId = identity.rows[0]?.operation_id;
  const reservationId = identity.rows[0]?.reservation_id;
  if (!operationId || !reservationId) {
    throw new FundingTradeAttemptError(
      "attempt_not_found",
      "funding trade attempt was not found",
    );
  }
  // A sealed funded handoff claims intent -> operation. Outcome paths use the
  // same order so a concurrent retry cannot deadlock terminalization.
  await client.query(
    `select intent.id
       from telegram_trade_intents intent
      where intent.user_id = $1
        and intent.funding_operation_id = $2
      order by intent.id
      for update`,
    [input.userId, operationId],
  );
  const locked = await client.query<{ id: string }>(
    `select id
       from funding_operations
      where id = $1 and user_id = $2
      for update`,
    [operationId, input.userId],
  );
  if (!locked.rows[0]) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "funding operation disappeared before trade outcome recording",
    );
  }
  const reservation = await client.query<{ id: string }>(
    `select id
       from balance_reservations
      where id = $1 and operation_id = $2 and user_id = $3
      for update`,
    [reservationId, operationId, input.userId],
  );
  if (!reservation.rows[0]) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "funding reservation disappeared before trade outcome recording",
    );
  }
  return operationId;
}

export async function claimFundingTradeAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    reservationId: string;
    venueId: string;
    marketId: string;
    executionPath: FundingTradeExecutionPath;
    idempotencyKey: string;
    canonicalFingerprint: string;
    consumerIntent: FundingTradeConsumerIntent;
    externalReference?: string | null;
    /** Only the exact v2 handoff claimer may consume a bound reservation. */
    allowTelegramAppHandoffV2?: boolean;
    now?: Date;
  }>,
): Promise<
  Readonly<{
    claimed: boolean;
    attempt: FundingTradeAttempt;
    reason:
      | "claimed"
      | "reclaimed_before_submission"
      | "replay_requires_reconciliation";
  }>
> {
  const now = input.now ?? new Date();
  // The exact Mini App claimer already locks its handoff/intent before it
  // reaches this common path. Lock a linked intent first here as well, so an
  // ordinary request cannot take operation → intent while an exact request
  // takes intent → operation.
  await assertTelegramAppHandoffV2FundingClaimBoundary(client, input);
  const scope = await loadReservationForUpdate(client, input);

  const activeResult = await client.query<FundingTradeAttemptRow>(
    `
        select ${ATTEMPT_COLUMNS}
        from funding_trade_attempts
        where reservation_id = $1
          and state in ('claimed', 'submission_started', 'ambiguous')
        order by attempt_number desc
        limit 1
        for update
      `,
    [input.reservationId],
  );
  const activeRow = activeResult.rows[0];
  if (activeRow) {
    const active = mapAttempt(activeRow);
    if (
      active.userId === input.userId &&
      active.operationId === input.operationId &&
      active.venueId === input.venueId &&
      active.marketId === input.marketId &&
      active.executionPath === input.executionPath &&
      active.idempotencyKey === input.idempotencyKey &&
      active.canonicalFingerprint === input.canonicalFingerprint &&
      sameFundingTradeConsumerIntent(
        active.consumerIntent,
        input.consumerIntent,
      )
    ) {
      if (
        active.state === "claimed" &&
        active.claimLeaseUntil.getTime() <= now.getTime()
      ) {
        const reclaimed = await client.query<FundingTradeAttemptRow>(
          `
            update funding_trade_attempts
            set claim_token = gen_random_uuid(),
                claim_lease_until = $2::timestamptz + interval '15 seconds',
                updated_at = $2::timestamptz
            where id = $1 and state = 'claimed'
            returning ${ATTEMPT_COLUMNS}
          `,
          [active.id, now],
        );
        const reclaimedRow = reclaimed.rows[0];
        if (!reclaimedRow) {
          throw new FundingTradeAttemptError(
            "invalid_state",
            "funding trade attempt could not be reclaimed",
          );
        }
        return {
          claimed: true,
          attempt: mapAttempt(reclaimedRow),
          reason: "reclaimed_before_submission",
        };
      }
      return {
        claimed: false,
        attempt: active,
        reason: "replay_requires_reconciliation",
      };
    }
    throw new FundingTradeAttemptError(
      "attempt_conflict",
      "funding reservation already has an unresolved trade attempt",
    );
  }

  assertReservationScope(
    scope,
    await projectedFundingLifecycleForTradeAttemptInTransaction(client, {
      operationId: input.operationId,
      now,
    }),
    {
      venueId: input.venueId,
      marketId: input.marketId,
      consumerIntent: input.consumerIntent,
      now,
    },
  );

  const replayResult = await client.query<FundingTradeAttemptRow>(
    `
        select ${ATTEMPT_COLUMNS}
        from funding_trade_attempts
        where user_id = $1 and idempotency_key = $2
        limit 1
        for update
      `,
    [input.userId, input.idempotencyKey],
  );
  const replayRow = replayResult.rows[0];
  if (replayRow) {
    const replay = mapAttempt(replayRow);
    if (
      replay.operationId === input.operationId &&
      replay.reservationId === input.reservationId &&
      replay.venueId === input.venueId &&
      replay.marketId === input.marketId &&
      replay.executionPath === input.executionPath &&
      replay.canonicalFingerprint === input.canonicalFingerprint &&
      sameFundingTradeConsumerIntent(
        replay.consumerIntent,
        input.consumerIntent,
      )
    ) {
      return {
        claimed: false,
        attempt: replay,
        reason: "replay_requires_reconciliation",
      };
    }
    throw new FundingTradeAttemptError(
      "attempt_conflict",
      "trade idempotency key is already bound to another attempt",
    );
  }

  const numberResult = await client.query<{ attempt_number: number }>(
    `
        select coalesce(max(attempt_number), 0)::integer + 1 as attempt_number
        from funding_trade_attempts
        where reservation_id = $1
      `,
    [input.reservationId],
  );
  const attemptNumber = numberResult.rows[0]?.attempt_number ?? 1;
  const inserted = await client.query<FundingTradeAttemptRow>(
    `
        insert into funding_trade_attempts (
          user_id, operation_id, reservation_id, attempt_number, venue_id,
          market_id, execution_path, idempotency_key, canonical_fingerprint,
          consumer_intent, consumer_intent_fingerprint,
          external_reference, broadcast_may_have_occurred, claim_lease_until,
          claimed_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13,
          $14::timestamptz + interval '15 seconds', $14::timestamptz
        )
        returning ${ATTEMPT_COLUMNS}
      `,
    [
      input.userId,
      input.operationId,
      input.reservationId,
      attemptNumber,
      input.venueId,
      input.marketId,
      input.executionPath,
      input.idempotencyKey,
      input.canonicalFingerprint,
      input.consumerIntent,
      input.consumerIntent.fingerprint,
      input.externalReference?.trim() || null,
      false,
      now,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("funding trade attempt insert returned no row");
  return {
    claimed: true,
    attempt: mapAttempt(row),
    reason: "claimed",
  };
}

export async function claimFundingTradeAttempt(
  pool: Pool,
  input: Parameters<typeof claimFundingTradeAttemptInTransaction>[1],
): ReturnType<typeof claimFundingTradeAttemptInTransaction> {
  return tx(pool, (client) =>
    claimFundingTradeAttemptInTransaction(client, input),
  );
}

export async function markFundingTradeAttemptSubmissionStartedInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    reservationId: string;
    attemptId: string;
    claimToken: string;
    now?: Date;
  }>,
): Promise<FundingTradeAttempt> {
  const now = input.now ?? new Date();
  const operation = await client.query<{ id: string }>(
    `
        select id
        from funding_operations
        where id = $1 and user_id = $2
        for update
      `,
    [input.operationId, input.userId],
  );
  if (!operation.rows[0]) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "funding operation disappeared before trade submission",
    );
  }
  const lifecycle = await projectedFundingLifecycleForTradeAttemptInTransaction(
    client,
    { operationId: input.operationId, now },
  );
  if (
    lifecycle.status !== "ready" ||
    lifecycle.progressStage !== "ready_for_consumer"
  ) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "trade submission claim is no longer ready",
    );
  }
  const result = await client.query<FundingTradeAttemptRow>(
    `
        update funding_trade_attempts attempt
        set state = 'submission_started',
            broadcast_may_have_occurred = true,
            updated_at = $6
        from balance_reservations reservation, funding_operations operation
        where attempt.id = $1
          and attempt.user_id = $2
          and attempt.operation_id = $3
          and attempt.reservation_id = $4
          and attempt.claim_token = $5::uuid
          and attempt.state = 'claimed'
          and attempt.claim_lease_until > $6
          and reservation.id = attempt.reservation_id
          and reservation.user_id = attempt.user_id
          and reservation.operation_id = attempt.operation_id
          and reservation.state = 'active'
          and reservation.expires_at > $6
          and operation.id = attempt.operation_id
          and operation.user_id = attempt.user_id
        returning attempt.*
      `,
    [
      input.attemptId,
      input.userId,
      input.operationId,
      input.reservationId,
      input.claimToken,
      now,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "trade submission claim was cancelled, superseded, or is no longer ready",
    );
  }
  return mapAttempt(row);
}

export async function markFundingTradeAttemptSubmissionStarted(
  pool: Pool,
  input: Parameters<
    typeof markFundingTradeAttemptSubmissionStartedInTransaction
  >[1],
): Promise<FundingTradeAttempt> {
  return tx(pool, (client) =>
    markFundingTradeAttemptSubmissionStartedInTransaction(client, input),
  );
}

export async function recordFundingTradeAttemptOutcomeInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    attemptId: string;
    outcome: "ambiguous" | "definitive_failure";
    externalReference?: string | null;
    errorCode?: string | null;
    broadcastMayHaveOccurred: boolean;
    operationSupportMetadataPatch?: Readonly<Record<string, JsonValue>>;
    now?: Date;
  }>,
): Promise<FundingTradeAttempt> {
  const appendOperationEvidence = async (operationId: string) => {
    if (input.operationSupportMetadataPatch === undefined) return;
    const result = await client.query(
      `update funding_operations
          set support_metadata = support_metadata || $3::jsonb
        where id = $1 and user_id = $2`,
      [operationId, input.userId, input.operationSupportMetadataPatch],
    );
    if (result.rowCount !== 1) {
      throw new FundingTradeAttemptError(
        "invalid_state",
        "funding operation disappeared while recording trade evidence",
      );
    }
  };
  await lockFundingOperationForAttempt(client, input);
  const attempt = await fetchAttemptForUpdate(client, input);
  if (attempt.state === input.outcome) {
    if (input.externalReference?.trim() && attempt.externalReference === null) {
      const enriched = await client.query<FundingTradeAttemptRow>(
        `
          update funding_trade_attempts
          set external_reference = $3,
              error_code = coalesce($4, error_code),
              updated_at = $5
          where id = $1 and user_id = $2 and state = $6
          returning ${ATTEMPT_COLUMNS}
        `,
        [
          input.attemptId,
          input.userId,
          input.externalReference.trim(),
          input.errorCode ?? null,
          input.now ?? new Date(),
          input.outcome,
        ],
      );
      const enrichedRow = enriched.rows[0];
      if (enrichedRow) {
        const enrichedAttempt = mapAttempt(enrichedRow);
        await appendOperationEvidence(enrichedAttempt.operationId);
        return enrichedAttempt;
      }
    }
    await appendOperationEvidence(attempt.operationId);
    return attempt;
  }
  if (attempt.state !== "claimed" && attempt.state !== "submission_started") {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "funding trade attempt is already resolved",
    );
  }
  if (input.outcome === "ambiguous" && !input.broadcastMayHaveOccurred) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "ambiguous trade attempt must preserve possible broadcast",
    );
  }
  if (input.outcome === "ambiguous" && attempt.state !== "submission_started") {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "trade submission must start before its outcome can be ambiguous",
    );
  }
  const result = await client.query<FundingTradeAttemptRow>(
    `
      update funding_trade_attempts
      set state = $3,
          broadcast_may_have_occurred = $4,
          external_reference = coalesce($5, external_reference),
          error_code = $6,
          resolved_at = $7,
          updated_at = $7
      where id = $1
        and user_id = $2
        and state in ('claimed', 'submission_started')
      returning ${ATTEMPT_COLUMNS}
    `,
    [
      input.attemptId,
      input.userId,
      input.outcome,
      input.broadcastMayHaveOccurred,
      input.externalReference?.trim() || null,
      input.errorCode ?? null,
      input.now ?? new Date(),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "funding trade attempt is not awaiting an outcome",
    );
  }
  const recordedAttempt = mapAttempt(row);
  await appendOperationEvidence(recordedAttempt.operationId);
  return recordedAttempt;
}

export async function recordFundingTradeAttemptOutcome(
  pool: Pool,
  input: Parameters<typeof recordFundingTradeAttemptOutcomeInTransaction>[1],
): Promise<FundingTradeAttempt> {
  return tx(pool, (client) =>
    recordFundingTradeAttemptOutcomeInTransaction(client, input),
  );
}

/**
 * Lease ambiguous Limitless CLOB attempts for exact-key reconciliation. The
 * initial candidate read is deliberately unlocked; each candidate is then
 * rechecked while holding the canonical intent -> operation -> reservation ->
 * attempt lock chain. Provider I/O must happen only after these transactions
 * have committed.
 */
export async function claimAmbiguousLimitlessTradeAttemptsForReconciliation(
  pool: Pool,
  input: Readonly<{
    batchSize: number;
    leaseSeconds: number;
    now?: Date;
  }>,
): Promise<readonly FundingTradeAttempt[]> {
  const now = input.now ?? new Date();
  const batchSize = Math.max(1, Math.min(50, Math.trunc(input.batchSize)));
  const leaseSeconds = Math.max(
    5,
    Math.min(300, Math.trunc(input.leaseSeconds)),
  );
  const candidates = await pool.query<{ id: string; user_id: string }>(
    `select id, user_id
       from funding_trade_attempts
      where execution_path = 'limitless_clob'
        and state in ('submission_started', 'ambiguous')
        and broadcast_may_have_occurred = true
        and external_reference is not null
        and (state = 'submission_started' or resolved_at is not null)
        and claim_lease_until <= $1
      order by resolved_at, id
      limit $2`,
    [now, batchSize],
  );
  const claimed: FundingTradeAttempt[] = [];
  for (const candidate of candidates.rows) {
    const attempt = await claimLimitlessTradeAttemptForReconciliation(pool, {
      attemptId: candidate.id,
      userId: candidate.user_id,
      leaseSeconds,
      now,
    }).catch(() => null);
    if (attempt) claimed.push(attempt);
  }
  return claimed;
}

export async function claimLimitlessTradeAttemptForReconciliation(
  pool: Pool,
  input: Readonly<{
    attemptId: string;
    leaseSeconds: number;
    now?: Date;
    userId: string;
  }>,
): Promise<FundingTradeAttempt | null> {
  const now = input.now ?? new Date();
  const leaseSeconds = Math.max(
    5,
    Math.min(300, Math.trunc(input.leaseSeconds)),
  );
  return tx(pool, async (client) => {
    await lockFundingOperationForAttempt(client, input);
    const current = await fetchAttemptForUpdate(client, input);
    if (
      current.executionPath !== "limitless_clob" ||
      !["submission_started", "ambiguous"].includes(current.state) ||
      !current.broadcastMayHaveOccurred ||
      !current.externalReference ||
      (current.state === "ambiguous" && current.resolvedAt === null) ||
      current.claimLeaseUntil.getTime() > now.getTime()
    ) {
      return null;
    }
    const leased = await client.query<FundingTradeAttemptRow>(
      `update funding_trade_attempts
          set state = 'ambiguous',
              claim_token = gen_random_uuid(),
              claim_lease_until = $3::timestamptz
                                + ($4::int * interval '1 second'),
              resolved_at = coalesce(resolved_at, $3),
              error_code = case
                when state = 'submission_started'
                  then 'limitless_exact_status_reconciliation_started'
                else error_code
              end,
              updated_at = $3
        where id = $1
          and user_id = $2
          and state in ('submission_started', 'ambiguous')
          and claim_lease_until <= $3
        returning ${ATTEMPT_COLUMNS}`,
      [input.attemptId, input.userId, now, leaseSeconds],
    );
    return leased.rows[0] ? mapAttempt(leased.rows[0]) : null;
  });
}

/**
 * Resolve only a Limitless CLOB ambiguity for which the venue's exact
 * clientOrderId lookup authoritatively returned not_found after an age fence.
 * Generic outcome recording intentionally cannot move ambiguous attempts to a
 * terminal state.
 */
export async function proveAmbiguousLimitlessTradeAttemptAbsentInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    attemptId: string;
    clientOrderId: string;
    expectedClaimToken: string;
    minimumAgeMs: number;
    now?: Date;
    operationSupportMetadataPatch?: Readonly<Record<string, JsonValue>>;
    userId: string;
  }>,
): Promise<FundingTradeAttempt> {
  const now = input.now ?? new Date();
  const operationId = await lockFundingOperationForAttempt(client, input);
  const attempt = await fetchAttemptForUpdate(client, input);
  if (
    attempt.operationId !== operationId ||
    attempt.executionPath !== "limitless_clob" ||
    attempt.state !== "ambiguous" ||
    attempt.externalReference !== input.clientOrderId.trim() ||
    attempt.claimToken !== input.expectedClaimToken ||
    attempt.claimLeaseUntil.getTime() <= now.getTime() ||
    attempt.resolvedAt === null ||
    !Number.isSafeInteger(input.minimumAgeMs) ||
    input.minimumAgeMs <= 0 ||
    now.getTime() - attempt.resolvedAt.getTime() < input.minimumAgeMs
  ) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "Limitless absence proof does not match an aged ambiguous trade attempt",
    );
  }
  const resolved = await client.query<FundingTradeAttemptRow>(
    `update funding_trade_attempts
        set state = 'definitive_failure',
            error_code = 'limitless_exact_status_not_found',
            resolved_at = $3,
            updated_at = $3
      where id = $1
        and user_id = $2
        and state = 'ambiguous'
        and claim_token = $4::uuid
        and claim_lease_until > clock_timestamp()
      returning ${ATTEMPT_COLUMNS}`,
    [input.attemptId, input.userId, now, input.expectedClaimToken],
  );
  const row = resolved.rows[0];
  if (!row) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "Limitless ambiguous trade attempt changed before absence resolution",
    );
  }
  if (input.operationSupportMetadataPatch !== undefined) {
    const evidence = await client.query(
      `update funding_operations
          set support_metadata = support_metadata || $3::jsonb
        where id = $1 and user_id = $2`,
      [operationId, input.userId, input.operationSupportMetadataPatch],
    );
    if (evidence.rowCount !== 1) {
      throw new FundingTradeAttemptError(
        "invalid_state",
        "funding operation disappeared while recording absence proof",
      );
    }
  }
  return mapAttempt(row);
}

export async function proveAmbiguousLimitlessFokNoFillInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    attemptId: string;
    clientOrderId: string;
    expectedClaimToken: string;
    now?: Date;
    userId: string;
  }>,
): Promise<FundingTradeAttempt> {
  const now = input.now ?? new Date();
  const operationId = await lockFundingOperationForAttempt(client, input);
  const attempt = await fetchAttemptForUpdate(client, input);
  if (
    attempt.operationId !== operationId ||
    attempt.executionPath !== "limitless_clob" ||
    attempt.state !== "ambiguous" ||
    attempt.externalReference !== input.clientOrderId.trim() ||
    attempt.claimToken !== input.expectedClaimToken ||
    attempt.claimLeaseUntil.getTime() <= now.getTime()
  ) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "Limitless no-fill proof does not match an ambiguous trade attempt",
    );
  }
  const resolved = await client.query<FundingTradeAttemptRow>(
    `update funding_trade_attempts
        set state = 'definitive_failure',
            error_code = 'trade_no_fill',
            resolved_at = $3,
            updated_at = $3
      where id = $1
        and user_id = $2
        and state = 'ambiguous'
        and claim_token = $4::uuid
        and claim_lease_until > clock_timestamp()
      returning ${ATTEMPT_COLUMNS}`,
    [input.attemptId, input.userId, now, input.expectedClaimToken],
  );
  const row = resolved.rows[0];
  if (!row) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "Limitless ambiguous trade attempt changed before no-fill resolution",
    );
  }
  return mapAttempt(row);
}

export async function proveAmbiguousLimitlessTerminalRejectionInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    attemptId: string;
    clientOrderId: string;
    errorCode: string;
    expectedClaimToken: string;
    now?: Date;
    userId: string;
  }>,
): Promise<FundingTradeAttempt> {
  const now = input.now ?? new Date();
  const normalizedErrorCode = input.errorCode.trim();
  if (
    !/^limitless_exact_status_(?:rejected|failed|cancelled|canceled|expired)$/u.test(
      normalizedErrorCode,
    )
  ) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "Limitless terminal rejection proof has an invalid status",
    );
  }
  const operationId = await lockFundingOperationForAttempt(client, input);
  const attempt = await fetchAttemptForUpdate(client, input);
  if (
    attempt.operationId !== operationId ||
    attempt.executionPath !== "limitless_clob" ||
    attempt.state !== "ambiguous" ||
    attempt.externalReference !== input.clientOrderId.trim() ||
    attempt.claimToken !== input.expectedClaimToken ||
    attempt.claimLeaseUntil.getTime() <= now.getTime()
  ) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "Limitless terminal rejection does not match a leased ambiguous trade attempt",
    );
  }
  const resolved = await client.query<FundingTradeAttemptRow>(
    `update funding_trade_attempts
        set state = 'definitive_failure',
            error_code = $3,
            resolved_at = $4,
            updated_at = $4
      where id = $1
        and user_id = $2
        and state = 'ambiguous'
        and claim_token = $5::uuid
        and claim_lease_until > clock_timestamp()
      returning ${ATTEMPT_COLUMNS}`,
    [
      input.attemptId,
      input.userId,
      normalizedErrorCode,
      now,
      input.expectedClaimToken,
    ],
  );
  const row = resolved.rows[0];
  if (!row) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "Limitless ambiguous trade attempt changed before terminal rejection resolution",
    );
  }
  return mapAttempt(row);
}

export async function acceptFundingTradeAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    reservationId: string;
    attemptId?: string | null;
    expectedReconciliationClaimToken?: string | null;
    externalReference: string;
    consumerKind: "web_order" | "execution" | "telegram_trade_intent";
    consumerRef: string;
    now?: Date;
  }>,
): Promise<FundingTradeAttempt> {
  const result = await client.query<FundingTradeAttemptRow>(
    `
      select ${ATTEMPT_COLUMNS}
      from funding_trade_attempts
      where user_id = $1
        and operation_id = $2
        and reservation_id = $3
        and ($4::uuid is null or id = $4)
        and (
          $5::uuid is null
          or (claim_token = $5::uuid and claim_lease_until > clock_timestamp())
        )
        and state in (
          'claimed',
          'submission_started',
          'ambiguous',
          'accepted'
        )
      order by attempt_number desc
      limit 1
      for update
    `,
    [
      input.userId,
      input.operationId,
      input.reservationId,
      input.attemptId ?? null,
      input.expectedReconciliationClaimToken ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new FundingTradeAttemptError(
      "attempt_not_found",
      "funding reservation has no claim for this trade",
    );
  }
  const attempt = mapAttempt(row);
  if (attempt.state === "accepted") {
    if (
      attempt.externalReference === input.externalReference &&
      attempt.consumerKind === input.consumerKind &&
      attempt.consumerRef === input.consumerRef
    ) {
      return attempt;
    }
    throw new FundingTradeAttemptError(
      "attempt_conflict",
      "funding trade attempt is already linked to another consumer",
    );
  }
  const accepted = await client.query<FundingTradeAttemptRow>(
    `
      update funding_trade_attempts
      set state = 'accepted',
          broadcast_may_have_occurred = true,
          external_reference = $4,
          consumer_kind = $5,
          consumer_ref = $6,
          error_code = null,
          resolved_at = $7,
          updated_at = $7
      where id = $1
        and user_id = $2
        and reservation_id = $3
        and state in ('claimed', 'submission_started', 'ambiguous')
        and (
          $8::uuid is null
          or (claim_token = $8::uuid and claim_lease_until > clock_timestamp())
        )
      returning ${ATTEMPT_COLUMNS}
    `,
    [
      attempt.id,
      input.userId,
      input.reservationId,
      input.externalReference,
      input.consumerKind,
      input.consumerRef,
      input.now ?? new Date(),
      input.expectedReconciliationClaimToken ?? null,
    ],
  );
  const acceptedRow = accepted.rows[0];
  if (!acceptedRow) {
    throw new FundingTradeAttemptError(
      "invalid_state",
      "funding trade attempt could not be accepted",
    );
  }
  return mapAttempt(acceptedRow);
}

export async function hasUnresolvedFundingTradeAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    reservationId: string;
  }>,
): Promise<boolean> {
  const result = await client.query<{ unresolved: boolean }>(
    `
      select exists (
        select 1
        from funding_trade_attempts
        where user_id = $1
          and operation_id = $2
          and reservation_id = $3
          and state in ('submission_started', 'ambiguous')
      ) as unresolved
    `,
    [input.userId, input.operationId, input.reservationId],
  );
  return result.rows[0]?.unresolved === true;
}

export async function recoverFundingTradeAttemptForOrderInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    venueId: string;
    tokenId: string;
    externalReferences: readonly string[];
  }>,
): Promise<Readonly<{
  attemptId: string;
  operationId: string;
  reservationId: string;
}> | null> {
  const references = [
    ...new Set(
      input.externalReferences
        .map((reference) => reference.trim())
        .filter((reference) => reference.length >= 8),
    ),
  ];
  if (references.length === 0) return null;
  const candidates = await client.query<{
    id: string;
    operation_id: string;
    reservation_id: string;
  }>(
    `
      select attempt.id, attempt.operation_id, attempt.reservation_id
      from funding_trade_attempts attempt
      where attempt.user_id = $1
        and attempt.venue_id = $2
        and attempt.state in (
          'claimed',
          'submission_started',
          'ambiguous'
        )
        and exists (
          select 1
          from unified_tokens token
          where token.market_id = attempt.market_id
            and token.venue = attempt.venue_id
            and token.token_id = $3
        )
        and (
          attempt.external_reference = any($4::text[])
          or (
            attempt.execution_path = 'polymarket_clob'
            and attempt.idempotency_key = any(
              select 'polymarket-clob:' || reference
              from unnest($4::text[]) as reference
            )
          )
        )
      order by attempt.claimed_at, attempt.id
      limit 2
    `,
    [input.userId, input.venueId, input.tokenId, references],
  );
  if (candidates.rows.length > 1) {
    throw new FundingTradeAttemptError(
      "attempt_conflict",
      "external order matches multiple unresolved funding trade attempts",
    );
  }
  const candidate = candidates.rows[0];
  if (!candidate) return null;
  await client.query(
    `select intent.id
       from telegram_trade_intents intent
      where intent.user_id = $1
        and intent.funding_operation_id = $2
      order by intent.id
      for update`,
    [input.userId, candidate.operation_id],
  );
  const operation = await client.query<{ id: string }>(
    `select id
       from funding_operations
      where id = $1
        and user_id = $2
      for update`,
    [candidate.operation_id, input.userId],
  );
  if (!operation.rows[0]) return null;
  const reservation = await client.query<{ id: string }>(
    `select id
       from balance_reservations
      where id = $1
        and operation_id = $2
        and user_id = $3
        and state = 'active'
      for update`,
    [candidate.reservation_id, candidate.operation_id, input.userId],
  );
  if (!reservation.rows[0]) return null;
  const attempt = await client.query<{ id: string }>(
    `select attempt.id
       from funding_trade_attempts attempt
      where attempt.id = $1
        and attempt.user_id = $2
        and attempt.operation_id = $3
        and attempt.reservation_id = $4
        and attempt.venue_id = $5
        and attempt.state in (
          'claimed',
          'submission_started',
          'ambiguous'
        )
        and exists (
          select 1
          from unified_tokens token
          where token.market_id = attempt.market_id
            and token.venue = attempt.venue_id
            and token.token_id = $6
        )
        and (
          attempt.external_reference = any($7::text[])
          or (
            attempt.execution_path = 'polymarket_clob'
            and attempt.idempotency_key = any(
              select 'polymarket-clob:' || reference
              from unnest($7::text[]) as reference
            )
          )
        )
      for update
    `,
    [
      candidate.id,
      input.userId,
      candidate.operation_id,
      candidate.reservation_id,
      input.venueId,
      input.tokenId,
      references,
    ],
  );
  if (!attempt.rows[0]) return null;
  return {
    attemptId: candidate.id,
    operationId: candidate.operation_id,
    reservationId: candidate.reservation_id,
  };
}
