import { ethers } from "ethers";

import { fetchLimitlessAmmQuote } from "./limitless-onchain.js";

import {
  LIMITLESS_CLOB_EIP712_NAME,
  LIMITLESS_CLOB_EIP712_VERSION,
  LIMITLESS_CLOB_CHAIN_ID,
  LIMITLESS_CLOB_ORDER_TYPES,
  LIMITLESS_CLOB_DOMAIN_TYPES,
} from "./limitless-order-contract.js";
export {
  LIMITLESS_CLOB_EIP712_NAME,
  LIMITLESS_CLOB_EIP712_VERSION,
  LIMITLESS_CLOB_CHAIN_ID,
  LIMITLESS_CLOB_ORDER_TYPES,
  LIMITLESS_CLOB_DOMAIN_TYPES,
} from "./limitless-order-contract.js";

export type LimitlessEmbeddedOrderPayload = {
  salt: string | number;
  maker: string;
  signer: string;
  taker?: string;
  tokenId: string | number;
  makerAmount: string | number;
  takerAmount: string | number;
  expiration: string | number;
  nonce: string | number;
  feeRateBps?: string | number;
  side: string | number;
  signatureType: string | number;
};

export function canonicalizeLimitlessOrderPayload(
  payload: LimitlessEmbeddedOrderPayload,
): Record<string, string | number> & {
  maker: string;
  signer: string;
  taker: string;
} {
  return {
    ...payload,
    maker: ethers.getAddress(payload.maker),
    signer: ethers.getAddress(payload.signer),
    taker: ethers.getAddress(
      typeof payload.taker === "string" && payload.taker.trim().length > 0
        ? payload.taker
        : ethers.ZeroAddress,
    ),
    feeRateBps: payload.feeRateBps ?? 0,
  };
}

export function buildEmbeddedLimitlessOrderTypedData(inputs: {
  signer: string;
  payload: LimitlessEmbeddedOrderPayload;
  exchangeAddress: string;
}) {
  const exchangeAddress = ethers.getAddress(inputs.exchangeAddress);
  const typedPayload = canonicalizeLimitlessOrderPayload(inputs.payload);
  if (typedPayload.signer.toLowerCase() !== inputs.signer.toLowerCase()) {
    throw new Error(
      "Embedded Limitless order signer must match the selected Trading Wallet.",
    );
  }
  if (typedPayload.maker.toLowerCase() !== inputs.signer.toLowerCase()) {
    throw new Error(
      "Embedded Limitless order maker must match the selected Trading Wallet.",
    );
  }
  return {
    domain: {
      name: LIMITLESS_CLOB_EIP712_NAME,
      version: LIMITLESS_CLOB_EIP712_VERSION,
      chainId: LIMITLESS_CLOB_CHAIN_ID,
      verifyingContract: exchangeAddress,
    },
    types: {
      EIP712Domain: LIMITLESS_CLOB_DOMAIN_TYPES,
      Order: LIMITLESS_CLOB_ORDER_TYPES.Order,
    },
    primaryType: "Order",
    message: typedPayload,
  } as const;
}

export async function quoteLimitlessAmmTrade(input: {
  rpcUrl: string;
  timeoutMs: number;
  marketAddress: string;
  outcomeIndex: number;
  side: "BUY" | "SELL";
  amountUsdRaw?: bigint | null;
  amountSharesRaw?: bigint | null;
}): Promise<{
  marketAddress: string;
  outcomeIndex: number;
  side: "BUY" | "SELL";
  sharesRaw: string | null;
  returnAmountRaw: string | null;
}> {
  const quote = await fetchLimitlessAmmQuote(input);
  return {
    marketAddress: ethers.getAddress(input.marketAddress),
    outcomeIndex: input.outcomeIndex,
    side: input.side,
    sharesRaw: quote.sharesRaw?.toString() ?? null,
    returnAmountRaw: quote.returnAmountRaw?.toString() ?? null,
  };
}
