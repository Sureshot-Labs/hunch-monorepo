import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { contentPool } from "../content-db.js";
import { CONTENT_RENDERER_CONTRACT_ID } from "../schemas/content-blocks.js";
import {
  contentArticlePreviewHeadersSchema,
  contentArticleSlugParamsSchema,
  publicContentArticleIndexQuerySchema,
  publicContentArticlesQuerySchema,
} from "../schemas/content.js";
import {
  ContentError,
  getPreviewContentArticle,
  getPublicContentArticle,
  listPublicContentArticleIndex,
  listPublicContentArticles,
} from "../services/content.js";
import { verifyContentPreviewToken } from "../services/content-preview.js";
import { recordContentRouteResponse } from "../services/content-observability.js";

const PUBLIC_CONTENT_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

function sendContentError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof ContentError)) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (["57014", "55P03", "40P01", "40001"].includes(code)) {
      reply.header("Retry-After", "1");
      return reply.code(503).send({
        error: "content_database_busy",
        message: "Content storage is temporarily busy",
      });
    }
    throw error;
  }
  reply.code(error.statusCode);
  return reply.send({
    error: error.code,
    message: error.message,
    ...(error.issues ? { issues: error.issues } : {}),
  });
}

export const contentRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const startedAt = new WeakMap<object, bigint>();
  const responseBytes = new WeakMap<object, number>();

  app.addHook("onRequest", async (request) => {
    startedAt.set(request, process.hrtime.bigint());
  });
  app.addHook("onSend", async (request, _reply, payload) => {
    const bytes =
      typeof payload === "string"
        ? Buffer.byteLength(payload)
        : Buffer.isBuffer(payload)
          ? payload.byteLength
          : 0;
    responseBytes.set(request, bytes);
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    const start = startedAt.get(request);
    if (!start) return;
    recordContentRouteResponse(
      request.routeOptions.url ?? "unknown",
      reply.statusCode,
      Number(process.hrtime.bigint() - start) / 1_000_000,
      responseBytes.get(request) ?? 0,
    );
  });

  z.get(
    "/content/articles",
    { schema: { querystring: publicContentArticlesQuerySchema } },
    async (request, reply) => {
      try {
        const result = await listPublicContentArticles(
          contentPool,
          request.query,
        );
        reply.header("Cache-Control", PUBLIC_CONTENT_CACHE_CONTROL);
        return reply.send({
          ok: true,
          rendererContractId: CONTENT_RENDERER_CONTRACT_ID,
          ...result,
        });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/content/articles-index",
    { schema: { querystring: publicContentArticleIndexQuerySchema } },
    async (request, reply) => {
      try {
        const result = await listPublicContentArticleIndex(
          contentPool,
          request.query,
        );
        reply.header("Cache-Control", PUBLIC_CONTENT_CACHE_CONTROL);
        return reply.send({
          ok: true,
          rendererContractId: CONTENT_RENDERER_CONTRACT_ID,
          ...result,
        });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/content/preview",
    { schema: { headers: contentArticlePreviewHeadersSchema } },
    async (request, reply) => {
      try {
        const claims = verifyContentPreviewToken(
          request.headers["x-hunch-content-preview-token"],
        );
        const article = await getPreviewContentArticle(
          contentPool,
          claims.articleId,
          claims.revision,
        );
        if (!article) {
          return reply.code(404).send({ error: "content_article_not_found" });
        }
        reply.header("Cache-Control", "private, no-store, max-age=0");
        reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
        return reply.send({
          ok: true,
          rendererContractId: CONTENT_RENDERER_CONTRACT_ID,
          article,
        });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );

  z.get(
    "/content/articles/:slug",
    { schema: { params: contentArticleSlugParamsSchema } },
    async (request, reply) => {
      try {
        const result = await getPublicContentArticle(
          contentPool,
          request.params.slug,
        );
        if (!result) {
          reply.header("Cache-Control", "public, max-age=0, s-maxage=15");
          return reply.code(404).send({ error: "content_article_not_found" });
        }
        if (result.kind === "redirect") {
          reply.header("Cache-Control", PUBLIC_CONTENT_CACHE_CONTROL);
          reply.header(
            "Location",
            `/content/articles/${encodeURIComponent(result.slug)}`,
          );
          return reply.code(308).send({ ok: true, redirectTo: result.slug });
        }
        reply.header("Cache-Control", PUBLIC_CONTENT_CACHE_CONTROL);
        reply.header("ETag", `W/"content-${result.article.versionId}"`);
        reply.header("Last-Modified", result.article.updatedAt);
        if (
          request.headers["if-none-match"] ===
          `W/"content-${result.article.versionId}"`
        ) {
          return reply.code(304).send();
        }
        return reply.send({
          ok: true,
          rendererContractId: CONTENT_RENDERER_CONTRACT_ID,
          article: result.article,
        });
      } catch (error) {
        return sendContentError(reply, error);
      }
    },
  );
};
