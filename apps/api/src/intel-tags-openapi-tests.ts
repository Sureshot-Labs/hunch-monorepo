// @isolated-process
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createHunchesRoutes } from "./routes/hunches.js";
import type { DbQuery } from "./db.js";

// No .env or provider calls. Register real social routes for their response contracts only.
Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/intel_openapi_test",
  REDIS_URL: "redis://127.0.0.1:1",
  JWT_SECRET: "intel-openapi-test",
  PRIVY_APP_ID: "intel-openapi-test",
  PRIVY_APP_SECRET: "intel-openapi-test",
});
globalThis.fetch = async () => {
  throw Error("network forbidden in contract test");
};
const { socialRoutes } = await import("./routes/social.js");
const { closeAcquiredRuntimeResources } =
  await import("./runtime-resource-cleanup.js");
const app = Fastify();
app.setSerializerCompiler(serializerCompiler);
app.setValidatorCompiler(validatorCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Intel", version: "1" } },
  transform: jsonSchemaTransform,
});
await app.register(
  createHunchesRoutes({
    query: async () => {
      throw Error("no SQL in contract generation");
    },
  } as unknown as DbQuery),
);
await app.register(socialRoutes);
try {
  await app.ready();
  const generated = app.swagger();
  const path = new URL("../openapi.json", import.meta.url);
  const saved = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { ...generated, paths: {} };
  for (const key of [
    "/hunches",
    "/hunches/{noteId}",
    "/social/feed",
    "/users/{id}/theses",
    "/markets/{marketId}/theses",
  ]) {
    const operation = generated.paths?.[key];
    assert.ok(operation, key);
    const json = JSON.stringify(operation);
    for (const code of [
      "top_trader",
      "wallet_activity",
      "winning_bet",
      "price_update",
      "new_evidence",
      "tagsVersion",
      "primaryTag",
    ])
      assert.ok(json.includes(code), `${key}:${code}`);
    assert.match(json, /"discriminator":\{"propertyName":"code"\}/);
    if (process.argv.includes("--write")) saved.paths[key] = operation;
    if (process.argv.includes("--compare"))
      assert.deepEqual(saved.paths[key], operation, key);
  }
  if (process.argv.includes("--write"))
    writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`);
  console.log(
    "Intel OpenAPI: real hunch/social routes use typed discriminated tags",
  );
} finally {
  await app.close();
  await closeAcquiredRuntimeResources();
}
