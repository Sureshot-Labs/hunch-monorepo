import { z } from "zod";
import { zRequiredString } from "./common.js";

export const priceHistoryQuerySchema = z.object({
  tokens: zRequiredString(
    "tokens parameter is required (comma-separated token IDs)",
  )
    .transform((s) =>
      s
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    )
    .refine((tokens) => tokens.length > 0, {
      message: "At least one token ID is required",
    })
    .refine((tokens) => tokens.length <= 50, {
      message: "Maximum 50 tokens per request",
    }),
  venue: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) => v ?? "polymarket")
    .refine((v) => v === "polymarket", {
      message: "Only polymarket is supported currently",
    }),
  startTs: z.coerce.number().int().optional(),
  endTs: z.coerce.number().int().optional(),
  interval: z
    .string()
    .optional()
    .transform((v) => v ?? "max"),
  fidelity: z.coerce.number().int().optional(),
});

export const tokenIdParamsSchema = z.object({
  tokenId: zRequiredString("tokenId parameter is required"),
});

export const orderbookBatchBodySchema = z.object({
  tokenIds: z
    .array(z.string())
    .min(1, "tokenIds must be a non-empty array")
    .max(50, "Maximum 50 tokens per batch request"),
});

export const priceQuerySchema = z.object({
  side: z
    .string()
    .min(1, "Valid side (BUY/SELL) query parameter is required")
    .transform((s) => s.toUpperCase())
    .refine((s) => s === "BUY" || s === "SELL", {
      message: "Valid side (BUY/SELL) query parameter is required",
    }),
});

export const priceBatchBodySchema = z.object({
  requests: z
    .array(
      z.object({
        token_id: zRequiredString("token_id is required"),
        side: z.enum(["BUY", "SELL"]),
      }),
    )
    .min(1, "requests must be a non-empty array")
    .max(50, "Maximum 50 requests per batch"),
});

export const spreadsBodySchema = z.object({
  tokenIds: z
    .array(z.string())
    .min(1, "tokenIds must be a non-empty array")
    .max(50, "Maximum 50 tokens per batch request"),
});
