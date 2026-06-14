import { config } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const envPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
if (process.env.HUNCH_RUNTIME_SECRETS_LOADED !== "1") {
  config({ path: envPath, override: true });
}

["PGHOST", "PGUSER", "PGPASSWORD", "PGPORT", "PGDATABASE", "PGSSLMODE"].forEach(
  (key) => delete process.env[key],
);

function parseBool(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  switch (value.toLowerCase()) {
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

function parseIntEnv(
  name: string,
  opts: { min: number; max: number; fallback: number },
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, Math.trunc(parsed)));
}

function parseIntEnvWithFallback(
  names: string[],
  opts: { min: number; max: number; fallback: number },
): number {
  for (const name of names) {
    const value = process.env[name];
    if (value == null || value === "") continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    return Math.min(opts.max, Math.max(opts.min, Math.trunc(parsed)));
  }
  return opts.fallback;
}

export const env = {
  dbUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  hyperliquidEnabled: parseBool(process.env.HYPERLIQUID_ENABLED) ?? false,
  writeDb: parseBool(process.env.HYPERLIQUID_WRITE_DB) ?? false,
  syncTopBooks: parseBool(process.env.HYPERLIQUID_SYNC_TOP_BOOKS) ?? true,
  mainnetInfoUrl:
    process.env.HYPERLIQUID_INFO_URL ?? "https://api.hyperliquid.xyz/info",
  mainnetWsUrl:
    process.env.HYPERLIQUID_WS_URL ?? "wss://api.hyperliquid.xyz/ws",
  testnetInfoUrl:
    process.env.HYPERLIQUID_TESTNET_INFO_URL ??
    "https://api.hyperliquid-testnet.xyz/info",
  testnetWsUrl:
    process.env.HYPERLIQUID_TESTNET_WS_URL ??
    "wss://api.hyperliquid-testnet.xyz/ws",
  requestTimeoutMs: parseIntEnv("HYPERLIQUID_HTTP_TIMEOUT_MS", {
    min: 1_000,
    max: 60_000,
    fallback: 10_000,
  }),
  refreshSec: parseIntEnv("HYPERLIQUID_REFRESH_SEC", {
    min: 30,
    max: 24 * 60 * 60,
    fallback: 300,
  }),
  syncCandleTotals:
    parseBool(process.env.HYPERLIQUID_SYNC_CANDLE_TOTALS) ?? true,
  candleTotalMaxMarkets: parseIntEnv("HYPERLIQUID_CANDLE_TOTAL_MAX_MARKETS", {
    min: 0,
    max: 5_000,
    fallback: 250,
  }),
  candleTotalConcurrency: parseIntEnv("HYPERLIQUID_CANDLE_TOTAL_CONCURRENCY", {
    min: 1,
    max: 50,
    fallback: 4,
  }),
  maxTopBookSyncTokens: parseIntEnv("HYPERLIQUID_MAX_TOP_BOOK_SYNC_TOKENS", {
    min: 0,
    max: 1_000,
    fallback: 64,
  }),
  topBookSyncConcurrency: parseIntEnv("HYPERLIQUID_TOP_BOOK_SYNC_CONCURRENCY", {
    min: 1,
    max: 50,
    fallback: 8,
  }),
  wsRefreshSec: parseIntEnv("HYPERLIQUID_WS_REFRESH_SEC", {
    min: 10,
    max: 60 * 60,
    fallback: 60,
  }),
  wsTargetBookMaxAgeSec: parseIntEnv(
    "HYPERLIQUID_WS_TARGET_BOOK_MAX_AGE_SEC",
    {
      min: 60,
      max: 24 * 60 * 60,
      fallback: 15 * 60,
    },
  ),
  wsReconnectSec: parseIntEnv("HYPERLIQUID_WS_RECONNECT_SEC", {
    min: 1,
    max: 10 * 60,
    fallback: 5,
  }),
  wsHeartbeatSec: parseIntEnv("HYPERLIQUID_WS_HEARTBEAT_SEC", {
    min: 5,
    max: 5 * 60,
    fallback: 20,
  }),
  wsPongTimeoutSec: parseIntEnv("HYPERLIQUID_WS_PONG_TIMEOUT_SEC", {
    min: 10,
    max: 10 * 60,
    fallback: 60,
  }),
  wsResubscribeSec: parseIntEnv("HYPERLIQUID_WS_RESUBSCRIBE_SEC", {
    min: 30,
    max: 60 * 60,
    fallback: 120,
  }),
  wsConcurrency: parseIntEnvWithFallback(
    ["HYPERLIQUID_WS_CONCURRENCY", "INDEXER_WS_CONCURRENCY"],
    {
      min: 1,
      max: 1_000,
      fallback: 8,
    },
  ),
  wsQueueMax: parseIntEnvWithFallback(
    ["HYPERLIQUID_WS_QUEUE_MAX", "INDEXER_WS_QUEUE_MAX"],
    {
      min: 1,
      max: 500_000,
      fallback: 10_000,
    },
  ),
  hotTokensTtlSec: parseIntEnv("HOT_TOKENS_TTL_SEC", {
    min: 60,
    max: 7 * 24 * 60 * 60,
    fallback: 1800,
  }),
  hotTokensMax: parseIntEnv("HOT_TOKENS_MAX", {
    min: 10,
    max: 50_000,
    fallback: 5000,
  }),
  hotStreamTokensTtlSec: parseIntEnv("HOT_STREAM_TOKENS_TTL_SEC", {
    min: 60,
    max: 7 * 24 * 60 * 60,
    fallback: 1800,
  }),
  hotStreamTokensMax: parseIntEnv("HOT_STREAM_TOKENS_MAX", {
    min: 10,
    max: 50_000,
    fallback: 5000,
  }),
};
