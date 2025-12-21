import { z } from "zod";
import { zCsvString, zVenue } from "./common.js";

const zVenueOptional = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue.optional(),
);

export const positionsQuerySchema = z.object({
  venue: zVenueOptional,
  wallets: zCsvString("wallets is required").optional(),
});

export const positionsByTokenQuerySchema = z.object({
  tokenIds: zCsvString("tokenIds is required"),
  venue: zVenueOptional,
  wallets: zCsvString("wallets is required").optional(),
});
