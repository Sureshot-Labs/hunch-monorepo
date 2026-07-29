import { ethers } from "ethers";

import {
  POLYMARKET_ORDER_TYPES,
  POLYMARKET_POLYGON_CHAIN_ID,
} from "./polymarket-signing-schema.js";

export type PolymarketOrderHashV2Input = {
  salt: string | number | bigint;
  maker: string;
  signer: string;
  tokenId: string | number | bigint;
  makerAmount: string | number | bigint;
  takerAmount: string | number | bigint;
  side: number;
  signatureType: number;
  timestamp: string | number | bigint;
  metadata: string;
  builder: string;
};

export function buildPolymarketOrderDomain(exchangeAddress: string) {
  return {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId: POLYMARKET_POLYGON_CHAIN_ID,
    verifyingContract: ethers.getAddress(exchangeAddress),
  } as const;
}

export function computePolymarketOrderHashV2(input: {
  exchangeAddress: string;
  order: PolymarketOrderHashV2Input;
}): string {
  return ethers.TypedDataEncoder.hash(
    buildPolymarketOrderDomain(input.exchangeAddress),
    POLYMARKET_ORDER_TYPES as unknown as Record<
      string,
      Array<{ name: string; type: string }>
    >,
    input.order,
  );
}
