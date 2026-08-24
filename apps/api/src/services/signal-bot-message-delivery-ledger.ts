import crypto from "node:crypto";

import type { DbQuery } from "../db.js";
import type { SignalBotMessageKind } from "./signal-bot-contracts.js";

const DELIVERY_STATE_VERSION = 2;
const STALE_DELIVERY_MS = 5 * 60_000;

type DeliveryLedgerStatus =
  | "blocked"
  | "delivery_unknown"
  | "queued"
  | "reserved"
  | "retry"
  | "sending"
  | "sent"
  | "skipped";

export type SignalBotMessageDeliverySnapshot = {
  attemptId: string | null;
  status: DeliveryLedgerStatus;
};

type DeliveryLedgerRow = {
  id: string;
  metrics: unknown;
  telegram_message_id: string | number | null;
};

export type SignalBotDeliveryReservation =
  | { attemptId: string; deliveryRef: string; status: "acquired" }
  | { status: "active" | "unavailable" }
  | {
      outcome: "blocked" | "delivery_unknown" | "sent" | "skipped";
      status: "terminal";
    };

function deliveryState(input: {
  attemptId: string | null;
  at: Date;
  errorCode?: string | null;
  nextAttemptAt?: Date | null;
  status: DeliveryLedgerStatus;
}): Record<string, unknown> {
  return {
    deliveryStateV2: {
      attemptId: input.attemptId,
      errorCode: input.errorCode ?? null,
      nextAttemptAt: input.nextAttemptAt?.toISOString() ?? null,
      status: input.status,
      updatedAt: input.at.toISOString(),
      version: DELIVERY_STATE_VERSION,
    },
    status: input.status,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rowStatus(row: DeliveryLedgerRow): SignalBotDeliveryReservation {
  if (row.telegram_message_id != null) {
    return { outcome: "sent", status: "terminal" };
  }
  const metrics = record(row.metrics);
  const state = record(metrics.deliveryStateV2);
  const status = state.status ?? metrics.status;
  if (
    status === "sent" ||
    status === "skipped" ||
    status === "blocked" ||
    status === "delivery_unknown"
  ) {
    return { outcome: status, status: "terminal" };
  }
  return { status: "active" };
}

export async function getSignalBotMessageDeliverySnapshot(input: {
  db: DbQuery;
  deliveryRef: string;
}): Promise<SignalBotMessageDeliverySnapshot | null> {
  const result = await input.db.query<DeliveryLedgerRow>(
    `
      select id::text, telegram_message_id, metrics
      from signal_bot_messages
      where id = $1::uuid
      limit 1
    `,
    [input.deliveryRef],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.telegram_message_id != null) {
    return { attemptId: null, status: "sent" };
  }
  const metrics = record(row.metrics);
  const state = record(metrics.deliveryStateV2);
  const status = state.status ?? metrics.status;
  const validStatuses: DeliveryLedgerStatus[] = [
    "blocked",
    "delivery_unknown",
    "queued",
    "reserved",
    "retry",
    "sending",
    "sent",
    "skipped",
  ];
  if (!validStatuses.includes(status as DeliveryLedgerStatus)) return null;
  return {
    attemptId: typeof state.attemptId === "string" ? state.attemptId : null,
    status: status as DeliveryLedgerStatus,
  };
}

export async function reserveSignalBotMessageDelivery(input: {
  baselineAt: string;
  baseMetrics?: Record<string, unknown>;
  chatId: string;
  db: DbQuery;
  messageKind: SignalBotMessageKind;
  noteId: string;
  now?: Date;
  recoverTerminalSkip?: boolean;
  replyToMessageId: number | null;
  threadRootNoteId: string;
}): Promise<SignalBotDeliveryReservation> {
  const now = input.now ?? new Date();
  const attemptId = crypto.randomUUID();
  const deliveryRef = crypto.randomUUID();
  const state = {
    ...(input.baseMetrics ?? {}),
    ...deliveryState({ attemptId, at: now, status: "reserved" }),
  };
  try {
    const acquired = await input.db.query<{ id: string }>(
      `
        insert into signal_bot_messages (
          id,
          chat_id,
          note_id,
          thread_root_note_id,
          message_kind,
          telegram_message_id,
          reply_to_message_id,
          baseline_at,
          sent_at,
          metrics
        ) values (
          $1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7,
          $8::timestamptz, $9::timestamptz, $10::jsonb
        )
        on conflict (chat_id, note_id, message_kind)
        do update set
          reply_to_message_id = excluded.reply_to_message_id,
          baseline_at = excluded.baseline_at,
          sent_at = excluded.sent_at,
          metrics = (
            signal_bot_messages.metrics - 'deliveryStateV2' - 'status'
          ) || excluded.metrics
        where (
          signal_bot_messages.metrics #>> '{deliveryStateV2,version}' = '2'
          and signal_bot_messages.metrics #>> '{deliveryStateV2,status}' = 'retry'
          and coalesce(
            (signal_bot_messages.metrics #>> '{deliveryStateV2,nextAttemptAt}')::timestamptz,
            '-infinity'::timestamptz
          ) <= $9::timestamptz
        ) or (
          signal_bot_messages.metrics #>> '{deliveryStateV2,version}' = '2'
          and signal_bot_messages.metrics #>> '{deliveryStateV2,status}' = 'reserved'
          and signal_bot_messages.sent_at <= $11::timestamptz
        ) or (
          signal_bot_messages.metrics #>> '{deliveryStateV2,version}' is null
          and signal_bot_messages.metrics->>'status' = 'compose_failed'
        ) or (
          $12::boolean
          and signal_bot_messages.telegram_message_id is null
          and coalesce(signal_bot_messages.metrics->>'status', '') = 'skipped'
        )
        returning id::text as id
      `,
      [
        deliveryRef,
        input.chatId,
        input.noteId,
        input.threadRootNoteId,
        input.messageKind,
        null,
        input.replyToMessageId,
        input.baselineAt,
        now.toISOString(),
        JSON.stringify(state),
        new Date(now.getTime() - STALE_DELIVERY_MS).toISOString(),
        input.recoverTerminalSkip === true,
      ],
    );
    const acquiredId = acquired.rows[0]?.id;
    if (acquiredId) {
      return { attemptId, deliveryRef: acquiredId, status: "acquired" };
    }

    await input.db.query(
      `
        update signal_bot_messages
        set metrics = (metrics - 'deliveryStateV2' - 'status') || $4::jsonb,
            sent_at = $5::timestamptz
        where chat_id = $1
          and note_id = $2::uuid
          and message_kind = $3
          and telegram_message_id is null
          and (
            (
              metrics #>> '{deliveryStateV2,version}' = '2'
              and metrics #>> '{deliveryStateV2,status}' = 'sending'
              and sent_at <= $6::timestamptz
            )
            or (
              metrics #>> '{deliveryStateV2,version}' is null
              and coalesce(metrics->>'status', '') in (
                'pending', 'prepared', 'send_failed'
              )
            )
          )
      `,
      [
        input.chatId,
        input.noteId,
        input.messageKind,
        JSON.stringify(
          deliveryState({
            attemptId: null,
            at: now,
            errorCode: "legacy_or_stale_delivery_unknown",
            status: "delivery_unknown",
          }),
        ),
        now.toISOString(),
        new Date(now.getTime() - STALE_DELIVERY_MS).toISOString(),
      ],
    );
    const existing = await input.db.query<DeliveryLedgerRow>(
      `
        select id::text, telegram_message_id, metrics
        from signal_bot_messages
        where chat_id = $1 and note_id = $2::uuid and message_kind = $3
        limit 1
      `,
      [input.chatId, input.noteId, input.messageKind],
    );
    return existing.rows[0]
      ? rowStatus(existing.rows[0])
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function beginSignalBotMessageDelivery(input: {
  attemptId: string;
  db: DbQuery;
  deliveryRef: string;
  expectedStatus?: "queued" | "reserved";
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const expectedStatus = input.expectedStatus ?? "reserved";
  const result = await input.db.query(
    `
      update signal_bot_messages
      set metrics = (metrics - 'deliveryStateV2' - 'status') || $3::jsonb,
          sent_at = $4::timestamptz
      where id = $1::uuid
        and metrics #>> '{deliveryStateV2,version}' = '2'
        and metrics #>> '{deliveryStateV2,status}' = $5
        and metrics #>> '{deliveryStateV2,attemptId}' = $2
    `,
    [
      input.deliveryRef,
      input.attemptId,
      JSON.stringify(
        deliveryState({
          attemptId: input.attemptId,
          at: now,
          status: "sending",
        }),
      ),
      now.toISOString(),
      expectedStatus,
    ],
  );
  return result.rowCount !== 0;
}

export async function finishSignalBotMessageDelivery(input: {
  attemptId: string;
  db: DbQuery;
  deliveryRef: string;
  errorCode?: string | null;
  expectedStatus: "queued" | "reserved" | "sending";
  messageId?: number | null;
  metrics?: Record<string, unknown>;
  nextAttemptAt?: Date | null;
  now?: Date;
  replyToMessageId?: number | null;
  status: Exclude<DeliveryLedgerStatus, "reserved" | "sending">;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const nextAttemptAt = input.status === "retry" ? input.nextAttemptAt : null;
  const nextState = {
    ...(input.metrics ?? {}),
    ...deliveryState({
      attemptId: input.status === "retry" ? input.attemptId : null,
      at: now,
      errorCode: input.errorCode,
      nextAttemptAt,
      status: input.status,
    }),
  };
  const result = await input.db.query(
    `
      update signal_bot_messages
      set telegram_message_id = $4,
          reply_to_message_id = case
            when $7::boolean then $8
            else reply_to_message_id
          end,
          metrics = (metrics - 'deliveryStateV2' - 'status') || $5::jsonb,
          sent_at = $6::timestamptz
      where id = $1::uuid
        and metrics #>> '{deliveryStateV2,version}' = '2'
        and metrics #>> '{deliveryStateV2,status}' = $2
        and metrics #>> '{deliveryStateV2,attemptId}' = $3
    `,
    [
      input.deliveryRef,
      input.expectedStatus,
      input.attemptId,
      input.messageId ?? null,
      JSON.stringify(nextState),
      now.toISOString(),
      input.replyToMessageId !== undefined,
      input.replyToMessageId ?? null,
    ],
  );
  return result.rowCount !== 0;
}

export async function quarantineStaleSignalBotMessageDeliveries(input: {
  db: DbQuery;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const state = deliveryState({
    attemptId: null,
    at: now,
    errorCode: "legacy_or_stale_delivery_unknown",
    status: "delivery_unknown",
  });
  const result = await input.db.query(
    `
      update signal_bot_messages
      set metrics = (metrics - 'deliveryStateV2' - 'status') || $1::jsonb,
          sent_at = $2::timestamptz
      where telegram_message_id is null
        and (
          (
            metrics #>> '{deliveryStateV2,version}' = '2'
            and metrics #>> '{deliveryStateV2,status}' = 'sending'
            and sent_at <= $3::timestamptz
          )
          or (
            metrics #>> '{deliveryStateV2,version}' is null
            and coalesce(metrics->>'status', '') in (
              'pending', 'prepared', 'send_failed'
            )
          )
        )
    `,
    [
      JSON.stringify(state),
      now.toISOString(),
      new Date(now.getTime() - STALE_DELIVERY_MS).toISOString(),
    ],
  );
  return result.rowCount ?? 0;
}

export async function recordSignalBotMessageNonDeliveryState(input: {
  baselineAt: string;
  chatId: string;
  db: DbQuery;
  messageKind: SignalBotMessageKind;
  metrics: Record<string, unknown> & {
    status: "compose_failed" | "skipped";
  };
  noteId: string;
  replyToMessageId: number | null;
  sentAt: Date;
  threadRootNoteId: string;
}): Promise<boolean> {
  const deliveryRef = crypto.randomUUID();
  try {
    const result = await input.db.query<{ id: string }>(
      `
        insert into signal_bot_messages (
          id,
          chat_id,
          note_id,
          thread_root_note_id,
          message_kind,
          telegram_message_id,
          reply_to_message_id,
          baseline_at,
          sent_at,
          metrics
        ) values (
          $1::uuid, $2, $3::uuid, $4::uuid, $5, null, $6,
          $7::timestamptz, $8::timestamptz, $9::jsonb
        )
        on conflict (chat_id, note_id, message_kind)
        do update set
          reply_to_message_id = excluded.reply_to_message_id,
          thread_root_note_id = excluded.thread_root_note_id,
          baseline_at = excluded.baseline_at,
          sent_at = excluded.sent_at,
          metrics = excluded.metrics
        where signal_bot_messages.telegram_message_id is null
          and signal_bot_messages.metrics #>> '{deliveryStateV2,version}' is null
          and coalesce(signal_bot_messages.metrics->>'status', '') in (
            'compose_failed', 'skipped'
          )
        returning id::text as id
      `,
      [
        deliveryRef,
        input.chatId,
        input.noteId,
        input.threadRootNoteId,
        input.messageKind,
        input.replyToMessageId,
        input.baselineAt,
        input.sentAt.toISOString(),
        JSON.stringify(input.metrics),
      ],
    );
    return result.rows[0]?.id != null;
  } catch (error) {
    if (
      error != null &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "42P01"
    ) {
      return false;
    }
    throw error;
  }
}

export async function recordSignalBotFollowthroughSkipped(input: {
  baselineAt: string;
  chatId: string;
  db: DbQuery;
  metrics: unknown;
  noteId: string;
  replyToMessageId: number | null;
  sentAt: Date;
  threadRootNoteId: string;
}): Promise<void> {
  const metrics = record(input.metrics);
  await recordSignalBotMessageNonDeliveryState({
    ...input,
    messageKind: "followthrough_stats",
    metrics: { ...metrics, status: "skipped" },
  });
}
