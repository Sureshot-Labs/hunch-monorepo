import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { imageSize } from "image-size";
import { z } from "zod";
import { resolveTrustedProxy } from "./lib/trusted-proxy.js";

const rootRequire = createRequire(
  new URL("../../../package.json", import.meta.url),
);
const apiRequire = createRequire(new URL("../package.json", import.meta.url));

test("HTTP dependencies resolve to patched releases without crossing major versions", () => {
  assert.equal(apiRequire("fastify/package.json").version, "5.12.8");
  assert.equal(rootRequire("undici/package.json").version, "7.30.1");
  for (const venue of ["polymarket", "limitless", "dflow"]) {
    const indexerRequire = createRequire(
      new URL(`../../indexer-${venue}/package.json`, import.meta.url),
    );
    assert.equal(indexerRequire("undici/package.json").version, "6.29.1");
  }
});

test("oversized constrained arrays stop before allocating per-element errors", () => {
  // GHSA-mrhx-c7xc-m3w5: a max bound must run before parsing every element.
  const schema = z.array(z.string()).max(3);
  const result = schema.safeParse(Array.from({ length: 10_000 }, () => 1));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.length, 1);
    assert.equal(result.error.issues[0]?.code, "too_big");
  }
  assert.deepEqual(schema.parse(["a", "b"]), ["a", "b"]);
});

test("zero-length ICNS entries are rejected without looping and PNG still parses", () => {
  // GHSA-w3rx-r6r6-pgpr. Isolate the malformed vector so an accidental downgrade
  // fails with a bounded child timeout instead of hanging the test runner.
  const code = `const assert=require('node:assert/strict');const {imageSize}=require(${JSON.stringify(apiRequire.resolve("image-size"))});assert.throws(()=>imageSize(Buffer.from('69636e73000000106963303700000000','hex')),/Invalid ICNS/);`;
  const child = spawnSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16_384,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  const dimensions = imageSize(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDtcAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  assert.equal(dimensions.width, 1);
  assert.equal(dimensions.height, 1);
});

test("malformed URLs cannot reach a sibling protected not-found handler", async () => {
  // GHSA-p68q-wchp-6fh7: invalid decoding must fail before plugin fallbacks.
  const app = Fastify();
  let privateFallbacks = 0;
  app.register(
    async (publicPlugin) => {
      publicPlugin.get("/ok", async () => ({ ok: true }));
      publicPlugin.setNotFoundHandler(async (_request, reply) =>
        reply.code(404).send({ public: true }),
      );
    },
    { prefix: "/public" },
  );
  app.register(
    async (privatePlugin) => {
      privatePlugin.setNotFoundHandler(
        {
          preHandler: async (_request: FastifyRequest, reply: FastifyReply) => {
            await reply.code(401).send({ error: "unauthorized" });
          },
        },
        async () => {
          privateFallbacks += 1;
          return { protected: true };
        },
      );
    },
    { prefix: "/private" },
  );
  try {
    for (const method of ["GET", "POST", "PATCH"] as const) {
      const response = await app.inject({ method, url: "/public/%zz" });
      assert.equal(response.statusCode, 400);
      assert.ok(!response.body.includes('"protected":true'));
    }
    assert.equal(privateFallbacks, 0);
    assert.equal((await app.inject("/public/ok")).statusCode, 200);
    assert.equal((await app.inject("/private/missing")).statusCode, 401);
  } finally {
    await app.close();
  }
});

test("header dependencies remain case-insensitive after schema compilation", async () => {
  // GHSA-9q9j-q6p8-xq58: a dependent header must not disappear after lowercasing.
  const app = Fastify();
  app.get(
    "/headers",
    {
      schema: {
        headers: {
          type: "object",
          properties: {
            "X-Admin": { type: "string" },
            "X-Admin-Token": { type: "string" },
          },
          dependencies: { "X-Admin": ["X-Admin-Token"] },
        },
      },
    },
    async () => ({ ok: true }),
  );
  try {
    assert.equal(
      (await app.inject({ url: "/headers", headers: { "x-admin": "1" } }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: "/headers",
          headers: { "x-admin": "1", "x-admin-token": "test-token" },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test("proxy trust validates private addresses and the configured hop bound", () => {
  assert.equal(resolveTrustedProxy(false, 1), false);
  const trusted = resolveTrustedProxy(true, 1);
  assert.ok(trusted);
  for (const address of [
    "127.0.0.1",
    "127.8.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fd12::1",
    "::ffff:172.16.0.1",
    "::ffff:ac10:1",
  ]) {
    assert.equal(trusted(address, 0), true, address);
    assert.equal(trusted(address, 1), false, address);
  }
  for (const address of [
    "172.15.255.255",
    "172.32.0.1",
    "8.8.8.8",
    "169.254.1.1",
    "fe80::1",
    "2001:4860::1",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "fd00::1%eth0",
    "garbage",
    "",
  ]) {
    assert.equal(trusted(address, 0), false, address);
  }
  assert.equal(trusted("127.0.0.1", -1), false);
  assert.equal(trusted("127.0.0.1", 0.5), false);
  const zeroHops = resolveTrustedProxy(true, 0);
  assert.ok(zeroHops);
  assert.equal(zeroHops("127.0.0.1", 0), false);
});

test("only a trusted private proxy can supply forwarded request fields", async () => {
  const app = Fastify({ trustProxy: resolveTrustedProxy(true, 1) });
  app.get("/", async (request) => ({
    ip: request.ip,
    host: request.host,
    protocol: request.protocol,
  }));
  const headers = {
    host: "origin.test",
    "x-forwarded-for": "198.51.100.8",
    "x-forwarded-host": "proxy.test",
    "x-forwarded-proto": "https",
  };
  try {
    assert.deepEqual(
      (
        await app.inject({ url: "/", remoteAddress: "172.18.0.2", headers })
      ).json(),
      { ip: "198.51.100.8", host: "proxy.test", protocol: "https" },
    );
    assert.deepEqual(
      (
        await app.inject({ url: "/", remoteAddress: "203.0.113.9", headers })
      ).json(),
      { ip: "203.0.113.9", host: "origin.test", protocol: "http" },
    );
  } finally {
    await app.close();
  }
});
