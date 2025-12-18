import { z } from "zod";
import { zEthAddress, zEthAddressRequired, zRequiredString } from "./common.js";

const zNumberish = z.union([z.string(), z.number()]);

const zOrderType = z.preprocess(
  (v) => (typeof v === "string" ? v.toUpperCase() : v),
  z.enum(["GTC", "GTD", "FAK", "FOK"]),
);

const polymarketOrderSchema = z
  .object({
    salt: zNumberish,
    maker: zEthAddressRequired,
    signer: zEthAddressRequired,
    taker: zEthAddress.optional(),
    tokenId: zNumberish,
    makerAmount: zNumberish,
    takerAmount: zNumberish,
    expiration: zNumberish,
    nonce: zNumberish,
    feeRateBps: zNumberish,
    side: zNumberish,
    signatureType: zNumberish,
    signature: zRequiredString("signature is required"),
  })
  .passthrough();

export const polymarketPlaceOrderBodySchema = z.object({
  order: polymarketOrderSchema,
  orderType: zOrderType.default("GTC"),
  deferExec: z.boolean().optional(),
});

export const polymarketCancelOrderBodySchema = z.object({
  orderID: zRequiredString("orderID is required"),
});

export const polymarketOpenOrdersQuerySchema = z.object({
  assetId: z.string().optional(),
  asset_id: z.string().optional(),
  market: z.string().optional(),
  id: z.string().optional(),
});

export const polymarketMarketInfoQuerySchema = z
  .object({
    tokenId: z.string().optional(),
    marketId: z.string().optional(),
  })
  .refine((v) => Boolean(v.tokenId || v.marketId), {
    message: "tokenId or marketId is required",
  });

export const polymarketQuoteBodySchema = z.object({
  tokenId: zRequiredString("tokenId is required"),
  side: z.enum(["BUY", "SELL"], {
    message: "Valid side (BUY/SELL) is required",
  }),
  amountUsd: z.coerce.number().positive("amountUsd must be > 0"),
  orderType: zOrderType.optional(),
  slippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
});
