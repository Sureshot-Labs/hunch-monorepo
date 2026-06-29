import type { FastifyPluginAsync } from "fastify";
import { checkDatabaseReady } from "../db.js";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (_request, reply) => {
    try {
      await checkDatabaseReady();
      return { ok: true, db: "ready" };
    } catch {
      return reply.code(503).send({ ok: false, db: "unavailable" });
    }
  });
};
