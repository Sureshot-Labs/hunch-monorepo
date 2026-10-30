import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createDiscoveryRoutes } from "./routes/discovery.js";

// No app/env import: contract generation cannot start timers, Redis refreshes or workers.
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Discovery", version: "1" } },
  transform: jsonSchemaTransform,
});
await app.register(
  createDiscoveryRoutes({
    read: async () => {
      throw Error("contract-only");
    },
    readTraders: async () => {
      throw Error("contract-only");
    },
  }),
);
await app.ready();
try {
  const generated = app.swagger();
  const path = new URL("../openapi.json", import.meta.url);
  const committed = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { ...generated, paths: {} };
  for (const name of ["quick-wins", "smart-money", "hidden-gems"]) {
    const key = `/discovery/${name}`,
      operation = generated.paths?.[key];
    assert.ok(operation);
    const reason = (
      operation.get?.responses?.["200"] as unknown as {
        content: {
          "application/json": {
            schema: {
              properties: {
                items: { items: { properties: { reason: unknown } } };
              };
            };
          };
        };
      }
    ).content["application/json"].schema.properties.items.items.properties
      .reason;
    assert.match(JSON.stringify(reason), /quick-wins/);
    assert.match(JSON.stringify(reason), /smart-money/);
    assert.match(JSON.stringify(reason), /hidden-gems/);
    assert.match(JSON.stringify(operation), /published_research/);
    assert.match(JSON.stringify(operation), /currentPositionStatus/);
    assert.match(
      JSON.stringify(reason),
      /"discriminator":\{"propertyName":"kind"\}/,
    );
    if (process.argv.includes("--write")) committed.paths[key] = operation;
    if (process.argv.includes("--compare"))
      assert.deepEqual(
        committed.paths[key],
        operation,
        `${key} OpenAPI must match executable Zod schema`,
      );
  }
  const tradersKey = "/discovery/smart-money/{marketId}/traders";
  const tradersOperation = generated.paths?.[tradersKey];
  assert.ok(tradersOperation);
  assert.match(JSON.stringify(tradersOperation), /observedIncreaseValueUsd/);
  if (process.argv.includes("--write"))
    committed.paths[tradersKey] = tradersOperation;
  if (process.argv.includes("--compare"))
    assert.deepEqual(committed.paths[tradersKey], tradersOperation);
  if (process.argv.includes("--write"))
    writeFileSync(path, `${JSON.stringify(committed, null, 2)}\n`);
  console.log(
    "ok - Discovery OpenAPI matches executable routes without initializing application services",
  );
} finally {
  await app.close();
}
