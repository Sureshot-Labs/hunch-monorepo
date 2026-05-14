import type { FastifyRequest } from "fastify";
import { env } from "../env.js";
import { resolveClientIp, type GeoFenceConfig } from "./geo-fence.js";
import {
  checkRateLimit,
  type RateLimitErrorMode,
} from "./rate-limit.js";

const requestIpConfig: GeoFenceConfig = {
  enabled: false,
  blockedCountries: [],
  defaultPolicy: "allow",
  trustProxy: env.trustProxy,
  proxySecret: env.proxySecret,
};

export function resolveSecurityClientIp(request: FastifyRequest): string {
  return resolveClientIp(request, requestIpConfig) ?? "unknown";
}

export async function checkRateLimitForSecurityClientIp(
  request: FastifyRequest,
  options: {
    keyPrefix: string;
    maxRequests: number;
    windowMs: number;
    onError?: RateLimitErrorMode;
  },
): Promise<{ allowed: boolean; clientIp: string; key: string }> {
  const clientIp = resolveSecurityClientIp(request);
  const key = `${options.keyPrefix}:${clientIp}`;
  const allowed = await checkRateLimit(
    key,
    options.maxRequests,
    options.windowMs,
    { onError: options.onError },
  );
  return { allowed, clientIp, key };
}
