import type { FastifyPluginAsync } from "fastify";
import { getMetrics } from "../metrics.js";

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/metrics", async (_req, reply) => {
    const m = getMetrics();
    return reply.send(m);
  });
};
