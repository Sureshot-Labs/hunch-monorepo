import { tx, type Pool, type PoolClient } from "@hunch/infra";

import type {
  AssetRef,
  ExternalIngressInstruction,
  FundingReceiveAutomationPolicy,
  JsonValue,
} from "../funding/domain/types.js";
import type { DirectIngressObservationVariant } from "../funding/reconciliation/direct-ingress-observer.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type ReceiveTargets = NonNullable<ExternalIngressInstruction["receiveTargets"]>;

export class TelegramFundingPersistenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TelegramFundingPersistenceError";
  }
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
  active_consent_revision: number | null;
  expires_at: Date;
  cancelled_at: Date | null;
  progress_revision: number;
  latest_progress_projection: JsonRecord | null;
  latest_terminal_revision: number | null;
  latest_terminal_projection: JsonRecord | null;
  last_delivered_revision: number;
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

type TelegramFundingMutationAction = "cancel" | "open" | "select_target";

type TelegramFundingMutationRow = Readonly<{
  funding_context_id: string;
  action: TelegramFundingMutationAction;
  idempotency_key: string;
  request_fingerprint: string;
  response_payload: JsonRecord;
  consent_revision: number | null;
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
  expiresAt: string;
  cancelledAt: string | null;
  progressRevision: number;
  latestProgressProjection: JsonRecord | null;
  latestTerminalRevision: number | null;
  latestTerminalProjection: JsonRecord | null;
  lastDeliveredRevision: number;
  createdAt: string;
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
  active_consent_revision,
  expires_at,
  cancelled_at,
  progress_revision,
  latest_progress_projection,
  latest_terminal_revision,
  latest_terminal_projection,
  last_delivered_revision,
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
    activeConsentRevision: row.active_consent_revision,
    expiresAt: row.expires_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    progressRevision: row.progress_revision,
    latestProgressProjection: row.latest_progress_projection,
    latestTerminalRevision: row.latest_terminal_revision,
    latestTerminalProjection: row.latest_terminal_projection,
    lastDeliveredRevision: row.last_delivered_revision,
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
        consent_revision
      from telegram_funding_mutations
      where idempotency_key = $1
      limit 1
    `,
    [idempotencyKey],
  );
  return rows[0] ?? null;
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
    const refreshed = await client.query<TelegramFundingSessionRow>(
      `
        update telegram_funding_sessions
        set telegram_account_id = $2,
            telegram_message_id = coalesce($3, telegram_message_id)
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
        idempotency_key,
        expires_at,
        created_at,
        updated_at
      ) values ($1, $2, $3, $4, $5, $6, 'generic_add_funds', $7, $8, $9, $9)
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

export async function reuseActiveTelegramFundingSession(
  pool: Pool,
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    chatId: string;
    telegramMessageId: number | null;
    venueId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    now: Date;
  }>,
): Promise<TelegramFundingSessionContext | null> {
  return tx(pool, async (client) => {
    const { rows } = await client.query<TelegramFundingSessionRow>(
      `
        select ${qualifiedSessionColumns("context")}
        from telegram_funding_sessions context
        join funding_receive_sessions receive
          on receive.id = context.receive_session_id
         and receive.user_id = context.user_id
         and receive.owner_channel = context.receive_owner_channel
        where context.user_id = $1
          and context.telegram_user_id = $2
          and context.chat_id = $3
          and context.origin = 'generic_add_funds'
          and context.receive_owner_channel = 'telegram'
          and context.cancelled_at is null
          and context.latest_terminal_projection is null
          and context.expires_at > $4
          and receive.owner_channel = 'telegram'
          and receive.venue_id = $5
          and receive.status in ('open', 'processing', 'review_required')
          and receive.expires_at > $4
        order by context.created_at desc, context.id desc
        for update of context
        limit 2
      `,
      [
        input.userId,
        input.telegramUserId,
        input.chatId,
        input.now,
        input.venueId,
      ],
    );
    if (rows.length > 1) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_active_context_ambiguous",
      );
    }
    const active = rows[0];
    if (!active) return null;
    const refreshed = await client.query<TelegramFundingSessionRow>(
      `
        update telegram_funding_sessions
        set telegram_account_id = $2,
            telegram_message_id = coalesce($3, telegram_message_id)
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
      limit 1
    `,
    [input.contextId, input.userId, input.telegramUserId, input.chatId],
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
    receiveTargetId: string;
    asset: AssetRef;
    variantIds: readonly string[];
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
        const [contextResult, consentResult] = await Promise.all([
          client.query<TelegramFundingSessionRow>(
            `select ${sessionColumns} from telegram_funding_sessions where id = $1`,
            [input.contextId],
          ),
          client.query<TelegramFundingConsentRow>(
            `
              select *
              from telegram_funding_consents
              where telegram_funding_session_id = $1
                and revision = $2
              limit 1
            `,
            [input.contextId, existingMutation.consent_revision],
          ),
        ]);
        const replayContext = contextResult.rows[0];
        const replayConsent = consentResult.rows[0];
        if (!replayContext || !replayConsent) {
          throw new TelegramFundingPersistenceError(
            "telegram_funding_mutation_replay_invalid",
          );
        }
        return {
          consent: publicConsent(replayConsent),
          context: publicSession(replayContext),
          replayed: true,
          mutationResponse: existingMutation.response_payload,
        };
      }
    }
    const locked = await client.query<TelegramFundingSessionRow>(
      `
        select ${qualifiedSessionColumns("context")}
        from telegram_funding_sessions context
        where context.id = $1
          and context.user_id = $2
          and context.telegram_user_id = $3
          and context.chat_id = $4
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
      ],
    );
    const contextRow = locked.rows[0];
    if (!contextRow) {
      throw new TelegramFundingPersistenceError(
        "telegram_funding_session_unavailable",
      );
    }
    const canonical = await client.query<{ id: string }>(
      `
        select receive.id
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
          ) values ($1, $2, $3, $4, $5, $6, $7::text[], false, null, $8::jsonb, $9, $10)
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
            telegram_message_id = coalesce($3, telegram_message_id),
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
      ],
    );
    const contextRow = locked.rows[0];
    if (!contextRow) return null;
    const updated = await client.query<TelegramFundingSessionRow>(
      `
        update telegram_funding_sessions
        set cancelled_at = coalesce(cancelled_at, $2),
            telegram_message_id = coalesce($3, telegram_message_id)
        where id = $1
        returning ${sessionColumns}
      `,
      [input.contextId, input.now, input.telegramMessageId],
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
          )
      `,
      [contextRow.receive_session_id, input.now],
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
    const nextContext = updated.rows[0];
    return nextContext
      ? { context: publicSession(nextContext), mutationResponse: null }
      : null;
  });
}
