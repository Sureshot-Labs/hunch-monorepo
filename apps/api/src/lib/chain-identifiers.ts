export const SOLANA_MAINNET_NETWORK_ID = "solana:mainnet";
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export const SOLANA_CAIP2_PATTERN = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;

export function solanaCaip2ForNetworkId(networkId: string): string | null {
  const normalized = networkId.trim();
  if (normalized === SOLANA_MAINNET_NETWORK_ID) {
    return SOLANA_MAINNET_CAIP2;
  }
  return SOLANA_CAIP2_PATTERN.test(normalized) ? normalized : null;
}
