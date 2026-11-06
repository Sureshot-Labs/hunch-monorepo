import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  registerFundingRoutes,
  type FundingRouteDependencies,
} from "./routes/funding.js";

// Register contracts only: no app startup, jobs, providers or auth requests.
const dependencies = new Proxy(
  {},
  {
    get: () => async () => {
      throw Error("contract-only dependency");
    },
  },
) as FundingRouteDependencies;
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Funding admission", version: "1" } },
  transform: jsonSchemaTransform,
});
registerFundingRoutes(app, dependencies);
await app.ready();
try {
  const generated = app.swagger();
  const file = new URL("../openapi.json", import.meta.url);
  const committed = JSON.parse(readFileSync(file, "utf8"));
  const paths = [
    "/funding/capabilities",
    "/funding/preparation/prepare",
    "/funding/preparation/runs/{runId}",
    "/funding/preparation/runs/{runId}/actions/{actionId}/report",
    "/funding/preparation/runs/{runId}/actions/{actionId}/admit",
    "/funding/preparation/runs/{runId}/reconcile",
  ];
  for (const path of paths) {
    const operation = generated.paths?.[path];
    assert.ok(operation, path);
    if (
      process.argv.includes("--write") ||
      process.env.HUNCH_WRITE_ADMISSION_OPENAPI === "1"
    )
      committed.paths[path] = operation;
    else
      assert.deepEqual(
        committed.paths[path],
        operation,
        `${path} must match executable contract`,
      );
  }
  assert.match(JSON.stringify(generated.paths?.[paths[4] ?? ""]), /requestKey/);
  assert.doesNotMatch(JSON.stringify(generated), /keyHash|executionJournal/);
  if (
    process.argv.includes("--write") ||
    process.env.HUNCH_WRITE_ADMISSION_OPENAPI === "1"
  )
    writeFileSync(file, `${JSON.stringify(committed, null, 2)}\n`);
  console.log(
    "[funding-admission-openapi] six executable contracts verified without jobs/providers",
  );
} finally {
  await app.close();
}
