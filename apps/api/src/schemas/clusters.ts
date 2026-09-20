import { z } from "zod";

export const clustersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  minLiquidity: z.coerce.number().min(0).optional(),
  minVenueCount: z.coerce.number().int().min(1).max(10).optional(),
  minSpread: z.coerce.number().min(0).max(1).optional(),
  minQualityScore: z.coerce.number().min(0).max(1).optional(),
  minAnalysisConfidence: z.coerce.number().min(0).max(1).optional(),
  maxOutlierRatio: z.coerce.number().min(0).max(1).optional(),
  sort_by: z.enum(["volume24h"]).optional(),
  sort_dir: z.enum(["asc", "desc"]).optional(),
});

export const aggClustersQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(500).optional(),
  venues: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sourceLimit: z.coerce.number().int().min(1).max(100).optional(),
  minLiquidity: z.coerce.number().min(0).optional(),
  minVenueCount: z.coerce.number().int().min(1).max(10).optional(),
  minSpread: z.coerce.number().min(0).max(1).optional(),
  sort_by: z.enum(["spread", "volume24h"]).optional(),
  sort_dir: z.enum(["asc", "desc"]).optional(),
});

export const clusterParamsSchema = z.object({
  id: z.string().min(1),
});

export const matchedClustersQuerySchema = aggClustersQuerySchema.extend({
  consumer: z.enum(["clusters", "agents"]).default("clusters"),
});

export type ClustersQuery = z.infer<typeof clustersQuerySchema>;
export type AggClustersQuery = z.infer<typeof aggClustersQuerySchema>;
export type ClusterParams = z.infer<typeof clusterParamsSchema>;

const nativeQuoteSchema = z.object({
  bid: z.number().nullable(),
  ask: z.number().nullable(),
  asOf: z.string().nullable(),
  fresh: z.boolean(),
});
/** Additive quote fields; legacy summaries keep their existing wire fields. */
export const matchingQuoteFieldsSchema = z.looseObject({
  verifiedOutcomeMapping: z
    .object({
      YES: z.enum(["YES", "NO"]).nullable(),
      NO: z.enum(["YES", "NO"]).nullable(),
    })
    .optional(),
  nativeQuotes: z
    .object({ yes: nativeQuoteSchema, no: nativeQuoteSchema })
    .optional(),
});
export const matchedClustersResponseSchema = z.looseObject({
  items: z.array(
    z.looseObject({ markets: z.array(matchingQuoteFieldsSchema) }),
  ),
});
export const matchedAlternativesResponseSchema = z.looseObject({
  markets: z.array(matchingQuoteFieldsSchema),
  alternatives: z.array(matchingQuoteFieldsSchema),
  lowestYesMid: matchingQuoteFieldsSchema.nullable().optional(),
  lowestNoMid: matchingQuoteFieldsSchema.nullable().optional(),
});
