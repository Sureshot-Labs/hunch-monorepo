import { z } from "zod";
import { embeddedPrivyAuthorizationSignatureSchema } from "./embedded-wallets.js";
import {
  zBytes32,
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
const zOptionalBool = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((v) => v === true || v === "true")
  .catch(false);
const zOutcome = z.preprocess(
  (v) => (typeof v === "string" ? v.toUpperCase() : v),
  z.enum(["YES", "NO"]),
);
const LIMITLESS_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/i;
const zLimitlessSlug = z
  .string()
  .trim()
  .min(1, "slug is required")
  .max(128, "slug is too long")
  .regex(LIMITLESS_SLUG_RE, "slug must use letters, numbers, and dashes only");

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
  account: zEthAddress.optional(),
  signingMessage: z.string().optional(),
  signature: z.string().optional(),
});

export const limitlessEmbeddedEnsureReadyBodySchema = z.object({});

export const limitlessEmbeddedEnsureReadyExecuteBodySchema = z.object({
  signingMessage: z.string().trim().min(1, "signingMessage is required"),
  signedRequests: z
    .array(embeddedPrivyAuthorizationSignatureSchema)
    .default([]),
});

export const limitlessEmbeddedSignOrderPrepareBodySchema = z.object({
  marketSlug: zLimitlessSlug,
  order: limitlessOrderSchema.omit({ signature: true }),
});

export const limitlessEmbeddedSignOrderExecuteBodySchema = z.object({
  marketSlug: zLimitlessSlug,
  order: limitlessOrderSchema.omit({ signature: true }),
  exchangeAddress: zEthAddressRequired,
  authorizationSignature: z.string().trim().min(1).optional(),
});

export const limitlessOrderBodySchema = z.object({
  order: limitlessOrderSchema,
  orderType: zOrderType.default("GTC"),
  marketSlug: zLimitlessSlug,
  ownerId: z.coerce.number().int().optional(),
});

export const limitlessOrderIdParamsSchema = z.object({
  orderId: zRequiredString("orderId is required"),
});

export const limitlessOpenOrdersQuerySchema = z.object({
  slug: zLimitlessSlug,
});

export const limitlessMarketExchangeQuerySchema = z.object({
  slug: zLimitlessSlug,
  side: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toUpperCase() : v),
      z.enum(["BUY", "SELL"]),
    )
    .optional(),
  forceCanonical: zOptionalBool.optional(),
});

export const limitlessHistoryQuerySchema = z.object({
  page: zPage,
  limit: zLimit,
  cursor: z.string().trim().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  wallets: zCsvString("wallets is required").optional(),
});

export const limitlessSlugParamsSchema = z.object({
  slug: zLimitlessSlug,
});

export const limitlessCancelBatchBodySchema = z.object({
  orderIds: z
    .array(z.string().min(1, "orderId is required"))
    .min(1, "orderIds is required"),
});

export const limitlessAmmOrderBodySchema = z.object({
  tokenId: zRequiredString("tokenId is required"),
  side: z.enum(["BUY", "SELL"]),
  size: z.number().positive("size is required"),
  price: z.number().positive().optional(),
  amountUsd: z.number().positive().optional(),
  marketSlug: zLimitlessSlug.optional(),
  txHash: z
    .string()
    .min(1, "txHash is required")
    .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid tx hash format"),
});

export const limitlessRedemptionQuerySchema = z.object({
  conditionIds: zCsvString("conditionIds is required"),
  adapter: zEthAddress.optional(),
});

export const limitlessRedemptionPlanQuerySchema = z.object({
  outcome: zOutcome,
  tokenId: zRequiredString("tokenId is required"),
  conditionId: zBytes32,
  negRisk: zOptionalBool.optional(),
  adapter: zEthAddress.optional(),
});

export const limitlessAccountQuerySchema = z.object({
  clobSpender: zEthAddress.optional(),
  negRiskSpender: zEthAddress.optional(),
  adapterSpender: zEthAddress.optional(),
  ammSpender: zEthAddress.optional(),
  tokenId: z.string().optional(),
  refresh: zOptionalBool.optional(),
});

export const limitlessAmmQuoteQuerySchema = z.object({
  marketAddress: zEthAddressRequired,
  outcomeIndex: z.coerce.number().int().min(0),
  side: z.enum(["BUY", "SELL"]),
  amountUsdRaw: z.string().regex(/^\d+$/).optional(),
  amountSharesRaw: z.string().regex(/^\d+$/).optional(),
});
