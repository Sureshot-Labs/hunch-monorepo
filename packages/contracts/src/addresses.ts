export type Address = `0x${string}`;

export const POLYMARKET_USDC: Record<"polygon", Address> = {
  polygon: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
};

export const POLYMARKET_EXCHANGE: Record<"polygon", Address> = {
  polygon: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
};

export const POLYMARKET_NEG_RISK_EXCHANGE: Record<"polygon", Address> = {
  polygon: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
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
