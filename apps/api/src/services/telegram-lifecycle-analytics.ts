import type { DbQuery } from "../db.js";

export type TelegramLifecycleAnalyticsEvent =
  | "hf_telegram_account_lifecycle"
  | "hf_telegram_trading_lifecycle";

export function resolveTelegramLifecycleChain(
  venue: string,
  fallback: string | null = null,
): string | null {
  if (venue === "polymarket") return "polygon";
  if (venue === "limitless") return "base";
  if (venue === "kalshi") return "solana";
  return fallback;
}

export async function recordTelegramLifecycleAnalytics(input: {
  chain?: string | null;
  db: DbQuery;
  dedupeKey: string;
  event: TelegramLifecycleAnalyticsEvent;
  reason?: string | null;
  source: string;
  status: string;
  userId: string;
  venue?: string | null;
}): Promise<void> {
  const payload = {
    analytics_schema_version: "telegram-lifecycle-v1",
    ...(input.chain ? { chain: input.chain } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    source: input.source,
    status: input.status,
    ...(input.venue ? { venue: input.venue } : {}),
  };
  await input.db.query(
    `insert into analytics_server_events (
       user_id,
       event_name,
       source,
       status,
       venue,
       analytics_schema_version,
       dedupe_key,
       origin,
       payload
     )
     values ($1, $2, $3, $4, $5, 'telegram-lifecycle-v1', $6, 'backend', $7::jsonb)
     on conflict (event_name, dedupe_key)
       where dedupe_key is not null
       do nothing`,
    [
      input.userId,
      input.event,
      input.source,
      input.status,
      input.venue ?? null,
      input.dedupeKey,
      JSON.stringify(payload),
    ],
  );
}
