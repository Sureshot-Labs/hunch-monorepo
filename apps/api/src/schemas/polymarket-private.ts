import { z } from "zod";
import { zEthAddress, zEthAddressRequired, zRequiredString } from "./common.js";

const zNumberish = z.union([z.string(), z.number()]);

const zOrderType = z.preprocess(
  (v) => (typeof v === "string" ? v.toUpperCase() : v),
  z.enum(["GTC", "GTD", "FAK", "FOK"]),
);

const zAmountType = z.enum(["usd", "shares"]);

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

const polymarketFeeAuthSchema = z.object({
  signer: zEthAddressRequired,
  vault: zEthAddressRequired,
  exchange: zEthAddressRequired,
  orderHash: zRequiredString("orderHash is required"),
  feeBps: zNumberish,
  nonce: zNumberish,
  deadline: zNumberish,
});

export const polymarketPlaceOrderBodySchema = z.object({
  order: polymarketOrderSchema,
  orderType: zOrderType.default("GTC"),
  deferExec: z.boolean().optional(),
  exchangeAddress: zEthAddress.optional(),
  negRisk: z.boolean().optional(),
  feeCollectorAddress: zEthAddress.optional(),
  feeAuth: polymarketFeeAuthSchema.optional(),
  feeAuthSig: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.feeAuth || value.feeAuthSig) {
    if (!value.feeAuth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feeAuth is required when feeAuthSig is provided",
        path: ["feeAuth"],
      });
    }
    if (!value.feeAuthSig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feeAuthSig is required when feeAuth is provided",
        path: ["feeAuthSig"],
      });
    }
  }
});

export const polymarketOrderHashBodySchema = z.object({
  order: polymarketOrderSchema,
  exchangeAddress: zEthAddress.optional(),
  negRisk: z.boolean().optional(),
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
    conditionId: z.string().optional(),
  })
  .refine((v) => Boolean(v.tokenId || v.marketId || v.conditionId), {
    message: "tokenId, marketId, or conditionId is required",
  });

export const polymarketOrderParamsQuerySchema = z.object({
  tokenId: zRequiredString("tokenId is required"),
});

export const polymarketFunderDeriveQuerySchema = z.object({
  includeMagicProxy: z.string().optional(),
});

export const polymarketQuoteBodySchema = z.object({
  tokenId: zRequiredString("tokenId is required"),
  side: z.enum(["BUY", "SELL"], {
    message: "Valid side (BUY/SELL) is required",
  }),
  amountUsd: z.coerce.number().positive("amountUsd must be > 0").optional(),
  amount: z.coerce.number().positive("amount must be > 0").optional(),
  amountType: zAmountType.optional(),
  orderType: zOrderType.optional(),
  slippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
}).refine((value) => {
  const amountType = value.amountType ?? "usd";
  if (amountType === "shares") {
    return value.amount != null;
  }
  return value.amountUsd != null || value.amount != null;
}, {
  message: "amountUsd (or amount) is required",
});
