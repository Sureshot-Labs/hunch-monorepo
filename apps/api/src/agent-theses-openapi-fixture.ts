import assert from "node:assert/strict";
import { mock } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/agent_openapi_test",
  REDIS_URL: "redis://127.0.0.1:1",
  JWT_SECRET: "agent-openapi-test",
  PRIVY_APP_ID: "agent-openapi-test",
  PRIVY_APP_SECRET: "agent-openapi-test",
});
mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: {
    pool: {
      query: () => {
        throw new Error("Unexpected database access");
      },
    },
  },
});
globalThis.fetch = async () => {
  throw new Error("Network forbidden in OpenAPI test");
};
const { socialRoutes } = await import("./routes/social.js");
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Social", version: "1" } },
  transform: jsonSchemaTransform,
});
await app.register(socialRoutes);
try {
  await app.ready();
  const spec = app.swagger();
  assert.ok(spec.paths?.["/theses"]);
  assert.ok(spec.paths?.["/theses/{id}"]);
  assert.ok(spec.paths?.["/social/feed"]);
  const encoded = JSON.stringify(spec.paths?.["/theses/{id}"]?.get);
  for (const key of [
    "purchaseMode",
    "entryQuoteAsOf",
    "sources",
    "isAgent",
    "top_ask_no_depth_fees_or_slippage",
  ])
    assert.ok(encoded.includes(key), key);
  const postOperation = spec.paths?.["/theses"]?.post;
  assert.ok(postOperation && "requestBody" in postOperation);
  const post = JSON.stringify(postOperation.requestBody);
  assert.ok(post.includes("purchaseRef"));
  assert.ok(!post.includes("purchaseMode"));
  assert.ok(JSON.stringify(spec).includes("paperPerformance"));
  console.log(
    "agent-theses OpenAPI: additive profile/thesis fields; POST remains real-only",
  );
} finally {
  await app.close();
}
