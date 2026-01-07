import { z } from "zod";

const feePolicyVenueSchema = z.enum(["polymarket", "kalshi"]);

export const adminFeePolicySchema = z.object({
  venue: feePolicyVenueSchema,
  feeBps: z.coerce.number().int().min(0).max(10_000),
  feeScale: z.coerce.number().min(0).max(10_000).optional(),
  effectiveAt: z.string().datetime().optional(),
});

export const adminRewardsPolicySchema = z.object({
  effectiveAt: z.string().datetime().optional(),
  tiers: z
    .array(
      z.object({
        tier: z.coerce.number().int().min(0),
        name: z.string().min(1),
        points: z.coerce.number().min(0),
        cashbackBps: z.coerce.number().int().min(0).max(10_000),
      }),
    )
    .min(1),
  referralBonus: z
    .array(
      z.object({
        minReferrals: z.coerce.number().int().min(0),
        bonusBps: z.coerce.number().int().min(0).max(10_000),
      }),
    )
    .min(1),
});

export const adminPointsSchema = z
  .object({
    userId: z.string().uuid().optional(),
    walletAddress: z.string().min(1).optional(),
    amount: z.coerce.number().finite().positive(),
    sourceId: z.string().min(1).optional(),
    sourceType: z.enum(["order", "execution"]).optional(),
    venue: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.userId && !value.walletAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide userId or walletAddress",
      });
    }
  });

export type AdminFeePolicyBody = z.infer<typeof adminFeePolicySchema>;
export type AdminRewardsPolicyBody = z.infer<typeof adminRewardsPolicySchema>;
export type AdminPointsBody = z.infer<typeof adminPointsSchema>;
