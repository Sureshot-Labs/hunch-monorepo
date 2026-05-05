import { z } from "zod";
export const holdersQuerySchema = z.object({
  marketId: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().min(1, "marketId is required"),
  ),
  limit: z.coerce
    .number()
    .int()
    .catch(20)
    .transform((n) => Math.min(Math.max(n, 1), 50)),
});
