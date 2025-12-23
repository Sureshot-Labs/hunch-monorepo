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

function optionalNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const asInt = Math.trunc(n);
  return asInt >= 0 ? asInt : fallback;
}

function optionalNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n >= 0 ? n : fallback;
}

function parseOptionalBool(value: string | undefined): boolean | undefined {
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

function parseList(raw: string | undefined, fallback?: string): string[] {
  const values = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (values.length > 0) return values;
  if (fallback && fallback.trim().length > 0) return [fallback.trim()];
  return [];
}

const nodeEnv = process.env.NODE_ENV ?? "development";

const dflowEnvRaw = process.env.DFLOW_ENV?.trim().toLowerCase();
const dflowEnv: "dev" | "prod" =
  dflowEnvRaw === "dev" || dflowEnvRaw === "prod" ? dflowEnvRaw : "prod";

const dflowPredictionMarketsDefault =
  dflowEnv === "dev"
    ? "https://dev-prediction-markets-api.dflow.net"
    : "https://prediction-markets-api.dflow.net";
const dflowQuoteDefault =
  dflowEnv === "dev"
    ? "https://dev-quote-api.dflow.net"
    : "https://quote-api.dflow.net";
const dflowWsDefault =
  dflowEnv === "dev"
    ? "wss://dev-prediction-markets-api.dflow.net/api/v1/ws"
    : "wss://prediction-markets-api.dflow.net/api/v1/ws";

const dflowPredictionMarketsBase =
  process.env.DFLOW_PREDICTION_MARKETS_API_BASE?.trim() ||
  dflowPredictionMarketsDefault;
const dflowQuoteBase =
  process.env.DFLOW_QUOTE_API_BASE?.trim() || dflowQuoteDefault;
const dflowWsUrl = process.env.DFLOW_WS_URL?.trim() || dflowWsDefault;

if (nodeEnv.toLowerCase() === "production" && dflowEnv === "dev") {
  throw new Error("[env] DFLOW_ENV=dev is not allowed in production");
}

if (
  nodeEnv.toLowerCase() === "production" &&
  [dflowPredictionMarketsBase, dflowQuoteBase, dflowWsUrl].some((value) =>
    value.includes("dev-"),
  )
) {
  throw new Error(
    "[env] DFlow dev endpoints are not allowed in production",
  );
}

const dflowRequireApiKeySetting = parseOptionalBool(
  process.env.DFLOW_REQUIRE_API_KEY,
);
const dflowRequireApiKey = dflowRequireApiKeySetting ?? dflowEnv === "prod";
const dflowApiKey = process.env.DFLOW_API_KEY?.trim() || "";
const dflowConfigured = !dflowRequireApiKey || dflowApiKey.length > 0;

const solanaRpcUrls = parseList(
  process.env.SOLANA_RPC_URLS,
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
);

export const env = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT ?? "3001"),
  dbUrl: req("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "", // optional
  nodeEnv,
  defaultLimit: Number(process.env.API_DEFAULT_LIMIT ?? "50"),
  maxLimit: Number(process.env.API_MAX_LIMIT ?? "200"),
  feedTtlSec: Number(process.env.API_FEED_TTL_SEC ?? "30"), // Default 30 seconds cache for feed API
  positionsSyncCooldownSec: optionalNonNegativeInt(
    "POSITIONS_SYNC_COOLDOWN_SEC",
    45,
  ),
  hotTokensTtlSec: optionalPositiveInt("HOT_TOKENS_TTL_SEC", 600),
  hotTokensMax: optionalPositiveInt("HOT_TOKENS_MAX", 1000),
  privyAppId: req("PRIVY_APP_ID"),
  privyAppSecret: req("PRIVY_APP_SECRET"),
  pricesSseMaxTokens: optionalPositiveInt("API_PRICES_SSE_MAX_TOKENS", 64),
  solanaRpcUrls,
  solanaRpcUrl: solanaRpcUrls[0],
  solanaRpcTimeoutMs: optionalPositiveInt("SOLANA_RPC_TIMEOUT_MS", 10_000),
  solanaUsdcMint:
    process.env.DFLOW_USDC_MINT?.trim() ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  polygonRpcUrl:
    process.env.POLYGON_RPC_URL?.trim() || "https://polygon-rpc.com",
  polygonRpcTimeoutMs: optionalPositiveInt("POLYGON_RPC_TIMEOUT_MS", 10_000),
  baseRpcUrl:
    process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org",
  baseRpcTimeoutMs: optionalPositiveInt("BASE_RPC_TIMEOUT_MS", 10_000),
  polymarketClobBase:
    process.env.POLYMARKET_CLOB_BASE?.trim() || "https://clob.polymarket.com",
  polymarketUsdcAddress:
    process.env.POLYMARKET_USDC_ADDRESS?.trim() ||
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  polymarketExchangeAddress:
    process.env.POLYMARKET_EXCHANGE_ADDRESS?.trim() ||
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  polymarketNegRiskExchangeAddress:
    process.env.POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS?.trim() ||
    "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  polymarketNegRiskAdapterAddress:
    process.env.POLYMARKET_NEG_RISK_ADAPTER_ADDRESS?.trim() ||
    "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  polymarketConditionalTokensAddress:
    process.env.POLYMARKET_CONDITIONAL_TOKENS_ADDRESS?.trim() ||
    "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  polymarketSafeFactoryAddress:
    process.env.POLYMARKET_SAFE_FACTORY_ADDRESS?.trim() ||
    "0xaacfeea03eb1561c4e67d661e40682bd20e3541b",
  polymarketSafeInitCodeHash:
    process.env.POLYMARKET_SAFE_INIT_CODE_HASH?.trim() ||
    "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf",
  polymarketMagicProxyFactoryAddress:
    process.env.POLYMARKET_MAGIC_PROXY_FACTORY_ADDRESS?.trim() ||
    "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052",
  polymarketMagicProxyImplementation:
    process.env.POLYMARKET_MAGIC_PROXY_IMPLEMENTATION?.trim() ||
    "0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f",

  // Fee policy (defaults to 0 bps)
  feeBpsPolymarket: optionalNonNegativeInt("HUNCH_FEE_BPS_POLYMARKET", 0),
  feeBpsKalshi: optionalNonNegativeInt("HUNCH_FEE_BPS_KALSHI", 0),
  feeScaleKalshi: optionalNonNegativeNumber("HUNCH_FEE_SCALE_KALSHI", 0),
  feePolicyTtlSec: optionalPositiveInt(
    "HUNCH_FEE_POLICY_TTL_SEC",
    7 * 24 * 60 * 60,
  ),
  feeCollectorAddress:
    process.env.HUNCH_FEE_COLLECTOR_ADDRESS?.trim() || "",
  feeCollectorPrivateKey:
    process.env.HUNCH_FEE_COLLECTOR_PRIVATE_KEY?.trim() || "",
  dflowFeeAccount: process.env.DFLOW_USDC_FEE_ACCOUNT?.trim() || "",

  debridgeDlnBase:
    process.env.DEBRIDGE_DLN_BASE?.trim() || "https://dln.debridge.finance/v1.0",
  debridgeStatsBase:
    process.env.DEBRIDGE_STATS_BASE?.trim() || "https://stats-api.dln.trade/api",

  polymarketBuilderApiKey:
    process.env.POLYMARKET_BUILDER_API_KEY?.trim() || "",
  polymarketBuilderApiSecret:
    process.env.POLYMARKET_BUILDER_API_SECRET?.trim() || "",
  polymarketBuilderApiPassphrase:
    process.env.POLYMARKET_BUILDER_API_PASSPHRASE?.trim() || "",

  // DFlow config (execution-ready)
  dflowEnv,
  dflowPredictionMarketsBase,
  dflowQuoteBase,
  dflowWsUrl,
  dflowRequireApiKey,
  dflowApiKey,
  dflowConfigured,
};
