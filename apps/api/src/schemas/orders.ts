import { z } from "zod";
import { env } from "../env.js";
import { zCsvString, zVenue } from "./common.js";

const zVenueOptional = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  zVenue.optional(),
);

const zOrderKind = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(["order", "swap"]).optional(),
);

export const ordersQuerySchema = z.object({
  venue: zVenueOptional,
  wallets: zCsvString("wallets is required").optional(),
  marketId: z
    .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
    .optional()
    .transform((v) => (v && v.length ? v : undefined)),
  tokenId: z
    .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
    .optional()
    .transform((v) => (v && v.length ? v : undefined)),
  status: z
    .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
    .optional()
    .transform((v) => (v && v.length ? v : undefined)),
  type: zOrderKind,
  limit: z.coerce
    .number()
    .int()
    .catch(env.defaultLimit)
    .transform((n) => Math.min(Math.max(n, 1), env.maxLimit)),
  offset: z.coerce
    .number()
    .int()
    .catch(0)
    .transform((n) => Math.max(n, 0)),
});

export const ordersOpenQuerySchema = ordersQuerySchema.omit({
  status: true,
  type: true,
});

export const orderIdParamsSchema = z.object({
  id: z.string().min(1, "id is required"),
});

export const orderIdQuerySchema = z.object({
  wallets: zCsvString("wallets is required").optional(),
});
