import { z } from "zod";
import { zCsvString, zRequiredString, zVenue } from "./common.js";

export const marketParamsSchema = z.object({
  marketId: zRequiredString("marketId parameter is required"),
});

const zVenueOptional = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue.optional(),
);

export const marketsByTokenQuerySchema = z.object({
  tokenIds: zCsvString("tokenIds is required"),
  venue: zVenueOptional,
});
