import { z } from "zod";

export const candlesticksQuerySchema = z.object({
  startTs: z.coerce.number().int().optional(),
  endTs: z.coerce.number().int().optional(),
  periodInterval: z.coerce.number().int().optional(),
  interval: z.string().optional(),
  fidelity: z.coerce.number().int().optional(),
  side: z
    .preprocess(
      (value) => (typeof value === "string" ? value.toUpperCase() : value),
      z.enum(["YES", "NO"]).optional(),
    )
    .optional(),
});
