import { z } from "zod";
import { normalizeRewardsChainId } from "../lib/rewards-chain.js";

export const rewardsReferralsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const rewardsReferralCodeUpdateBodySchema = z.object({
  code: z.string().trim().min(1).max(32),
});

const rewardsChainIdSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const normalized = normalizeRewardsChainId(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unsupported chainId. Allowed: 137, 8453, solana",
      });
      return z.NEVER;
    }
    return normalized;
  });

export const rewardsClaimBodySchema = z.object({
  chainId: rewardsChainIdSchema,
  walletAddress: z.string().trim().min(1).optional(),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string")
    .optional(),
});

export const rewardsLeaderboardQuerySchema = z.object({
  metric: z.enum(["points", "volume", "pnl"]).default("points"),
  interval: z
    .enum(["daily", "weekly", "monthly", "yearly", "alltime"])
    .default("alltime"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
