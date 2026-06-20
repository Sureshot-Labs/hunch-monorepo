import { z } from "zod";

import { zVenue } from "./common.js";

const zChain = z.enum(["polygon", "base", "solana"]);
const filterModeSchema = z.enum(["any", "all"]).default("any");
const signalSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
const uppercaseEnum = <T extends [string, ...string[]]>(values: T) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(values),
  );
const walletOutcomeSideSchema = uppercaseEnum(["YES", "NO"]);
const walletTradeActionSchema = uppercaseEnum(["BUY", "SELL"]);
const walletChangeActionSchema = uppercaseEnum([
  "OPENED",
  "INCREASED",
  "REDUCED",
  "CLOSED",
]);
const walletMarketStatusSchema = uppercaseEnum([
  "ACTIVE",
  "OPEN",
  "CLOSED",
  "SETTLED",
  "ARCHIVED",
  "RESOLVED",
]);
const walletLabelColorSchema = z.enum([
  "orange",
  "cyan",
  "green",
  "gold",
  "pink",
]);

const csvStringArraySchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return undefined;
  },
  z.array(z.string().min(1)).optional(),
);

const categoriesCsvSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return undefined;
  },
  z.array(z.string().min(1)).optional(),
);

const queryBooleanSchema = z.preprocess((value) => {
  if (value == null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

export const walletFollowBodySchema = z.object({
  address: z.string().min(4),
  chain: zChain,
  label: z.string().min(1).max(120).optional(),
});

export const walletFollowParamsSchema = z.object({
  address: z.string().min(4),
});

export const walletFollowChainQuerySchema = z.object({
  chain: zChain,
});

export const walletFollowDeleteQuerySchema = walletFollowChainQuerySchema;

export const walletFollowPatchBodySchema = z.object({
  label: z.preprocess((value) => {
    if (value == null) return null;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }, z.string().max(120).nullable()),
});

const nullableTrimmedStringSchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (value == null) return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}, z.string().max(120).nullable().optional());

export const walletPrivateMetaPatchBodySchema = z
  .object({
    name: nullableTrimmedStringSchema,
    label: nullableTrimmedStringSchema,
    labelColor: walletLabelColorSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.label !== undefined ||
      value.labelColor !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

export const walletPrivateNoteBodySchema = z.object({
  note: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }, z.string().max(500)),
});

export const walletPrivateNoteParamsSchema = z.object({
  address: z.string().min(4),
  noteId: z.string().uuid(),
});

export const walletFollowingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const walletResolverParamsSchema = z.object({
  address: z.string().min(4),
});

export const walletResolverQuerySchema = z.object({
  chain: zChain.optional(),
});

export const walletProfileParamsSchema = z.object({
  walletId: z.string().uuid(),
});

export const walletActivityQuerySchema = z.object({
  walletId: z.string().uuid().optional(),
  venue: zVenue.optional(),
  marketId: z.string().trim().min(1).optional(),
  eventId: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  outcomeSide: walletOutcomeSideSchema.optional(),
  action: walletTradeActionSchema.optional(),
  changeAction: walletChangeActionSchema.optional(),
  minSizeUsd: z.coerce.number().min(0).optional(),
  minDeltaShares: z.coerce.number().min(0).optional(),
  marketStatus: walletMarketStatusSchema.optional(),
  acceptingOrders: queryBooleanSchema.optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const walletActivitySummaryQuerySchema = z.object({
  scope: z.enum(["following", "whales", "all"]).default("whales"),
  windowHours: z.coerce.number().int().min(1).optional(),
  topChanges: z.coerce.number().int().min(1).max(10).default(5),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z
    .enum(["last_activity", "net_change_usd", "unusual_score", "importance"])
    .default("last_activity"),
  categories: categoriesCsvSchema.optional(),
  tags: csvStringArraySchema.optional(),
  tagMode: filterModeSchema,
  primary: csvStringArraySchema.optional(),
  labels: csvStringArraySchema.optional(),
  labelMode: filterModeSchema,
  includeAttribution: queryBooleanSchema.default(true),
  includeSparkline: queryBooleanSchema.default(false),
});

export const walletActivitySummaryStatsQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).optional(),
});

export const walletActivitySignalsQuerySchema = z.object({
  walletId: z.string().uuid().optional(),
  scope: z.enum(["following", "active", "all"]).default("following"),
  windowHours: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  minStakeUsd: z.coerce.number().min(0).optional(),
  maxOdds: z.coerce.number().min(0).max(1).optional(),
  minIdleDays: z.coerce.number().int().min(0).optional(),
  maxPriorMarkets: z.coerce.number().int().min(0).optional(),
  minPayoutUsd: z.coerce.number().min(0).optional(),
  minScore: z.coerce.number().min(0).max(1).optional(),
  signalType: z.enum(["longshot_large", "longshot_large_late"]).optional(),
  lateBucket: z.enum(["late", "very_late", "unknown"]).optional(),
  categories: categoriesCsvSchema.optional(),
  tags: csvStringArraySchema.optional(),
  tagMode: filterModeSchema,
  primary: csvStringArraySchema.optional(),
  labels: csvStringArraySchema.optional(),
  labelMode: filterModeSchema,
  excludeMmLike: queryBooleanSchema.default(false),
  severity: z
    .preprocess((value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        return value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      }
      return undefined;
    }, z.array(signalSeveritySchema).optional())
    .optional(),
  displayReasons: csvStringArraySchema.optional(),
  signalReasonMode: filterModeSchema,
  includeAttribution: queryBooleanSchema.default(false),
});

export const walletPositionsQuerySchema = z.object({
  walletId: z.string().uuid().optional(),
  venue: zVenue.optional(),
  marketId: z.string().trim().min(1).optional(),
  eventId: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  outcomeSide: walletOutcomeSideSchema.optional(),
  marketStatus: walletMarketStatusSchema.optional(),
  acceptingOrders: queryBooleanSchema.optional(),
  since: z.string().datetime().optional(),
  latest: queryBooleanSchema.default(true),
  includeSmall: queryBooleanSchema.default(false),
  minPositionUsd: z.coerce.number().min(0).optional(),
  minPositionShares: z.coerce.number().min(0).optional(),
  minSizeUsd: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const walletPositionHistoryQuerySchema = z.object({
  walletId: z.string().uuid(),
  venue: zVenue.optional(),
  marketId: z.string().trim().min(1).optional(),
  eventId: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  outcomeSide: walletOutcomeSideSchema.optional(),
  marketStatus: walletMarketStatusSchema.optional(),
  acceptingOrders: queryBooleanSchema.optional(),
  since: z.string().datetime().optional(),
  includeSmall: queryBooleanSchema.default(false),
  minPositionUsd: z.coerce.number().min(0).optional(),
  minPositionShares: z.coerce.number().min(0).optional(),
  minSizeUsd: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const marketWalletActivityParamsSchema = z.object({
  marketId: z.string().trim().min(1),
});

export const marketWalletActivityQuerySchema = z.object({
  since: z.string().datetime().optional(),
  outcomeSide: walletOutcomeSideSchema.optional(),
  action: walletTradeActionSchema.optional(),
  changeAction: walletChangeActionSchema.optional(),
  minSizeUsd: z.coerce.number().min(0).optional(),
  minDeltaShares: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const walletPositioningSortSchema = z.enum([
  "tracked_position_usd",
  "wallet_count",
  "yes_position_usd",
  "no_position_usd",
  "imbalance_usd",
  "balanced_disagreement",
  "minority_side_usd",
  "abs_imbalance_pct",
  "event_disagreement_score",
  "contested_market_count",
  "cross_market_wallet_count",
  "top_market_minority_side_usd",
  "largest_market_pct",
  "avg_win_rate",
  "avg_win_rate_edge",
  "avg_edge_z_score",
  "avg_brier_score",
  "avg_roi",
  "newest_snapshot",
]);

const walletPositioningShapeSchema = z.enum(["table", "tree", "graph", "both"]);
const walletPositioningEventShapeSchema = z.enum([
  "any",
  "single_market",
  "multi_market",
]);
const walletPositioningHolderSortSchema = z.enum([
  "position_usd",
  "edge_z_score",
]);

export const walletPositioningQuerySchema = z.object({
  scope: z.enum(["whales"]).default("whales"),
  venue: zVenue.optional(),
  category: z.string().trim().min(1).optional(),
  marketStatus: walletMarketStatusSchema.default("ACTIVE"),
  acceptingOrders: queryBooleanSchema.optional(),
  outcomeSide: walletOutcomeSideSchema.optional(),
  walletActiveWithinHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .default(24 * 30),
  minWalletExposureUsd: z.coerce.number().min(0).default(100),
  minPositionUsd: z.coerce.number().min(0).default(100),
  minWallets: z.coerce.number().int().min(1).max(100).optional(),
  minYesPositionUsd: z.coerce.number().min(0).optional(),
  minNoPositionUsd: z.coerce.number().min(0).optional(),
  minMinoritySideUsd: z.coerce.number().min(0).optional(),
  minMinoritySideShare: z.coerce.number().min(0).max(1).optional(),
  minYesWallets: z.coerce.number().int().min(1).max(100).optional(),
  minNoWallets: z.coerce.number().int().min(1).max(100).optional(),
  minAbsImbalancePct: z.coerce.number().min(0).max(1).optional(),
  maxAbsImbalancePct: z.coerce.number().min(0).max(1).optional(),
  maxLargestHolderPct: z.coerce.number().min(0).max(1).optional(),
  minBalancedDisagreementScore: z.coerce.number().min(0).optional(),
  contestedMinMinoritySideUsd: z.coerce.number().min(0).default(10_000),
  contestedMinMinoritySideShare: z.coerce.number().min(0).max(1).default(0.05),
  contestedMinSideWallets: z.coerce.number().int().min(1).max(100).default(2),
  contestedMaxLargestHolderPct: z.coerce.number().min(0).max(1).default(0.85),
  eventShape: walletPositioningEventShapeSchema.default("any"),
  minContestedMarketCount: z.coerce.number().int().min(1).optional(),
  minEventDisagreementScore: z.coerce.number().min(0).optional(),
  minCrossMarketWallets: z.coerce.number().int().min(1).optional(),
  mmMode: z.enum(["all", "exclude", "only"]).default("all"),
  sort: walletPositioningSortSchema.default("tracked_position_usd"),
  includeHolders: queryBooleanSchema.default(true),
  holdersLimit: z.coerce.number().int().min(0).max(20).default(3),
  holderSort: walletPositioningHolderSortSchema.default("position_usd"),
  includePositionPnl: queryBooleanSchema.default(false),
  shape: walletPositioningShapeSchema.default("table"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const eventWalletPositioningParamsSchema = z.object({
  eventId: z.string().trim().min(1),
});

export const marketWalletPositioningParamsSchema = z.object({
  marketId: z.string().trim().min(1),
});

export const walletWhalesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  marketLimit: z.coerce.number().int().min(1).max(20).default(5),
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
  includeSummary: queryBooleanSchema.default(false),
  windowHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .default(24),
  topChanges: z.coerce.number().int().min(1).max(10).default(3),
  categories: z
    .preprocess(
      (value) => {
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          return value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        }
        return undefined;
      },
      z.array(z.string().min(1)).optional(),
    )
    .optional(),
  sort: z
    .enum([
      "last_activity",
      "volume_30d",
      "trades_30d",
      "exposure_usd",
      "imbalance_usd",
      "winrate",
      "edge_z_score",
      "stake_weighted_edge",
      "brier_score",
      "pnl_30d",
      "roi_30d",
    ])
    .default("last_activity"),
  mmMode: z.enum(["all", "exclude", "only"]).default("all"),
  minTrades30d: z.coerce.number().int().min(0).optional(),
  minResolvedCount: z.coerce.number().int().min(0).optional(),
  minPnl30d: z.coerce.number().optional(),
  minRoi30d: z.coerce.number().optional(),
  minWinRate30d: z.coerce.number().min(0).max(1).optional(),
  minResolvedEdgeSampleCount: z.coerce.number().int().min(0).optional(),
  minResolvedStakeUsd: z.coerce.number().min(0).optional(),
  minResolvedWinRateEdge30d: z.coerce.number().optional(),
  minResolvedEdgeZScore30d: z.coerce.number().optional(),
  maxResolvedBrierScore30d: z.coerce.number().min(0).optional(),
  maxExposureUsd: z.coerce.number().min(0).optional(),
  maxNetImbalanceUsd: z.coerce.number().min(0).optional(),
  tags: csvStringArraySchema.optional(),
  tagMode: filterModeSchema,
  primary: csvStringArraySchema.optional(),
  labels: csvStringArraySchema.optional(),
  labelMode: filterModeSchema,
  includeAttribution: queryBooleanSchema.default(true),
  includeSparkline: queryBooleanSchema.default(false),
});

export const walletSeriesQuerySchema = z.object({
  windowHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  bucketHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .optional(),
  period: z.enum(["1d", "7d", "30d", "all"]).default("30d"),
  limit: z.coerce.number().int().min(1).max(240).default(120),
});
