import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import * as schema from "../schemas/onboarding.js";
import { OnboardingService } from "../services/onboarding-service.js";
import { OnboardingError } from "../services/onboarding-state.js";
import { SocialError } from "../services/social-primitives.js";
import {
  resolveSocialPolicy,
  SocialPolicyUnavailableError,
} from "../services/social-policy.js";

const errors = Object.fromEntries(
  [400, 401, 403, 409, 429, 500, 503].map((code) => [
    code,
    schema.onboardingErrorSchema,
  ]),
);
function userId(request: FastifyRequest): string {
  if (!request.user) throw new SocialError("unauthorized", 401);
  return request.user.id;
}

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service = new OnboardingService(pool, async (id) => {
    const { policy } = await resolveSocialPolicy(pool);
    if (
      !(await checkRateLimit(
        `onboarding:write:${id}`,
        policy.writeRateLimit,
        policy.rateLimitWindowSeconds * 1000,
        { onError: "fail_closed" },
      ))
    )
      throw new SocialError("rate_limit_exceeded", 429);
  });
  const required = createAuthMiddleware();
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof OnboardingError)
      return reply
        .code(error.statusCode)
        .send({ error: error.code, onboarding: error.onboarding });
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
      "Onboarding request failed",
    );
    return reply.code(500).send({ error: "onboarding_request_failed" });
  });
  typed.get(
    "/users/interests",
    {
      schema: {
        tags: ["Onboarding"],
        response: { 200: schema.onboardingCatalogSchema, ...errors },
      },
    },
    async () => service.catalog(),
  );
  typed.get(
    "/users/me/onboarding",
    {
      preHandler: required,
      schema: {
        tags: ["Onboarding"],
        response: { 200: schema.onboardingStateSchema, ...errors },
      },
    },
    async (request) => service.get(userId(request)),
  );
  typed.put(
    "/users/me/interests",
    {
      preHandler: required,
      schema: {
        tags: ["Onboarding"],
        body: schema.onboardingInterestsBodySchema,
        response: { 200: schema.onboardingStateSchema, ...errors },
      },
    },
    async (request) => service.setInterests(userId(request), request.body),
  );
  typed.patch(
    "/users/me/onboarding",
    {
      preHandler: required,
      schema: {
        tags: ["Onboarding"],
        body: schema.onboardingProgressBodySchema,
        response: { 200: schema.onboardingStateSchema, ...errors },
      },
    },
    async (request) => service.progress(userId(request), request.body),
  );
  typed.post(
    "/users/me/onboarding/complete",
    {
      preHandler: required,
      schema: {
        tags: ["Onboarding"],
        body: schema.onboardingCompleteBodySchema,
        response: { 200: schema.onboardingStateSchema, ...errors },
      },
    },
    async (request) =>
      service.complete(userId(request), request.body.expectedRevision),
  );
};
