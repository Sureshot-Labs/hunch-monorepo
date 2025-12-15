import { z } from "zod";
import { zRequiredString } from "./common.js";

export const watchlistAddBodySchema = z.object({
  marketId: z
    .string()
    .min(1, "marketId is required")
    .refine((s) => s.includes(":"), {
      message:
        "Invalid marketId format. Expected format: venue:venue_market_id",
    }),
});

export const watchlistListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
  include_inactive: z
    .union([z.boolean(), z.string(), z.undefined()])
    .transform((v) => v === true || v === "true")
    .catch(false),
});

export const watchlistRemoveParamsSchema = z.object({
  marketId: zRequiredString("marketId parameter is required"),
});
