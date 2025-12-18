import { z } from "zod";
import { zVenue } from "./common.js";

const zVenueOptional = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue.optional(),
);

export const executionsQuerySchema = z.object({
  venue: zVenueOptional,
  marketId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
});
