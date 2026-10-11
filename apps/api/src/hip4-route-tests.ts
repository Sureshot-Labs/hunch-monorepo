import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import { registerHip4ReadRoutes } from "./routes/hip4-read.js";

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
  assert.equal(
    (await app.inject({ method: "POST", url: "/markets/hyperliquid/canary" }))
      .statusCode,
    404,
  );
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
