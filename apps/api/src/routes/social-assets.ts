import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { configureContentServiceRuntime } from "../content-service-runtime.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import {
  contentAssetCreateBodySchema,
  contentAssetCompleteBodySchema,
} from "../schemas/content.js";
import {
  createContentAssetUpload,
  completeContentAssetUpload,
  deleteContentAsset,
  type ContentAsset,
} from "../services/content-assets.js";
import { userContentActor } from "../services/content-actor.js";
import { resolveSocialPolicy } from "../services/social-policy.js";
import { SocialError } from "../services/social-primitives.js";

const avatarSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "verifying", "ready", "failed", "deleted"]),
  url: z.string().nullable(),
  mimeType: z.string(),
  byteSize: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});
const assetParams = z.object({ id: z.string().uuid() });
const errors = {
  400: z.object({ error: z.string() }),
  401: z.object({ error: z.string() }),
  403: z.object({ error: z.string() }),
  404: z.object({ error: z.string() }),
  409: z.object({ error: z.string() }),
  413: z.object({ error: z.string() }),
  422: z.object({ error: z.string() }),
  429: z.object({ error: z.string() }),
  503: z.object({ error: z.string() }),
};
function publicAvatar(asset: ContentAsset) {
  return {
    id: asset.id,
    status: asset.status,
    url: asset.publicUrl,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
  };
}

function avatarUserId(request: FastifyRequest): string {
  if (!request.user) throw new SocialError("unauthorized", 401);
  return request.user.id;
}

export const socialAssetsRoutes: FastifyPluginAsync = async (app) => {
  configureContentServiceRuntime(env.content);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error as Error & {
      code?: string;
      statusCode?: number;
      status?: number;
    };
    const status = known.statusCode ?? known.status ?? 500;
    if ((status >= 400 && status < 500) || status === 503)
      return reply
        .code(status)
        .send({ error: known.code ?? "avatar_request_failed" });
    if (typeof error === "object" && error !== null && "validation" in error)
      return reply.code(400).send({ error: "invalid_request" });
    request.log.error({ err: error }, "Avatar request failed");
    return reply.code(500).send({ error: "avatar_request_failed" });
  });
  typed.post(
    "/users/me/avatar/uploads",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: contentAssetCreateBodySchema.pick({
          originalFilename: true,
          mimeType: true,
          expectedByteSize: true,
          checksumSha256: true,
        }),
        response: {
          200: z.object({
            asset: avatarSchema,
            upload: z.object({
              method: z.literal("PUT"),
              url: z.string(),
              headers: z.record(z.string(), z.string()),
              expiresAt: z.string(),
            }),
          }),
          ...errors,
        },
      },
    },
    async (request) => {
      const { policy, revision } = await resolveSocialPolicy(pool);
      if (!policy.enabled) throw new SocialError("social_disabled", 503);
      if (
        !(await checkRateLimit(
          `social:avatar:${avatarUserId(request)}`,
          policy.avatarRateLimit,
          policy.rateLimitWindowSeconds * 1000,
          { onError: "fail_closed" },
        ))
      )
        throw new SocialError("rate_limit_exceeded", 429);
      const result = await createContentAssetUpload(
        pool,
        { ...request.body, kind: "image" },
        userContentActor(avatarUserId(request)),
        { maximumBytes: policy.avatarMaxBytes, revision },
      );
      return { asset: publicAvatar(result.asset), upload: result.upload };
    },
  );
  typed.post(
    "/users/me/avatar/uploads/:id/complete",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: assetParams,
        body: contentAssetCompleteBodySchema,
        response: { 200: avatarSchema, ...errors },
      },
    },
    async (request) =>
      publicAvatar(
        await completeContentAssetUpload(
          pool,
          request.params.id,
          request.body,
          userContentActor(avatarUserId(request)),
        ),
      ),
  );
  typed.delete(
    "/users/me/avatar/uploads/:id",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: assetParams,
        response: { 200: avatarSchema, ...errors },
      },
    },
    async (request) =>
      publicAvatar(
        await deleteContentAsset(
          pool,
          request.params.id,
          userContentActor(avatarUserId(request)),
        ),
      ),
  );
};
