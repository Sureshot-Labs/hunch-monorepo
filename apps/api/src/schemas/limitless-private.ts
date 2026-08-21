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

export const limitlessOrderBodySchema = z
  .object({
    order: limitlessOrderSchema,
    orderType: zOrderType.default("GTC"),
    marketSlug: zLimitlessSlug,
    ownerId: z.coerce.number().int().optional(),
    fundingOperationId: z.string().uuid().optional(),
    fundingReservationId: z.string().uuid().optional(),
    telegramAppHandoffId: z.string().uuid().optional(),
    telegramAppHandoffPlanFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/iu, "Invalid Telegram handoff fingerprint")
      .optional(),
  })
  .superRefine((value, context) => {
    if (
      Boolean(value.fundingOperationId) !== Boolean(value.fundingReservationId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "fundingOperationId and fundingReservationId must be provided together",
      });
    }
    if (
      Boolean(value.telegramAppHandoffId) !==
      Boolean(value.telegramAppHandoffPlanFingerprint)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "telegramAppHandoffId and telegramAppHandoffPlanFingerprint must be provided together",
      });
    }
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
  limit: zLimit,
  cursor: z.string().trim().min(1).optional(),
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

export const limitlessAmmOrderBodySchema = z
  .object({
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
    fundingOperationId: z.string().uuid().optional(),
    fundingReservationId: z.string().uuid().optional(),
    fundingTradeAttemptId: z.string().uuid().optional(),
  })
  .superRefine((value, context) => {
    if (
      Boolean(value.fundingOperationId) !== Boolean(value.fundingReservationId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "fundingOperationId and fundingReservationId must be provided together",
      });
    }
    if (
      Boolean(value.fundingOperationId) !== Boolean(value.fundingTradeAttemptId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "fundingTradeAttemptId is required exactly when funding reservation fields are provided",
      });
    }
  });

export const limitlessAmmFundingClaimBodySchema = z
  .object({
    amountUsdRaw: z.string().regex(/^[1-9][0-9]*$/, "amountUsdRaw is invalid"),
    fundingOperationId: z.string().uuid(),
    fundingReservationId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(8).max(192),
    marketAddress: zEthAddressRequired,
    marketSlug: zLimitlessSlug.optional(),
    tokenId: zRequiredString("tokenId is required"),
    transactionData: z
      .string()
      .regex(/^0x[a-fA-F0-9]+$/, "transactionData is invalid"),
    telegramAppHandoffId: z.string().uuid().optional(),
    telegramAppHandoffPlanFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/iu, "Invalid Telegram handoff fingerprint")
      .optional(),
  })
  .superRefine((value, context) => {
    if (
      Boolean(value.telegramAppHandoffId) !==
      Boolean(value.telegramAppHandoffPlanFingerprint)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "telegramAppHandoffId and telegramAppHandoffPlanFingerprint must be provided together",
      });
    }
  });

/**
 * A v2 handoff AMM Buy or Sell is signed by the Mini App, then broadcast by
 * Hunch.
 * Keeping the signed bytes in this request lets the API claim its immutable
 * hash before any RPC submission; the value is never stored in Postgres.
 */
export const limitlessAmmHandoffBroadcastBodySchema = z.object({
  telegramAppHandoffId: z.string().uuid(),
  // Telegram plan fingerprints are SHA-256 hex without the EVM `0x` prefix.
  telegramAppHandoffPlanFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/iu, "Invalid Telegram handoff fingerprint"),
  tokenId: zRequiredString("tokenId is required"),
  marketSlug: zLimitlessSlug.optional(),
  signedTransaction: z
    .string()
    .regex(/^0x[a-fA-F0-9]+$/, "signedTransaction is invalid")
    .max(65_536, "signedTransaction is too large"),
});

export const limitlessAmmFundingStartBodySchema = z.object({
  attemptId: z.string().uuid(),
  claimToken: z.string().uuid(),
  fundingOperationId: z.string().uuid(),
  fundingReservationId: z.string().uuid(),
});

export const limitlessAmmFundingOutcomeBodySchema = z
  .object({
    attemptId: z.string().uuid(),
    outcome: z.enum(["ambiguous", "not_broadcast"]),
    txHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid tx hash format")
      .optional(),
    errorCode: z.string().trim().min(1).max(128).optional(),
  })
  .superRefine((value, context) => {
    if (value.outcome === "not_broadcast" && value.txHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "not_broadcast outcome cannot include txHash",
      });
    }
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
  marketSlug: zLimitlessSlug.optional(),
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

export const limitlessClobQuoteQuerySchema = z
  .object({
    slug: zLimitlessSlug,
    tokenId: zRequiredString("tokenId is required"),
    side: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim().toUpperCase() : value,
      z.enum(["BUY", "SELL"]),
    ),
    amountUsd: z.coerce.number().positive().optional(),
    amountShares: z.coerce.number().positive().optional(),
  })
  .superRefine((value, context) => {
    if ((value.amountUsd == null) === (value.amountShares == null)) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of amountUsd or amountShares",
      });
    }
  });
