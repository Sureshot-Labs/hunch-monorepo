import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { DbQuery } from "../db.js";
import {
  adminSocialErrorSchema,
  adminSocialEventsQuerySchema,
  adminSocialEventsResponseSchema,
  adminSocialModerationBodySchema,
  adminSocialMutationResponseSchema,
  adminSocialReportParamsSchema,
  adminSocialReportsQuerySchema,
  adminSocialReportsResponseSchema,
  adminSocialResolveBodySchema,
} from "../schemas/admin-social.js";
import {
  listAdminSocialModerationEvents,
  listAdminSocialReports,
  moderateAdminSocialTarget,
  resolveAdminSocialLimits,
  resolveAdminSocialReport,
} from "../services/social-moderation.js";
import { SocialError } from "../services/social-primitives.js";

export type AdminSocialPermission = "users:read" | "users:write";
export type AdminSocialRouteDependencies = {
  db: DbQuery;
  authorize: (permission: AdminSocialPermission) => preHandlerHookHandler;
  transact: <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;
};
const errors = {
  400: adminSocialErrorSchema,
  401: adminSocialErrorSchema,
  403: adminSocialErrorSchema,
  404: adminSocialErrorSchema,
  409: adminSocialErrorSchema,
  503: adminSocialErrorSchema,
};

function adminId(request: FastifyRequest) {
  const id =
    request.adminAccount?.id ??
    (request.adminActor?.kind === "admin_account"
      ? request.adminActor.id
      : null);
  if (!id) throw new SocialError("admin_access_required", 401);
  return id;
}
function limits(db: DbQuery, request: FastifyRequest) {
  return resolveAdminSocialLimits(db, () =>
    request.log.warn(
      { recovery: "admin_moderation_limits" },
      "Social policy unavailable; using default administrative pagination/reason limits only",
    ),
  );
}
function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof SocialError) {
    const messages: Record<string, string> = {
      invalid_text_length: "Enter a reason within the configured length limit.",
      invalid_cursor: "This page cursor is invalid for the selected filters.",
      social_report_not_found: "This report no longer exists.",
      social_target_unavailable: "This target no longer exists.",
      social_report_target_mismatch:
        "The report refers to a different target. Refresh and review the target again.",
      social_action_target_mismatch:
        "This action is not supported for the selected target.",
      admin_access_required: "A human admin session is required.",
    };
    return reply.code(error.statusCode).send({
      error: error.code,
      message: messages[error.code] ?? error.message,
    });
  }
  // Do not echo database statements, report bodies or user content in HTTP errors.
  reply.log.error(
    {
      errorCode:
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "unknown",
    },
    "Social moderation operation failed",
  );
  return reply.code(503).send({
    error: "social_moderation_unavailable",
    message: "Social moderation is temporarily unavailable. Retry the request.",
  });
}

/** Dependencies keep the admin route contract testable without importing API-wide secrets. */
export function registerAdminSocialRoutes(
  app: FastifyInstance,
  dependencies: AdminSocialRouteDependencies,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    "/admin/social/reports",
    {
      preHandler: dependencies.authorize("users:read"),
      schema: {
        querystring: adminSocialReportsQuerySchema,
        response: { 200: adminSocialReportsResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        return reply.send({
          ok: true,
          ...(await listAdminSocialReports(
            dependencies.db,
            request.query,
            await limits(dependencies.db, request),
          )),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  api.get(
    "/admin/social/moderation-events",
    {
      preHandler: dependencies.authorize("users:read"),
      schema: {
        querystring: adminSocialEventsQuerySchema,
        response: { 200: adminSocialEventsResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        const input = {
          cursor: request.query.cursor,
          limit: request.query.limit,
          target:
            request.query.targetKind && request.query.targetId
              ? { kind: request.query.targetKind, id: request.query.targetId }
              : undefined,
        };
        return reply.send({
          ok: true,
          ...(await listAdminSocialModerationEvents(
            dependencies.db,
            input,
            await limits(dependencies.db, request),
          )),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  api.post(
    "/admin/social/moderation",
    {
      preHandler: dependencies.authorize("users:write"),
      schema: {
        body: adminSocialModerationBodySchema,
        response: { 200: adminSocialMutationResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        const actorId = adminId(request);
        // Resolve policy before opening the mutation transaction: a policy read failure must
        // not leave the recovery transaction aborted before its safe fallback is used.
        const resolvedLimits = await limits(dependencies.db, request);
        const result = await dependencies.transact((db) =>
          moderateAdminSocialTarget(db, request.body, actorId, resolvedLimits),
        );
        return reply.send({ ok: true, event: result });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
  api.post(
    "/admin/social/reports/:id/resolve",
    {
      preHandler: dependencies.authorize("users:write"),
      schema: {
        params: adminSocialReportParamsSchema,
        body: adminSocialResolveBodySchema,
        response: { 200: adminSocialMutationResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        const actorId = adminId(request);
        const resolvedLimits = await limits(dependencies.db, request);
        const result = await dependencies.transact((db) =>
          resolveAdminSocialReport(
            db,
            request.params.id,
            request.body.reason,
            actorId,
            resolvedLimits,
          ),
        );
        return reply.send({ ok: true, event: result });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
