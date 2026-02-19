import type { FastifyRequest } from "fastify";
import { env } from "../env.js";
import { resolveClientIp, type GeoFenceConfig } from "./geo-fence.js";

const requestIpConfig: GeoFenceConfig = {
  enabled: false,
  blockedCountries: [],
  defaultPolicy: "allow",
  trustProxy: env.trustProxy,
  proxySecret: env.proxySecret,
};

export function resolveSecurityClientIp(request: FastifyRequest): string {
  return resolveClientIp(request, requestIpConfig) ?? request.ip ?? "unknown";
}
