import { z } from "zod";

import { FUNDING_REASON_CODES } from "../funding/domain/types.js";
import { FUNDING_SUGGESTION_PREFERENCES } from "../account-value/asset-preferences.js";
import {
  assetLocationSchema,
  moneySchema,
  usdAmountSchema,
} from "../funding/domain/schemas.js";

const fundingReasonCodeSchema = z.enum(FUNDING_REASON_CODES);
const freshnessSchema = z.enum(["fresh", "stale", "unknown"]);
const observationErrorSchema = z
  .object({
    code: z.string().min(1).max(160),
    retryable: z.boolean(),
  })
  .strict();
const usdEstimateSchema = z
  .object({
    value: usdAmountSchema,
    asOf: z.string().datetime(),
    priceSource: z.string().min(1).max(160),
    confidence: z.enum(["high", "medium", "low"]),
    policyId: z.string().min(1).max(160),
  })
  .strict();
const valuedAssetComponentSchema = z
  .object({
    componentId: z.string().min(8).max(192),
    location: assetLocationSchema,
    amount: moneySchema,
    category: z.enum(["cash", "token", "in_transit"]),
    estimatedUsd: usdEstimateSchema.nullable(),
    observedAt: z.string().datetime(),
    observationFreshness: freshnessSchema,
    observationError: observationErrorSchema.nullable(),
    valuationEligibility: z.enum(["included", "unpriced", "stale", "excluded"]),
    executionEligibility: z.enum([
      "unknown",
      "eligible",
      "temporarily_unavailable",
      "ineligible",
    ]),
    reasonCodes: z.array(fundingReasonCodeSchema),
  })
  .strict();
const valuedPositionComponentSchema = z
  .object({
    componentId: z.string().min(8).max(192),
    venueId: z.string().min(1).max(160),
    venueBindingId: z.string().min(8).max(192),
    positionRef: z.string().min(1).max(512),
    estimatedUsd: usdEstimateSchema.nullable(),
    valuationMethod: z.string().min(1).max(160),
    observedAt: z.string().datetime(),
    observationFreshness: freshnessSchema,
    observationError: observationErrorSchema.nullable(),
    valuationEligibility: z.enum(["included", "unpriced", "stale", "excluded"]),
    reasonCodes: z.array(fundingReasonCodeSchema),
  })
  .strict();
const collectorErrorSchema = z
  .object({
    collectorId: z.string().min(1).max(160),
    code: z.string().min(1).max(192),
    retryable: z.boolean(),
  })
  .strict();
const accountValueProjectionSchema = z
  .object({
    accountId: z.string().min(1).max(192),
    liquidAssetsEstimatedUsd: usdAmountSchema,
    positionsEstimatedUsd: usdAmountSchema,
    totalPortfolioEstimatedUsd: usdAmountSchema,
    headlineMode: z.enum(["liquid_only", "liquid_plus_positions"]),
    positionValuationCompleteness: z.enum(["complete", "partial"]),
    positionValuationFreshness: z.enum(["fresh", "stale"]),
    cashEstimatedUsd: usdAmountSchema,
    tokenEstimatedUsd: usdAmountSchema,
    inTransitEstimatedUsd: usdAmountSchema,
    valuationCompleteness: z.enum(["complete", "partial"]),
    valuationFreshness: z.enum(["fresh", "stale"]),
    collectorErrors: z.array(collectorErrorSchema),
    unpricedAssetCount: z.number().int().nonnegative(),
    asOf: z.string().datetime(),
    components: z.array(valuedAssetComponentSchema),
    positionComponents: z.array(valuedPositionComponentSchema),
  })
  .strict();
const cashAvailabilityComponentSchema = z
  .object({
    componentId: z.string().min(8).max(192),
    venueId: z.string().min(1).max(160).nullable(),
    venueBindingId: z.string().min(8).max(192).nullable(),
    amount: moneySchema,
    lockedRaw: z.string().regex(/^(0|[1-9]\d*)$/),
    reservedRaw: z.string().regex(/^(0|[1-9]\d*)$/),
    submittedDebitRaw: z.string().regex(/^(0|[1-9]\d*)$/),
    availableRaw: z.string().regex(/^(0|[1-9]\d*)$/),
    availableEstimatedUsd: usdAmountSchema.nullable(),
    asOf: z.string().datetime(),
    freshness: z.enum(["fresh", "stale"]),
    reasonCodes: z.array(fundingReasonCodeSchema),
  })
  .strict();
const cashAvailabilitySchema = z
  .object({
    cashAvailableEstimatedUsd: usdAmountSchema,
    byVenueEstimatedUsd: z.record(z.string(), usdAmountSchema),
    completeness: z.enum(["complete", "partial"]),
    freshness: z.enum(["fresh", "stale"]),
    collectorErrors: z.array(collectorErrorSchema),
    components: z.array(cashAvailabilityComponentSchema),
    asOf: z.string().datetime(),
  })
  .strict();
const venueSummarySchema = z
  .object({
    cashEstimatedUsd: usdAmountSchema,
    cashAvailableEstimatedUsd: usdAmountSchema,
    positionsEstimatedUsd: usdAmountSchema,
    totalPortfolioEstimatedUsd: usdAmountSchema,
  })
  .strict();

export const accountValueReadModelSchema = z
  .object({
    projection: accountValueProjectionSchema,
    headline: z
      .object({
        label: z.enum(["Estimated assets", "Portfolio value"]),
        estimatedUsd: usdAmountSchema,
        mode: z.enum(["liquid_only", "liquid_plus_positions"]),
        completeness: z.enum(["complete", "partial"]),
        freshness: z.enum(["fresh", "stale"]),
      })
      .strict(),
    cashAvailability: cashAvailabilitySchema,
    venues: z.record(z.string(), venueSummarySchema),
    policy: z
      .object({
        creationMode: z.string().min(1).max(32),
        revision: z.string().min(1).max(160),
        source: z.enum(["default", "db"]),
        invalidStoredPolicy: z.boolean(),
      })
      .strict(),
    ownershipEvidenceRevision: z.string().min(32).max(128),
    duplicateAssetObservationCount: z.number().int().nonnegative(),
    assetPreferences: z.record(
      z.string(),
      z
        .object({
          componentId: z.string().min(8).max(192),
          preference: z.enum(FUNDING_SUGGESTION_PREFERENCES),
          revision: z.string().regex(/^[1-9]\d*$/),
        })
        .strict(),
    ),
  })
  .strict();

export const accountValueResponseSchema = z
  .object({
    ok: z.literal(true),
    account: accountValueReadModelSchema,
  })
  .strict();

export const accountAssetsQuerySchema = z
  .object({
    category: z.enum(["cash", "token", "in_transit", "position"]).optional(),
    valuationEligibility: z
      .enum(["included", "unpriced", "stale", "excluded"])
      .optional(),
    cursor: z.string().min(8).max(192).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const accountAssetsResponseSchema = z
  .object({
    ok: z.literal(true),
    asOf: z.string().datetime(),
    items: z.array(
      z.union([valuedAssetComponentSchema, valuedPositionComponentSchema]),
    ),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().min(8).max(192).nullable(),
  })
  .strict();

export const accountValueErrorResponseSchema = z
  .object({
    error: z.string().min(1),
    code: z.string().min(1),
  })
  .strict();

// The shared auth middleware owns these payloads and predates WP2 error codes.
export const accountValueAuthErrorResponseSchema = z
  .object({
    error: z.string().min(1),
    code: z.string().min(1).optional(),
  })
  .strict();

export const accountAssetPreferenceParamsSchema = z
  .object({
    componentId: z.string().min(8).max(192),
  })
  .strict();

export const accountAssetPreferenceBodySchema = z
  .object({
    preference: z.enum(FUNDING_SUGGESTION_PREFERENCES),
  })
  .strict();

export const accountAssetPreferenceResponseSchema = z
  .object({
    ok: z.literal(true),
    componentId: z.string().min(8).max(192),
    preference: z.enum(FUNDING_SUGGESTION_PREFERENCES),
    revision: z.string().regex(/^[1-9]\d*$/),
    grantsTransactionAuthority: z.literal(false),
  })
  .strict();
