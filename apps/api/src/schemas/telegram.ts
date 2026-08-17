import { z } from "zod";

export const telegramContextBodySchema = z.object({
  initDataRaw: z
    .string()
    .trim()
    .min(1)
    .max(8 * 1024),
});

export const telegramContextSuccessResponseSchema = z.object({
  ok: z.literal(true),
  telegram: z.object({
    authDate: z.string(),
    startParam: z.string().nullable().optional(),
    user: z.object({
      id: z.string(),
      firstName: z.string().nullable().optional(),
      lastName: z.string().nullable().optional(),
      username: z.string().nullable().optional(),
      photoUrl: z.string().nullable().optional(),
    }),
  }),
});

export const telegramContextErrorResponseSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
});

const telegramAppHandoffTokenSchema = z
  .string()
  .trim()
  .regex(/^th1_[A-Za-z0-9_-]{43}$/);

export const telegramAppHandoffRequestSchema = z
  .object({
    initDataRaw: z
      .string()
      .trim()
      .min(1)
      .max(8 * 1024),
    token: telegramAppHandoffTokenSchema,
  })
  .strict();

export const telegramAppHandoffCommitRequestSchema =
  telegramAppHandoffRequestSchema
    .extend({
      planFingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
    })
    .strict();

export const telegramAppHandoffResponseSchema = z.object({
  handoff: z.object({
    authorityFingerprint: z.string(),
    cancelledAt: z.string().nullable(),
    claimedAt: z.string().nullable(),
    committedAt: z.string().nullable(),
    expiresAt: z.string(),
    expiredAt: z.string().nullable(),
    id: z.string().uuid(),
    planFingerprint: z.string(),
    planSnapshot: z.record(z.string(), z.unknown()),
    policyRevision: z.string(),
    quoteSnapshot: z.record(z.string(), z.unknown()),
    state: z.enum(["issued", "claimed", "committed", "cancelled", "expired"]),
    tradeIntentId: z.string().uuid(),
  }),
});

export const telegramGroupMembershipStateSchema = z.enum([
  "member",
  "not_member",
  "telegram_not_linked",
  "unavailable",
]);

export const telegramGroupMembershipResponseSchema = z.object({
  cached: z.boolean(),
  checkedAt: z.string(),
  state: telegramGroupMembershipStateSchema,
});
