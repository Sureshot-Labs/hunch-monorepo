import { z } from "zod";

export const onboardingStepNames = [
  "interests",
  "handle",
  "photo",
  "passkey",
  "notifications",
  "traders",
] as const;
export const onboardingStepNameSchema = z.enum(onboardingStepNames);
export const onboardingStepResultSchema = z
  .object({
    status: z.enum(["pending", "completed", "skipped", "not_applicable"]),
    reason: z
      .enum([
        "user_skipped",
        "no_photo",
        "suggestions_unavailable",
        "feature_unavailable",
        "capability_unavailable",
        "insufficient_suggestions",
        "legacy_exempt",
        "profile_not_transferred",
      ])
      .nullable(),
  })
  .strict();
export const onboardingStepsSchema = z
  .object({
    interests: onboardingStepResultSchema,
    handle: onboardingStepResultSchema,
    photo: onboardingStepResultSchema,
    passkey: onboardingStepResultSchema,
    notifications: onboardingStepResultSchema,
    traders: onboardingStepResultSchema,
  })
  .strict();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const onboardingStateSchema = z
  .object({
    flowVersion: z.literal(1),
    revision,
    status: z.enum(["not_started", "in_progress", "completed"]),
    completionReason: z.enum(["flow", "legacy"]).nullable(),
    completedAt: z.string().datetime().nullable(),
    nextStep: onboardingStepNameSchema.nullable(),
    interestIds: z.array(z.string()),
    steps: onboardingStepsSchema,
  })
  .strict();
export const onboardingCatalogSchema = z.object({
  catalogVersion: z.literal(1),
  minSelections: z.literal(3),
  items: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      enabled: z.boolean(),
      sortOrder: z.number().int(),
    }),
  ),
});
export const onboardingInterestsBodySchema = z
  .object({
    expectedRevision: revision,
    outcome: z.enum(["completed", "skipped"]),
    interestIds: z.array(z.string()),
  })
  .strict();
export const onboardingProgressBodySchema = z
  .object({
    expectedRevision: revision,
    step: z.enum(["handle", "photo", "passkey", "notifications", "traders"]),
    outcome: z.enum(["completed", "skipped", "not_applicable"]),
    reason: z
      .enum([
        "user_skipped",
        "no_photo",
        "suggestions_unavailable",
        "feature_unavailable",
        "capability_unavailable",
        "insufficient_suggestions",
      ])
      .nullable()
      .optional(),
  })
  .strict();
export const onboardingCompleteBodySchema = z
  .object({ expectedRevision: revision })
  .strict();
export const onboardingErrorSchema = z.object({
  error: z.string(),
  onboarding: onboardingStateSchema.optional(),
});

export type OnboardingState = z.infer<typeof onboardingStateSchema>;
export type OnboardingStep = z.infer<typeof onboardingStepNameSchema>;
export type OnboardingStepResult = z.infer<typeof onboardingStepResultSchema>;
export type OnboardingInterestsInput = z.infer<
  typeof onboardingInterestsBodySchema
>;
export type OnboardingProgressInput = z.infer<
  typeof onboardingProgressBodySchema
>;
export type OnboardingCatalog = z.infer<typeof onboardingCatalogSchema>;
