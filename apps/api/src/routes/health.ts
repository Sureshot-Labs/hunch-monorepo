import type { FastifyPluginAsync } from "fastify";
import { checkDatabaseReady } from "../db.js";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/time", async (_request, reply) => {
    const nowMs = Date.now();
    reply.header("Content-Type", "application/json; charset=utf-8");
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
};
