import { z } from "zod";

const feePolicyVenueSchema = z.enum(["polymarket", "kalshi"]);

export const adminFeePolicySchema = z.object({
  venue: feePolicyVenueSchema,
  feeBps: z.coerce.number().int().min(0).max(10_000),
  feeScale: z.coerce.number().min(0).max(10_000).optional(),
  effectiveAt: z.string().datetime().optional(),
});

export const adminDebridgeConfigSchema = z.object({
  dlnBase: z.string().url().optional(),
  statsBase: z.string().url().optional(),
  affiliateFeePercent: z.coerce.number().min(0).max(100).optional(),
  affiliateFeeRecipients: z.string().optional(),
  referralCode: z.coerce.number().int().min(0).optional(),
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
}).superRefine((value, ctx) => {
  const maxCashbackBps = Math.max(
    0,
    ...value.tiers.map((tier) => Number(tier.cashbackBps) || 0),
  );
  const maxReferralBps = Math.max(
    0,
    ...value.referralBonus.map((bonus) => Number(bonus.bonusBps) || 0),
  );
  if (maxCashbackBps + maxReferralBps > 10_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["referralBonus"],
      message:
        "Max cashback + referral bonus exceeds 100% of fees. Reduce referral bonus or cashback tiers.",
    });
  }
});

export const adminUsersQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const adminUserParamsSchema = z.object({
  id: z.string().uuid(),
});

export const adminUserActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const adminUserAdminSchema = z.object({
  isAdmin: z.coerce.boolean(),
});

export const adminUserActiveSchema = z.object({
  isActive: z.coerce.boolean(),
});

export const adminUserMergeSchema = z
  .object({
    sourceId: z.string().uuid().optional(),
    targetId: z.string().uuid().optional(),
    sourceWallet: z.string().min(1).optional(),
    targetWallet: z.string().min(1).optional(),
    dryRun: z.coerce.boolean().optional(),
    keepSource: z.coerce.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.sourceId && !value.sourceWallet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceId"],
        message: "Provide sourceId or sourceWallet",
      });
    }
    if (!value.targetId && !value.targetWallet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetId"],
        message: "Provide targetId or targetWallet",
      });
    }
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
export type AdminDebridgeConfigBody = z.infer<typeof adminDebridgeConfigSchema>;
export type AdminRewardsPolicyBody = z.infer<typeof adminRewardsPolicySchema>;
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;
export type AdminUserParams = z.infer<typeof adminUserParamsSchema>;
export type AdminUserActivityQuery = z.infer<
  typeof adminUserActivityQuerySchema
>;
export type AdminUserAdminBody = z.infer<typeof adminUserAdminSchema>;
export type AdminUserActiveBody = z.infer<typeof adminUserActiveSchema>;
export type AdminUserMergeBody = z.infer<typeof adminUserMergeSchema>;
export type AdminPointsBody = z.infer<typeof adminPointsSchema>;
