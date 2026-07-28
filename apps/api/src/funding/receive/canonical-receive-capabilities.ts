export type CanonicalFundingReceiveObserverId =
  | "evm_erc20_transfer_v1"
  | "solana_transfer_v1";

const OBSERVER_BY_NETWORK: Readonly<
  Partial<Record<string, CanonicalFundingReceiveObserverId>>
> = {
  "evm:137": "evm_erc20_transfer_v1",
  "evm:8453": "evm_erc20_transfer_v1",
  "solana:mainnet": "solana_transfer_v1",
};

export function canonicalFundingReceiveObserverId(
  networkId: string,
): CanonicalFundingReceiveObserverId | null {
  return OBSERVER_BY_NETWORK[networkId] ?? null;
}

export function supportsCanonicalFundingReceiveEvents(
  networkId: string,
): boolean {
  return canonicalFundingReceiveObserverId(networkId) !== null;
}
