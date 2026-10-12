import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import { registerHip4ReadRoutes } from "./routes/hip4-read.js";
import { mapHip4Market } from "./services/hip4-mapping.js";

export async function buildHip4ContractApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: { info: { title: "Hunch HIP-4 read canary", version: "1" } },
    transform: jsonSchemaTransform,
  });
  return app;
}
test("read canary checks authorization before policy/DB and does not grant writes", async () => {
  const app = await buildHip4ContractApp();
  let reads = 0;
  registerHip4ReadRoutes(app, {
    authorize: async (_req, reply) => {
      reply.code(403).send({ error: "forbidden" });
    },
    policy: async () => {
      reads++;
      return { policy: DEFAULT_HIP4_READ_POLICY, revision: "defaults" };
    },
    markets: async () => {
      reads++;
      return [];
    },
  });
  const response = await app.inject({
    method: "GET",
    url: "/markets/hyperliquid/canary",
  });
  assert.equal(response.statusCode, 403);
  assert.equal(reads, 0);
  for (const suffix of ["", "/trades", "/candles"]) {
    assert.equal(
      (
        await app.inject(
          `/markets/hyperliquid/canary/hyperliquid:mainnet:outcome:1${suffix}`,
        )
      ).statusCode,
      403,
    );
  }
  assert.equal(reads, 0);
  assert.equal(
    (await app.inject({ method: "POST", url: "/markets/hyperliquid/canary" }))
      .statusCode,
    404,
  );
  await app.close();
});
test("history is allowlist/revision-bound, bounded, and separates malformed cursors from service errors", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/hip4/public-reads.json", import.meta.url),
      "utf8",
    ),
  );
  const market = mapHip4Market({
    ...fixture.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: fixture.collectedAt,
    generation: "test",
  }).market;
  const app = await buildHip4ContractApp();
  let reads = 0;
  let broken = false;
  registerHip4ReadRoutes(app, {
    authorize: async () => {},
    maxStreamTokens: 1,
    policy: async () => ({
      policy: {
        ...DEFAULT_HIP4_READ_POLICY,
        enabled: true,
        outcomeAllowlist: [8775],
        bookMaxAgeMs: 1001,
      },
      revision: "one",
    }),
    markets: async () => {
      reads++;
      return [market];
    },
    trades: async () => {
      if (broken) throw new Error("private transport details");
      return {
        source: "canonical_primary_trades",
        trades: [],
        nextCursor: null,
      };
    },
    candles: async () => ({
      intervalMs: 60000,
      candles: [],
      coverage: {
        source: "canonical_primary_trades",
        complete: false,
        intervals: [],
        truncated: false,
      },
      nextBefore: null,
    }),
  });
  const base = "/markets/hyperliquid/canary/";
  const id = market.marketId;
  assert.equal(
    (await app.inject(base + "hyperliquid:testnet:outcome:8775/trades"))
      .statusCode,
    404,
  );
  assert.equal(
    (await app.inject(base + id + "/trades?policyRevision=old")).statusCode,
    409,
  );
  assert.equal(reads, 0);
  assert.equal(
    (await app.inject(base + id + "/trades?cursor=invalid")).statusCode,
    400,
  );
  assert.equal(
    (await app.inject(base + id + "/candles?from=0&before=999999999999"))
      .statusCode,
    400,
  );
  assert.equal((await app.inject(base + id + "/trades")).statusCode, 200);
  assert.equal(
    (await app.inject(base + id + "/candles")).json().coverage.complete,
    false,
  );
  assert.equal((await app.inject(base + id)).json().streamTokenIds.length, 1);
  assert.equal((await app.inject(base + id)).json().refreshAfterMs, 500);
  broken = true;
  const failed = await app.inject(base + id + "/trades");
  assert.equal(failed.statusCode, 503);
  assert.ok(!failed.body.includes("private transport"));
  await app.close();
});
test("disabled, unavailable and empty canary responses remain distinct", async () => {
  const app = await buildHip4ContractApp();
  let mode = "off";
  registerHip4ReadRoutes(app, {
    authorize: async () => {},
    policy: async () => {
      if (mode === "broken") throw new Error("invalid_policy");
      return {
        policy: { ...DEFAULT_HIP4_READ_POLICY, enabled: mode === "on" },
        revision: "test",
      };
    },
    markets: async () => [],
  });
  assert.equal(
    (await app.inject("/markets/hyperliquid/canary")).statusCode,
    404,
  );
  mode = "broken";
  assert.equal(
    (await app.inject("/markets/hyperliquid/canary")).statusCode,
    503,
  );
  mode = "on";
  const response = await app.inject("/markets/hyperliquid/canary");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json().markets, []);
  assert.equal(
    (await app.inject("/markets/hyperliquid/canary?afterOutcome=1.2"))
      .statusCode,
    400,
  );
  await app.close();
});
