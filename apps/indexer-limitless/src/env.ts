import { config } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const envPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
config({ path: envPath, override: true });

// nuke pg envs so Pool uses connectionString you provided
["PGHOST", "PGUSER", "PGPASSWORD", "PGPORT", "PGDATABASE", "PGSSLMODE"].forEach(
  (k) => delete process.env[k],
);

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[env] Missing ${name}. Put it in ${envPath}`);
    process.exit(1);
  }
  return v;
}

function parseOptionalBool(v: string | undefined): boolean | undefined {
  if (!v) return undefined;
  switch (v.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function clampInt(
  value: number | undefined,
  opts: { min: number; max: number; fallback: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return opts.fallback;
  }
  return Math.min(opts.max, Math.max(opts.min, Math.trunc(value)));
}

function parseOptionalFloat(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampFloat(
  value: number | undefined,
  opts: { min: number; max: number; fallback: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return opts.fallback;
  }
  return Math.min(opts.max, Math.max(opts.min, value));
}

const limitlessEnabledSetting = parseOptionalBool(
  process.env.LIMITLESS_ENABLED,
);

const pageSizeRaw = Number(process.env.LIMITLESS_PAGE_SIZE ?? "25");
const bootstrapPageSize = Math.min(
  25,
  Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 25),
);

const maxPagesRaw = Number(process.env.LIMITLESS_MAX_PAGES ?? "10");
const bootstrapMaxPages = Math.max(
  0,
  Number.isFinite(maxPagesRaw) ? maxPagesRaw : 10,
);

const refreshMinutesRaw = Number(process.env.LIMITLESS_REFRESH_MIN ?? "1");
const refreshMinutes = Math.max(
  1,
  Number.isFinite(refreshMinutesRaw) ? refreshMinutesRaw : 5,
);
const fullRefreshMinutesRaw = Number(
  process.env.LIMITLESS_FULL_REFRESH_MIN ??
    String(Math.max(refreshMinutes * 6, 30)),
);
const fullRefreshMinutes = Math.max(
  refreshMinutes,
  Number.isFinite(fullRefreshMinutesRaw)
    ? fullRefreshMinutesRaw
    : Math.max(refreshMinutes * 6, 30),
);
const startupSeedPagesRaw = Number(
  process.env.LIMITLESS_STARTUP_SEED_PAGES ?? "2",
);
const startupSeedPages = Math.max(
  0,
  Math.min(5, Number.isFinite(startupSeedPagesRaw) ? startupSeedPagesRaw : 2),
);

const wsRefreshSec = clampInt(
  parseOptionalInt(
    process.env.LIMITLESS_WS_REFRESH_SEC ?? process.env.INDEXER_WS_REFRESH_SEC,
  ),
  { min: 10, max: 3600, fallback: 10 },
);

const httpDelayRaw = Number(process.env.LIMITLESS_HTTP_MIN_DELAY_MS ?? "500");
const limitlessHttpMinDelayMs = Math.max(
  0,
  Number.isFinite(httpDelayRaw) ? httpDelayRaw : 500,
);

const httpRetriesRaw = Number(process.env.LIMITLESS_HTTP_MAX_RETRIES ?? "2");
const limitlessHttpMaxRetries = Math.max(
  0,
  Number.isFinite(httpRetriesRaw) ? httpRetriesRaw : 2,
);

const httpBackoffRaw = Number(process.env.LIMITLESS_HTTP_BACKOFF_MS ?? "750");
const limitlessHttpBackoffMs = Math.max(
  0,
  Number.isFinite(httpBackoffRaw) ? httpBackoffRaw : 750,
);
const httpTimeoutRaw = Number(process.env.LIMITLESS_HTTP_TIMEOUT_MS ?? "10000");
const limitlessHttpTimeoutMs = Math.max(
  1_000,
  Number.isFinite(httpTimeoutRaw) ? httpTimeoutRaw : 10_000,
);

const hotTokensTtlSec = clampInt(
  parseOptionalInt(process.env.HOT_TOKENS_TTL_SEC),
  { min: 60, max: 7 * 24 * 60 * 60, fallback: 1800 },
);
const hotTokensMax = clampInt(parseOptionalInt(process.env.HOT_TOKENS_MAX), {
  min: 10,
  max: 50_000,
  fallback: 5000,
});
const hotStreamTokensTtlSec = clampInt(
  parseOptionalInt(process.env.HOT_STREAM_TOKENS_TTL_SEC),
  { min: 60, max: 7 * 24 * 60 * 60, fallback: 1800 },
);
const hotStreamTokensMax = clampInt(
  parseOptionalInt(process.env.HOT_STREAM_TOKENS_MAX),
  {
    min: 10,
    max: 50_000,
    fallback: 5000,
  },
);

const priceRefreshQueueEnabled =
  parseOptionalBool(process.env.PRICE_REFRESH_QUEUE_ENABLED) ?? true;
const priceRefreshQueueBatch = clampInt(
  parseOptionalInt(process.env.PRICE_REFRESH_QUEUE_BATCH),
  { min: 1, max: 1000, fallback: 100 },
);
const priceRefreshQueueIntervalMs = clampInt(
  parseOptionalInt(process.env.PRICE_REFRESH_QUEUE_INTERVAL_MS),
  { min: 1000, max: 10 * 60 * 1000, fallback: 5000 },
);
const priceRefreshQueueMax = clampInt(
  parseOptionalInt(process.env.PRICE_REFRESH_QUEUE_MAX),
  { min: 100, max: 1_000_000, fallback: 20_000 },
);
const priceRefreshRetryDelayMs = clampInt(
  parseOptionalInt(process.env.PRICE_REFRESH_RETRY_DELAY_MS),
  { min: 1000, max: 60 * 60 * 1000, fallback: 60_000 },
);

const wsHotShareRaw = parseOptionalFloat(
  process.env.LIMITLESS_WS_HOT_SHARE ?? process.env.WS_HOT_SHARE,
);
const wsHotShare = clampFloat(wsHotShareRaw, {
  min: 0,
  max: 1,
  fallback: 0.5,
});

const baseRpcTimeoutMs = clampInt(
  parseOptionalInt(process.env.BASE_RPC_TIMEOUT_MS),
  { min: 1_000, max: 60_000, fallback: 10_000 },
);

const hotAmmQuoteCooldownMs = clampInt(
  parseOptionalInt(process.env.LIMITLESS_AMM_QUOTE_COOLDOWN_MS),
  { min: 1_000, max: 10 * 60 * 1000, fallback: 15_000 },
);

const hotAmmQuoteMaxMarkets = clampInt(
  parseOptionalInt(process.env.LIMITLESS_AMM_QUOTE_MAX_MARKETS),
  { min: 1, max: 500, fallback: 64 },
);

export const env = {
  dbUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL"),
  baseRpcUrl: process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org",
  baseRpcTimeoutMs,

  limitlessEnabledSetting,
  limitlessEnabled: limitlessEnabledSetting ?? true,

  limitlessBase: process.env.LIMITLESS_BASE ?? "https://api.limitless.exchange",
  limitlessWsUrl: process.env.LIMITLESS_WS ?? "wss://ws.limitless.exchange",
  limitlessWsSession: process.env.LIMITLESS_WS_SESSION ?? "",
  // how many markets we’ll pull per bootstrap tick
  bootstrapPageSize,
  bootstrapMaxPages,
  // minutes between refreshes
  refreshMinutes,
  fullRefreshMinutes,
  startupSeedPages,
  wsRefreshSec,

  limitlessHttpMinDelayMs,
  limitlessHttpMaxRetries,
  limitlessHttpBackoffMs,
  limitlessHttpTimeoutMs,
  hotTokensTtlSec,
  hotTokensMax,
  hotStreamTokensTtlSec,
  hotStreamTokensMax,
  priceRefreshQueueEnabled,
  priceRefreshQueueBatch,
  priceRefreshQueueIntervalMs,
  priceRefreshQueueMax,
  priceRefreshRetryDelayMs,
  hotAmmQuoteCooldownMs,
  hotAmmQuoteMaxMarkets,

  // AMM prices are % (0..100) in /markets/active; CLOB prices are 0..1.
  writePriceSnapshots: (process.env.LIMITLESS_SNAPSHOTS ?? "true") === "true",
  wsSubset: Number(process.env.INDEXER_WS_SUBSET ?? "200"),
  wsConcurrency: process.env.INDEXER_WS_CONCURRENCY ?? "8",
  wsHotShare,

  venueName: "limitless",
  venueId: Number(process.env.LIMITLESS_VENUE_ID ?? "3"),
};
