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

const multiplierValueSchema = z.coerce.number().positive().finite();

export const adminRewardsMultiplierPolicySchema = z
  .object({
    effectiveAt: z.string().datetime().optional(),
    globalMultiplier: multiplierValueSchema,
    referralRules: z
      .array(
        z.object({
          minReferrals: z.coerce.number().int().min(0),
          multiplier: multiplierValueSchema,
        }),
      )
      .default([]),
    tierRules: z
      .array(
        z.object({
          minPoints: z.coerce.number().min(0),
          multiplier: multiplierValueSchema,
        }),
      )
      .default([]),
    notes: z.string().trim().max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    const referralThresholds = new Set<number>();
    for (const [index, rule] of value.referralRules.entries()) {
      if (referralThresholds.has(rule.minReferrals)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["referralRules", index, "minReferrals"],
          message: `Duplicate referral threshold: ${rule.minReferrals}`,
        });
      }
      referralThresholds.add(rule.minReferrals);
    }

    const tierThresholds = new Set<number>();
    for (const [index, rule] of value.tierRules.entries()) {
      if (tierThresholds.has(rule.minPoints)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tierRules", index, "minPoints"],
          message: `Duplicate tier threshold: ${rule.minPoints}`,
        });
      }
      tierThresholds.add(rule.minPoints);
    }
  });

export const adminRewardsMultiplierOverridesQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const adminRewardsMultiplierOverrideSchema = z
  .object({
    userId: z.string().uuid().optional(),
    walletAddress: z.string().trim().min(1).optional(),
    multiplier: multiplierValueSchema,
    reason: z.string().trim().max(500).optional(),
    effectiveAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.userId && !value.walletAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide userId or walletAddress",
      });
    }

    if (value.expiresAt) {
      const effectiveAt = value.effectiveAt
        ? Date.parse(value.effectiveAt)
        : Date.now();
      const expiresAt = Date.parse(value.expiresAt);
      if (
        Number.isFinite(effectiveAt) &&
        Number.isFinite(expiresAt) &&
        expiresAt <= effectiveAt
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expiresAt"],
          message: "expiresAt must be later than effectiveAt (or now)",
        });
      }
    }
  });

export const adminRewardsMultiplierOverrideParamsSchema = z.object({
  userId: z.string().uuid(),
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

export const adminUserKalshiProofBypassSchema = z.object({
  kalshiProofBypass: z.coerce.boolean(),
});

export const adminUserReferralCodeSchema = z.object({
  code: z.string().trim().min(1).max(32),
  forceTransfer: z.coerce.boolean().optional(),
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

export const adminRewardsTreasuryQuerySchema = z.object({
  chainId: z.string().trim().min(1).optional(),
});

export const adminIntelPolicyKeySchema = z.enum([
  "wallet_intel_signals",
  "wallet_intel_refresh",
  "wallet_intel_attribution",
  "ai_whale_profiles",
  "ai_clusters",
  "arbitrage_defaults",
]);

export const adminIntelPolicyParamsSchema = z.object({
  key: adminIntelPolicyKeySchema,
});

export const adminIntelPolicyBodySchema = z.object({
  effectiveAt: z.string().datetime().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export type AdminFeePolicyBody = z.infer<typeof adminFeePolicySchema>;
export type AdminDebridgeConfigBody = z.infer<typeof adminDebridgeConfigSchema>;
export type AdminRewardsPolicyBody = z.infer<typeof adminRewardsPolicySchema>;
export type AdminRewardsMultiplierPolicyBody = z.infer<
  typeof adminRewardsMultiplierPolicySchema
>;
export type AdminRewardsMultiplierOverridesQuery = z.infer<
  typeof adminRewardsMultiplierOverridesQuerySchema
>;
export type AdminRewardsMultiplierOverrideBody = z.infer<
  typeof adminRewardsMultiplierOverrideSchema
>;
export type AdminRewardsMultiplierOverrideParams = z.infer<
  typeof adminRewardsMultiplierOverrideParamsSchema
>;
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;
export type AdminUserParams = z.infer<typeof adminUserParamsSchema>;
export type AdminUserActivityQuery = z.infer<
  typeof adminUserActivityQuerySchema
>;
export type AdminUserAdminBody = z.infer<typeof adminUserAdminSchema>;
export type AdminUserActiveBody = z.infer<typeof adminUserActiveSchema>;
export type AdminUserKalshiProofBypassBody = z.infer<
  typeof adminUserKalshiProofBypassSchema
>;
export type AdminUserMergeBody = z.infer<typeof adminUserMergeSchema>;
export type AdminIntelPolicyParams = z.infer<typeof adminIntelPolicyParamsSchema>;
export type AdminIntelPolicyBody = z.infer<typeof adminIntelPolicyBodySchema>;
export type AdminPointsBody = z.infer<typeof adminPointsSchema>;
export type AdminRewardsTreasuryQuery = z.infer<
  typeof adminRewardsTreasuryQuerySchema
>;
