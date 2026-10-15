// Pure protocol/product settings. No activation switch: venue_lifecycle owns
// exposure, exits and cancellation. Funding routes keep their existing policy.
import { z } from "zod";

export const hip4TradingPolicySchema = z
  .object({
    version: z.literal(1).default(1),
    minimumBuyNotionalUsd: z
      .string()
      .max(128)
      .regex(/^(0|[1-9]\d*)(\.\d+)?$/u)
      .refine((value) => /[1-9]/u.test(value), "Buy minimum must be positive")
      .default("1.00"),
    // Sign-only cancellation is a separate authorization, not a BUY quote.
    // Its expiry must not depend on successful balance/fee observations.
    cancelSignatureTtlMs: z.number().int().positive().safe().default(60_000),
    marketSlippageBps: z.number().int().min(0).max(10_000).default(30),
  })
  .strict();
export type Hip4TradingPolicy = z.infer<typeof hip4TradingPolicySchema>;
export const DEFAULT_HIP4_TRADING_POLICY = hip4TradingPolicySchema.parse({});
export const hip4CancelPolicySchema = hip4TradingPolicySchema
  .pick({
    version: true,
    cancelSignatureTtlMs: true,
  })
  .strip();
export const hip4MarketQuotePolicySchema = hip4TradingPolicySchema
  .pick({ version: true, marketSlippageBps: true })
  .strip();
