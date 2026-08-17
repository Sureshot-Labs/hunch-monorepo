import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createAdminMiddleware } from "../auth.js";
import { getApiContentPools } from "../content-runtime.js";
import { env } from "../env.js";
import {
  adminContentArticlesQuerySchema,
  adminContentAssetsQuerySchema,
  contentArticleCreateBodySchema,
  contentArticleIdParamsSchema,
  contentArticleMutationBodySchema,
  contentArticlePreviewTokenBodySchema,
  contentArticlePublishBodySchema,
  contentArticleUpdateBodySchema,
  contentArticleVersionParamsSchema,
  contentArticleVersionsQuerySchema,
  contentAssetCompleteBodySchema,
  contentAssetCreateBodySchema,
  contentAssetIdParamsSchema,
  contentAssetUpdateBodySchema,
} from "../schemas/content.js";
import {
  completeContentAssetUpload,
  createContentAssetUpload,
  deleteContentAsset,
  getContentAsset,
  listContentAssets,
  updateContentAsset,
} from "../services/content-assets.js";
import {
  archiveContentArticle,
  cancelContentArticleSchedule,
  ContentError,
  createContentArticle,
  createContentArticleCheckpoint,
  getAdminContentArticle,
  getContentArticleVersion,
  listAdminContentArticles,
  listContentArticleAudit,
  listContentArticleVersions,
  publishContentArticle,
  restoreContentArticleVersion,
  transitionContentArticleReview,
  unpublishContentArticle,
  updateContentArticle,
} from "../services/content.js";
import { createContentPreviewToken } from "../services/content-preview.js";
import { adminContentActor } from "../services/content-actor.js";
import {
  getContentOperationalStatus,
  recordContentRevisionConflict,
} from "../services/content-observability.js";
import { sendContentError as sendSharedContentError } from "./content-error.js";

const CONTENT_BODY_LIMIT = 1_500_000;

function sendContentError(reply: FastifyReply, error: unknown) {
  return sendSharedContentError(reply, error, {
    databaseBusyMessage: "Content storage is busy; retry the request",
    onRevisionConflict: recordContentRevisionConflict,
  });
}

function actorAdminId(request: FastifyRequest): string | null {
  return request.adminAccount?.id ?? request.adminActor?.id ?? null;
}

function contentActor(request: FastifyRequest) {
  const id = actorAdminId(request);
  if (!id) {
    throw new Error("Admin content actor is missing after authorization");
  }
  return adminContentActor(
    id,
    request.adminAccount?.email ?? request.adminActor?.email,
  );
}

export const adminContentRoutes: FastifyPluginAsync = async (app) => {
  const contentPool = getApiContentPools().adminPool;
  const z = app.withTypeProvider<ZodTypeProvider>();
  const canRead = createAdminMiddleware({
    requiredAdminPermission: "content:read",
    allowLegacyFallback: false,
  });
  const canWrite = createAdminMiddleware({
    requiredAdminPermission: "content:write",
    allowLegacyFallback: false,
  });
  const canPublish = createAdminMiddleware({
    requiredAdminPermission: "content:publish",
    allowLegacyFallback: false,
  });

  z.get(
    "/admin/content/operations",
    { preHandler: canRead },
    async (_request, reply) => {
      try {
        const operations = await getContentOperationalStatus(contentPool);
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, operations });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/admin/content/articles",
    {
      preHandler: canRead,
      schema: { querystring: adminContentArticlesQuerySchema },
    },
    async (request, reply) => {
      try {
        const result = await listAdminContentArticles(
          contentPool,
          request.query,
        );
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, ...result });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.post(
    "/admin/content/articles",
    {
      preHandler: canWrite,
      bodyLimit: CONTENT_BODY_LIMIT,
      schema: { body: contentArticleCreateBodySchema },
    },
    async (request, reply) => {
      try {
        const result = await createContentArticle(
          contentPool,
          request.body,
          contentActor(request),
        );
        reply.header("Cache-Control", "no-store");
        return reply.code(201).send({ ok: true, article: result.article });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/admin/content/articles/:id",
    { preHandler: canRead, schema: { params: contentArticleIdParamsSchema } },
    async (request, reply) => {
      try {
        const article = await getAdminContentArticle(
          contentPool,
          request.params.id,
        );
        if (!article) {
          return reply.code(404).send({ error: "content_article_not_found" });
        }
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, article });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.patch(
    "/admin/content/articles/:id",
    {
      preHandler: canWrite,
      bodyLimit: CONTENT_BODY_LIMIT,
      schema: {
        params: contentArticleIdParamsSchema,
        body: contentArticleUpdateBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const result = await updateContentArticle(
          contentPool,
          request.params.id,
          request.body,
          contentActor(request),
        );
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, article: result.article });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.post(
    "/admin/content/articles/:id/preview-token",
    {
      preHandler: canWrite,
      schema: {
        params: contentArticleIdParamsSchema,
        body: contentArticlePreviewTokenBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const article = await getAdminContentArticle(
          contentPool,
          request.params.id,
        );
        if (!article) {
          return reply.code(404).send({ error: "content_article_not_found" });
        }
        if (article.draft.revision !== request.body.expectedRevision) {
          throw new ContentError(
            "content_revision_conflict",
            "Article draft was changed by another editor",
            409,
          );
        }
        const preview = createContentPreviewToken({
          articleId: article.id,
          revision: article.draft.revision,
          ttlSeconds: request.body.ttlSeconds,
        });
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, preview });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  const reviewTransition = (
    path: string,
    status: "draft" | "in_review" | "approved",
    preHandler: ReturnType<typeof createAdminMiddleware>,
  ) =>
    z.post(
      path,
      {
        preHandler,
        schema: {
          params: contentArticleIdParamsSchema,
          body: contentArticleMutationBodySchema,
        },
      },
      async (request, reply) => {
        try {
          const article = await transitionContentArticleReview(contentPool, {
            id: request.params.id,
            expectedRevision: request.body.expectedRevision,
            actor: contentActor(request),
            status,
          });
          reply.header("Cache-Control", "no-store");
          return reply.send({ ok: true, article });
        } catch (error) {
          return sendContentError(reply, error);
        }
      },
    );

  reviewTransition(
    "/admin/content/articles/:id/submit-review",
    "in_review",
    canWrite,
  );
  reviewTransition(
    "/admin/content/articles/:id/approve",
    "approved",
    canPublish,
  );
  reviewTransition(
    "/admin/content/articles/:id/return-draft",
    "draft",
    canWrite,
  );

  z.post(
    "/admin/content/articles/:id/publish",
    {
      preHandler: canPublish,
      schema: {
        params: contentArticleIdParamsSchema,
        body: contentArticlePublishBodySchema,
      },
    },
    async (request, reply) => {
      try {
        if (!env.contentPublishingEnabled) {
          throw new ContentError(
            "content_publishing_disabled",
            "Content publishing is disabled until the public renderer is ready",
            503,
          );
        }
        const result = await publishContentArticle(contentPool, {
          id: request.params.id,
          expectedRevision: request.body.expectedRevision,
          actorAdminId: actorAdminId(request),
          publishAt: request.body.publishAt
            ? new Date(request.body.publishAt)
            : undefined,
          requireApproval: env.contentRequireApproval,
        });
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, article: result.article });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.post(
    "/admin/content/articles/:id/cancel-schedule",
    {
      preHandler: canPublish,
      schema: {
        params: contentArticleIdParamsSchema,
        body: contentArticleMutationBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const result = await cancelContentArticleSchedule(contentPool, {
          id: request.params.id,
          expectedRevision: request.body.expectedRevision,
          actorAdminId: actorAdminId(request),
        });
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, article: result.article });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  for (const [path, mutation] of [
    ["/admin/content/articles/:id/unpublish", unpublishContentArticle],
    ["/admin/content/articles/:id/archive", archiveContentArticle],
  ] as const) {
    z.post(
      path,
      {
        preHandler: canPublish,
        schema: {
          params: contentArticleIdParamsSchema,
          body: contentArticleMutationBodySchema,
        },
      },
      async (request, reply) => {
        try {
          const result = await mutation(contentPool, {
            id: request.params.id,
            expectedRevision: request.body.expectedRevision,
            actorAdminId: actorAdminId(request),
          });
          reply.header("Cache-Control", "no-store");
          return reply.send({ ok: true, article: result.article });
        } catch (error) {
          return sendContentError(reply, error);
        }
      },
    );
  }

  z.post(
    "/admin/content/articles/:id/versions",
    {
      preHandler: canWrite,
      schema: {
        params: contentArticleIdParamsSchema,
        body: contentArticleMutationBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const version = await createContentArticleCheckpoint(contentPool, {
          id: request.params.id,
          expectedRevision: request.body.expectedRevision,
          actor: contentActor(request),
        });
        reply.header("Cache-Control", "no-store");
        return reply.code(201).send({ ok: true, version });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/admin/content/articles/:id/versions",
    {
      preHandler: canRead,
      schema: {
        params: contentArticleIdParamsSchema,
        querystring: contentArticleVersionsQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        const result = await listContentArticleVersions(contentPool, {
          articleId: request.params.id,
          ...request.query,
        });
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, ...result });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/admin/content/articles/:id/audit",
    {
      preHandler: canRead,
      schema: {
        params: contentArticleIdParamsSchema,
        querystring: contentArticleVersionsQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        const result = await listContentArticleAudit(contentPool, {
          articleId: request.params.id,
          ...request.query,
        });
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, ...result });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/admin/content/articles/:id/versions/:versionId",
    {
      preHandler: canRead,
      schema: { params: contentArticleVersionParamsSchema },
    },
    async (request, reply) => {
      try {
        const version = await getContentArticleVersion(
          contentPool,
          request.params.id,
          request.params.versionId,
        );
        if (!version) {
          return reply.code(404).send({ error: "content_version_not_found" });
        }
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, version });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.post(
    "/admin/content/articles/:id/versions/:versionId/restore",
    {
      preHandler: canWrite,
      bodyLimit: CONTENT_BODY_LIMIT,
      schema: {
        params: contentArticleVersionParamsSchema,
        body: contentArticleMutationBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const result = await restoreContentArticleVersion(contentPool, {
          id: request.params.id,
          versionId: request.params.versionId,
          expectedRevision: request.body.expectedRevision,
          actorAdminId: actorAdminId(request),
        });
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, article: result.article });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/admin/content/assets",
    {
      preHandler: canRead,
      schema: { querystring: adminContentAssetsQuerySchema },
    },
    async (request, reply) => {
      try {
        const result = await listContentAssets(contentPool, request.query);
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, ...result });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.post(
    "/admin/content/assets",
    { preHandler: canWrite, schema: { body: contentAssetCreateBodySchema } },
    async (request, reply) => {
      try {
        const intent = await createContentAssetUpload(
          contentPool,
          request.body,
          contentActor(request),
        );
        reply.header("Cache-Control", "no-store");
        return reply.code(201).send({ ok: true, ...intent });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/admin/content/assets/:id",
    { preHandler: canRead, schema: { params: contentAssetIdParamsSchema } },
    async (request, reply) => {
      try {
        const asset = await getContentAsset(contentPool, request.params.id);
        if (!asset) {
          return reply.code(404).send({ error: "content_asset_not_found" });
        }
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, asset });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.post(
    "/admin/content/assets/:id/complete",
    {
      preHandler: canWrite,
      schema: {
        params: contentAssetIdParamsSchema,
        body: contentAssetCompleteBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const asset = await completeContentAssetUpload(
          contentPool,
          request.params.id,
          request.body,
          contentActor(request),
        );
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, asset });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.patch(
    "/admin/content/assets/:id",
    {
      preHandler: canWrite,
      schema: {
        params: contentAssetIdParamsSchema,
        body: contentAssetUpdateBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const asset = await updateContentAsset(
          contentPool,
          request.params.id,
          request.body,
          contentActor(request),
        );
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, asset });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.delete(
    "/admin/content/assets/:id",
    { preHandler: canWrite, schema: { params: contentAssetIdParamsSchema } },
    async (request, reply) => {
      try {
        const asset = await deleteContentAsset(
          contentPool,
          request.params.id,
          contentActor(request),
        );
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, asset });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );
};
