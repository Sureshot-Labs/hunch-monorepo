import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { tx } from "@hunch/infra";

import { getApiContentPools } from "../content-runtime.js";
import { env } from "../env.js";
import {
  acquireDistributedSlotStatus,
  consumeDistributedBudgetStatus,
  releaseDistributedSlot,
} from "../lib/rate-limit.js";
import {
  adminContentArticlesQuerySchema,
  contentArticleCreateBodySchema,
  contentArticleIdParamsSchema,
  contentArticleMutationBodySchema,
  contentArticlePreviewTokenBodySchema,
  contentArticleUpdateBodySchema,
  contentArticleVersionParamsSchema,
  contentArticleVersionsQuerySchema,
  contentAssetCompleteBodySchema,
  contentAssetIdParamsSchema,
  journalServiceAssetCreateBodySchema,
  journalServiceAssetsQuerySchema,
  journalServiceAssetUpdateBodySchema,
  journalServiceIdempotencyHeadersSchema,
} from "../schemas/content.js";
import {
  completeContentAssetUpload,
  createContentAssetUpload,
  getContentAsset,
  journalServiceAsset,
  listContentAssets,
  renewContentAssetUpload,
  updateContentAsset,
} from "../services/content-assets.js";
import {
  ContentError,
  createContentArticleInTransaction,
  createContentArticleCheckpoint,
  getAdminContentArticle,
  getContentArticleVersion,
  listAdminContentArticles,
  listContentArticleAudit,
  listContentArticleVersions,
  transitionContentArticleReview,
  updateContentArticle,
  validateContentArticleForService,
} from "../services/content.js";
import { createContentPreviewToken } from "../services/content-preview.js";
import { createJournalServiceMiddleware } from "../services/journal-service-auth.js";
import {
  recordJournalServiceOutcome,
  recordJournalServiceRequest,
} from "../services/journal-service-observability.js";
import {
  claimJournalIdempotency,
  claimJournalIdempotencyInTransaction,
  completeJournalIdempotency,
  completeJournalIdempotencyInTransaction,
  journalIdempotencyRequestHash,
  JournalIdempotencyError,
  releaseJournalIdempotencyLease,
  type JournalIdempotencyClaim,
} from "../services/journal-idempotency.js";
import { sendContentError } from "./content-error.js";

const CONTENT_BODY_LIMIT = 1_500_000;

function serviceActor(request: FastifyRequest) {
  if (!request.contentActor || request.contentActor.kind !== "service") {
    throw new Error("Journal service actor is missing after authentication");
  }
  return request.contentActor;
}

function principalId(request: FastifyRequest): string {
  const id = request.journalServicePrincipal?.id;
  if (!id) throw new Error("Journal service principal is missing");
  return id;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string") {
    throw new JournalIdempotencyError(
      "idempotency_key_reused",
      "Idempotency-Key header is required",
      409,
    );
  }
  return value;
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof JournalIdempotencyError) {
    recordJournalServiceOutcome(error.code);
    if (error.code === "idempotency_in_progress") {
      reply.header("Retry-After", "1");
    }
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }
  if (
    error instanceof ContentError &&
    error.code === "content_revision_conflict"
  ) {
    recordJournalServiceOutcome("revision_conflict");
  }
  return sendContentError(reply, error, {
    databaseBusyMessage: "Journal storage is busy; retry the request",
  });
}

async function releaseClaimOnError(
  pool: ReturnType<typeof getApiContentPools>["adminPool"],
  claim: JournalIdempotencyClaim | null,
) {
  if (!claim) return;
  await releaseJournalIdempotencyLease(pool, claim).catch(() => undefined);
}

export const serviceJournalRoutes: FastifyPluginAsync = async (app) => {
  if (!env.journalServiceApiEnabled) return;
  const contentPool = getApiContentPools().adminPool;
  const z = app.withTypeProvider<ZodTypeProvider>();
  const requestStarts = new WeakMap<FastifyRequest, number>();
  app.addHook("onRequest", async (request) => {
    requestStarts.set(request, performance.now());
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unknown";
    const scope = request.journalServiceRequiredScope ?? "unknown";
    recordJournalServiceRequest(
      route,
      scope,
      reply.statusCode,
      performance.now() - (requestStarts.get(request) ?? performance.now()),
    );
    const params = request.params as { id?: unknown } | undefined;
    request.log.info(
      {
        requestId: request.id,
        principalId: request.journalServicePrincipal?.id,
        credentialPrefix: request.journalServiceCredential?.prefix,
        route,
        scope,
        resourceId: typeof params?.id === "string" ? params.id : undefined,
        status: reply.statusCode,
      },
      "Journal service request completed",
    );
  });
  const auth = (
    requiredScope: Parameters<
      typeof createJournalServiceMiddleware
    >[1]["requiredScope"],
    rateProfile: Parameters<
      typeof createJournalServiceMiddleware
    >[1]["rateProfile"],
  ) =>
    createJournalServiceMiddleware(contentPool, { requiredScope, rateProfile });

  z.get(
    "/service/journal/articles",
    {
      preHandler: auth("journal:read", "read"),
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
        return sendServiceError(reply, error);
      }
    },
  );

  z.post(
    "/service/journal/articles",
    {
      preHandler: auth("journal:draft:create", "mutation"),
      bodyLimit: CONTENT_BODY_LIMIT,
      schema: {
        headers: journalServiceIdempotencyHeadersSchema,
        body: contentArticleCreateBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const result = await tx(contentPool, async (db) => {
          const claim = await claimJournalIdempotencyInTransaction(db, {
            principalId: principalId(request),
            operation: "create_article",
            idempotencyKey: idempotencyKey(request),
            requestHash: journalIdempotencyRequestHash(
              "create_article",
              request.body,
            ),
            resourceType: "article",
          });
          let article = await getAdminContentArticle(db, claim.resourceId);
          if (!article) {
            article = (
              await createContentArticleInTransaction(
                db,
                request.body,
                serviceActor(request),
                claim.resourceId,
              )
            ).article;
          }
          await completeJournalIdempotencyInTransaction(db, claim, {
            httpStatus: 201,
            response: { articleId: article.id },
          });
          return { article, claim };
        });
        recordJournalServiceOutcome(
          result.claim.replay ? "draft_create_replayed" : "draft_created",
        );
        if (result.claim.replay) recordJournalServiceOutcome("idempotency_hit");
        if (result.claim.reclaimed)
          recordJournalServiceOutcome("idempotency_lease_reclaimed");
        reply.header("Cache-Control", "no-store");
        return reply
          .code(result.claim.replay ? (result.claim.httpStatus ?? 201) : 201)
          .send({
            ok: true,
            article: result.article,
            idempotentReplay: result.claim.replay,
          });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  z.get(
    "/service/journal/articles/:id",
    {
      preHandler: auth("journal:read", "read"),
      schema: { params: contentArticleIdParamsSchema },
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
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, article });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  z.patch(
    "/service/journal/articles/:id",
    {
      preHandler: auth("journal:draft:update", "mutation"),
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
          serviceActor(request),
        );
        recordJournalServiceOutcome(
          result.article.draft.revision > request.body.expectedRevision
            ? "draft_updated"
            : "draft_update_noop",
        );
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, article: result.article });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  z.post(
    "/service/journal/articles/:id/checkpoint",
    {
      preHandler: auth("journal:draft:checkpoint", "mutation"),
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
          actor: serviceActor(request),
        });
        recordJournalServiceOutcome("checkpoint_created");
        reply.header("Cache-Control", "no-store");
        return reply.code(201).send({ ok: true, version });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  z.post(
    "/service/journal/articles/:id/validate",
    {
      preHandler: auth("journal:validate", "read"),
      schema: { params: contentArticleIdParamsSchema },
    },
    async (request, reply) => {
      try {
        const validation = await validateContentArticleForService(
          contentPool,
          request.params.id,
        );
        recordJournalServiceOutcome(
          validation.ready ? "validation_ready" : "validation_not_ready",
        );
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, validation });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  z.post(
    "/service/journal/articles/:id/preview-token",
    {
      preHandler: auth("journal:preview:create", "mutation"),
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
            undefined,
            {
              currentRevision: article.draft.revision,
              currentContentHash: article.draft.contentHash,
            },
          );
        }
        const preview = createContentPreviewToken({
          articleId: article.id,
          revision: article.draft.revision,
          ttlSeconds: request.body.ttlSeconds,
        });
        recordJournalServiceOutcome("preview_created");
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, preview });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  z.get(
    "/service/journal/articles/:id/versions",
    {
      preHandler: auth("journal:read", "read"),
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
        return sendServiceError(reply, error);
      }
    },
  );

  z.get(
    "/service/journal/articles/:id/versions/:versionId",
    {
      preHandler: auth("journal:read", "read"),
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
        return sendServiceError(reply, error);
      }
    },
  );

  z.get(
    "/service/journal/articles/:id/audit",
    {
      preHandler: auth("journal:read", "read"),
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
        return sendServiceError(reply, error);
      }
    },
  );

  z.get(
    "/service/journal/assets",
    {
      preHandler: auth("journal:read", "read"),
      schema: { querystring: journalServiceAssetsQuerySchema },
    },
    async (request, reply) => {
      try {
        const result = await listContentAssets(contentPool, {
          ...request.query,
          kind: "image",
        });
        reply.header("Cache-Control", "no-store");
        return reply.send({
          ok: true,
          items: result.items.map(journalServiceAsset),
          nextCursor: result.nextCursor,
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  z.post(
    "/service/journal/assets",
    {
      preHandler: auth("journal:asset:upload-image", "upload"),
      schema: {
        headers: journalServiceIdempotencyHeadersSchema,
        body: journalServiceAssetCreateBodySchema,
      },
    },
    async (request, reply) => {
      let claim: JournalIdempotencyClaim | null = null;
      let budgetReserved = false;
      try {
        const body = {
          kind: "image" as const,
          originalFilename: request.body.originalFilename,
          mimeType: request.body.mimeType,
          expectedByteSize: request.body.expectedByteSize,
          checksumSha256: request.body.checksumSha256,
          defaultAlt: request.body.defaultAlt,
          defaultCaption: request.body.defaultCaption,
          creditName: request.body.creditName,
          creditUrl: request.body.creditUrl,
          metadata: {
            sourceType: request.body.sourceType,
            ...(request.body.license !== undefined
              ? { license: request.body.license }
              : {}),
          },
        };
        claim = await claimJournalIdempotency(contentPool, {
          principalId: principalId(request),
          operation: "create_asset_upload",
          idempotencyKey: idempotencyKey(request),
          requestHash: journalIdempotencyRequestHash(
            "create_asset_upload",
            body,
          ),
          resourceType: "asset",
        });
        const existing = await getContentAsset(contentPool, claim.resourceId);
        if (!existing) {
          const budgetStatus = await consumeDistributedBudgetStatus(
            `journal-service:daily-upload:${principalId(request)}:${new Date()
              .toISOString()
              .slice(0, 10)}`,
            body.expectedByteSize,
            env.journalServiceDailyUploadBytes,
            26 * 60 * 60 * 1_000,
          );
          if (budgetStatus === "unavailable") {
            await releaseClaimOnError(contentPool, claim);
            return reply
              .code(503)
              .send({ error: "service_security_backend_unavailable" });
          }
          if (budgetStatus === "limited") {
            reply.header("Retry-After", "3600");
            await releaseClaimOnError(contentPool, claim);
            return reply
              .code(429)
              .send({ error: "service_upload_quota_exceeded" });
          }
          budgetReserved = true;
        }
        const intent = existing
          ? await renewContentAssetUpload(
              contentPool,
              claim.resourceId,
              serviceActor(request),
            )
          : await createContentAssetUpload(
              contentPool,
              body,
              serviceActor(request),
              claim.resourceId,
            );
        await completeJournalIdempotency(contentPool, claim, {
          httpStatus: 201,
          response: { assetId: claim.resourceId },
        });
        recordJournalServiceOutcome(
          claim.replay ? "upload_intent_replayed" : "upload_intent_created",
        );
        if (budgetReserved) {
          recordJournalServiceOutcome(
            "upload_bytes_reserved",
            body.expectedByteSize,
          );
        }
        if (claim.replay) recordJournalServiceOutcome("idempotency_hit");
        if (claim.reclaimed)
          recordJournalServiceOutcome("idempotency_lease_reclaimed");
        reply.header("Cache-Control", "no-store");
        return reply.code(claim.replay ? (claim.httpStatus ?? 201) : 201).send({
          ok: true,
          asset: journalServiceAsset(intent.asset),
          upload: intent.upload,
          idempotentReplay: claim.replay,
        });
      } catch (error) {
        await releaseClaimOnError(contentPool, claim);
        return sendServiceError(reply, error);
      }
    },
  );

  z.post(
    "/service/journal/assets/:id/complete",
    {
      preHandler: auth("journal:asset:upload-image", "upload"),
      schema: {
        params: contentAssetIdParamsSchema,
        body: contentAssetCompleteBodySchema,
      },
    },
    async (request, reply) => {
      const slotKey = `journal-service:asset-verification:${principalId(request)}`;
      let slot = false;
      try {
        const slotStatus = await acquireDistributedSlotStatus(
          slotKey,
          env.journalServiceMaxConcurrentVerifications,
          10 * 60 * 1_000,
        );
        if (slotStatus === "unavailable") {
          return reply
            .code(503)
            .send({ error: "service_security_backend_unavailable" });
        }
        if (slotStatus === "limited") {
          reply.header("Retry-After", "30");
          return reply.code(429).send({
            error: "service_asset_verification_limit_exceeded",
          });
        }
        slot = true;
        const asset = await completeContentAssetUpload(
          contentPool,
          request.params.id,
          request.body,
          serviceActor(request),
        );
        recordJournalServiceOutcome("upload_completed");
        recordJournalServiceOutcome(
          "upload_bytes_completed",
          request.body.byteSize,
        );
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, asset: journalServiceAsset(asset) });
      } catch (error) {
        return sendServiceError(reply, error);
      } finally {
        if (slot) await releaseDistributedSlot(slotKey, 10 * 60 * 1_000);
      }
    },
  );

  z.patch(
    "/service/journal/assets/:id/metadata",
    {
      preHandler: auth("journal:asset:upload-image", "upload"),
      schema: {
        params: contentAssetIdParamsSchema,
        body: journalServiceAssetUpdateBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const asset = await updateContentAsset(
          contentPool,
          request.params.id,
          request.body,
          serviceActor(request),
        );
        recordJournalServiceOutcome("asset_metadata_updated");
        reply.header("Cache-Control", "no-store");
        return reply.send({ ok: true, asset: journalServiceAsset(asset) });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  if (env.journalServiceReviewSubmitEnabled) {
    z.post(
      "/service/journal/articles/:id/submit-review",
      {
        preHandler: auth("journal:review:submit", "mutation"),
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
            actor: serviceActor(request),
            status: "in_review",
          });
          recordJournalServiceOutcome("review_submitted");
          reply.header("Cache-Control", "no-store");
          return reply.send({ ok: true, article });
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );
  }
};
