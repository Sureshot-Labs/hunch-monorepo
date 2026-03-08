import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
config({ path: envPath, override: true }); // load repo .env

// 🧹 Prevent pg from mixing PG* env with your connectionString
["PGHOST", "PGUSER", "PGPASSWORD", "PGPORT", "PGDATABASE", "PGSSLMODE"].forEach(
  (k) => delete process.env[k],
);

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[env] Missing ${name}. Make sure it's in ${envPath}`);
    process.exit(1);
  }
  return v;
}

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length ? v.trim() : undefined;
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

function parseCsvLowercase(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? items : undefined;
}

const dflowEnabledSetting = parseOptionalBool(process.env.DFLOW_ENABLED);
const dflowApiKey = opt("DFLOW_API_KEY");

const dflowEnvRaw = opt("DFLOW_ENV")?.toLowerCase();
const dflowEnv: "dev" | "prod" =
  dflowEnvRaw === "dev" || dflowEnvRaw === "prod" ? dflowEnvRaw : "prod";

const requireApiKeySetting = parseOptionalBool(
  process.env.DFLOW_REQUIRE_API_KEY,
);
const requireApiKey = requireApiKeySetting ?? dflowEnv === "prod";

const nodeEnv = process.env.NODE_ENV?.toLowerCase();
if (nodeEnv === "production" && dflowEnv === "dev") {
  console.error("[env] DFLOW_ENV=dev is not allowed when NODE_ENV=production");
  process.exit(1);
}

const defaultPredictionMarketsBase =
  dflowEnv === "dev"
    ? "https://dev-prediction-markets-api.dflow.net"
    : "https://prediction-markets-api.dflow.net";
const defaultQuoteBase =
  dflowEnv === "dev"
    ? "https://dev-quote-api.dflow.net"
    : "https://a.quote-api.dflow.net";
const defaultWsUrl =
  dflowEnv === "dev"
    ? "wss://dev-prediction-markets-api.dflow.net/api/v1/ws"
    : "wss://prediction-markets-api.dflow.net/api/v1/ws";

const dflowPredictionMarketsBase =
  opt("DFLOW_PREDICTION_MARKETS_API_BASE") ?? defaultPredictionMarketsBase;
const dflowQuoteBase = opt("DFLOW_QUOTE_API_BASE") ?? defaultQuoteBase;
const dflowWsUrl = opt("DFLOW_WS_URL") ?? defaultWsUrl;

if (
  nodeEnv === "production" &&
  [dflowPredictionMarketsBase, dflowQuoteBase, dflowWsUrl].some((value) =>
    value.includes("dev-"),
  )
) {
  console.error(
    "[env] DFlow dev endpoints are not allowed when NODE_ENV=production",
  );
  process.exit(1);
}

const dflowIssues: string[] = [];
if (requireApiKey && !dflowApiKey) {
  dflowIssues.push("Missing DFLOW_API_KEY (required)");
}

const defaultSolanaUsdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const solanaUsdcMint = opt("DFLOW_USDC_MINT") ?? defaultSolanaUsdcMint;
if (!solanaUsdcMint) {
  dflowIssues.push("Missing DFLOW_USDC_MINT (effective value is empty)");
}

const dflowConfigured = dflowIssues.length === 0;
const dflowEnabled = dflowEnabledSetting ?? dflowConfigured;

const refreshMinutesRaw = parseOptionalInt(process.env.DFLOW_REFRESH_MIN);
const refreshMinutes = clampInt(refreshMinutesRaw, {
  min: 1,
  max: 24 * 60,
  fallback: 10,
});

const wsRefreshSecRaw = parseOptionalInt(
  process.env.DFLOW_WS_REFRESH_SEC ?? process.env.INDEXER_WS_REFRESH_SEC,
);
const wsRefreshSec = clampInt(wsRefreshSecRaw, {
  min: 10,
  max: 3600,
  fallback: 60,
});

const pageSizeRaw = parseOptionalInt(process.env.DFLOW_PAGE_SIZE);
const pageSize = clampInt(pageSizeRaw, { min: 1, max: 500, fallback: 100 });

const hotEnabledSetting = parseOptionalBool(process.env.DFLOW_HOT_ENABLED);
const hotEnabled = hotEnabledSetting ?? true;

const hotMaxPagesRaw = parseOptionalInt(process.env.DFLOW_HOT_MAX_PAGES);
const hotMaxPages = clampInt(hotMaxPagesRaw, {
  min: 1,
  max: 10_000,
  fallback: 2,
});

const hotSort =
  opt("DFLOW_HOT_SORT") ??
  ("volume24h" satisfies
    | "volume"
    | "volume24h"
    | "liquidity"
    | "openInterest"
    | "startDate");

const catchupEnabledSetting = parseOptionalBool(
  process.env.DFLOW_CATCHUP_ENABLED,
);
const catchupEnabled = catchupEnabledSetting ?? true;

const overlapPagesRaw = parseOptionalInt(process.env.DFLOW_OVERLAP_PAGES);
const overlapPages = clampInt(overlapPagesRaw, {
  min: 0,
  max: 10_000,
  fallback: 5,
});

const catchupMaxPagesRaw = parseOptionalInt(
  process.env.DFLOW_CATCHUP_MAX_PAGES,
);
const catchupMaxPages = clampInt(catchupMaxPagesRaw, {
  min: 0,
  max: 100_000,
  fallback: 0,
});

const nonActiveSweepEnabledSetting = parseOptionalBool(
  process.env.DFLOW_NON_ACTIVE_SWEEP_ENABLED,
);
const nonActiveSweepEnabled = nonActiveSweepEnabledSetting ?? true;
const nonActiveSweepEvery = clampInt(
  parseOptionalInt(process.env.DFLOW_NON_ACTIVE_SWEEP_EVERY),
  { min: 1, max: 10_000, fallback: 2 },
);
const nonActiveSweepMaxPages = clampInt(
  parseOptionalInt(process.env.DFLOW_NON_ACTIVE_SWEEP_MAX_PAGES),
  { min: 1, max: 10_000, fallback: 20 },
);
const nonActiveSweepPageSize = clampInt(
  parseOptionalInt(process.env.DFLOW_NON_ACTIVE_SWEEP_PAGE_SIZE),
  { min: 1, max: 500, fallback: 100 },
);
const nonActiveSweepOverlapPages = clampInt(
  parseOptionalInt(process.env.DFLOW_NON_ACTIVE_SWEEP_OVERLAP_PAGES),
  { min: 0, max: 1000, fallback: 1 },
);
const allowedSweepStatuses = new Set([
  "closed",
  "inactive",
  "settled",
  "archived",
  "resolved",
]);
const nonActiveSweepStatuses =
  parseCsvLowercase(process.env.DFLOW_NON_ACTIVE_SWEEP_STATUSES)?.filter(
    (status) => allowedSweepStatuses.has(status),
  ) ?? ["closed", "inactive"];

const hotTokensTtlSec = clampInt(parseOptionalInt(process.env.HOT_TOKENS_TTL_SEC), {
  min: 60,
  max: 7 * 24 * 60 * 60,
  fallback: 1800,
});
const hotTokensMax = clampInt(parseOptionalInt(process.env.HOT_TOKENS_MAX), {
  min: 10,
  max: 50_000,
  fallback: 5000,
});
const hotStreamTokensTtlSec = clampInt(
  parseOptionalInt(process.env.HOT_STREAM_TOKENS_TTL_SEC),
  {
    min: 60,
    max: 7 * 24 * 60 * 60,
    fallback: 1800,
  },
);
const hotStreamTokensMax = clampInt(
  parseOptionalInt(process.env.HOT_STREAM_TOKENS_MAX),
  {
    min: 10,
    max: 50_000,
    fallback: 5000,
  },
);

const isInitializedSetting = parseOptionalBool(
  process.env.DFLOW_IS_INITIALIZED,
);

const requireInitializedSetting = parseOptionalBool(
  process.env.DFLOW_REQUIRE_INITIALIZED,
);
const requireInitialized = requireInitializedSetting ?? dflowEnv === "prod";

const dflowWsAllSetting = parseOptionalBool(process.env.DFLOW_WS_ALL);
const dflowWsAll = dflowWsAllSetting ?? false;

const dflowWsLogEverySec = clampInt(
  parseOptionalInt(process.env.DFLOW_WS_LOG_EVERY_SEC),
  { min: 0, max: 3600, fallback: 0 },
);

const wsHotShareRaw = parseOptionalFloat(
  process.env.DFLOW_WS_HOT_SHARE ?? process.env.WS_HOT_SHARE,
);
const wsHotShare = clampFloat(wsHotShareRaw, {
  min: 0,
  max: 1,
  fallback: 0.5,
});

const tradesTokenLimit = clampInt(
  parseOptionalInt(process.env.DFLOW_TRADES_TOKEN_LIMIT),
  { min: 1, max: 2000, fallback: 200 },
);
const tradesPerMintLimit = clampInt(
  parseOptionalInt(process.env.DFLOW_TRADES_PER_MINT),
  { min: 1, max: 1000, fallback: 50 },
);
const tradesConcurrency = clampInt(
  parseOptionalInt(process.env.DFLOW_TRADES_CONCURRENCY),
  { min: 1, max: 50, fallback: 8 },
);

const seriesRefreshHours = clampInt(
  parseOptionalInt(process.env.DFLOW_SERIES_REFRESH_HOURS),
  { min: 1, max: 168, fallback: 24 },
);
const seriesPageSizeRaw = parseOptionalInt(process.env.DFLOW_SERIES_PAGE_SIZE);
const seriesPageSize =
  seriesPageSizeRaw != null
    ? clampInt(seriesPageSizeRaw, { min: 1, max: 5000, fallback: 1000 })
    : undefined;
const seriesMaxPages = clampInt(
  parseOptionalInt(process.env.DFLOW_SERIES_MAX_PAGES),
  { min: 0, max: 100_000, fallback: 0 },
);

export const env = {
  dbUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL"),

  // DFlow hosts + auth
  dflowEnv,
  requireApiKeySetting,
  requireApiKey,

  dflowPredictionMarketsBase,
  dflowQuoteBase,
  dflowWsUrl,
  dflowApiKey,
  dflowEnabledSetting,
  dflowEnabled,
  dflowConfigured,
  dflowIssues,

  // Indexer knobs (shared defaults used by other indexers too)
  refreshMinutes,
  wsRefreshSec,
  pageSize,
  hotEnabledSetting,
  hotEnabled,
  hotMaxPages,
  hotSort,
  catchupEnabledSetting,
  catchupEnabled,
  overlapPages,
  catchupMaxPages,
  nonActiveSweepEnabledSetting,
  nonActiveSweepEnabled,
  nonActiveSweepEvery,
  nonActiveSweepMaxPages,
  nonActiveSweepPageSize,
  nonActiveSweepOverlapPages,
  nonActiveSweepStatuses,
  hotTokensTtlSec,
  hotTokensMax,
  hotStreamTokensTtlSec,
  hotStreamTokensMax,
  isInitializedSetting,
  isInitialized: isInitializedSetting,
  requireInitializedSetting,
  requireInitialized,
  dflowWsAll,
  dflowWsLogEverySec,
  tradesTokenLimit,
  tradesPerMintLimit,
  tradesConcurrency,
  seriesRefreshHours,
  seriesPageSize,
  seriesMaxPages,
  topBookSnapshot: Number(process.env.INDEXER_TOP_BOOK_SNAPSHOT ?? "150"),
  wsSubset: Number(process.env.INDEXER_WS_SUBSET ?? "200"),
  wsConcurrency: process.env.INDEXER_WS_CONCURRENCY ?? "8",
  wsHotShare,

  // Phase 1 constraint (documented in INTEGRATIONS_PLAN.md)
  solanaUsdcMint,
};
