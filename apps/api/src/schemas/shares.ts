import { z } from "zod";
import { zVenue } from "./common.js";

const zVenueList = z
  .preprocess((value) => {
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    }
    if (typeof value === "string") {
      return value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    }
    return undefined;
  }, z.array(zVenue).optional())
  .transform((venues) => {
    if (!venues?.length) return undefined;
    return Array.from(new Set(venues)).sort();
  });

const zWalletList = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}, z.array(z.string().min(1)).optional());

const zOptionalReferralCode = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .optional()
  .nullable();

export const portfolioPnlShareCreateBodySchema = z.object({
  source: z.literal("portfolio").default("portfolio"),
  referralCode: zOptionalReferralCode,
  venue: z
    .preprocess(
      (value) => (typeof value === "string" ? value.toLowerCase() : value),
      zVenue.optional(),
    )
    .optional(),
  venues: zVenueList,
  wallets: zWalletList,
  topPositionId: z.string().uuid().optional().nullable(),
});

export const tradePnlShareCreateBodySchema = z.object({
  source: z.literal("position"),
  positionId: z.string().uuid(),
  referralCode: zOptionalReferralCode,
});

export const shareIdParamsSchema = z.object({
  shareId: z.string().min(1).max(64),
});
