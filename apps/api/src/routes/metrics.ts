import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { getMetrics } from "../metrics.js";

function readHeaderValue(
  headers: Record<string, unknown>,
  name: string,
): string | null {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : null;
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    const trimmed = raw[0].trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function authTokenFromHeaders(headers: Record<string, unknown>): string | null {
  const bearer = readHeaderValue(headers, "authorization");
  if (bearer && bearer.toLowerCase().startsWith("bearer ")) {
    const token = bearer.slice(7).trim();
    if (token.length) return token;
  }
  return readHeaderValue(headers, "x-metrics-token");
}

function tokensEqual(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/metrics", async (request, reply) => {
    const expectedToken = env.metricsAuthToken;
    if (!expectedToken) {
      reply.code(404);
      return reply.send({ error: "Not found" });
    }

    const token = authTokenFromHeaders(
      request.headers as Record<string, unknown>,
    );
    if (!token || !tokensEqual(expectedToken, token)) {
      reply.code(401);
      return reply.send({ error: "Unauthorized" });
    }

    const m = getMetrics();
    return reply.send(m);
  });
};
