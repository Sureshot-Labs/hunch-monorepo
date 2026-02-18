import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseUsdcToMicro, usdcMicroToDecimalString } from "./lib/usdc.js";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
config({ path: envPath, override: true });

function req(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`[env] Missing ${name} in ${envPath}`);
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

function optionalRatio01(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0 || n > 1) return fallback;
  return n;
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

function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  const match = allowed.find((entry) => entry === normalized);
  return match ?? fallback;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const enableSwaggerSetting = parseOptionalBool(process.env.ENABLE_SWAGGER);
const enableSwagger =
  enableSwaggerSetting ?? nodeEnv.toLowerCase() !== "production";
const trustProxySetting = parseOptionalBool(process.env.TRUST_PROXY);
const trustProxy = trustProxySetting ?? false;
const proxySecret = process.env.HUNCH_PROXY_SECRET?.trim() || "";

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
    : "https://a.quote-api.dflow.net";
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

const dflowGeoBlockEnabledSetting = parseOptionalBool(
  process.env.DFLOW_GEO_BLOCK_ENABLED,
);
const dflowGeoBlockEnabled = dflowGeoBlockEnabledSetting ?? false;
const dflowGeoBlockCountries = parseList(
  process.env.DFLOW_GEO_BLOCK_COUNTRIES,
).map((country) => country.toUpperCase());
const dflowGeoBlockDefaultRaw = process.env.DFLOW_GEO_BLOCK_DEFAULT
  ?.trim()
  .toLowerCase();
const dflowGeoBlockDefault: "allow" | "block" =
  dflowGeoBlockDefaultRaw === "allow" ? "allow" : "block";

const kalshiProofEnabled =
  parseOptionalBool(process.env.KALSHI_PROOF_ENABLED) ?? false;
const kalshiProofCacheVerifiedTtlMs = optionalPositiveInt(
  "KALSHI_PROOF_CACHE_VERIFIED_TTL_MS",
  600_000,
);
const kalshiProofCacheUnverifiedTtlMs = optionalNonNegativeInt(
  "KALSHI_PROOF_CACHE_UNVERIFIED_TTL_MS",
  20_000,
);

if (dflowGeoBlockEnabled && dflowGeoBlockCountries.length === 0) {
  throw new Error(
    "[env] DFLOW_GEO_BLOCK_COUNTRIES is required when DFLOW_GEO_BLOCK_ENABLED=true",
  );
}

const solanaRpcUrls = parseList(
  process.env.SOLANA_RPC_URLS,
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
);
const aiWhaleProfileAutoRun =
  parseOptionalBool(process.env.AI_WHALE_PROFILE_AUTORUN) ?? false;
const aiWhaleProfileLimit = optionalPositiveInt("AI_WHALE_PROFILE_LIMIT", 15);
const aiWhaleProfileMarketLimit = optionalPositiveInt(
  "AI_WHALE_PROFILE_MARKET_LIMIT",
  5,
);
const aiWhaleProfileWindowDays = optionalPositiveInt(
  "AI_WHALE_PROFILE_WINDOW_DAYS",
  30,
);
const aiWhaleProfileModel =
  process.env.AI_WHALE_PROFILE_MODEL?.trim() || "openai/gpt-5.2";
const walletIntelWhaleUsd = optionalNonNegativeNumber(
  "WALLET_INTEL_WHALE_USD",
  10_000,
);
const walletIntelWhaleUsdSolana = optionalNonNegativeNumber(
  "WALLET_INTEL_WHALE_USD_SOLANA",
  walletIntelWhaleUsd,
);
const walletIntelMarketLimitPerVenue = optionalNonNegativeInt(
  "WALLET_INTEL_MARKET_LIMIT_PER_VENUE",
  10,
);
const walletIntelMarketLimitKalshi = optionalNonNegativeInt(
  "WALLET_INTEL_MARKET_LIMIT_KALSHI",
  walletIntelMarketLimitPerVenue,
);
const walletIntelWhaleMarketLimit = optionalNonNegativeInt(
  "WALLET_INTEL_WHALE_MARKET_LIMIT",
  50,
);
const walletIntelWatchlistMarketLimit = optionalPositiveInt(
  "WALLET_INTEL_WATCHLIST_MARKET_LIMIT",
  200,
);
const walletIntelFollowedWalletLimit = optionalPositiveInt(
  "WALLET_INTEL_FOLLOWED_WALLET_LIMIT",
  500,
);
const walletIntelTokenLimitPoly = optionalPositiveInt(
  "WALLET_INTEL_TOKEN_LIMIT_POLY",
  2_000,
);
const walletIntelTokenLimitLimitless = optionalPositiveInt(
  "WALLET_INTEL_TOKEN_LIMIT_LIMITLESS",
  2_000,
);
const walletIntelTokenLimitKalshi = optionalPositiveInt(
  "WALLET_INTEL_TOKEN_LIMIT_KALSHI",
  2_000,
);
const walletIntelBackfillMaxSteps = optionalPositiveInt(
  "WALLET_INTEL_BACKFILL_MAX_STEPS",
  6,
);
const walletIntelSelectionModePoly = parseEnum(
  process.env.WALLET_INTEL_SELECTION_MODE_POLY,
  ["trade_24h", "trade_1h", "volume_24h", "liquidity", "hybrid"],
  "trade_24h",
);
const walletIntelSelectionModeKalshi = parseEnum(
  process.env.WALLET_INTEL_SELECTION_MODE_KALSHI,
  ["trade_24h", "trade_1h", "open_interest", "updated", "hybrid"],
  "trade_24h",
);
const walletIntelSelectionModeLimitless = parseEnum(
  process.env.WALLET_INTEL_SELECTION_MODE_LIMITLESS,
  ["liquidity", "book", "updated", "hybrid"],
  "liquidity",
);
const walletIntelSignalWeightStake = optionalNonNegativeNumber(
  "WALLET_INTEL_SIGNAL_WEIGHT_STAKE",
  0.4,
);
const walletIntelSignalWeightOdds = optionalNonNegativeNumber(
  "WALLET_INTEL_SIGNAL_WEIGHT_ODDS",
  0.3,
);
const walletIntelSignalWeightIdle = optionalNonNegativeNumber(
  "WALLET_INTEL_SIGNAL_WEIGHT_IDLE",
  0.2,
);
const walletIntelSignalWeightNovelty = optionalNonNegativeNumber(
  "WALLET_INTEL_SIGNAL_WEIGHT_NOVELTY",
  0.1,
);
const positionsSyncFlattenGraceSec = optionalNonNegativeInt(
  "POSITIONS_SYNC_FLATTEN_GRACE_SEC",
  45,
);
const limitlessPositionsSyncFlattenGraceSec = optionalNonNegativeInt(
  "LIMITLESS_POSITIONS_SYNC_FLATTEN_GRACE_SEC",
  positionsSyncFlattenGraceSec,
);
const rewardsTreasuryMinSweepUsdRaw =
  process.env.HUNCH_REWARDS_TREASURY_MIN_SWEEP_USD?.trim() || "0";
const rewardsTreasuryMinSweepMicro = parseUsdcToMicro(
  rewardsTreasuryMinSweepUsdRaw,
);
if (rewardsTreasuryMinSweepMicro == null) {
  throw new Error(
    "[env] Invalid HUNCH_REWARDS_TREASURY_MIN_SWEEP_USD (must be non-negative decimal with up to 6 decimals)",
  );
}
const rewardsTreasuryMinSweepUsd = Number(
  usdcMicroToDecimalString(rewardsTreasuryMinSweepMicro),
);

export const env = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT ?? "3001"),
  dbUrl: req("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "", // optional
  nodeEnv,
  enableSwagger,
  trustProxy,
  proxySecret,
  defaultLimit: Number(process.env.API_DEFAULT_LIMIT ?? "50"),
  maxLimit: Number(process.env.API_MAX_LIMIT ?? "200"),
  feedTtlSec: Number(process.env.API_FEED_TTL_SEC ?? "30"), // Default 30 seconds cache for feed API
  holdersTtlSec: Number(process.env.API_HOLDERS_TTL_SEC ?? "300"),
  holdersTtlSecPolymarket: Number(
    process.env.API_HOLDERS_TTL_SEC_POLYMARKET ?? "60",
  ),
  similarMarketsCacheTtlSec: optionalNonNegativeInt(
    "API_SIMILAR_CACHE_TTL_SEC",
    300,
  ),
  positionsSyncCooldownSec: optionalNonNegativeInt(
    "POSITIONS_SYNC_COOLDOWN_SEC",
    15,
  ),
  positionsSyncConcurrencyEvm: optionalNonNegativeInt(
    "POSITIONS_SYNC_CONCURRENCY_EVM",
    2,
  ),
  positionsSyncConcurrencySolana: optionalNonNegativeInt(
    "POSITIONS_SYNC_CONCURRENCY_SOLANA",
    2,
  ),
  positionsSyncFlattenGraceSec,
  limitlessPositionsSyncFlattenGraceSec,
  hotTokensTtlSec: optionalPositiveInt("HOT_TOKENS_TTL_SEC", 1800),
  hotTokensMax: optionalPositiveInt("HOT_TOKENS_MAX", 5000),
  hotStreamTokensTtlSec: optionalPositiveInt("HOT_STREAM_TOKENS_TTL_SEC", 1800),
  hotStreamTokensMax: optionalPositiveInt("HOT_STREAM_TOKENS_MAX", 5000),
  hotStreamMarkIntervalSec: optionalPositiveInt(
    "HOT_STREAM_MARK_INTERVAL_SEC",
    60,
  ),
  openRouterKey: process.env.OPENROUTER_API_KEY?.trim() || "",
  aiWhaleProfileAutoRun,
  aiWhaleProfileLimit,
  aiWhaleProfileMarketLimit,
  aiWhaleProfileWindowDays,
  aiWhaleProfileModel,
  aiClusterAnalysisEnabled:
    parseOptionalBool(process.env.AI_CLUSTER_ANALYSIS_ENABLED) ?? false,
  aiClusterModelFast:
    process.env.AI_CLUSTER_MODEL_FAST?.trim() || "openai/gpt-5-nano",
  aiClusterModelFinal:
    process.env.AI_CLUSTER_MODEL_FINAL?.trim() || "openai/gpt-5.2",
  aiClusterModelFallback:
    process.env.AI_CLUSTER_MODEL_FALLBACK?.trim() || "openai/gpt-4o-mini",
  aiClusterMaxStageB: optionalNonNegativeInt("AI_CLUSTER_MAX_STAGE_B", 50),
  aiClusterReanalyzeHours: optionalNonNegativeInt(
    "AI_CLUSTER_REANALYZE_HOURS",
    24,
  ),
  aiClusterUseWebContext:
    parseOptionalBool(process.env.AI_CLUSTER_USE_WEB_CONTEXT) ?? false,
  aiClusterWebMaxResults: optionalNonNegativeInt(
    "AI_CLUSTER_WEB_MAX_RESULTS",
    5,
  ),
  aiClusterMinConfidence: optionalNonNegativeNumber(
    "AI_CLUSTER_MIN_CONFIDENCE",
    0.6,
  ),
  aiClusterMaxOutlierRatio: optionalNonNegativeNumber(
    "AI_CLUSTER_MAX_OUTLIER_RATIO",
    0.4,
  ),
  aiClusterAnalysisMinSpread: optionalNonNegativeNumber(
    "AI_CLUSTER_ANALYSIS_MIN_SPREAD",
    0.02,
  ),
  aiClusterAnalysisMinQuality: optionalNonNegativeNumber(
    "AI_CLUSTER_ANALYSIS_MIN_QUALITY",
    0.45,
  ),
  aiClusterAnalysisMinVenueCount: optionalNonNegativeInt(
    "AI_CLUSTER_ANALYSIS_MIN_VENUE_COUNT",
    2,
  ),
  aiClusterAnalysisConcurrency: optionalPositiveInt(
    "AI_CLUSTER_ANALYSIS_CONCURRENCY",
    3,
  ),
  aiClusterDebugLogs:
    parseOptionalBool(process.env.AI_CLUSTER_DEBUG_LOGS) ?? false,
  aiWhaleProfileStyleGuide:
    process.env.AI_WHALE_PROFILE_STYLE_GUIDE?.trim() ||
    "Neutral tone, short sentences, no hype, no speculation.",
  aiWhaleProfileMaxTokens: optionalPositiveInt(
    "AI_WHALE_PROFILE_MAX_TOKENS",
    800,
  ),
  aiWhaleProfileMaxTokensFallback: optionalPositiveInt(
    "AI_WHALE_PROFILE_MAX_TOKENS_FALLBACK",
    420,
  ),
  walletIntelMarketLimit: optionalPositiveInt(
    "WALLET_INTEL_MARKET_LIMIT",
    50,
  ),
  walletIntelMarketLimitPerVenue,
  walletIntelMarketLimitKalshi,
  walletIntelWhaleMarketLimit,
  walletIntelWatchlistMarketLimit,
  walletIntelFollowedWalletLimit,
  walletIntelTokenLimitPoly,
  walletIntelTokenLimitLimitless,
  walletIntelTokenLimitKalshi,
  walletIntelSelectionModePoly,
  walletIntelSelectionModeKalshi,
  walletIntelSelectionModeLimitless,
  walletIntelHolderLimit: optionalPositiveInt(
    "WALLET_INTEL_HOLDER_LIMIT",
    20,
  ),
  walletIntelSnapshotHours: optionalPositiveInt(
    "WALLET_INTEL_SNAPSHOT_HOURS",
    6,
  ),
  walletIntelBackfillSnapshots: optionalNonNegativeInt(
    "WALLET_INTEL_BACKFILL_SNAPSHOTS",
    0,
  ),
  walletIntelBackfillMaxSteps,
  walletIntelRetentionDaysSnapshots: optionalNonNegativeInt(
    "WALLET_INTEL_RETENTION_DAYS_SNAPSHOTS",
    0,
  ),
  walletIntelRetentionDaysActivity: optionalNonNegativeInt(
    "WALLET_INTEL_RETENTION_DAYS_ACTIVITY",
    0,
  ),
  walletIntelRetentionDaysMetrics: optionalNonNegativeInt(
    "WALLET_INTEL_RETENTION_DAYS_METRICS",
    0,
  ),
  walletIntelMinVolume24h: optionalNonNegativeNumber(
    "WALLET_INTEL_MIN_VOLUME_24H",
    0,
  ),
  walletIntelMinActivityUsd: optionalNonNegativeNumber(
    "WALLET_INTEL_MIN_ACTIVITY_USD",
    0.01,
  ),
  walletIntelMinActivityShares: optionalNonNegativeNumber(
    "WALLET_INTEL_MIN_ACTIVITY_SHARES",
    0.001,
  ),
  walletIntelMinPositionUsd: optionalNonNegativeNumber(
    "WALLET_INTEL_MIN_POSITION_USD",
    0.01,
  ),
  walletIntelMinPositionShares: optionalNonNegativeNumber(
    "WALLET_INTEL_MIN_POSITION_SHARES",
    0.001,
  ),
  walletIntelFreshDays: optionalPositiveInt("WALLET_INTEL_FRESH_DAYS", 7),
  walletIntelDormantDays: optionalPositiveInt("WALLET_INTEL_DORMANT_DAYS", 30),
  walletIntelWhaleUsd,
  walletIntelWhaleUsdSolana,
  walletIntelSignalMaxOdds: optionalNonNegativeNumber(
    "WALLET_INTEL_SIGNAL_MAX_ODDS",
    0.05,
  ),
  walletIntelSignalMinStakeUsd: optionalNonNegativeNumber(
    "WALLET_INTEL_SIGNAL_MIN_STAKE_USD",
    25_000,
  ),
  walletIntelSignalMinIdleDays: optionalNonNegativeInt(
    "WALLET_INTEL_SIGNAL_MIN_IDLE_DAYS",
    180,
  ),
  walletIntelSignalMaxPriorMarkets: optionalNonNegativeInt(
    "WALLET_INTEL_SIGNAL_MAX_PRIOR_MARKETS",
    1,
  ),
  walletIntelSignalMinPayoutUsd: optionalNonNegativeNumber(
    "WALLET_INTEL_SIGNAL_MIN_PAYOUT_USD",
    250_000,
  ),
  walletIntelSignalLateHours: optionalPositiveInt(
    "WALLET_INTEL_SIGNAL_LATE_HOURS",
    24,
  ),
  walletIntelSignalVeryLateHours: optionalPositiveInt(
    "WALLET_INTEL_SIGNAL_VERY_LATE_HOURS",
    6,
  ),
  walletIntelSignalWeightStake,
  walletIntelSignalWeightOdds,
  walletIntelSignalWeightIdle,
  walletIntelSignalWeightNovelty,
  walletIntelSignalMinScore: optionalNonNegativeNumber(
    "WALLET_INTEL_SIGNAL_MIN_SCORE",
    0.6,
  ),
  walletIntelSignalWindowHoursDefault: optionalPositiveInt(
    "WALLET_INTEL_SIGNAL_WINDOW_HOURS_DEFAULT",
    24,
  ),
  walletIntelSignalWindowHoursMax: optionalPositiveInt(
    "WALLET_INTEL_SIGNAL_WINDOW_HOURS_MAX",
    24 * 14,
  ),
  walletIntelSignalNotificationsEnabled:
    parseOptionalBool(process.env.WALLET_INTEL_SIGNAL_NOTIFICATIONS_ENABLED) ??
    false,
  walletIntelSignalNotifyMinScore: optionalNonNegativeNumber(
    "WALLET_INTEL_SIGNAL_NOTIFY_MIN_SCORE",
    0.8,
  ),
  walletIntelRetentionDaysSignals: optionalNonNegativeInt(
    "WALLET_INTEL_RETENTION_DAYS_SIGNALS",
    30,
  ),
  privyAppId: req("PRIVY_APP_ID"),
  privyAppSecret: req("PRIVY_APP_SECRET"),
  pricesSseMaxTokens: optionalPositiveInt("API_PRICES_SSE_MAX_TOKENS", 64),
  walletBalancesBatchMaxWallets: optionalPositiveInt(
    "WALLET_BALANCES_BATCH_MAX_WALLETS",
    20,
  ),
  walletBalancesBatchConcurrency: optionalPositiveInt(
    "WALLET_BALANCES_BATCH_CONCURRENCY",
    4,
  ),
  polymarketAccountCacheTtlMs: optionalNonNegativeInt(
    "POLYMARKET_ACCOUNT_CACHE_TTL_MS",
    5_000,
  ),
  limitlessAccountCacheTtlMs: optionalNonNegativeInt(
    "LIMITLESS_ACCOUNT_CACHE_TTL_MS",
    5_000,
  ),
  evmCodeCacheTtlMs: optionalNonNegativeInt(
    "EVM_CODE_CACHE_TTL_MS",
    10 * 60_000,
  ),
  evmApprovalCacheTtlMs: optionalNonNegativeInt(
    "EVM_APPROVAL_CACHE_TTL_MS",
    2_000,
  ),
  solanaRpcUrls,
  solanaRpcUrl: solanaRpcUrls[0],
  solanaRpcTimeoutMs: optionalPositiveInt("SOLANA_RPC_TIMEOUT_MS", 10_000),
  solanaUsdcMint:
    process.env.DFLOW_USDC_MINT?.trim() ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  polygonRpcUrl:
    process.env.POLYGON_RPC_URL?.trim() || "https://polygon-rpc.com",
  polygonRpcTimeoutMs: optionalPositiveInt("POLYGON_RPC_TIMEOUT_MS", 10_000),
  polygonMulticallAddress:
    process.env.POLYGON_MULTICALL_ADDRESS?.trim() ||
    "0xca11bde05977b3631167028862be2a173976ca11",
  baseRpcUrl:
    process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org",
  baseRpcTimeoutMs: optionalPositiveInt("BASE_RPC_TIMEOUT_MS", 10_000),
  baseMulticallAddress:
    process.env.BASE_MULTICALL_ADDRESS?.trim() ||
    "0xca11bde05977b3631167028862be2a173976ca11",
  alchemyPolygonNftBaseUrl:
    process.env.ALCHEMY_POLYGON_NFT_BASE_URL?.trim() || "",
  alchemyBaseNftBaseUrl:
    process.env.ALCHEMY_BASE_NFT_BASE_URL?.trim() || "",
  polymarketDataApiBase:
    process.env.POLYMARKET_DATA_API_BASE?.trim() ||
    "https://data-api.polymarket.com",
  limitlessApiBase:
    process.env.LIMITLESS_API_BASE?.trim() || "https://api.limitless.exchange",
  limitlessApiVersion: process.env.LIMITLESS_API_VERSION?.trim() || "v1",
  limitlessApiTimeoutMs: optionalPositiveInt("LIMITLESS_API_TIMEOUT_MS", 15_000),
  limitlessReferralCode: process.env.LIMITLESS_REFERRAL_CODE?.trim() || "",
  limitlessUsdcAddress:
    process.env.LIMITLESS_USDC_ADDRESS?.trim() ||
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  limitlessConditionalTokensAddress:
    process.env.LIMITLESS_CONDITIONAL_TOKENS_ADDRESS?.trim() ||
    "0xc9c98965297bc527861c898329ee280632b76e18",
  limitlessClobAddress:
    process.env.LIMITLESS_CLOB_ADDRESS?.trim() ||
    "0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5",
  limitlessNegRiskAddress:
    process.env.LIMITLESS_NEGRISK_ADDRESS?.trim() ||
    "0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47",
  limitlessNegRiskRequestAddress:
    process.env.LIMITLESS_NEGRISK_REQUEST_ADDRESS?.trim() ||
    "0x5a38afc17F7E97ad8d6C547ddb837E40B4aEDfC6",
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
  rewardsTreasuryBufferUsd: optionalNonNegativeNumber(
    "HUNCH_REWARDS_TREASURY_BUFFER_USD",
    0,
  ),
  rewardsTreasuryBufferPct: optionalRatio01(
    "HUNCH_REWARDS_TREASURY_BUFFER_PCT",
    0,
  ),
  rewardsTreasuryIncludePending:
    parseOptionalBool(process.env.HUNCH_REWARDS_TREASURY_INCLUDE_PENDING) ??
    true,
  rewardsTreasuryMinSweepUsdRaw,
  rewardsTreasuryMinSweepUsd,
  rewardsTreasuryMinSweepMicro,
  rewardsTreasuryColdAddressPolygon:
    process.env.HUNCH_REWARDS_TREASURY_COLD_ADDRESS_POLYGON?.trim() || "",
  rewardsTreasuryColdAddressBase:
    process.env.HUNCH_REWARDS_TREASURY_COLD_ADDRESS_BASE?.trim() || "",
  rewardsTreasuryColdAddressSolana:
    process.env.HUNCH_REWARDS_TREASURY_COLD_ADDRESS_SOLANA?.trim() || "",
  rewardsPayoutPrivateKeyPolygon:
    process.env.HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_POLYGON?.trim() ||
    process.env.HUNCH_REWARDS_PAYOUT_PRIVATE_KEY?.trim() ||
    "",
  rewardsPayoutPrivateKeyBase:
    process.env.HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_BASE?.trim() ||
    process.env.HUNCH_REWARDS_PAYOUT_PRIVATE_KEY?.trim() ||
    "",
  rewardsPayoutPrivateKey:
    process.env.HUNCH_REWARDS_PAYOUT_PRIVATE_KEY?.trim() || "",
  rewardsUsdcAddressPolygon:
    process.env.HUNCH_REWARDS_USDC_ADDRESS_POLYGON?.trim() || "",
  rewardsUsdcAddressBase:
    process.env.HUNCH_REWARDS_USDC_ADDRESS_BASE?.trim() || "",
  rewardsUsdcPolygon:
    process.env.HUNCH_REWARDS_USDC_ADDRESS_POLYGON?.trim() || "",
  rewardsUsdcBase:
    process.env.HUNCH_REWARDS_USDC_ADDRESS_BASE?.trim() || "",
  rewardsSolanaSecretKeyCanonical:
    process.env.HUNCH_REWARDS_SOLANA_SECRET_KEY?.trim() || "",
  rewardsSolanaSecretKey:
    process.env.HUNCH_REWARDS_SOLANA_SECRET_KEY?.trim() || "",

  debridgeDlnBase:
    process.env.DEBRIDGE_DLN_BASE?.trim() || "https://dln.debridge.finance/v1.0",
  debridgeStatsBase:
    process.env.DEBRIDGE_STATS_BASE?.trim() || "https://stats-api.dln.trade/api",
  debridgeAffiliateFeePercent: optionalNonNegativeNumber(
    "DEBRIDGE_AFFILIATE_FEE_PERCENT",
    0,
  ),
  debridgeAffiliateFeeRecipients:
    process.env.DEBRIDGE_AFFILIATE_FEE_RECIPIENTS?.trim() || "",
  debridgeReferralCode: optionalNonNegativeInt("DEBRIDGE_REFERRAL_CODE", 0),

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
  dflowGeoBlockEnabled,
  dflowGeoBlockCountries,
  dflowGeoBlockDefault,
  kalshiProofEnabled,
  kalshiProofCacheVerifiedTtlMs,
  kalshiProofCacheUnverifiedTtlMs,
};
