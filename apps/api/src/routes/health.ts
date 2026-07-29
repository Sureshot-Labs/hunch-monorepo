import type { FastifyPluginAsync } from "fastify";
import { checkContentDatabaseReady } from "../content-db.js";
import { checkDatabaseReady } from "../db.js";
import { env } from "../env.js";
import { CONTENT_RENDERER_CONTRACT_ID } from "../schemas/content-blocks.js";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/time", async (_request, reply) => {
    const nowMs = Date.now();
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return {
      ok: true,
      nowMs,
      nowSec: Math.floor(nowMs / 1000),
      iso: new Date(nowMs).toISOString(),
    };
  });

  app.get("/health", async (_request, reply) => {
    try {
      await checkDatabaseReady();
      return { ok: true, db: "ready" };
    } catch {
      return reply.code(503).send({ ok: false, db: "unavailable" });
    }
  });

  app.get("/health/content", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const configuration = {
      publishingEnabled: env.contentPublishingEnabled,
      workerEnabled: env.contentWorkerEnabled,
      approvalRequired: env.contentRequireApproval,
      rendererContractMatches:
        env.contentRendererContractId === CONTENT_RENDERER_CONTRACT_ID,
      revalidationConfigured: Boolean(
        env.contentRevalidateUrl && env.contentRevalidateSecret,
      ),
      storageConfigured: Boolean(
        env.contentAssetS3Endpoint &&
        env.contentAssetS3Bucket &&
        env.contentAssetPublicBaseUrl,
      ),
    };
    try {
      const database = await checkContentDatabaseReady();
      return {
        ok: true,
        database: { ready: true, ...database },
        configuration,
      };
    } catch {
      return reply.code(503).send({
        ok: false,
        database: { ready: false },
        configuration,
      });
    }
  });
};
