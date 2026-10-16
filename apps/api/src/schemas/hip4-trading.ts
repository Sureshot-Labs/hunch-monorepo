import { z } from "zod";
import {
  hip4OrderPreparationRequestSchema,
  hip4CancelPreparationRequestSchema,
} from "../repos/hip4-order-preparation.js";
import { hip4TradeActionSchema } from "../services/hip4-trade-signing.js";
import { hip4MarketOrderQuoteRequestSchema } from "../services/hip4-market-order.js";
import { hip4OrderRecoverySchema } from "../repos/hip4-order-recovery.js";

const uuid = z.string().uuid();
const raw = z.string().regex(/^(0|[1-9]\d*)$/u);
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/u);
const timestamp = z.string().datetime();
export const hip4TradingAmountsSchema = z.object({
  protocolVersion: z.string(),
  policyRevision: z.string().nullable(),
  side: z.enum(["BUY", "SELL"]),
  timeInForce: z.enum(["Gtc", "Ioc", "Alo"]),
  limitPrice: decimal,
  quantity: raw,
  tokenRaw: raw,
  grossQuoteRaw: raw,
  feeCapRaw: raw.nullable(),
  sellFeeEstimateAtLimitRaw: raw.nullable(),
  debitAsset: z.enum(["quote", "outcome"]),
  debitCapRaw: raw,
  minimumNetProceedsRaw: raw.nullable(),
  estimatedNetProceedsAtLimitRaw: raw.nullable(),
  minimum: z
    .object({
      protocolQuoteRaw: raw,
      productQuoteRaw: raw,
      effectiveQuoteRaw: raw,
      quantity: raw,
      normalizedNotionalRaw: raw,
    })
    .nullable(),
  sellMinimumKnown: z.literal(false),
});
export const hip4TradingFeesSchema = z.object({
  version: z.literal("hip4-outcome-fees-v1"),
  observedAt: timestamp,
  expiresAt: timestamp,
  feeRoleAssumption: z.enum(["maker", "taker", "maker_or_taker"]),
  makerRate: decimal,
  takerRate: decimal,
  currentRateUpperBound: decimal,
  alignmentTreatment: z.literal("undiscounted_upper_rate"),
  estimatedFeeAtLimitRaw: raw,
  estimatedNetProceedsAtLimitRaw: raw.nullable(),
  buyFeeCapRaw: raw.nullable(),
  lifetimeFeeCapRaw: z.null(),
  feeAccounting: z.literal("actual_execution_fee"),
  fundingCostsIncluded: z.literal(false),
  builderFeesEnabled: z.literal(false),
});
export const hip4TradingQuoteSchema = z.object({
  amounts: hip4TradingAmountsSchema,
  fees: hip4TradingFeesSchema,
  // Provider capacity is NOT spendability after Hunch funding/order holds.
  providerCapacity: z.object({
    assetId: z.string(),
    decimals: z.number().int(),
    availableRaw: raw,
    observedAt: timestamp,
    expiresAt: timestamp,
    includesHunchHolds: z.literal(false),
  }),
  expiresAt: timestamp,
});
export const hip4TradingMarketQuoteSchema = hip4TradingQuoteSchema.extend({
  // Runtime already normalizes UUIDs. Output schemas must describe their
  // resulting string type, not an input transform that OpenAPI emits as unknown.
  preparationRequest: hip4OrderPreparationRequestSchema.extend({
    requestKey: uuid,
    controllerWalletRef: uuid,
  }),
  executionEstimate: z.object({
    source: z.literal("native_l2"),
    coin: z.string(),
    observedAt: timestamp,
    expiresAt: timestamp,
    slippageBps: z.number().int().min(0).max(10_000),
    referencePrice: decimal,
    estimatedFillQuantity: raw,
    estimatedUnfilledQuantity: raw,
    estimatedGrossQuoteRaw: raw,
    partialFillPossible: z.literal(true),
    guaranteed: z.literal(false),
  }),
});
export const hip4TradingPreparationSchema = z.object({
  actionId: uuid,
  orderId: uuid,
  cloid: z.string().regex(/^0x[0-9a-f]{32}$/u),
  state: z.enum(["prepared", "abandoned"]),
  signerAddress: z.string().regex(/^0x[0-9a-f]{40}$/u),
  environment: z.literal("mainnet"),
  action: hip4TradeActionSchema,
  nonce: z.number().int().nonnegative(),
  expiresAt: timestamp,
  typedData: z.object({
    domain: z.object({
      name: z.literal("Exchange"),
      version: z.literal("1"),
      chainId: z.literal(1337),
      verifyingContract: z.literal(
        "0x0000000000000000000000000000000000000000",
      ),
    }),
    types: z.object({
      Agent: z.tuple([
        z.object({ name: z.literal("source"), type: z.literal("string") }),
        z.object({
          name: z.literal("connectionId"),
          type: z.literal("bytes32"),
        }),
      ]),
    }),
    primaryType: z.literal("Agent"),
    message: z.object({
      source: z.literal("a"),
      connectionId: z.string().regex(/^0x[0-9a-f]{64}$/u),
    }),
  }),
  amounts: hip4TradingAmountsSchema.nullable(),
  fees: hip4TradingFeesSchema.nullable(),
});
const hip4TradingSubmitBodyBase = z
  .object({
    actionId: uuid,
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/u),
    telegramAppHandoffId: z.string().uuid().optional(),
    telegramAppHandoffPlanFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/iu)
      .optional(),
    funding: z
      .object({ operationId: uuid, reservationId: uuid })
      .strict()
      .optional(),
  })
  .strict();
export const hip4TradingSubmitBodySchema = hip4TradingSubmitBodyBase.refine(
  (value) =>
    Boolean(value.telegramAppHandoffId) ===
    Boolean(value.telegramAppHandoffPlanFingerprint),
  {
    message: "Both Telegram handoff fields are required together",
    path: ["telegramAppHandoffId"],
  },
);
export const hip4TradingCancelSubmitBodySchema = hip4TradingSubmitBodyBase
  .omit({
    funding: true,
    telegramAppHandoffId: true,
    telegramAppHandoffPlanFingerprint: true,
  })
  .extend({ orderId: uuid })
  .strict();
export const hip4TradingSubmissionSchema = z.object({
  actionId: uuid,
  orderId: uuid,
  state: z.enum(["submission_started", "reconcile_required", "rejected"]),
  replayed: z.boolean(),
  reconciliationRequired: z.boolean(),
});
const error = z.object({ error: z.string() });
export const hip4TradingErrors = {
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
  503: error,
};
function route<Body extends z.ZodType, Response extends z.ZodType>(
  body: Body,
  response: Response,
) {
  return {
    tags: ["Hyperliquid trading"],
    body,
    response: { 200: response, ...hip4TradingErrors },
  };
}
// Used by both the real HTTP registrations and the offline client-contract generator.
export const hip4TradingRouteSchemas = {
  "/orders/market-quote": route(
    hip4MarketOrderQuoteRequestSchema,
    hip4TradingMarketQuoteSchema,
  ),
  "/orders/quote": route(
    hip4OrderPreparationRequestSchema,
    hip4TradingQuoteSchema,
  ),
  "/orders/prepare": route(
    hip4OrderPreparationRequestSchema,
    hip4TradingPreparationSchema,
  ),
  "/orders/submit": route(
    hip4TradingSubmitBodySchema,
    hip4TradingSubmissionSchema,
  ),
  "/orders/cancel/prepare": route(
    hip4CancelPreparationRequestSchema,
    hip4TradingPreparationSchema,
  ),
  "/orders/cancel/submit": route(
    hip4TradingCancelSubmitBodySchema,
    hip4TradingSubmissionSchema,
  ),
  "/orders/abandon": route(
    z.object({ actionId: uuid }).strict(),
    hip4OrderRecoverySchema,
  ),
  "/orders/recheck": route(
    z.object({ actionId: uuid }).strict(),
    hip4OrderRecoverySchema,
  ),
};
export const hip4TradingReadRouteSchemas = {
  "/orders/actions/:actionId": {
    tags: ["Hyperliquid trading"],
    params: z.object({ actionId: uuid }),
    response: { 200: hip4OrderRecoverySchema, ...hip4TradingErrors },
  },
};
export {
  hip4OrderPreparationRequestSchema,
  hip4CancelPreparationRequestSchema,
};
