import { z } from "zod";
import { env } from "../env.js";
import { zVenue } from "./common.js";

const zVenueQuery = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue.optional(),
);

export const feedQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .catch(env.defaultLimit)
    .transform((n) => Math.min(Math.max(n, 1), env.maxLimit)),
  offset: z.coerce
    .number()
    .int()
    .catch(0)
    .transform((n) => Math.max(n, 0)),
  min_volume24hr: z.coerce.number().catch(1e-9),
  min_liquidity: z.coerce.number().catch(0),
  venue: zVenueQuery,
  category: z.string().optional(),
  filter: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) => (v === "newest" || v === "endingsoon" ? v : undefined)),
  sort: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) => (v === "totalvol" || v === "liquidity" ? v : undefined)),
});
