import { z } from "zod";
import { zRequiredString } from "./common.js";

export const rewardsReferralsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const rewardsClaimBodySchema = z.object({
  chainId: zRequiredString("chainId is required"),
  walletAddress: z.string().trim().min(1).optional(),
  amount: z.coerce.number().positive().optional(),
});

export const rewardsLeaderboardQuerySchema = z.object({
  metric: z.enum(["points", "volume", "pnl"]).default("points"),
  interval: z
    .enum(["daily", "weekly", "monthly", "yearly", "alltime"])
    .default("alltime"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
