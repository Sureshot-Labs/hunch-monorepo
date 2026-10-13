import { z } from "zod";
import {
  venueLifecyclePolicySchema,
  venueLifecycleCapabilitiesSchema,
} from "@hunch/shared";

const venueStateSchema =
  venueLifecyclePolicySchema.shape.venues.shape.polymarket.extend({
    capabilities: venueLifecycleCapabilitiesSchema,
  });
export const venueMetadataSchema = z.object({
  total: z.number().int().nonnegative(),
  generatedAt: z.string(),
  coverageStatus: z.enum(["pending", "ready", "stale"]),
  coverageAsOf: z.string().nullable(),
  venues: z.array(
    z.object({
      venue: z.string(),
      activeMarkets: z.number().nullable(),
      counts: z.object({
        withVolume: z.number().nullable(),
        withLiquidity: z.number().nullable(),
        withPrice: z.number().nullable(),
      }),
      coverage: z.object({
        volume: z.number().nullable(),
        liquidity: z.number().nullable(),
        price: z.number().nullable(),
        score: z.number().nullable(),
      }),
    }),
  ),
  policy: z.object({
    source: z.enum(["db", "default", "env"]),
    effectiveAt: z.string().nullable(),
    invalidOverride: z.boolean(),
    revision: z.string(),
    venues: z.object({
      polymarket: venueStateSchema,
      limitless: venueStateSchema,
      kalshi: venueStateSchema,
      hyperliquid: venueStateSchema,
    }),
  }),
});
export const venueMetadataRouteSchema = {
  response: { 200: venueMetadataSchema },
};
