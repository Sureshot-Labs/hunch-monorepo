import { z } from "zod";
import { zEthAddress, zEthAddressRequired, zRequiredString } from "./common.js";

const zNumberish = z.union([z.string(), z.number()]);

const zClientType = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(["eoa", "base", "etherspot"]),
);

const zOrderType = z.preprocess(
  (v) => (typeof v === "string" ? v.toUpperCase() : v),
  z.enum(["GTC", "FOK"]),
);

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
    feeRateBps: zNumberish,
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

export const limitlessSlugParamsSchema = z.object({
  slug: zRequiredString("slug is required"),
});

export const limitlessCancelBatchBodySchema = z.object({
  orderIds: z.array(z.string().min(1, "orderId is required")).min(1, "orderIds is required"),
});
