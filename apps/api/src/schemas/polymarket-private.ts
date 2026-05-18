import { z } from "zod";
import {
  zBytes32,
  zEthAddress,
  zEthAddressRequired,
  zRequiredString,
} from "./common.js";

const zNumberish = z.union([z.string(), z.number()]);

const zOrderType = z.preprocess(
  (v) => (typeof v === "string" ? v.toUpperCase() : v),
  z.enum(["GTC", "GTD", "FAK", "FOK"]),
);

const zAmountType = z.enum(["usd", "shares"]);
const zOutcome = z.preprocess(
  (v) => (typeof v === "string" ? v.toUpperCase() : v),
  z.enum(["YES", "NO"]),
);
const zOptionalBool = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((v) => v === true || v === "true")
  .catch(false);

const polymarketOrderSchemaV1 = z
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

const polymarketUnsignedOrderSchemaV1 = z
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
  })
  .passthrough();

const polymarketOrderSchemaV2 = z
  .object({
    salt: zNumberish,
    maker: zEthAddressRequired,
    signer: zEthAddressRequired,
    tokenId: zNumberish,
    makerAmount: zNumberish,
    takerAmount: zNumberish,
    side: zNumberish,
    signatureType: zNumberish,
    timestamp: zNumberish,
    metadata: zBytes32,
    builder: zBytes32,
    signature: zRequiredString("signature is required"),
    expiration: zNumberish.optional(),
  })
  .passthrough();

const polymarketUnsignedOrderSchemaV2 = z
  .object({
    salt: zNumberish,
    maker: zEthAddressRequired,
    signer: zEthAddressRequired,
    tokenId: zNumberish,
    makerAmount: zNumberish,
    takerAmount: zNumberish,
    side: zNumberish,
    signatureType: zNumberish,
    timestamp: zNumberish,
    metadata: zBytes32,
    builder: zBytes32,
    expiration: zNumberish.optional(),
  })
  .passthrough();

const polymarketOrderSchema = z.union([
  polymarketOrderSchemaV2,
  polymarketOrderSchemaV1,
]);

const polymarketUnsignedOrderSchema = z.union([
  polymarketUnsignedOrderSchemaV2,
  polymarketUnsignedOrderSchemaV1,
]);

const polymarketFeeAuthSchemaV1 = z.object({
  signer: zEthAddressRequired,
  vault: zEthAddressRequired,
  exchange: zEthAddressRequired,
  orderHash: zRequiredString("orderHash is required"),
  feeBps: zNumberish,
  nonce: zNumberish,
  deadline: zNumberish,
});

const polymarketFeeAuthSchemaV3 = z.object({
  signer: zEthAddressRequired,
  vault: zEthAddressRequired,
  exchange: zEthAddressRequired,
  orderHash: zRequiredString("orderHash is required"),
  feeBps: zNumberish,
  deadline: zNumberish,
});

const polymarketFeeAuthSchema = z.union([
  polymarketFeeAuthSchemaV1,
  polymarketFeeAuthSchemaV3,
]);

export const polymarketPlaceOrderBodySchema = z
  .object({
    order: polymarketOrderSchema,
    orderType: zOrderType.default("GTC"),
    deferExec: z.boolean().optional(),
    exchangeAddress: zEthAddress.optional(),
    negRisk: z.boolean().optional(),
    feeCollectorAddress: zEthAddress.optional(),
    feeAuth: polymarketFeeAuthSchema.optional(),
    feeAuthSig: z.string().optional(),
  })
  .superRefine((value, ctx) => {
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

export const polymarketAccountQuerySchema = z.object({
  refresh: zOptionalBool.optional(),
});

export const polymarketRedemptionPlanQuerySchema = z.object({
  outcome: zOutcome,
  tokenId: zRequiredString("tokenId is required"),
  negRisk: zOptionalBool.optional(),
  funderAddress: zEthAddress.optional(),
  conditionId: zBytes32.optional(),
  questionId: zBytes32.optional(),
  negRiskParentConditionId: zBytes32.optional(),
  negRiskRequestId: zBytes32.optional(),
});

export const polymarketOrderParamsQuerySchema = z.object({
  tokenId: zRequiredString("tokenId is required"),
});

export const polymarketFunderDeriveQuerySchema = z.object({
  includeMagicProxy: z.string().optional(),
  refresh: zOptionalBool.optional(),
  walletAddress: zEthAddress.optional(),
});

export const polymarketFunderDeriveBatchBodySchema = z.object({
  wallets: z.array(zEthAddress).min(1, "wallets is required"),
  includeMagicProxy: z.boolean().optional(),
  refresh: z.boolean().optional(),
});

export const polymarketQuoteBodySchema = z
  .object({
    tokenId: zRequiredString("tokenId is required"),
    side: z.enum(["BUY", "SELL"], {
      message: "Valid side (BUY/SELL) is required",
    }),
    amountUsd: z.coerce.number().positive("amountUsd must be > 0").optional(),
    amount: z.coerce.number().positive("amount must be > 0").optional(),
    amountType: zAmountType.optional(),
    orderType: zOrderType.optional(),
    limitPrice: z.coerce.number().positive("limitPrice must be > 0").optional(),
    slippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .refine(
    (value) => {
      const amountType = value.amountType ?? "usd";
      if (amountType === "shares") {
        return value.amount != null;
      }
      return value.amountUsd != null || value.amount != null;
    },
    {
      message: "amountUsd (or amount) is required",
    },
  )
  .refine(
    (value) => {
      const orderType =
        typeof value.orderType === "string"
          ? value.orderType.toUpperCase()
          : "FOK";
      if (orderType === "FOK" || orderType === "FAK") return true;
      return value.limitPrice != null;
    },
    {
      message: "limitPrice is required for limit orders",
    },
  );

export const polymarketEmbeddedEnsureReadyBodySchema = z.object({
  funderAddress: zEthAddress.optional(),
});

const embeddedAuthorizationRequestSignatureSchema = z.object({
  id: zRequiredString("id is required"),
  signature: zRequiredString("signature is required"),
});

export const polymarketEmbeddedEnsureReadyExecuteBodySchema = z.object({
  funderAddress: zEthAddress.optional(),
  connectTimestamp: z.string().trim().min(1).optional(),
  connectNonce: z.number().int().nonnegative().optional(),
  signedRequests: z
    .array(embeddedAuthorizationRequestSignatureSchema)
    .default([]),
});

export const polymarketEmbeddedSignOrderBodySchema = z.object({
  order: polymarketUnsignedOrderSchema,
  exchangeAddress: zEthAddressRequired,
  authorizationSignature: zRequiredString("authorizationSignature is required"),
});

export const polymarketEmbeddedSignFeeAuthBodySchema = z.object({
  feeAuth: polymarketFeeAuthSchema,
  feeCollectorAddress: zEthAddressRequired,
  authorizationSignature: zRequiredString("authorizationSignature is required"),
});

const polymarketTypedDataFieldSchema = z.object({
  name: z.string().trim().min(1),
  type: z.string().trim().min(1),
});

const polymarketEmbeddedTypedDataSchema = z
  .object({
    primaryType: z.string().trim().min(1).optional(),
    primary_type: z.string().trim().min(1).optional(),
    domain: z.record(z.string(), z.unknown()),
    types: z.record(z.string(), z.array(polymarketTypedDataFieldSchema)),
    message: z.record(z.string(), z.unknown()),
  })
  .refine((value) => Boolean(value.primaryType ?? value.primary_type), {
    message: "primaryType is required",
  });

export const polymarketEmbeddedSignTypedDataBodySchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  label: z.string().trim().min(1).max(160).optional(),
  typedData: polymarketEmbeddedTypedDataSchema,
  authorizationSignature: zRequiredString("authorizationSignature is required"),
});
