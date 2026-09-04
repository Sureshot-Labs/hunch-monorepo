import { tx, type Pool, type PoolClient } from "@hunch/infra";

import {
  parseFundingReceiveReviewContinuation,
  parseFundingReceiveQuotePlan,
  type FundingReceiveQuotePlan,
  type FundingReceiveReviewContinuation,
  type AssetRef,
  type ExternalIngressInstruction,
  type FundingReceiveReceipt,
  type FundingReceiveAutomationPolicy,
  type FundingReceiveSessionChannel,
  type FundingReceiveMethod,
  type FundingReceiveSession,
  type FundingReceiveSessionStatus,
  type JsonValue,
} from "../domain/types.js";
import { canonicalAccountAddress } from "../domain/asset-identity.js";
import { allocateFundingObservationInTransaction } from "./funding-operation-repository.js";
import { lockFundingAuthorizationReservationScope } from "./funding-authorization-reservation-lock.js";
import { canonicalJsonEqual } from "./canonical.js";
import { reduceFundingOperationInTransaction } from "../reconciliation/funding-reducer.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type ReceiveTargets = NonNullable<ExternalIngressInstruction["receiveTargets"]>;
type ActiveReceiveSessionStatus =
  | "open"
  | "processing"
  | "review_required"
  | "recovery_required";

export class FundingReceiveSessionChannelConflictError extends Error {
  readonly code = "receive_channel_conflict";

  constructor() {
    super("an active receive session is owned by another channel");
    this.name = "FundingReceiveSessionChannelConflictError";
  }
}

export class FundingReceiveSessionExactScopeConflictError extends Error {
  readonly code = "receive_session_selection_conflict";

  constructor(readonly activeReceiveSessionId: string) {
    super(
      "another selected asset is already receiving funds for this destination",
    );
    this.name = "FundingReceiveSessionExactScopeConflictError";
  }
}

export class FundingReceiveSessionOpenIdempotencyConflictError extends Error {
  readonly code = "receive_session_idempotency_conflict";

  constructor() {
    super(
      "receive session idempotency key was already used for another option",
    );
    this.name = "FundingReceiveSessionOpenIdempotencyConflictError";
  }
}

type ReceiveSessionRow = Readonly<{
  id: string;
  user_id: string;
  status: FundingReceiveSessionStatus;
  owner_channel: FundingReceiveSessionChannel;
  venue_id: string;
  destination_option_id: string;
  venue_binding_option_id: string;
  destination_asset: AssetRef;
  destination_target_snapshot: JsonRecord;
  venue_binding_snapshot: JsonRecord;
  funding_methods: readonly FundingReceiveMethod[];
  receive_targets: ReceiveTargets;
  observation_variants: readonly JsonRecord[];
  observation_start_variants: readonly JsonRecord[];
  selected_receive_target_id: string | null;
  automation_policy: FundingReceiveAutomationPolicy;
  policy_version: string | number;
  policy_revision: string;
  ownership_revision: string;
  version: string | number;
  opened_at: Date;
  last_observed_at: Date | null;
  observation_requested_at: Date | null;
  expires_at: Date;
  observe_until: Date;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}>;

type ReceiveReceiptRow = Readonly<{
  id: string;
  receive_session_id: string;
  user_id: string;
  variant_id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  destination_address: string;
  raw_amount: string;
  observation_revision: string;
  tx_hash: string | null;
  event_index: string | null;
  ledger_height: string | null;
  block_hash: string | null;
  source_address: string | null;
  observed_at: Date;
  status: FundingReceiveReceipt["status"];
  handling: FundingReceiveReceipt["handling"];
  child_funding_operation_id: string | null;
  evidence: JsonRecord;
  created_at: Date;
  updated_at: Date;
}>;

const sessionColumns = `
  id,
  user_id,
  status,
  owner_channel,
  venue_id,
  destination_option_id,
  venue_binding_option_id,
  destination_asset,
  destination_target_snapshot,
  venue_binding_snapshot,
  funding_methods,
  receive_targets,
  observation_variants,
  observation_start_variants,
  selected_receive_target_id,
  automation_policy,
  policy_version,
  policy_revision,
  ownership_revision,
  version,
  opened_at,
  last_observed_at,
  observation_requested_at,
  expires_at,
  observe_until,
  closed_at,
  created_at,
  updated_at
`;

function publicSession(row: ReceiveSessionRow): FundingReceiveSession {
  return {
    receiveSessionId: row.id,
    status: row.status,
    venueId: row.venue_id,
    destinationOptionId: row.destination_option_id,
    venueBindingOptionId: row.venue_binding_option_id,
    destinationAsset: row.destination_asset,
    methods: row.funding_methods,
    receiveTargets: row.receive_targets,
    selectedReceiveTargetId: row.selected_receive_target_id,
    automationPolicy: row.automation_policy,
    version: Number(row.version),
    openedAt: row.opened_at.toISOString(),
    lastObservedAt: row.last_observed_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
    observeUntil: row.observe_until.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

function publicReceipt(row: ReceiveReceiptRow): FundingReceiveReceipt {
  const reviewContinuation = parseFundingReceiveReviewContinuation(
    row.evidence.reviewContinuation,
  );
  const reviewQuotePlan = parseFundingReceiveQuotePlan(
    row.evidence.reviewQuotePlan,
  );
  return {
    receiptId: row.id,
    receiveSessionId: row.receive_session_id,
    variantId: row.variant_id,
    asset: {
      networkId: row.network_id,
      assetId: row.asset_id,
      decimals: row.asset_decimals,
    },
    destinationAddress: row.destination_address,
    rawAmount: row.raw_amount,
    observationRevision: row.observation_revision,
    ledgerHeight: row.ledger_height,
    observedAt: row.observed_at.toISOString(),
    status: row.status,
    handling: row.handling,
    childFundingOperationId: row.child_funding_operation_id,
    ...(reviewContinuation && reviewQuotePlan
      ? { reviewContinuation, reviewQuotePlan }
      : {}),
  };
}

export function deriveActiveFundingReceiveSessionStatus(
  receiptStatuses: readonly FundingReceiveReceipt["status"][],
): ActiveReceiveSessionStatus {
  if (receiptStatuses.includes("recovery_required")) {
    return "recovery_required";
  }
  if (receiptStatuses.includes("review_required")) {
    return "review_required";
  }
  if (
    receiptStatuses.includes("observed") ||
    receiptStatuses.includes("routing")
  ) {
    return "processing";
  }
  return "open";
}

export async function derivePersistedFundingReceiveSessionStatus(
  db: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    userId: string;
  }>,
): Promise<ActiveReceiveSessionStatus> {
  const { rows } = await db.query<Pick<ReceiveReceiptRow, "status">>(
    `
      select status
      from funding_receive_receipts
      where receive_session_id = $1
        and user_id = $2
    `,
    [input.receiveSessionId, input.userId],
  );
  return deriveActiveFundingReceiveSessionStatus(rows.map((row) => row.status));
}

export async function deriveEffectiveFundingReceiveSessionStatus(
  db: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    userId: string;
  }>,
): Promise<ActiveReceiveSessionStatus | "completed" | null> {
  const scope = await db.query<{
    destination_option_id: string;
    venue_binding_option_id: string;
  }>(
    `
      select destination_option_id, venue_binding_option_id
      from funding_receive_sessions
      where id = $1
        and user_id = $2
      limit 1
    `,
    [input.receiveSessionId, input.userId],
  );
  const sessionScope = scope.rows[0];
  if (!sessionScope) return null;
  await lockFundingReceiveSessionScope(db, {
    userId: input.userId,
    destinationOptionId: sessionScope.destination_option_id,
    venueBindingOptionId: sessionScope.venue_binding_option_id,
  });
  const derivedStatus = await derivePersistedFundingReceiveSessionStatus(
    db,
    input,
  );
  if (derivedStatus !== "open") return derivedStatus;
  const releaseFacts = await db.query<{
    late_receipt_present: boolean;
    successor_present: boolean;
    was_closed: boolean;
  }>(
    `
      select
        receive_session.closed_at is not null as was_closed,
        exists (
          select 1
          from funding_receive_sessions successor_session
          where successor_session.user_id = receive_session.user_id
            and successor_session.destination_option_id =
                  receive_session.destination_option_id
            and successor_session.venue_binding_option_id =
                  receive_session.venue_binding_option_id
            and successor_session.id <> receive_session.id
            and successor_session.created_at > receive_session.created_at
        ) as successor_present,
        exists (
          select 1
          from funding_receive_receipts receive_receipt
          where receive_receipt.receive_session_id = receive_session.id
            and receive_receipt.evidence ->> 'lateReceipt' = 'true'
        ) as late_receipt_present
      from funding_receive_sessions receive_session
      where receive_session.id = $1
        and receive_session.user_id = $2
      limit 1
    `,
    [input.receiveSessionId, input.userId],
  );
  const release = releaseFacts.rows[0];
  if (!release) return null;
  // Ready receipts normally leave a still-valid address reusable. Once the
  // address was closed, received a late transfer, or was superseded, settling
  // its durable work must never make that old address active again.
  return release.was_closed ||
    release.late_receipt_present ||
    release.successor_present
    ? "completed"
    : "open";
}

async function refreshFundingReceiveSessionStatus(
  db: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    userId: string;
    now: Date;
  }>,
): Promise<void> {
  const status = await deriveEffectiveFundingReceiveSessionStatus(db, input);
  if (!status) return;
  await db.query(
    `
      update funding_receive_sessions
      set status = $3,
          closed_at = case
            when $3 = 'completed' then coalesce(closed_at, $4::timestamptz)
            else closed_at
          end,
          version = version + 1,
          updated_at = $4
      where id = $1
        and user_id = $2
        and status in ('open', 'processing', 'review_required', 'recovery_required')
    `,
    [input.receiveSessionId, input.userId, status, input.now],
  );
}

export type FundingReceiveSessionSnapshot = Readonly<{
  session: FundingReceiveSession;
  userId: string;
  ownerChannel: FundingReceiveSessionChannel;
  destinationTargetSnapshot: JsonRecord;
  venueBindingSnapshot: JsonRecord;
  observationVariants: readonly JsonRecord[];
  policyVersion: number;
  policyRevision: string;
  ownershipRevision: string;
  observeUntil: Date;
}>;

export type FundingReceiveSessionPersistenceResult = Readonly<{
  snapshot: FundingReceiveSessionSnapshot;
  replayed: boolean;
}>;

function snapshot(row: ReceiveSessionRow): FundingReceiveSessionSnapshot {
  return {
    session: publicSession(row),
    userId: row.user_id,
    ownerChannel: row.owner_channel,
    destinationTargetSnapshot: row.destination_target_snapshot,
    venueBindingSnapshot: row.venue_binding_snapshot,
    observationVariants: row.observation_variants,
    policyVersion: Number(row.policy_version),
    policyRevision: row.policy_revision,
    ownershipRevision: row.ownership_revision,
    observeUntil: row.observe_until,
  };
}

export async function lockFundingReceiveSessionScope(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    destinationOptionId: string;
    userId: string;
    venueBindingOptionId: string;
  }>,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    [
      "funding-receive-session",
      input.userId,
      input.destinationOptionId,
      input.venueBindingOptionId,
    ].join(":"),
  ]);
}

type FundingReceiveOpenIdempotency = Readonly<{
  key: string;
  requestFingerprint: string;
}>;

type ExactReceiveScope = Readonly<{
  selectedReceiveTargetId: string | null;
  receiveTargets: ReceiveTargets;
  requireExactReceiveScope?: boolean;
}>;

type FundingReceiveOpenIdempotencyRow = Readonly<{
  receive_session_id: string;
  request_fingerprint: string;
}>;

type FundingReceiveOpenIdempotencySessionRow = ReceiveSessionRow &
  Readonly<{
    request_fingerprint: string;
  }>;

/**
 * A receive session can be presentation-expired while an in-flight receipt is
 * still inside its observer grace window. This extra fact is selection-only:
 * it keeps a second token choice from concealing a receipt that is actively
 * being routed, without letting a review/recovery pause monopolize the deposit
 * destination. Closed sessions remain observable independently of this lease.
 */
type FundingReceiveSelectionSessionRow = ReceiveSessionRow &
  Readonly<{
    selection_has_any_receipt: boolean;
    selection_has_in_flight_receipt: boolean;
  }>;

type FundingReceiveSelectionState = Pick<
  FundingReceiveSelectionSessionRow,
  "status" | "expires_at" | "observe_until" | "selection_has_in_flight_receipt"
>;

function assertFundingReceiveOpenIdempotency(
  input: FundingReceiveOpenIdempotency,
): FundingReceiveOpenIdempotency {
  const key = input.key.trim();
  if (key.length < 8 || key.length > 256) {
    throw new FundingReceiveSessionOpenIdempotencyConflictError();
  }
  if (!/^[0-9a-f]{64}$/u.test(input.requestFingerprint)) {
    throw new FundingReceiveSessionOpenIdempotencyConflictError();
  }
  return { key, requestFingerprint: input.requestFingerprint };
}

async function lockFundingReceiveOpenIdempotency(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    ownerChannel: FundingReceiveSessionChannel;
    idempotency: FundingReceiveOpenIdempotency;
  }>,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    [
      "funding-receive-open",
      input.userId,
      input.ownerChannel,
      input.idempotency.key,
    ].join(":"),
  ]);
}

async function findFundingReceiveOpenIdempotency(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    ownerChannel: FundingReceiveSessionChannel;
    idempotency: FundingReceiveOpenIdempotency;
    lock?: boolean;
  }>,
): Promise<ReceiveSessionRow | null> {
  const result = await db.query<FundingReceiveOpenIdempotencySessionRow>(
    `
      select receive_session.*, open_idempotency.request_fingerprint
      from funding_receive_open_idempotency open_idempotency
      join funding_receive_sessions receive_session
        on receive_session.id = open_idempotency.receive_session_id
       and receive_session.user_id = open_idempotency.user_id
       and receive_session.owner_channel = open_idempotency.owner_channel
      where open_idempotency.user_id = $1
        and open_idempotency.owner_channel = $2
        and open_idempotency.idempotency_key = $3
      ${input.lock ? "for update" : ""}
      limit 1
    `,
    [input.userId, input.ownerChannel, input.idempotency.key],
  );
  const row = result.rows[0] ?? null;
  if (row && row.request_fingerprint !== input.idempotency.requestFingerprint) {
    throw new FundingReceiveSessionOpenIdempotencyConflictError();
  }
  return row;
}

async function attachFundingReceiveOpenIdempotency(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    ownerChannel: FundingReceiveSessionChannel;
    idempotency: FundingReceiveOpenIdempotency;
    receiveSessionId: string;
    now: Date;
  }>,
): Promise<void> {
  const inserted = await client.query<FundingReceiveOpenIdempotencyRow>(
    `
      insert into funding_receive_open_idempotency (
        user_id,
        owner_channel,
        idempotency_key,
        request_fingerprint,
        receive_session_id,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $6)
      on conflict (user_id, owner_channel, idempotency_key) do nothing
      returning receive_session_id, request_fingerprint
    `,
    [
      input.userId,
      input.ownerChannel,
      input.idempotency.key,
      input.idempotency.requestFingerprint,
      input.receiveSessionId,
      input.now,
    ],
  );
  const row = inserted.rows[0];
  if (row) return;
  const existing = await client.query<FundingReceiveOpenIdempotencyRow>(
    `
      select receive_session_id, request_fingerprint
      from funding_receive_open_idempotency
      where user_id = $1
        and owner_channel = $2
        and idempotency_key = $3
      for update
      limit 1
    `,
    [input.userId, input.ownerChannel, input.idempotency.key],
  );
  const persisted = existing.rows[0];
  if (
    !persisted ||
    persisted.receive_session_id !== input.receiveSessionId ||
    persisted.request_fingerprint !== input.idempotency.requestFingerprint
  ) {
    throw new FundingReceiveSessionOpenIdempotencyConflictError();
  }
}

function receiveSessionOwnsInFlightSelectionLease(
  session: Pick<
    FundingReceiveSelectionState,
    "status" | "selection_has_in_flight_receipt"
  >,
): boolean {
  return session.selection_has_in_flight_receipt;
}

function receiveSessionIsCurrentForSelection(
  session: FundingReceiveSelectionState,
  now: Date,
): boolean {
  return receiveSessionOwnsInFlightSelectionLease(session)
    ? session.observe_until > now
    : session.status === "open" && session.expires_at > now;
}

function matchesExactReceiveScope(
  session: Pick<
    ReceiveSessionRow,
    "selected_receive_target_id" | "receive_targets"
  >,
  input: ExactReceiveScope,
): boolean {
  return (
    !input.requireExactReceiveScope ||
    (session.selected_receive_target_id === input.selectedReceiveTargetId &&
      canonicalJsonEqual(session.receive_targets, input.receiveTargets))
  );
}

async function lockCurrentFundingReceiveSessions(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    userId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    /**
     * Read paused states as well because a session-level review/recovery status
     * can coexist with another receipt that is still observed or routing.
     */
    includePausedStates: boolean;
    now: Date;
  }>,
): Promise<readonly FundingReceiveSelectionSessionRow[]> {
  const { rows } = await client.query<FundingReceiveSelectionSessionRow>(
    `
      select ${sessionColumns},
             exists (
               select 1
               from funding_receive_receipts receipt
               where receipt.receive_session_id = funding_receive_sessions.id
             ) as selection_has_any_receipt,
             exists (
               select 1
               from funding_receive_receipts receipt
               where receipt.receive_session_id = funding_receive_sessions.id
                 and receipt.status in ('observed', 'routing')
             ) as selection_has_in_flight_receipt
      from funding_receive_sessions
      where user_id = $1
        and destination_option_id = $2
        and venue_binding_option_id = $3
        and (
          status = any($4::text[])
          or (
            $5::boolean
            and status in ('completed', 'expired', 'cancelled')
            and observe_until > $6
            and exists (
              select 1
              from funding_receive_receipts receipt
              where receipt.receive_session_id = funding_receive_sessions.id
                and receipt.status in ('observed', 'routing')
            )
          )
        )
      order by opened_at desc, id desc
      for update
    `,
    [
      input.userId,
      input.destinationOptionId,
      input.venueBindingOptionId,
      input.includePausedStates
        ? ["open", "processing", "review_required", "recovery_required"]
        : ["open", "processing", "review_required"],
      input.includePausedStates,
      input.now,
    ],
  );
  return rows;
}

function assertReplayDoesNotConflictWithCurrentSelection(
  replay: ReceiveSessionRow,
  current: readonly FundingReceiveSelectionSessionRow[],
  now: Date,
): void {
  const currentSessions = current.filter((session) =>
    receiveSessionIsCurrentForSelection(session, now),
  );
  if (
    currentSessions.some(
      (session) => session.owner_channel !== replay.owner_channel,
    )
  ) {
    throw new FundingReceiveSessionChannelConflictError();
  }
  const differentPostMoneySession = currentSessions.find(
    (session) =>
      session.id !== replay.id &&
      receiveSessionOwnsInFlightSelectionLease(session) &&
      !matchesExactReceiveScope(session, {
        selectedReceiveTargetId: replay.selected_receive_target_id,
        receiveTargets: replay.receive_targets,
        requireExactReceiveScope: true,
      }),
  );
  if (differentPostMoneySession) {
    throw new FundingReceiveSessionExactScopeConflictError(
      differentPostMoneySession.id,
    );
  }
}

async function replayLockedFundingReceiveOpenIdempotency(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    ownerChannel: FundingReceiveSessionChannel;
    idempotency: FundingReceiveOpenIdempotency;
    now: Date;
  }>,
): Promise<FundingReceiveSessionPersistenceResult | null> {
  await lockFundingReceiveOpenIdempotency(client, input);
  // Discover the immutable scope before taking any session row lock. Every
  // open path then takes locks in the same order: idempotency -> scope -> row.
  // Locking the replay row before the scope would deadlock against a fresh
  // open that already owns the scope and is about to inspect that same row.
  const discovered = await findFundingReceiveOpenIdempotency(client, {
    userId: input.userId,
    ownerChannel: input.ownerChannel,
    idempotency: input.idempotency,
  });
  if (!discovered) return null;
  await lockFundingReceiveSessionScope(client, {
    userId: discovered.user_id,
    destinationOptionId: discovered.destination_option_id,
    venueBindingOptionId: discovered.venue_binding_option_id,
  });
  const replay = await findFundingReceiveOpenIdempotency(client, {
    userId: input.userId,
    ownerChannel: input.ownerChannel,
    idempotency: input.idempotency,
    lock: true,
  });
  if (!replay || replay.id !== discovered.id) {
    throw new FundingReceiveSessionOpenIdempotencyConflictError();
  }
  const current = await lockCurrentFundingReceiveSessions(client, {
    userId: replay.user_id,
    destinationOptionId: replay.destination_option_id,
    venueBindingOptionId: replay.venue_binding_option_id,
    includePausedStates: true,
    now: input.now,
  });
  assertReplayDoesNotConflictWithCurrentSelection(replay, current, input.now);
  return { snapshot: snapshot(replay), replayed: true };
}

/**
 * Replays an opaque Add Funds request before validating its short-lived token.
 * A prior success remains safe to return after token expiry, unless another
 * asset has since crossed the money boundary for the same destination.
 */
export async function replayFundingReceiveSessionOpenIdempotency(
  db: Pool,
  input: Readonly<{
    userId: string;
    ownerChannel: FundingReceiveSessionChannel;
    idempotencyKey: string;
    requestFingerprint: string;
    now: Date;
  }>,
): Promise<FundingReceiveSessionPersistenceResult | null> {
  const idempotency = assertFundingReceiveOpenIdempotency({
    key: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
  });
  return tx(db, async (client) => {
    return replayLockedFundingReceiveOpenIdempotency(client, {
      userId: input.userId,
      ownerChannel: input.ownerChannel,
      idempotency,
      now: input.now,
    });
  });
}

export async function createOrReuseFundingReceiveSession(
  db: Pool,
  input: Readonly<{
    userId: string;
    ownerChannel?: FundingReceiveSessionChannel;
    venueId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    destinationAsset: AssetRef;
    destinationTargetSnapshot: JsonRecord;
    venueBindingSnapshot: JsonRecord;
    methods: readonly FundingReceiveMethod[];
    receiveTargets: ReceiveTargets;
    observationVariants: readonly JsonRecord[];
    selectedReceiveTargetId: string | null;
    /**
     * Generic token-first Add Funds binds a session to one asset+receiver.
     * Legacy destination-scoped callers intentionally retain their existing
     * all-accepted-assets replay behaviour.
     */
    requireExactReceiveScope?: boolean;
    /** Durable generic-open replay key; legacy callers omit it. */
    openIdempotency?: FundingReceiveOpenIdempotency;
    automationPolicy: FundingReceiveAutomationPolicy;
    policyVersion: number;
    policyRevision: string;
    ownershipRevision: string;
    expiresAt: Date;
    observeUntil: Date;
    now: Date;
  }>,
  finalize?: (
    client: PoolClient,
    result: FundingReceiveSessionPersistenceResult,
  ) => Promise<void>,
  preparePersistence?: (client: PoolClient) => Promise<void>,
): Promise<FundingReceiveSessionPersistenceResult> {
  const ownerChannel = input.ownerChannel ?? "web";
  const openIdempotency = input.openIdempotency
    ? assertFundingReceiveOpenIdempotency(input.openIdempotency)
    : null;
  return tx(db, async (client) => {
    const finalized = async (
      result: FundingReceiveSessionPersistenceResult,
    ): Promise<FundingReceiveSessionPersistenceResult> => {
      await finalize?.(client, result);
      return result;
    };
    await preparePersistence?.(client);
    if (openIdempotency) {
      const replay = await replayLockedFundingReceiveOpenIdempotency(client, {
        userId: input.userId,
        ownerChannel,
        idempotency: openIdempotency,
        now: input.now,
      });
      if (replay) {
        return finalized(replay);
      }
    }
    await lockFundingReceiveSessionScope(client, input);
    const existing = await lockCurrentFundingReceiveSessions(client, {
      ...input,
      // Session status is only an aggregate. Read paused sessions as well so
      // any coexisting observed/routing receipt still retains its exact lease.
      includePausedStates: true,
      now: input.now,
    });
    const protectedCrossChannelSession = existing.find(
      (session) =>
        session.owner_channel !== ownerChannel &&
        receiveSessionIsCurrentForSelection(session, input.now) &&
        receiveSessionOwnsInFlightSelectionLease(session),
    );
    if (protectedCrossChannelSession) {
      throw new FundingReceiveSessionChannelConflictError();
    }
    const exactSelection = input.requireExactReceiveScope === true;
    const selectionCandidates = exactSelection
      ? existing
      : existing.filter(
          (session) =>
            session.selection_has_in_flight_receipt ||
            session.status === "open" ||
            session.status === "processing" ||
            session.status === "review_required",
        );
    for (const staleSession of selectionCandidates) {
      if (receiveSessionIsCurrentForSelection(staleSession, input.now)) {
        continue;
      }
      // Review/recovery is durable work attached to the original receipt, not
      // an active receive-address lease. Keep it resumable by id while a fresh
      // deposit session is opened alongside it.
      if (
        staleSession.status === "review_required" ||
        staleSession.status === "recovery_required"
      ) {
        continue;
      }
      await client.query(
        `
          update funding_receive_sessions
          set status = 'expired',
              closed_at = $2,
              updated_at = $2,
              version = version + 1
          where id = $1
            and status in ('open', 'processing')
        `,
        [staleSession.id, input.now],
      );
    }
    const currentSessions = selectionCandidates.filter((session) =>
      receiveSessionIsCurrentForSelection(session, input.now),
    );
    const crossChannelSessions = currentSessions.filter(
      (session) => session.owner_channel !== ownerChannel,
    );
    if (
      crossChannelSessions.some((session) =>
        receiveSessionOwnsInFlightSelectionLease(session),
      )
    ) {
      throw new FundingReceiveSessionChannelConflictError();
    }

    // A fresh surface may supersede an unspent receive session from another
    // channel. We close, rather than mutate or return, the old session so its
    // opaque channel ownership is never disclosed. Cancelled sessions remain
    // observable through observe_until, so a transfer sent to an already
    // displayed address is still recovered and cannot be lost during handoff.
    for (const supersededSession of crossChannelSessions) {
      const cancelled = await client.query(
        `
          update funding_receive_sessions receive_session
          set status = 'cancelled',
              closed_at = $2,
              updated_at = $2,
              version = version + 1
          where receive_session.id = $1
            and receive_session.status = 'open'
            and not exists (
              select 1
              from funding_receive_receipts receipt
              where receipt.receive_session_id = receive_session.id
                and receipt.status in ('observed', 'routing')
            )
        `,
        [supersededSession.id, input.now],
      );
      if (cancelled.rowCount !== 1) {
        // An unresolved receipt can race with a new open. Fail closed instead
        // of replacing a session while money is still being handled.
        throw new FundingReceiveSessionChannelConflictError();
      }
    }

    const sameChannelSessions = currentSessions.filter(
      (session) => session.owner_channel === ownerChannel,
    );
    const differentPostMoneySession = sameChannelSessions.find(
      (session) =>
        input.requireExactReceiveScope &&
        receiveSessionOwnsInFlightSelectionLease(session) &&
        !matchesExactReceiveScope(session, input),
    );
    if (differentPostMoneySession) {
      throw new FundingReceiveSessionExactScopeConflictError(
        differentPostMoneySession.id,
      );
    }
    // Aggregate session status is intentionally allowed to be review/recovery
    // while another receipt from the same session is still observed/routing.
    // The money-bearing workflow owns the selection lease even if a newer,
    // address-only session is also present after an earlier rollout.
    const current =
      sameChannelSessions.find(receiveSessionOwnsInFlightSelectionLease) ??
      sameChannelSessions[0] ??
      null;
    if (
      current &&
      current.owner_channel === ownerChannel &&
      (receiveSessionOwnsInFlightSelectionLease(current) ||
        (!current.selection_has_any_receipt &&
          (ownerChannel === "telegram" ||
            (current.policy_revision === input.policyRevision &&
              current.ownership_revision === input.ownershipRevision)))) &&
      matchesExactReceiveScope(current, input)
    ) {
      if (openIdempotency) {
        await attachFundingReceiveOpenIdempotency(client, {
          userId: input.userId,
          ownerChannel,
          idempotency: openIdempotency,
          receiveSessionId: current.id,
          now: input.now,
        });
      }
      return finalized({ snapshot: snapshot(current), replayed: true });
    }
    if (current) {
      await client.query(
        `
          update funding_receive_sessions
          set status = 'expired',
              closed_at = $2,
              updated_at = $2,
              version = version + 1
          where id = $1
        `,
        [current.id, input.now],
      );
    }
    const releasedPausedSessionIds = existing
      .filter(
        (session) =>
          (session.status === "review_required" ||
            session.status === "recovery_required") &&
          !receiveSessionOwnsInFlightSelectionLease(session) &&
          session.closed_at === null,
      )
      .map((session) => session.id);
    if (releasedPausedSessionIds.length > 0) {
      // `created_at` is transaction-start time, so it cannot by itself prove
      // which concurrent open became the logical successor. Persist the
      // release on the paused predecessor while this scope lock is held. Its
      // review/recovery remains addressable by id, but later settlement cannot
      // resurrect the old receive address after the successor is cancelled.
      await client.query(
        `
          update funding_receive_sessions
          set closed_at = $2,
              updated_at = $2,
              version = version + 1
          where id = any($1::uuid[])
            and status in ('review_required', 'recovery_required')
            and closed_at is null
        `,
        [releasedPausedSessionIds, input.now],
      );
    }
    const inserted = await client.query<ReceiveSessionRow>(
      `
        insert into funding_receive_sessions (
          user_id,
          owner_channel,
          venue_id,
          destination_option_id,
          venue_binding_option_id,
          destination_asset,
          destination_target_snapshot,
          venue_binding_snapshot,
          funding_methods,
          receive_targets,
          observation_variants,
          observation_start_variants,
          selected_receive_target_id,
          automation_policy,
          policy_version,
          policy_revision,
          ownership_revision,
          opened_at,
          observation_requested_at,
          expires_at,
          observe_until
        )
        values (
          $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
          $9::jsonb, $10::jsonb, $11::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15,
          $16, $17, $17, $18, $19
        )
        returning ${sessionColumns}
      `,
      [
        input.userId,
        ownerChannel,
        input.venueId,
        input.destinationOptionId,
        input.venueBindingOptionId,
        JSON.stringify(input.destinationAsset),
        JSON.stringify(input.destinationTargetSnapshot),
        JSON.stringify(input.venueBindingSnapshot),
        JSON.stringify(input.methods),
        JSON.stringify(input.receiveTargets),
        JSON.stringify(input.observationVariants),
        input.selectedReceiveTargetId,
        JSON.stringify(input.automationPolicy),
        input.policyVersion,
        input.policyRevision,
        input.ownershipRevision,
        input.now,
        input.expiresAt,
        input.observeUntil,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("funding receive session insert returned no row");
    if (openIdempotency) {
      await attachFundingReceiveOpenIdempotency(client, {
        userId: input.userId,
        ownerChannel,
        idempotency: openIdempotency,
        receiveSessionId: row.id,
        now: input.now,
      });
    }
    return finalized({ snapshot: snapshot(row), replayed: false });
  });
}

export async function fetchFundingReceiveSessionForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; receiveSessionId: string }>,
): Promise<FundingReceiveSessionSnapshot | null> {
  const { rows } = await db.query<ReceiveSessionRow>(
    `
      select ${sessionColumns}
      from funding_receive_sessions
      where id = $1
        and user_id = $2
      limit 1
    `,
    [input.receiveSessionId, input.userId],
  );
  return rows[0] ? snapshot(rows[0]) : null;
}

export async function requestFundingReceiveSessionObservation(
  db: Pick<Pool, "query">,
  input: Readonly<{
    now: Date;
    receiveSessionId: string;
    userId: string;
  }>,
): Promise<boolean> {
  const result = await db.query(
    `
      update funding_receive_sessions receive_session
      set observation_requested_at = greatest(
            coalesce(receive_session.observation_requested_at, $3),
            $3
          ),
          updated_at = greatest(receive_session.updated_at, $3)
      where receive_session.id = $1
        and receive_session.user_id = $2
        and (
          (
            receive_session.status in ('open', 'processing', 'review_required')
            and receive_session.expires_at > $3
          )
          or (
            receive_session.status = 'recovery_required'
            and receive_session.observe_until > $3
          )
        )
    `,
    [input.receiveSessionId, input.userId, input.now],
  );
  return result.rowCount === 1;
}

export async function expireFundingReceiveSessions(
  db: Pick<Pool, "query">,
  input: Readonly<{ now: Date }>,
): Promise<number> {
  const result = await db.query(
    `
      update funding_receive_sessions
      set status = 'expired',
          closed_at = $1,
          version = version + 1,
          updated_at = $1
      where status in ('open', 'processing', 'review_required', 'recovery_required')
        and expires_at <= $1
    `,
    [input.now],
  );
  return result.rowCount ?? 0;
}

export async function claimObservableFundingReceiveSessions(
  db: Pick<Pool, "query">,
  input: Readonly<{
    limit: number;
    minimumPollIntervalMs: number;
    inactivePollIntervalMs?: number;
    closedPollIntervalMs?: number;
    activeWindowMs?: number;
    now: Date;
  }>,
): Promise<readonly FundingReceiveSessionSnapshot[]> {
  const minimumPollIntervalMs = Math.max(
    1_000,
    Math.trunc(input.minimumPollIntervalMs),
  );
  const inactivePollIntervalMs = Math.max(
    minimumPollIntervalMs,
    Math.trunc(input.inactivePollIntervalMs ?? 60_000),
  );
  const closedPollIntervalMs = Math.max(
    inactivePollIntervalMs,
    Math.trunc(input.closedPollIntervalMs ?? 300_000),
  );
  const activeWindowMs = Math.max(
    minimumPollIntervalMs,
    Math.trunc(input.activeWindowMs ?? 15 * 60_000),
  );
  const { rows } = await db.query<ReceiveSessionRow>({
    name: "funding-receive-claim-observable-sessions-v2",
    text: `
      with observable_sessions as (
        select
          id,
          case
            when status in ('open', 'processing') then 0
            when status in ('review_required', 'recovery_required') then 1
            else 2
          end as polling_class,
          case
            when status in (
                   'open', 'processing', 'review_required', 'recovery_required'
                 )
              and observation_requested_at is not null
              and (
                last_observed_at is null
                or last_observed_at < observation_requested_at
              )
              then 0
            else 1
          end as request_priority,
          coalesce(last_observed_at, opened_at) as polling_age,
          case
            when status in ('completed', 'expired', 'cancelled') then $5::bigint
            when coalesce(observation_requested_at, opened_at)
                   <= $1::timestamptz
                        - ($6::bigint * interval '1 millisecond')
              then $4::bigint
            else $3::bigint
          end as poll_interval_ms
        from funding_receive_sessions
        where (
            (
              status in ('open', 'processing', 'review_required')
              and expires_at > $1::timestamptz
            )
            or (
              status = 'recovery_required'
              and observe_until > $1::timestamptz
            )
            or (
              status in ('completed', 'expired', 'cancelled')
              and observe_until > $1::timestamptz
            )
          )
      ),
      eligible_sessions as (
        select
          id,
          polling_class,
          request_priority,
          polling_age + (poll_interval_ms * interval '1 millisecond')
            as next_poll_at
        from observable_sessions
        where (
            request_priority = 0
            or polling_age
              <= $1::timestamptz
                   - (poll_interval_ms * interval '1 millisecond')
          )
      ),
      candidates as (
        select receive_session.id
        from eligible_sessions eligible_session
        join funding_receive_sessions receive_session
          on receive_session.id = eligible_session.id
        -- Earliest deadline first preserves the configured hot/inactive/late
        -- cadences and guarantees progress for every class even when a worker
        -- is deliberately run with a one-row batch.
        order by eligible_session.next_poll_at asc,
                 eligible_session.request_priority asc,
                 eligible_session.polling_class asc,
                 receive_session.id asc
        for update of receive_session skip locked
        limit $2::integer
      ),
      claimed as (
        update funding_receive_sessions session
        set last_observed_at = $1::timestamptz
        from candidates
        where session.id = candidates.id
        returning session.*
      )
      select ${sessionColumns}
      from claimed
      order by coalesce(last_observed_at, opened_at) asc
    `,
    values: [
      input.now,
      input.limit,
      minimumPollIntervalMs,
      inactivePollIntervalMs,
      closedPollIntervalMs,
      activeWindowMs,
    ],
  });
  return rows.map(snapshot);
}
export async function listFundingReceiveReceiptsForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; receiveSessionId: string }>,
): Promise<readonly FundingReceiveReceipt[]> {
  const { rows } = await db.query<ReceiveReceiptRow>(
    `
      select
        id,
        receive_session_id,
        user_id,
        variant_id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        raw_amount::text,
        observation_revision,
        tx_hash,
        event_index,
        ledger_height::text,
        block_hash,
        source_address,
        observed_at,
        status,
        handling,
        child_funding_operation_id,
        evidence,
        created_at,
        updated_at
      from funding_receive_receipts
      where receive_session_id = $1
        and user_id = $2
      order by created_at asc
    `,
    [input.receiveSessionId, input.userId],
  );
  return rows.map(publicReceipt);
}

export async function listFundingReceiveRoutingReceiptIdsAfterBroadcastBoundary(
  db: Pick<Pool, "query">,
  input: Readonly<{ userId: string; receiveSessionId: string }>,
): Promise<readonly string[]> {
  const { rows } = await db.query<{ id: string }>(
    `
      select receipt.id
      from funding_receive_receipts receipt
      where receipt.receive_session_id = $1
        and receipt.user_id = $2
        and receipt.status = 'routing'
        and receipt.handling = 'automatic_conversion'
        and receipt.child_funding_operation_id is not null
        and exists (
          select 1
          from funding_operation_steps step
          join funding_operation_step_attempts attempt
            on attempt.step_id = step.id
          where step.operation_id = receipt.child_funding_operation_id
            and attempt.broadcast_may_have_occurred
        )
      order by receipt.created_at asc, receipt.id asc
    `,
    [input.receiveSessionId, input.userId],
  );
  return rows.map((row) => row.id);
}

export async function cancelFundingReceiveSessionForUser(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    ownerChannel: FundingReceiveSessionChannel;
    receiveSessionId: string;
    now: Date;
  }>,
): Promise<FundingReceiveSessionSnapshot | null> {
  const { rows } = await db.query<ReceiveSessionRow>(
    `
      update funding_receive_sessions
      set status = 'cancelled',
          closed_at = $3,
          updated_at = $3,
          version = version + 1
      where id = $1
        and user_id = $2
        and owner_channel = $4
        and status = 'open'
        and not exists (
          select 1
          from funding_receive_receipts receipt
          where receipt.receive_session_id = funding_receive_sessions.id
            and receipt.status <> 'ready'
        )
      returning ${sessionColumns}
    `,
    [input.receiveSessionId, input.userId, input.now, input.ownerChannel],
  );
  return rows[0] ? snapshot(rows[0]) : null;
}

type FundingReceiveCanonicalEventAllocationRow = Readonly<{
  id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  destination_address: string;
  source_address: string | null;
  raw_amount: string;
  tx_hash: string;
  event_index: string;
  ledger_height: string;
  block_hash: string;
  observed_at: Date;
  allocation_status: "pending" | "allocated" | "recovery_required";
  allocated_receive_session_id: string | null;
  allocated_receipt_id: string | null;
  allocation_error_code: string | null;
}>;

export type FundingReceiveCanonicalEventAllocation = Readonly<{
  eventId: string;
  status: "pending" | "allocated" | "recovery_required";
  targetReceiveSessionId: string | null;
  allocatedReceiptId: string | null;
  errorCode: string | null;
}>;

export type RecoverableFundingReceiveCanonicalEvent = Readonly<{
  variantId: string;
  networkId: string;
  asset: AssetRef;
  destinationAddress: string;
  sourceAddress: string | null;
  rawAmount: string;
  transactionHash: string;
  eventIndex: string;
  ledgerHeight: string;
  blockHash: string;
  observedAt: Date;
}>;

/**
 * Returns a bounded backlog of canonical transfers which arrived before an
 * eligible receive session was visible. The chain scanner may already have
 * advanced past these immutable events, so normal rescanning cannot recover
 * them. Only the narrow, ownership-unavailable quarantine is retryable;
 * ambiguous-owner events remain fail-closed for manual recovery.
 */
export async function listRecoverableFundingReceiveCanonicalEvents(
  db: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    now: Date;
    limit?: number;
  }>,
): Promise<readonly RecoverableFundingReceiveCanonicalEvent[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const { rows } = await db.query<{
    variant_id: string;
    network_id: string;
    asset_id: string;
    asset_decimals: number;
    destination_address: string;
    source_address: string | null;
    raw_amount: string;
    tx_hash: string;
    event_index: string;
    ledger_height: string;
    block_hash: string;
    observed_at: Date;
  }>(
    `
      select matched_variant.variant_id,
             canonical_event.network_id,
             canonical_event.asset_id,
             canonical_event.asset_decimals,
             canonical_event.destination_address,
             canonical_event.source_address,
             canonical_event.raw_amount::text,
             canonical_event.tx_hash,
             canonical_event.event_index,
             canonical_event.ledger_height::text,
             canonical_event.block_hash,
             canonical_event.observed_at
      from funding_receive_sessions receive_session
      join funding_receive_canonical_events canonical_event
        on canonical_event.allocation_status = 'recovery_required'
       and canonical_event.allocation_error_code =
             'receive_session_allocation_unavailable'
      cross join lateral (
        select start_variant->>'variantId' as variant_id
        from jsonb_array_elements(
          receive_session.observation_start_variants
        ) start_variant
        where start_variant->>'networkId' = canonical_event.network_id
          and start_variant->'asset'->>'decimals' =
                canonical_event.asset_decimals::text
          and funding_account_identifier_equal(
                canonical_event.network_id,
                start_variant->'asset'->>'assetId',
                canonical_event.asset_id
              )
          and funding_account_identifier_equal(
                canonical_event.network_id,
                start_variant->>'destinationAddress',
                canonical_event.destination_address
              )
          and case
                when coalesce(
                       start_variant->'observation'->'payload'->>
                         'eventCursorBlock',
                       start_variant->'observation'->'payload'->>
                         'eventCursorSlot'
                     ) ~ '^[0-9]+$'
                  then coalesce(
                         start_variant->'observation'->'payload'->>
                           'eventCursorBlock',
                         start_variant->'observation'->'payload'->>
                           'eventCursorSlot'
                       )::numeric
                else null
              end < canonical_event.ledger_height
        order by start_variant->>'variantId'
        limit 1
      ) matched_variant
      where receive_session.id = $1::uuid
        and receive_session.observe_until > $2
      order by canonical_event.first_observed_at, canonical_event.id
      limit $3
    `,
    [input.receiveSessionId, input.now, limit],
  );
  return rows.map((row) => ({
    variantId: row.variant_id,
    networkId: row.network_id,
    asset: {
      networkId: row.network_id,
      assetId: row.asset_id,
      decimals: row.asset_decimals,
    },
    destinationAddress: row.destination_address,
    sourceAddress: row.source_address,
    rawAmount: row.raw_amount,
    transactionHash: row.tx_hash,
    eventIndex: row.event_index,
    ledgerHeight: row.ledger_height,
    blockHash: row.block_hash,
    observedAt: row.observed_at,
  }));
}

/**
 * A historical event can enter the retry backlog before the matching Hunch
 * handoff evidence becomes visible. Once that event is proven internal, keep
 * the immutable evidence for audit but remove it from external-deposit retry.
 */
export async function suppressRecoverableFundingReceiveCanonicalInternalEvent(
  db: Pick<PoolClient, "query">,
  input: Readonly<{
    networkId: string;
    transactionHash: string;
    eventIndex: string;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await db.query(
    `
      update funding_receive_canonical_events
      set allocation_error_code = 'internal_handoff_suppressed',
          last_observed_at = greatest(last_observed_at, $4)
      where network_id = $1
        and tx_hash = $2
        and event_index = $3
        and allocation_status = 'recovery_required'
        and allocation_error_code =
              'receive_session_allocation_unavailable'
    `,
    [input.networkId, input.transactionHash, input.eventIndex, input.now],
  );
  return result.rowCount === 1;
}

function sameCanonicalReceiveValue(
  networkId: string,
  left: string,
  right: string,
): boolean {
  return (
    canonicalAccountAddress(networkId, left) ===
    canonicalAccountAddress(networkId, right)
  );
}

function canonicalStartCursor(
  row: Readonly<{ observationStartVariants: readonly JsonRecord[] }>,
  input: Readonly<{
    networkId: string;
    assetId: string;
    destinationAddress: string;
  }>,
): bigint | null {
  const cursors = row.observationStartVariants.flatMap((raw) => {
    const asset =
      raw.asset && typeof raw.asset === "object" && !Array.isArray(raw.asset)
        ? (raw.asset as JsonRecord)
        : null;
    const observation =
      raw.observation &&
      typeof raw.observation === "object" &&
      !Array.isArray(raw.observation)
        ? (raw.observation as JsonRecord)
        : null;
    const payload =
      observation?.payload &&
      typeof observation.payload === "object" &&
      !Array.isArray(observation.payload)
        ? (observation.payload as JsonRecord)
        : null;
    if (
      raw.networkId !== input.networkId ||
      typeof asset?.assetId !== "string" ||
      typeof raw.destinationAddress !== "string" ||
      !sameCanonicalReceiveValue(
        input.networkId,
        asset.assetId,
        input.assetId,
      ) ||
      !sameCanonicalReceiveValue(
        input.networkId,
        raw.destinationAddress,
        input.destinationAddress,
      )
    ) {
      return [];
    }
    const cursor =
      payload?.eventCursorBlock ?? payload?.eventCursorSlot ?? null;
    return typeof cursor === "string" && /^[0-9]+$/u.test(cursor)
      ? [BigInt(cursor)]
      : [];
  });
  if (cursors.length === 0) return null;
  return cursors.reduce((highest, cursor) =>
    cursor > highest ? cursor : highest,
  );
}

export function selectFundingReceiveCanonicalEventTarget(
  input: Readonly<{
    networkId: string;
    assetId: string;
    destinationAddress: string;
    ledgerHeight: string;
    candidates: readonly Readonly<{
      receiveSessionId: string;
      userId: string;
      openedAt: Date;
      observationStartVariants: readonly JsonRecord[];
    }>[];
  }>,
):
  | Readonly<{ targetReceiveSessionId: string; errorCode: null }>
  | Readonly<{
      targetReceiveSessionId: null;
      errorCode:
        | "receive_session_allocation_unavailable"
        | "ambiguous_receive_session_owner";
    }> {
  const ledgerHeight = BigInt(input.ledgerHeight);
  const candidates = input.candidates.flatMap((candidate) => {
    const cursor = canonicalStartCursor(candidate, input);
    return cursor != null && cursor < ledgerHeight
      ? [{ candidate, cursor }]
      : [];
  });
  const owners = new Set(candidates.map(({ candidate }) => candidate.userId));
  if (candidates.length === 0) {
    return {
      targetReceiveSessionId: null,
      errorCode: "receive_session_allocation_unavailable",
    };
  }
  if (owners.size !== 1) {
    return {
      targetReceiveSessionId: null,
      errorCode: "ambiguous_receive_session_owner",
    };
  }
  candidates.sort((left, right) => {
    if (left.cursor > right.cursor) return -1;
    if (left.cursor < right.cursor) return 1;
    const opened =
      right.candidate.openedAt.getTime() - left.candidate.openedAt.getTime();
    if (opened !== 0) return opened;
    return left.candidate.receiveSessionId.localeCompare(
      right.candidate.receiveSessionId,
    );
  });
  const target = candidates[0];
  if (!target) {
    return {
      targetReceiveSessionId: null,
      errorCode: "receive_session_allocation_unavailable",
    };
  }
  return {
    targetReceiveSessionId: target.candidate.receiveSessionId,
    errorCode: null,
  };
}

function sameCanonicalEventIdentity(
  row: FundingReceiveCanonicalEventAllocationRow,
  input: Readonly<{
    networkId: string;
    asset: AssetRef;
    destinationAddress: string;
    sourceAddress: string | null;
    rawAmount: string;
    transactionHash: string;
    eventIndex: string;
    ledgerHeight: string;
    blockHash: string;
    observedAt: Date;
  }>,
): boolean {
  return (
    row.network_id === input.networkId &&
    sameCanonicalReceiveValue(
      input.networkId,
      row.asset_id,
      input.asset.assetId,
    ) &&
    row.asset_decimals === input.asset.decimals &&
    sameCanonicalReceiveValue(
      input.networkId,
      row.destination_address,
      input.destinationAddress,
    ) &&
    (row.source_address == null && input.sourceAddress == null
      ? true
      : row.source_address != null &&
        input.sourceAddress != null &&
        sameCanonicalReceiveValue(
          input.networkId,
          row.source_address,
          input.sourceAddress,
        )) &&
    row.raw_amount === input.rawAmount &&
    row.tx_hash === input.transactionHash &&
    row.event_index === input.eventIndex &&
    row.ledger_height === input.ledgerHeight &&
    row.block_hash === input.blockHash
  );
}

export async function claimFundingReceiveCanonicalEventAllocation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    networkId: string;
    asset: AssetRef;
    destinationAddress: string;
    sourceAddress: string | null;
    rawAmount: string;
    transactionHash: string;
    eventIndex: string;
    ledgerHeight: string;
    blockHash: string;
    observedAt: Date;
    now: Date;
    /** The observer session attempting to consume a quarantined event. */
    expectedReceiveSessionId?: string;
  }>,
): Promise<FundingReceiveCanonicalEventAllocation> {
  const event = await client.query<FundingReceiveCanonicalEventAllocationRow>(
    `
      insert into funding_receive_canonical_events (
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        source_address,
        raw_amount,
        tx_hash,
        event_index,
        ledger_height,
        block_hash,
        observed_at,
        first_observed_at,
        last_observed_at
      )
      values (
        $1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::numeric, $10, $11,
        $12, $12
      )
      on conflict (network_id, tx_hash, event_index)
      do update set last_observed_at = greatest(
        funding_receive_canonical_events.last_observed_at,
        excluded.last_observed_at
      )
      returning
        id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        source_address,
        raw_amount::text,
        tx_hash,
        event_index,
        ledger_height::text,
        block_hash,
        observed_at,
        allocation_status,
        allocated_receive_session_id,
        allocated_receipt_id,
        allocation_error_code
    `,
    [
      input.networkId,
      input.asset.assetId,
      input.asset.decimals,
      input.destinationAddress,
      input.sourceAddress,
      input.rawAmount,
      input.transactionHash,
      input.eventIndex,
      input.ledgerHeight,
      input.blockHash,
      input.observedAt,
      input.now,
    ],
  );
  const row = event.rows[0];
  if (!row || !sameCanonicalEventIdentity(row, input)) {
    throw new Error("canonical receive event identity collision");
  }
  const retryUnavailableAllocation =
    row.allocation_status === "recovery_required" &&
    row.allocation_error_code === "receive_session_allocation_unavailable";
  if (row.allocation_status !== "pending" && !retryUnavailableAllocation) {
    return {
      eventId: row.id,
      status: row.allocation_status,
      targetReceiveSessionId: row.allocated_receive_session_id,
      allocatedReceiptId: row.allocated_receipt_id,
      errorCode: row.allocation_error_code,
    };
  }

  const sessions = await client.query<ReceiveSessionRow>(
    `
      select ${sessionColumns}
      from funding_receive_sessions
      where observe_until > $1
        and status in (
          'open',
          'processing',
          'review_required',
          'recovery_required',
          'completed',
          'expired',
          'cancelled'
        )
        and exists (
          select 1
          from jsonb_array_elements(observation_start_variants) variant
          where variant->>'networkId' = $2
            and funding_account_identifier_equal(
              $2,
              variant->'asset'->>'assetId',
              $3
            )
            and funding_account_identifier_equal(
              $2,
              variant->>'destinationAddress',
              $4
            )
        )
      order by id
      for update
    `,
    [input.now, input.networkId, input.asset.assetId, input.destinationAddress],
  );
  const selection = selectFundingReceiveCanonicalEventTarget({
    networkId: input.networkId,
    assetId: input.asset.assetId,
    destinationAddress: input.destinationAddress,
    ledgerHeight: input.ledgerHeight,
    candidates: sessions.rows.map((session) => ({
      receiveSessionId: session.id,
      userId: session.user_id,
      openedAt: session.opened_at,
      observationStartVariants: session.observation_start_variants,
    })),
  });
  if (selection.errorCode) {
    await client.query(
      `
        update funding_receive_canonical_events
        set allocation_status = 'recovery_required',
            allocation_error_code = $2,
            last_observed_at = $3
        where id = $1
          and (
            allocation_status = 'pending'
            or (
              allocation_status = 'recovery_required'
              and allocation_error_code =
                    'receive_session_allocation_unavailable'
            )
          )
      `,
      [row.id, selection.errorCode, input.now],
    );
    return {
      eventId: row.id,
      status: "recovery_required",
      targetReceiveSessionId: null,
      allocatedReceiptId: null,
      errorCode: selection.errorCode,
    };
  }
  if (
    retryUnavailableAllocation &&
    selection.targetReceiveSessionId !== input.expectedReceiveSessionId
  ) {
    // More than one historical session can match the same physical address.
    // Keep the event in the bounded retry backlog until the canonical target
    // itself polls; a non-target must never turn it into orphaned `pending`.
    return {
      eventId: row.id,
      status: "recovery_required",
      targetReceiveSessionId: selection.targetReceiveSessionId,
      allocatedReceiptId: null,
      errorCode: row.allocation_error_code,
    };
  }
  if (retryUnavailableAllocation) {
    const retried = await client.query(
      `
        update funding_receive_canonical_events
        set allocation_status = 'pending',
            allocation_error_code = null,
            last_observed_at = $2
        where id = $1
          and allocation_status = 'recovery_required'
          and allocation_error_code =
                'receive_session_allocation_unavailable'
      `,
      [row.id, input.now],
    );
    if (retried.rowCount !== 1) {
      throw new Error("canonical receive event retry state changed");
    }
  }
  return {
    eventId: row.id,
    status: "pending",
    targetReceiveSessionId: selection.targetReceiveSessionId,
    allocatedReceiptId: null,
    errorCode: null,
  };
}

export async function finalizeFundingReceiveCanonicalEventAllocation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    eventId: string;
    receiveSessionId: string;
    receiptId: string;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await client.query(
    `
      update funding_receive_canonical_events
      set allocation_status = 'allocated',
          allocated_receive_session_id = $2,
          allocated_receipt_id = $3,
          allocated_at = $4,
          last_observed_at = $4
      where id = $1
        and allocation_status = 'pending'
    `,
    [input.eventId, input.receiveSessionId, input.receiptId, input.now],
  );
  if (result.rowCount === 1) return true;
  const { rows } = await client.query<{
    allocated_receive_session_id: string | null;
    allocated_receipt_id: string | null;
  }>(
    `
      select allocated_receive_session_id, allocated_receipt_id
      from funding_receive_canonical_events
      where id = $1
        and allocation_status = 'allocated'
      limit 1
    `,
    [input.eventId],
  );
  return (
    rows[0]?.allocated_receive_session_id === input.receiveSessionId &&
    rows[0]?.allocated_receipt_id === input.receiptId
  );
}

export async function insertFundingReceiveReceipt(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    userId: string;
    variantId: string;
    asset: AssetRef;
    destinationAddress: string;
    rawAmount: string;
    observationRevision: string;
    canonicalEvent?: Readonly<{
      transactionHash: string;
      eventIndex: string;
      ledgerHeight: string;
      blockHash: string;
      sourceAddress: string | null;
    }> | null;
    observedAt: Date;
    handling: FundingReceiveReceipt["handling"];
    status: FundingReceiveReceipt["status"];
    evidence: JsonRecord;
    now: Date;
  }>,
): Promise<Readonly<{ receipt: FundingReceiveReceipt; replayed: boolean }>> {
  const { rows } = await client.query<ReceiveReceiptRow>(
    `
      insert into funding_receive_receipts (
        receive_session_id,
        user_id,
        variant_id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        raw_amount,
        observation_revision,
        tx_hash,
        event_index,
        ledger_height,
        block_hash,
        source_address,
        observed_at,
        status,
        handling,
        evidence,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9,
        $10, $11, $12::numeric, $13, $14, $15, $16, $17,
        $18::jsonb, $19, $19
      )
      on conflict do nothing
      returning
        id,
        receive_session_id,
        user_id,
        variant_id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        raw_amount::text,
        observation_revision,
        tx_hash,
        event_index,
        ledger_height::text,
        block_hash,
        source_address,
        observed_at,
        status,
        handling,
        child_funding_operation_id,
        evidence,
        created_at,
        updated_at
    `,
    [
      input.receiveSessionId,
      input.userId,
      input.variantId,
      input.asset.networkId,
      input.asset.assetId,
      input.asset.decimals,
      input.destinationAddress,
      input.rawAmount,
      input.observationRevision,
      input.canonicalEvent?.transactionHash ?? null,
      input.canonicalEvent?.eventIndex ?? null,
      input.canonicalEvent?.ledgerHeight ?? null,
      input.canonicalEvent?.blockHash ?? null,
      input.canonicalEvent?.sourceAddress ?? null,
      input.observedAt,
      input.status,
      input.handling,
      JSON.stringify(input.evidence),
      input.now,
    ],
  );
  const inserted = rows[0];
  if (inserted) {
    return { receipt: publicReceipt(inserted), replayed: false };
  }
  const replay = await client.query<ReceiveReceiptRow>(
    `
      select
        id,
        receive_session_id,
        user_id,
        variant_id,
        network_id,
        asset_id,
        asset_decimals,
        destination_address,
        raw_amount::text,
        observation_revision,
        tx_hash,
        event_index,
        ledger_height::text,
        block_hash,
        source_address,
        observed_at,
        status,
        handling,
        child_funding_operation_id,
        evidence,
        created_at,
        updated_at
      from funding_receive_receipts
      where (
          receive_session_id = $1
          and variant_id = $2
          and observation_revision = $3
        )
        or (
          $4::text is not null
          and network_id = $5
          and tx_hash = $4
          and event_index = $6
        )
      order by created_at asc
      limit 1
    `,
    [
      input.receiveSessionId,
      input.variantId,
      input.observationRevision,
      input.canonicalEvent?.transactionHash ?? null,
      input.asset.networkId,
      input.canonicalEvent?.eventIndex ?? null,
    ],
  );
  const replayed = replay.rows[0];
  if (!replayed) {
    throw new Error("funding receive receipt conflict could not be resolved");
  }
  return { receipt: publicReceipt(replayed), replayed: true };
}

export async function updateFundingReceiveSessionObservation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    expectedVersion: number;
    observationVariants: readonly JsonRecord[];
    status:
      | "open"
      | "processing"
      | "review_required"
      | "recovery_required"
      | "completed";
    lastObservedAt: Date;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await client.query(
    `
      update funding_receive_sessions
      set observation_variants = $3::jsonb,
          status = $4,
          closed_at = case
            when $4 = 'completed' then coalesce(closed_at, $6)
            else closed_at
          end,
          last_observed_at = $5,
          version = version + case
            when observation_variants is distinct from $3::jsonb
              or status is distinct from $4
              then 1
            else 0
          end,
          updated_at = $6
      where id = $1
        and version = $2
        and status in ('open', 'processing', 'review_required', 'recovery_required')
    `,
    [
      input.receiveSessionId,
      input.expectedVersion,
      JSON.stringify(input.observationVariants),
      input.status,
      input.lastObservedAt,
      input.now,
    ],
  );
  return result.rowCount === 1;
}

export async function updateClosedFundingReceiveSessionObservation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    receiveSessionId: string;
    expectedVersion: number;
    observationVariants: readonly JsonRecord[];
    lastObservedAt: Date;
    recoveryRequired: boolean;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await client.query(
    `
      update funding_receive_sessions
      set observation_variants = $3::jsonb,
          status = case when $5 then 'recovery_required' else status end,
          last_observed_at = $4,
          version = version + case
            when observation_variants is distinct from $3::jsonb
              or $5::boolean
              then 1
            else 0
          end,
          updated_at = $6
      where id = $1
        and version = $2
        and status in ('completed', 'expired', 'cancelled')
        and observe_until > $6
    `,
    [
      input.receiveSessionId,
      input.expectedVersion,
      JSON.stringify(input.observationVariants),
      input.lastObservedAt,
      input.recoveryRequired,
      input.now,
    ],
  );
  return result.rowCount === 1;
}

export type FundingReceiveReceiptRoutingTarget = Readonly<{
  receipt: FundingReceiveReceipt;
  receiptDestinationLocationId: string | null;
  receiptVariantSnapshot: JsonRecord | null;
  userId: string;
  ownerChannel: FundingReceiveSessionChannel;
  venueId: string;
  destinationOptionId: string;
  venueBindingOptionId: string;
  destinationAsset: AssetRef;
  destinationTargetSnapshot: JsonRecord;
  venueBindingSnapshot: JsonRecord;
  automationPolicy: FundingReceiveAutomationPolicy;
  policyVersion: number;
  policyRevision: string;
  ownershipRevision: string;
  telegramAccountId: string | null;
  telegramAutomationPolicy: JsonRecord | null;
  telegramFundingAuthorizationId: string | null;
  telegramFundingConsentFingerprint: string | null;
  telegramFundingConsentId: string | null;
  telegramUserId: string | null;
  childExecutorId: string | null;
  childBroadcastMayHaveOccurred: boolean;
  childHasUnfinishedAttempt: boolean;
  routingAttemptCount: number;
  routingDisposition:
    | "pending"
    | "retry_scheduled"
    | "operation_created"
    | "review_required"
    | "recovery_required"
    | "ready";
}>;

export type FundingReceiveReceiptReviewTarget =
  FundingReceiveReceiptRoutingTarget &
    Readonly<{
      reviewQuoteId: string | null;
    }>;

type ReceiveReceiptTargetRow = ReceiveReceiptRow & {
  receipt_destination_location_id: string | null;
  receipt_variant_snapshot: JsonRecord | null;
  venue_id: string;
  destination_option_id: string;
  venue_binding_option_id: string;
  destination_asset: AssetRef;
  destination_target_snapshot: JsonRecord;
  venue_binding_snapshot: JsonRecord;
  automation_policy: FundingReceiveAutomationPolicy;
  policy_version: string | number;
  policy_revision: string;
  ownership_revision: string;
  owner_channel: FundingReceiveSessionChannel;
  telegram_account_id: string | null;
  telegram_automation_policy: JsonRecord | null;
  telegram_funding_authorization_id: string | null;
  telegram_funding_consent_fingerprint: string | null;
  telegram_funding_consent_id: string | null;
  telegram_user_id: string | null;
  child_executor_id: string | null;
  child_broadcast_may_have_occurred: boolean;
  child_has_unfinished_attempt: boolean;
  routing_attempt_count: number;
  routing_disposition: FundingReceiveReceiptRoutingTarget["routingDisposition"];
};

function receiveReceiptRoutingTarget(
  row: ReceiveReceiptTargetRow,
): FundingReceiveReceiptRoutingTarget {
  return {
    receipt: publicReceipt(row),
    receiptDestinationLocationId: row.receipt_destination_location_id,
    receiptVariantSnapshot: row.receipt_variant_snapshot,
    userId: row.user_id,
    ownerChannel: row.owner_channel,
    venueId: row.venue_id,
    destinationOptionId: row.destination_option_id,
    venueBindingOptionId: row.venue_binding_option_id,
    destinationAsset: row.destination_asset,
    destinationTargetSnapshot: row.destination_target_snapshot,
    venueBindingSnapshot: row.venue_binding_snapshot,
    automationPolicy: row.automation_policy,
    policyVersion: Number(row.policy_version),
    policyRevision: row.policy_revision,
    ownershipRevision: row.ownership_revision,
    telegramAccountId: row.telegram_account_id,
    telegramAutomationPolicy: row.telegram_automation_policy,
    telegramFundingAuthorizationId: row.telegram_funding_authorization_id,
    telegramFundingConsentFingerprint: row.telegram_funding_consent_fingerprint,
    telegramFundingConsentId: row.telegram_funding_consent_id,
    telegramUserId: row.telegram_user_id,
    childExecutorId: row.child_executor_id,
    childBroadcastMayHaveOccurred: row.child_broadcast_may_have_occurred,
    childHasUnfinishedAttempt: row.child_has_unfinished_attempt,
    routingAttemptCount: row.routing_attempt_count,
    routingDisposition: row.routing_disposition,
  };
}

export async function listFundingReceiveReceiptsForRouting(
  db: Pick<Pool, "query">,
  input: Readonly<{ limit: number; now?: Date }>,
): Promise<readonly FundingReceiveReceiptRoutingTarget[]> {
  const { rows } = await db.query<ReceiveReceiptTargetRow>({
    name: "funding-receive-list-routing-receipts-v1",
    text: `
      select
        receipt.id,
        receipt.receive_session_id,
        receipt.user_id,
        receipt.variant_id,
        receipt.network_id,
        receipt.asset_id,
        receipt.asset_decimals,
        receipt.destination_address,
        receipt.raw_amount::text,
        receipt.observation_revision,
        receipt.tx_hash,
        receipt.event_index,
        receipt.ledger_height::text,
        receipt.block_hash,
        receipt.source_address,
        receipt.observed_at,
        receipt.status,
        receipt.handling,
        receipt.child_funding_operation_id,
        receipt.routing_attempt_count,
        receipt.routing_disposition,
        receipt.evidence,
        receipt.created_at,
        receipt.updated_at,
        (
          select variant ->> 'destinationLocationId'
          from jsonb_array_elements(session.observation_variants) variant
          where variant ->> 'variantId' = receipt.variant_id
          limit 1
        ) as receipt_destination_location_id,
        (
          select variant
          from jsonb_array_elements(session.observation_variants) variant
          where variant ->> 'variantId' = receipt.variant_id
          limit 1
        ) as receipt_variant_snapshot,
        session.venue_id,
        session.owner_channel,
        session.destination_option_id,
        session.venue_binding_option_id,
        session.destination_asset,
        session.destination_target_snapshot,
        session.venue_binding_snapshot,
        session.automation_policy,
        session.policy_version,
        session.policy_revision,
        session.ownership_revision,
        telegram_context.telegram_account_id,
        telegram_context.telegram_user_id,
        telegram_consent.automation_policy_snapshot as telegram_automation_policy,
        telegram_consent.automation_policy_snapshot ->> 'authorizationId'
          as telegram_funding_authorization_id,
        telegram_consent.id as telegram_funding_consent_id,
        telegram_consent.consent_fingerprint
          as telegram_funding_consent_fingerprint,
        (
          select child_step.executor_id
          from funding_operation_steps child_step
          where child_step.operation_id = operation.id
            and child_step.executor_id is not null
          order by child_step.ordinal asc
          limit 1
        ) as child_executor_id,
        exists (
          select 1
          from funding_operation_steps child_step
          join funding_operation_step_attempts child_attempt
            on child_attempt.step_id = child_step.id
          where child_step.operation_id = operation.id
            and child_attempt.broadcast_may_have_occurred
        ) as child_broadcast_may_have_occurred,
        exists (
          select 1
          from funding_operation_steps child_step
          join funding_operation_step_attempts child_attempt
            on child_attempt.step_id = child_step.id
          where child_step.operation_id = operation.id
            and child_attempt.outcome = 'started'
        ) as child_has_unfinished_attempt
      from funding_receive_receipts receipt
      join funding_receive_sessions session
        on session.id = receipt.receive_session_id
      left join telegram_funding_sessions telegram_context
        on telegram_context.receive_session_id = session.id
       and telegram_context.user_id = session.user_id
      left join funding_receive_canonical_events canonical_event
        on canonical_event.allocated_receipt_id = receipt.id
       and canonical_event.allocated_receive_session_id = session.id
       and canonical_event.allocation_status = 'allocated'
      left join lateral (
        select consent.*
        from telegram_funding_consents consent
        where consent.telegram_funding_session_id = telegram_context.id
          and consent.consented_at <= canonical_event.first_observed_at
          and jsonb_typeof(
                consent.automation_policy_snapshot -> 'presentation'
              ) = 'object'
          and receipt.variant_id = any(consent.consented_variant_ids)
          and (
            receipt.handling = 'review_required'
            or (
              consent.automation_enabled
              and (
                (
                  consent.max_auto_execute_source_raw is null
                  and consent.automation_policy_snapshot ->> 'version' = '2'
                  and consent.automation_policy_snapshot ->> 'fullReceipt' = 'true'
                )
                or (
                  consent.max_auto_execute_source_raw > 0
                  and consent.automation_policy_snapshot ->> 'version' = '3'
                  and consent.automation_policy_snapshot ->> 'fullReceipt' = 'false'
                  and receipt.raw_amount <= consent.max_auto_execute_source_raw
                )
              )
              and receipt.ledger_height is not null
              and receipt.network_id =
                    consent.automation_policy_snapshot #>> '{sourceAsset,networkId}'
              and receipt.asset_decimals::text =
                    consent.automation_policy_snapshot #>> '{sourceAsset,decimals}'
              and funding_account_identifier_equal(
                receipt.network_id,
                receipt.asset_id,
                consent.automation_policy_snapshot #>>
                  '{sourceAsset,assetId}'
              )
              and exists (
                select 1
                from jsonb_array_elements(
                  case
                    when jsonb_typeof(
                      consent.automation_policy_snapshot -> 'variantCursors'
                    ) = 'array'
                      then consent.automation_policy_snapshot -> 'variantCursors'
                    else '[]'::jsonb
                  end
                ) cursor
                where cursor ->> 'variantId' = receipt.variant_id
                  and cursor ->> 'networkId' = receipt.network_id
                  and cursor ->> 'ledgerHeightExclusive' ~ '^(0|[1-9][0-9]*)$'
                  and receipt.ledger_height >
                        (cursor ->> 'ledgerHeightExclusive')::numeric
              )
            )
          )
        order by consent.consented_at desc, consent.revision desc
        limit 1
      ) telegram_consent on true
      left join funding_operations operation
        on operation.id = receipt.child_funding_operation_id
      where (
          receipt.status = 'observed'
          and receipt.handling = 'automatic_conversion'
          and receipt.child_funding_operation_id is null
          and receipt.routing_next_attempt_at <= $2
          and (
            (
              session.owner_channel = 'web'
              and session.selected_receive_target_id is not null
            )
            or (
              session.owner_channel = 'telegram'
              and telegram_context.id is not null
              and receipt.observed_at <= telegram_context.expires_at
              and (
                telegram_context.cancelled_at is null
                or receipt.observed_at <= telegram_context.cancelled_at
              )
              and telegram_consent.id is not null
            )
          )
        )
        or (
          receipt.status = 'review_required'
          and receipt.handling in ('review_required', 'automatic_conversion')
          and receipt.child_funding_operation_id is null
          and not funding_receive_review_evidence_is_valid(receipt.evidence)
          and (
            (
              session.owner_channel = 'web'
              and session.selected_receive_target_id is not null
            )
            or (
              session.owner_channel = 'telegram'
              and telegram_context.id is not null
              and receipt.observed_at <= telegram_context.expires_at
              and (
                telegram_context.cancelled_at is null
                or receipt.observed_at <= telegram_context.cancelled_at
              )
              and telegram_consent.id is not null
            )
          )
        )
        or (
          receipt.status = 'routing'
          and receipt.child_funding_operation_id is not null
        )
      order by receipt.created_at asc
      limit $1
    `,
    values: [input.limit, input.now ?? new Date()],
  });
  return rows.map(receiveReceiptRoutingTarget);
}

export async function recordFundingReceiveReceiptRoutingDisposition(
  db: Pool,
  input: Readonly<{
    receiptId: string;
    receiveSessionId: string;
    userId: string;
    disposition: "retry_scheduled" | "review_required" | "recovery_required";
    errorCode: string;
    reviewContinuation?: FundingReceiveReviewContinuation;
    reviewQuotePlan?: FundingReceiveQuotePlan;
    retryAt?: Date | null;
    now: Date;
  }>,
): Promise<boolean> {
  if (
    input.disposition === "review_required" &&
    (!input.reviewContinuation || !input.reviewQuotePlan)
  ) {
    throw new Error(
      "review-required receive routing needs adapter continuation and quote plan",
    );
  }
  return tx(db, async (client) => {
    const nextStatus =
      input.disposition === "review_required"
        ? "review_required"
        : input.disposition === "recovery_required"
          ? "recovery_required"
          : "observed";
    const receipt = await client.query(
      `
        update funding_receive_receipts
        set status = $4,
            routing_disposition = $5,
            routing_attempt_count = routing_attempt_count + 1,
            routing_next_attempt_at = coalesce($6, routing_next_attempt_at),
            routing_last_attempt_at = $7,
            routing_last_error_code = $8,
            evidence = case
              when $9::jsonb is null or $10::jsonb is null then evidence
              else jsonb_set(
                jsonb_set(evidence, '{reviewContinuation}', $9::jsonb, true),
                '{reviewQuotePlan}',
                $10::jsonb,
                true
              )
            end,
            updated_at = $7
        where id = $1
          and receive_session_id = $2
          and user_id = $3
          and (
            (status = 'observed' and handling = 'automatic_conversion')
            or (
              status = 'review_required'
              and handling in ('review_required', 'automatic_conversion')
              and not funding_receive_review_evidence_is_valid(evidence)
              and $5 in ('review_required', 'recovery_required')
            )
          )
          and child_funding_operation_id is null
      `,
      [
        input.receiptId,
        input.receiveSessionId,
        input.userId,
        nextStatus,
        input.disposition,
        input.retryAt ?? null,
        input.now,
        input.errorCode,
        input.reviewContinuation
          ? JSON.stringify(input.reviewContinuation)
          : null,
        input.reviewQuotePlan ? JSON.stringify(input.reviewQuotePlan) : null,
      ],
    );
    if (receipt.rowCount !== 1) return false;
    if (nextStatus !== "observed") {
      await refreshFundingReceiveSessionStatus(client, input);
    }
    return true;
  });
}

/**
 * A prior operation on the same venue binding is ordinary serialization, not
 * a failed routing attempt. Defer without consuming the receipt retry budget.
 */
export async function deferFundingReceiveReceiptRouting(
  db: Pick<Pool, "query">,
  input: Readonly<{
    receiptId: string;
    userId: string;
    retryAt: Date;
    errorCode: string;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `
      with deferred as (
        update funding_receive_receipts
        set routing_disposition = 'retry_scheduled',
            routing_next_attempt_at = $3,
            routing_last_attempt_at = $4,
            routing_last_error_code = $5,
            updated_at = $4
        where id = $1
          and user_id = $2
          and status = 'observed'
          and handling = 'automatic_conversion'
          and child_funding_operation_id is null
        returning receive_session_id
      )
      update funding_receive_sessions session
      set version = session.version + 1,
          updated_at = $4
      from deferred
      where session.id = deferred.receive_session_id
        and session.user_id = $2
      returning session.id
    `,
    [input.receiptId, input.userId, input.retryAt, input.now, input.errorCode],
  );
  return result.rowCount === 1;
}

export async function fetchFundingReceiveReceiptForReview(
  db: Pick<Pool, "query">,
  input: Readonly<{
    userId: string;
    ownerChannel: FundingReceiveSessionChannel;
    receiveSessionId: string;
    receiptId: string;
    lock?: boolean;
  }>,
): Promise<FundingReceiveReceiptReviewTarget | null> {
  const { rows } = await db.query<
    ReceiveReceiptTargetRow & { review_quote_id: string | null }
  >(
    `
      select
        receipt.id,
        receipt.receive_session_id,
        receipt.user_id,
        receipt.variant_id,
        receipt.network_id,
        receipt.asset_id,
        receipt.asset_decimals,
        receipt.destination_address,
        receipt.raw_amount::text,
        receipt.observation_revision,
        receipt.tx_hash,
        receipt.event_index,
        receipt.ledger_height::text,
        receipt.block_hash,
        receipt.source_address,
        receipt.observed_at,
        receipt.status,
        receipt.handling,
        receipt.child_funding_operation_id,
        receipt.review_quote_id,
        receipt.routing_attempt_count,
        receipt.routing_disposition,
        receipt.evidence,
        receipt.created_at,
        receipt.updated_at,
        (
          select variant ->> 'destinationLocationId'
          from jsonb_array_elements(session.observation_variants) variant
          where variant ->> 'variantId' = receipt.variant_id
          limit 1
        ) as receipt_destination_location_id,
        (
          select variant
          from jsonb_array_elements(session.observation_variants) variant
          where variant ->> 'variantId' = receipt.variant_id
          limit 1
        ) as receipt_variant_snapshot,
        session.venue_id,
        session.owner_channel,
        session.destination_option_id,
        session.venue_binding_option_id,
        session.destination_asset,
        session.destination_target_snapshot,
        session.venue_binding_snapshot,
        session.automation_policy,
        session.policy_version,
        session.policy_revision,
        session.ownership_revision,
        null::uuid as telegram_account_id,
        null::text as telegram_user_id,
        null::jsonb as telegram_automation_policy,
        null::uuid as telegram_funding_authorization_id,
        null::uuid as telegram_funding_consent_id,
        null::text as telegram_funding_consent_fingerprint,
        (
          select child_step.executor_id
          from funding_operation_steps child_step
          where child_step.operation_id = operation.id
            and child_step.executor_id is not null
          order by child_step.ordinal asc
          limit 1
        ) as child_executor_id,
        exists (
          select 1
          from funding_operation_steps child_step
          join funding_operation_step_attempts child_attempt
            on child_attempt.step_id = child_step.id
          where child_step.operation_id = operation.id
            and child_attempt.broadcast_may_have_occurred
        ) as child_broadcast_may_have_occurred,
        exists (
          select 1
          from funding_operation_steps child_step
          join funding_operation_step_attempts child_attempt
            on child_attempt.step_id = child_step.id
          where child_step.operation_id = operation.id
            and child_attempt.outcome = 'started'
        ) as child_has_unfinished_attempt
      from funding_receive_receipts receipt
      join funding_receive_sessions session
        on session.id = receipt.receive_session_id
      left join funding_operations operation
        on operation.id = receipt.child_funding_operation_id
      where receipt.id = $1
        and receipt.receive_session_id = $2
        and receipt.user_id = $3
        and session.owner_channel = $4
        and receipt.handling in ('review_required', 'automatic_conversion')
        and receipt.status in ('review_required', 'routing')
      ${input.lock ? "for update of receipt" : ""}
      limit 1
    `,
    [input.receiptId, input.receiveSessionId, input.userId, input.ownerChannel],
  );
  const row = rows[0];
  return row
    ? {
        ...receiveReceiptRoutingTarget(row),
        reviewQuoteId: row.review_quote_id,
      }
    : null;
}

export async function setFundingReceiveReceiptReviewQuote(
  db: Pick<Pool, "query">,
  input: Readonly<{
    receiptId: string;
    userId: string;
    quoteId: string;
    previousQuoteId: string | null;
    now: Date;
  }>,
): Promise<boolean> {
  const result = await db.query(
    `
      update funding_receive_receipts
      set review_quote_id = $3,
          updated_at = $4
      where id = $1
        and user_id = $2
        and status = 'review_required'
        and handling in ('review_required', 'automatic_conversion')
        and child_funding_operation_id is null
        and review_quote_id is not distinct from $5::uuid
    `,
    [
      input.receiptId,
      input.userId,
      input.quoteId,
      input.now,
      input.previousQuoteId,
    ],
  );
  if (
    result.rowCount === 1 &&
    input.previousQuoteId &&
    input.previousQuoteId !== input.quoteId
  ) {
    await db.query(
      `update funding_quotes
          set invalidated_at = $3,
              invalidation_reason = 'receive_review_replaced'
        where user_id = $1
          and id = $2
          and consumed_at is null
          and invalidated_at is null`,
      [input.userId, input.previousQuoteId, input.now],
    );
  }
  return result.rowCount === 1;
}

export async function linkFundingReceiveReceiptReviewOperationInTransaction(
  client: PoolClient,
  input: Readonly<{
    receiptId: string;
    receiveSessionId: string;
    userId: string;
    quoteId: string;
    childFundingOperationId: string;
    now: Date;
  }>,
): Promise<boolean> {
  const receipt = await client.query(
    `
      update funding_receive_receipts
      set status = 'routing',
          child_funding_operation_id = $5,
          routing_disposition = 'operation_created',
          routing_last_attempt_at = $6,
          routing_last_error_code = null,
          updated_at = $6
      where id = $1
        and receive_session_id = $2
        and user_id = $3
        and review_quote_id = $4
        and status = 'review_required'
        and handling in ('review_required', 'automatic_conversion')
        and child_funding_operation_id is null
    `,
    [
      input.receiptId,
      input.receiveSessionId,
      input.userId,
      input.quoteId,
      input.childFundingOperationId,
      input.now,
    ],
  );
  if (receipt.rowCount !== 1) return false;
  await refreshFundingReceiveSessionStatus(client, input);
  return true;
}

type FundingReceiveReceiptOperationLinkInput = Readonly<{
  authorizationFingerprint?: string;
  authorizationId?: string;
  telegramFundingConsentFingerprint?: string;
  telegramFundingConsentId?: string;
  serverExecutionProfileId?: string;
  receiptId: string;
  userId: string;
  childFundingOperationId: string;
  now: Date;
}>;

export async function claimFundingReceiveReceiptOperationLinkInTransaction(
  client: PoolClient,
  input: Readonly<{ receiptId: string; userId: string }>,
): Promise<boolean> {
  const result = await client.query(
    `
      select 1
      from funding_receive_receipts
      where id = $1
        and user_id = $2
        and status = 'observed'
        and handling = 'automatic_conversion'
        and child_funding_operation_id is null
      for update
    `,
    [input.receiptId, input.userId],
  );
  return result.rowCount === 1;
}

/**
 * Returns a stable key for the next child operation generation of one receipt.
 * The initial operation retains the legacy key. A terminal child that was
 * explicitly detached can then be retried without replaying that child, while
 * every commit inside the same generation remains idempotent.
 *
 * Callers that commit an operation must compute (or recheck) this while holding
 * the receipt row lock acquired by claimFundingReceiveReceiptOperationLinkInTransaction.
 */
export async function fundingReceiveReceiptOperationIdempotencyKey(
  db: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  input: Readonly<{ receiptId: string; userId: string }>,
): Promise<string> {
  const baseKey = `receive-receipt:${input.receiptId}`;
  const { rows } = await db.query<{ next_generation: string }>(
    `select (
              coalesce(
                max(
                  case
                    when operation_row.idempotency_key = $3 then 0::numeric
                    when split_part(
                           operation_row.idempotency_key,
                           ':retry:',
                           2
                         ) ~ '^[1-9][0-9]*$'
                      then split_part(
                             operation_row.idempotency_key,
                             ':retry:',
                             2
                           )::numeric
                    when operation_row.support_metadata ->>
                           'fundingReceiveReceiptId' = $2
                      then 0::numeric
                    else null
                  end
                ),
                -1::numeric
              ) + 1::numeric
            )::text as next_generation
       from funding_operations operation_row
      where operation_row.user_id = $1
        and (
          operation_row.support_metadata ->> 'fundingReceiveReceiptId' = $2
          or operation_row.idempotency_key = $3
          or operation_row.idempotency_key like $3 || ':retry:%'
        )`,
    [input.userId, input.receiptId, baseKey],
  );
  const generationRaw = rows[0]?.next_generation;
  if (!generationRaw || !/^(0|[1-9][0-9]*)$/.test(generationRaw)) {
    throw new Error("funding receive receipt operation generation is invalid");
  }
  const generation = BigInt(generationRaw);
  return generation === 0n ? baseKey : `${baseKey}:retry:${generationRaw}`;
}

export async function linkFundingReceiveReceiptOperationInTransaction(
  client: PoolClient,
  input: FundingReceiveReceiptOperationLinkInput,
): Promise<boolean> {
  const result = await client.query<{
    asset_decimals: number;
    asset_id: string;
    block_hash: string | null;
    destination_address: string;
    event_index: string | null;
    ledger_height: string | null;
    network_id: string;
    observed_at: Date;
    raw_amount: string;
    receive_session_id: string;
    source_address: string | null;
    tx_hash: string | null;
    variant_id: string;
  }>(
    `
        update funding_receive_receipts
        set status = 'routing',
            child_funding_operation_id = $3,
            routing_disposition = 'operation_created',
            routing_last_attempt_at = $4,
            routing_last_error_code = null,
            updated_at = $4
        where id = $1
          and user_id = $2
          and status = 'observed'
          and child_funding_operation_id is null
        returning
          asset_decimals,
          asset_id,
          block_hash,
          destination_address,
          event_index,
          ledger_height::text,
          network_id,
          observed_at,
          raw_amount::text,
          receive_session_id,
          source_address,
          tx_hash,
          variant_id
      `,
    [input.receiptId, input.userId, input.childFundingOperationId, input.now],
  );
  const receipt = result.rows[0];
  if (!receipt) return false;
  const receiveSessionId = receipt.receive_session_id;
  if (!input.authorizationId || !input.authorizationFingerprint) {
    await refreshFundingReceiveSessionStatus(client, {
      receiveSessionId,
      userId: input.userId,
      now: input.now,
    });
    return true;
  }
  if (
    !input.telegramFundingConsentId ||
    !input.telegramFundingConsentFingerprint ||
    !input.serverExecutionProfileId
  ) {
    throw new Error("automatic funding operation is missing consent evidence");
  }
  const operation = await client.query<{
    segment_id: string | null;
    step_id: string;
  }>(
    `
        select step.id as step_id, step.segment_id
        from funding_operations operation
        join funding_operation_steps step
          on step.operation_id = operation.id
         and step.ordinal = 0
        join funding_receive_receipts linked_receipt
          on linked_receipt.id = $5
         and linked_receipt.receive_session_id = $6
         and linked_receipt.user_id = operation.user_id
         and linked_receipt.child_funding_operation_id = operation.id
        where operation.id = $1
          and operation.user_id = $2
          and operation.requested_source_amount ->> 'raw' = $3
          and step.executor_id = $4
        for update of operation, step
      `,
    [
      input.childFundingOperationId,
      input.userId,
      receipt.raw_amount,
      input.serverExecutionProfileId,
      input.receiptId,
      receiveSessionId,
    ],
  );
  const stepId = operation.rows[0]?.step_id;
  const segmentId = operation.rows[0]?.segment_id ?? null;
  if (!stepId || !receipt.tx_hash || !receipt.event_index) {
    throw new Error(
      "automatic funding operation is not bound to exact receipt evidence",
    );
  }
  await client.query(
    `
        update funding_operations
        set support_metadata = support_metadata || jsonb_build_object(
              'fundingAuthorizationId', $3::text,
              'fundingAuthorizationFingerprint', $4::text,
              'fundingReceiveReceiptId', $5::text,
              'telegramFundingConsentId', $6::text,
              'telegramFundingConsentFingerprint', $7::text
            ),
            updated_at = $8,
            version = version + 1
        where id = $1
          and user_id = $2
      `,
    [
      input.childFundingOperationId,
      input.userId,
      input.authorizationId,
      input.authorizationFingerprint,
      input.receiptId,
      input.telegramFundingConsentId,
      input.telegramFundingConsentFingerprint,
      input.now,
    ],
  );
  // Acquire the durable scope fence in its own statement. A waiter then starts
  // the cap-sum statement with a fresh READ COMMITTED snapshot that includes
  // the preceding generation's committed reservation.
  await lockFundingAuthorizationReservationScope(client, {
    authorizationId: input.authorizationId,
    userId: input.userId,
  });
  const capReservation = await client.query<{
    authority_exists: boolean;
    requires_reservation: boolean;
    reserved: boolean;
  }>(
    `with authority as materialized (
       select id, user_id, wallet_chain, wallet_address,
              security_class, max_source_raw
       from telegram_funding_authorizations
       where id = $1::uuid
         and user_id = $2::uuid
       for update
     ), inserted as (
       insert into telegram_funding_authorization_reservations (
         authorization_id,
         receive_receipt_id,
         funding_operation_id,
         source_raw,
         status,
         reserved_at
       )
       select authority.id, $3::uuid, $4::uuid, $5::numeric,
              'reserved', clock_timestamp()
       from authority
       where authority.security_class = 'routed_value_movement'
         and authority.max_source_raw is not null
         and $5::numeric <= authority.max_source_raw
         and $5::numeric + coalesce((
           select sum(receipt_charge.source_raw)
           from (
             select reservation.receive_receipt_id,
                    max(reservation.source_raw) as source_raw
             from telegram_funding_authorization_reservations reservation
             join telegram_funding_authorizations prior_authority
               on prior_authority.id = reservation.authorization_id
             where prior_authority.user_id = authority.user_id
               and lower(prior_authority.wallet_address) =
                     lower(authority.wallet_address)
               and prior_authority.wallet_chain = authority.wallet_chain
               and prior_authority.security_class = 'routed_value_movement'
               and reservation.status <> 'released'
               and reservation.receive_receipt_id <> $3::uuid
               and reservation.reserved_at >=
                     $6::timestamptz - interval '24 hours'
             group by reservation.receive_receipt_id
           ) receipt_charge
         ), 0) <= authority.max_source_raw
       on conflict (funding_operation_id) do nothing
       returning id
     )
     select
       exists(select 1 from authority) as authority_exists,
       coalesce((select security_class = 'routed_value_movement' from authority), false)
         as requires_reservation,
       exists(select 1 from inserted)
         or exists(
           select 1
           from telegram_funding_authorization_reservations
           where receive_receipt_id = $3::uuid
             and authorization_id = $1::uuid
             and funding_operation_id = $4::uuid
             and source_raw = $5::numeric
         ) as reserved`,
    [
      input.authorizationId,
      input.userId,
      input.receiptId,
      input.childFundingOperationId,
      receipt.raw_amount,
      input.now,
    ],
  );
  if (
    !capReservation.rows[0]?.authority_exists ||
    (capReservation.rows[0]?.requires_reservation &&
      !capReservation.rows[0]?.reserved)
  ) {
    throw new Error("routed funding authorization cap is unavailable");
  }
  const priorSourceCredit = await client.query<{
    id: string;
    operation_id: string;
    segment_id: string | null;
  }>(
    `select observation.id, observation.operation_id, observation.segment_id
       from funding_observations observation
      where observation.network_id = $1
        and observation.tx_hash = $2
        and observation.event_index = $3
      for update`,
    [receipt.network_id, receipt.tx_hash, receipt.event_index],
  );
  const existingSourceCredit = priorSourceCredit.rows[0];
  if (!existingSourceCredit) {
    await allocateFundingObservationInTransaction(client, {
      operationId: input.childFundingOperationId,
      segmentId,
      kind: "source_credit",
      networkId: receipt.network_id,
      assetId: receipt.asset_id,
      assetDecimals: receipt.asset_decimals,
      txHash: receipt.tx_hash,
      eventIndex: receipt.event_index,
      fromAddress: receipt.source_address,
      toAddress: receipt.destination_address,
      rawAmount: receipt.raw_amount,
      observedAt: receipt.observed_at,
      ledgerHeight: receipt.ledger_height,
      blockHash: receipt.block_hash,
      finalityStatus: "finalized",
      finalizedAt: input.now,
      metadata: {
        receiveSessionId,
        receiptId: input.receiptId,
        variantId: receipt.variant_id,
      },
    });
  } else if (
    existingSourceCredit.operation_id !== input.childFundingOperationId
  ) {
    const reallocated = await client.query(
      `update funding_observations observation
          set operation_id = $2::uuid,
              segment_id = $3::uuid,
              metadata = jsonb_set(
                observation.metadata,
                '{receiveReceiptAllocationHistory}',
                (
                  case
                    when jsonb_typeof(
                           observation.metadata ->
                           'receiveReceiptAllocationHistory'
                         ) = 'array'
                      then observation.metadata ->
                           'receiveReceiptAllocationHistory'
                    else '[]'::jsonb
                  end
                ) || jsonb_build_array(jsonb_build_object(
                  'previousOperationId', observation.operation_id::text,
                  'previousSegmentId', observation.segment_id::text,
                  'nextOperationId', $2::text,
                  'reallocatedAt', $4::timestamptz
                )),
                true
              )
        where observation.id = $1::uuid
          and observation.operation_id = $5::uuid
          and observation.kind = 'source_credit'
          and observation.network_id = $6
          and (
            (
              observation.network_id like 'evm:%'
              and lower(observation.asset_id) = lower($7)
            )
            or (
              observation.network_id not like 'evm:%'
              and observation.asset_id = $7
            )
          )
          and observation.asset_decimals = $8
          and observation.tx_hash = $9
          and observation.event_index = $10
          and (
            (
              observation.network_id like 'evm:%'
              and lower(observation.from_address) is not distinct from
                    lower($11)
            )
            or (
              observation.network_id not like 'evm:%'
              and observation.from_address is not distinct from $11
            )
          )
          and (
            (
              observation.network_id like 'evm:%'
              and lower(observation.to_address) = lower($12)
            )
            or (
              observation.network_id not like 'evm:%'
              and observation.to_address = $12
            )
          )
          and observation.raw_amount = $13
          and observation.observed_at = $14::timestamptz
          and observation.ledger_height is not distinct from $15
          and observation.block_hash is not distinct from $16
          and observation.finality_status = 'finalized'
          and observation.canonical
          and observation.metadata ->> 'receiveSessionId' = $17::text
          and observation.metadata ->> 'receiptId' = $18::text`,
      [
        existingSourceCredit.id,
        input.childFundingOperationId,
        segmentId,
        input.now,
        existingSourceCredit.operation_id,
        receipt.network_id,
        receipt.asset_id,
        receipt.asset_decimals,
        receipt.tx_hash,
        receipt.event_index,
        receipt.source_address,
        receipt.destination_address,
        receipt.raw_amount,
        receipt.observed_at,
        receipt.ledger_height,
        receipt.block_hash,
        receiveSessionId,
        input.receiptId,
      ],
    );
    if (reallocated.rowCount !== 1) {
      throw new Error("funding receive source credit cannot be reallocated");
    }
  }
  // A finalized source-credit is the only ingress fact that unlocks this
  // deferred action. Materialize every action cache from the common projector
  // rather than inventing a receive-specific `planned -> action_required`
  // transition here.
  await reduceFundingOperationInTransaction(client, {
    operationId: input.childFundingOperationId,
    now: input.now,
  });
  await refreshFundingReceiveSessionStatus(client, {
    receiveSessionId,
    userId: input.userId,
    now: input.now,
  });
  return true;
}

export async function linkFundingReceiveReceiptOperation(
  db: Pool,
  input: FundingReceiveReceiptOperationLinkInput,
): Promise<boolean> {
  return tx(db, (client) =>
    linkFundingReceiveReceiptOperationInTransaction(client, input),
  );
}

export async function settleFundingReceiveReceiptRouting(
  db: Pool,
  input: Readonly<{
    receiptId: string;
    receiveSessionId: string;
    userId: string;
    childOperationId?: string | null;
    childOperationStatus?: string | null;
    status: "ready" | "review_required" | "recovery_required";
    continuation?: FundingReceiveReviewContinuation;
    quotePlan?: FundingReceiveQuotePlan;
    now: Date;
  }>,
): Promise<boolean> {
  if (
    input.status === "review_required" &&
    (!input.childOperationId ||
      !input.childOperationStatus ||
      !input.continuation ||
      !input.quotePlan)
  ) {
    throw new Error(
      "retryable receive routing requires child and adapter review evidence",
    );
  }
  return tx(db, async (client) => {
    const receipt = await client.query(
      `
        update funding_receive_receipts
        set status = $4,
            routing_disposition = case
              when $4 = 'ready' then 'ready'
              when $4 = 'review_required' then 'review_required'
              else 'recovery_required'
            end,
            routing_last_error_code = case
              when $4 = 'ready' then null
              when $4 = 'review_required'
                then 'child_operation_failed_before_broadcast'
              else coalesce(routing_last_error_code, 'child_operation_failed')
            end,
            review_quote_id = case
              when $4 = 'review_required' then null
              else review_quote_id
            end,
            child_funding_operation_id = case
              when $4 = 'review_required' then null
              else child_funding_operation_id
            end,
            evidence = case
              when $4 = 'review_required' then jsonb_set(
                jsonb_set(
                  jsonb_set(
                    evidence,
                    '{routingOperationHistory}',
                    (
                      case
                        when jsonb_typeof(evidence -> 'routingOperationHistory') = 'array'
                          then evidence -> 'routingOperationHistory'
                        else '[]'::jsonb
                      end
                    ) || jsonb_build_array(
                      jsonb_build_object(
                        'operationId', $6::text,
                        'outcome', $7::text,
                        'detachedAt', $5::timestamptz
                      )
                    ),
                    true
                  ),
                  '{reviewContinuation}',
                  $8::jsonb,
                  true
                ),
                '{reviewQuotePlan}',
                $9::jsonb,
                true
              )
              else evidence
            end,
            updated_at = $5::timestamptz
        where id = $1
          and receive_session_id = $2
          and user_id = $3
          and status = 'routing'
          and ($6::uuid is null or child_funding_operation_id = $6)
      `,
      [
        input.receiptId,
        input.receiveSessionId,
        input.userId,
        input.status,
        input.now,
        input.childOperationId ?? null,
        input.childOperationStatus ?? null,
        input.continuation ? JSON.stringify(input.continuation) : null,
        input.quotePlan ? JSON.stringify(input.quotePlan) : null,
      ],
    );
    if (receipt.rowCount !== 1) return false;
    await refreshFundingReceiveSessionStatus(client, input);
    return true;
  });
}
