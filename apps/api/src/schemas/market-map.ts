import { z } from "zod";

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

export const marketMapQuerySchema = z.object({
  venues: z.string().trim().min(1).optional(),
  level: z.coerce.number().int().min(1).max(3).optional(),
  parent: z.string().trim().min(1).optional(),
  sizeBy: z
    .enum(["count", "volume24h", "liquidity", "openInterest"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  perVenueMin: z.coerce.number().int().min(0).max(50).optional(),
  includeChildrenPreview: z.coerce.boolean().optional(),
  childrenPreviewLimit: z.coerce.number().int().min(1).max(12).optional(),
  includeEventsPreview: z.coerce.boolean().optional(),
  eventsPreviewLimit: z.coerce.number().int().min(1).max(24).optional(),
  marketsPreviewLimit: z.coerce.number().int().min(1).max(12).optional(),
  // Backward-compat aliases.
  includeLeafEventsPreview: z.coerce.boolean().optional(),
  leafEventsPreviewLimit: z.coerce.number().int().min(1).max(24).optional(),
});

export const marketMapNodeParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const marketMapNodeEventsQuerySchema = z.object({
  venues: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort_by: z.enum(["volume24h", "liquidity", "openInterest"]).optional(),
  sort_dir: z.enum(["asc", "desc"]).optional(),
  marketsPreviewLimit: z.coerce.number().int().min(1).max(12).optional(),
});

export const marketMapSidebarsQuerySchema = z.object({
  venues: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(25).optional(),
  trendingLimit: z.coerce.number().int().min(0).max(25).optional(),
  volumeMoversLimit: z.coerce.number().int().min(0).max(25).optional(),
  liquidityMoversLimit: z.coerce.number().int().min(0).max(25).optional(),
  topMoversLimit: z.coerce.number().int().min(0).max(25).optional(),
  volumeMoversSortBy: z.enum(["percent", "absolute"]).optional(),
  liquidityMoversSortBy: z.enum(["percent", "absolute"]).optional(),
  minVolume24h: z.coerce.number().min(0).optional(),
  minLiquidity: z.coerce.number().min(0).optional(),
  minVolumeChange24h: z.coerce.number().min(0).optional(),
  minVolumeChangePct24h: z.coerce.number().min(0).optional(),
  minLiquidityChange24h: z.coerce.number().min(0).optional(),
  minLiquidityChangePct24h: z.coerce.number().min(0).optional(),
  includeVolumeSparkline: queryBooleanSchema.default(false),
  includeLiquiditySparkline: queryBooleanSchema.default(false),
  includeMovementSparkline: queryBooleanSchema.default(false),
  sparklineWindowHours: z.coerce.number().int().min(1).max(168).optional(),
  sparklineBucketHours: z.coerce.number().int().min(1).max(24).optional(),
});

export type MarketMapQuery = z.infer<typeof marketMapQuerySchema>;
export type MarketMapNodeParams = z.infer<typeof marketMapNodeParamsSchema>;
export type MarketMapNodeEventsQuery = z.infer<
  typeof marketMapNodeEventsQuerySchema
>;
export type MarketMapSidebarsQuery = z.infer<
  typeof marketMapSidebarsQuerySchema
>;
