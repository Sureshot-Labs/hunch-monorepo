import {
  POLYMARKET_FUNDING_ROUTER,
  POLYMARKET_PUSD,
  POLYMARKET_USDCE,
} from "@hunch/contracts";

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const DEFAULT_MULTICALL_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";
const POLYMARKET_PUSD_ADDRESS = POLYMARKET_PUSD.polygon;
const POLYMARKET_USDCE_ADDRESS = POLYMARKET_USDCE.polygon;
const POLYMARKET_FUNDING_ROUTER_ADDRESS = POLYMARKET_FUNDING_ROUTER.polygon;

function optionalPositiveInt(
  source: Environment,
  key: string,
  fallback: number,
): number {
  const raw = source[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function optionalIntInRange(
  source: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = source[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function optionalNonNegativeInt(
  source: Environment,
  key: string,
  fallback: number,
): number {
  return optionalIntInRange(source, key, fallback, 0, Number.MAX_SAFE_INTEGER);
}

function stringValue(
  source: Environment,
  key: string,
  fallback: string,
): string {
  return source[key]?.trim() || fallback;
}

function solanaRpcUrlList(
  source: Environment,
  primaryKey: string,
  fallbackKey: string,
  fallback: string,
): readonly string[] {
  const explicitValues = (source[primaryKey] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (explicitValues.length > 0) {
    return [...new Set(explicitValues)];
  }

  const configuredValue = stringValue(source, fallbackKey, fallback);
  return [...new Set([configuredValue, fallback])];
}

function keyValueMap(
  source: Environment,
  key: string,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const entry of (source[key] ?? "").split(/[\n,]/u)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const mapKey = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (mapKey && value) output[mapKey] = value;
  }
  return output;
}

export type FundingSidecarRuntimeConfig = Readonly<{
  solanaRpcUrls: readonly string[];
  solanaRpcUrl: string;
  solanaRpcTimeoutMs: number;
  evmRpcUrlsByChain: Readonly<Record<string, string>>;
  ethereumRpcUrl: string;
  optimismRpcUrl: string;
  bscRpcUrl: string;
  polygonRpcUrl: string;
  polygonRpcTimeoutMs: number;
  polygonMulticallAddress: string;
  arbitrumRpcUrl: string;
  avalancheRpcUrl: string;
  lineaRpcUrl: string;
  baseRpcUrl: string;
  baseRpcTimeoutMs: number;
  baseMulticallAddress: string;
  solanaUsdcMint: string;
  polymarketClobBase: string;
  polymarketPusdAddress: string;
  polymarketUsdceAddress: string;
  polymarketUsdcAddress: string;
  polymarketExchangeAddress: string;
  polymarketNegRiskExchangeAddress: string;
  polymarketFundingRouterAddress: string;
  polymarketNegRiskAdapterAddress: string;
  polymarketConditionalTokensAddress: string;
  limitlessUsdcAddress: string;
  limitlessConditionalTokensAddress: string;
  limitlessClobAddress: string;
  limitlessNegRiskAddress: string;
  evmCodeCacheTtlMs: number;
  evmApprovalCacheTtlMs: number;
  walletIntelRetryMaxAttempts: number;
  walletIntelRetryBaseBackoffMs: number;
  walletIntelRetryMaxBackoffMs: number;
}>;

export function loadFundingSidecarRuntimeConfig(
  source: Environment = process.env,
): FundingSidecarRuntimeConfig {
  const solanaRpcUrls = solanaRpcUrlList(
    source,
    "SOLANA_RPC_URLS",
    "SOLANA_RPC_URL",
    DEFAULT_SOLANA_RPC_URL,
  );
  const polymarketPusdAddress = stringValue(
    source,
    "POLYMARKET_PUSD_ADDRESS",
    stringValue(
      source,
      "POLYMARKET_COLLATERAL_ADDRESS",
      POLYMARKET_PUSD_ADDRESS,
    ),
  );
  if (
    polymarketPusdAddress.toLowerCase() ===
    POLYMARKET_USDCE_ADDRESS.toLowerCase()
  ) {
    throw new Error(
      "Polymarket CLOB V2 collateral cannot use the legacy USDC.e address",
    );
  }
  const polymarketUsdceAddress = stringValue(
    source,
    "POLYMARKET_USDCE_ADDRESS",
    POLYMARKET_USDCE_ADDRESS,
  );
  const configuredFundingRouterAddress =
    source.POLYMARKET_FUNDING_ROUTER_ADDRESS?.trim() || "";
  const polymarketFundingRouterAddress =
    configuredFundingRouterAddress.toLowerCase() ===
    POLYMARKET_FUNDING_ROUTER_ADDRESS.toLowerCase()
      ? configuredFundingRouterAddress
      : "";
  if (
    polymarketFundingRouterAddress &&
    (polymarketPusdAddress.toLowerCase() !==
      POLYMARKET_PUSD_ADDRESS.toLowerCase() ||
      polymarketUsdceAddress.toLowerCase() !==
        POLYMARKET_USDCE_ADDRESS.toLowerCase())
  ) {
    throw new Error(
      "POLYMARKET_FUNDING_ROUTER_ADDRESS requires canonical pUSD and USDC.e addresses",
    );
  }
  return {
    solanaRpcUrls,
    solanaRpcUrl: solanaRpcUrls[0] ?? DEFAULT_SOLANA_RPC_URL,
    solanaRpcTimeoutMs: optionalPositiveInt(
      source,
      "SOLANA_RPC_TIMEOUT_MS",
      10_000,
    ),
    evmRpcUrlsByChain: keyValueMap(source, "EVM_RPC_URLS_BY_CHAIN"),
    ethereumRpcUrl: stringValue(
      source,
      "ETHEREUM_RPC_URL",
      "https://ethereum-rpc.publicnode.com",
    ),
    optimismRpcUrl: stringValue(
      source,
      "OPTIMISM_RPC_URL",
      "https://mainnet.optimism.io",
    ),
    bscRpcUrl: stringValue(
      source,
      "BSC_RPC_URL",
      "https://bsc-dataseed.binance.org",
    ),
    polygonRpcUrl: stringValue(
      source,
      "POLYGON_RPC_URL",
      "https://polygon-rpc.com",
    ),
    polygonRpcTimeoutMs: optionalPositiveInt(
      source,
      "POLYGON_RPC_TIMEOUT_MS",
      10_000,
    ),
    polygonMulticallAddress: stringValue(
      source,
      "POLYGON_MULTICALL_ADDRESS",
      DEFAULT_MULTICALL_ADDRESS,
    ),
    arbitrumRpcUrl: stringValue(
      source,
      "ARBITRUM_RPC_URL",
      "https://arb1.arbitrum.io/rpc",
    ),
    avalancheRpcUrl: stringValue(
      source,
      "AVALANCHE_RPC_URL",
      "https://api.avax.network/ext/bc/C/rpc",
    ),
    lineaRpcUrl: stringValue(
      source,
      "LINEA_RPC_URL",
      "https://rpc.linea.build",
    ),
    baseRpcUrl: stringValue(source, "BASE_RPC_URL", "https://mainnet.base.org"),
    baseRpcTimeoutMs: optionalPositiveInt(
      source,
      "BASE_RPC_TIMEOUT_MS",
      10_000,
    ),
    baseMulticallAddress: stringValue(
      source,
      "BASE_MULTICALL_ADDRESS",
      DEFAULT_MULTICALL_ADDRESS,
    ),
    solanaUsdcMint: stringValue(
      source,
      "DFLOW_USDC_MINT",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ),
    polymarketClobBase: stringValue(
      source,
      "POLYMARKET_CLOB_BASE",
      "https://clob.polymarket.com",
    ),
    polymarketPusdAddress,
    polymarketUsdceAddress,
    polymarketUsdcAddress: polymarketPusdAddress,
    polymarketExchangeAddress: stringValue(
      source,
      "POLYMARKET_EXCHANGE_ADDRESS",
      "0xE111180000d2663C0091e4f400237545B87B996B",
    ),
    polymarketNegRiskExchangeAddress: stringValue(
      source,
      "POLYMARKET_NEG_RISK_EXCHANGE_ADDRESS",
      "0xe2222d279d744050d28e00520010520000310F59",
    ),
    polymarketFundingRouterAddress,
    polymarketNegRiskAdapterAddress: stringValue(
      source,
      "POLYMARKET_NEG_RISK_ADAPTER_ADDRESS",
      "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
    ),
    polymarketConditionalTokensAddress: stringValue(
      source,
      "POLYMARKET_CONDITIONAL_TOKENS_ADDRESS",
      "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    ),
    limitlessUsdcAddress: stringValue(
      source,
      "LIMITLESS_USDC_ADDRESS",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ),
    limitlessConditionalTokensAddress: stringValue(
      source,
      "LIMITLESS_CONDITIONAL_TOKENS_ADDRESS",
      "0xc9c98965297bc527861c898329ee280632b76e18",
    ),
    limitlessClobAddress: stringValue(
      source,
      "LIMITLESS_CLOB_ADDRESS",
      "0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5",
    ),
    limitlessNegRiskAddress: stringValue(
      source,
      "LIMITLESS_NEGRISK_ADDRESS",
      "0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47",
    ),
    evmCodeCacheTtlMs: optionalNonNegativeInt(
      source,
      "EVM_CODE_CACHE_TTL_MS",
      10 * 60_000,
    ),
    evmApprovalCacheTtlMs: optionalNonNegativeInt(
      source,
      "EVM_APPROVAL_CACHE_TTL_MS",
      2_000,
    ),
    walletIntelRetryMaxAttempts: optionalIntInRange(
      source,
      "WALLET_INTEL_RETRY_MAX_ATTEMPTS",
      3,
      1,
      6,
    ),
    walletIntelRetryBaseBackoffMs: optionalIntInRange(
      source,
      "WALLET_INTEL_RETRY_BASE_BACKOFF_MS",
      250,
      10,
      60_000,
    ),
    walletIntelRetryMaxBackoffMs: optionalIntInRange(
      source,
      "WALLET_INTEL_RETRY_MAX_BACKOFF_MS",
      2_000,
      10,
      120_000,
    ),
  };
}

export const fundingSidecarRuntimeConfig = loadFundingSidecarRuntimeConfig();
