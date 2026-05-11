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

export type ClustersQuery = z.infer<typeof clustersQuerySchema>;
export type AggClustersQuery = z.infer<typeof aggClustersQuerySchema>;
export type ClusterParams = z.infer<typeof clusterParamsSchema>;
