import { z } from "zod";

const feePolicyVenueSchema = z.enum(["polymarket", "kalshi", "limitless"]);
const adminCursorSchema = z.string().trim().min(1).max(2000);
const adminPageLimitSchema = z.coerce.number().int().min(1).max(100);
const adminQueryBooleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return value;
}, z.boolean());

export const adminFeePolicySchema = z.object({
  venue: feePolicyVenueSchema,
  feeBps: z.coerce.number().int().min(0).max(10_000),
  feeScale: z.coerce.number().min(0).max(10_000).optional(),
  polymarketBuilderCode: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional()
    .or(z.literal("")),
  polymarketBuilderTakerFeeBps: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .optional(),
  polymarketBuilderMakerFeeBps: z.coerce
    .number()
    .int()
    .min(0)
    .max(50)
    .optional(),
  limitlessFeeShareBps: z.coerce.number().int().min(0).max(10_000).optional(),
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

export const adminRewardsPolicySchema = z
  .object({
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
  })
  .superRefine((value, ctx) => {
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
    globalMultiplierLabel: z.string().trim().max(120).nullable().optional(),
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
  limit: adminPageLimitSchema.optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const adminRewardsMultiplierOverrideSchema = z
  .object({
    userId: z.string().uuid().optional(),
    walletAddress: z.string().trim().min(1).optional(),
    multiplier: multiplierValueSchema,
    label: z.string().trim().max(120).nullable().optional(),
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

export const adminReferralCodesQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  policyType: z.enum(["user", "campaign"]).optional(),
  active: adminQueryBooleanSchema.optional(),
  usageLimit: z.enum(["limited", "unlimited"]).optional(),
  limit: adminPageLimitSchema.optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const referralCodePolicyNumberSchema = z.coerce
  .number()
  .finite()
  .min(0)
  .optional();

export const adminReferralCodeCampaignCreateSchema = z.object({
  code: z.string().trim().min(3).max(10),
  label: z.string().trim().min(1).max(120).optional(),
  multiplierOverride: z.coerce.number().positive().finite().optional(),
  visibleDropPoints: referralCodePolicyNumberSchema,
  tierDropPoints: referralCodePolicyNumberSchema,
  maxUses: z.coerce.number().int().positive().optional(),
});

export const adminReferralCodeParamsSchema = z.object({
  id: z.string().uuid(),
});

export const adminReferralCodeByCodeParamsSchema = z.object({
  code: z.string().trim().min(1).max(120),
});

export const adminReferralCodeReferralsQuerySchema = z.object({
  limit: adminPageLimitSchema.optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const adminFeeLedgerSourceTypeSchema = z.enum(["order", "execution"]);
const adminFeeLedgerRewardKindSchema = z.enum(["any", "cashback", "referral"]);

export const adminFeeLedgerQuerySchema = z.object({
  q: z.string().trim().min(1).max(500).optional(),
  venue: feePolicyVenueSchema.optional(),
  chainId: z.string().trim().min(1).max(80).optional(),
  status: z.string().trim().min(1).max(80).optional(),
  userId: z.string().uuid().optional(),
  wallet: z.string().trim().min(1).max(160).optional(),
  orderId: z.string().uuid().optional(),
  orderHash: z.string().trim().min(1).max(200).optional(),
  venueOrderId: z.string().trim().min(1).max(200).optional(),
  txHash: z.string().trim().min(1).max(200).optional(),
  feeEventId: z.string().uuid().optional(),
  sourceId: z.string().trim().min(1).max(500).optional(),
  sourceType: adminFeeLedgerSourceTypeSchema.optional(),
  feeProgram: z.string().trim().min(1).max(120).optional(),
  tokenId: z.string().trim().min(1).max(220).optional(),
  marketId: z.string().trim().min(1).max(220).optional(),
  referralCode: z.string().trim().min(1).max(120).optional(),
  referralCodeId: z.string().uuid().optional(),
  referralPolicyId: z.string().uuid().optional(),
  referrerUserId: z.string().uuid().optional(),
  referredUserId: z.string().uuid().optional(),
  rewardKind: adminFeeLedgerRewardKindSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: adminPageLimitSchema.optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const adminFeeLedgerDetailParamsSchema = z.object({
  id: z.string().uuid(),
});

export const adminReferralCodeFeeEventsQuerySchema =
  adminFeeLedgerQuerySchema.omit({
    referralCode: true,
    referralCodeId: true,
    referralPolicyId: true,
  });

export const adminReferralCodeUpdateSchema = z.object({
  label: z.string().trim().min(1).max(120).nullable().optional(),
  multiplierOverride: z.coerce
    .number()
    .positive()
    .finite()
    .nullable()
    .optional(),
  visibleDropPoints: referralCodePolicyNumberSchema,
  tierDropPoints: referralCodePolicyNumberSchema,
  maxUses: z.coerce.number().int().positive().nullable().optional(),
  deactivate: z.coerce.boolean().optional(),
  reactivate: z.coerce.boolean().optional(),
});

export const adminUsersQuerySchema = z.object({
  cursor: adminCursorSchema.optional(),
  q: z.string().trim().min(1).optional(),
  limit: adminPageLimitSchema.optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const adminUserParamsSchema = z.object({
  id: z.string().uuid(),
});

export const adminUserActivityQuerySchema = z.object({
  cursor: adminCursorSchema.optional(),
  limit: adminPageLimitSchema.optional(),
});

export const adminUserAnalyticsRangeSchema = z.enum([
  "24h",
  "7d",
  "30d",
  "90d",
  "1y",
  "all",
]);

export const adminUserAnalyticsQuerySchema = z.object({
  cursor: adminCursorSchema.optional(),
  limit: adminPageLimitSchema.optional(),
  range: adminUserAnalyticsRangeSchema.optional(),
});

const adminAnalyticsOriginSchema = z.enum(["backend", "browser"]);
const adminAnalyticsOutcomeSchema = z.enum([
  "action",
  "failure",
  "success",
  "timeout",
]);

export const adminAnalyticsRangeQuerySchema = z.object({
  range: adminUserAnalyticsRangeSchema.optional(),
});

export const adminAnalyticsEventsQuerySchema = z.object({
  cursor: adminCursorSchema.optional(),
  domain: z.string().trim().min(1).max(80).optional(),
  eventName: z.string().trim().min(1).max(120).optional(),
  limit: adminPageLimitSchema.optional(),
  origin: adminAnalyticsOriginSchema.optional(),
  outcome: adminAnalyticsOutcomeSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  range: adminUserAnalyticsRangeSchema.optional(),
  source: z.string().trim().min(1).max(120).optional(),
  status: z.string().trim().min(1).max(120).optional(),
  userId: z.string().uuid().optional(),
  venue: z.string().trim().min(1).max(120).optional(),
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
  code: z.string().trim().min(3).max(10),
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

export const adminUserPrivyBindGrantSchema = z
  .object({
    userId: z.string().uuid().optional(),
    walletAddress: z.string().min(1).optional(),
    expiresInHours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
    note: z.string().trim().max(500).optional(),
    clear: z.coerce.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.userId && !value.walletAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide userId or walletAddress",
      });
    }
    if (!value.clear && value.expiresInHours == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresInHours"],
        message: "Provide expiresInHours unless clear is true",
      });
    }
  });

export const adminPointsSchema = z
  .object({
    userId: z.string().uuid().optional(),
    walletAddress: z.string().min(1).optional(),
    amount: z.coerce.number().finite().positive(),
    sourceType: z.enum(["order", "execution"]).optional(),
    venue: z.string().min(1).optional(),
    visible: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.userId && !value.walletAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide userId or walletAddress",
      });
    }
  });

export const adminManualPointsQuerySchema = z
  .object({
    cursor: adminCursorSchema.optional(),
    userId: z.string().uuid().optional(),
    walletAddress: z.string().min(1).optional(),
    limit: adminPageLimitSchema.optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.userId && !value.walletAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide userId or walletAddress",
      });
    }
  });

export const adminManualPointsParamsSchema = z.object({
  id: z.string().uuid(),
});

export const adminRewardsTreasuryQuerySchema = z.object({
  chainId: z.string().trim().min(1).optional(),
});

export const adminIntelPolicyKeySchema = z.enum([
  "auth_access",
  "wallet_intel_signals",
  "wallet_intel_refresh",
  "wallet_intel_attribution",
  "ai_whale_profiles",
  "ai_clusters",
  "api_cache_warm",
  "market_map",
  "map_search",
  "map_signals",
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
export type AdminUserAnalyticsQuery = z.infer<
  typeof adminUserAnalyticsQuerySchema
>;
export type AdminUserAdminBody = z.infer<typeof adminUserAdminSchema>;
export type AdminUserActiveBody = z.infer<typeof adminUserActiveSchema>;
export type AdminUserKalshiProofBypassBody = z.infer<
  typeof adminUserKalshiProofBypassSchema
>;
export type AdminUserMergeBody = z.infer<typeof adminUserMergeSchema>;
export type AdminUserPrivyBindGrantBody = z.infer<
  typeof adminUserPrivyBindGrantSchema
>;
export type AdminIntelPolicyParams = z.infer<
  typeof adminIntelPolicyParamsSchema
>;
export type AdminIntelPolicyBody = z.infer<typeof adminIntelPolicyBodySchema>;
export type AdminPointsBody = z.infer<typeof adminPointsSchema>;
export type AdminRewardsTreasuryQuery = z.infer<
  typeof adminRewardsTreasuryQuerySchema
>;
