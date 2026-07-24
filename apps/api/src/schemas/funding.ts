import { z } from "zod";

import { FUNDING_REASON_CODES } from "../funding/domain/types.js";
import {
  assetLocationSchema,
  assetRefSchema,
  fundingCommitRequestSchema,
  fundingDiscoveryRequestSchema,
  fundingQuoteRequestSchema,
  moneySchema,
  opaqueIdSchema,
  rawAmountSchema,
  usdAmountSchema,
} from "../funding/domain/schemas.js";

export {
  fundingCommitRequestSchema,
  fundingDiscoveryRequestSchema,
  fundingQuoteRequestSchema,
};

const fundingReasonCodeSchema = z.enum(FUNDING_REASON_CODES);
const preparationPurposeSchema = z.enum([
  "fund",
  "buy",
  "sell",
  "redeem",
  "withdraw",
]);
const preparationExecutionModeSchema = z.enum([
  "web_client",
  "privy_authorization",
  "privy_delegated",
  "venue_relayer",
]);
const readinessClassSchema = z.enum([
  "internal_managed",
  "external_ready",
  "external_setup_available",
  "external_source_only",
  "external_view_only",
]);
const preparationStatusSchema = z.enum([
  "ready",
  "setup_required",
  "user_action_required",
  "unavailable",
]);

const actionSummarySchema = z
  .object({
    kind: z.enum([
      "evm_transaction",
      "svm_transaction",
      "signature",
      "external_handoff",
    ]),
    safeLabel: z.string().trim().min(1).max(160),
    actor: z.enum(["user", "server"]),
    valueMoving: z.boolean(),
    sponsorship: z.enum(["none", "requested", "required"]),
  })
  .strict();

const fundingSourceRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("owned_location"),
      location: assetLocationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_ingress"),
      ingressKind: z.enum(["controlled_wallet", "exchange", "privy", "manual"]),
      networkId: z.string().nullable(),
      asset: assetRefSchema.nullable(),
      controlledSender: z.boolean(),
    })
    .strict(),
]);

const feeSchema = z
  .object({
    kind: z.string().trim().min(1).max(80),
    amount: moneySchema,
    estimatedUsd: usdAmountSchema.nullable(),
  })
  .strict();

const etaSchema = z
  .object({
    minSeconds: z.number().int().min(0),
    maxSeconds: z.number().int().min(0),
  })
  .strict()
  .refine((value) => value.maxSeconds >= value.minSeconds);

export const sourceOptionSchema = z
  .object({
    sourceOptionId: opaqueIdSchema,
    kind: z.enum([
      "wallet_asset",
      "venue_cash",
      "privy_funding_method",
      "manual_receive",
      "relay_deposit_address",
    ]),
    safeLabel: z.string().trim().min(1).max(160),
    source: fundingSourceRefSchema,
    amountMode: z.enum(["exact_input", "exact_output", "variable_external"]),
    maximumSourceRaw: rawAmountSchema.nullable(),
    expectedDestination: moneySchema.nullable(),
    minimumDestination: moneySchema.nullable(),
    estimatedUsd: usdAmountSchema.nullable(),
    fees: z.array(feeSchema).max(32),
    eta: etaSchema.nullable(),
    experienceMode: z.enum(["inline_funding", "prepare_first", "unavailable"]),
    requiredActions: z.array(actionSummarySchema).max(64),
    expiresAt: z.string().datetime(),
    recommended: z.boolean(),
    selectable: z.boolean(),
    reasonCodes: z.array(fundingReasonCodeSchema).max(64),
  })
  .strict();

export const fundingDestinationOptionSchema = z
  .object({
    destinationOptionId: opaqueIdSchema,
    venueId: z.string().trim().min(2).max(160),
    venueBindingOptionId: opaqueIdSchema,
    safeLabel: z.string().trim().min(1).max(160),
    requiredAsset: assetRefSchema,
    networkLabel: z.string().trim().min(1).max(80),
    readinessClass: readinessClassSchema,
    preparationStatus: preparationStatusSchema,
    preparationPurpose: preparationPurposeSchema,
    executionMode: preparationExecutionModeSchema,
    marketClass: z.string().trim().min(1).max(80).nullable(),
    topology: z.string().trim().min(1).max(80),
    inspectionRevision: opaqueIdSchema,
    recommended: z.boolean(),
    selectable: z.boolean(),
    reasonCodes: z.array(fundingReasonCodeSchema).max(64),
  })
  .strict();

export const intentLiquidityProjectionSchema = z
  .object({
    liquidityProjectionId: opaqueIdSchema,
    marketContextId: opaqueIdSchema.nullable(),
    venueId: z.string().trim().min(2).max(160).nullable(),
    venueBindingOptionId: opaqueIdSchema.nullable(),
    destinationOptionId: opaqueIdSchema.nullable(),
    collateralAsset: assetRefSchema,
    requestedCollateralRaw: rawAmountSchema,
    availableNowRaw: rawAmountSchema,
    shortfallRaw: rawAmountSchema,
    convertibleRaw: rawAmountSchema,
    requestedUsd: usdAmountSchema,
    availableNowUsd: usdAmountSchema,
    shortfallUsd: usdAmountSchema,
    convertibleUsd: usdAmountSchema,
    mode: z.enum(["instant", "inline_funding", "prepare_first", "unavailable"]),
    eta: z
      .object({
        minSeconds: z.number().int().min(0),
        maxSeconds: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    requiredActions: z.array(actionSummarySchema).max(64),
    sourceOptions: z.array(sourceOptionSchema).max(128),
    asOf: z.string().datetime(),
    expiresAt: z.string().datetime(),
    policyVersion: z.number().int().positive(),
    completeness: z.enum(["complete", "partial"]),
    freshness: z.enum(["fresh", "stale"]),
    errors: z
      .array(
        z
          .object({
            code: z.string().trim().min(1).max(160),
            retryable: z.boolean(),
          })
          .strict(),
      )
      .max(128),
    reasonCodes: z.array(fundingReasonCodeSchema).max(64),
    destinationOptions: z.array(fundingDestinationOptionSchema).max(128),
  })
  .strict();

export const fundingQuoteSummarySchema = z
  .object({
    quoteId: opaqueIdSchema,
    liquidityProjectionId: opaqueIdSchema,
    selectedSourceOptionId: opaqueIdSchema,
    destinationOptionId: opaqueIdSchema,
    venueBindingOptionId: opaqueIdSchema,
    planKind: z.enum([
      "wallet_route",
      "relay_deposit_address",
      "direct_external_handoff",
      "already_available",
    ]),
    experienceMode: z.enum(["instant", "inline_funding", "prepare_first"]),
    expectedDestination: moneySchema,
    minimumDestination: moneySchema,
    fees: z.array(feeSchema).max(32),
    eta: etaSchema.nullable(),
    requiredActions: z.array(actionSummarySchema).max(64),
    planHash: z.string().trim().min(32).max(192),
    consentToken: opaqueIdSchema,
    expiresAt: z.string().datetime(),
    policyVersion: z.number().int().positive(),
  })
  .strict();

export const fundingDestinationsQuerySchema = z
  .object({
    purpose: preparationPurposeSchema.default("fund"),
    marketContextId: opaqueIdSchema.nullable().optional(),
    marketClass: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .strict();

export const fundingDestinationsResponseSchema = z
  .object({
    ok: z.literal(true),
    options: z.array(fundingDestinationOptionSchema).max(128),
  })
  .strict();

export const fundingLiquidityResponseSchema = z
  .object({
    ok: z.literal(true),
    liquidity: intentLiquidityProjectionSchema,
  })
  .strict();

export const fundingQuoteResponseSchema = z
  .object({
    ok: z.literal(true),
    quote: fundingQuoteSummarySchema,
  })
  .strict();

export const fundingOperationPublicSchema = z
  .object({
    operationId: opaqueIdSchema,
    purpose: z.enum([
      "add_funds",
      "trade_shortfall",
      "convert_asset",
      "withdrawal",
      "manual_rebalance",
    ]),
    status: z.string().trim().min(1).max(80),
    progressStage: z.string().trim().min(1).max(80),
    experienceMode: z.enum(["instant", "inline", "prepare_first"]),
    planKind: z.enum([
      "wallet_route",
      "relay_deposit_address",
      "direct_external_handoff",
      "already_available",
    ]),
    errorCode: z.string().trim().min(1).max(160).nullable(),
    version: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export const fundingOperationResponseSchema = z
  .object({
    ok: z.literal(true),
    operation: fundingOperationPublicSchema,
    replayed: z.boolean().optional(),
  })
  .strict();

export const fundingOperationParamsSchema = z
  .object({ id: opaqueIdSchema })
  .strict();

export const fundingOperationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: z.string().datetime().nullable().optional(),
  })
  .strict();

export const fundingOperationsResponseSchema = z
  .object({
    ok: z.literal(true),
    operations: z.array(fundingOperationPublicSchema).max(100),
  })
  .strict();

export const fundingApiErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z.string(),
  })
  .strict();

export const fundingValidationErrorResponseSchema = z.union([
  fundingApiErrorResponseSchema,
  z
    .object({
      statusCode: z.literal(400),
      code: z.string(),
      error: z.string(),
      message: z.string(),
    })
    .passthrough(),
]);
