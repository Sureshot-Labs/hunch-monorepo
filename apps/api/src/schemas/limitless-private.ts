import { z } from "zod";
import {
  zCsvString,
  zEthAddress,
  zEthAddressRequired,
  zRequiredString,
} from "./common.js";

const zNumberish = z.union([z.string(), z.number()]);

const zClientType = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(["eoa", "base", "etherspot"]),
);

const zOrderType = z.preprocess(
  (v) => (typeof v === "string" ? v.toUpperCase() : v),
  z.enum(["GTC", "FOK"]),
);

const zPage = z.coerce.number().int().min(1).catch(1);
const zLimit = z.coerce.number().int().min(1).max(200).catch(100);

const limitlessOrderSchema = z
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
    feeRateBps: zNumberish.optional().default(0),
    side: zNumberish,
    signatureType: zNumberish,
    signature: zRequiredString("signature is required"),
    price: zNumberish.optional(),
  })
  .passthrough();

export const limitlessAuthLoginBodySchema = z.object({
  client: zClientType.optional(),
  smartWallet: zEthAddress.optional(),
  referralCode: z.string().optional(),
  r: z.string().optional(),
  account: zEthAddress.optional(),
  signingMessage: z.string().optional(),
  signature: z.string().optional(),
});

export const limitlessOrderBodySchema = z.object({
  order: limitlessOrderSchema,
  orderType: zOrderType.default("GTC"),
  marketSlug: zRequiredString("marketSlug is required"),
  ownerId: z.coerce.number().int().optional(),
});

export const limitlessOrderIdParamsSchema = z.object({
  orderId: zRequiredString("orderId is required"),
});

export const limitlessOpenOrdersQuerySchema = z.object({
  slug: zRequiredString("slug is required"),
});

export const limitlessHistoryQuerySchema = z.object({
  page: zPage,
  limit: zLimit,
  from: z.string().optional(),
  to: z.string().optional(),
  wallets: zCsvString("wallets is required").optional(),
});

export const limitlessSlugParamsSchema = z.object({
  slug: zRequiredString("slug is required"),
});

export const limitlessCancelBatchBodySchema = z.object({
  orderIds: z.array(z.string().min(1, "orderId is required")).min(1, "orderIds is required"),
});

export const limitlessAmmOrderBodySchema = z.object({
  tokenId: zRequiredString("tokenId is required"),
  side: z.enum(["BUY", "SELL"]),
  size: z.number().positive("size is required"),
  price: z.number().positive().optional(),
  amountUsd: z.number().positive().optional(),
  marketSlug: z.string().optional(),
  txHash: z
    .string()
    .min(1, "txHash is required")
    .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid tx hash format"),
});

export const limitlessRedemptionQuerySchema = z.object({
  conditionIds: zCsvString("conditionIds is required"),
  adapter: zEthAddress.optional(),
});

export const limitlessAccountQuerySchema = z.object({
  clobSpender: zEthAddress.optional(),
  negRiskSpender: zEthAddress.optional(),
  ammSpender: zEthAddress.optional(),
  verifySession: z.coerce.boolean().optional(),
});
