import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import { resolveClientIp, type GeoFenceConfig } from "./lib/geo-fence.js";

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
];

for (const test of tests) {
  test.run();
  console.log(`[security-ip-tests] ok ${test.name}`);
}
