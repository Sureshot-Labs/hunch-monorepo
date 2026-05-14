import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import { resolveClientIp, type GeoFenceConfig } from "./lib/geo-fence.js";
import { isGlobalRateLimitExemptPath } from "./lib/global-rate-limit.js";

type TestCase = {
  name: string;
  run: () => void;
};

const proxyConfig: GeoFenceConfig = {
  enabled: false,
  blockedCountries: [],
  defaultPolicy: "allow",
  trustProxy: true,
  proxySecret: "secret",
};

function requestWith(
  headers: Record<string, string | undefined>,
  ip = "10.0.0.1",
): FastifyRequest {
  return {
    headers,
    ip,
  } as unknown as FastifyRequest;
}

const tests: TestCase[] = [
  {
    name: "trusts signed Hunch client IP",
    run: () => {
      assert.equal(
        resolveClientIp(
          requestWith({
            "x-hunch-proxy-secret": "secret",
            "x-hunch-client-ip": "203.0.113.8",
          }),
          proxyConfig,
        ),
        "203.0.113.8",
      );
    },
  },
  {
    name: "signed Hunch client IP wins over second proxy headers",
    run: () => {
      assert.equal(
        resolveClientIp(
          requestWith({
            "x-hunch-proxy-secret": "secret",
            "x-hunch-client-ip": "203.0.113.8",
            "x-real-ip": "10.10.10.10",
            "x-forwarded-for": "10.10.10.10",
          }),
          proxyConfig,
        ),
        "203.0.113.8",
      );
    },
  },
  {
    name: "ignores unsigned Hunch client IP",
    run: () => {
      assert.equal(
        resolveClientIp(
          requestWith({
            "x-hunch-client-ip": "203.0.113.8",
          }),
          proxyConfig,
        ),
        "10.0.0.1",
      );
    },
  },
  {
    name: "falls through malformed signed IPs to valid proxy headers",
    run: () => {
      assert.equal(
        resolveClientIp(
          requestWith({
            "x-hunch-proxy-secret": "secret",
            "x-hunch-client-ip": "bad-ip",
            "x-real-ip": "198.51.100.7",
          }),
          proxyConfig,
        ),
        "198.51.100.7",
      );
    },
  },
  {
    name: "strips IPv4 ports",
    run: () => {
      assert.equal(
        resolveClientIp(
          requestWith({
            "x-hunch-proxy-secret": "secret",
            "x-real-ip": "198.51.100.7:443",
          }),
          proxyConfig,
        ),
        "198.51.100.7",
      );
    },
  },
  {
    name: "rejects malformed request IPs",
    run: () => {
      assert.equal(
        resolveClientIp(requestWith({}, "not-an-ip"), proxyConfig),
        null,
      );
    },
  },
  {
    name: "global rate limit exempts only infrastructure paths",
    run: () => {
      assert.equal(isGlobalRateLimitExemptPath("/health"), true);
      assert.equal(isGlobalRateLimitExemptPath("/metrics"), true);
      assert.equal(isGlobalRateLimitExemptPath("/openapi.json"), true);
      assert.equal(isGlobalRateLimitExemptPath("/docs"), true);
      assert.equal(isGlobalRateLimitExemptPath("/docs/static/main.js"), true);
      assert.equal(isGlobalRateLimitExemptPath("/feed"), false);
      assert.equal(isGlobalRateLimitExemptPath("/auth/privy"), false);
      assert.equal(isGlobalRateLimitExemptPath("/metrics-extra"), false);
    },
  },
];

for (const test of tests) {
  test.run();
  console.log(`[security-ip-tests] ok ${test.name}`);
}
