import { z } from "zod";

const tokenIdsSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .transform((parts) => parts.flatMap((p) => p.split(",")))
  .transform((parts) => parts.map((p) => p.trim()).filter(Boolean))
  .refine((parts) => parts.length > 0, {
    message: "Pass token_id or token_id=a,b,c",
  });

export const pricesStreamQuerySchema = z.object({
  token_id: tokenIdsSchema,
});
