import { z } from "zod";

export const marketMapQuerySchema = z.object({
  venues: z.string().trim().min(1).optional(),
  level: z.coerce.number().int().min(1).max(3).optional(),
  parent: z.string().trim().min(1).optional(),
  sizeBy: z.enum(["count", "volume24h", "liquidity", "openInterest"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  perVenueMin: z.coerce.number().int().min(0).max(50).optional(),
  includeChildrenPreview: z.coerce.boolean().optional(),
  childrenPreviewLimit: z.coerce.number().int().min(1).max(12).optional(),
  includeEventsPreview: z.coerce.boolean().optional(),
  eventsPreviewLimit: z.coerce.number().int().min(1).max(24).optional(),
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
});

export type MarketMapQuery = z.infer<typeof marketMapQuerySchema>;
export type MarketMapNodeParams = z.infer<typeof marketMapNodeParamsSchema>;
export type MarketMapNodeEventsQuery = z.infer<typeof marketMapNodeEventsQuerySchema>;
