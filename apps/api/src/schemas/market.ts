import { z } from "zod";
import { zCsvString, zRequiredString, zVenue } from "./common.js";
import { polymarketAssetContextSchema } from "./polymarket-private.js";

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

const zOptionalInt = z
  .union([z.number(), z.string(), z.undefined()])
  .transform((value) => {
    if (value === undefined) return undefined;
    const n = typeof value === "string" ? Number(value) : value;
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  });

const zOptionalNumber = z
  .union([z.number(), z.string(), z.undefined()])
  .transform((value) => {
    if (value === undefined) return undefined;
    const n = typeof value === "string" ? Number(value) : value;
    return Number.isFinite(n) ? n : undefined;
  });

const zOptionalCsv = z.union([z.string(), z.undefined()]).transform((value) => {
  if (!value) return undefined;
  const list = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return list.length ? list : undefined;
});

export const marketsByTokenQuerySchema = z
  .object({
    assetContext: z
      .string()
      .max(8192)
      .transform((value) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      })
      .pipe(polymarketAssetContextSchema)
      .optional(),
    tokenIds: zCsvString("tokenIds is required"),
    venue: zVenueOptional,
    includeTop: zOptionalBool.optional(),
  })
  .refine(
    (value) =>
      !value.assetContext ||
      ((value.venue == null || value.venue === "polymarket") &&
        value.tokenIds.length === 1 &&
        value.tokenIds[0] === value.assetContext.assetId),
    "Asset context requires its exact single Polymarket token",
  );

export const marketSimilarQuerySchema = z.object({
  limit: zOptionalInt.optional(),
  venue: zVenueOptional,
  activeOnly: zOptionalBool.optional(),
  cutoff: zOptionalNumber.optional(),
  excludeMarkets: zOptionalCsv.optional(),
  excludeEvents: zOptionalCsv.optional(),
});

export const marketAlternativesQuerySchema = z.object({
  consumer: z.enum(["alternatives", "agents"]).default("alternatives"),
  venues: z.string().trim().min(1).optional(),
  limit: zOptionalInt.optional(),
  sourceLimit: zOptionalInt.optional(),
});
