import crypto from "node:crypto";

import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
import { telegramFundingCallbackData } from "./telegram-funding-contracts.js";
import { isTelegramFundingReadyTerminalProjection } from "./telegram-funding-progress.js";

export { hasReadyTelegramFundingDestinationReceipt } from "./telegram-funding-route.js";

type Queryable = Pick<PoolClient, "query">;

export const TELEGRAM_FUNDING_BUY_CONTINUATION_TTL_MS = 2 * 60 * 1000;

export type TelegramFundingBuyReturnRevision = Readonly<{
  revision: number;
  fundingContextId: string;
  requestFingerprint: string;
  venueBindingOptionId: string;
  destinationOptionId: string;
  venueId: string;
  marketId: string;
  requestedSpendUsd: string;
  side: "NO" | "YES";
  eventId: string | null;
  sourceShortfallIntentId: string | null;
  sourceAuthorityFingerprint: string;
  telegramAccountIdSnapshot: string;
  createdAt: string;
}>;

export type TelegramFundingBuyContinuation = Readonly<{
  id: string;
  tokenHash: string;
  fundingContextId: string;
  policyRevision: string;
  buyReturnRevision: number;
  readyReceiveVersion: number;
  readyProgressRevision: number;
  bindingFingerprint: string;
  telegramAccountId: string | null;
  chatId: string;
  telegramUserId: string;
  expiresAt: string;
  createdAt: string;
}>;

type BuyReturnRow = Readonly<{
  telegram_funding_session_id: string;
  revision: number;
  telegram_account_id_snapshot: string;
  market_id: string;
  event_id: string | null;
  side: "NO" | "YES";
  requested_spend_usd: string;
  source_shortfall_intent_id: string | null;
  source_authority_fingerprint: string;
  venue_id: string;
  destination_option_id: string;
  venue_binding_option_id: string;
  request_fingerprint: string;
  created_at: Date;
}>;

type ContinuationRow = Readonly<{
  id: string;
  telegram_funding_session_id: string;
  buy_return_revision: number;
  ready_progress_revision: number;
  ready_receive_version: string | number;
  token_hash: string;
  binding_fingerprint: string;
  policy_revision: string;
  telegram_account_id: string | null;
  telegram_user_id: string;
  chat_id: string;
  expires_at: Date;
  created_at: Date;
}>;

const buyReturnColumns = `
  telegram_funding_session_id,
  revision,
  telegram_account_id_snapshot,
  market_id,
  event_id,
  side,
  requested_spend_usd::text,
  source_shortfall_intent_id,
  source_authority_fingerprint,
  venue_id,
  destination_option_id,
  venue_binding_option_id,
  request_fingerprint,
  created_at
`;

const continuationColumns = `
  id,
  telegram_funding_session_id,
  buy_return_revision,
  ready_progress_revision,
  ready_receive_version,
  token_hash,
  binding_fingerprint,
  policy_revision,
  telegram_account_id,
  telegram_user_id,
  chat_id,
  expires_at,
  created_at
`;

function publicBuyReturn(row: BuyReturnRow): TelegramFundingBuyReturnRevision {
  const receiveBinding = {
    fundingContextId: row.telegram_funding_session_id,
    venueBindingOptionId: row.venue_binding_option_id,
    destinationOptionId: row.destination_option_id,
    venueId: row.venue_id,
  };
  const request = {
    marketId: row.market_id,
    requestedSpendUsd: row.requested_spend_usd,
    side: row.side,
    eventId: row.event_id,
    sourceShortfallIntentId: row.source_shortfall_intent_id,
    sourceAuthorityFingerprint: row.source_authority_fingerprint,
  };
  return {
    revision: row.revision,
    requestFingerprint: row.request_fingerprint,
    telegramAccountIdSnapshot: row.telegram_account_id_snapshot,
    ...receiveBinding,
    ...request,
    createdAt: row.created_at.toISOString(),
  };
}

function publicContinuation(
  row: ContinuationRow,
): TelegramFundingBuyContinuation {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    fundingContextId: row.telegram_funding_session_id,
    policyRevision: row.policy_revision,
    buyReturnRevision: row.buy_return_revision,
    readyReceiveVersion: Number(row.ready_receive_version),
    readyProgressRevision: row.ready_progress_revision,
    bindingFingerprint: row.binding_fingerprint,
    telegramAccountId: row.telegram_account_id,
    chatId: row.chat_id,
    telegramUserId: row.telegram_user_id,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export function hashTelegramFundingBuyContinuationToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function createContinuationToken(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export async function fetchActiveTelegramFundingBuyReturn(
  db: Pick<Pool, "query">,
  contextId: string,
): Promise<TelegramFundingBuyReturnRevision | null> {
  const { rows } = await db.query<BuyReturnRow>(
    `
      select ${buyReturnColumns
        .split("\n")
        .map((column) => (column.trim() ? `buy_return.${column.trim()}` : ""))
        .join("\n")}
      from telegram_funding_sessions context
      join telegram_funding_buy_return_revisions buy_return
        on buy_return.telegram_funding_session_id = context.id
       and buy_return.revision = context.active_buy_return_revision
      where context.id = $1
      limit 1
    `,
    [contextId],
  );
  return rows[0] ? publicBuyReturn(rows[0]) : null;
}

async function loadBuyReturnMutationReplay(
  client: Queryable,
  input: Readonly<{
    contextId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }>,
): Promise<TelegramFundingBuyReturnRevision | null> {
  const replay = await client.query<
    BuyReturnRow & { mutation_fingerprint: string }
  >(
    `
      select
        ${buyReturnColumns
          .split("\n")
          .map((column) => (column.trim() ? `buy_return.${column.trim()}` : ""))
          .join("\n")},
        mutation.request_fingerprint as mutation_fingerprint
      from telegram_funding_mutations mutation
      join telegram_funding_buy_return_revisions buy_return
        on buy_return.telegram_funding_session_id = mutation.funding_context_id
       and buy_return.revision = mutation.buy_return_revision
      where mutation.idempotency_key = $1
      limit 1
    `,
    [input.idempotencyKey],
  );
  const row = replay.rows[0];
  if (!row) return null;
  if (
    row.mutation_fingerprint !== input.requestFingerprint ||
    row.telegram_funding_session_id !== input.contextId
  ) {
    throw new Error("telegram_funding_idempotency_conflict");
  }
  return publicBuyReturn(row);
}

export async function appendTelegramFundingBuyReturnInTransaction(
  client: Queryable,
  input: Readonly<{
    contextId: string;
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    chatId: string;
    marketId: string;
    eventId: string | null;
    side: "NO" | "YES";
    requestedSpendUsd: string;
    sourceShortfallIntentId: string;
    sourceAuthorityFingerprint: string;
    venueId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    responsePayload: Readonly<Record<string, unknown>>;
    now: Date;
  }>,
): Promise<
  Readonly<{ revision: TelegramFundingBuyReturnRevision; replayed: boolean }>
> {
  const replayed = await loadBuyReturnMutationReplay(client, input);
  if (replayed) {
    return { revision: replayed, replayed: true };
  }

  const locked = await client.query<{
    active_buy_return_revision: number | null;
    destination_option_id: string;
    venue_binding_option_id: string;
    venue_id: string;
  }>(
    `
      select
        context.active_buy_return_revision,
        receive.destination_option_id,
        receive.venue_binding_option_id,
        receive.venue_id
      from telegram_funding_sessions context
      join funding_receive_sessions receive
        on receive.id = context.receive_session_id
       and receive.user_id = context.user_id
       and receive.owner_channel = context.receive_owner_channel
      where context.id = $1
        and context.user_id = $2
        and context.telegram_account_id = $3::uuid
        and context.telegram_user_id = $4
        and context.chat_id = $5
        and context.cancelled_at is null
        and context.expires_at > $6
        and context.receive_owner_channel = 'telegram'
        and receive.owner_channel = 'telegram'
        and receive.status in ('open', 'processing', 'review_required')
        and receive.expires_at > $6
      for update of context
    `,
    [
      input.contextId,
      input.userId,
      input.telegramAccountId,
      input.telegramUserId,
      input.chatId,
      input.now,
    ],
  );
  const context = locked.rows[0];
  if (!context) throw new Error("telegram_funding_session_unavailable");
  if (
    context.venue_id !== input.venueId ||
    context.destination_option_id !== input.destinationOptionId ||
    context.venue_binding_option_id !== input.venueBindingOptionId
  ) {
    throw new Error("telegram_funding_binding_mismatch");
  }
  const lockedReplay = await loadBuyReturnMutationReplay(client, input);
  if (lockedReplay) {
    return { revision: lockedReplay, replayed: true };
  }
  const revision = (context.active_buy_return_revision ?? 0) + 1;
  const inserted = await client.query<BuyReturnRow>(
    `
      insert into telegram_funding_buy_return_revisions (
        telegram_funding_session_id,
        revision,
        parent_revision,
        telegram_account_id_snapshot,
        market_id,
        event_id,
        side,
        requested_spend_usd,
        source_shortfall_intent_id,
        source_authority_fingerprint,
        venue_id,
        destination_option_id,
        venue_binding_option_id,
        request_fingerprint,
        created_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15
      )
      returning ${buyReturnColumns}
    `,
    [
      input.contextId,
      revision,
      revision === 1 ? null : revision - 1,
      input.telegramAccountId,
      input.marketId,
      input.eventId,
      input.side,
      input.requestedSpendUsd,
      input.sourceShortfallIntentId,
      input.sourceAuthorityFingerprint,
      input.venueId,
      input.destinationOptionId,
      input.venueBindingOptionId,
      input.requestFingerprint,
      input.now,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("telegram_funding_buy_return_create_failed");
  const activated = await client.query(
    `
      update telegram_funding_sessions
      set active_buy_return_revision = $2,
          resume_intent_id = null,
          resumed_at = null,
          updated_at = $3
      where id = $1
        and active_buy_return_revision is not distinct from $4
    `,
    [input.contextId, revision, input.now, context.active_buy_return_revision],
  );
  if ((activated.rowCount ?? 0) !== 1) {
    throw new Error("telegram_funding_buy_return_superseded");
  }
  await client.query(
    `
      insert into telegram_funding_mutations (
        funding_context_id,
        action,
        idempotency_key,
        request_fingerprint,
        response_payload,
        consent_revision,
        buy_return_revision,
        created_at
      ) values ($1, 'set_buy_return', $2, $3, $4::jsonb, null, $5, $6)
    `,
    [
      input.contextId,
      input.idempotencyKey,
      input.requestFingerprint,
      JSON.stringify(input.responsePayload),
      revision,
      input.now,
    ],
  );
  return { revision: publicBuyReturn(row), replayed: false };
}

export async function issueTelegramFundingBuyContinuation(input: {
  pool: Pool;
  contextId: string;
  returnRevision: number;
  progressRevision: number;
  receiveVersion: number;
  telegramAccountId: string;
  telegramUserId: string;
  chatId: string;
  policyRevision: string;
  validateBeforeIssue?: (client: Queryable) => Promise<boolean>;
  now?: Date;
}): Promise<
  Readonly<{ continuation: TelegramFundingBuyContinuation; token: string }>
> {
  const now = input.now ?? new Date();
  const token = createContinuationToken();
  const tokenHash = hashTelegramFundingBuyContinuationToken(token);
  return tx(input.pool, async (client) => {
    const current = await client.query<{
      active_buy_return_revision: number | null;
      latest_terminal_projection: unknown;
      progress_revision: number;
      receive_version: string | number;
    }>(
      `
        select
          context.active_buy_return_revision,
          context.latest_terminal_projection,
          context.progress_revision,
          receive.version as receive_version
        from telegram_funding_sessions context
        join funding_receive_sessions receive
          on receive.id = context.receive_session_id
         and receive.user_id = context.user_id
        where context.id = $1
          and context.telegram_account_id = $2::uuid
          and context.telegram_user_id = $3
          and context.chat_id = $4
          and context.cancelled_at is null
          and context.expires_at > $5
          and context.latest_progress_projection ->> 'state' = 'ready'
          and context.latest_terminal_projection =
              context.latest_progress_projection
        for update of context
      `,
      [
        input.contextId,
        input.telegramAccountId,
        input.telegramUserId,
        input.chatId,
        now,
      ],
    );
    const row = current.rows[0];
    if (
      !row ||
      !isTelegramFundingReadyTerminalProjection(
        row.latest_terminal_projection,
        input.contextId,
      ) ||
      row.active_buy_return_revision !== input.returnRevision ||
      row.progress_revision !== input.progressRevision ||
      Number(row.receive_version) !== input.receiveVersion
    ) {
      throw new Error("telegram_funding_buy_continuation_stale");
    }
    if (
      input.validateBeforeIssue &&
      !(await input.validateBeforeIssue(client))
    ) {
      throw new Error("telegram_funding_buy_continuation_stale");
    }
    const bindingFingerprint = canonicalJsonHash({
      contextId: input.contextId,
      returnRevision: input.returnRevision,
      progressRevision: input.progressRevision,
      receiveVersion: input.receiveVersion,
      telegramAccountId: input.telegramAccountId,
      telegramUserId: input.telegramUserId,
      chatId: input.chatId,
    });
    const inserted = await client.query<ContinuationRow>(
      `
        insert into telegram_funding_buy_continuations (
          telegram_funding_session_id,
          buy_return_revision,
          ready_progress_revision,
          ready_receive_version,
          token_hash,
          binding_fingerprint,
          policy_revision,
          telegram_account_id,
          telegram_user_id,
          chat_id,
          expires_at,
          created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        returning ${continuationColumns}
      `,
      [
        input.contextId,
        input.returnRevision,
        input.progressRevision,
        input.receiveVersion,
        tokenHash,
        bindingFingerprint,
        input.policyRevision,
        input.telegramAccountId,
        input.telegramUserId,
        input.chatId,
        new Date(now.getTime() + TELEGRAM_FUNDING_BUY_CONTINUATION_TTL_MS),
        now,
      ],
    );
    const continuation = inserted.rows[0];
    if (!continuation) {
      throw new Error("telegram_funding_buy_continuation_create_failed");
    }
    return { continuation: publicContinuation(continuation), token };
  });
}

export async function fetchTelegramFundingBuyContinuationForUpdate(
  client: Queryable,
  token: string,
): Promise<TelegramFundingBuyContinuation | null> {
  const { rows } = await client.query<ContinuationRow>(
    `
      select ${continuationColumns}
      from telegram_funding_buy_continuations
      where token_hash = $1
      for update
      limit 1
    `,
    [hashTelegramFundingBuyContinuationToken(token)],
  );
  return rows[0] ? publicContinuation(rows[0]) : null;
}

export type TelegramFundingBuyContinuationCapability = Readonly<
  | { available: true }
  | {
      available: false;
      reason: "disabled" | "no_active_return" | "not_ready";
    }
>;

export type TelegramFundingBuyContinuationAdapter = Readonly<{
  id: "polymarket_destination_pusd_v1";
  tradingVenue: "polymarket";
}>;

export function resolveTelegramFundingBuyContinuationAdapter(input: {
  destinationAsset: Readonly<{
    assetId: string;
    decimals: number;
    networkId: string;
  }>;
  venueId: string;
}): TelegramFundingBuyContinuationAdapter | null {
  if (
    input.venueId !== "polymarket" ||
    resolveKnownAccountAssetSymbol(input.destinationAsset) !== "pUSD"
  ) {
    return null;
  }
  return {
    id: "polymarket_destination_pusd_v1",
    tradingVenue: "polymarket",
  };
}

export function resolveTelegramFundingBuyContinuationCapability(input: {
  activeReturnAttached: boolean;
  buyContinuationEnabled: boolean;
  progressState:
    | "cancelled"
    | "expired"
    | "funds_received"
    | "needs_attention"
    | "ready"
    | "unavailable"
    | "waiting_for_transfer";
}): TelegramFundingBuyContinuationCapability {
  if (!input.buyContinuationEnabled) {
    return { available: false, reason: "disabled" };
  }
  if (!input.activeReturnAttached) {
    return { available: false, reason: "no_active_return" };
  }
  if (input.progressState !== "ready") {
    return { available: false, reason: "not_ready" };
  }
  return { available: true };
}

export function buildTelegramFundingReviewBuyButton(input: {
  continuationToken: string;
}): Readonly<{ callback_data: string; text: string }> {
  return {
    callback_data: telegramFundingCallbackData({
      continuationToken: input.continuationToken,
      kind: "review_buy",
    }),
    text: "Review Buy",
  };
}
