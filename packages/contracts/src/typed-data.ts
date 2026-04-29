import type { Address } from "./addresses";

export const POLYMARKET_ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
} as const;

export const POLYMARKET_ORDER_TYPES_V2 = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

export const FEE_AUTH_TYPES = {
  FeeAuth: [
    { name: "signer", type: "address" },
    { name: "vault", type: "address" },
    { name: "exchange", type: "address" },
    { name: "orderHash", type: "bytes32" },
    { name: "feeBps", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const FEE_AUTH_TYPES_V3 = {
  FeeAuthV3: [
    { name: "signer", type: "address" },
    { name: "vault", type: "address" },
    { name: "exchange", type: "address" },
    { name: "orderHash", type: "bytes32" },
    { name: "feeBps", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function buildPolymarketOrderDomain(
  chainId: number,
  exchange: Address
) {
  return {
    name: "Polymarket CTF Exchange",
    version: "1",
    chainId,
    verifyingContract: exchange,
  };
}

export function buildPolymarketOrderDomainV2(
  chainId: number,
  exchange: Address
) {
  return {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId,
    verifyingContract: exchange,
  };
}

export function buildFeeAuthDomain(
  chainId: number,
  feeCollector: Address
) {
  return {
    name: "Polymarket Aggregator FeeCollector",
    version: "2",
    chainId,
    verifyingContract: feeCollector,
  };
}

export function buildFeeAuthDomainV3(
  chainId: number,
  feeCollector: Address
) {
  return {
    name: "Polymarket Aggregator FeeCollector",
    version: "3",
    chainId,
    verifyingContract: feeCollector,
  };
}
