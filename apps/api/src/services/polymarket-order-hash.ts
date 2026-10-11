import { ethers } from "ethers";
import {
  validatePolymarketOrderDomainVersion,
  type PolymarketOrderDomainVersion,
} from "@hunch/shared";

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

export function buildPolymarketOrderDomain(
  exchangeAddress: string,
  domainVersion: PolymarketOrderDomainVersion = "2",
) {
  validatePolymarketOrderDomainVersion(exchangeAddress, domainVersion);
  return {
    name: "Polymarket CTF Exchange",
    version: domainVersion,
    chainId: POLYMARKET_POLYGON_CHAIN_ID,
    verifyingContract: ethers.getAddress(exchangeAddress),
  } as const;
}

export function computePolymarketOrderHashV2(input: {
  exchangeAddress: string;
  // V2 here describes the eleven-field payload, not the market protocol.
  orderDomainVersion?: PolymarketOrderDomainVersion;
  order: PolymarketOrderHashV2Input;
}): string {
  return ethers.TypedDataEncoder.hash(
    buildPolymarketOrderDomain(input.exchangeAddress, input.orderDomainVersion),
    POLYMARKET_ORDER_TYPES as unknown as Record<
      string,
      Array<{ name: string; type: string }>
    >,
    input.order,
  );
}
