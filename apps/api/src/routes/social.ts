import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { socialRouteSchemas } from "../schemas/social-routes.js";
import { SocialService } from "../services/social-service.js";
import { getCopyAttributionStatus } from "../services/social-copy.js";
import {
  resolveSocialPolicy,
  SocialPolicyUnavailableError,
} from "../services/social-policy.js";
import { SocialError } from "../services/social-primitives.js";

function requireUserId(request: FastifyRequest): string {
  if (!request.user) throw new SocialError("unauthorized", 401);
  return request.user.id;
}

export const socialRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service = new SocialService(
    pool,
    async (userId, policy, kind) => {
      const maximum =
        kind === "comment"
          ? policy.commentRateLimit
          : kind === "like"
            ? policy.likeRateLimit
            : kind === "report"
              ? policy.reportRateLimit
              : policy.writeRateLimit;
      if (
        !(await checkRateLimit(
          `social:${kind}:${userId}`,
          maximum,
          policy.rateLimitWindowSeconds * 1000,
          { onError: "fail_closed" },
        ))
      )
        throw new SocialError("rate_limit_exceeded", 429);
    },
    { limitlessPositionContract: env.limitlessConditionalTokensAddress },
  );
  const optional = createAuthMiddleware({ optional: true });
  const required = createAuthMiddleware();
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });
  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof SocialError ||
      error instanceof SocialPolicyUnavailableError
    )
      return reply.code(error.statusCode).send({ error: error.code });
    if (error && typeof error === "object" && "validation" in error)
      return reply.code(400).send({ error: "invalid_request" });
    request.log.error(
      {
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "unknown",
      },
      "Social request failed",
    );
    return reply.code(500).send({ error: "social_request_failed" });
  });
  typed.get(
    "/social/config",
    { schema: socialRouteSchemas.get["/social/config"] },
    async () => resolveSocialPolicy(pool),
  );
  typed.get(
    "/social/hunches/:id",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/social/hunches/:id"],
    },
    async (request) =>
      service.getHunch(request.user?.id ?? null, request.params.id),
  );
  typed.get(
    "/social/copies/:idempotencyKey",
    {
      preHandler: required,
      schema: socialRouteSchemas.get["/social/copies/:idempotencyKey"],
    },
    async (request) => {
      const result = await getCopyAttributionStatus(
        pool,
        requireUserId(request),
        request.params.idempotencyKey,
      );
      if (!result) throw new SocialError("copy_not_found", 404);
      return result;
    },
  );
  typed.get(
    "/users/handles/:handle",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/users/handles/:handle"],
    },
    async (request) =>
      service.handleAvailability(
        request.user?.id ?? null,
        request.params.handle,
      ),
  );
  typed.get(
    "/users/by-handle/:handle",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/users/by-handle/:handle"],
    },
    async (request) =>
      service.profileByHandle(request.user?.id ?? null, request.params.handle),
  );
  typed.get(
    "/users/suggestions",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/users/suggestions"],
    },
    async (request) =>
      service.listProfiles(request.user?.id ?? null, {
        ...request.query,
        kind: "suggestions",
      }),
  );
  typed.get(
    "/users/me/blocks",
    {
      preHandler: required,
      schema: socialRouteSchemas.get["/users/me/blocks"],
    },
    async (request) =>
      service.listProfiles(requireUserId(request), {
        ...request.query,
        kind: "blocked",
      }),
  );
  typed.patch(
    "/users/me/profile",
    {
      preHandler: required,
      schema: socialRouteSchemas.patch["/users/me/profile"],
    },
    async (request) =>
      service.updateProfile(requireUserId(request), request.body),
  );
  typed.get(
    "/users/:id/profile",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/users/:id/profile"],
    },
    async (request) =>
      service.getProfile(request.user?.id ?? null, request.params.id),
  );
  for (const kind of ["followers", "following"] as const)
    typed.get(
      `/users/:id/${kind}`,
      {
        preHandler: optional,
        schema: socialRouteSchemas.get[`/users/:id/${kind}`],
      },
      async (request) =>
        service.listProfiles(request.user?.id ?? null, {
          ...request.query,
          kind,
          userId: request.params.id,
        }),
    );
  typed.put(
    "/users/:id/follow",
    {
      preHandler: required,
      schema: socialRouteSchemas.put["/users/:id/follow"],
    },
    async (request) =>
      service.setFollow(requireUserId(request), request.params.id, true),
  );
  typed.delete(
    "/users/:id/follow",
    {
      preHandler: required,
      schema: socialRouteSchemas.delete["/users/:id/follow"],
    },
    async (request) =>
      service.setFollow(requireUserId(request), request.params.id, false),
  );
  typed.put(
    "/users/:id/block",
    {
      preHandler: required,
      schema: socialRouteSchemas.put["/users/:id/block"],
    },
    async (request) =>
      service.setBlock(requireUserId(request), request.params.id, true),
  );
  typed.delete(
    "/users/:id/block",
    {
      preHandler: required,
      schema: socialRouteSchemas.delete["/users/:id/block"],
    },
    async (request) =>
      service.setBlock(requireUserId(request), request.params.id, false),
  );
  typed.get(
    "/theses/eligibility",
    {
      preHandler: required,
      schema: socialRouteSchemas.get["/theses/eligibility"],
    },
    async (request) =>
      service.eligibility(requireUserId(request), request.query),
  );
  typed.post(
    "/theses/eligibility/refresh",
    {
      preHandler: required,
      schema: socialRouteSchemas.post["/theses/eligibility/refresh"],
    },
    async (request) =>
      service.refreshEligibility(requireUserId(request), request.body),
  );
  // Idempotency replay is resolved inside the service before current policy checks.
  typed.post(
    "/theses",
    {
      preHandler: required,
      schema: socialRouteSchemas.post["/theses"],
    },
    async (request) => service.publish(requireUserId(request), request.body),
  );
  typed.get(
    "/theses/:id",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/theses/:id"],
    },
    async (request) =>
      service.getThesis(request.user?.id ?? null, request.params.id, true),
  );
  typed.delete(
    "/theses/:id",
    {
      preHandler: required,
      schema: socialRouteSchemas.delete["/theses/:id"],
    },
    async (request) =>
      service.hideThesis(requireUserId(request), request.params.id),
  );
  typed.get(
    "/social/feed",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/social/feed"],
    },
    async (request) => service.feed(request.user?.id ?? null, request.query),
  );
  typed.get(
    "/users/:id/theses",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/users/:id/theses"],
    },
    async (request) =>
      service.feed(request.user?.id ?? null, {
        ...request.query,
        mode: "all",
        source: "thesis",
        authorId: request.params.id,
      }),
  );
  typed.get(
    "/markets/:marketId/theses",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/markets/:marketId/theses"],
    },
    async (request) =>
      service.feed(request.user?.id ?? null, {
        ...request.query,
        mode: "all",
        source: "thesis",
        marketId: request.params.marketId,
      }),
  );
  typed.get(
    "/social/comments",
    {
      preHandler: optional,
      schema: socialRouteSchemas.get["/social/comments"],
    },
    async (request) =>
      service.listComments(request.user?.id ?? null, request.query),
  );
  typed.put(
    "/social/likes/:targetKind/:targetId",
    {
      preHandler: required,
      schema: socialRouteSchemas.put["/social/likes/:targetKind/:targetId"],
    },
    async (request) =>
      service.setLike(
        requireUserId(request),
        { kind: request.params.targetKind, id: request.params.targetId },
        true,
      ),
  );
  typed.delete(
    "/social/likes/:targetKind/:targetId",
    {
      preHandler: required,
      schema: socialRouteSchemas.delete["/social/likes/:targetKind/:targetId"],
    },
    async (request) =>
      service.setLike(
        requireUserId(request),
        { kind: request.params.targetKind, id: request.params.targetId },
        false,
      ),
  );
  typed.post(
    "/social/comments",
    {
      preHandler: required,
      schema: socialRouteSchemas.post["/social/comments"],
    },
    async (request) =>
      service.createComment(requireUserId(request), request.body),
  );
  typed.delete(
    "/social/comments/:id",
    {
      preHandler: required,
      schema: socialRouteSchemas.delete["/social/comments/:id"],
    },
    async (request) =>
      service.hideComment(requireUserId(request), request.params.id),
  );
  typed.post(
    "/social/reports",
    {
      preHandler: required,
      schema: socialRouteSchemas.post["/social/reports"],
    },
    async (request) => service.report(requireUserId(request), request.body),
  );
};
