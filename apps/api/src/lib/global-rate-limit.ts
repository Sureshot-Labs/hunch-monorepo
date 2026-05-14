import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { checkRateLimitForSecurityClientIp } from "./request-ip.js";

const EXEMPT_EXACT_PATHS = new Set(["/health", "/metrics", "/openapi.json"]);
const EXEMPT_PREFIXES = ["/docs"];

function requestPath(request: FastifyRequest): string {
  const raw = request.url || "/";
  const queryIndex = raw.indexOf("?");
  return queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
}

export function isGlobalRateLimitExemptPath(path: string): boolean {
  if (EXEMPT_EXACT_PATHS.has(path)) return true;
  return EXEMPT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export async function enforceGlobalRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!env.apiGlobalRateLimitEnabled) return;

  const path = requestPath(request);
  if (isGlobalRateLimitExemptPath(path)) return;

  const result = await checkRateLimitForSecurityClientIp(request, {
    keyPrefix: "api:global",
    maxRequests: env.apiGlobalRateLimitMaxRequests,
    windowMs: env.apiGlobalRateLimitWindowMs,
    onError: "fail_open",
  });

  if (result.allowed) return;

  reply.code(429);
  await reply.send({
    error: "rate_limit_exceeded",
    message: "Too many requests. Please try again later.",
  });
}
