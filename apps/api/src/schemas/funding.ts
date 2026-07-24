import { z } from "zod";

import { FUNDING_REASON_CODES } from "../funding/domain/types.js";
import {
  assetLocationSchema,
  assetRefSchema,
  fundingCommitRequestSchema,
  fundingDiscoveryRequestSchema,
  fundingQuoteRequestSchema,
  moneySchema,
  normalizedActionSchema,
  opaqueIdSchema,
  rawAmountSchema,
  usdAmountSchema,
} from "../funding/domain/schemas.js";

export {
  fundingCommitRequestSchema,
  fundingDiscoveryRequestSchema,
  fundingQuoteRequestSchema,
};

export const fundingReasonCodeSchema = z.enum(FUNDING_REASON_CODES);
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

const preparationRequestBaseSchema = z
  .object({
    venueBindingOptionId: opaqueIdSchema,
    purpose: preparationPurposeSchema,
    marketContextId: opaqueIdSchema.nullable(),
    marketClass: z.string().trim().min(1).max(80).nullable(),
  })
  .strict();

export const fundingPreparationInspectRequestSchema =
  preparationRequestBaseSchema;

export const fundingPreparationPrepareRequestSchema =
  preparationRequestBaseSchema
    .extend({
      operationId: opaqueIdSchema,
      expectedInspectionRevision: opaqueIdSchema,
    })
    .strict();

export const actionSummarySchema = z
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
  z
    .object({
      kind: z.literal("composite"),
      legCount: z.number().int().min(2).max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal("venue_preparation"),
      venueId: z.string().trim().min(2).max(160),
      venueBindingId: opaqueIdSchema,
      inputCount: z.number().int().min(1).max(16),
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

const sourceOptionLegSchema = z
  .object({
    sourceLegId: opaqueIdSchema,
    safeLabel: z.string().trim().min(1).max(160),
    source: fundingSourceRefSchema.refine(
      (source) =>
        source.kind !== "composite" && source.kind !== "venue_preparation",
      "a composite source leg must be independently executable",
    ),
    sourceAmount: moneySchema,
    expectedDestination: moneySchema,
    minimumDestination: moneySchema,
    fees: z.array(feeSchema).max(32),
    eta: etaSchema.nullable(),
    requiredActions: z.array(actionSummarySchema).max(64),
  })
  .strict();

export const sourceOptionSchema = z
  .object({
    sourceOptionId: opaqueIdSchema,
    kind: z.enum([
      "wallet_asset",
      "venue_cash",
      "privy_funding_method",
      "manual_receive",
      "relay_deposit_address",
      "venue_preparation",
      "composite",
    ]),
    safeLabel: z.string().trim().min(1).max(160),
    source: fundingSourceRefSchema,
    sourceLegs: z.array(sourceOptionLegSchema).min(2).max(16).optional(),
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
  .strict()
  .superRefine((option, context) => {
    const composite = option.kind === "composite";
    if (
      composite !== (option.source.kind === "composite") ||
      composite !== Boolean(option.sourceLegs)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceLegs"],
        message:
          "composite source kind, source reference, and source legs must agree",
      });
      return;
    }
    if (
      (option.kind === "venue_preparation") !==
      (option.source.kind === "venue_preparation")
    ) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message:
          "venue preparation source kind and source reference must agree",
      });
    }
    if (
      option.source.kind === "composite" &&
      option.sourceLegs &&
      option.source.legCount !== option.sourceLegs.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["source", "legCount"],
        message: "composite source leg count differs from its frozen legs",
      });
    }
  });

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

const venueAccountBindingSchema = z
  .object({
    bindingId: opaqueIdSchema,
    venueId: z.string().trim().min(2).max(160),
    controllerWalletId: opaqueIdSchema,
    executionWalletId: opaqueIdSchema,
    accountRef: z.string().trim().min(1).max(256),
    settlementLocation: assetLocationSchema,
    signingMode: z.enum([
      "web_client",
      "privy_authorization",
      "privy_delegated",
    ]),
  })
  .strict();

export const preparationResultSchema = z
  .object({
    status: preparationStatusSchema,
    binding: venueAccountBindingSchema,
    safeLabel: z.string().trim().min(1).max(160),
    purpose: preparationPurposeSchema,
    marketClass: z.string().trim().min(1).max(80).nullable(),
    readinessClass: readinessClassSchema,
    executionMode: preparationExecutionModeSchema,
    topology: z.string().trim().min(1).max(80),
    inspectionRevision: opaqueIdSchema,
    inspectedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    requiredActions: z.array(actionSummarySchema).max(64),
    postconditions: z
      .array(
        z
          .object({
            kind: z.string().trim().min(1).max(160),
            safeLabel: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .max(64),
    reasonCodes: z.array(fundingReasonCodeSchema).max(64),
    evidence: z
      .object({
        facts: z.record(z.string(), z.unknown()),
        checks: z
          .array(
            z
              .object({
                checkId: z.string().trim().min(1).max(160),
                status: z.enum([
                  "satisfied",
                  "action_required",
                  "user_action_required",
                  "pending",
                  "unavailable",
                  "unsupported",
                ]),
                safeLabel: z.string().trim().min(1).max(240),
                reasonCode: fundingReasonCodeSchema.nullable(),
              })
              .strict(),
          )
          .max(128),
      })
      .strict(),
  })
  .strict();

export const fundingPreparationInspectResponseSchema = z
  .object({
    ok: z.literal(true),
    preparation: preparationResultSchema,
  })
  .strict();

export const fundingPreparationPrepareResponseSchema = z
  .object({
    ok: z.literal(true),
    actions: z.array(normalizedActionSchema).max(64),
  })
  .strict();

export const fundingWithdrawalDestinationRequestSchema = z
  .object({
    asset: assetRefSchema,
    address: z.string().trim().min(16).max(256),
  })
  .strict();

export const fundingWithdrawalDestinationResponseSchema = z
  .object({
    ok: z.literal(true),
    recipientId: opaqueIdSchema,
    networkId: z.string().trim().min(2).max(160),
    asset: assetRefSchema,
    safeAddress: z.string().trim().min(3).max(256),
    addressFingerprint: z.string().trim().min(32).max(192),
    validatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    validationPolicyVersion: z.number().int().positive(),
    replayed: z.boolean(),
  })
  .strict();

export const fundingWithdrawalDestinationParamsSchema = z
  .object({ id: opaqueIdSchema })
  .strict();

export const fundingWithdrawalDestinationRevokeResponseSchema = z
  .object({
    ok: z.literal(true),
    recipientId: opaqueIdSchema,
    revoked: z.literal(true),
    revokedAt: z.string().datetime().nullable(),
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
    destinationOptionId: opaqueIdSchema.nullable(),
    venueBindingOptionId: opaqueIdSchema.nullable(),
    planKind: z.enum([
      "wallet_route",
      "relay_deposit_address",
      "direct_external_handoff",
      "already_available",
      "venue_preparation",
      "composite_route",
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
      "venue_preparation",
      "composite_route",
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
    consumerReservation: z
      .object({
        operationId: opaqueIdSchema,
        reservationId: opaqueIdSchema,
        rawAmount: rawAmountSchema,
        asset: assetRefSchema,
        expiresAt: z.string().datetime(),
      })
      .strict()
      .nullable()
      .optional(),
    replayed: z.boolean().optional(),
  })
  .strict();

export const fundingOperationParamsSchema = z
  .object({ id: opaqueIdSchema })
  .strict();

export const fundingOperationActionParamsSchema = z
  .object({
    id: opaqueIdSchema,
    stepId: opaqueIdSchema,
  })
  .strict();

export const fundingOperationActionPrepareResponseSchema = z
  .object({
    ok: z.literal(true),
    attemptId: opaqueIdSchema,
    action: normalizedActionSchema,
    actionFingerprint: z.string().trim().min(32).max(192),
    executorId: z.string().trim().min(2).max(160),
    executionMode: z.enum(["web_client", "privy_authorization"]),
    payerRequirement: z.enum(["user", "privy_sponsor"]),
    sponsorshipPolicyId: z.string().trim().min(2).max(160).nullable(),
  })
  .strict();

export const fundingOperationActionReportRequestSchema = z
  .object({
    attemptId: opaqueIdSchema,
    outcome: z.enum(["submitted", "ambiguous", "failed", "cancelled"]),
    transactionReference: z.string().trim().min(8).max(512).nullable(),
    actualCosts: z
      .object({
        networkFeeRaw: rawAmountSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    const mayHaveBroadcast =
      report.outcome === "submitted" || report.outcome === "ambiguous";
    if (mayHaveBroadcast !== Boolean(report.transactionReference)) {
      context.addIssue({
        code: "custom",
        path: ["transactionReference"],
        message:
          "submitted or ambiguous report requires one transaction reference",
      });
    }
  });

export const fundingOperationActionReportResponseSchema = z
  .object({
    ok: z.literal(true),
    accepted: z.literal(true),
    stepState: z.enum([
      "submitted",
      "reconcile_required",
      "failed",
      "cancelled",
    ]),
  })
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
