// @requires-db @requires-redis
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRedisClient } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  contextTestCandidate,
  contextTestDecision,
  contextTestNow,
} from "./holder-context-test-fixtures.js";
import {
  buildHolderContextFacts,
  buildHolderResearchThesisKey,
  buildHolderResearchDecisionCacheKey,
  holderContextFactsUnchanged,
  loadHolderContextBaselines,
  persistHolderResearchPublicContext,
} from "./services/holder-research.js";
import { getIntelPolicyDefaults } from "./services/runtime-policies.js";
import { maybeWriteDecisionCache } from "./ai-holder-research-run.js";

assert.equal(
  process.env.HUNCH_TEST_EXPECT_DATABASE,
  "hunch_intel_test_20261029",
);
assert.equal(
  process.env.HUNCH_DISCOVERY_TEST_REDIS_URL,
  "redis://127.0.0.1:6380",
);
const pool = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=15000 -c lock_timeout=2000",
});
const redis = createRedisClient({
  url: process.env.HUNCH_DISCOVERY_TEST_REDIS_URL,
});
await redis.connect();
const client = await pool.connect(),
  second = await pool.connect();
const policy = { ...getIntelPolicyDefaults("holder_research"), dryRun: false };
const runId = `context-test:${randomUUID()}`;
const candidate = contextTestCandidate(`polymarket:${runId}`);
const facts = buildHolderContextFacts({
  candidate,
  policy,
  externalResearch: null,
  now: contextTestNow,
});
const decision = contextTestDecision(candidate);
const persist = (
  connection = client,
  suffix = "1",
  update = decision,
  baseline = facts,
) =>
  persistHolderResearchPublicContext(connection, {
    runnerRunId: `${runId}:${suffix}`,
    decision: update,
    policy,
    contextFacts: baseline,
  });
try {
  assert.match(
    String((await client.query("select version()")).rows[0].version),
    /PostgreSQL 16/,
  );
  // Real table definitions and constraints, in the explicitly guarded test DB.
  await client.query(
    readFileSync(
      new URL(
        "../../../packages/db/migrations/0079_ai_notes.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const rows = () =>
    client.query(
      "select id,status,created_at,updated_at,metrics from ai_notes where source_id=$1 order by created_at,id",
      [candidate.market.marketId],
    );
  const initial = await Promise.all([
    persist(client, "1"),
    persist(
      second,
      "2",
      contextTestDecision(candidate, "Same holding, differently phrased."),
    ),
  ]);
  assert.deepEqual(initial.sort(), ["persisted", "unchanged"]);
  const before = (await rows()).rows;
  assert.equal(before.length, 1);
  const loaded = await loadHolderContextBaselines(client, [
    candidate.market.marketId,
  ]);
  assert.equal(
    holderContextFactsUnchanged(loaded.get(candidate.thesisKey), facts, policy),
    true,
  );
  assert.equal(
    await persist(
      client,
      "3",
      contextTestDecision(
        candidate,
        "Another paraphrase, without changed facts.",
      ),
    ),
    "unchanged",
  );
  assert.deepEqual(
    (await rows()).rows,
    before,
    "no new row, timestamps or ordering for paraphrases",
  );
  // Legacy/incomplete metadata repairs after one ordinary analysis, not another post.
  for (const bad of [
    { ...facts, complete: false },
    { ...facts, snapshot: {} },
    { ...facts, version: 0 },
  ]) {
    await client.query(
      "update ai_notes set metrics=jsonb_set(metrics,'{contextFactsV1}',$2::jsonb) where id=$1",
      [before[0].id, JSON.stringify(bad)],
    );
    // Use exact originally persisted prose, whichever concurrent writer won.
    const saved = (
      await client.query("select title,description from ai_notes where id=$1", [
        before[0].id,
      ])
    ).rows[0];
    const same = contextTestDecision(candidate, saved.description);
    assert.ok(same.output.public_context);
    same.output.public_context.headline = saved.title;
    assert.equal(
      await persist(client, `repair:${randomUUID()}`, same),
      "unchanged",
    );
    assert.equal((await rows()).rows.length, 1);
    assert.equal(
      holderContextFactsUnchanged(
        (await rows()).rows[0].metrics.contextFactsV1,
        facts,
        policy,
      ),
      true,
    );
    assert.deepEqual((await rows()).rows[0].created_at, before[0].created_at);
  }
  const changed = structuredClone(candidate);
  changed.market.yesProbability = 0.8;
  const changedFacts = buildHolderContextFacts({
    candidate: changed,
    policy,
    externalResearch: null,
    now: contextTestNow,
  });
  const originalSummary = (
    await client.query("select description from ai_notes where id=$1", [
      before[0].id,
    ])
  ).rows[0].description;
  assert.equal(
    await persist(
      client,
      "same-conclusion",
      contextTestDecision(changed, originalSummary),
      changedFacts,
    ),
    "unchanged",
  );
  assert.equal(
    holderContextFactsUnchanged(
      (await rows()).rows[0].metrics.contextFactsV1,
      changedFacts,
      policy,
    ),
    true,
    "material change analyzed with same conclusion updates only comparison metadata",
  );
  const nextFacts = { ...changedFacts, sources: "a".repeat(64) };
  assert.equal(
    await persist(
      client,
      "changed",
      contextTestDecision(changed, "The price has materially changed."),
      nextFacts,
    ),
    "persisted",
  );
  assert.equal(
    (await rows()).rows.filter((r) => r.status === "active").length,
    1,
  );
  const opposite = structuredClone(candidate);
  opposite.side = "NO";
  opposite.thesisKey = buildHolderResearchThesisKey(
    opposite.market.marketId,
    "NO",
  );
  const oppositeFacts = buildHolderContextFacts({
    candidate: opposite,
    policy,
    externalResearch: null,
    now: contextTestNow,
  });
  assert.equal(
    await persist(
      client,
      "opposite",
      contextTestDecision(opposite),
      oppositeFacts,
    ),
    "persisted",
  );
  assert.equal(
    (await rows()).rows.filter((r) => r.status === "active").length,
    2,
    "opposite contracts are not superseded",
  );
  const stats = {
    enabled: true,
    status: "ok" as const,
    checked: 0,
    skipped: 0,
    rechecked: 0,
    written: 0,
    errors: 0,
    dryRun: false,
  };
  const params = {
    redis,
    policy,
    callModel: true,
    candidate,
    output: { status: "CONTEXT" as const, rationale: "holder_disagreement" },
    decisionCache: stats,
  };
  await maybeWriteDecisionCache(params);
  // Force an actual write failure after lock/read, and prove rollback/retry.
  await client.query("set default_transaction_read_only=on");
  try {
    await assert.rejects(
      persist(
        client,
        "retry",
        contextTestDecision(changed, "Retry after storage error."),
        { ...changedFacts, sources: "f".repeat(64) },
      ),
      /read-only transaction/,
    );
  } finally {
    await client.query("set default_transaction_read_only=off");
  }
  await maybeWriteDecisionCache({ ...params, technicalFailure: true });
  assert.equal(
    await redis.get(buildHolderResearchDecisionCacheKey(candidate.thesisKey)),
    null,
  );
  assert.equal(
    await persist(
      client,
      "retry",
      contextTestDecision(changed, "Retry after storage error."),
      { ...changedFacts, sources: "f".repeat(64) },
    ),
    "persisted",
  );
  assert.equal(stats.written, 1);
  await client.query(
    `insert into ai_notes(note_key,note_type,title,description,source_kind,source_id,producer_type,producer_run_id,lineage,created_at)
    values($1,'signal','New signal','New evidence','market',$2,'holder_research',$3,'{"side":"YES"}',now()+interval '1 second')`,
    [`${runId}:signal`, candidate.market.marketId, runId],
  );
  assert.equal(
    (await loadHolderContextBaselines(client, [candidate.market.marketId])).has(
      candidate.thesisKey,
    ),
    false,
    "a newer active signal masks an older context for the same side",
  );
  assert.equal((await loadHolderContextBaselines(client, [])).size, 0);
  console.log(
    "[holder-context-integration-tests] PG16 concurrent paraphrase dedup, source/price/side revisions, metadata repair, rollback and Redis retry passed",
  );
} finally {
  client.release();
  second.release();
  await pool.end();
  await redis.quit();
}
