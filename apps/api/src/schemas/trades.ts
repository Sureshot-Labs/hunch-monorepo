import { z } from "zod";
import { env } from "../env.js";
import { zCsvString } from "./common.js";

export const tradesQuerySchema = z
  .object({
    eventId: z
      .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
      .optional()
      .transform((v) => (v && v.length ? v : undefined)),
    marketId: z
      .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
      .optional()
      .transform((v) => (v && v.length ? v : undefined)),
    tokenIds: zCsvString("tokenIds is required").optional(),
    paginationMode: z.enum(["offset", "cursor"]).default("offset"),
    cursor: z.string().min(1).max(8192).optional(),
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
  })
  .refine((v) => Boolean(v.eventId || v.marketId || v.tokenIds?.length), {
    message: "eventId, marketId, or tokenIds is required",
  })
  .refine((v) => v.cursor == null || v.paginationMode === "cursor", {
    message: "cursor requires cursor pagination",
  })
  .refine(
    (v) =>
      v.paginationMode !== "cursor" ||
      (v.offset === 0 &&
        !v.tokenIds?.length &&
        (!v.eventId || v.eventId.startsWith("polymarket:")) &&
        (!v.marketId || v.marketId.startsWith("polymarket:"))),
    {
      message:
        "cursor pagination requires a Polymarket event/market scope without offset or tokenIds",
    },
  );
