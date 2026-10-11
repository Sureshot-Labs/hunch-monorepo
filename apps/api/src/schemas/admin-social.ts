import { z } from "zod";

const uuid = z.string().uuid();
export const adminSocialTargetSchema = z
  .object({
    kind: z.enum(["user", "thesis", "comment"]),
    id: uuid,
  })
  .strict();
export type AdminSocialTarget = z.infer<typeof adminSocialTargetSchema>;
export const adminSocialActionSchema = z.enum([
  "hide",
  "unhide",
  "suspend",
  "unsuspend",
]);
export type AdminSocialAction = z.infer<typeof adminSocialActionSchema>;
const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
export const adminSocialReportsQuerySchema = pageQuery
  .extend({ status: z.enum(["open", "resolved"]).default("open") })
  .strict();
export const adminSocialEventsQuerySchema = pageQuery
  .extend({
    targetKind: adminSocialTargetSchema.shape.kind.optional(),
    targetId: uuid.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.targetKind === undefined) === (value.targetId === undefined),
    { message: "targetKind and targetId must be provided together" },
  );
export const adminSocialModerationBodySchema = z
  .object({
    target: adminSocialTargetSchema,
    action: adminSocialActionSchema,
    reason: z.string(),
    reportId: uuid.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.target.kind === "user"
        ? value.action === "suspend" || value.action === "unsuspend"
        : value.action === "hide" || value.action === "unhide",
    { message: "Action does not match target kind", path: ["action"] },
  );
export const adminSocialReportParamsSchema = z.object({ id: uuid });
export const adminSocialResolveBodySchema = z
  .object({ reason: z.string() })
  .strict();
export const adminSocialTargetPreviewSchema = z.object({
  text: z.string().nullable(),
  authorUserId: uuid.nullable(),
  moderationHidden: z.boolean(),
  authorHidden: z.boolean(),
  proofInvalidated: z.boolean(),
  socialSuspended: z.boolean(),
});
export const adminSocialReportSchema = z.object({
  id: uuid,
  target: adminSocialTargetSchema,
  reporterUserId: uuid.nullable(),
  reason: z.string(),
  status: z.enum(["open", "resolved"]),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  targetPreview: adminSocialTargetPreviewSchema.nullable(),
});
export const adminSocialEventSchema = z.object({
  id: uuid,
  target: adminSocialTargetSchema,
  action: z.enum(["hide", "unhide", "suspend", "unsuspend", "resolve_report"]),
  reason: z.string(),
  adminId: uuid.nullable(),
  reportId: uuid.nullable(),
  createdAt: z.string(),
});
export const adminSocialReportsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(adminSocialReportSchema),
  nextCursor: z.string().nullable(),
});
export const adminSocialEventsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(adminSocialEventSchema),
  nextCursor: z.string().nullable(),
});
export const adminSocialMutationResponseSchema = z.object({
  ok: z.literal(true),
  event: adminSocialEventSchema,
});
export const adminSocialErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
