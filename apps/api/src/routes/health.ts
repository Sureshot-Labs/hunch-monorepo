import type { FastifyPluginAsync } from "fastify";
import { checkDatabaseReady } from "../db.js";
import { checkContentDatabaseReady } from "../content-db.js";
import { getApiContentPools } from "../content-runtime.js";
import { env } from "../env.js";

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

  if (env.contentEnabled) {
    app.get("/health/content", async (_request, reply) => {
      try {
        const content = await checkContentDatabaseReady(
          getApiContentPools().publicPool,
        );
        return { ok: true, content: "ready", ...content };
      } catch {
        return reply.code(503).send({ ok: false, content: "unavailable" });
      }
    });
  }
};
