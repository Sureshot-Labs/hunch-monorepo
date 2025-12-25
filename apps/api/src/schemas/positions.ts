import { z } from "zod";
import { zCsvString, zVenue } from "./common.js";

const zVenueOptional = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue.optional(),
);

const zOptionalNumber = z
  .union([z.number(), z.string()])
  .transform((value) => {
    const parsed = typeof value === "string" ? Number(value) : value;
    return Number.isFinite(parsed) ? parsed : undefined;
  })
  .optional()
  .catch(undefined);

const zBoolish = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((value) => {
    if (value === undefined) return true;
    return value === true || value === "true";
  })
  .catch(true);

export const positionsQuerySchema = z.object({
  venue: zVenueOptional,
  wallets: zCsvString("wallets is required").optional(),
  minSize: zOptionalNumber,
  includeHidden: z
    .union([z.boolean(), z.string(), z.undefined()])
    .transform((v) => v === true || v === "true")
    .catch(false),
});

export const positionsByTokenQuerySchema = z.object({
  tokenIds: zCsvString("tokenIds is required"),
  venue: zVenueOptional,
  wallets: zCsvString("wallets is required").optional(),
  minSize: zOptionalNumber,
  includeHidden: z
    .union([z.boolean(), z.string(), z.undefined()])
    .transform((v) => v === true || v === "true")
    .catch(false),
});

export const positionVisibilitySchema = z.object({
  venue: zVenue,
  walletAddress: z.string().min(1),
  tokenId: z.string().min(1),
  hidden: zBoolish,
});
