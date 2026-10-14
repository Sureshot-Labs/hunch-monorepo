import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeFundingStageSchema = z.enum(["nonce_mapping", "send_asset"]);
/** Public signing instructions are rebuilt from the validated immutable pair.
 * This response schema is not permission to sign arbitrary provider data. */
export const nativeFundingPreparationSchema = z
  .object({
    version: z.literal(1),
    stage: nativeFundingStageSchema,
    expiresAt: z.string().datetime(),
    signer: z.string().regex(/^0x[a-f0-9]{40}$/),
    digest: z.string().regex(/^0x[a-f0-9]{64}$/),
    typedData: z
      .object({
        domain: z
          .object({
            name: z.string(),
            version: z.string(),
            chainId: z.number().int().positive(),
            verifyingContract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          })
          .strict(),
        types: z.record(
          z.string(),
          z.array(z.object({ name: z.string(), type: z.string() }).strict()),
        ),
        primaryType: z.string(),
        message: z.record(
          z.string(),
          z.union([z.string(), z.number().int().safe()]),
        ),
      })
      .strict(),
  })
  .strict();
export type NativeFundingPreparation = z.infer<
  typeof nativeFundingPreparationSchema
>;
const prepared = z.object({
  version: z.literal(1),
  stage: nativeFundingStageSchema,
  expiresAt: z.string().datetime(),
  pairFingerprint: digest,
  signer: z.string().regex(/^0x[a-f0-9]{40}$/),
  nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const nativeFundingSubmissionSchema = z.discriminatedUnion("phase", [
  prepared.extend({ phase: z.literal("prepared") }).strict(),
  prepared
    .extend({
      phase: z.literal("admitted"),
      admittedAt: z.string().datetime(),
      requestFingerprint: digest,
    })
    .strict(),
  prepared
    .extend({
      phase: z.literal("closed"),
      admittedAt: z.string().datetime().optional(),
      requestFingerprint: digest.optional(),
      reason: z.enum([
        "authorized",
        "authorization_unknown",
        "cancelled",
        "expired",
      ]),
    })
    .strict(),
]);
export type NativeFundingSubmission = z.infer<
  typeof nativeFundingSubmissionSchema
>;
export function parseNativeFundingSubmission(
  value: unknown,
): NativeFundingSubmission | null {
  const parsed = nativeFundingSubmissionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** This flag is derived from exact server-owned facts, never accepted from a
 * client report. Unknown mapping registration has no monetary side effect. */
export function nativeAuthRetryable(bound: boolean, value: unknown): boolean {
  const submission = parseNativeFundingSubmission(value);
  return (
    bound &&
    submission?.stage === "nonce_mapping" &&
    submission.phase === "closed" &&
    submission.reason === "authorization_unknown" &&
    Boolean(submission.admittedAt && submission.requestFingerprint)
  );
}
