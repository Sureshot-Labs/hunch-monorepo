import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
config({ path: envPath, override: true });

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

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
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

const kalshiEnabledSetting = parseOptionalBool(process.env.KALSHI_ENABLED);
const kalshiKeyId = opt("KALSHI_API_KEY_ID");
const kalshiPrivateKeyPath = opt("KALSHI_PRIVATE_KEY_PATH");
const kalshiPrivateKeyResolvedPath = kalshiPrivateKeyPath
  ? resolve(kalshiPrivateKeyPath)
  : undefined;

const kalshiIssues: string[] = [];
if (!kalshiKeyId) kalshiIssues.push("Missing KALSHI_API_KEY_ID");
if (!kalshiPrivateKeyPath) kalshiIssues.push("Missing KALSHI_PRIVATE_KEY_PATH");
if (kalshiPrivateKeyResolvedPath && !existsSync(kalshiPrivateKeyResolvedPath)) {
  kalshiIssues.push(
    `KALSHI private key not found: ${kalshiPrivateKeyResolvedPath}`,
  );
}

const kalshiConfigured = kalshiIssues.length === 0;
const kalshiEnabled = kalshiEnabledSetting ?? kalshiConfigured;

const hotTokensTtlSec = clampInt(
  parseOptionalInt(process.env.HOT_TOKENS_TTL_SEC),
  { min: 60, max: 7 * 24 * 60 * 60, fallback: 600 },
);
const hotTokensMax = clampInt(parseOptionalInt(process.env.HOT_TOKENS_MAX), {
  min: 10,
  max: 50_000,
  fallback: 1000,
});

export const env = {
  dbUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL"),

  // Kalshi auth + base
  kalshiBase: process.env.KALSHI_API_BASE ?? "https://demo-api.kalshi.co",
  kalshiWsUrl:
    process.env.KALSHI_WS_URL ?? "wss://demo-api.kalshi.co/trade-api/ws/v2",
  kalshiEnabledSetting,
  kalshiEnabled,
  kalshiConfigured,
  kalshiIssues,
  kalshiKeyId,
  kalshiPrivateKeyPath,

  // indexer knobs
  bootstrapLimit: Number(process.env.INDEXER_BOOTSTRAP_LIMIT ?? "200"),
  topBookSnapshot: Number(process.env.INDEXER_TOP_BOOK_SNAPSHOT ?? "150"),
  hotTokensTtlSec,
  hotTokensMax,
  rpsRead: Number(process.env.KALSHI_RPS_READ ?? "18"), // under 20/s
  rpsWrite: Number(
    process.env.KALSHI_RPS_WRITE ?? process.env.KALSHI_RPS_WRIT ?? "9",
  ), // under 10/s
  wsSubset: Number(process.env.INDEXER_WS_SUBSET ?? "200"),
  wsConcurrency: process.env.INDEXER_WS_CONCURRENCY ?? "8",
};
