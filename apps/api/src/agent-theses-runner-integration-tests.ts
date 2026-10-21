import {
  agentFixtureAuthors,
  agentFixtureProfiles,
} from "./fixtures/agent-theses-authors.js";
// @requires-db @requires-redis
import assert from "node:assert/strict";
import { agentScreenFixture } from "./fixtures/agent-theses-screening.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRedisClient, type Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { runAgentTheses } from "./services/agent-theses-runner.js";
import {
  AgentRunState,
  AGENT_THESES_PREFIX,
} from "./services/agent-theses-state.js";
import { DEFAULT_AGENT_THESES_POLICY } from "./services/agent-theses-policy.js";
import { provisionAgentAuthors } from "./services/agent-theses-provision.js";
import { resolveLimitlessPositionContract } from "./services/limitless-protocol-config.js";
import { agentHistoricalContracts } from "./fixtures/agent-theses-history.js";
import {
  marketMapActiveKey,
  marketMapRunNodesGlobalKey,
  marketMapRunNodeEventsKey,
} from "./services/market-map.js";
import {
  loadAgentMarketPool,
  loadAgentCandidates,
  enrichAgentSelectedContext,
} from "./services/agent-theses-context.js";
import { EMBEDDING_ACTIVE_KEY } from "@hunch/embeddings";
import type { AgentModelClient } from "./services/agent-theses-model.js";
import { SocialService } from "./services/social-service.js";

// This suite is deliberately fenced to its disposable local Redis, never repository REDIS_URL.
const redisUrl = process.env.HUNCH_AGENT_TEST_REDIS_URL;
assert.equal(redisUrl, "redis://127.0.0.1:55477");
const redis = createRedisClient({ url: redisUrl });
await redis.connect();
const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
let depth = 0;
const readQueries = new Map<string, { sql: string; values: unknown[] }>();
const session = {
  query: async (sql: string, values: unknown[] = []) => {
    if (sql.toLowerCase() === "begin")
      return client.query(`savepoint runner_test_${++depth}`);
    if (sql.toLowerCase() === "commit")
      return client.query(`release savepoint runner_test_${depth--}`);
    if (sql.toLowerCase() === "rollback") {
      await client.query(`rollback to savepoint runner_test_${depth}`);
      return client.query(`release savepoint runner_test_${depth--}`);
    }
    if (
      /^\s*(select|with)\b/i.test(sql) &&
      !/\b(insert|update|delete|pg_advisory)/i.test(sql)
    ) {
      const previous = readQueries.get(sql);
      if (
        !previous ||
        JSON.stringify(values).length > JSON.stringify(previous.values).length
      )
        readQueries.set(sql, { sql, values });
    }
    return client.query(sql, values);
  },
  release: () => {},
};
const db = {
  query: session.query,
  connect: async () => session,
} as unknown as Pool;
const prefix = `agents-test:${randomUUID()}`;
const mapId = prefix;
const modelCalls: Array<{ stage: string; input: Record<string, unknown> }> = [];
try {
  await client.query("begin");
  await client.query("set local statement_timeout='10s'");
  const agents = await provisionAgentAuthors(db, agentFixtureProfiles, true);
  const policy = structuredClone({
    ...DEFAULT_AGENT_THESES_POLICY,
    authors: agentFixtureAuthors,
  });
  policy.enabled = true;
  for (let i = 0; i < 3; i++) {
    const id = agents.authors[i].userId;
    assert.ok(id);
    policy.authors[i].userId = id;
  }
  // Starter slots do not restrict categories: deliberately swap their topics.
  policy.authors[0].interests = agentFixtureAuthors[1].interests;
  policy.authors[1].interests = agentFixtureAuthors[0].interests;
  await db.query(
    "insert into runtime_policies(policy_key,effective_at,payload) values('agent_theses',now(),$1::jsonb)",
    [JSON.stringify(policy)],
  );
  const eventId = `${prefix}:event`;
  await db.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Saved contracts','ACTIVE')",
    [eventId],
  );
  for (const [i, fixture] of agentHistoricalContracts.entries()) {
    const id = `${prefix}:${String(i).padStart(4, "0")}`,
      token = `${id}:YES`;
    await db.query(
      "insert into unified_markets(id,venue,venue_market_id,event_id,title,description,category,status,market_type,outcomes) values($1,'limitless',$1,$2,$3,$4,$5,'ACTIVE','binary','[\"Yes\",\"No\"]')",
      [id, eventId, fixture.title, fixture.condition, fixture.category],
    );
    await db.query(
      "insert into unified_tokens(token_id,venue,market_id,side) values($1,'limitless',$2,'YES')",
      [token, id],
    );
    await db.query(
      "insert into unified_token_top_latest(token_id,venue,ts,best_ask) values($1,'limitless',clock_timestamp(),'0.5')",
      [token],
    );
  }
  const evidenceKey = `ai:map_search:v1:evidence:${prefix}`;
  await db.query(
    `insert into ai_notes(note_key,note_type,status,title,description,source_kind,source_id,producer_type,producer_run_id,metrics,model_meta)
     values($1,'context','active','Saved public context','Prior interpretation, not independent evidence.','market',$2,'holder_research',$1,$3::jsonb,$4::jsonb)`,
    [
      prefix,
      `${prefix}:0000`,
      JSON.stringify({
        publicContextV1: {
          caveats: ["A social-media remark is not an agreement."],
        },
      }),
      JSON.stringify({
        public_source_citations: [
          {
            title: "Saved report",
            url: "https://example.org/report",
            publishedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      }),
    ],
  );
  await redis.zAdd("ai:map_search:v1:recent_evidence", [
    { value: prefix, score: Date.now() },
  ]);
  await redis.set(
    evidenceKey,
    JSON.stringify({
      headline: agentHistoricalContracts[0].title,
      summary: "Saved context; not a new live search.",
      publishedAt: new Date(Date.now() - 60_000).toISOString(),
      sourceUrl: "https://example.org/saved-report",
      confirmation: "unconfirmed",
      sourceTier: "social",
    }),
  );
  // A missing/unreadable vector generation still permits lexical saved-news context.
  const withoutVectors = new Proxy(redis, {
    get(target, property) {
      if (property === "get")
        return async (key: string) => {
          if (key === EMBEDDING_ACTIVE_KEY)
            throw new Error("test_vectors_unavailable");
          return target.get(key);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const advancingQuoteDb = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith("select m.*,e.title as event_title")) {
        await delay(10);
        await db.query(
          "update unified_token_top_latest set ts=$2 where token_id=$1",
          [`${prefix}:0000:YES`, new Date()],
        );
      }
      return db.query(sql, values);
    },
  } as unknown as Pool;
  const contextInput = {
    db: advancingQuoteDb,
    redis: withoutVectors,
    marketIds: [`${prefix}:0000`],
    maxQuoteAgeSeconds: 900,
    limitlessPositionContract: resolveLimitlessPositionContract(),
  };
  const completeRules = `${"Historical rule detail. ".repeat(160)}Final rule: runoff ballots count; announcements alone do not qualify.`;
  await db.query("update unified_markets set description=$2 where id=$1", [
    `${prefix}:0000`,
    completeRules,
  ]);
  const historicalNow = new Date();
  const background = await loadAgentCandidates(contextInput);
  assert.equal(background.candidates[0].condition, completeRules);
  assert.equal(
    background.candidates.length,
    1,
    "live quote during hydration remains eligible",
  );
  assert.equal(
    (await loadAgentCandidates({ ...contextInput, now: historicalNow }))
      .candidates.length,
    0,
    "an explicit historical clock still excludes later quotes",
  );
  assert.ok(
    background.candidates[0].sources.some(
      (source) => source.id === `news:${prefix}`,
    ),
  );
  const savedNews = background.candidates[0].sources.find(
    (source) => source.id === `news:${prefix}`,
  );
  assert.equal(savedNews?.confirmation, "unconfirmed");
  assert.equal(savedNews?.sourceTier, "social");
  const savedContext = background.candidates[0].sources.find(
    (source) => source.kind === "hunch_analysis",
  );
  assert.deepEqual(savedContext?.caveats, [
    "A social-media remark is not an agreement.",
  ]);
  assert.equal(
    savedContext?.citedSources?.[0].url,
    "https://example.org/report",
  );
  assert.ok(background.diagnostics.includes("stored_news_vectors_unavailable"));
  // Venue rules can live in metadata (e.g. DFlow), with no description. They
  // are valid context, including secondary/early-close rules, not a missing-rule skip.
  const originalContextRow = (
    await db.query(
      "select description,metadata from unified_markets where id=$1",
      [`${prefix}:0000`],
    )
  ).rows[0];
  await db.query(
    "update unified_markets set description=null,metadata=$2::jsonb where id=$1",
    [
      `${prefix}:0000`,
      JSON.stringify({
        ...originalContextRow.metadata,
        rulesPrimary: "Exact settlement",
        rulesSecondary: "Secondary rule",
        earlyCloseCondition: "Early closure",
      }),
    ],
  );
  assert.equal(
    (await loadAgentCandidates(contextInput)).candidates[0].condition,
    "Exact settlement\n\nSecondary rule\n\nEarly closure",
  );
  await db.query(
    "update unified_markets set metadata='{}'::jsonb where id=$1",
    [`${prefix}:0000`],
  );
  const missingCondition = await loadAgentCandidates(contextInput);
  assert.equal(missingCondition.candidates.length, 0);
  assert.ok(
    missingCondition.diagnostics.includes(
      `candidate_excluded:${prefix}:0000:missing_condition`,
    ),
  );
  await db.query(
    "update unified_markets set description=$2,metadata=$3::jsonb where id=$1",
    [
      `${prefix}:0000`,
      originalContextRow.description,
      JSON.stringify(originalContextRow.metadata),
    ],
  );
  assert.equal(
    (await loadAgentCandidates(contextInput)).candidates.length,
    1,
    "fixed condition is eligible on the next run without a stale skip marker",
  );
  // Rotation must eventually see >120 low-activity markets, without a volume threshold.
  for (let i = 3; i < 133; i++)
    await db.query(
      "insert into unified_markets(id,venue,venue_market_id,event_id,title,description,status,market_type) values($1,'limitless',$1,$2,'Small market','Fixture resolves YES when the specified event occurs before its deadline.','ACTIVE','binary')",
      [`${prefix}:${String(i).padStart(4, "0")}`, eventId],
    );
  await redis.set(marketMapActiveKey(), mapId);
  await redis.set(
    marketMapRunNodesGlobalKey(mapId),
    JSON.stringify([{ id: "leaf", childIds: [] }]),
  );
  await redis.set(
    marketMapRunNodeEventsKey(mapId, "leaf"),
    JSON.stringify([{ eventId }]),
  );
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const selected = await loadAgentMarketPool(db, redis, 120);
    for (const id of selected.marketIds)
      if (id.startsWith(prefix)) seen.add(id);
    await redis.set(
      `${AGENT_THESES_PREFIX}:cursor`,
      JSON.stringify(selected.cursor),
    );
    if (i === 0) {
      // A rebuilt snapshot must not lose the tail of an event already being paged.
      await redis.set(marketMapActiveKey(), `${mapId}:rebuilt`);
      await redis.set(
        marketMapRunNodesGlobalKey(`${mapId}:rebuilt`),
        JSON.stringify([{ id: "leaf", childIds: [] }]),
      );
      await redis.set(
        marketMapRunNodeEventsKey(`${mapId}:rebuilt`, "leaf"),
        JSON.stringify([{ eventId }]),
      );
    }
  }
  assert.equal(seen.size, 133);
  await redis.del(`${AGENT_THESES_PREFIX}:cursor`);
  let cryptoCanPublish = false;
  const model: AgentModelClient = async (call) => {
    const body = call.body as Record<string, unknown>;
    modelCalls.push({ stage: call.stage, input: body });
    const screening = call.stage === "jev" ? agentScreenFixture(body) : null;
    if (screening) return screening;
    if (call.stage === "jev") {
      const state = body.state as {
        author: { interests: string };
        candidates: Record<string, { category: string }>;
      };
      const topic = state.author.interests.startsWith("Sports")
        ? "sports"
        : state.author.interests.startsWith("Crypto")
          ? "crypto"
          : "politics";
      if (topic === "sports") throw new Error("simulated_jev_failure");
      const label =
        topic === "crypto" && !cryptoCanPublish
          ? "none"
          : (Object.entries(state.candidates).find(
              ([, c]) => c.category === topic,
            )?.[0] ?? "none");
      return {
        model: policy.jevModel,
        answers: {
          market: {
            type: "choice",
            choice: label,
            confidence: 1,
            probabilities: Object.fromEntries(
              [...Object.keys(state.candidates), "none"].map((id) => [
                id,
                id === label ? 1 : 0,
              ]),
            ),
          },
          angle: {
            type: "choice",
            choice: "mechanism",
            confidence: 1,
            probabilities: { mechanism: 1, countercase: 0, change: 0 },
          },
        },
      };
    }
    const messages = body.messages as Array<{ content: string }>;
    const payload = JSON.parse(messages[1].content);
    const topic = payload.author.interests.startsWith("Sports")
      ? "sports"
      : payload.author.interests.startsWith("Crypto")
        ? "crypto"
        : "politics";
    const candidate = payload.candidates.find(
      (c: { category: string }) => c.category === topic,
    );
    assert.ok(
      candidate,
      "Fallback writer can choose by interests across template categories",
    );
    assert.equal(
      payload.author.specialization,
      undefined,
      "Slot must not anchor model topic",
    );
    assert.ok(!body.tools);
    assert.ok(candidate.condition.length > 50);
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: "publish",
              marketId: candidate.marketId,
              outcome: "YES",
              body: "This test opinion distinguishes the exact condition from a nearby but different outcome.",
              sourceIds: [candidate.sources[0].id],
              counterargument: "Supplied evidence is incomplete.",
              maxEntryPrice: "0.6",
              changeReason: null,
            }),
          },
        },
      ],
    };
  };
  const result = await runAgentTheses({
    db,
    redis,
    apiKey: "",
    model,
    limitlessPositionContract: resolveLimitlessPositionContract(),
  });
  assert.equal(result.status, "complete");
  if (!("authors" in result)) throw new Error("Missing report");
  assert.deepEqual(
    result.authors.map((a) => a.status),
    ["published", "published", "jev_none"],
    JSON.stringify(result),
  );
  assert.equal(modelCalls.filter((c) => c.stage === "writer").length, 2);
  cryptoCanPublish = true;
  const next = await runAgentTheses({
    db,
    redis,
    apiKey: "",
    model,
    limitlessPositionContract: resolveLimitlessPositionContract(),
  });
  if (!("authors" in next)) throw new Error("Missing report");
  assert.equal(next.authors[0].status, "publication_cooldown");
  assert.equal(next.authors[1].status, "publication_cooldown");
  // A skip did not occupy a publication slot. The ready author's independent
  // cursor starts with its own first page, not the cooling author's tail.
  assert.equal(next.authors[2].status, "published");
  const rotationKeys = [
    `${AGENT_THESES_PREFIX}:pool_turn`,
    ...policy.authors.map(
      (author) => `${AGENT_THESES_PREFIX}:cursor:${author.userId}`,
    ),
  ];
  const rotationBefore = await redis.mGet(rotationKeys);
  const ownershipBefore = await redis.hGetAll(
    `${AGENT_THESES_PREFIX}:pool_owners`,
  );
  const callsBefore = modelCalls.length;
  const recovered = await runAgentTheses({
    db,
    redis,
    apiKey: "",
    model,
    limitlessPositionContract: resolveLimitlessPositionContract(),
  });
  if (!("authors" in recovered)) throw new Error("Missing report");
  assert.deepEqual(
    recovered.authors.map((a) => a.status),
    ["publication_cooldown", "publication_cooldown", "publication_cooldown"],
  );
  assert.deepEqual(
    recovered.candidates,
    [],
    "All-cooldown run does not load candidates",
  );
  assert.deepEqual(await redis.mGet(rotationKeys), rotationBefore);
  assert.deepEqual(
    await redis.hGetAll(`${AGENT_THESES_PREFIX}:pool_owners`),
    ownershipBefore,
  );
  assert.equal(modelCalls.length, callsBefore);
  assert.equal(modelCalls.filter((c) => c.stage === "writer").length, 3);
  await db.query(
    "update user_theses set published_at=published_at-interval '5 hours' where author_id=any($1::uuid[])",
    [policy.authors.map((author) => author.userId)],
  );
  const noBudget = await runAgentTheses({
    db,
    redis,
    apiKey: "",
    model: async () => {
      throw new Error("agent_budget_exhausted");
    },
    limitlessPositionContract: resolveLimitlessPositionContract(),
  });
  assert.equal(noBudget.status, "agent_budget_exhausted");
  assert.deepEqual(
    await redis.mGet(rotationKeys),
    rotationBefore,
    "Budget refusal does not consume unseen pages",
  );
  assert.deepEqual(
    await redis.hGetAll(`${AGENT_THESES_PREFIX}:pool_owners`),
    ownershipBefore,
  );

  // Fourth/fifth identities are real runtime authors, not merely extra admin cards.
  await client.query("savepoint dynamic_agents");
  const extras = await provisionAgentAuthors(
    db,
    [
      { handle: "custom_fourth", name: "Fourth", bio: "AI" },
      { handle: "custom_fifth", name: "Fifth", bio: "AI" },
    ],
    true,
  );
  const expanded = structuredClone(policy);
  expanded.authors = [
    ...expanded.authors.map((a) => ({ ...a, enabled: false })),
    ...extras.authors.map((a) => {
      assert.ok(a.userId);
      return { ...agentFixtureAuthors[0], userId: a.userId, enabled: true };
    }),
  ];
  await db.query(
    "insert into runtime_policies(policy_key,effective_at,payload) values('agent_theses',clock_timestamp(),$1::jsonb)",
    [JSON.stringify(expanded)],
  );
  const extraRun = await runAgentTheses({
    db,
    redis,
    apiKey: "",
    model,
    limitlessPositionContract: resolveLimitlessPositionContract(),
  });
  assert.ok("authors" in extraRun);
  assert.equal(extraRun.authors.length, 2);
  assert.ok(
    extraRun.authors.every((a) => a.status === "published"),
    JSON.stringify(extraRun.authors),
  );
  assert.deepEqual(
    extraRun.authors.map((a) => a.userId).sort(),
    extras.authors.map((a) => a.userId).sort(),
  );
  await client.query("rollback to savepoint dynamic_agents");
  await client.query("release savepoint dynamic_agents");

  const state = new AgentRunState(redis, "test-owner");
  const rival = new AgentRunState(redis, "test-rival");
  assert.equal(await state.acquire(), true);
  assert.equal(await rival.acquire(), false);
  await state.reserve("reserved-timeout", 0.25, 0.4);
  await state.settle("reserved-timeout", null);
  await assert.rejects(
    state.reserve("over-budget", 0.2, 0.4),
    /budget_exhausted/,
  );
  await state.close();
  assert.equal(await rival.acquire(), true);
  await assert.rejects(
    rival.reserve("restart-over-budget", 0.2, 0.4),
    /budget_exhausted/,
  );
  await rival.settle("reserved-timeout", 0.01);
  await rival.reserve("after-settlement", 0.2, 0.4);
  await assert.rejects(
    rival.reserve("after-settlement", 0.2, 0.4),
    /already_reserved/,
  );
  // Simulate an expired ownership followed by another owner; stale owner must not release it.
  await redis.set(`${AGENT_THESES_PREFIX}:lock`, "replacement", { PX: 120000 });
  await assert.rejects(rival.assertLease(), /lease_lost/);
  await assert.rejects(
    rival.saveCursor({ event: 999 }, "test-author"),
    /lease_lost/,
  );
  assert.equal(
    await redis.get(`${AGENT_THESES_PREFIX}:cursor:test-author`),
    null,
  );
  await rival.close();
  assert.equal(await redis.get(`${AGENT_THESES_PREFIX}:lock`), "replacement");
  // Scale only inside this rollback-only PG16 fixture. No new index.
  await client.query("set local statement_timeout='30s'");
  const authorId = agents.authors[0].userId;
  assert.ok(authorId);
  await db.query(
    `insert into user_theses(author_id,canonical_purchase_key,market_id,event_id,token_id,outcome,
     instrument_generation,expiry,body,buy_snapshot,policy_revision,qualifying_notional,
     idempotency_key,payload_hash,purchase_mode,published_at)
     select t.author_id,'paper:scale:'||$2||':'||sample.seq,t.market_id,t.event_id,t.token_id,t.outcome,
       t.instrument_generation,t.expiry,t.body,t.buy_snapshot,t.policy_revision,t.qualifying_notional,
       'scale:'||$2||':'||sample.seq,t.payload_hash,'paper',t.published_at-sample.seq*interval '4 hours'
     from (select * from user_theses where author_id=$1 order by published_at desc,id desc limit 1) t
     cross join generate_series(1,20000) sample(seq)`,
    [authorId, prefix],
  );
  await db.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
     select $1||':unrelated:'||sample.seq,'limitless',$1||':unrelated:'||sample.seq,$2,'Unrelated','ACTIVE','binary'
     from generate_series(1,50000) sample(seq)`,
    [prefix, eventId],
  );
  await db.query(
    `insert into unified_tokens(token_id,venue,market_id,side)
     select m.id||':YES','limitless',m.id,'YES' from unified_markets m
     where m.event_id=$1 on conflict(token_id) do nothing`,
    [eventId],
  );
  await db.query(
    `insert into unified_token_top_latest(token_id,venue,ts,best_ask)
     select tok.token_id,'limitless',clock_timestamp(),0.5 from unified_tokens tok
     join unified_markets m on m.id=tok.market_id where m.event_id=$1
     on conflict(token_id) do nothing`,
    [eventId],
  );
  await db.query(
    `insert into ai_notes(note_key,note_type,status,title,description,source_kind,source_id,producer_type,producer_run_id)
     select $1||':note:'||sample.seq,'signal','active','Saved news','Existing evidence','market',
       $1||':unrelated:'||sample.seq,'map_signals',$1 from generate_series(1,5000) sample(seq)`,
    [prefix],
  );
  await db.query("analyze user_theses");
  await db.query("analyze unified_markets");
  await db.query("analyze unified_tokens");
  await db.query("analyze unified_token_top_latest");
  await db.query("analyze ai_notes");
  await client.query("set local statement_timeout='10s'");
  const maxSet = Array.from(
    { length: 120 },
    (_, i) => `${prefix}:${String(i).padStart(4, "0")}`,
  );
  const maxCandidates = await loadAgentCandidates({
    db,
    redis,
    marketIds: maxSet,
    maxQuoteAgeSeconds: 900,
    limitlessPositionContract: resolveLimitlessPositionContract(),
  });
  assert.equal(maxCandidates.candidates.length, 120);
  // Deep context reads only selected markets; newest opposite view survives a
  // long same-side history and future notes cannot leak into the context.
  const deepClock = new Date();
  await db.query(
    `insert into ai_notes(note_key,note_type,status,title,description,direction,source_kind,source_id,producer_type,producer_run_id,created_at)
     select $1||':deep:'||sample.seq,'signal','active','Interpretation','Saved argument',
       case when sample.seq=8 then 'down' else 'up' end,'market',$2,'map_signals',$1,
       $3::timestamptz-sample.seq*interval '1 second'
     from generate_series(1,5000) sample(seq)`,
    [prefix, maxSet[0], deepClock],
  );
  await db.query(
    `insert into ai_notes(note_key,note_type,status,title,description,direction,source_kind,source_id,producer_type,producer_run_id,created_at)
     values($1,'signal','active','Future note','Must be excluded','down','market',$2,'map_signals',$1,$3::timestamptz+interval '1 day')`,
    [`${prefix}:future`, maxSet[0], deepClock],
  );
  await db.query("analyze ai_notes");
  const deep = await enrichAgentSelectedContext({
    db,
    redis,
    candidates: maxCandidates.candidates.slice(0, 1),
    now: deepClock,
  });
  assert.ok(!deep.diagnostics.includes("stored_notes_unavailable"));
  assert.equal(deep.candidates.length, 1);
  assert.ok(
    deep.candidates[0].sources.some((s) =>
      s.excerpt.includes("[Prior NO interpretation]"),
    ),
  );
  assert.ok(deep.candidates[0].sources.every((s) => s.title !== "Future note"));
  assert.deepEqual(
    deep.candidates[0].sides,
    maxCandidates.candidates[0].sides,
    "enrichment cannot change accepted quote/instrument",
  );
  assert.equal(
    (
      await enrichAgentSelectedContext({
        db,
        redis,
        candidates: maxCandidates.candidates,
        now: deepClock,
      })
    ).candidates.length,
    3,
  );
  const noteRead = [...readQueries.values()].find((q) =>
    q.sql.includes("note_row.*"),
  );
  assert.ok(noteRead);
  // The same changed SQL is exercised at max pool size/deep limit and an empty tail.
  await db.query(noteRead.sql, [maxSet, deepClock, 12]);
  assert.equal(
    (
      await db.query(`${noteRead.sql} /* empty-tail plan */`, [
        [`${prefix}:missing`],
        deepClock,
        12,
      ])
    ).rows.length,
    0,
  );
  // Exercise a full exact-contract history lookup including contracts never published.
  const historyQuery = [...readQueries.keys()].find((sql) =>
    sql.includes("distinct on (market_id)"),
  );
  assert.ok(historyQuery);
  await db.query(historyQuery, [authorId, maxSet.slice(0, 24)]);
  const social = new SocialService(db, undefined, {
    limitlessPositionContract: resolveLimitlessPositionContract(),
  });
  assert.equal((await social.paperPerformance(authorId)).pending, 20001);
  // Execute all captured changed reads at their largest exercised argument sets.
  // Also prepare them, so forced generic plans are actually exercised.
  let queryIndex = 0;
  let maxMs = 0;
  for (const { sql, values } of [...readQueries.values()]) {
    const name = `agent_plan_${queryIndex++}`;
    await client.query(`prepare ${name} as ${sql}`);
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await client.query(`set local plan_cache_mode=${mode}`);
      const literals = values.map((value) =>
        value == null
          ? "NULL"
          : Array.isArray(value)
            ? `ARRAY[${value.map((v) => `'${String(v).replaceAll("'", "''")}'`).join(",")}]::text[]`
            : typeof value === "boolean"
              ? String(value)
              : typeof value === "number"
                ? String(value)
                : `'${(value instanceof Date ? value.toISOString() : String(value)).replaceAll("'", "''")}'`,
      );
      const explained = await client.query(
        `explain (analyze,buffers,format json) execute ${name}${literals.length ? `(${literals.join(",")})` : ""}`,
      );
      const plan = explained.rows[0]["QUERY PLAN"][0];
      maxMs = Math.max(maxMs, plan["Execution Time"]);
      const scans: string[] = [];
      const inspect = (node: Record<string, unknown>) => {
        if (node["Relation Name"])
          scans.push(
            `${node["Node Type"]}:${node["Relation Name"]}:${node["Actual Rows"]}`,
          );
        for (const child of (node.Plans ?? []) as Array<
          Record<string, unknown>
        >)
          inspect(child);
      };
      inspect(plan.Plan);
      console.log(
        JSON.stringify({
          query: name,
          mode,
          ms: plan["Execution Time"],
          hits: plan.Plan["Shared Hit Blocks"],
          reads: plan.Plan["Shared Read Blocks"],
          scans,
        }),
      );
    }
    await client.query(`deallocate ${name}`);
  }
  console.log(
    JSON.stringify({
      agentScale: {
        authorTheses: 20001,
        unrelatedMarkets: 50000,
        plannedReads: queryIndex,
        maxMs,
      },
    }),
  );
  console.log(
    "agent-theses runner real PG/Redis: rotation, categories, Jev none/error, cooldown, lease, persisted budget passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
  // Exact test-owned prefix in the explicitly fenced disposable Redis only.
  const keys = await redis.keys(`${AGENT_THESES_PREFIX}:*`);
  if (keys.length) await redis.del(keys);
  await redis.del([
    marketMapActiveKey(),
    marketMapRunNodesGlobalKey(mapId),
    marketMapRunNodeEventsKey(mapId, "leaf"),
    marketMapRunNodesGlobalKey(`${mapId}:rebuilt`),
    marketMapRunNodeEventsKey(`${mapId}:rebuilt`, "leaf"),
    `ai:map_search:v1:evidence:${prefix}`,
  ]);
  await redis.zRem("ai:map_search:v1:recent_evidence", prefix);
  await redis.quit();
}
