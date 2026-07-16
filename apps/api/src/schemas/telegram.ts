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
