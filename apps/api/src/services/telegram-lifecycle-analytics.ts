import type { DbQuery } from "../db.js";

export type TelegramLifecycleAnalyticsEvent =
  | "hf_telegram_account_lifecycle"
  | "hf_telegram_deposit_resolution"
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

export async function recordTelegramDepositResolutionAnalytics(input: {
  db: DbQuery;
  reason: string | null;
  source: "deposit_menu" | "funding_preview";
  status: string;
  telegramUserId: string | number;
  venue: string;
}): Promise<void> {
  const { rows } = await input.db.query<{ user_id: string }>(
    `select user_id
       from user_telegram_accounts
      where telegram_user_id = $1
      limit 1`,
    [String(input.telegramUserId)],
  );
  const userId = rows[0]?.user_id;
  if (!userId) return;
  const day = new Date().toISOString().slice(0, 10);
  await recordTelegramLifecycleAnalytics({
    chain: resolveTelegramLifecycleChain(input.venue),
    db: input.db,
    dedupeKey: [
      "telegram-deposit",
      userId,
      input.venue,
      input.source,
      input.status,
      input.reason ?? "ready",
      day,
    ].join(":"),
    event: "hf_telegram_deposit_resolution",
    reason: input.reason,
    source: input.source,
    status: input.status,
    userId,
    venue: input.venue,
  });
}
