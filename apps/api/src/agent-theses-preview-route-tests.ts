import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerAdminAgentThesesRoutes } from "./routes/admin-agent-theses.js";
import { agentFixtureAuthors } from "./fixtures/agent-theses-authors.js";
import type { AgentPreview } from "./schemas/agent-preview.js";

const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(swagger, {
  openapi: { info: { title: "Preview contract", version: "1" } },
  transform: jsonSchemaTransform,
});
const userId = randomUUID(),
  adminId = randomUUID();
const report: AgentPreview = {
  runId: "a".repeat(64),
  userId,
  startedAt: new Date().toISOString(),
  completedAt: null,
  status: "running",
  stage: "loading",
  reason: null,
  diagnostics: [],
  models: { jev: "saved-jev", writer: "saved-writer" },
  candidateCount: 0,
  shortlistCount: 0,
  selection: null,
  angle: null,
  draftText: null,
  result: null,
  calls: [],
  cost: { actualUsd: 0, reservedUsd: 0 },
  budget: { limitUsd: 2, remainingUsd: 2, reservedUsd: 0, actualUsd: 0 },
};
let starts = 0;
registerAdminAgentThesesRoutes(app, {
  db: {
    query: async () => {
      throw new Error(
        "No database writes or reads expected in route contract test",
      );
    },
  },
  transact: async () => {
    throw new Error("Preview must not start a write transaction");
  },
  authorize: (permission) => async (req, reply) => {
    const allowed = String(req.headers["x-test-permissions"] ?? "").split(",");
    if (!allowed.includes(permission))
      return reply.code(allowed[0] ? 403 : 401).send({ error: "forbidden" });
    if (req.method !== "GET" && req.headers["x-csrf-token"] !== "csrf")
      return reply.code(403).send({ error: "admin_csrf_invalid" });
    req.adminActor = { kind: "admin_account", id: adminId };
  },
  preview: {
    budget: async () => report.budget,
    read: async (id) => {
      assert.equal(id, report.runId);
      return report;
    },
    start: async (actor, id, body) => {
      starts++;
      assert.equal(actor, adminId);
      assert.equal(id, userId);
      assert.equal(body.settings.style, "Unsaved");
      return report;
    },
  },
});
try {
  await app.ready();
  const root = "/admin/agent-theses",
    url = `${root}/authors/${userId}/preview`;
  const {
    userId: _id,
    enabled: _enabled,
    ...settings
  } = agentFixtureAuthors[0];
  const payload = {
    requestId: randomUUID(),
    settings: { ...settings, style: "Unsaved" },
  };
  const headers = {
    "x-test-permissions": "intel:read,intel:write,users:write",
    "x-csrf-token": "csrf",
  };
  assert.equal(
    (await app.inject({ method: "POST", url, payload })).statusCode,
    401,
  );
  for (const permission of ["intel:read", "intel:write", "users:write"])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          payload,
          headers: { ...headers, "x-test-permissions": permission },
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        payload,
        headers: { "x-test-permissions": headers["x-test-permissions"] },
      })
    ).statusCode,
    403,
  );
  for (const invalid of [
    { ...payload, policy: { previewDayBudgetUsd: 100 } },
    { ...payload, settings: { ...payload.settings, userId: randomUUID() } },
    { ...payload, requestId: "bad" },
  ])
    assert.equal(
      (await app.inject({ method: "POST", url, headers, payload: invalid }))
        .statusCode,
      400,
    );
  assert.equal(starts, 0);
  const started = await app.inject({ method: "POST", url, payload, headers });
  assert.equal(started.statusCode, 202, started.body);
  assert.equal(started.headers["cache-control"], "private, no-store");
  assert.equal(starts, 1);
  const read = await app.inject({
    url: `${root}/previews/${report.runId}`,
    headers: { "x-test-permissions": "intel:read" },
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["cache-control"], "private, no-store");
  assert.equal(read.json().shortlist, undefined, "old preview remains valid");
  report.retrieval = {
    poolCount: 120,
    semanticPoolCount: 60,
    cacheHits: 1,
    generated: 0,
    durationMs: 42,
  };
  report.shortlist = [
    {
      marketId: "test:crypto",
      title: "Bitcoin",
      eventTitle: "Crypto",
      category: "Crypto",
      semanticRank: 1,
    },
  ];
  report.reasonDetail =
    "No grounded opinion after considering the alternatives";
  report.writerCandidates = [{ marketId: "test:crypto", title: "Bitcoin" }];
  const enriched = await app.inject({
    url: `${root}/previews/${report.runId}`,
    headers: { "x-test-permissions": "intel:read" },
  });
  assert.deepEqual(enriched.json().shortlist, report.shortlist);
  assert.deepEqual(enriched.json().retrieval, report.retrieval);
  assert.equal(enriched.json().reasonDetail, report.reasonDetail);
  assert.deepEqual(enriched.json().writerCandidates, report.writerCandidates);
  assert.equal(
    (await app.inject({ url: `${root}/previews/${report.runId}` })).statusCode,
    401,
  );
  const paths = app.swagger().paths;
  const operation = JSON.stringify(paths?.[`${root}/authors/{userId}/preview`]);
  for (const field of [
    "202",
    "requestId",
    "styleExamples",
    "language",
    "draftText",
    "reservedUsd",
    "retrieval",
    "semanticRank",
  ])
    assert.ok(operation.includes(field), field);
  assert.ok(paths?.[`${root}/previews/{runId}`]);
  console.log(
    "Preview routes/OpenAPI: authorization, CSRF, draft validation and async polling contract passed.",
  );
} finally {
  await app.close();
}
