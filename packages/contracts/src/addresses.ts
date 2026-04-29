export type Address = `0x${string}`;

export const POLYMARKET_USDC: Record<"polygon", Address> = {
  polygon: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
};

export const POLYMARKET_USDCE = POLYMARKET_USDC;

export const POLYMARKET_PUSD: Record<"polygon", Address> = {
  polygon: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
};

export const POLYMARKET_EXCHANGE: Record<"polygon", Address> = {
  polygon: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
};

export const POLYMARKET_NEG_RISK_EXCHANGE: Record<"polygon", Address> = {
  polygon: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
};

export const POLYMARKET_EXCHANGE_V2: Record<"polygon", Address> = {
  polygon: "0xE111180000d2663C0091e4f400237545B87B996B",
};

export const POLYMARKET_NEG_RISK_EXCHANGE_V2: Record<"polygon", Address> = {
  polygon: "0xe2222d279d744050d28e00520010520000310F59",
};

export const POLYMARKET_COLLATERAL_ONRAMP: Record<"polygon", Address> = {
  polygon: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
};

export const POLYMARKET_COLLATERAL_OFFRAMP: Record<"polygon", Address> = {
  polygon: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
};

export const POLYMARKET_CONDITIONAL_TOKENS: Record<"polygon", Address> = {
  polygon: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
};

export const FEE_COLLECTOR_ADDRESSES: {
  polygon: Address | null;
  polygonNegRisk: Address | null;
} = {
  polygon: null,
  polygonNegRisk: null,
};
