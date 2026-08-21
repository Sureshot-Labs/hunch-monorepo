import crypto from "node:crypto";

import { tx, type Pool, type PoolClient } from "@hunch/infra";

import {
  canonicalJsonHash,
  hashOpaqueToken,
} from "../funding/persistence/canonical.js";
import type { JsonObject } from "../funding/domain/types.js";

/**
 * Opaque token for the sealed Telegram → Mini App *trade* handoff. It conveys
 * consent for a fingerprinted intent; it is unrelated to a funding action
 * whose kind is `external_handoff`.
 */
export const TELEGRAM_APP_HANDOFF_TOKEN_PREFIX = "th1_";
export const TELEGRAM_APP_HANDOFF_START_PARAM_PREFIX = "handoff_";
const TELEGRAM_APP_HANDOFF_TOKEN_RE = /^th1_[A-Za-z0-9_-]{43}$/;
const TELEGRAM_APP_HANDOFF_TTL_MS = 10 * 60 * 1_000;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Lifecycle of the sealed trade handoff itself, not of its funding operation:
 * issued = bot created it; claimed = the bound Mini App user opened it;
 * committed = exact plan accepted for execution; cancelled/expired are final
 * pre-commit exits. Funding and trade state continue in their own records.
 */
export type TelegramAppHandoffState =
  | "issued"
  | "claimed"
  | "committed"
  | "cancelled"
  | "expired";

type TelegramAppHandoffRow = {
  authority_fingerprint: string;
  cancelled_at: Date | null;
  claimed_at: Date | null;
  claimed_by_user_id: string | null;
  committed_at: Date | null;
  expires_at: Date;
  expired_at: Date | null;
  id: string;
  plan_fingerprint: string;
  plan_snapshot: JsonObject;
  policy_revision: string;
  quote_snapshot: JsonObject;
  state: TelegramAppHandoffState;
  telegram_user_id: string;
  trade_intent_id: string;
  user_id: string;
};

type TelegramAppHandoffAccess = Readonly<{
  telegramUserId: string;
  tokenHash: string;
  userId: string;
}>;

type TelegramAppHandoffAccessInput = Readonly<{
  db: Pool;
  telegramUserId: string;
  token: string;
  userId: string;
}>;

const handoffReturningColumns = `
  authority_fingerprint,
  cancelled_at,
  claimed_at,
  claimed_by_user_id::text,
  committed_at,
  expires_at,
  expired_at,
  id::text,
  plan_fingerprint,
  plan_snapshot,
  policy_revision,
  quote_snapshot,
  state,
  telegram_user_id,
  trade_intent_id::text,
  user_id::text`;

export type TelegramAppHandoff = Readonly<{
  authorityFingerprint: string;
  cancelledAt: string | null;
  claimedAt: string | null;
  committedAt: string | null;
  expiresAt: string;
  expiredAt: string | null;
  id: string;
  planFingerprint: string;
  planSnapshot: JsonObject;
  policyRevision: string;
  quoteSnapshot: JsonObject;
  state: TelegramAppHandoffState;
  tradeIntentId: string;
}>;

export type IssuedTelegramAppHandoff = Readonly<{
  handoff: TelegramAppHandoff;
  startParam: string;
  token: string;
}>;

export class TelegramAppHandoffError extends Error {
  constructor(
    readonly code:
      | "already_issued"
      | "expired"
      | "invalid_token"
      | "not_claimable"
      | "not_cancellable"
      | "not_committable"
      | "not_found"
      | "plan_changed"
      | "policy_changed"
      | "unauthorized"
      | "venue_unsupported",
  ) {
    super(code);
    this.name = "TelegramAppHandoffError";
  }
}

function asJsonObject(value: unknown, field: string): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${field} must be a plain JSON object`);
  }
  return value as JsonObject;
}

/** A direct v2 handoff is sealed for exactly one trade action. */
function directV2PlanAction(planSnapshot: JsonObject): "buy" | "sell" | null {
  if (planSnapshot.version !== 2 || planSnapshot.kind !== "direct_trade") {
    return null;
  }
  const trade = asJsonObject(planSnapshot.trade, "planSnapshot.trade");
  if (trade.action !== "buy" && trade.action !== "sell") {
    throw new TypeError("planSnapshot.trade.action must be buy or sell");
  }
  return trade.action;
}

/**
 * A v2 handoff owns a durable trade intent even when it has materialized a
 * funding operation.  Cancelling it must therefore cancel the *future trade*
 * at every pre-venue state; reconciliation may still finish already-broadcast
 * funding and return those funds to the controller.
 */
function isV2TradePlan(planSnapshot: JsonObject): boolean {
  return (
    planSnapshot.version === 2 &&
    (planSnapshot.kind === "direct_trade" || planSnapshot.kind === "funding")
  );
}

function normalizeBoundedValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new TypeError(
      `${field} is required and must be at most 256 characters`,
    );
  }
  return normalized;
}

function normalizeSha256(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_HEX_RE.test(normalized)) {
    throw new TypeError(`${field} must be a SHA-256 hex value`);
  }
  return normalized;
}

function normalizeUuid(value: string, field: string): string {
  const normalized = value.trim();
  if (!UUID_RE.test(normalized)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return normalized;
}

function normalizeTelegramUserId(value: string): string {
  const normalized = value.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(normalized)) {
    throw new TypeError("telegramUserId must be a positive decimal identifier");
  }
  return normalized;
}

function createOpaqueToken(
  deterministicInput?: Readonly<{ payload: string; secret: string }>,
): string {
  const bytes = deterministicInput
    ? crypto
        .createHmac("sha256", deterministicInput.secret)
        .update(deterministicInput.payload)
        .digest()
    : crypto.randomBytes(32);
  return `${TELEGRAM_APP_HANDOFF_TOKEN_PREFIX}${bytes.toString("base64url")}`;
}

function handoffStartParam(token: string): string {
  return `${TELEGRAM_APP_HANDOFF_START_PARAM_PREFIX}${token}`;
}

function parseOpaqueToken(token: string): string {
  const normalized = token.trim();
  if (!TELEGRAM_APP_HANDOFF_TOKEN_RE.test(normalized)) {
    throw new TelegramAppHandoffError("invalid_token");
  }
  return normalized;
}

function parseHandoffAccess(input: {
  telegramUserId: string;
  token: string;
  userId: string;
}): TelegramAppHandoffAccess {
  return {
    telegramUserId: normalizeTelegramUserId(input.telegramUserId),
    tokenHash: hashOpaqueToken(parseOpaqueToken(input.token)),
    userId: normalizeUuid(input.userId, "userId"),
  };
}

function mapRow(row: TelegramAppHandoffRow): TelegramAppHandoff {
  return {
    authorityFingerprint: row.authority_fingerprint,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    claimedAt: row.claimed_at?.toISOString() ?? null,
    committedAt: row.committed_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
    expiredAt: row.expired_at?.toISOString() ?? null,
    id: row.id,
    planFingerprint: row.plan_fingerprint,
    planSnapshot: asJsonObject(row.plan_snapshot, "plan_snapshot"),
    policyRevision: row.policy_revision,
    quoteSnapshot: asJsonObject(row.quote_snapshot, "quote_snapshot"),
    state: row.state,
    tradeIntentId: row.trade_intent_id,
  };
}

async function expireIfNeeded(
  client: PoolClient,
  input: { telegramUserId: string; tokenHash: string; userId: string },
): Promise<void> {
  await client.query(
    `update telegram_app_handoffs handoff_row
        set state = 'expired', expired_at = clock_timestamp()
      where handoff_row.token_hash = $1
        and handoff_row.user_id = $2::uuid
        and handoff_row.telegram_user_id = $3
        and handoff_row.state in ('issued', 'claimed')
        and handoff_row.expires_at <= clock_timestamp()`,
    [input.tokenHash, input.userId, input.telegramUserId],
  );
}

async function loadBoundHandoff(
  client: PoolClient,
  input: {
    forUpdate?: boolean;
    telegramUserId: string;
    tokenHash: string;
    userId: string;
  },
): Promise<TelegramAppHandoffRow | null> {
  const { rows } = await client.query<TelegramAppHandoffRow>(
    `select
       handoff_row.authority_fingerprint,
       handoff_row.cancelled_at,
       handoff_row.claimed_at,
       handoff_row.claimed_by_user_id,
       handoff_row.committed_at,
       handoff_row.expires_at,
       handoff_row.expired_at,
       handoff_row.id::text,
       handoff_row.plan_fingerprint,
       handoff_row.plan_snapshot,
       handoff_row.policy_revision,
       handoff_row.quote_snapshot,
       handoff_row.state,
       handoff_row.telegram_user_id,
       handoff_row.trade_intent_id::text,
       handoff_row.user_id::text
     from telegram_app_handoffs handoff_row
     join user_telegram_accounts telegram_account
       on telegram_account.telegram_user_id = handoff_row.telegram_user_id
      and telegram_account.user_id = handoff_row.user_id
     join users account_user on account_user.id = handoff_row.user_id
     where handoff_row.token_hash = $1
       and handoff_row.user_id = $2::uuid
       and handoff_row.telegram_user_id = $3
       and coalesce(account_user.is_active, true) = true
    limit 1${input.forUpdate ? " for update of handoff_row" : ""}`,
    [input.tokenHash, input.userId, input.telegramUserId],
  );
  return rows[0] ?? null;
}

async function withCurrentTelegramAppHandoff<T>(
  input: TelegramAppHandoffAccessInput,
  options: { forUpdate?: boolean },
  handler: (input: {
    access: TelegramAppHandoffAccess;
    client: PoolClient;
    row: TelegramAppHandoffRow;
  }) => Promise<T>,
): Promise<T> {
  const access = parseHandoffAccess(input);
  return tx(input.db, async (client) => {
    await expireIfNeeded(client, access);
    const row = await loadBoundHandoff(client, {
      forUpdate: options.forUpdate,
      ...access,
    });
    if (!row) throw new TelegramAppHandoffError("not_found");
    if (row.state === "expired") throw new TelegramAppHandoffError("expired");
    return handler({ access, client, row });
  });
}

/**
 * Creates one one-time, opaque Mini App token for a confirmed app-handoff
 * intent. The raw token is returned only here; the database receives its hash.
 */
export async function issueTelegramAppHandoff(input: {
  authorityFingerprint: string;
  db: Pool;
  expiresAt?: Date;
  planSnapshot: JsonObject;
  policyRevision: string;
  quoteSnapshot: JsonObject;
  telegramUserId: string;
  tokenSecret?: string;
  tradeIntentId: string;
  userId: string;
}): Promise<IssuedTelegramAppHandoff> {
  const planSnapshot = asJsonObject(input.planSnapshot, "planSnapshot");
  const quoteSnapshot = asJsonObject(input.quoteSnapshot, "quoteSnapshot");
  const authorityFingerprint = normalizeBoundedValue(
    normalizeSha256(input.authorityFingerprint, "authorityFingerprint"),
    "authorityFingerprint",
  );
  const policyRevision = normalizeBoundedValue(
    input.policyRevision,
    "policyRevision",
  );
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + TELEGRAM_APP_HANDOFF_TTL_MS);
  if (
    !(expiresAt instanceof Date) ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    throw new TypeError("expiresAt must be a future date");
  }
  const tradeIntentId = normalizeUuid(input.tradeIntentId, "tradeIntentId");
  const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
  const userId = normalizeUuid(input.userId, "userId");
  const tokenSecret = input.tokenSecret?.trim() || null;
  const token = createOpaqueToken(
    tokenSecret
      ? {
          payload: [tradeIntentId, userId, telegramUserId].join(":"),
          secret: tokenSecret,
        }
      : undefined,
  );
  const tokenHash = hashOpaqueToken(token);
  const planFingerprint = canonicalJsonHash({
    authorityFingerprint,
    planSnapshot,
    policyRevision,
    quoteSnapshot,
    tradeIntentId,
  });
  // V1 and v2 funding stay Buy-only. A direct v2 handoff can be either
  // action, but its durable trade intent must match the one exact sealed plan.
  const directAction = directV2PlanAction(planSnapshot);
  const allowedIntentActions = directAction ? [directAction] : ["buy"];

  const handoff = await tx(input.db, async (client) => {
    const inserted = await client.query<TelegramAppHandoffRow>(
      `insert into telegram_app_handoffs (
         trade_intent_id,
         user_id,
         telegram_user_id,
         token_hash,
         plan_fingerprint,
         policy_revision,
         authority_fingerprint,
         quote_snapshot,
         plan_snapshot,
         expires_at
       )
       select
         intent.id,
         intent.user_id,
         intent.telegram_user_id,
         $4,
         $5,
         $6,
         $7,
         $8::jsonb,
         $9::jsonb,
         $10::timestamptz
       from telegram_trade_intents intent
       join user_telegram_accounts telegram_account
         on telegram_account.telegram_user_id = intent.telegram_user_id
        and telegram_account.user_id = intent.user_id
       where intent.id = $1::uuid
         and intent.user_id = $2::uuid
         and intent.telegram_user_id = $3
         and intent.action = any($11::text[])
         and intent.delivery_mode = 'app_handoff'
         and intent.status in ('previewed', 'confirming', 'funding', 'external_handoff')
       on conflict do nothing
       returning ${handoffReturningColumns}`,
      [
        tradeIntentId,
        userId,
        telegramUserId,
        tokenHash,
        planFingerprint,
        policyRevision,
        authorityFingerprint,
        JSON.stringify(quoteSnapshot),
        JSON.stringify(planSnapshot),
        expiresAt,
        allowedIntentActions,
      ],
    );
    if (inserted.rows[0]) return mapRow(inserted.rows[0]);

    if (tokenSecret) {
      const existingDeterministic = await client.query<TelegramAppHandoffRow>(
        `select ${handoffReturningColumns}
             from telegram_app_handoffs
            where trade_intent_id = $1::uuid
              and token_hash = $2
            limit 1`,
        [tradeIntentId, tokenHash],
      );
      if (existingDeterministic.rows[0]) {
        return mapRow(existingDeterministic.rows[0]);
      }
    }
    const existing = await client.query<{ exists: boolean }>(
      `select exists(
         select 1
           from telegram_app_handoffs handoff_row
          where handoff_row.trade_intent_id = $1::uuid
       ) as exists`,
      [tradeIntentId],
    );
    if (existing.rows[0]?.exists) {
      throw new TelegramAppHandoffError("already_issued");
    }
    throw new TelegramAppHandoffError("unauthorized");
  });

  return { handoff, startParam: handoffStartParam(token), token };
}

export async function resolveTelegramAppHandoff(input: {
  db: Pool;
  telegramUserId: string;
  token: string;
  userId: string;
}): Promise<TelegramAppHandoff> {
  return withCurrentTelegramAppHandoff(input, {}, async ({ row }) => {
    return mapRow(row);
  });
}

/** Claim is single-flight. A second tab may observe the same claim but cannot commit it twice. */
export async function claimTelegramAppHandoff(input: {
  db: Pool;
  telegramUserId: string;
  token: string;
  userId: string;
}): Promise<TelegramAppHandoff> {
  return withCurrentTelegramAppHandoff(
    input,
    { forUpdate: true },
    async ({ access, client, row }) => {
      if (row.state === "cancelled" || row.state === "committed") {
        throw new TelegramAppHandoffError("not_claimable");
      }
      if (row.state === "issued") {
        const claimed = await client.query<TelegramAppHandoffRow>(
          `update telegram_app_handoffs handoff_row
            set state = 'claimed',
                claimed_at = clock_timestamp(),
                claimed_by_user_id = $2::uuid
          where handoff_row.id = $1::uuid
          returning ${handoffReturningColumns}`,
          [row.id, access.userId],
        );
        const claimedRow = claimed.rows[0];
        if (!claimedRow) throw new TelegramAppHandoffError("not_claimable");
        return mapRow(claimedRow);
      }
      return mapRow(row);
    },
  );
}

/**
 * A user may cancel a v2 sealed handoff before the venue-submit boundary.
 * This cancels its durable trade intent, not any already-broadcast funding:
 * funding reconciliation keeps running safely, but cannot later submit Buy or
 * Sell. Legacy issued/claimed tokens retain their token-only cancellation.
 */
export async function cancelTelegramAppHandoff(input: {
  db: Pool;
  telegramUserId: string;
  token: string;
  userId: string;
}): Promise<TelegramAppHandoff> {
  return withCurrentTelegramAppHandoff(
    input,
    { forUpdate: true },
    async ({ client, row }) => {
      const v2TradePlan = isV2TradePlan(row.plan_snapshot);
      const cancellableHandoffStates = v2TradePlan
        ? ["issued", "claimed", "committed"]
        : ["issued", "claimed"];
      if (!cancellableHandoffStates.includes(row.state)) {
        throw new TelegramAppHandoffError("not_cancellable");
      }
      if (v2TradePlan) {
        const cancelledIntent = await client.query(
          `update telegram_trade_intents intent
              set status = 'cancelled',
                  error_code = 'cancelled_by_user',
                  error_message = 'The user cancelled the sealed Mini App trade before venue submission.',
                  updated_at = clock_timestamp()
            where intent.id = $1::uuid
              and intent.user_id = $2::uuid
              and intent.delivery_mode = 'app_handoff'
              and intent.action in ('buy', 'sell')
              and intent.status in (
                'draft', 'previewed', 'confirming', 'external_handoff', 'funding'
              )
              and intent.submit_started_at is null`,
          [row.trade_intent_id, row.user_id],
        );
        if ((cancelledIntent.rowCount ?? 0) !== 1) {
          throw new TelegramAppHandoffError("not_cancellable");
        }
      }
      const cancelled = await client.query<TelegramAppHandoffRow>(
        `update telegram_app_handoffs handoff_row
          set state = 'cancelled', cancelled_at = clock_timestamp()
        where handoff_row.id = $1::uuid
          and handoff_row.state = any($2::text[])
        returning ${handoffReturningColumns}`,
        [row.id, cancellableHandoffStates],
      );
      const cancelledRow = cancelled.rows[0];
      if (!cancelledRow) throw new TelegramAppHandoffError("not_cancellable");
      return mapRow(cancelledRow);
    },
  );
}

type TelegramAppHandoffCommitInput = Readonly<{
  currentAuthorityFingerprint: string;
  currentPolicyRevision: string;
  db: Pool;
  planFingerprint: string;
  telegramUserId: string;
  token: string;
  userId: string;
}>;

export type TelegramAppHandoffCommitContext = Readonly<{
  client: PoolClient;
  handoff: TelegramAppHandoff;
}>;

/**
 * Atomically consumes a sealed v2 handoff with its client continuation.
 * The callback is invoked even for an already committed handoff so a retried
 * Mini App request can return its pre-existing operation rather than creating
 * another one. The callback must be deterministic and side-effect-safe in the
 * surrounding transaction.
 */
export async function commitTelegramAppHandoffWithExecution<T>(
  input: TelegramAppHandoffCommitInput &
    Readonly<{
      commitExecution: (context: TelegramAppHandoffCommitContext) => Promise<T>;
      /**
       * Client funding becomes durable `funding`; a sealed direct Buy remains
       * `external_handoff` because there is no fabricated FundingOperation.
       */
      committedIntentStatus?: "external_handoff" | "funding";
      /**
       * Stored with the execution marker so a direct Sell can never be
       * confused with a funding-capable Buy by a later database transition.
       */
      executionKind?: "direct_trade" | "funding";
      /**
       * A v2 consumer can narrow the only intent states it is allowed to
       * commit. This prevents a cancelled or terminal Telegram intent from
       * being re-attached by a stale Mini App tab.
       */
      allowedIntentStatuses?: readonly string[];
      /**
       * V2 direct handoffs may seal Buy or Sell. Funding callers retain the
       * default Buy-only boundary so a Sell can never acquire a reservation.
       */
      allowedIntentActions?: readonly ("buy" | "sell")[];
    }>,
): Promise<Readonly<{ execution: T; handoff: TelegramAppHandoff }>> {
  const authorityFingerprint = normalizeSha256(
    input.currentAuthorityFingerprint,
    "currentAuthorityFingerprint",
  );
  const planFingerprint = normalizeSha256(
    input.planFingerprint,
    "planFingerprint",
  );
  const policyRevision = normalizeBoundedValue(
    input.currentPolicyRevision,
    "currentPolicyRevision",
  );
  return withCurrentTelegramAppHandoff(
    input,
    { forUpdate: true },
    async ({ client, row }) => {
      if (row.state !== "claimed" && row.state !== "committed") {
        throw new TelegramAppHandoffError("not_committable");
      }
      if (row.plan_fingerprint !== planFingerprint) {
        throw new TelegramAppHandoffError("plan_changed");
      }
      if (
        row.policy_revision !== policyRevision ||
        row.authority_fingerprint !== authorityFingerprint
      ) {
        throw new TelegramAppHandoffError("policy_changed");
      }
      const committedRow =
        row.state === "committed"
          ? row
          : (
              await client.query<TelegramAppHandoffRow>(
                `update telegram_app_handoffs handoff_row
                  set state = 'committed', committed_at = clock_timestamp()
                where handoff_row.id = $1::uuid
                  and handoff_row.state = 'claimed'
                returning ${handoffReturningColumns}`,
                [row.id],
              )
            ).rows[0];
      if (!committedRow) throw new TelegramAppHandoffError("not_committable");
      const handoff = mapRow(committedRow);
      const execution = await input.commitExecution({ client, handoff });
      const attached = await client.query(
        `update telegram_trade_intents intent
            set status = case
                  when intent.status in ('previewed', 'external_handoff', 'confirming')
                    then $4::text
                  else intent.status
                end,
                result = coalesce(intent.result, '{}'::jsonb)
                  || jsonb_build_object(
                    'appHandoffExecution',
                    jsonb_build_object(
                      'committedAt', coalesce($2::timestamptz, clock_timestamp()),
                      'handoffId', $3::uuid,
                      'kind', $7::text,
                      'version', 2
                    )
                  ),
                updated_at = clock_timestamp()
          where intent.id = $1::uuid
            and intent.delivery_mode = 'app_handoff'
            and intent.action = any($6::text[])
            and (
              cardinality($5::text[]) = 0
              or intent.status = any($5::text[])
            )`,
        [
          row.trade_intent_id,
          committedRow.committed_at,
          row.id,
          input.committedIntentStatus ?? "funding",
          input.allowedIntentStatuses ?? [],
          input.allowedIntentActions ?? ["buy"],
          input.executionKind ??
            (input.committedIntentStatus === "external_handoff"
              ? "direct_trade"
              : "funding"),
        ],
      );
      if ((attached.rowCount ?? 0) !== 1) {
        throw new TelegramAppHandoffError("not_committable");
      }
      return { execution, handoff };
    },
  );
}

/**
 * Marks the sealed v1 handoff consumed after its web consumer has verified the
 * exact policy, authority, and immutable plan. V1 deliberately has no funding
 * side effect: `/execute` replays the original Telegram confirmation.
 */
export async function commitTelegramAppHandoff(
  input: TelegramAppHandoffCommitInput,
): Promise<TelegramAppHandoff> {
  const authorityFingerprint = normalizeSha256(
    input.currentAuthorityFingerprint,
    "currentAuthorityFingerprint",
  );
  const planFingerprint = normalizeSha256(
    input.planFingerprint,
    "planFingerprint",
  );
  const policyRevision = normalizeBoundedValue(
    input.currentPolicyRevision,
    "currentPolicyRevision",
  );
  return withCurrentTelegramAppHandoff(
    input,
    { forUpdate: true },
    async ({ client, row }) => {
      if (row.state !== "claimed" && row.state !== "committed") {
        throw new TelegramAppHandoffError("not_committable");
      }
      if (row.plan_fingerprint !== planFingerprint) {
        throw new TelegramAppHandoffError("plan_changed");
      }
      if (
        row.policy_revision !== policyRevision ||
        row.authority_fingerprint !== authorityFingerprint
      ) {
        throw new TelegramAppHandoffError("policy_changed");
      }
      const committedRow =
        row.state === "committed"
          ? row
          : (
              await client.query<TelegramAppHandoffRow>(
                `update telegram_app_handoffs handoff_row
                  set state = 'committed', committed_at = clock_timestamp()
                where handoff_row.id = $1::uuid
                  and handoff_row.state = 'claimed'
                returning ${handoffReturningColumns}`,
                [row.id],
              )
            ).rows[0];
      if (!committedRow) throw new TelegramAppHandoffError("not_committable");
      const attached = await client.query(
        `update telegram_trade_intents intent
            set status = case
                  when intent.status in ('previewed', 'external_handoff')
                    then 'confirming'
                  else intent.status
                end,
                result = coalesce(intent.result, '{}'::jsonb)
                  || jsonb_build_object(
                    'appHandoffExecution',
                    jsonb_build_object(
                      'committedAt', coalesce($2::timestamptz, clock_timestamp()),
                      'handoffId', $3::uuid,
                      'version', 1
                    )
                  ),
                updated_at = clock_timestamp()
          where intent.id = $1::uuid
            and intent.delivery_mode = 'app_handoff'
            and intent.action = 'buy'`,
        [row.trade_intent_id, committedRow.committed_at, row.id],
      );
      if ((attached.rowCount ?? 0) !== 1) {
        throw new TelegramAppHandoffError("not_committable");
      }
      return mapRow(committedRow);
    },
  );
}

export function parseTelegramAppHandoffStartParam(
  startParam: string | null | undefined,
): string | null {
  const value = startParam?.trim() ?? "";
  if (!value.startsWith(TELEGRAM_APP_HANDOFF_START_PARAM_PREFIX)) return null;
  const token = value.slice(TELEGRAM_APP_HANDOFF_START_PARAM_PREFIX.length);
  return TELEGRAM_APP_HANDOFF_TOKEN_RE.test(token) ? token : null;
}
