import { z } from "zod";
import { zCsvString, zRequiredString, zVenue } from "./common.js";

export const marketParamsSchema = z.object({
  marketId: zRequiredString("marketId parameter is required"),
});

const zVenueOptional = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue.optional(),
);

const zOptionalBool = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return undefined;
  });

export const marketsByTokenQuerySchema = z.object({
  tokenIds: zCsvString("tokenIds is required"),
  venue: zVenueOptional,
  includeTop: zOptionalBool.optional(),
});
