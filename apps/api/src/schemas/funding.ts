import { z } from "zod";

import { FUNDING_REASON_CODES } from "../funding/domain/types.js";
import {
  assetLocationSchema,
  assetRefSchema,
  canonicalIdSchema,
  fundingCommitRequestSchema,
  fundingDiscoveryRequestSchema,
  fundingQuoteRequestSchema,
  marketReferenceSchema,
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

export const fundingTradeShortfallPreflightRequestSchema =
  fundingDiscoveryRequestSchema.superRefine((request, context) => {
    if (request.purpose !== "trade_shortfall") {
      context.addIssue({
        code: "custom",
        path: ["purpose"],
        message: "trusted preflight is available only for a trade shortfall",
      });
    }
    if (!request.controllerWalletRef) {
      context.addIssue({
        code: "custom",
        path: ["controllerWalletRef"],
        message: "trusted preflight requires the selected controller wallet",
      });
    }
  });

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
    marketContextId: marketReferenceSchema.nullable(),
    marketClass: z.string().trim().min(1).max(80).nullable(),
    positionActionRef: z.string().uuid().nullable().optional(),
    controllerWalletRef: z.string().uuid().nullable().optional(),
  })
  .strict();

export const fundingPreparationInspectRequestSchema =
  preparationRequestBaseSchema;

export const fundingPreparationPrepareRequestSchema =
  preparationRequestBaseSchema
    .extend({
      // Accepted for compatibility only. The server-owned run id is the
      // durable idempotency boundary.
      operationId: opaqueIdSchema.optional(),
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

const fundingReceiveTargetSchema = z
  .object({
    receiveTargetId: opaqueIdSchema,
    networkId: z.string().trim().min(2).max(160),
    destinationAddress: z.string().trim().min(16).max(256),
    acceptedAssets: z
      .array(
        z
          .object({
            asset: assetRefSchema,
            handling: z.enum([
              "direct",
              "automatic_conversion",
              "review_required",
            ]),
            senderNativeFeeRequirement: moneySchema.nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    safeInstructions: z.array(z.string().trim().min(1).max(240)).max(16),
  })
  .strict()
  .superRefine((target, context) => {
    for (const [index, accepted] of target.acceptedAssets.entries()) {
      if (accepted.asset.networkId !== target.networkId) {
        context.addIssue({
          code: "custom",
          path: ["acceptedAssets", index, "asset", "networkId"],
          message: "accepted ingress asset must use its receive target network",
        });
      }
    }
  });

export const externalIngressInstructionSchema = z
  .object({
    ingressKind: z.enum(["controlled_wallet", "exchange", "privy", "manual"]),
    sourceNetworkId: z.string().trim().min(2).max(160).nullable(),
    sourceAsset: assetRefSchema.nullable(),
    receiveTargets: z
      .array(fundingReceiveTargetSchema)
      .min(1)
      .max(16)
      .optional(),
    recommendedReceiveTargetId: opaqueIdSchema.nullable().optional(),
    destinationOptionId: opaqueIdSchema,
    destinationAddress: z.string().trim().min(16).max(256),
    requestedAmount: moneySchema.nullable(),
    amountSemantics: z.enum(["minimum", "exact"]),
    expiresAt: z.string().datetime().nullable(),
    safeInstructions: z.array(z.string().trim().min(1).max(240)).max(16),
  })
  .strict()
  .superRefine((instruction, context) => {
    if (!instruction.receiveTargets) {
      if (instruction.recommendedReceiveTargetId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["recommendedReceiveTargetId"],
          message:
            "recommended receive target requires an explicit target list",
        });
      }
      return;
    }
    const targetIds = instruction.receiveTargets.map(
      (target) => target.receiveTargetId,
    );
    if (new Set(targetIds).size !== targetIds.length) {
      context.addIssue({
        code: "custom",
        path: ["receiveTargets"],
        message: "receive target identifiers must be unique",
      });
    }
    if (
      instruction.recommendedReceiveTargetId == null ||
      !targetIds.includes(instruction.recommendedReceiveTargetId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["recommendedReceiveTargetId"],
        message: "recommended receive target must identify an available target",
      });
    }
  });

export const fundingReceiveSessionOpenRequestSchema = z
  .object({
    destinationOptionId: opaqueIdSchema,
    venueBindingOptionId: opaqueIdSchema,
    selectedReceiveTargetId: opaqueIdSchema.nullable().optional(),
  })
  .strict();

export const fundingReceiveSessionParamsSchema = z
  .object({ id: z.string().uuid() })
  .strict();

export const fundingReceiveReceiptParamsSchema = z
  .object({
    id: z.string().uuid(),
    receiptId: z.string().uuid(),
  })
  .strict();

export const fundingReceiveSessionPublicSchema = z
  .object({
    receiveSessionId: z.string().uuid(),
    status: z.enum([
      "open",
      "processing",
      "review_required",
      "completed",
      "expired",
      "cancelled",
      "recovery_required",
    ]),
    venueId: z.string().trim().min(2).max(160),
    destinationOptionId: opaqueIdSchema,
    venueBindingOptionId: opaqueIdSchema,
    destinationAsset: assetRefSchema,
    methods: z
      .array(
        z
          .object({
            methodId: opaqueIdSchema,
            kind: z.enum(["manual", "privy"]),
            safeLabel: z.string().trim().min(2).max(120),
            ingress: externalIngressInstructionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(8),
    receiveTargets: z.array(fundingReceiveTargetSchema).min(1).max(16),
    selectedReceiveTargetId: opaqueIdSchema.nullable(),
    automationPolicy: z
      .object({
        stableConversion: z.literal("automatic_within_caps"),
        volatileConversion: z.literal("review_required"),
        maximumFeeUsd: usdAmountSchema,
        maximumFeeBps: z.number().int().min(0).max(10_000),
        maximumSlippageBps: z.number().int().min(0).max(500),
      })
      .strict(),
    version: z.number().int().positive(),
    openedAt: z.string().datetime(),
    lastObservedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime(),
    observeUntil: z.string().datetime(),
    closedAt: z.string().datetime().nullable(),
  })
  .strict();

export const fundingReceiveReceiptPublicSchema = z
  .object({
    receiptId: z.string().uuid(),
    receiveSessionId: z.string().uuid(),
    variantId: opaqueIdSchema,
    asset: assetRefSchema,
    destinationAddress: z.string().trim().min(16).max(256),
    rawAmount: rawAmountSchema,
    observationRevision: z.string().trim().min(8).max(256),
    observedAt: z.string().datetime(),
    status: z.enum([
      "observed",
      "review_required",
      "routing",
      "ready",
      "recovery_required",
    ]),
    handling: z.enum(["direct", "automatic_conversion", "review_required"]),
    childFundingOperationId: z.string().uuid().nullable(),
  })
  .strict();

export const fundingReceiveSessionResponseSchema = z
  .object({
    ok: z.literal(true),
    session: fundingReceiveSessionPublicSchema,
    receipts: z.array(fundingReceiveReceiptPublicSchema).max(256),
    replayed: z.boolean(),
  })
  .strict();

const sourceOptionLegSchema = z
  .object({
    sourceLegId: opaqueIdSchema,
    safeLabel: z.string().trim().min(1).max(160),
    source: fundingSourceRefSchema.refine(
      (source) => source.kind !== "composite",
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
    ingress: externalIngressInstructionSchema.optional(),
    sourceLegs: z.array(sourceOptionLegSchema).min(2).max(16).optional(),
    amountMode: z.enum(["exact_input", "exact_output", "variable_external"]),
    quotedSourceAmount: moneySchema.nullable().optional(),
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
    const directIngress =
      option.kind === "manual_receive" ||
      option.kind === "privy_funding_method" ||
      option.kind === "relay_deposit_address";
    if (
      directIngress !==
      (option.source.kind === "external_ingress" && Boolean(option.ingress))
    ) {
      context.addIssue({
        code: "custom",
        path: ["ingress"],
        message:
          "external ingress source kind, source reference, and instructions must agree",
      });
    }
    if (
      option.ingress &&
      option.ingress.destinationOptionId.trim().length > 0 &&
      option.source.kind === "external_ingress" &&
      option.ingress.ingressKind !== option.source.ingressKind
    ) {
      context.addIssue({
        code: "custom",
        path: ["ingress", "ingressKind"],
        message: "external ingress instruction kind differs from source",
      });
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
    venueBindingId: opaqueIdSchema,
    venueBindingOptionId: opaqueIdSchema,
    controllerWalletId: opaqueIdSchema,
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

const fundingPreparationActionStateSchema = z.enum([
  "action_required",
  "submitted",
  "ambiguous",
  "failed",
  "cancelled",
  "succeeded",
]);

const fundingPreparationRunStatusSchema = z.enum([
  ...fundingPreparationActionStateSchema.options,
  "expired",
]);

const fundingPreparationRunResponseFields = {
  ok: z.literal(true),
  runId: z.string().uuid(),
  status: fundingPreparationRunStatusSchema,
  inspectionRevision: opaqueIdSchema,
  actions: z.array(normalizedActionSchema).max(64),
  actionAttempts: z
    .array(
      z
        .object({
          actionId: opaqueIdSchema,
          ordinal: z.number().int().min(0).max(63),
          actionFingerprint: z.string().trim().min(32).max(192),
          action: normalizedActionSchema,
          state: fundingPreparationActionStateSchema,
          broadcastMayHaveOccurred: z.boolean(),
          transactionReference: z.string().trim().min(8).max(512).nullable(),
          reportedAt: z.string().datetime().nullable(),
          resolvedAt: z.string().datetime().nullable(),
        })
        .strict(),
    )
    .max(64),
  controllerWalletRef: z.string().uuid(),
  expiresAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  replayed: z.boolean(),
} as const;

export const fundingPreparationPrepareResponseSchema = z
  .object(fundingPreparationRunResponseFields)
  .strict();

export const fundingPreparationRunResponseSchema = z
  .object(fundingPreparationRunResponseFields)
  .strict();

export const fundingPreparationRunParamsSchema = z
  .object({
    runId: z.string().uuid(),
  })
  .strict();

export const fundingPreparationActionParamsSchema = z
  .object({
    runId: z.string().uuid(),
    actionId: opaqueIdSchema,
  })
  .strict();

export const fundingPreparationActionReportRequestSchema = z
  .object({
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
    if (
      report.outcome === "submitted" &&
      report.transactionReference === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["transactionReference"],
        message: "submitted report requires a transaction reference",
      });
    }
    if (
      (report.outcome === "failed" || report.outcome === "cancelled") &&
      report.transactionReference !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["transactionReference"],
        message: "an unbroadcast action cannot have a transaction reference",
      });
    }
  });

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
    marketContextId: marketReferenceSchema.nullable(),
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
    consentMode: z.enum([
      "trade_intent",
      "explicit_economic_review",
      "external_action",
    ]),
    sourceAmounts: z
      .array(
        z
          .object({
            safeLabel: z.string().trim().min(1).max(160),
            amount: moneySchema,
          })
          .strict(),
      )
      .max(16),
    expectedDestination: moneySchema,
    minimumDestination: moneySchema,
    fees: z.array(feeSchema).max(32),
    eta: etaSchema.nullable(),
    requiredActions: z.array(actionSummarySchema).max(64),
    ingress: externalIngressInstructionSchema.nullable(),
    planHash: z.string().trim().min(32).max(192),
    consentToken: opaqueIdSchema,
    expiresAt: z.string().datetime(),
    policyVersion: z.number().int().positive(),
  })
  .strict();

export const fundingDestinationsQuerySchema = z
  .object({
    purpose: preparationPurposeSchema.default("fund"),
    marketContextId: marketReferenceSchema.nullable().optional(),
    marketClass: z.string().trim().min(1).max(80).nullable().optional(),
    positionActionRef: z.string().uuid().nullable().optional(),
    controllerWalletRef: z.string().uuid().nullable().optional(),
  })
  .strict();

export const fundingDestinationsResponseSchema = z
  .object({
    ok: z.literal(true),
    options: z.array(fundingDestinationOptionSchema).max(128),
  })
  .strict();

export const fundingCapabilitiesResponseSchema = z
  .object({
    ok: z.literal(true),
    fundingApiVersion: z.literal(1),
    receiveSessionsVersion: z.literal(1),
    creationMode: z.enum(["off", "on"]),
    destinationVenues: z.array(canonicalIdSchema).max(64),
    supportedActionKinds: z
      .array(
        z.enum([
          "add_funds",
          "trade_shortfall",
          "convert_asset",
          "withdrawal",
          "redeem",
        ]),
      )
      .max(5),
  })
  .strict();

export const fundingLiquidityResponseSchema = z
  .object({
    ok: z.literal(true),
    liquidity: intentLiquidityProjectionSchema,
  })
  .strict();

export const fundingTradeShortfallPreflightResponseSchema = z
  .object({
    ok: z.literal(true),
    fundingRequired: z.boolean(),
    additionalDestinationAmount: moneySchema.nullable(),
    liquidity: intentLiquidityProjectionSchema.nullable(),
  })
  .strict();

export const fundingQuoteResponseSchema = z
  .object({
    ok: z.literal(true),
    quote: fundingQuoteSummarySchema,
  })
  .strict();

export const fundingReceiveReceiptReviewQuoteResponseSchema = z
  .object({
    ok: z.literal(true),
    receipt: fundingReceiveReceiptPublicSchema,
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
    venueId: z.string().trim().min(1).max(160).nullable(),
    requestedSourceAmount: moneySchema.nullable(),
    requestedDestinationAmount: moneySchema.nullable(),
    actualSourceAmount: moneySchema.nullable(),
    actualDestinationAmount: moneySchema.nullable(),
    errorCode: z.string().trim().min(1).max(160).nullable(),
    recoveryMode: z.enum(["automatic_evidence", "manual_review"]).nullable(),
    version: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export const fundingOperationStepPublicSchema = z
  .object({
    stepId: opaqueIdSchema,
    ordinal: z.number().int().min(0),
    kind: z.enum([
      "approval",
      "transaction",
      "signature",
      "external_handoff",
      "server_action",
      "venue_preparation",
    ]),
    state: z.enum([
      "planned",
      "action_required",
      "submitted",
      "succeeded",
      "reconcile_required",
      "recovery_required",
      "failed",
      "cancelled",
    ]),
    dependsOnStepId: opaqueIdSchema.nullable(),
    dependencyState: z
      .enum([
        "planned",
        "action_required",
        "submitted",
        "succeeded",
        "reconcile_required",
        "recovery_required",
        "failed",
        "cancelled",
      ])
      .nullable(),
    actionable: z.boolean(),
  })
  .strict();

export const fundingOperationResponseSchema = z
  .object({
    ok: z.literal(true),
    operation: fundingOperationPublicSchema,
    steps: z.array(fundingOperationStepPublicSchema).max(256),
    ingress: externalIngressInstructionSchema.nullable(),
    consumerReservation: z
      .object({
        operationId: opaqueIdSchema,
        reservationId: opaqueIdSchema,
        rawAmount: rawAmountSchema,
        asset: assetRefSchema,
        consumerIntent: z
          .object({
            venueId: z.string().trim().min(1).max(160),
            marketId: marketReferenceSchema,
            marketContextId: marketReferenceSchema,
            side: z.literal("BUY"),
            spend: moneySchema,
            fingerprint: z.string().trim().min(32).max(192),
          })
          .strict(),
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
    controllerWalletRef: z.string().uuid(),
    executorId: z.string().trim().min(2).max(160),
    executionMode: z.enum([
      "web_client",
      "privy_authorization",
      "venue_relayer",
    ]),
    payerRequirement: z.enum(["user", "privy_sponsor", "provider"]),
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
    code: z.string().optional(),
  })
  .strict();

export const fundingValidationErrorResponseSchema = z.union([
  fundingApiErrorResponseSchema,
  z
    .object({
      statusCode: z.literal(400),
      code: z.string(),
      error: z.string(),
      message: z.string().optional(),
    })
    .passthrough(),
]);
