import { config } from "dotenv";
import { resolve } from "path";

const cwd = process.cwd(); // apps/indexer-polymarket
config({ path: resolve(cwd, "../../.env"), override: true }); // load repo .env

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
    console.error(`[env] Missing ${name}. Make sure it's in ../../.env`);
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
  fallback: 600,
});

const hotTokensMaxRaw = parseOptionalInt(process.env.HOT_TOKENS_MAX);
const hotTokensMax = clampInt(hotTokensMaxRaw, {
  min: 10,
  max: 50_000,
  fallback: 1000,
});

const wsHotShareRaw = parseOptionalFloat(
  process.env.POLYMARKET_WS_HOT_SHARE ?? process.env.WS_HOT_SHARE,
);
const wsHotShare = clampFloat(wsHotShareRaw, {
  min: 0,
  max: 1,
  fallback: 0.5,
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
  hotLookbackMinutes,
  hotMaxPages,
  overlapPages,
  // bootstrapLimit removed - now fetching all events
  hotTokensTtlSec,
  hotTokensMax,
  hotStatusMaxEvents,
  topBookSnapshot: Number(process.env.INDEXER_TOP_BOOK_SNAPSHOT ?? "150"),
  wsSubset: Number(process.env.INDEXER_WS_SUBSET ?? "200"),
  wsConcurrency: process.env.INDEXER_WS_CONCURRENCY ?? "8",
  wsHotShare,
};
