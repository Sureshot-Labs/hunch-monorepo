import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import * as schema from "../schemas/social.js";
import { SocialService } from "../services/social-service.js";
import { getCopyAttributionStatus } from "../services/social-copy.js";
import {
  resolveSocialPolicy,
  socialPolicySchema,
  SocialPolicyUnavailableError,
} from "../services/social-policy.js";
import { SocialError } from "../services/social-primitives.js";

const errors = {
  400: schema.socialErrorSchema,
  401: schema.socialErrorSchema,
  403: schema.socialErrorSchema,
  404: schema.socialErrorSchema,
  409: schema.socialErrorSchema,
  429: schema.socialErrorSchema,
  500: schema.socialErrorSchema,
  503: schema.socialErrorSchema,
};
const idResponse = z.object({ id: z.string().uuid() });
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
  const configResponse = z.object({
    policy: socialPolicySchema,
    revision: z.string(),
    source: z.enum(["default", "db"]),
    effectiveAt: z.string().nullable(),
  });
  typed.get(
    "/social/config",
    { schema: { response: { 200: configResponse, ...errors } } },
    async () => resolveSocialPolicy(pool),
  );
  typed.get(
    "/social/copies/:idempotencyKey",
    {
      preHandler: required,
      schema: {
        params: schema.socialCopyStatusParams,
        response: { 200: schema.socialCopyStatusResponse, ...errors },
      },
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
      schema: {
        params: schema.socialHandleParams,
        response: { 200: schema.socialHandleResponse, ...errors },
      },
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
      schema: {
        params: schema.socialHandleParams,
        response: { 200: schema.socialProfileResponse, ...errors },
      },
    },
    async (request) =>
      service.profileByHandle(request.user?.id ?? null, request.params.handle),
  );
  typed.get(
    "/users/suggestions",
    {
      preHandler: optional,
      schema: {
        querystring: schema.socialPageQuery,
        response: { 200: schema.socialProfilesResponse, ...errors },
      },
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
      schema: {
        querystring: schema.socialPageQuery,
        response: { 200: schema.socialProfilesResponse, ...errors },
      },
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
      schema: {
        body: schema.socialProfilePatch,
        response: { 200: schema.socialProfileResponse, ...errors },
      },
    },
    async (request) =>
      service.updateProfile(requireUserId(request), request.body),
  );
  typed.get(
    "/users/:id/profile",
    {
      preHandler: optional,
      schema: {
        params: schema.socialIdParams,
        response: { 200: schema.socialProfileResponse, ...errors },
      },
    },
    async (request) =>
      service.getProfile(request.user?.id ?? null, request.params.id),
  );
  for (const kind of ["followers", "following"] as const)
    typed.get(
      `/users/:id/${kind}`,
      {
        preHandler: optional,
        schema: {
          params: schema.socialIdParams,
          querystring: schema.socialPageQuery,
          response: { 200: schema.socialProfilesResponse, ...errors },
        },
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
      schema: {
        params: schema.socialIdParams,
        response: { 200: schema.socialOkSchema, ...errors },
      },
    },
    async (request) =>
      service.setFollow(requireUserId(request), request.params.id, true),
  );
  typed.delete(
    "/users/:id/follow",
    {
      preHandler: required,
      schema: {
        params: schema.socialIdParams,
        response: { 200: schema.socialOkSchema, ...errors },
      },
    },
    async (request) =>
      service.setFollow(requireUserId(request), request.params.id, false),
  );
  typed.put(
    "/users/:id/block",
    {
      preHandler: required,
      schema: {
        params: schema.socialIdParams,
        response: { 200: schema.socialOkSchema, ...errors },
      },
    },
    async (request) =>
      service.setBlock(requireUserId(request), request.params.id, true),
  );
  typed.delete(
    "/users/:id/block",
    {
      preHandler: required,
      schema: {
        params: schema.socialIdParams,
        response: { 200: schema.socialOkSchema, ...errors },
      },
    },
    async (request) =>
      service.setBlock(requireUserId(request), request.params.id, false),
  );
  typed.get(
    "/theses/eligibility",
    {
      preHandler: required,
      schema: {
        querystring: schema.socialEligibilityQuery,
        response: { 200: schema.socialEligibilitySchema, ...errors },
      },
    },
    async (request) =>
      service.eligibility(requireUserId(request), request.query),
  );
  typed.post(
    "/theses/eligibility/refresh",
    {
      preHandler: required,
      schema: {
        body: schema.socialPurchaseRef,
        response: { 200: schema.socialOkSchema, ...errors },
      },
    },
    async (request) =>
      service.refreshEligibility(requireUserId(request), request.body),
  );
  // Idempotency replay is resolved inside the service before current policy checks.
  typed.post(
    "/theses",
    {
      preHandler: required,
      schema: {
        body: schema.socialPublishBody,
        response: { 200: schema.socialThesisSchema, ...errors },
      },
    },
    async (request) => service.publish(requireUserId(request), request.body),
  );
  typed.get(
    "/theses/:id",
    {
      preHandler: optional,
      schema: {
        params: schema.socialIdParams,
        response: { 200: schema.socialThesisSchema, ...errors },
      },
    },
    async (request) =>
      service.getThesis(request.user?.id ?? null, request.params.id, true),
  );
  typed.delete(
    "/theses/:id",
    {
      preHandler: required,
      schema: {
        params: schema.socialIdParams,
        response: { 200: schema.socialOkSchema, ...errors },
      },
    },
    async (request) =>
      service.hideThesis(requireUserId(request), request.params.id),
  );
  typed.get(
    "/social/feed",
    {
      preHandler: optional,
      schema: {
        querystring: schema.socialFeedQuery,
        response: { 200: schema.socialFeedResponse, ...errors },
      },
    },
    async (request) => service.feed(request.user?.id ?? null, request.query),
  );
  typed.get(
    "/users/:id/theses",
    {
      preHandler: optional,
      schema: {
        params: schema.socialIdParams,
        querystring: schema.socialPageQuery,
        response: { 200: schema.socialFeedResponse, ...errors },
      },
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
      schema: {
        params: z.object({ marketId: z.string() }),
        querystring: schema.socialPageQuery,
        response: { 200: schema.socialFeedResponse, ...errors },
      },
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
      schema: {
        querystring: schema.socialCommentsQuery,
        response: { 200: schema.socialCommentsResponse, ...errors },
      },
    },
    async (request) =>
      service.listComments(request.user?.id ?? null, request.query),
  );
  typed.post(
    "/social/comments",
    {
      preHandler: required,
      schema: {
        body: schema.socialCommentBody,
        response: { 200: idResponse, ...errors },
      },
    },
    async (request) =>
      service.createComment(requireUserId(request), request.body),
  );
  typed.delete(
    "/social/comments/:id",
    {
      preHandler: required,
      schema: {
        params: schema.socialIdParams,
        response: { 200: schema.socialOkSchema, ...errors },
      },
    },
    async (request) =>
      service.hideComment(requireUserId(request), request.params.id),
  );
  typed.post(
    "/social/reports",
    {
      preHandler: required,
      schema: {
        body: schema.socialReportBody,
        response: { 200: idResponse, ...errors },
      },
    },
    async (request) => service.report(requireUserId(request), request.body),
  );
};
