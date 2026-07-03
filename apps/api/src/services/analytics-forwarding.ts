import type { DbQuery } from "../db.js";
import { env } from "../env.js";

export const COLLECTED_ANALYTICS_EVENTS = [
  "hf_bridge_fail",
  "hf_bridge_submit",
  "hf_bridge_success",
  "hf_event_entry_open",
  "hf_market_open",
  "hf_order_fail",
  "hf_order_submit",
  "hf_order_success",
  "hf_portfolio_order_cancel",
  "hf_portfolio_share_action",
  "hf_referral_link_landing",
  "hf_redemption_action",
  "hf_rewards_claim_action",
  "hf_rewards_referral_action",
  "hf_telegram_context_validation",
  "hf_telegram_mini_app_entry",
  "hf_telegram_privy_link",
  "hf_trade_submit_no_terminal_2m",
  "hf_wallet_connect_click",
  "hf_wallet_connect_completed_funnel",
  "hf_wallet_connect_error",
  "hf_wallet_connect_success",
  "hf_wallet_link_click",
  "hf_wallet_link_completed_funnel",
  "hf_wallet_link_error",
  "hf_wallet_link_success",
] as const;

type CollectedAnalyticsEventName = (typeof COLLECTED_ANALYTICS_EVENTS)[number];

type AnalyticsDeliveryMode = "database" | "off";
type AnalyticsEventOrigin = "backend" | "browser";

type ForwardedAnalyticsTelemetry = {
  accepted: number;
  deduped: number;
  droppedDisabled: number;
  droppedInvalid: number;
  failed: number;
};

type AnalyticsForwardingTelemetryOptions = {
  breakdownWindowDays?: number;
};

type AnalyticsEventCollectionResult =
  | {
      accepted: false;
      reason: "disabled" | "invalid" | "unsupported";
      error?: string;
    }
  | { accepted: true; deduped: boolean; stored: boolean };

type ValidationSuccess = {
  analyticsSchemaVersion: string;
  ok: true;
  attemptId: string | null;
  dedupeKey: string | null;
  eventSlug: string | null;
  referredUserKey: string | null;
  source: string | null;
  status: string | null;
  venue: string | null;
};

type ValidationFailure = {
  error: string;
  ok: false;
};

const runtimeTelemetry: ForwardedAnalyticsTelemetry = {
  accepted: 0,
  deduped: 0,
  droppedDisabled: 0,
  droppedInvalid: 0,
  failed: 0,
};
const runtimeStartedAt = new Date();
let deliveryModeOverrideForTests: AnalyticsDeliveryMode | null = null;
const DEFAULT_TELEMETRY_BREAKDOWN_WINDOW_DAYS = 30;

const TERMINAL_ORDER_EVENTS = new Set<string>([
  "hf_order_fail",
  "hf_order_submit",
  "hf_order_success",
  "hf_trade_submit_no_terminal_2m",
]);
const TERMINAL_BRIDGE_EVENTS = new Set<string>([
  "hf_bridge_fail",
  "hf_bridge_submit",
  "hf_bridge_success",
]);
const PORTFOLIO_CANCEL_STATUSES = new Set([
  "cancel_error",
  "cancel_submit",
  "cancel_success",
]);
const REWARDS_CLAIM_STATUSES = new Set([
  "claim_error",
  "claim_submit",
  "claim_success",
]);
const REDEMPTION_STATUSES = new Set([
  "redemption_fail",
  "redemption_submit",
  "redemption_success",
]);
const BACKEND_ANALYTICS_SCHEMA_VERSION = "backend-collector-v1";

function resolveTerminalDedupeKey(
  event: CollectedAnalyticsEventName,
  attemptId: string,
  status: string | null,
): string {
  if (
    (event === "hf_portfolio_order_cancel" ||
      event === "hf_redemption_action" ||
      event === "hf_rewards_claim_action") &&
    status
  ) {
    return `${event}:${attemptId}:${status}`;
  }
  return `${event}:${attemptId}`;
}

function isCollectedAnalyticsEventName(
  value: string,
): value is CollectedAnalyticsEventName {
  return (COLLECTED_ANALYTICS_EVENTS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readTrimmedString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeReferralCode(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.length > 0 ? normalized : null;
}

function resolveDeliveryMode(): AnalyticsDeliveryMode {
  if (deliveryModeOverrideForTests) return deliveryModeOverrideForTests;
  if (!env.analyticsServerForwardingEnabled) return "off";
  return env.analyticsServerForwardingMode;
}

function normalizeTelemetryBreakdownWindowDays(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TELEMETRY_BREAKDOWN_WINDOW_DAYS;
  }
  return Math.max(1, Math.min(395, Math.trunc(parsed)));
}

export function setAnalyticsDeliveryModeForTests(
  mode: AnalyticsDeliveryMode | null,
): void {
  deliveryModeOverrideForTests = mode;
}

function isTerminalCollectedEvent(event: CollectedAnalyticsEventName): boolean {
  return (
    TERMINAL_ORDER_EVENTS.has(event) ||
    TERMINAL_BRIDGE_EVENTS.has(event) ||
    event === "hf_portfolio_order_cancel" ||
    event === "hf_redemption_action" ||
    event === "hf_rewards_claim_action"
  );
}

function isCollectableEventForOrigin(
  event: CollectedAnalyticsEventName,
  payload: Record<string, unknown>,
  origin: AnalyticsEventOrigin,
): boolean {
  const status = readTrimmedString(payload, "status");
  if (TERMINAL_ORDER_EVENTS.has(event) || TERMINAL_BRIDGE_EVENTS.has(event)) {
    return true;
  }
  if (event === "hf_portfolio_order_cancel") {
    return status != null && PORTFOLIO_CANCEL_STATUSES.has(status);
  }
  if (event === "hf_rewards_claim_action") {
    if (status == null || !REWARDS_CLAIM_STATUSES.has(status)) return false;
    if (origin === "backend") return status !== "claim_submit";
    return status === "claim_submit";
  }
  if (event === "hf_redemption_action") {
    return status != null && REDEMPTION_STATUSES.has(status);
  }
  return true;
}

function validateCollectedAnalyticsPayload(
  event: CollectedAnalyticsEventName,
  payload: Record<string, unknown>,
  userId: string | null,
  origin: AnalyticsEventOrigin,
): ValidationFailure | ValidationSuccess {
  if (!isCollectableEventForOrigin(event, payload, origin)) {
    return {
      ok: false,
      error: `event ${event} with status ${readTrimmedString(payload, "status") ?? "null"} is not collectable for ${origin}`,
    };
  }

  const schemaVersion =
    origin === "backend"
      ? (readTrimmedString(payload, "analytics_schema_version") ??
        BACKEND_ANALYTICS_SCHEMA_VERSION)
      : readTrimmedString(payload, "analytics_schema_version");
  if (!schemaVersion) {
    return { ok: false, error: "analytics_schema_version is required" };
  }

  const attemptId = readTrimmedString(payload, "attempt_id");
  const referredUserKey = readTrimmedString(payload, "referred_user_key");
  const eventSlug = normalizeReferralCode(
    readTrimmedString(payload, "event_slug"),
  );
  const source = readTrimmedString(payload, "source");
  const status = readTrimmedString(payload, "status");
  const venue = readTrimmedString(payload, "venue");

  if (isTerminalCollectedEvent(event)) {
    if (!userId) {
      return {
        ok: false,
        error: "authenticated user is required for terminal analytics events",
      };
    }
    if (!attemptId) {
      return {
        ok: false,
        error: "attempt_id is required for terminal analytics events",
      };
    }
    return {
      analyticsSchemaVersion: schemaVersion,
      ok: true,
      attemptId,
      dedupeKey: resolveTerminalDedupeKey(event, attemptId, status),
      eventSlug,
      referredUserKey,
      source,
      status,
      venue,
    };
  }

  if (
    event === "hf_portfolio_share_action" ||
    event === "hf_referral_link_landing" ||
    event === "hf_rewards_referral_action"
  ) {
    if (!eventSlug) {
      return {
        ok: false,
        error: "event_slug is required for referral share and landing events",
      };
    }
  }

  return {
    analyticsSchemaVersion: schemaVersion,
    ok: true,
    attemptId,
    dedupeKey: null,
    eventSlug,
    referredUserKey,
    source,
    status,
    venue,
  };
}

export function shouldForwardAnalyticsEvent(event: string): boolean {
  return isCollectedAnalyticsEventName(event);
}

export function listCollectedAnalyticsEvents(): string[] {
  return [...COLLECTED_ANALYTICS_EVENTS];
}

async function insertAnalyticsServerEvent(
  pool: DbQuery,
  inputs: {
    analyticsSchemaVersion: string;
    attemptId: string | null;
    dedupeKey: string | null;
    event: CollectedAnalyticsEventName;
    eventSlug: string | null;
    origin: AnalyticsEventOrigin;
    payload: Record<string, unknown>;
    referredUserKey: string | null;
    source: string | null;
    status: string | null;
    userId: string | null;
    venue: string | null;
  },
): Promise<AnalyticsEventCollectionResult> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into analytics_server_events (
        user_id,
        event_name,
        event_slug,
        source,
        status,
        venue,
        referred_user_key,
        attempt_id,
        analytics_schema_version,
        dedupe_key,
        origin,
        payload
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
      )
      on conflict (event_name, dedupe_key)
        where dedupe_key is not null
        do nothing
      returning id
    `,
    [
      inputs.userId,
      inputs.event,
      inputs.eventSlug,
      inputs.source,
      inputs.status,
      inputs.venue,
      inputs.referredUserKey,
      inputs.attemptId,
      inputs.analyticsSchemaVersion,
      inputs.dedupeKey,
      inputs.origin,
      JSON.stringify(inputs.payload),
    ],
  );

  if (!rows[0]) {
    runtimeTelemetry.deduped += 1;
    return { accepted: true, deduped: true, stored: true };
  }

  runtimeTelemetry.accepted += 1;
  return { accepted: true, deduped: false, stored: true };
}

export async function collectAnalyticsEvent(
  pool: DbQuery,
  inputs: {
    event: string;
    origin: AnalyticsEventOrigin;
    payload: unknown;
    userId?: string | null;
  },
): Promise<AnalyticsEventCollectionResult> {
  if (!isCollectedAnalyticsEventName(inputs.event)) {
    runtimeTelemetry.droppedInvalid += 1;
    return { accepted: false, reason: "unsupported" };
  }

  const deliveryMode = resolveDeliveryMode();
  if (deliveryMode === "off") {
    runtimeTelemetry.droppedDisabled += 1;
    return { accepted: false, reason: "disabled" };
  }

  if (!isRecord(inputs.payload)) {
    runtimeTelemetry.droppedInvalid += 1;
    return {
      accepted: false,
      reason: "invalid",
      error: "payload must be an object",
    };
  }

  const validated = validateCollectedAnalyticsPayload(
    inputs.event,
    inputs.payload,
    inputs.userId ?? null,
    inputs.origin,
  );
  if (!validated.ok) {
    runtimeTelemetry.droppedInvalid += 1;
    return { accepted: false, reason: "invalid", error: validated.error };
  }

  try {
    return await insertAnalyticsServerEvent(pool, {
      userId: inputs.userId ?? null,
      event: inputs.event,
      eventSlug: validated.eventSlug,
      source: validated.source,
      status: validated.status,
      venue: validated.venue,
      referredUserKey: validated.referredUserKey,
      attemptId: validated.attemptId,
      analyticsSchemaVersion: validated.analyticsSchemaVersion,
      dedupeKey: validated.dedupeKey,
      origin: inputs.origin,
      payload: inputs.payload,
    });
  } catch (error) {
    runtimeTelemetry.failed += 1;
    throw error;
  }
}

export async function ingestForwardedAnalyticsEvent(
  pool: DbQuery,
  inputs: {
    event: string;
    payload: unknown;
    userId?: string | null;
  },
): Promise<AnalyticsEventCollectionResult> {
  return collectAnalyticsEvent(pool, {
    ...inputs,
    origin: "browser",
  });
}

export async function fetchAnalyticsForwardingTelemetry(
  pool: DbQuery,
  options: AnalyticsForwardingTelemetryOptions = {},
): Promise<{
  byEvent: Array<{ event: string; count: number }>;
  byOrigin: Array<{ count: number; origin: AnalyticsEventOrigin }>;
  bySchemaVersion: Array<{ count: number; version: string }>;
  collector: {
    recentStored: number;
    recentWindowDays: number;
    stored: number;
    storedEstimated: boolean;
  };
  mode: AnalyticsDeliveryMode;
  runtime: ForwardedAnalyticsTelemetry;
  runtimeStartedAt: string;
}> {
  const breakdownWindowDays = normalizeTelemetryBreakdownWindowDays(
    options.breakdownWindowDays,
  );
  const [
    { rows: collectorRows },
    { rows: versionRows },
    { rows: eventRows },
    { rows: originRows },
  ] = await Promise.all([
    pool.query<{ recent_stored: string; stored: string }>(
      `
          select
            greatest(
              coalesce(
                (
                  select reltuples::bigint
                  from pg_class
                  where oid = 'analytics_server_events'::regclass
                ),
                0
              ),
              0
            )::text as stored,
            (
              select count(*)::text
              from analytics_server_events
              where created_at >= now() - make_interval(days => $1::int)
            ) as recent_stored
        `,
      [breakdownWindowDays],
    ),
    pool.query<{ count: string; version: string }>(
      `
          select
            analytics_schema_version as version,
            count(*)::text as count
          from analytics_server_events
          where created_at >= now() - make_interval(days => $1::int)
          group by analytics_schema_version
          order by count(*) desc, analytics_schema_version desc
          limit 20
        `,
      [breakdownWindowDays],
    ),
    pool.query<{ count: string; event: string }>(
      `
          select
            event_name as event,
            count(*)::text as count
          from analytics_server_events
          where created_at >= now() - make_interval(days => $1::int)
          group by event_name
          order by count(*) desc, event_name asc
          limit 20
        `,
      [breakdownWindowDays],
    ),
    pool.query<{ count: string; origin: AnalyticsEventOrigin }>(
      `
          select
            origin,
            count(*)::text as count
          from analytics_server_events
          where created_at >= now() - make_interval(days => $1::int)
          group by origin
          order by count(*) desc, origin asc
        `,
      [breakdownWindowDays],
    ),
  ]);

  const collectorRow = collectorRows[0];
  return {
    runtime: { ...runtimeTelemetry },
    runtimeStartedAt: runtimeStartedAt.toISOString(),
    mode: resolveDeliveryMode(),
    collector: {
      stored: Number(collectorRow?.stored ?? 0),
      storedEstimated: true,
      recentStored: Number(collectorRow?.recent_stored ?? 0),
      recentWindowDays: breakdownWindowDays,
    },
    byOrigin: originRows.map((row) => ({
      origin: row.origin,
      count: Number(row.count),
    })),
    bySchemaVersion: versionRows.map((row) => ({
      version: row.version,
      count: Number(row.count),
    })),
    byEvent: eventRows.map((row) => ({
      event: row.event,
      count: Number(row.count),
    })),
  };
}
