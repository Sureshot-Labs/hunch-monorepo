import { z } from "zod";
import { env } from "../env.js";

const TOKEN_ID_MAX_LEN = 160;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

const tokenIdsSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .transform((parts) => parts.flatMap((p) => p.split(",")))
  .transform((parts) => parts.map((p) => p.trim()).filter(Boolean))
  .transform((parts) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
      if (seen.has(part)) continue;
      seen.add(part);
      out.push(part);
    }
    return out;
  })
  .refine((parts) => parts.length > 0, {
    message: "Pass token_id or token_id=a,b,c",
  })
  .refine((parts) => parts.length <= env.pricesSseMaxTokens, {
    message: `Max ${env.pricesSseMaxTokens} token_id values allowed`,
  })
  .refine((parts) => parts.every((id) => id.length <= TOKEN_ID_MAX_LEN), {
    message: `token_id must be <= ${TOKEN_ID_MAX_LEN} characters`,
  })
  .refine((parts) => parts.every((id) => TOKEN_ID_PATTERN.test(id)), {
    message: "token_id contains invalid characters",
  });

export const pricesStreamQuerySchema = z.object({
  token_id: tokenIdsSchema,
});
