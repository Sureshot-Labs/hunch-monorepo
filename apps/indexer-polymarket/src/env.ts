import { config } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const envPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
config({ path: envPath, override: true }); // load repo .env

// 🧹 Prevent pg from mixing PG* env with your connectionString
["PGHOST", "PGUSER", "PGPASSWORD", "PGPORT", "PGDATABASE", "PGSSLMODE"].forEach(
  (k) => delete process.env[k],
);

function parseOptionalInt(v: string | undefined): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function clampInt(
  v: number | undefined,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  if (v == null) return fallback;
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function parseOptionalFloat(v: string | undefined): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseBoolean(v: string | undefined, fallback: boolean): boolean {
  if (v == null || v.trim() === "") return fallback;
  const normalized = v.trim().toLowerCase();
  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return fallback;
}

function clampFloat(
  v: number | undefined,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  if (v == null) return fallback;
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[env] Missing ${name}. Make sure it's in ${envPath}`);
    process.exit(1);
  }
  return v;
}

const pageSizeRaw = parseOptionalInt(process.env.POLYMARKET_PAGE_SIZE);
const pageSize = clampInt(pageSizeRaw, { min: 1, max: 500, fallback: 500 });

const refreshMinutesRaw = parseOptionalInt(process.env.POLYMARKET_REFRESH_MIN);
const refreshMinutes = clampInt(refreshMinutesRaw, {
  min: 1,
  max: 24 * 60,
  fallback: 10,
});

const wsRefreshSecRaw = parseOptionalInt(
  process.env.POLYMARKET_WS_REFRESH_SEC ?? process.env.INDEXER_WS_REFRESH_SEC,
);
const wsRefreshSec = clampInt(wsRefreshSecRaw, {
  min: 10,
  max: 3600,
  fallback: 60,
});
const wsResubscribeSecRaw = parseOptionalInt(
  process.env.POLYMARKET_WS_RESUBSCRIBE_SEC ??
    process.env.INDEXER_WS_RESUBSCRIBE_SEC,
);
const wsResubscribeSec = clampInt(wsResubscribeSecRaw, {
  min: 10,
  max: 3600,
  fallback: 60,
});
const wsSubChunkSizeRaw = parseOptionalInt(
  process.env.POLYMARKET_WS_SUB_CHUNK_SIZE ??
    process.env.INDEXER_WS_SUB_CHUNK_SIZE,
);
const wsSubChunkSize = clampInt(wsSubChunkSizeRaw, {
  min: 10,
  max: 1000,
  fallback: 250,
});

const hotLookbackMinutesRaw = parseOptionalInt(
  process.env.POLYMARKET_HOT_LOOKBACK_MIN,
);
const hotLookbackMinutesFallback = Math.max(refreshMinutes * 2, 30);
const hotLookbackMinutes = clampInt(hotLookbackMinutesRaw, {
  min: 1,
  max: 7 * 24 * 60,
  fallback: hotLookbackMinutesFallback,
});

const hotMaxPagesRaw = parseOptionalInt(process.env.POLYMARKET_HOT_MAX_PAGES);
const hotMaxPages = clampInt(hotMaxPagesRaw, {
  min: 1,
  max: 10_000,
  fallback: 10,
});

const overlapPagesRaw = parseOptionalInt(process.env.POLYMARKET_OVERLAP_PAGES);
const overlapPages = clampInt(overlapPagesRaw, {
  min: 0,
  max: 10_000,
  fallback: 2,
});

const hotStatusMaxEventsRaw = parseOptionalInt(
  process.env.POLYMARKET_HOT_STATUS_MAX_EVENTS,
);
const hotStatusMaxEvents = clampInt(hotStatusMaxEventsRaw, {
  min: 1,
  max: 10_000,
  fallback: 200,
});

const hotTokensTtlSecRaw = parseOptionalInt(process.env.HOT_TOKENS_TTL_SEC);
const hotTokensTtlSec = clampInt(hotTokensTtlSecRaw, {
  min: 60,
  max: 7 * 24 * 60 * 60,
  fallback: 1800,
});

const hotTokensMaxRaw = parseOptionalInt(process.env.HOT_TOKENS_MAX);
const hotTokensMax = clampInt(hotTokensMaxRaw, {
  min: 10,
  max: 50_000,
  fallback: 5000,
});

const hotStreamTokensTtlSecRaw = parseOptionalInt(
  process.env.HOT_STREAM_TOKENS_TTL_SEC,
);
const hotStreamTokensTtlSec = clampInt(hotStreamTokensTtlSecRaw, {
  min: 60,
  max: 7 * 24 * 60 * 60,
  fallback: 1800,
});

const hotStreamTokensMaxRaw = parseOptionalInt(
  process.env.HOT_STREAM_TOKENS_MAX,
);
const hotStreamTokensMax = clampInt(hotStreamTokensMaxRaw, {
  min: 10,
  max: 50_000,
  fallback: 5000,
});

const wsHotShareRaw = parseOptionalFloat(
  process.env.POLYMARKET_WS_HOT_SHARE ?? process.env.WS_HOT_SHARE,
);
const wsHotShare = clampFloat(wsHotShareRaw, {
  min: 0,
  max: 1,
  fallback: 0.5,
});
const wsCustomFeatureEnabled = parseBoolean(
  process.env.POLYMARKET_WS_CUSTOM_FEATURE_ENABLED,
  true,
);
const dbStatementTimeoutMsRaw = parseOptionalInt(
  process.env.POLYMARKET_DB_STATEMENT_TIMEOUT_MS ??
    process.env.INDEXER_DB_STATEMENT_TIMEOUT_MS,
);
const dbStatementTimeoutMs = clampInt(dbStatementTimeoutMsRaw, {
  min: 0,
  max: 10 * 60_000,
  fallback: 120_000,
});

export const env = {
  dbUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL"),
  gammaBase:
    process.env.POLYMARKET_GAMMA_BASE ?? "https://gamma-api.polymarket.com",
  clobBase: process.env.POLYMARKET_CLOB_BASE ?? "https://clob.polymarket.com",
  wsUrl:
    process.env.POLYMARKET_WS ??
    "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  pageSize,
  refreshMinutes,
  wsRefreshSec,
  wsResubscribeSec,
  wsSubChunkSize,
  hotLookbackMinutes,
  hotMaxPages,
  overlapPages,
  // bootstrapLimit removed - now fetching all events
  hotTokensTtlSec,
  hotTokensMax,
  hotStreamTokensTtlSec,
  hotStreamTokensMax,
  hotStatusMaxEvents,
  topBookSnapshot: Number(process.env.INDEXER_TOP_BOOK_SNAPSHOT ?? "150"),
  wsSubset: Number(process.env.INDEXER_WS_SUBSET ?? "200"),
  wsConcurrency: process.env.INDEXER_WS_CONCURRENCY ?? "8",
  wsHotShare,
  wsCustomFeatureEnabled,
  dbStatementTimeoutMs,
};
