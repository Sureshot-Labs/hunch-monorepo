import { z } from "zod";
import { zCsvString, zVenue } from "./common.js";

const zVenueOptional = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue.optional(),
);

const zVenueListOptional = z
  .preprocess((v) => {
    const toParts = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        return value
          .filter((part): part is string => typeof part === "string")
          .flatMap((part) => part.split(","))
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean);
      }
      if (typeof value === "string") {
        return value
          .split(",")
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean);
      }
      return [];
    };

    const parts = toParts(v);
    return parts.length ? parts : undefined;
  }, z.array(zVenue).optional())
  .transform((venues) => {
    if (!venues?.length) return undefined;
    return Array.from(new Set(venues)).sort();
  });

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
  venues: zVenueListOptional,
  wallets: zCsvString("wallets is required").optional(),
  q: z
    .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
    .optional()
    .transform((v) => (v && v.length ? v.slice(0, 160) : undefined)),
  eventId: z
    .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
    .optional()
    .transform((v) => (v && v.length ? v : undefined)),
  marketId: z
    .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
    .optional()
    .transform((v) => (v && v.length ? v : undefined)),
  minSize: zOptionalNumber,
  includeHidden: z
    .union([z.boolean(), z.string(), z.undefined()])
    .transform((v) => v === true || v === "true")
    .catch(false),
  includeMarkets: z
    .union([z.boolean(), z.string(), z.undefined()])
    .transform((v) => v === true || v === "true")
    .catch(false),
  force: z
    .union([z.boolean(), z.string(), z.undefined()])
    .transform((v) => v === true || v === "true")
    .catch(false),
  debug: z
    .union([z.boolean(), z.string(), z.undefined()])
    .transform((v) => v === true || v === "true")
    .catch(false),
});

export const positionsByTokenQuerySchema = z.object({
  tokenIds: zCsvString("tokenIds is required"),
  venue: zVenueOptional,
  venues: zVenueListOptional,
  wallets: zCsvString("wallets is required").optional(),
  minSize: zOptionalNumber,
  includeHidden: z
    .union([z.boolean(), z.string(), z.undefined()])
    .transform((v) => v === true || v === "true")
    .catch(false),
});

export const positionsPnlSummaryQuerySchema = positionsQuerySchema.pick({
  venue: true,
  venues: true,
  wallets: true,
});

export const positionVisibilitySchema = z.object({
  venue: zVenue,
  walletAddress: z.string().min(1),
  tokenId: z.string().min(1),
  hidden: zBoolish,
});

export const kalshiLossCloseTransactionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  transaction: z.string().min(1),
  encoding: z.literal("base64"),
  mint: z.string().min(1),
  tokenAccount: z.string().min(1),
  amountRaw: z.string().min(1),
});

export const positionVisibilityResponseSchema = z.object({
  ok: z.literal(true),
  hidden: z.boolean(),
  closeLossTransaction: kalshiLossCloseTransactionSchema.optional(),
  closeLoss: z
    .union([
      z.object({
        skippedReason: z.literal("prepare_failed"),
        error: z.string().min(1),
      }),
      z.object({
        skippedReason: z.string().min(1),
      }),
    ])
    .optional(),
});

export const positionVisibilityErrorResponseSchema = z.object({
  error: z.string(),
});
