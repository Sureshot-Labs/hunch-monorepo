import { createHash } from "node:crypto";
import { z } from "zod";
import type { DbQuery } from "../db.js";

const count = z.number().int().positive().max(1_000_000);
const seconds = z.number().int().nonnegative().max(31_536_000);
const socialPolicyFields = {
  version: z.literal(1),
  enabled: z.boolean(),
  publicationsEnabled: z.boolean(),
  copyEnabled: z.boolean(),
  commentsEnabled: z.boolean(),
  likesEnabled: z.boolean(),
  minimumNotionalUsd: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/)
    .refine((v) => /[1-9]/.test(v), "Must be positive"),
  thesisMaxGraphemes: count,
  commentMaxGraphemes: count,
  bioMaxGraphemes: count,
  displayNameMaxGraphemes: count,
  handleMinLength: count,
  handleMaxLength: count,
  handleCooldownSeconds: seconds,
  pageSize: count,
  maxPageSize: count.max(1_000),
  avatarMaxBytes: z.number().int().positive().max(500_000_000),
  profileStatsWindowDays: count.nullable(),
  profileStatsMinResolved: count,
  markMaxAgeSeconds: seconds.refine((v) => v > 0),
  rateLimitWindowSeconds: seconds.refine((v) => v > 0),
  writeRateLimit: count,
  commentRateLimit: count,
  likeRateLimit: count,
  reportRateLimit: count,
  avatarRateLimit: count,
  reportMaxGraphemes: count,
  moderationReasonMaxGraphemes: count,
  repairEnabled: z.boolean(),
  repairBatchSize: count.max(1_000),
  repairConcurrency: count.max(20),
  repairIntervalSeconds: seconds.refine((v) => v > 0),
  repairLeaseSeconds: seconds.refine((v) => v > 0),
  repairRetrySeconds: seconds.refine((v) => v > 0),
  repairMaxRetrySeconds: seconds.refine((v) => v > 0),
  repairProviderRequestBudget: count,
};

export const socialPolicySchema = z
  .object(socialPolicyFields)
  .strict()
  .superRefine((policy, ctx) => {
    for (const [left, right] of [
      ["handleMinLength", "handleMaxLength"],
      ["pageSize", "maxPageSize"],
      ["repairRetrySeconds", "repairMaxRetrySeconds"],
    ] as const) {
      if (policy[left] > policy[right])
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [left],
          message: `Must not exceed ${right}`,
        });
    }
  });
export type SocialPolicy = z.infer<typeof socialPolicySchema>;
export const DEFAULT_SOCIAL_POLICY: Readonly<SocialPolicy> = Object.freeze({
  version: 1,
  enabled: true,
  publicationsEnabled: true,
  copyEnabled: true,
  commentsEnabled: true,
  likesEnabled: true,
  minimumNotionalUsd: "10.00",
  thesisMaxGraphemes: 450,
  commentMaxGraphemes: 450,
  bioMaxGraphemes: 160,
  displayNameMaxGraphemes: 80,
  handleMinLength: 3,
  handleMaxLength: 20,
  handleCooldownSeconds: 0,
  pageSize: 20,
  maxPageSize: 50,
  avatarMaxBytes: 5_000_000,
  profileStatsWindowDays: null,
  profileStatsMinResolved: 1,
  markMaxAgeSeconds: 900,
  rateLimitWindowSeconds: 60,
  writeRateLimit: 60,
  commentRateLimit: 20,
  likeRateLimit: 120,
  reportRateLimit: 10,
  avatarRateLimit: 5,
  reportMaxGraphemes: 1_000,
  moderationReasonMaxGraphemes: 1_000,
  repairEnabled: true,
  repairBatchSize: 50,
  repairConcurrency: 2,
  repairIntervalSeconds: 30,
  repairLeaseSeconds: 120,
  repairRetrySeconds: 30,
  repairMaxRetrySeconds: 3_600,
  repairProviderRequestBudget: 100,
});

/** Validate the entire resulting policy, not merely independent override fields. */
export const socialPolicyOverrideSchema = z
  .object(socialPolicyFields)
  .strict()
  .partial()
  .superRefine((override, ctx) => {
    const full = socialPolicySchema.safeParse({
      ...DEFAULT_SOCIAL_POLICY,
      ...override,
    });
    if (!full.success)
      for (const issue of full.error.issues)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issue.path,
          message: issue.message,
        });
  });

export class SocialPolicyUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "social_policy_unavailable";
  constructor() {
    super("Social policy is temporarily unavailable; retry this operation.");
  }
}

export function mergeSocialPolicy(override: unknown): SocialPolicy {
  const parsed = socialPolicyOverrideSchema.parse(override);
  return socialPolicySchema.parse({ ...DEFAULT_SOCIAL_POLICY, ...parsed });
}

export function buildSocialPolicyRevision(policy: SocialPolicy): string {
  return createHash("sha256")
    .update(JSON.stringify(socialPolicySchema.parse(policy)))
    .digest("hex")
    .slice(0, 16);
}

export type ResolvedSocialPolicy = {
  policy: SocialPolicy;
  revision: string;
  source: "default" | "db";
  effectiveAt: string | null;
};

/** Deliberately uncached: publish eligibility must use the current effective revision. */
export async function resolveSocialPolicy(
  db: DbQuery,
): Promise<ResolvedSocialPolicy> {
  try {
    const { rows } = await db.query<{
      payload: unknown;
      effective_at: Date | string;
    }>(
      `select payload,effective_at from runtime_policies where policy_key=$1 and effective_at<=now()
       order by effective_at desc,created_at desc limit 1`,
      ["social"],
    );
    const row = rows[0];
    const policy = row
      ? mergeSocialPolicy(row.payload)
      : socialPolicySchema.parse(DEFAULT_SOCIAL_POLICY);
    return {
      policy,
      revision: buildSocialPolicyRevision(policy),
      source: row ? "db" : "default",
      effectiveAt: row ? new Date(row.effective_at).toISOString() : null,
    };
  } catch {
    // A missing/invalid row is different from a successful query returning no override.
    throw new SocialPolicyUnavailableError();
  }
}
