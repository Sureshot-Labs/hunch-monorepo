import { z } from "zod";
import { zRequiredString, zVenue } from "./common.js";

export const eventParamsSchema = z.object({
  eventId: zRequiredString("eventId parameter is required"),
});

export const eventSeriesQuerySchema = z.object({
  statuses: z.string().optional(),
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

export const eventSimilarQuerySchema = z.object({
  limit: zOptionalInt.optional(),
  venue: zVenueOptional,
  activeOnly: zOptionalBool.optional(),
  cutoff: zOptionalNumber.optional(),
  excludeEvents: zOptionalCsv.optional(),
  marketId: z.string().min(1).optional(),
  includeDetails: zOptionalBool.optional(),
});
