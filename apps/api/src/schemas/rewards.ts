import { z } from "zod";
import { normalizeRewardsChainId } from "../lib/rewards-chain.js";

export const rewardsReferralsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const rewardsReferralCodeUpdateBodySchema = z.object({
  code: z.string().trim().min(3).max(10),
});

export const rewardsReferralAttachBodySchema = z.object({
  code: z.string().trim().min(3).max(10),
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
  analyticsAttemptId: z.string().trim().min(1).optional(),
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
  excludeManual: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const rewardsTutorialStateSchema = z.object({
  dismissedAt: z.string().nullable(),
});

export const rewardsTutorialStateResponseSchema = z.object({
  ok: z.literal(true),
  tutorial: rewardsTutorialStateSchema,
});

export const rewardsOnboardingShareClaimResponseSchema = z.object({
  ok: z.literal(true),
  granted: z.boolean(),
  alreadyGranted: z.boolean(),
  pointsAwarded: z.number().int().positive(),
});
