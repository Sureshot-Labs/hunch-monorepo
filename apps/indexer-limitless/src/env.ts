import { config } from "dotenv";
import { resolve } from "path";

const cwd = process.cwd(); // apps/indexer-limitless
config({ path: resolve(cwd, "../../.env"), override: true });

// nuke pg envs so Pool uses connectionString you provided
["PGHOST", "PGUSER", "PGPASSWORD", "PGPORT", "PGDATABASE", "PGSSLMODE"].forEach(
  (k) => delete process.env[k],
);

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[env] Missing ${name}. Put it in ../../.env`);
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
  opts: { min: number; max: number; fallback: number }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return opts.fallback;
  }
  return Math.min(opts.max, Math.max(opts.min, Math.trunc(value)));
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

const refreshMinutesRaw = Number(process.env.LIMITLESS_REFRESH_MIN ?? "5");
const refreshMinutes = Math.max(
  1,
  Number.isFinite(refreshMinutesRaw) ? refreshMinutesRaw : 5,
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

const hotTokensTtlSec = clampInt(
  parseOptionalInt(process.env.HOT_TOKENS_TTL_SEC),
  { min: 60, max: 7 * 24 * 60 * 60, fallback: 600 }
);
const hotTokensMax = clampInt(parseOptionalInt(process.env.HOT_TOKENS_MAX), {
  min: 10,
  max: 50_000,
  fallback: 1000,
});

export const env = {
  dbUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL"),

  limitlessEnabledSetting,
  limitlessEnabled: limitlessEnabledSetting ?? true,

  limitlessBase: process.env.LIMITLESS_BASE ?? "https://api.limitless.exchange",
  limitlessWsUrl:
    process.env.LIMITLESS_WS ?? "wss://ws.limitless.exchange",
  limitlessWsSession: process.env.LIMITLESS_WS_SESSION ?? "",
  // how many markets we’ll pull per bootstrap tick
  bootstrapPageSize,
  bootstrapMaxPages,
  // minutes between refreshes
  refreshMinutes,

  limitlessHttpMinDelayMs,
  limitlessHttpMaxRetries,
  limitlessHttpBackoffMs,
  hotTokensTtlSec,
  hotTokensMax,

  // AMM prices are % (0..100) in /markets/active; CLOB prices are 0..1.
  writePriceSnapshots: (process.env.LIMITLESS_SNAPSHOTS ?? "true") === "true",
  wsSubset: Number(process.env.INDEXER_WS_SUBSET ?? "200"),
  wsConcurrency: process.env.INDEXER_WS_CONCURRENCY ?? "8",

  venueName: "limitless",
  venueId: Number(process.env.LIMITLESS_VENUE_ID ?? "3"),
};
