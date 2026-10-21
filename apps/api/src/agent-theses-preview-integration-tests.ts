// @requires-db @requires-redis
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRedisClient } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  AgentPreviewService,
  agentPreviewReadOnlyDb,
} from "./services/agent-theses-preview.js";
import {
  DEFAULT_AGENT_THESES_POLICY,
  agentAuthorSettingsSchema,
} from "./services/agent-theses-policy.js";
import { agentFixtureAuthors } from "./fixtures/agent-theses-authors.js";
import {
  AGENT_PREVIEW_PREFIX,
  AGENT_THESES_PREFIX,
  AgentRunState,
} from "./services/agent-theses-state.js";
import { resolveLimitlessPositionContract } from "./services/limitless-protocol-config.js";
import { type AgentPreview } from "./schemas/agent-preview.js";

assert.equal(process.env.HUNCH_AGENT_TEST_REDIS_URL, "redis://127.0.0.1:55477");
// Separate database from the scheduled-runner suite and old paid QA ledgers.
const redis = createRedisClient({
  url: `${process.env.HUNCH_AGENT_TEST_REDIS_URL}/2`,
});
await redis.connect();
assert.deepEqual(
  await redis.keys("*"),
  [],
  "preview test Redis DB2 must be empty",
);
const schema = `preview_test_${randomUUID().replaceAll("-", "")}`;
const setup = await createIntegrationTestPool({ max: 1 });
assert.match(schema, /^preview_test_[a-f0-9]{32}$/);
await setup.query(`create schema ${schema}`);
const pool = await createIntegrationTestPool({
  max: 3,
  options: `-c search_path=${schema},public`,
});
const tables = [
  "users",
  "runtime_policies",
  "unified_events",
  "unified_markets",
  "unified_tokens",
  "unified_token_top_latest",
  "ai_notes",
  "user_theses",
];
const userId = randomUUID(),
  adminId = randomUUID(),
  marketId = `preview:${randomUUID()}`,
  tokenId = `${marketId}:YES`;
const author = { ...agentFixtureAuthors[0], userId, enabled: false };
const { userId: _identity, enabled: _enabled, ...draftSettings } = author;
const settings = agentAuthorSettingsSchema.parse(draftSettings);
let mode = "publish",
  calls = 0,
  releaseGate: (() => void) | undefined;
let writerEffect: (() => Promise<void>) | undefined;
let seenStyle = "",
  seenLanguage = "",
  seenExamples = "";
const service = new AgentPreviewService({
  db: pool,
  redis: async () => redis,
  apiKey: "local-mocked-not-a-key",
  limitlessPositionContract: resolveLimitlessPositionContract(),
  fetchImpl: (async (url, init) => {
    calls++;
    assert.ok(String(url).startsWith("https://openrouter.ai/api/"));
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/decisions")) {
      if (mode === "hold")
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
      if (mode === "jev_error") throw new Error("mock_timeout");
      const market = mode === "none" ? "none" : "c0";
      return Response.json({
        model: DEFAULT_AGENT_THESES_POLICY.jevModel,
        usage: { cost: 0.001 },
        answers: {
          market: {
            type: "choice",
            choice: market,
            confidence: 1,
            probabilities: {
              c0: market === "c0" ? 1 : 0,
              none: market === "none" ? 1 : 0,
            },
          },
          angle: {
            type: "choice",
            choice: "mechanism",
            confidence: 1,
            probabilities: { mechanism: 1, countercase: 0, change: 0 },
          },
        },
      });
    }
    const context = JSON.parse(body.messages[1].content);
    seenStyle = context.author.style;
    seenLanguage = context.author.language;
    seenExamples = context.author.styleExamples;
    if (mode === "timeout") throw new Error("mock_timeout");
    if (writerEffect) await writerEffect();
    const candidate = context.candidates[0];
    const decision =
      mode === "skip"
        ? { decision: "skip", reason: "No supported distinct view" }
        : {
            decision: "publish",
            marketId:
              mode === "invalid_market" ? "not_supplied" : candidate.marketId,
            outcome: "YES",
            body: "<script>not executable</script> A deliberately opinionated local test thesis.",
            sourceIds: [
              mode === "invalid_sources"
                ? "unknown"
                : `market:${candidate.marketId}`,
            ],
            counterargument: "The exact deadline remains uncertain.",
            maxEntryPrice: "0.6",
            changeReason:
              mode === "missing_change"
                ? null
                : "New supplied evidence changes the previous view.",
          };
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(decision) },
        },
      ],
      usage: { cost: 0.01 },
    });
  }) as typeof fetch,
});
let policyId: string;
const policy = { ...DEFAULT_AGENT_THESES_POLICY, authors: [author] };
const wait = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const report = await service.read(id);
    if (report.status !== "running") return report;
    await delay(10);
  }
  throw new Error("preview_test_timeout");
};
const run = async () =>
  wait(
    (
      await service.start(adminId, userId, {
        requestId: randomUUID(),
        settings,
      })
    ).runId,
  );
const snapshot = async () => {
  const rows = [];
  for (const table of tables)
    rows.push(
      (
        await pool.query(
          `select to_jsonb(row_data) as data from ${table} row_data order by to_jsonb(row_data)::text`,
        )
      ).rows,
    );
  return JSON.stringify(rows);
};
try {
  for (const table of tables)
    await pool.query(
      `create table ${schema}.${table} (like public.${table} including all)`,
    );
  await pool.query(
    "insert into users(id,handle,display_name,is_agent,onboarding_version) values($1,'preview_fixture','Preview fixture',true,1)",
    [userId],
  );
  policyId = (
    await pool.query(
      "insert into runtime_policies(policy_key,effective_at,payload) values('agent_theses',now(),$1::jsonb) returning id",
      [JSON.stringify(policy)],
    )
  ).rows[0].id;
  await pool.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Political institutions','ACTIVE')",
    [marketId],
  );
  await pool.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,description,category,status,market_type,outcomes) values($1,'limitless',$1,$1,'Political agreement by deadline?','Only a signed agreement before the exact deadline counts.','Politics','ACTIVE','binary','[\"Agreement\",\"No agreement\"]')",
    [marketId],
  );
  await pool.query(
    "insert into unified_tokens(token_id,venue,market_id,side) values($1,'limitless',$2,'YES')",
    [tokenId, marketId],
  );
  await pool.query(
    "insert into unified_token_top_latest(token_id,venue,ts,best_ask) values($1,'limitless',clock_timestamp(),'0.5')",
    [tokenId],
  );
  await pool.query(
    "insert into ai_notes(note_key,note_type,status,title,description,source_kind,source_id,producer_type,producer_run_id) values($1,'signal','active','Saved context','A signed agreement still requires implementation.','market',$1,'map_signals',$1)",
    [marketId],
  );
  const readOnly = agentPreviewReadOnlyDb(pool);
  assert.equal(
    (await readOnly.query("show transaction_read_only")).rows[0]
      .transaction_read_only,
    "on",
  );
  await assert.rejects(
    readOnly.query("update users set display_name='forbidden' where id=$1", [
      userId,
    ]),
    { code: "25006" },
  );
  const productionState = new AgentRunState(redis, "cron-fixture");
  assert.ok(await productionState.acquire());
  await productionState.reserve("cron-fixture:call", 2, 2); // Fully spent cron budget must not block preview.
  await productionState.saveCursor({ node: 3, event: 4 }, userId);
  await productionState.considered(userId, [marketId]);
  const originalCursor = await redis.get(
    `${AGENT_THESES_PREFIX}:cursor:${userId}`,
  );
  const originalConsidered = await redis.zRangeWithScores(
    `${AGENT_THESES_PREFIX}:considered:${userId}`,
    0,
    -1,
  );
  settings.style = "Несохранённый язвительный стиль";
  settings.language = "Русский";
  settings.styleExamples = "Пример: красивый заголовок не равен договору.";
  const before = await snapshot();
  mode = "hold";
  const request = { requestId: randomUUID(), settings };
  const [first, duplicate] = await Promise.all([
    service.start(adminId, userId, request),
    service.start(adminId, userId, request),
  ]);
  assert.equal(first.runId, duplicate.runId);
  await assert.rejects(
    service.start(adminId, userId, { requestId: randomUUID(), settings }),
    /preview_busy/,
  );
  await assert.rejects(
    service.start(adminId, userId, {
      ...request,
      settings: { ...settings, style: "Different" },
    }),
    /preview_request_conflict/,
  );
  while (!releaseGate) await delay(5);
  releaseGate();
  const success = await wait(first.runId);
  assert.equal(success.status, "complete");
  assert.equal(success.shortlist?.length, success.shortlistCount);
  assert.equal(success.shortlist?.[0].marketId, marketId);
  assert.equal(
    success.retrieval?.generated,
    0,
    "missing optional index incurs no embedding call",
  );
  assert.equal(success.retrieval?.poolCount, 1);
  assert.equal(success.reason, null);
  assert.equal(success.result?.simulation?.shares, "200");
  assert.equal(success.result?.outcomeLabel, "Agreement");
  assert.equal(success.cost.actualUsd, 0.011);
  assert.equal(success.cost.reservedUsd, 0);
  assert.equal(seenStyle, settings.style);
  assert.equal(seenLanguage, settings.language);
  assert.equal(seenExamples, settings.styleExamples);
  assert.equal(
    (await service.start(adminId, userId, request)).runId,
    first.runId,
  );
  assert.equal(calls, 2);
  assert.equal(
    await snapshot(),
    before,
    "preview leaves every SQL fixture row byte-identical",
  );
  assert.equal(
    await redis.get(`${AGENT_THESES_PREFIX}:cursor:${userId}`),
    originalCursor,
  );
  assert.deepEqual(
    await redis.zRangeWithScores(
      `${AGENT_THESES_PREFIX}:considered:${userId}`,
      0,
      -1,
    ),
    originalConsidered,
  );
  assert.equal(await redis.get(`${AGENT_THESES_PREFIX}:lock`), "cron-fixture");
  assert.equal(
    await redis.hGet(`${AGENT_THESES_PREFIX}:costs`, "cron-fixture:call"),
    "20000000000",
  );
  assert.equal(await redis.exists(`${AGENT_THESES_PREFIX}:runs`), 0);
  for (const [scenario, reason] of [
    ["none", "jev_none"],
    ["skip", "writer_skip"],
    ["invalid_market", "writer_invalid_market_or_side"],
    ["invalid_sources", "writer_invalid_sources"],
  ]) {
    mode = scenario;
    const result = await run();
    assert.equal(result.reason, reason);
    if (scenario === "invalid_sources")
      assert.ok(
        result.result?.body,
        "invalid references retain safe text, not fabricated source URLs",
      );
  }
  mode = "jev_error";
  const fallback = await run();
  assert.ok(fallback.result?.simulation);
  assert.ok(fallback.diagnostics.includes("jev_fallback:mock_timeout"));
  mode = "publish";
  writerEffect = async () => {
    await pool.query(
      "update unified_token_top_latest set best_ask='0.9' where token_id=$1",
      [tokenId],
    );
  };
  const moved = await run();
  assert.equal(moved.reason, "price_changed");
  assert.ok(moved.result?.body);
  assert.equal(moved.result?.simulation, null);
  await pool.query(
    "update unified_token_top_latest set best_ask='0.5' where token_id=$1",
    [tokenId],
  );
  writerEffect = async () => {
    await pool.query(
      "update unified_token_top_latest set ts=clock_timestamp()-interval '1 hour' where token_id=$1",
      [tokenId],
    );
  };
  const staleAfterWriting = await run();
  assert.equal(staleAfterWriting.reason, "stale_quote");
  assert.ok(staleAfterWriting.draftText);
  await pool.query(
    "update unified_token_top_latest set ts=clock_timestamp() where token_id=$1",
    [tokenId],
  );
  writerEffect = async () => {
    await pool.query("delete from unified_tokens where token_id=$1", [tokenId]);
  };
  const changedInstrument = await run();
  assert.equal(changedInstrument.reason, "instrument_changed");
  assert.equal(changedInstrument.result?.simulation, null);
  await pool.query(
    "insert into unified_tokens(token_id,venue,market_id,side) values($1,'limitless',$2,'YES')",
    [tokenId, marketId],
  );
  writerEffect = undefined;
  await pool.query(
    "update unified_token_top_latest set best_ask='0.5',ts=clock_timestamp()-interval '1 hour' where token_id=$1",
    [tokenId],
  );
  const oldCalls = calls;
  assert.equal((await run()).reason, "no_candidates");
  assert.equal(calls, oldCalls);
  await pool.query(
    "update unified_token_top_latest set ts=clock_timestamp() where token_id=$1",
    [tokenId],
  );
  // Seed a recent paper thesis: preview ignores cooldown but still checks exact-contract updates.
  await pool.query(
    "insert into user_theses(author_id,canonical_purchase_key,market_id,event_id,token_id,outcome,instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash,purchase_mode) values($1,'paper:fixture',$2,$2,$3,'YES','fixture','Previous public view','{}','fixture',100,'fixture','fixture','paper')",
    [userId, marketId, tokenId],
  );
  mode = "missing_change";
  const missing = await run();
  assert.equal(missing.reason, "writer_missing_change");
  assert.ok(missing.result?.body);
  assert.equal(missing.result?.simulation, null);
  mode = "publish";
  assert.ok(
    (await run()).result?.simulation,
    "a valid update can preview during publication cooldown",
  );
  await pool.query("update users set social_suspended_at=now() where id=$1", [
    userId,
  ]);
  await assert.rejects(run(), /agent_unavailable/);
  await pool.query("update users set social_suspended_at=null where id=$1", [
    userId,
  ]);
  await pool.query(
    "update runtime_policies set payload=jsonb_set(payload,'{previewDayBudgetUsd}','0.0001') where id=$1",
    [policyId],
  );
  await assert.rejects(run(), /agent_budget_exhausted/);
  await pool.query(
    "update runtime_policies set payload=jsonb_set(payload,'{previewDayBudgetUsd}','2') where id=$1",
    [policyId],
  );
  mode = "timeout";
  const timeout = await run();
  assert.equal(timeout.status, "failed");
  assert.ok(timeout.cost.reservedUsd > 0);
  assert.equal(timeout.cost.actualUsd, 0.001);
  // Simulate executor disappearance after a paid reservation. A new API instance must not rerun it.
  const orphanId = "a".repeat(64),
    orphan = new AgentRunState(redis, orphanId, AGENT_PREVIEW_PREFIX);
  const orphanReport: AgentPreview = {
    ...success,
    runId: orphanId,
    status: "running",
    stage: "writing",
    completedAt: null,
    calls: [],
    result: null,
  };
  assert.ok(
    await orphan.acquire({
      key: `${AGENT_PREVIEW_PREFIX}:run:${orphanId}`,
      value: JSON.stringify({ ...orphanReport, requestHash: "orphan" }),
      ttlSeconds: 86400,
    }),
  );
  await orphan.reserve(`${orphanId}:1:writer`, 0.1, 2, { stage: "writer" });
  await orphan.close();
  const restarted = new AgentPreviewService({
    db: pool,
    redis: async () => redis,
    apiKey: "unused",
  });
  const interrupted = await restarted.read(orphanId);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.cost.reservedUsd, 0.1);
  await restarted.close();
  mode = "publish";
  writerEffect = async () => {
    await redis.del(`${AGENT_PREVIEW_PREFIX}:lock`);
  };
  const lostLease = await run();
  assert.equal(lostLease.status, "interrupted");
  assert.equal(lostLease.reason, "preview_interrupted");
  assert.ok(
    lostLease.cost.actualUsd > 0,
    "completed provider response remains charged after lost lease",
  );
  await productionState.close();
  console.log(
    "Agent preview PG16/Redis integration passed: read-only, separate budget/lease, drafts, idempotence, recovery.",
  );
} finally {
  releaseGate?.();
  await service.close();
  const keys = await redis.keys("*");
  assert.ok(
    keys.every((key) => key.startsWith(AGENT_THESES_PREFIX)),
    "cleanup only isolated preview/cron test keys",
  );
  if (keys.length) await redis.del(keys);
  await redis.quit();
  await pool.end();
  // Exact, generated schema; never a public-schema cleanup.
  assert.equal(
    (
      await setup.query("select nspname from pg_namespace where nspname=$1", [
        schema,
      ])
    ).rows[0]?.nspname,
    schema,
  );
  await setup.query(`drop schema ${schema} cascade`);
  await setup.end();
}
