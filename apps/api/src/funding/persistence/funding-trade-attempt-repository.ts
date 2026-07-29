import { tx, type Pool, type PoolClient } from "@hunch/infra";

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
  operation_status: string;
  progress_stage: string;
  purpose: string;
  venue_id: string | null;
  market_id: string | null;
}>;

const ATTEMPT_COLUMNS = `
  id, user_id, operation_id, reservation_id, attempt_number, venue_id,
  market_id, execution_path, idempotency_key, canonical_fingerprint, state,
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
      | "reservation_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "FundingTradeAttemptError";
  }
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
        operation.status as operation_status,
        operation.progress_stage,
        operation.purpose,
        operation.venue_id,
        operation.market_id
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
  input: Readonly<{
    venueId: string;
    marketId: string;
    now: Date;
  }>,
): void {
  if (
    row.operation_status !== "ready" ||
    row.progress_stage !== "ready_for_consumer" ||
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
    externalReference?: string | null;
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
      active.canonicalFingerprint === input.canonicalFingerprint
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

  assertReservationScope(scope, {
    venueId: input.venueId,
    marketId: input.marketId,
    now,
  });

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
      replay.canonicalFingerprint === input.canonicalFingerprint
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
          external_reference, broadcast_may_have_occurred, claim_lease_until,
          claimed_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12::timestamptz + interval '15 seconds', $12::timestamptz
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
  await client.query(
    `
        select id
        from funding_operations
        where id = $1 and user_id = $2
        for update
      `,
    [input.operationId, input.userId],
  );
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
          and operation.status = 'ready'
          and operation.progress_stage = 'ready_for_consumer'
        returning attempt.*
      `,
    [
      input.attemptId,
      input.userId,
      input.operationId,
      input.reservationId,
      input.claimToken,
      input.now ?? new Date(),
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
    now?: Date;
  }>,
): Promise<FundingTradeAttempt> {
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
      if (enrichedRow) return mapAttempt(enrichedRow);
    }
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
  return mapAttempt(row);
}

export async function recordFundingTradeAttemptOutcome(
  pool: Pool,
  input: Parameters<typeof recordFundingTradeAttemptOutcomeInTransaction>[1],
): Promise<FundingTradeAttempt> {
  return tx(pool, (client) =>
    recordFundingTradeAttemptOutcomeInTransaction(client, input),
  );
}

export async function acceptFundingTradeAttemptInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    operationId: string;
    reservationId: string;
    attemptId?: string | null;
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
    `
      select id
      from funding_operations
      where id = $1 and user_id = $2
      for update
    `,
    [candidate.operation_id, input.userId],
  );
  const locked = await client.query<{ id: string }>(
    `
      select attempt.id
      from funding_trade_attempts attempt
      join balance_reservations reservation
        on reservation.id = attempt.reservation_id
       and reservation.operation_id = attempt.operation_id
       and reservation.user_id = attempt.user_id
      join funding_operations operation
        on operation.id = attempt.operation_id
       and operation.user_id = attempt.user_id
      where attempt.id = $1
        and attempt.user_id = $2
        and attempt.state in (
          'claimed',
          'submission_started',
          'ambiguous'
        )
        and reservation.state = 'active'
        and operation.status = 'ready'
        and operation.progress_stage = 'ready_for_consumer'
      for update of reservation, attempt
    `,
    [candidate.id, input.userId],
  );
  if (!locked.rows[0]) return null;
  return {
    attemptId: candidate.id,
    operationId: candidate.operation_id,
    reservationId: candidate.reservation_id,
  };
}
