import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), "../../.env"), override: true });

function req(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`[env] Missing ${name} in ../../.env`);
  return v;
}

function optionalPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const asInt = Math.trunc(n);
  return asInt > 0 ? asInt : fallback;
}

export const env = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT ?? "3001"),
  dbUrl: req("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "", // optional
  nodeEnv: process.env.NODE_ENV ?? "development",
  defaultLimit: Number(process.env.API_DEFAULT_LIMIT ?? "50"),
  maxLimit: Number(process.env.API_MAX_LIMIT ?? "200"),
  feedTtlSec: Number(process.env.API_FEED_TTL_SEC ?? "30"), // Default 30 seconds cache for feed API
  privyAppId: req("PRIVY_APP_ID"),
  privyAppSecret: req("PRIVY_APP_SECRET"),
  pricesSseMaxTokens: optionalPositiveInt("API_PRICES_SSE_MAX_TOKENS", 64),
  solanaRpcUrl:
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  solanaRpcTimeoutMs: optionalPositiveInt("SOLANA_RPC_TIMEOUT_MS", 10_000),
  polygonRpcUrl:
    process.env.POLYGON_RPC_URL?.trim() || "https://polygon-rpc.com",
  polygonRpcTimeoutMs: optionalPositiveInt("POLYGON_RPC_TIMEOUT_MS", 10_000),
};
