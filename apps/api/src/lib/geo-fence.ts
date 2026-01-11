import type { FastifyRequest } from "fastify";
import { isIP } from "node:net";
import geoip from "geoip-lite";

export type GeoFenceConfig = {
  enabled: boolean;
  blockedCountries: string[];
  defaultPolicy: "allow" | "block";
  trustProxy: boolean;
  proxySecret: string;
};

export type GeoFenceDecision = {
  allowed: boolean;
  country: string | null;
  ip: string | null;
  reason: "disabled" | "allowed" | "blocked" | "unknown";
};

function normalizeIp(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("::ffff:")) {
    const mapped = trimmed.slice(7);
    if (isIP(mapped)) return mapped;
  }

  if (isIP(trimmed)) return trimmed;

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0) {
    const withoutPort = trimmed.slice(0, lastColon);
    if (isIP(withoutPort)) return withoutPort;
  }

  return trimmed;
}

function readHeader(
  request: FastifyRequest,
  headerName: string,
): string | null {
  const raw = request.headers[headerName.toLowerCase()];
  if (!raw) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

function shouldTrustForwardedHeaders(
  request: FastifyRequest,
  config: GeoFenceConfig,
): boolean {
  if (!config.trustProxy) return false;
  if (!config.proxySecret) return false;
  const header = readHeader(request, "x-hunch-proxy-secret");
  return header === config.proxySecret;
}

export function resolveClientIp(
  request: FastifyRequest,
  config: GeoFenceConfig,
): string | null {
  const forwarded = shouldTrustForwardedHeaders(request, config)
    ? [
        readHeader(request, "cf-connecting-ip"),
        readHeader(request, "x-forwarded-for"),
        readHeader(request, "x-real-ip"),
      ]
    : [];

  const candidates = [...forwarded, request.ip].filter(
    (value): value is string => Boolean(value && value.trim()),
  );

  for (const candidate of candidates) {
    const first = candidate.split(",")[0]?.trim() ?? "";
    const normalized = normalizeIp(first);
    if (normalized) return normalized;
  }

  return null;
}

export function lookupCountry(ip: string): string | null {
  const hit = geoip.lookup(ip);
  if (!hit || !hit.country) return null;
  return hit.country.toUpperCase();
}

export function evaluateGeoFence(
  request: FastifyRequest,
  config: GeoFenceConfig,
): GeoFenceDecision {
  if (!config.enabled) {
    return { allowed: true, country: null, ip: null, reason: "disabled" };
  }

  const ip = resolveClientIp(request, config);
  if (!ip) {
    const allowed = config.defaultPolicy === "allow";
    return {
      allowed,
      country: null,
      ip: null,
      reason: allowed ? "allowed" : "unknown",
    };
  }

  const country = lookupCountry(ip);
  if (!country) {
    const allowed = config.defaultPolicy === "allow";
    return {
      allowed,
      country: null,
      ip,
      reason: allowed ? "allowed" : "unknown",
    };
  }

  const blocked = config.blockedCountries.includes(country);
  return {
    allowed: !blocked,
    country,
    ip,
    reason: blocked ? "blocked" : "allowed",
  };
}

export function buildGeoFenceResponse(args: {
  venue: string;
  decision: GeoFenceDecision;
}) {
  return {
    error: `${args.venue} trading is not available in your region`,
    code: "geo_blocked",
    venue: args.venue,
    country: args.decision.country,
  };
}
