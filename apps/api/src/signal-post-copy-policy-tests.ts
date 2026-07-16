import assert from "node:assert/strict";

import {
  clearSignalPostCopyPolicyCache,
  DEFAULT_SIGNAL_POST_COPY_POLICY,
  resolveSignalPostCopyPolicy,
} from "./services/signal-post-copy-policy.js";

type PolicyDb = Parameters<typeof resolveSignalPostCopyPolicy>[0];

async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function dbWithPayload(payload: unknown): PolicyDb {
  return {
    query: async () => ({
      rows:
        payload == null
          ? []
          : [
              {
                id: "00000000-0000-4000-8000-000000000001",
                policy_key: "signal_post_copy",
                effective_at: new Date("2026-01-01T00:00:00.000Z"),
                payload,
                created_by: null,
                created_at: new Date("2026-01-01T00:00:00.000Z"),
              },
            ],
    }),
  } as unknown as PolicyDb;
}

await test("signal post copy policy uses a complete valid DB snapshot", async () => {
  const db = dbWithPayload({
    ...DEFAULT_SIGNAL_POST_COPY_POLICY,
    materialNetFlowUsd: 12_000,
  });
  const resolved = await resolveSignalPostCopyPolicy(db);
  assert.equal(resolved.source, "db");
  assert.equal(resolved.invalidOverride, false);
  assert.equal(resolved.policy.materialNetFlowUsd, 12_000);
  assert.equal(resolved.effectiveAt, "2026-01-01T00:00:00.000Z");
});

await test("signal post copy policy fails invalid overrides to compiled defaults", async () => {
  const db = dbWithPayload({
    ...DEFAULT_SIGNAL_POST_COPY_POLICY,
    minimumPriceMoveCents: 8,
    strongPriceMoveCents: 5,
  });
  const resolved = await resolveSignalPostCopyPolicy(db);
  assert.equal(resolved.source, "default");
  assert.equal(resolved.invalidOverride, true);
  assert.deepEqual(resolved.policy, DEFAULT_SIGNAL_POST_COPY_POLICY);
});

await test("signal post copy policy caches by DB dependency", async () => {
  let queries = 0;
  const db = {
    query: async () => {
      queries += 1;
      return { rows: [] };
    },
  } as unknown as PolicyDb;
  await resolveSignalPostCopyPolicy(db);
  await resolveSignalPostCopyPolicy(db);
  assert.equal(queries, 1);
  clearSignalPostCopyPolicyCache(db);
  await resolveSignalPostCopyPolicy(db);
  assert.equal(queries, 2);
});
