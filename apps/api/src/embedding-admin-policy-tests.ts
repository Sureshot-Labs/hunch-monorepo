import assert from "node:assert/strict";
import { DEFAULT_EMBEDDING_POLICY } from "@hunch/embeddings";
import { adminIntelPolicyParamsSchema } from "./schemas/admin.js";
import { parseAdminEmbeddingStatus } from "./services/admin-embeddings-status.js";
import {
  getIntelPolicyDefaults,
  getIntelPolicySchema,
  resolveIntelPolicy,
} from "./services/runtime-policies.js";

const schema = getIntelPolicySchema("ai_embeddings");
assert.deepEqual(schema.parse({}), {});
assert.deepEqual(schema.parse({ model: "qwen/qwen3-embedding-8b" }), {
  model: "qwen/qwen3-embedding-8b",
});
assert.equal(
  adminIntelPolicyParamsSchema.safeParse({ key: "ai_embeddings" }).success,
  true,
);
assert.deepEqual(
  getIntelPolicyDefaults("ai_embeddings"),
  DEFAULT_EMBEDDING_POLICY,
);
for (const payload of [
  { model: "unsupported/model" },
  { dimensions: 4096 },
  { textVersion: "unknown" },
  { generationBudgetUsd: -1 },
  { requestTimeoutMs: 0 },
  { ignoredUnknownField: true },
]) {
  assert.equal(schema.safeParse(payload).success, false);
}

function policyDb(payload: unknown, exists = true) {
  return {
    query: async () => ({
      rows: exists
        ? [
            {
              id: "fixture",
              policy_key: "ai_embeddings",
              effective_at: new Date("2026-09-20T22:00:00Z"),
              created_at: new Date("2026-09-20T22:00:00Z"),
              payload,
            },
          ]
        : [],
    }),
  } as unknown as Parameters<typeof resolveIntelPolicy>[0];
}

const defaults = await resolveIntelPolicy(
  policyDb(null, false),
  "ai_embeddings",
);
assert.equal(defaults.source, "default");
assert.equal(defaults.invalidOverride, false);
const changed = await resolveIntelPolicy(
  policyDb({ model: "qwen/qwen3-embedding-8b" }),
  "ai_embeddings",
);
assert.equal(changed.source, "db");
assert.equal(changed.effective.model, "qwen/qwen3-embedding-8b");
assert.equal(changed.effective.dimensions, 1024);
assert.equal(changed.effective.batchSize, 64);
const invalid = await resolveIntelPolicy(
  policyDb({ model: "unsupported/model" }),
  "ai_embeddings",
);
assert.equal(
  invalid.invalidOverride,
  true,
  "invalid transition cannot be presented as valid defaults",
);

assert.deepEqual(parseAdminEmbeddingStatus(null), {
  status: null,
  error: null,
});
for (const raw of [
  "{",
  "null",
  "{}",
  '{"state":"ready"}',
  '{"state":"active","budget":{"limitUsd":5,"spentUsd":-1,"reservedUsd":0}}',
]) {
  assert.equal(parseAdminEmbeddingStatus(raw).status, null);
  assert.ok(parseAdminEmbeddingStatus(raw).error);
}
const report = {
  state: "building",
  activeGeneration: "legacy-e5",
  desiredGeneration: "clean-e5",
  verifiedAt: null,
  coverage: {
    events: { eligible: 100, verified: 75, missing: 25 },
    markets: { eligible: 1000, verified: 0, missing: 1000 },
  },
};
assert.deepEqual(parseAdminEmbeddingStatus(JSON.stringify(report)), {
  status: report,
  error: null,
});
for (const actualUsd of [null, 0, 0.032]) {
  const telemetry = {
    ...report,
    budget: {
      limitUsd: 5,
      spentUsd: 0.5,
      reservedUsd: 0.1,
      actualUsd,
      remainingUsd: 4.5,
    },
    memory: {
      redisUsedBytes: 1024,
      workerAvailableBytes: 4096,
      projectedBytes: 4096.5,
      workerRssBytes: 512,
      redisRssBytes: 2048,
      redisPersistenceActive: false,
    },
  };
  assert.deepEqual(parseAdminEmbeddingStatus(JSON.stringify(telemetry)), {
    status: telemetry,
    error: null,
  });
}
for (const actualUsd of [-1, "0.1"]) {
  const telemetry = {
    ...report,
    budget: { limitUsd: 5, spentUsd: 0.5, reservedUsd: 0, actualUsd },
  };
  assert.equal(
    parseAdminEmbeddingStatus(JSON.stringify(telemetry)).status,
    null,
  );
}
assert.ok(
  parseAdminEmbeddingStatus(
    '{"state":"active","budget":{"limitUsd":5,"spentUsd":0,"reservedUsd":0,"actualUsd":1e999}}',
  ).error,
);
console.log("embedding admin policy tests passed");
