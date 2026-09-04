import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  AssetRef,
  ExternalIngressInstruction,
  FundingReceiveAutomationPolicy,
  JsonValue,
} from "../funding/domain/types.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../funding/domain/asset-identity.js";
import { SOLANA_NATIVE_ASSET } from "../funding/domain/network-fees.js";
import { lockTelegramFundingLinkLifecycle } from "../funding/execution/telegram-funding-link-lifecycle-lock.js";
import {
  isTelegramFundingManagedSolanaWalletCurrent,
  resolveTelegramFundingManagedWalletIdentity,
  telegramFundingManagedWalletControllerId,
  telegramFundingVenueNetworkId,
} from "../funding/execution/telegram-funding-managed-wallet.js";
import { hashOpaqueToken } from "../funding/persistence/canonical.js";
import { loadFundingLifecycleProjectionForOperation } from "../funding/lifecycle/funding-lifecycle-read-model.js";
import { lockFundingReceiveSessionScope } from "../funding/persistence/funding-receive-session-repository.js";
import {
  parseDirectIngressObservationVariant,
  type DirectIngressObservationVariant,
} from "../funding/reconciliation/direct-ingress-observer.js";
import { resolveTelegramFundingAutomaticCapability } from "./telegram-funding-route.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type ReceiveTargets = NonNullable<ExternalIngressInstruction["receiveTargets"]>;

export class TelegramFundingPersistenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TelegramFundingPersistenceError";
  }
}

export type TelegramFundingReviewTarget = Readonly<{
  contextId: string;
  receiptId: string;
  receiveSessionId: string;
  quoteId: string | null;
}>;

export async function lockActiveTelegramFundingReviewTarget(
  client: PoolClient,
  input: Readonly<{
    receiptId: string;
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    telegramMessageId: number | null;
    chatId: string;
    now: Date;
  }>,
): Promise<TelegramFundingReviewTarget | null> {
  const { rows } = await client.query<{
    context_id: string;
    quote_id: string | null;
    receipt_id: string;
    receive_session_id: string;
  }>(
    `
      select
        context.id as context_id,
        receipt.review_quote_id as quote_id,
        receipt.id as receipt_id,
        receipt.receive_session_id
      from telegram_funding_sessions context
      join funding_receive_sessions receive
        on receive.id = context.receive_session_id
       and receive.user_id = context.user_id
       and receive.owner_channel = 'telegram'
      join funding_receive_receipts receipt
        on receipt.receive_session_id = receive.id
       and receipt.user_id = context.user_id
      join user_telegram_accounts account
        on account.id = $3::uuid
       and account.user_id = context.user_id
       and account.telegram_user_id = context.telegram_user_id
      where receipt.id = $1::uuid
        and context.user_id = $2::uuid
        and context.telegram_user_id = $4
        and context.chat_id = $5
        and context.telegram_message_id is not distinct from $7::bigint
        and context.cancelled_at is null
        and context.expires_at > $6
        and context.latest_terminal_projection is null
        and receive.status in ('open', 'processing', 'review_required')
        and receive.expires_at > $6
        and receipt.status = 'review_required'
        and receipt.handling in ('review_required', 'automatic_conversion')
        and receipt.child_funding_operation_id is null
        and receipt.evidence ? 'reviewContinuation'
      for update of context, receive, receipt
      limit 1
    `,
    [
      input.receiptId,
      input.userId,
      input.telegramAccountId,
      input.telegramUserId,
      input.chatId,
      input.now,
      input.telegramMessageId,
    ],
  );
  const row = rows[0] ?? null;
  return row
    ? {
        contextId: row.context_id,
        receiptId: row.receipt_id,
        receiveSessionId: row.receive_session_id,
        quoteId: row.quote_id,
      }
    : null;
}

export async function lockActiveTelegramFundingReviewByConsentToken(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    telegramMessageId: number | null;
    chatId: string;
    consentToken: string;
    now: Date;
  }>,
): Promise<TelegramFundingReviewTarget | null> {
  const { rows } = await client.query<{
    context_id: string;
    quote_id: string;
    receipt_id: string;
    receive_session_id: string;
  }>(
    `
      select
        context.id as context_id,
        quote.id as quote_id,
        receipt.id as receipt_id,
        receipt.receive_session_id
      from funding_quotes quote
      join funding_receive_receipts receipt
        on receipt.review_quote_id = quote.id
       and receipt.user_id = quote.user_id
      join funding_receive_sessions receive
        on receive.id = receipt.receive_session_id
       and receive.user_id = receipt.user_id
       and receive.owner_channel = 'telegram'
      join telegram_funding_sessions context
        on context.receive_session_id = receive.id
       and context.user_id = receive.user_id
      join user_telegram_accounts account
        on account.id = $2::uuid
       and account.user_id = context.user_id
       and account.telegram_user_id = context.telegram_user_id
      where quote.user_id = $1::uuid
        and quote.consent_token_hash = $5
        and context.telegram_user_id = $3
        and context.chat_id = $4
        and context.telegram_message_id is not distinct from $7::bigint
        and context.cancelled_at is null
        and context.expires_at > $6
        and context.latest_terminal_projection is null
        and receive.status in ('open', 'processing', 'review_required')
        and receive.expires_at > $6
        and receipt.status in ('review_required', 'routing')
        and receipt.handling in ('review_required', 'automatic_conversion')
        and (
          (receipt.status = 'review_required' and receipt.child_funding_operation_id is null)
          or (receipt.status = 'routing' and receipt.child_funding_operation_id is not null)
        )
        and receipt.evidence ? 'reviewContinuation'
      order by context.id, receipt.id
      for update of context, receive, receipt, quote
      limit 2
    `,
    [
      input.userId,
      input.telegramAccountId,
      input.telegramUserId,
      input.chatId,
      hashOpaqueToken(input.consentToken),
      input.now,
      input.telegramMessageId,
    ],
  );
  const row = rows.length === 1 ? rows[0] : null;
  return row
    ? {
        contextId: row.context_id,
        receiptId: row.receipt_id,
        receiveSessionId: row.receive_session_id,
        quoteId: row.quote_id,
      }
    : null;
}

type TelegramFundingSessionRow = Readonly<{
  id: string;
  user_id: string;
  telegram_account_id: string | null;
  telegram_user_id: string;
  chat_id: string;
  telegram_message_id: string | number | null;
  receive_session_id: string;
  origin: "generic_add_funds" | "buy_return_context";
  market_id: string | null;
  event_id: string | null;
  side: "NO" | "YES" | null;
  requested_spend_usd: string | number | null;
  minimum_funding_usd: string | number | null;
  resume_generation: number;
  resume_intent_id: string | null;
  resumed_at: Date | null;
  active_consent_revision: number | null;
  expires_at: Date;
  cancelled_at: Date | null;
  progress_revision: number;
  latest_progress_projection: JsonRecord | null;
  latest_terminal_revision: number | null;
  latest_terminal_projection: JsonRecord | null;
  last_delivered_revision: number;
  address_disclosure_attempt_revision: number;
  address_disclosure_message_id: string | number | null;
  address_delivered_revision: number;
  address_redacted_revision: number;
  created_at: Date;
  updated_at: Date;
}>;

type TelegramFundingConsentRow = Readonly<{
  id: string;
  telegram_funding_session_id: string;
  revision: number;
  selected_receive_target_id: string;
  selected_asset_network_id: string;
  selected_asset_id: string;
  selected_asset_decimals: number;
  consented_variant_ids: string[];
  automation_enabled: boolean;
  max_auto_execute_source_raw: string | null;
  automation_policy_snapshot: JsonRecord;
  consent_fingerprint: string;
  consented_at: Date;
}>;

type TelegramFundingMutationAction =
  | "cancel"
  | "open"
  | "resume_buy"
  | "review_conversion"
  | "select_target"
  | "set_buy_return";

type TelegramFundingMutationRow = Readonly<{
  funding_context_id: string;
  action: TelegramFundingMutationAction;
  idempotency_key: string;
  request_fingerprint: string;
  response_payload: JsonRecord;
  consent_revision: number | null;
  review_receipt_id: string | null;
  review_quote_id: string | null;
}>;

export type TelegramFundingSessionContext = Readonly<{
  id: string;
  userId: string;
  telegramAccountId: string | null;
  telegramUserId: string;
  chatId: string;
  telegramMessageId: number | null;
  receiveSessionId: string;
  origin: "generic_add_funds" | "buy_return_context";
  activeConsentRevision: number | null;
  initialMarketId: string | null;
  initialEventId: string | null;
  initialSide: "NO" | "YES" | null;
  initialRequestedSpendUsd: string | null;
  initialMinimumFundingUsd?: string | null;
  resumeGeneration: number;
  resumeIntentId: string | null;
  resumedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string;
  createdAt: string;
  progressRevision: number;
  latestProgressProjection: JsonRecord | null;
  latestTerminalRevision: number | null;
  latestTerminalProjection: JsonRecord | null;
  lastDeliveredRevision: number;
  addressDisclosureAttemptRevision: number;
  addressDisclosureMessageId: number | null;
  addressDeliveredRevision: number;
  addressRedactedRevision: number;
  updatedAt: string;
}>;

export type TelegramFundingConsent = Readonly<{
  id: string;
  fundingContextId: string;
  revision: number;
  receiveTargetId: string;
  asset: AssetRef;
  variantIds: readonly string[];
  automationEnabled: boolean;
  maximumAutomaticRaw: string | null;
  policySnapshot: JsonRecord;
  fingerprint: string;
  consentedAt: string;
}>;

const sessionColumns = `
  id,
  user_id,
  telegram_account_id,
  telegram_user_id,
  chat_id,
  telegram_message_id,
  receive_session_id,
  origin,
  market_id,
  event_id,
  side,
  requested_spend_usd,
  minimum_funding_usd,
  resume_generation,
  resume_intent_id,
  resumed_at,
  active_consent_revision,
  expires_at,
  cancelled_at,
  progress_revision,
  latest_progress_projection,
  latest_terminal_revision,
  latest_terminal_projection,
  last_delivered_revision,
  address_disclosure_attempt_revision,
  address_disclosure_message_id,
  address_delivered_revision,
  address_redacted_revision,
  created_at,
  updated_at
`;

function qualifiedSessionColumns(alias: string): string {
  return sessionColumns
    .split("\n")
    .map((column) => (column.trim() ? `${alias}.${column.trim()}` : ""))
    .join("\n");
}

function publicSession(
  row: TelegramFundingSessionRow,
): TelegramFundingSessionContext {
  const messageId =
    row.telegram_message_id == null ? null : Number(row.telegram_message_id);
  const disclosureMessageId =
    row.address_disclosure_message_id == null
      ? null
      : Number(row.address_disclosure_message_id);
  return {
    id: row.id,
    userId: row.user_id,
    telegramAccountId: row.telegram_account_id,
    telegramUserId: row.telegram_user_id,
    chatId: row.chat_id,
    telegramMessageId:
      messageId != null && Number.isSafeInteger(messageId) ? messageId : null,
    receiveSessionId: row.receive_session_id,
    origin: row.origin,
    initialMarketId: row.market_id,
    initialEventId: row.event_id,
    initialSide: row.side,
    initialRequestedSpendUsd:
      row.requested_spend_usd == null ? null : String(row.requested_spend_usd),
    initialMinimumFundingUsd:
      row.minimum_funding_usd == null ? null : String(row.minimum_funding_usd),
    resumeGeneration: row.resume_generation,
    resumeIntentId: row.resume_intent_id,
    resumedAt: row.resumed_at?.toISOString() ?? null,
    activeConsentRevision: row.active_consent_revision,
    expiresAt: row.expires_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    progressRevision: row.progress_revision,
    latestProgressProjection: row.latest_progress_projection,
    latestTerminalRevision: row.latest_terminal_revision,
    latestTerminalProjection: row.latest_terminal_projection,
    lastDeliveredRevision: row.last_delivered_revision,
    addressDisclosureAttemptRevision: row.address_disclosure_attempt_revision,
    addressDisclosureMessageId:
      disclosureMessageId != null && Number.isSafeInteger(disclosureMessageId)
        ? disclosureMessageId
        : null,
    addressDeliveredRevision: row.address_delivered_revision,
    addressRedactedRevision: row.address_redacted_revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function publicConsent(row: TelegramFundingConsentRow): TelegramFundingConsent {
  return {
    id: row.id,
    fundingContextId: row.telegram_funding_session_id,
    revision: row.revision,
    receiveTargetId: row.selected_receive_target_id,
    asset: {
      networkId: row.selected_asset_network_id,
      assetId: row.selected_asset_id,
      decimals: row.selected_asset_decimals,
    },
    variantIds: row.consented_variant_ids,
    automationEnabled: row.automation_enabled,
    maximumAutomaticRaw: row.max_auto_execute_source_raw,
    policySnapshot: row.automation_policy_snapshot,
    fingerprint: row.consent_fingerprint,
    consentedAt: row.consented_at.toISOString(),
  };
}

function assertSameMutation(
  row: TelegramFundingMutationRow,
  input: Readonly<{
    action: TelegramFundingMutationAction;
    contextId: string;
    requestFingerprint: string;
  }>,
): void {
  if (
    row.action !== input.action ||
    row.funding_context_id !== input.contextId ||
    row.request_fingerprint !== input.requestFingerprint
  ) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_idempotency_conflict",
    );
  }
}

async function loadMutationByKey(
  client: Pick<PoolClient, "query">,
  idempotencyKey: string,
): Promise<TelegramFundingMutationRow | null> {
  const { rows } = await client.query<TelegramFundingMutationRow>(
    `
      select
        funding_context_id,
        action,
        idempotency_key,
        request_fingerprint,
        response_payload,
        consent_revision,
        review_receipt_id,
        review_quote_id
      from telegram_funding_mutations
      where idempotency_key = $1
      limit 1
    `,
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

function assertSameReviewMutation(
  row: TelegramFundingMutationRow,
  input: Readonly<{
    contextId: string;
    quoteId?: string;
    receiptId: string;
    requestFingerprint: string;
  }>,
): void {
  if (
    row.action !== "review_conversion" ||
    row.funding_context_id !== input.contextId ||
    row.request_fingerprint !== input.requestFingerprint ||
    row.consent_revision !== null ||
    row.review_receipt_id !== input.receiptId ||
    (input.quoteId != null && row.review_quote_id !== input.quoteId) ||
    row.review_quote_id == null ||
    row.response_payload.fundingContextId !== input.contextId ||
    typeof row.response_payload.text !== "string" ||
    row.response_payload.parse_mode !== "MarkdownV2"
  ) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_idempotency_conflict",
    );
  }
}

export async function fetchTelegramFundingReviewMutationReplay(
  client: PoolClient,
  input: Readonly<{
    idempotencyKey: string;
    receiptId: string;
    requestFingerprint: string;
    telegramAccountId: string;
    telegramUserId: string;
    chatId: string;
    userId: string;
  }>,
): Promise<JsonRecord | null> {
  const row = await loadMutationByKey(client, input.idempotencyKey);
  if (!row) return null;
  assertSameReviewMutation(row, {
    contextId: row.funding_context_id,
    receiptId: input.receiptId,
    requestFingerprint: input.requestFingerprint,
  });
  const context = await fetchTelegramFundingSessionContext(client, {
    contextId: row.funding_context_id,
    userId: input.userId,
    telegramUserId: input.telegramUserId,
    chatId: input.chatId,
  });
  if (!context || context.telegramAccountId !== input.telegramAccountId) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_idempotency_conflict",
    );
  }
  return row.response_payload;
}

export async function fetchActiveTelegramFundingReviewResponse(
  client: PoolClient,
  input: Readonly<{
    contextId: string;
    quoteId: string;
    receiptId: string;
    userId: string;
    now: Date;
  }>,
): Promise<JsonRecord | null> {
  const { rows } = await client.query<TelegramFundingMutationRow>(
    `
      select
        mutation.funding_context_id,
        mutation.action,
        mutation.idempotency_key,
        mutation.request_fingerprint,
        mutation.response_payload,
        mutation.consent_revision,
        mutation.review_receipt_id,
        mutation.review_quote_id
      from telegram_funding_mutations mutation
      join funding_quotes quote
        on quote.id = mutation.review_quote_id
       and quote.user_id = $4::uuid
      where mutation.funding_context_id = $1::uuid
        and mutation.action = 'review_conversion'
        and mutation.review_receipt_id = $2::uuid
        and mutation.review_quote_id = $3::uuid
        and quote.expires_at > $5
        and quote.consumed_at is null
        and quote.invalidated_at is null
      order by mutation.created_at asc, mutation.id asc
      limit 1
    `,
    [input.contextId, input.receiptId, input.quoteId, input.userId, input.now],
  );
  const row = rows[0];
  if (!row) return null;
  assertSameReviewMutation(row, {
    ...input,
    requestFingerprint: row.request_fingerprint,
  });
  return row.response_payload;
}

export async function recordTelegramFundingReviewMutation(
  client: PoolClient,
  input: Readonly<{
    contextId: string;
    idempotencyKey: string;
    quoteId: string;
    receiptId: string;
    requestFingerprint: string;
    responsePayload: JsonRecord;
    now: Date;
  }>,
): Promise<JsonRecord> {
  await client.query(
    `
      insert into telegram_funding_mutations (
        funding_context_id,
        action,
        idempotency_key,
        request_fingerprint,
        response_payload,
        consent_revision,
        review_receipt_id,
        review_quote_id,
        created_at
      ) values ($1, 'review_conversion', $2, $3, $4::jsonb, null, $5, $6, $7)
      on conflict (idempotency_key) do nothing
    `,
    [
      input.contextId,
      input.idempotencyKey,
      input.requestFingerprint,
      JSON.stringify(input.responsePayload),
      input.receiptId,
      input.quoteId,
      input.now,
    ],
  );
  const row = await loadMutationByKey(client, input.idempotencyKey);
  if (!row) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_session_create_failed",
    );
  }
  assertSameReviewMutation(row, input);
  return row.response_payload;
}

function assertSameOpenMutation(
  row: TelegramFundingMutationRow,
  input: Readonly<{ contextId: string; requestFingerprint: string }>,
): void {
  if (
    row.action !== "open" ||
    row.funding_context_id !== input.contextId ||
    row.request_fingerprint !== input.requestFingerprint ||
    row.consent_revision !== null ||
    row.response_payload.fundingContextId !== input.contextId
  ) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_idempotency_conflict",
    );
  }
}

export async function fetchTelegramFundingOpenMutationReplay(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    idempotencyKey: string;
    requestFingerprint: string;
    userId: string;
    telegramUserId: string;
    chatId: string;
  }>,
): Promise<TelegramFundingSessionContext | null> {
  const row = await loadMutationByKey(pool, input.idempotencyKey);
  if (!row) return null;
  const contextId = row.response_payload.fundingContextId;
  if (typeof contextId !== "string") {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_idempotency_conflict",
    );
  }
  assertSameOpenMutation(row, {
    contextId,
    requestFingerprint: input.requestFingerprint,
  });
  const context = await fetchTelegramFundingSessionContext(pool, {
    contextId,
    userId: input.userId,
    telegramUserId: input.telegramUserId,
    chatId: input.chatId,
  });
  if (!context) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_idempotency_conflict",
    );
  }
  return context;
}

export async function recordTelegramFundingOpenMutation(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    contextId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    now: Date;
  }>,
): Promise<void> {
  await client.query(
    `
      insert into telegram_funding_mutations (
        funding_context_id,
        action,
        idempotency_key,
        request_fingerprint,
        response_payload,
        consent_revision,
        created_at
      ) values ($1, 'open', $2, $3, $4::jsonb, null, $5)
      on conflict (idempotency_key) do nothing
    `,
    [
      input.contextId,
      input.idempotencyKey,
      input.requestFingerprint,
      JSON.stringify({ fundingContextId: input.contextId }),
      input.now,
    ],
  );
  const row = await loadMutationByKey(client, input.idempotencyKey);
  if (!row) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_session_create_failed",
    );
  }
  assertSameOpenMutation(row, input);
}

export async function fetchTelegramFundingMutationReplay(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    action: TelegramFundingMutationAction;
    contextId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }>,
): Promise<JsonRecord | null> {
  const row = await loadMutationByKey(pool, input.idempotencyKey);
  if (!row) return null;
  assertSameMutation(row, input);
  return row.response_payload;
}

function assertSameContextIdentity(
  row: TelegramFundingSessionRow,
  input: Readonly<{
    chatId: string;
    receiveSessionId: string;
    telegramUserId: string;
    userId: string;
  }>,
): void {
  if (
    row.user_id !== input.userId ||
    row.telegram_user_id !== input.telegramUserId ||
    row.chat_id !== input.chatId ||
    row.receive_session_id !== input.receiveSessionId
  ) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_idempotency_conflict",
    );
  }
}

async function loadSessionByIdentity(
  client: PoolClient,
  input: Readonly<{ idempotencyKey: string; receiveSessionId: string }>,
): Promise<TelegramFundingSessionRow | null> {
  const { rows } = await client.query<TelegramFundingSessionRow>(
    `
      select ${sessionColumns}
      from telegram_funding_sessions
      where idempotency_key = $1
         or receive_session_id = $2
      order by (idempotency_key = $1) desc
      for update
      limit 1
    `,
    [input.idempotencyKey, input.receiveSessionId],
  );
  return rows[0] ?? null;
}

type CreateTelegramFundingSessionInput = Readonly<{
  userId: string;
  telegramAccountId: string;
  telegramUserId: string;
  chatId: string;
  telegramMessageId: number | null;
  receiveSessionId: string;
  idempotencyKey: string;
  expiresAt: Date;
  now: Date;
  initialBuyReturn?: Readonly<{
    eventId: string | null;
    marketId: string;
    minimumFundingUsd: string | null;
    requestedSpendUsd: string;
    side: "NO" | "YES";
  }>;
}>;

export async function createOrReuseTelegramFundingSessionInTransaction(
  client: PoolClient,
  input: CreateTelegramFundingSessionInput,
): Promise<
  Readonly<{ context: TelegramFundingSessionContext; replayed: boolean }>
> {
  let existing = await loadSessionByIdentity(client, input);
  if (existing) {
    assertSameContextIdentity(existing, input);
    if (
      input.telegramMessageId != null &&
      existing.telegram_message_id != null &&
      input.telegramMessageId !== Number(existing.telegram_message_id)
    ) {
      // Message ownership changes only through the lifecycle transaction, which
      // also terminalizes the old card. This low-level reuse must never rebind it.
      throw new TelegramFundingPersistenceError(
        "telegram_funding_session_active_elsewhere",
      );
    }
    const refreshed = await client.query<TelegramFundingSessionRow>(
      `
        update telegram_funding_sessions
        set telegram_account_id = $2,
            telegram_message_id = coalesce(telegram_message_id, $3)
        where id = $1
        returning ${sessionColumns}
      `,
      [existing.id, input.telegramAccountId, input.telegramMessageId],
    );
    existing = refreshed.rows[0] ?? existing;
    return { context: publicSession(existing), replayed: true };
  }
  const inserted = await client.query<TelegramFundingSessionRow>(
    `
      insert into telegram_funding_sessions (
        user_id,
        telegram_account_id,
        telegram_user_id,
        chat_id,
        telegram_message_id,
        receive_session_id,
        origin,
        market_id,
        event_id,
        side,
        requested_spend_usd,
        minimum_funding_usd,
        idempotency_key,
        expires_at,
        created_at,
        updated_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric,
        $12::numeric, $13, $14, $15, $15
      )
      on conflict do nothing
      returning ${sessionColumns}
    `,
    [
      input.userId,
      input.telegramAccountId,
      input.telegramUserId,
      input.chatId,
      input.telegramMessageId,
      input.receiveSessionId,
      input.initialBuyReturn ? "buy_return_context" : "generic_add_funds",
      input.initialBuyReturn?.marketId ?? null,
      input.initialBuyReturn?.eventId ?? null,
      input.initialBuyReturn?.side ?? null,
      input.initialBuyReturn?.requestedSpendUsd ?? null,
      input.initialBuyReturn?.minimumFundingUsd ?? null,
      input.idempotencyKey,
      input.expiresAt,
      input.now,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { context: publicSession(created), replayed: false };
  const raced = await loadSessionByIdentity(client, input);
  if (!raced) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_session_create_failed",
    );
  }
  assertSameContextIdentity(raced, input);
  return { context: publicSession(raced), replayed: true };
}

export async function createOrReuseTelegramFundingSession(
  pool: Pool,
  input: CreateTelegramFundingSessionInput,
): Promise<
  Readonly<{ context: TelegramFundingSessionContext; replayed: boolean }>
> {
  return tx(pool, (client) =>
    createOrReuseTelegramFundingSessionInTransaction(client, input),
  );
}

export async function fetchTelegramFundingSessionContext(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    contextId: string;
    telegramUserId: string;
    chatId: string;
    userId: string;
  }>,
): Promise<TelegramFundingSessionContext | null> {
  const { rows } = await pool.query<TelegramFundingSessionRow>(
    `
      select ${sessionColumns}
      from telegram_funding_sessions
      where id = $1
        and user_id = $2
        and telegram_user_id = $3
        and chat_id = $4
      limit 1
    `,
    [input.contextId, input.userId, input.telegramUserId, input.chatId],
  );
  return rows[0] ? publicSession(rows[0]) : null;
}

export async function fetchTelegramFundingSessionByIdempotency(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    idempotencyKey: string;
    telegramUserId: string;
    chatId: string;
    userId: string;
  }>,
): Promise<TelegramFundingSessionContext | null> {
  const { rows } = await pool.query<TelegramFundingSessionRow>(
    `
      select ${sessionColumns}
      from telegram_funding_sessions
      where idempotency_key = $1
        and user_id = $2
        and telegram_user_id = $3
        and chat_id = $4
      limit 1
    `,
    [input.idempotencyKey, input.userId, input.telegramUserId, input.chatId],
  );
  return rows[0] ? publicSession(rows[0]) : null;
}

type ActiveTelegramFundingOpenScope = Readonly<{
  chatId: string;
  controllerWalletId?: string;
  now: Date;
  telegramUserId: string;
  userId: string;
  venueBindingOptionId?: string;
  venueId: string;
}>;

async function lockActiveTelegramFundingOpenContext(
  client: Pick<PoolClient, "query">,
  input: ActiveTelegramFundingOpenScope,
): Promise<
  | (TelegramFundingSessionRow & Readonly<{ has_in_flight_receipt: boolean }>)
  | null
> {
  const { rows } = await client.query<
    TelegramFundingSessionRow & Readonly<{ has_in_flight_receipt: boolean }>
  >(
    `
      select ${qualifiedSessionColumns("context")},
             exists (
               select 1
               from funding_receive_receipts priority_receipt
               where priority_receipt.receive_session_id = receive.id
                 and priority_receipt.status in ('observed', 'routing')
             ) as has_in_flight_receipt
      from telegram_funding_sessions context
      join funding_receive_sessions receive
        on receive.id = context.receive_session_id
       and receive.user_id = context.user_id
       and receive.owner_channel = context.receive_owner_channel
      where context.user_id = $1
        and context.telegram_user_id = $2
        and context.chat_id = $3
        and context.receive_owner_channel = 'telegram'
        and context.cancelled_at is null
        and context.latest_terminal_projection is null
        and receive.owner_channel = 'telegram'
        and receive.venue_id = $5
        and (
          $6::text is null
          or receive.destination_target_snapshot #>>
               '{location,details,controllerWalletId}' = $6
        )
        and ($7::text is null or receive.venue_binding_option_id = $7)
        and (
          (
            context.expires_at > $4
            and
            receive.status = 'open'
            and receive.expires_at > $4
          )
          or (
            receive.observe_until > $4
            and exists (
              select 1
              from funding_receive_receipts active_receipt
              where active_receipt.receive_session_id = receive.id
                and active_receipt.status in ('observed', 'routing')
            )
          )
        )
      order by has_in_flight_receipt desc,
               context.created_at desc,
               context.id desc
      for update of context, receive
      limit 2
    `,
    [
      input.userId,
      input.telegramUserId,
      input.chatId,
      input.now,
      input.venueId,
      input.controllerWalletId ?? null,
      input.venueBindingOptionId ?? null,
    ],
  );
  const inFlight = rows.filter((row) => row.has_in_flight_receipt);
  if (inFlight.length > 1 || (inFlight.length === 0 && rows.length > 1)) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_active_context_ambiguous",
    );
  }
  // A resumed receipt may start routing after a fresh address was opened.
  // The money-bearing workflow is authoritative; an address with no observed
  // funds must not make that durable workflow ambiguous or hide it.
  return inFlight[0] ?? rows[0] ?? null;
}

async function activeTelegramFundingHasLiveRouting(
  client: Pick<PoolClient, "query">,
  receiveSessionId: string,
): Promise<boolean> {
  const { rows } = await client.query<{
    child_funding_operation_id: string | null;
  }>(
    `select distinct receive_receipt.child_funding_operation_id::text
       from funding_receive_receipts receive_receipt
      where receive_receipt.receive_session_id = $1::uuid
        and receive_receipt.status in ('observed', 'routing')`,
    [receiveSessionId],
  );
  for (const receipt of rows) {
    // An observed receipt without a child operation is still a live
    // money-bearing workflow. For a routed child, derive terminality from the
    // same immutable facts used by execution and reconciliation; a stale
    // operation cache must neither retain nor release this receive lease.
    if (receipt.child_funding_operation_id === null) return true;
    const projection = await loadFundingLifecycleProjectionForOperation(
      client,
      { operationId: receipt.child_funding_operation_id },
    );
    if (projection && !projection.lifecycle.safety.terminal) return true;
  }
  return false;
}

async function releaseTerminalTelegramReceiveLease(
  client: Pick<PoolClient, "query">,
  input: ActiveTelegramFundingOpenScope &
    Readonly<{
      destinationOptionId: string;
      venueBindingOptionId: string;
    }>,
): Promise<void> {
  // A terminal Telegram card cannot remain the owner of a reusable receive
  // address. Older projector versions could terminalize the card while leaving
  // its receipt-free receive session open. Without repairing that split state,
  // the receive repository reuses the old session and the Telegram layer finds
  // the old card again, producing an endless "Deposit already active" loop.
  //
  // Keep money-bearing sessions untouched: observed/routing receipts still own
  // the receive lease and must be resumed instead of superseded. Expiring only
  // the address lease preserves late-receipt observation through observe_until.
  await client.query(
    `
      update funding_receive_sessions receive_session
      set status = 'expired',
          closed_at = $7,
          updated_at = $7,
          version = version + 1
      where receive_session.user_id = $1::uuid
        and receive_session.owner_channel = 'telegram'
        and receive_session.venue_id = $4
        and receive_session.destination_option_id = $5
        and receive_session.venue_binding_option_id = $6
        and receive_session.status = 'open'
        and exists (
          select 1
          from telegram_funding_sessions funding_context
          where funding_context.receive_session_id = receive_session.id
            and funding_context.user_id = $1::uuid
            and funding_context.telegram_user_id = $2
            and funding_context.chat_id = $3
            and funding_context.receive_owner_channel = 'telegram'
            and (
              funding_context.cancelled_at is not null
              or funding_context.latest_terminal_projection is not null
            )
        )
        and not exists (
          select 1
          from funding_receive_receipts receipt
          where receipt.receive_session_id = receive_session.id
            and receipt.status in ('observed', 'routing')
        )
    `,
    [
      input.userId,
      input.telegramUserId,
      input.chatId,
      input.venueId,
      input.destinationOptionId,
      input.venueBindingOptionId,
      input.now,
    ],
  );
}

export async function prepareTelegramFundingSessionOpenInTransaction(
  client: PoolClient,
  input: ActiveTelegramFundingOpenScope &
    Readonly<{
      destinationOptionId: string;
      reuseActiveContextForBuyReturn?: boolean;
      supersedeInactiveContextForBuyReturn?: boolean;
      telegramAccountId: string;
      telegramMessageId: number | null;
      venueBindingOptionId: string;
    }>,
): Promise<TelegramFundingSessionContext | null> {
  await lockTelegramFundingLinkLifecycle(client, input.userId);
  await lockFundingReceiveSessionScope(client, input);
  if (input.controllerWalletId) {
    const currentManagedWallet =
      await resolveTelegramFundingManagedWalletIdentity(client, {
        userId: input.userId,
        telegramAccountId: input.telegramAccountId,
        telegramUserId: input.telegramUserId,
      });
    const networkId = telegramFundingVenueNetworkId(input.venueId);
    if (
      !currentManagedWallet ||
      !networkId ||
      telegramFundingManagedWalletControllerId(
        currentManagedWallet,
        networkId,
      ) !== input.controllerWalletId
    ) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_session_unavailable",
      );
    }
  }
  await releaseTerminalTelegramReceiveLease(client, input);
  const active = await lockActiveTelegramFundingOpenContext(client, input);
  if (!active) return null;
  if (
    input.reuseActiveContextForBuyReturn ||
    input.supersedeInactiveContextForBuyReturn
  ) {
    if (active.telegram_account_id !== input.telegramAccountId) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_session_unavailable",
      );
    }
    const hasLiveRouting = await activeTelegramFundingHasLiveRouting(
      client,
      active.receive_session_id,
    );
    if (input.reuseActiveContextForBuyReturn) {
      // A Buy shortfall may attach only while deposited funds are actually
      // being routed. An open address, a completed receipt, or a stale recovery
      // shell is not an active financial workflow.
      return hasLiveRouting ? publicSession(active) : null;
    }
    if (hasLiveRouting) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_session_active_elsewhere",
      );
    }
    const retired = await client.query<{ id: string }>(
      `update funding_receive_sessions receive_session
          set status = 'expired',
              closed_at = $2,
              updated_at = $2,
              version = version + 1
        where receive_session.id = $1::uuid
          and receive_session.owner_channel = 'telegram'
          and receive_session.status = 'open'
        returning receive_session.id`,
      [active.receive_session_id, input.now],
    );
    if (!retired.rows[0]) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_session_active_elsewhere",
      );
    }
    return publicSession(active);
  }
  const sameMessage =
    input.telegramMessageId == null ||
    active.telegram_message_id == null ||
    Number(active.telegram_message_id) === input.telegramMessageId;
  if (sameMessage) return null;
  // Telegram message ids are monotone within a chat. A delayed callback from an
  // older card may observe the current context, but it must never take it back.
  if (input.telegramMessageId < Number(active.telegram_message_id)) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_session_active_elsewhere",
    );
  }
  const closed = await client.query<{ id: string }>(
    `
      update funding_receive_sessions receive
      set status = 'cancelled',
          closed_at = $2,
          updated_at = $2,
          version = version + 1
      where receive.id = $1
        and receive.owner_channel = 'telegram'
        and receive.status = 'open'
        and not exists (
          select 1
          from funding_receive_receipts receipt
          where receipt.receive_session_id = receive.id
            and receipt.status <> 'ready'
        )
      returning receive.id
    `,
    [active.receive_session_id, input.now],
  );
  if (!closed.rows[0]) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_session_active_elsewhere",
    );
  }
  return publicSession(active);
}

export async function finalizeSupersededTelegramFundingSessionInTransaction(
  client: PoolClient,
  input: Readonly<{
    context: TelegramFundingSessionContext;
    fingerprint: string;
    now: Date;
    projection: JsonRecord;
  }>,
): Promise<void> {
  const updated = await client.query<{
    progress_revision: number;
    telegram_account_id: string | null;
    telegram_message_id: string | number | null;
    telegram_user_id: string;
    user_id: string;
  }>(
    `
      update telegram_funding_sessions
      set cancelled_at = coalesce(cancelled_at, $2),
          progress_revision = progress_revision + 1,
          progress_fingerprint = $3,
          latest_progress_projection = $4::jsonb,
          latest_terminal_revision = progress_revision + 1,
          latest_terminal_projection = $4::jsonb,
          projection_checked_at = $2,
          updated_at = $2
      where id = $1
        and cancelled_at is null
        and latest_terminal_projection is null
      returning
        progress_revision,
        telegram_account_id,
        telegram_message_id,
        telegram_user_id,
        user_id
    `,
    [
      input.context.id,
      input.now,
      input.fingerprint,
      JSON.stringify(input.projection),
    ],
  );
  const terminal = updated.rows[0];
  if (!terminal) {
    throw new TelegramFundingPersistenceError(
      "telegram_funding_session_unavailable",
    );
  }
  await client.query(
    `
      update telegram_bot_action_outbox
      set status = 'skipped',
          last_error = 'funding_session_superseded',
          updated_at = $2
      where funding_session_id = $1
        and action in (
          'funding_send',
          'funding_edit',
          'funding_replacement',
          'funding_qr'
        )
        and status in ('pending', 'retry')
    `,
    [input.context.id, input.now],
  );
  await client.query(
    `
      update telegram_bot_action_outbox
      set state_revision = $2,
          payload = $3::jsonb,
          status = 'pending',
          attempt_count = 0,
          next_attempt_at = now(),
          last_error = null,
          sent_at = null,
          delivery_attempt_id = null,
          delivery_started_at = null,
          updated_at = now()
      where funding_session_id = $1
        and action = 'funding_qr'
        and telegram_message_id is not null
        and telegram_message_id is distinct from $4::bigint
        and status not in ('sending', 'delivery_unknown')
    `,
    [
      input.context.id,
      terminal.progress_revision,
      JSON.stringify(input.projection),
      terminal.telegram_message_id,
    ],
  );
  if (terminal.telegram_message_id == null) return;
  await client.query(
    `
      insert into telegram_bot_action_outbox (
        action,
        telegram_account_id,
        user_id,
        telegram_user_id,
        funding_session_id,
        state_revision,
        payload
      ) values ('funding_edit', $1, $2, $3, $4, $5, $6::jsonb)
      on conflict do nothing
    `,
    [
      terminal.telegram_account_id,
      terminal.user_id,
      terminal.telegram_user_id,
      input.context.id,
      terminal.progress_revision,
      JSON.stringify(input.projection),
    ],
  );
}

export async function reuseActiveTelegramFundingSession(
  pool: Pool,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    chatId: string;
    telegramMessageId: number | null;
    venueId: string;
    controllerWalletId?: string;
    venueBindingOptionId?: string;
    presentAcrossMessages?: boolean;
    presentInFlightAcrossMessages?: boolean;
    idempotencyKey: string;
    requestFingerprint: string;
    now: Date;
  }>,
): Promise<TelegramFundingSessionContext | null> {
  return tx(pool, async (client) => {
    await lockTelegramFundingLinkLifecycle(client, input.userId);
    if (input.controllerWalletId) {
      const currentManagedWallet =
        await resolveTelegramFundingManagedWalletIdentity(client, {
          userId: input.userId,
          telegramAccountId: input.telegramAccountId,
          telegramUserId: input.telegramUserId,
        });
      const networkId = telegramFundingVenueNetworkId(input.venueId);
      if (
        !currentManagedWallet ||
        !networkId ||
        telegramFundingManagedWalletControllerId(
          currentManagedWallet,
          networkId,
        ) !== input.controllerWalletId
      ) {
        return null;
      }
    }
    const active = await lockActiveTelegramFundingOpenContext(client, input);
    if (!active) return null;
    const opensInAnotherMessage =
      input.telegramMessageId != null &&
      active.telegram_message_id != null &&
      Number(active.telegram_message_id) !== input.telegramMessageId;
    if (opensInAnotherMessage) {
      // A Telegram message owns its context: reusing another message makes
      // the new button look inert. The final open transaction owns the
      // supersede decision so two messages cannot both pass this preflight.
      if (
        !input.presentAcrossMessages &&
        !(input.presentInFlightAcrossMessages && active.has_in_flight_receipt)
      ) {
        return null;
      }
      await recordTelegramFundingOpenMutation(client, {
        contextId: active.id,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        now: input.now,
      });
      return publicSession(active);
    }
    const refreshed = await client.query<TelegramFundingSessionRow>(
      `
        update telegram_funding_sessions
        set telegram_account_id = $2,
            telegram_message_id = case
              when address_disclosure_attempt_revision = 0
                then coalesce($3, telegram_message_id)
              else telegram_message_id
            end
        where id = $1
        returning ${sessionColumns}
      `,
      [active.id, input.telegramAccountId, input.telegramMessageId],
    );
    await recordTelegramFundingOpenMutation(client, {
      contextId: active.id,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      now: input.now,
    });
    return publicSession(refreshed.rows[0] ?? active);
  });
}

export type TelegramFundingSelectionSnapshot = Readonly<{
  context: TelegramFundingSessionContext;
  receiveTargets: ReceiveTargets;
  observationVariants: readonly DirectIngressObservationVariant[];
  automationPolicy: FundingReceiveAutomationPolicy;
}>;

export async function fetchTelegramFundingSelectionSnapshot(
  pool: Pick<Pool, "query">,
  input: Readonly<{
    contextId: string;
    telegramUserId: string;
    telegramMessageId: number | null;
    chatId: string;
    userId: string;
  }>,
): Promise<TelegramFundingSelectionSnapshot | null> {
  const { rows } = await pool.query<
    TelegramFundingSessionRow & {
      receive_targets: ReceiveTargets;
      observation_variants: readonly DirectIngressObservationVariant[];
      automation_policy: FundingReceiveAutomationPolicy;
    }
  >(
    `
      select
        ${sessionColumns
          .split("\n")
          .map((column) => (column.trim() ? `context.${column.trim()}` : ""))
          .join("\n")},
        receive.receive_targets,
        receive.observation_variants,
        receive.automation_policy
      from telegram_funding_sessions context
      join funding_receive_sessions receive
        on receive.id = context.receive_session_id
       and receive.user_id = context.user_id
      where context.id = $1
        and context.user_id = $2
        and context.telegram_user_id = $3
        and context.chat_id = $4
        and context.telegram_message_id is not distinct from $5::bigint
      limit 1
    `,
    [
      input.contextId,
      input.userId,
      input.telegramUserId,
      input.chatId,
      input.telegramMessageId,
    ],
  );
  const row = rows[0];
  return row
    ? {
        context: publicSession(row),
        receiveTargets: row.receive_targets,
        observationVariants: row.observation_variants,
        automationPolicy: row.automation_policy,
      }
    : null;
}

export async function appendTelegramFundingConsent(
  pool: Pool,
  input: Readonly<{
    contextId: string;
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    chatId: string;
    telegramMessageId: number | null;
    controllerWalletId: string;
    retainedSourceWalletAddress?: string;
    receiveTargetId: string;
    asset: AssetRef;
    variantIds: readonly string[];
    automationEnabled?: boolean;
    maximumAutomaticRaw?: string | null;
    policySnapshot: JsonRecord;
    fingerprint: string;
    mutation?: Readonly<{
      idempotencyKey: string;
      requestFingerprint: string;
      responsePayload: JsonRecord;
    }>;
    now: Date;
  }>,
): Promise<
  Readonly<{
    consent: TelegramFundingConsent;
    context: TelegramFundingSessionContext;
    replayed: boolean;
    mutationResponse: JsonRecord | null;
  }>
> {
  return tx(pool, async (client) => {
    if (input.mutation) {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`telegram-funding-mutation:${input.mutation.idempotencyKey}`],
      );
      const existingMutation = await loadMutationByKey(
        client,
        input.mutation.idempotencyKey,
      );
      if (existingMutation) {
        assertSameMutation(existingMutation, {
          action: "select_target",
          contextId: input.contextId,
          requestFingerprint: input.mutation.requestFingerprint,
        });
        const contextResult = await client.query<TelegramFundingSessionRow>(
          `select ${sessionColumns} from telegram_funding_sessions where id = $1`,
          [input.contextId],
        );
        const consentResult = await client.query<TelegramFundingConsentRow>(
          `
            select *
            from telegram_funding_consents
            where telegram_funding_session_id = $1
              and revision = $2
            limit 1
          `,
          [input.contextId, existingMutation.consent_revision],
        );
        const replayContext = contextResult.rows[0];
        const replayConsent = consentResult.rows[0];
        if (!replayContext || !replayConsent) {
          throw new TelegramFundingPersistenceError(
            "telegram_funding_mutation_replay_invalid",
          );
        }
        await client.query(
          `
            with request_clock as (
              select clock_timestamp() as requested_at
            )
            update funding_receive_sessions receive_session
            set observation_requested_at = greatest(
                  coalesce(
                    receive_session.observation_requested_at,
                    request_clock.requested_at
                  ),
                  request_clock.requested_at
                ),
                updated_at = greatest(
                  receive_session.updated_at,
                  request_clock.requested_at
                )
            from request_clock
            where receive_session.id = $1
              and receive_session.user_id = $2
              and (
                (
                  receive_session.status in ('open', 'processing', 'review_required')
                  and receive_session.expires_at > request_clock.requested_at
                )
                or (
                  receive_session.status = 'recovery_required'
                  and receive_session.observe_until > request_clock.requested_at
                )
              )
          `,
          [replayContext.receive_session_id, input.userId],
        );
        return {
          consent: publicConsent(replayConsent),
          context: publicSession(replayContext),
          replayed: true,
          mutationResponse: existingMutation.response_payload,
        };
      }
    }
    await lockTelegramFundingLinkLifecycle(client, input.userId);
    const locked = await client.query<TelegramFundingSessionRow>(
      `
        select ${qualifiedSessionColumns("context")}
        from telegram_funding_sessions context
        where context.id = $1
          and context.user_id = $2
          and context.telegram_user_id = $3
          and context.chat_id = $4
          and context.telegram_message_id is not distinct from $7::bigint
          and context.cancelled_at is null
          and context.expires_at > $6
          and context.latest_terminal_projection is null
          and exists (
            select 1
            from user_telegram_accounts account
            where account.id = $5
              and account.user_id = context.user_id
              and account.telegram_user_id = context.telegram_user_id
          )
        for update of context
      `,
      [
        input.contextId,
        input.userId,
        input.telegramUserId,
        input.chatId,
        input.telegramAccountId,
        input.now,
        input.telegramMessageId,
      ],
    );
    const contextRow = locked.rows[0];
    if (!contextRow) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_session_unavailable",
      );
    }
    if (
      sameAsset(input.asset, SOLANA_NATIVE_ASSET) &&
      contextRow.origin !== "generic_add_funds"
    ) {
      const retainedSourceCapability = await client.query<{
        app_handoff_active: boolean;
      }>(
        `
          select exists (
            select 1
            from telegram_funding_sessions funding_context
            join telegram_funding_buy_return_revisions buy_return
              on buy_return.telegram_funding_session_id = funding_context.id
             and buy_return.revision = funding_context.active_buy_return_revision
            where funding_context.id = $1
              and funding_context.origin = 'buy_return_context'
              and buy_return.continuation_mode = 'app_handoff'
          ) as app_handoff_active
        `,
        [input.contextId],
      );
      if (retainedSourceCapability.rows[0]?.app_handoff_active !== true) {
        throw new TelegramFundingPersistenceError(
          "telegram_funding_session_unavailable",
        );
      }
    }
    const canonical = await client.query<{
      controller_wallet_id: string | null;
      destination_network_id: string | null;
      destination_option_id: string;
      id: string;
      observation_variants: readonly unknown[];
      venue_binding_option_id: string;
    }>(
      `
        select
          receive.id,
          receive.destination_target_snapshot #>>
            '{location,details,controllerWalletId}' as controller_wallet_id,
          receive.destination_asset ->> 'networkId' as destination_network_id,
          receive.destination_option_id,
          receive.observation_variants,
          receive.venue_binding_option_id
        from funding_receive_sessions receive
        where receive.id = $1
          and receive.user_id = $2
          and receive.owner_channel = 'telegram'
          and receive.status = 'open'
          and receive.expires_at > $3
          and not exists (
            select 1
            from funding_receive_receipts receipt
            where receipt.receive_session_id = receive.id
          )
        for update of receive
      `,
      [contextRow.receive_session_id, input.userId, input.now],
    );
    if (!canonical.rows[0]) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_session_unavailable",
      );
    }
    const canonicalReceive = canonical.rows[0];
    const frozenControllerWalletId =
      canonicalReceive.controller_wallet_id?.trim() ?? "";
    const destinationNetworkId =
      canonicalReceive.destination_network_id?.trim() ?? "";
    const currentManagedWallet =
      await resolveTelegramFundingManagedWalletIdentity(client, {
        userId: input.userId,
        telegramAccountId: input.telegramAccountId,
        telegramUserId: input.telegramUserId,
      });
    if (
      !frozenControllerWalletId ||
      frozenControllerWalletId !== input.controllerWalletId ||
      !currentManagedWallet ||
      telegramFundingManagedWalletControllerId(
        currentManagedWallet,
        destinationNetworkId,
      ) !== frozenControllerWalletId
    ) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_session_unavailable",
      );
    }
    if (sameAsset(input.asset, SOLANA_NATIVE_ASSET)) {
      const retainedSourceWalletAddress =
        input.retainedSourceWalletAddress?.trim() ?? "";
      let selectedVariant: DirectIngressObservationVariant | null = null;
      try {
        const variants = Array.isArray(canonicalReceive.observation_variants)
          ? canonicalReceive.observation_variants.map(
              parseDirectIngressObservationVariant,
            )
          : [];
        selectedVariant =
          input.variantIds.length === 1
            ? (variants.find(
                (variant) => variant.variantId === input.variantIds[0],
              ) ?? null)
            : null;
      } catch {
        selectedVariant = null;
      }
      if (
        !retainedSourceWalletAddress ||
        !selectedVariant ||
        selectedVariant.completion.kind !== "retained_owned_source_credit" ||
        !sameAsset(selectedVariant.asset, SOLANA_NATIVE_ASSET) ||
        selectedVariant.networkId !== SOLANA_NATIVE_ASSET.networkId ||
        !sameAccountAddress(
          SOLANA_NATIVE_ASSET.networkId,
          selectedVariant.destinationAddress,
          retainedSourceWalletAddress,
        ) ||
        !(await isTelegramFundingManagedSolanaWalletCurrent(client, {
          lock: true,
          telegramAccountId: input.telegramAccountId,
          telegramUserId: input.telegramUserId,
          userId: input.userId,
          walletAddress: retainedSourceWalletAddress,
        }))
      ) {
        throw new TelegramFundingPersistenceError(
          "telegram_funding_session_unavailable",
        );
      }
    }
    if (input.automationEnabled) {
      const capability = await resolveTelegramFundingAutomaticCapability(
        client,
        {
          policySnapshot: input.policySnapshot,
          userId: input.userId,
          telegramAccountId: input.telegramAccountId,
          telegramUserId: input.telegramUserId,
          destinationOptionId: canonicalReceive.destination_option_id,
          venueBindingOptionId: canonicalReceive.venue_binding_option_id,
          now: input.now,
          lock: true,
        },
      );
      if (
        !capability?.authorization ||
        capability.decision.kind !== "allowed"
      ) {
        throw new TelegramFundingPersistenceError(
          "telegram_funding_session_unavailable",
        );
      }
    }
    const existing = await client.query<TelegramFundingConsentRow>(
      `
        select *
        from telegram_funding_consents
        where telegram_funding_session_id = $1
          and consent_fingerprint = $2
        limit 1
      `,
      [input.contextId, input.fingerprint],
    );
    let consent = existing.rows[0] ?? null;
    let replayed = consent != null;
    if (!consent) {
      const nextRevision = await client.query<{ revision: number }>(
        `
          select coalesce(max(revision), 0)::int + 1 as revision
          from telegram_funding_consents
          where telegram_funding_session_id = $1
        `,
        [input.contextId],
      );
      const revision = nextRevision.rows[0]?.revision ?? 1;
      const inserted = await client.query<TelegramFundingConsentRow>(
        `
          insert into telegram_funding_consents (
            telegram_funding_session_id,
            revision,
            selected_receive_target_id,
            selected_asset_network_id,
            selected_asset_id,
            selected_asset_decimals,
            consented_variant_ids,
            automation_enabled,
            max_auto_execute_source_raw,
            automation_policy_snapshot,
            consent_fingerprint,
            consented_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10::jsonb, $11, $12
          )
          returning *
        `,
        [
          input.contextId,
          revision,
          input.receiveTargetId,
          input.asset.networkId,
          input.asset.assetId,
          input.asset.decimals,
          Array.from(new Set(input.variantIds)).sort(),
          input.automationEnabled === true,
          input.maximumAutomaticRaw ?? null,
          JSON.stringify(input.policySnapshot),
          input.fingerprint,
          input.now,
        ],
      );
      consent = inserted.rows[0] ?? null;
      replayed = false;
    }
    if (!consent) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_consent_create_failed",
      );
    }
    const updated = await client.query<TelegramFundingSessionRow>(
      `
        update telegram_funding_sessions
        set telegram_account_id = $2,
            telegram_message_id = case
              when address_disclosure_attempt_revision = 0
                then coalesce($3, telegram_message_id)
              else telegram_message_id
            end,
            active_consent_revision = $4
        where id = $1
        returning ${sessionColumns}
      `,
      [
        input.contextId,
        input.telegramAccountId,
        input.telegramMessageId,
        consent.revision,
      ],
    );
    const nextContext = updated.rows[0];
    if (!nextContext) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_consent_activate_failed",
      );
    }
    if (input.mutation) {
      await client.query(
        `
          insert into telegram_funding_mutations (
            funding_context_id,
            action,
            idempotency_key,
            request_fingerprint,
            response_payload,
            consent_revision,
            created_at
          ) values ($1, 'select_target', $2, $3, $4::jsonb, $5, $6)
        `,
        [
          input.contextId,
          input.mutation.idempotencyKey,
          input.mutation.requestFingerprint,
          JSON.stringify(input.mutation.responsePayload),
          consent.revision,
          input.now,
        ],
      );
    }
    await client.query(
      `
        with request_clock as (
          select clock_timestamp() as requested_at
        )
        update funding_receive_sessions receive_session
        set observation_requested_at = greatest(
              coalesce(
                receive_session.observation_requested_at,
                request_clock.requested_at
              ),
              request_clock.requested_at
            ),
            updated_at = greatest(
              receive_session.updated_at,
              request_clock.requested_at
            )
        from request_clock
        where receive_session.id = $1
          and receive_session.user_id = $2
          and (
            (
              receive_session.status in ('open', 'processing', 'review_required')
              and receive_session.expires_at > request_clock.requested_at
            )
            or (
              receive_session.status = 'recovery_required'
              and receive_session.observe_until > request_clock.requested_at
            )
          )
      `,
      [contextRow.receive_session_id, input.userId],
    );
    return {
      consent: publicConsent(consent),
      context: publicSession(nextContext),
      replayed,
      mutationResponse: null,
    };
  });
}

export async function fetchActiveTelegramFundingConsent(
  pool: Pick<Pool, "query">,
  fundingContextId: string,
): Promise<TelegramFundingConsent | null> {
  const { rows } = await pool.query<TelegramFundingConsentRow>(
    `
      select consent.*
      from telegram_funding_sessions context
      join telegram_funding_consents consent
        on consent.telegram_funding_session_id = context.id
       and consent.revision = context.active_consent_revision
      where context.id = $1
      limit 1
    `,
    [fundingContextId],
  );
  return rows[0] ? publicConsent(rows[0]) : null;
}

export async function cancelTelegramFundingSessionContext(
  pool: Pool,
  input: Readonly<{
    contextId: string;
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    chatId: string;
    telegramMessageId: number | null;
    idempotencyKey: string;
    requestFingerprint: string;
    responsePayload: JsonRecord;
    now: Date;
  }>,
): Promise<Readonly<{
  context: TelegramFundingSessionContext;
  mutationResponse: JsonRecord | null;
}> | null> {
  return tx(pool, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`telegram-funding-mutation:${input.idempotencyKey}`],
    );
    const existingMutation = await loadMutationByKey(
      client,
      input.idempotencyKey,
    );
    if (existingMutation) {
      assertSameMutation(existingMutation, {
        action: "cancel",
        contextId: input.contextId,
        requestFingerprint: input.requestFingerprint,
      });
      const replay = await client.query<TelegramFundingSessionRow>(
        `select ${sessionColumns} from telegram_funding_sessions where id = $1`,
        [input.contextId],
      );
      const replayContext = replay.rows[0];
      return replayContext
        ? {
            context: publicSession(replayContext),
            mutationResponse: existingMutation.response_payload,
          }
        : null;
    }
    // Cancel participates in the same lifecycle fence as address egress. Once
    // this transaction commits, an older claimed delivery must observe the
    // closed context at its final pre-egress CAS instead of revealing it.
    await lockTelegramFundingLinkLifecycle(client, input.userId);
    const locked = await client.query<TelegramFundingSessionRow>(
      `
        select ${qualifiedSessionColumns("context")}
        from telegram_funding_sessions context
        join funding_receive_sessions receive
          on receive.id = context.receive_session_id
         and receive.user_id = context.user_id
         and receive.owner_channel = context.receive_owner_channel
        where context.id = $1
          and context.user_id = $2
          and context.telegram_user_id = $3
          and context.chat_id = $4
          and context.telegram_message_id is not distinct from $6::bigint
          and context.receive_owner_channel = 'telegram'
          and exists (
            select 1
            from user_telegram_accounts account
            where account.id = $5
              and account.user_id = context.user_id
              and account.telegram_user_id = context.telegram_user_id
          )
        for update of context, receive
      `,
      [
        input.contextId,
        input.userId,
        input.telegramUserId,
        input.chatId,
        input.telegramAccountId,
        input.telegramMessageId,
      ],
    );
    const contextRow = locked.rows[0];
    if (!contextRow) return null;
    const updated = await client.query<TelegramFundingSessionRow>(
      `
        update telegram_funding_sessions
        set cancelled_at = coalesce(cancelled_at, $2),
            telegram_message_id = case
              when address_disclosure_attempt_revision = 0
                then coalesce($3, telegram_message_id)
              else telegram_message_id
            end
        where id = $1
          and not exists (
            select 1
            from funding_receive_receipts receipt
            where receipt.receive_session_id = $4::uuid
              and receipt.status <> 'ready'
          )
        returning ${sessionColumns}
      `,
      [
        input.contextId,
        input.now,
        input.telegramMessageId,
        contextRow.receive_session_id,
      ],
    );
    if (!updated.rows[0]) {
      throw new Error("telegram_funding_money_boundary_crossed");
    }
    await client.query(
      `
        update telegram_trade_intents trade_intent
        set status = 'cancelled',
            updated_at = $2
        from telegram_funding_sessions context
        join telegram_funding_buy_return_revisions buy_return
          on buy_return.telegram_funding_session_id = context.id
         and buy_return.revision = context.active_buy_return_revision
        where context.id = $1
          and trade_intent.id = buy_return.source_shortfall_intent_id
          and trade_intent.status in ('draft', 'previewed')
          and trade_intent.confirmed_at is null
          and trade_intent.submitted_at is null
          and trade_intent.order_id is null
          and trade_intent.execution_id is null
          and trade_intent.venue_order_id is null
          and trade_intent.tx_signature is null
      `,
      [input.contextId, input.now],
    );
    await client.query(
      `
        update funding_receive_sessions receive
        set status = 'cancelled',
            closed_at = $2,
            updated_at = $2,
            version = version + 1
        where receive.id = $1
          and receive.owner_channel = 'telegram'
          and receive.status = 'open'
          and not exists (
            select 1
            from funding_receive_receipts receipt
            where receipt.receive_session_id = receive.id
              and receipt.status <> 'ready'
          )
      `,
      [contextRow.receive_session_id, input.now],
    );
    await client.query(
      `
        update telegram_bot_action_outbox outbox
        set status = 'skipped',
            last_error = 'funding_session_cancelled',
            updated_at = $2
        where outbox.funding_session_id = $1
          and outbox.action in ('funding_send', 'funding_edit', 'funding_replacement', 'funding_qr')
          and outbox.status in ('pending', 'retry')
          and (
            jsonb_typeof(outbox.payload->'receiveAddress') = 'string'
            or outbox.action = 'funding_qr'
          )
      `,
      [input.contextId, input.now],
    );
    await client.query(
      `
        insert into telegram_funding_mutations (
          funding_context_id,
          action,
          idempotency_key,
          request_fingerprint,
          response_payload,
          consent_revision,
          created_at
        ) values ($1, 'cancel', $2, $3, $4::jsonb, null, $5)
      `,
      [
        input.contextId,
        input.idempotencyKey,
        input.requestFingerprint,
        JSON.stringify(input.responsePayload),
        input.now,
      ],
    );
    return {
      context: publicSession(updated.rows[0]),
      mutationResponse: null,
    };
  });
}
