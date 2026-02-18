const REWARDS_CHAIN_ALIASES: Record<string, "137" | "8453" | "solana"> = {
  "137": "137",
  polygon: "137",
  matic: "137",
  "8453": "8453",
  base: "8453",
  solana: "solana",
  sol: "solana",
};

export type RewardsChainId = "137" | "8453" | "solana";
export const REWARDS_CHAIN_IDS: RewardsChainId[] = ["137", "8453", "solana"];

export function normalizeRewardsChainId(
  input: string | null | undefined,
): RewardsChainId | null {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  return REWARDS_CHAIN_ALIASES[normalized] ?? null;
}

export function isRewardsChainId(
  input: string | null | undefined,
): input is RewardsChainId {
  return normalizeRewardsChainId(input) !== null;
}
