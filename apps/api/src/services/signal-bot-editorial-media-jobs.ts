import type { DbQuery } from "../db.js";

export const X_EDITORIAL_MEDIA_JOB_VERSION = 1;

export type XEditorialMediaProfile = "desktop" | "mobile";

export type XEditorialMediaDeliveryConfig = {
  enabled: boolean;
  profiles: XEditorialMediaProfile[];
};

export function parseXEditorialMediaDeliveryConfig(
  env: NodeJS.ProcessEnv,
): XEditorialMediaDeliveryConfig {
  const enabled = ["1", "true", "yes", "on"].includes(
    env.HUNCH_SIGNAL_BOT_X_EDITORIAL_MEDIA_ENABLED?.trim().toLowerCase() ?? "",
  );
  const profiles = (
    env.HUNCH_SIGNAL_BOT_X_EDITORIAL_MEDIA_PROFILES?.trim() || "mobile,desktop"
  )
    .split(",")
    .map((profile) => profile.trim().toLowerCase())
    .filter(
      (profile): profile is XEditorialMediaProfile =>
        profile === "desktop" || profile === "mobile",
    );
  return { enabled, profiles: [...new Set(profiles)] };
}

export type XEditorialMediaJobPayloadV1 = {
  captionMarkdownV2: string;
  captureUrl: string;
  profiles: XEditorialMediaProfile[];
  version: typeof X_EDITORIAL_MEDIA_JOB_VERSION;
};

export type XEditorialMediaJob = {
  attemptCount: number;
  chatId: string;
  deliveryAttemptId: string;
  deliveryRef: string;
  id: string;
  maxAttempts: number;
  payload: XEditorialMediaJobPayloadV1;
};

type EditorialMediaJobRow = {
  attempt_count: number;
  chat_id: string;
  delivery_attempt_id: string;
  id: string;
  max_attempts: number;
  payload: unknown;
  signal_bot_message_id: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parsePayload(value: unknown): XEditorialMediaJobPayloadV1 | null {
  const payload = asObject(value);
  const profiles = Array.isArray(payload.profiles)
    ? payload.profiles.filter(
        (profile): profile is XEditorialMediaProfile =>
          profile === "desktop" || profile === "mobile",
      )
    : [];
  if (
    payload.version !== X_EDITORIAL_MEDIA_JOB_VERSION ||
    typeof payload.captionMarkdownV2 !== "string" ||
    typeof payload.captureUrl !== "string" ||
    profiles.length === 0
  ) {
    return null;
  }
  try {
    const captureUrl = new URL(payload.captureUrl);
    if (captureUrl.protocol !== "https:" && captureUrl.protocol !== "http:") {
      return null;
    }
  } catch {
    return null;
  }
  return {
    captionMarkdownV2: payload.captionMarkdownV2,
    captureUrl: payload.captureUrl,
    profiles: [...new Set(profiles)],
    version: X_EDITORIAL_MEDIA_JOB_VERSION,
  };
}

function mapJob(row: EditorialMediaJobRow): XEditorialMediaJob | null {
  const payload = parsePayload(row.payload);
  if (!payload) return null;
  return {
    attemptCount: row.attempt_count,
    chatId: row.chat_id,
    deliveryAttemptId: row.delivery_attempt_id,
    deliveryRef: row.signal_bot_message_id,
    id: row.id,
    maxAttempts: row.max_attempts,
    payload,
  };
}

function queuedDeliveryState(input: {
  attemptId: string;
  at: Date;
}): Record<string, unknown> {
  return {
    deliveryStateV2: {
      attemptId: input.attemptId,
      errorCode: null,
      nextAttemptAt: null,
      status: "queued",
      updatedAt: input.at.toISOString(),
      version: 2,
    },
    editorialMediaV1: {
      queuedAt: input.at.toISOString(),
      status: "queued",
      version: 1,
    },
    status: "queued",
  };
}

export async function enqueueXEditorialMediaJob(input: {
  attemptId: string;
  captionMarkdownV2: string;
  captureUrl: string;
  chatId: string;
  db: DbQuery;
  deliveryRef: string;
  maxAttempts?: number;
  now?: Date;
  profiles: XEditorialMediaProfile[];
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const payload: XEditorialMediaJobPayloadV1 = {
    captionMarkdownV2: input.captionMarkdownV2,
    captureUrl: input.captureUrl,
    profiles: [...new Set(input.profiles)],
    version: X_EDITORIAL_MEDIA_JOB_VERSION,
  };
  if (!parsePayload(payload)) return false;
  const result = await input.db.query<{ id: string }>(
    `
      with queued_delivery as (
        update signal_bot_messages
        set metrics = (metrics - 'deliveryStateV2' - 'status') || $4::jsonb,
            sent_at = $5::timestamptz
        where id = $1::uuid
          and metrics #>> '{deliveryStateV2,version}' = '2'
          and metrics #>> '{deliveryStateV2,status}' = 'reserved'
          and metrics #>> '{deliveryStateV2,attemptId}' = $2
        returning id, chat_id
      )
      insert into signal_bot_editorial_media_jobs (
        signal_bot_message_id,
        delivery_attempt_id,
        chat_id,
        status,
        payload,
        max_attempts,
        available_at,
        updated_at
      )
      select id, $2::uuid, chat_id, 'queued', $3::jsonb, $6::integer,
             $5::timestamptz, $5::timestamptz
      from queued_delivery
      on conflict (signal_bot_message_id) do update set
        delivery_attempt_id = excluded.delivery_attempt_id,
        payload = excluded.payload,
        status = case
          when signal_bot_editorial_media_jobs.status in (
            'sent', 'blocked', 'delivery_unknown'
          ) then signal_bot_editorial_media_jobs.status
          else 'queued'
        end,
        available_at = excluded.available_at,
        lease_owner = null,
        lease_expires_at = null,
        updated_at = excluded.updated_at
      returning id::text as id
    `,
    [
      input.deliveryRef,
      input.attemptId,
      JSON.stringify(payload),
      JSON.stringify(
        queuedDeliveryState({ attemptId: input.attemptId, at: now }),
      ),
      now.toISOString(),
      Math.max(1, Math.min(10, input.maxAttempts ?? 3)),
    ],
  );
  return result.rows[0]?.id != null;
}

export async function claimXEditorialMediaJob(input: {
  db: DbQuery;
  leaseMs: number;
  now?: Date;
  owner: string;
}): Promise<XEditorialMediaJob | null> {
  const now = input.now ?? new Date();
  const result = await input.db.query<EditorialMediaJobRow>(
    `
      with candidate as (
        select id
        from signal_bot_editorial_media_jobs
        where (
          status in ('queued', 'retry') and available_at <= $1::timestamptz
        ) or (
          status = 'rendering'
          and lease_expires_at is not null
          and lease_expires_at <= $1::timestamptz
        )
        order by available_at asc, created_at asc
        for update skip locked
        limit 1
      )
      update signal_bot_editorial_media_jobs jobs
      set status = 'rendering',
          attempt_count = jobs.attempt_count + 1,
          lease_owner = $2,
          lease_expires_at = $3::timestamptz,
          last_error_code = null,
          last_error_message = null,
          updated_at = $1::timestamptz
      from candidate
      where jobs.id = candidate.id
      returning jobs.id::text,
                jobs.signal_bot_message_id::text,
                jobs.delivery_attempt_id::text,
                jobs.chat_id,
                jobs.payload,
                jobs.attempt_count,
                jobs.max_attempts
    `,
    [
      now.toISOString(),
      input.owner,
      new Date(now.getTime() + input.leaseMs).toISOString(),
    ],
  );
  const row = result.rows[0];
  return row ? mapJob(row) : null;
}

export async function requeueXEditorialMediaDelivery(input: {
  db: DbQuery;
  job: XEditorialMediaJob;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await input.db.query(
    `
      update signal_bot_messages
      set metrics = (metrics - 'deliveryStateV2' - 'status') || $3::jsonb,
          sent_at = $4::timestamptz
      where id = $1::uuid
        and metrics #>> '{deliveryStateV2,version}' = '2'
        and metrics #>> '{deliveryStateV2,status}' = 'sending'
        and metrics #>> '{deliveryStateV2,attemptId}' = $2
    `,
    [
      input.job.deliveryRef,
      input.job.deliveryAttemptId,
      JSON.stringify(
        queuedDeliveryState({
          attemptId: input.job.deliveryAttemptId,
          at: now,
        }),
      ),
      now.toISOString(),
    ],
  );
  return result.rowCount !== 0;
}

export async function retryXEditorialMediaJob(input: {
  db: DbQuery;
  errorCode: string;
  errorMessage: string;
  extendForDeliveryRetry?: boolean;
  job: XEditorialMediaJob;
  now?: Date;
  retryAfterMs: number;
}): Promise<"failed" | "retry"> {
  const now = input.now ?? new Date();
  const attemptLimit =
    input.job.maxAttempts + (input.extendForDeliveryRetry ? 3 : 0);
  const exhausted = input.job.attemptCount >= attemptLimit;
  await input.db.query(
    `
      update signal_bot_editorial_media_jobs
      set status = $3,
          available_at = $4::timestamptz,
          lease_owner = null,
          lease_expires_at = null,
          last_error_code = $5,
          last_error_message = $6,
          completed_at = case when $3 = 'failed' then $2::timestamptz else null end,
          updated_at = $2::timestamptz
      where id = $1::uuid and status = 'rendering'
    `,
    [
      input.job.id,
      now.toISOString(),
      exhausted ? "failed" : "retry",
      new Date(now.getTime() + input.retryAfterMs).toISOString(),
      input.errorCode.slice(0, 120),
      input.errorMessage.slice(0, 1_000),
    ],
  );
  return exhausted ? "failed" : "retry";
}

export async function finishXEditorialMediaJob(input: {
  db: DbQuery;
  errorCode?: string | null;
  errorMessage?: string | null;
  jobId: string;
  now?: Date;
  result?: Record<string, unknown>;
  status: "blocked" | "delivery_unknown" | "failed" | "sent";
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await input.db.query(
    `
      update signal_bot_editorial_media_jobs
      set status = $3,
          result = $4::jsonb,
          lease_owner = null,
          lease_expires_at = null,
          last_error_code = $5,
          last_error_message = $6,
          completed_at = $2::timestamptz,
          updated_at = $2::timestamptz
      where id = $1::uuid and status = 'rendering'
    `,
    [
      input.jobId,
      now.toISOString(),
      input.status,
      JSON.stringify(input.result ?? {}),
      input.errorCode?.slice(0, 120) ?? null,
      input.errorMessage?.slice(0, 1_000) ?? null,
    ],
  );
  return result.rowCount !== 0;
}
