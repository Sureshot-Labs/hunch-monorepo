// @requires-redis
import assert from "node:assert/strict";
import { createRedisClient } from "@hunch/infra";
import {
  DEFAULT_EMBEDDING_POLICY,
  EMBEDDING_ACTIVE_KEY,
  generationForPolicy,
  embeddingKey,
  embeddingIndex,
  type EmbeddingGeneration,
} from "@hunch/embeddings";
import {
  retrieveAgentInterests,
  relatedAgentMarkets,
  interleaveAgentMatches,
  createAgentInterestEmbedder,
} from "./services/agent-theses-retrieval.js";
import {
  AgentRunState,
  AGENT_PREVIEW_PREFIX,
  AGENT_THESES_PREFIX,
} from "./services/agent-theses-state.js";
import { enrichAgentSelectedContext } from "./services/agent-theses-context.js";

// Dedicated empty Redis Stack fixture. Never connects to application/prod Redis.
const url = process.env.HUNCH_AGENT_RETRIEVAL_TEST_REDIS_URL;
assert.equal(url, "redis://127.0.0.1:55478");
const redis = createRedisClient({ url });
await redis.connect();
assert.equal(await redis.dbSize(), 0, "retrieval fixture must start empty");
const generation = generationForPolicy(DEFAULT_EMBEDDING_POLICY);
const generations: EmbeddingGeneration[] = [];
const vector = (axis: number) =>
  Array.from({ length: 1024 }, (_, i) => Number(i === axis));
async function seed(g: EmbeddingGeneration) {
  await redis.sendCommand([
    "FT.CREATE",
    embeddingIndex(g, "market"),
    "ON",
    "HASH",
    "PREFIX",
    "1",
    embeddingKey(g, "market", ""),
    "SCHEMA",
    "status",
    "TAG",
    "embedding",
    "VECTOR",
    "FLAT",
    "6",
    "TYPE",
    "FLOAT32",
    "DIM",
    "1024",
    "DISTANCE_METRIC",
    "COSINE",
  ]);
  generations.push(g);
  for (const [id, axis, status] of [
    ["crypto", 0, "ACTIVE"],
    ["weather", 1, "ACTIVE"],
    ["musk-politics", 2, "ACTIVE"],
    ["hormuz", 3, "ACTIVE"],
    ["closed-crypto", 0, "SETTLED"],
  ] as const) {
    await redis.hSet(embeddingKey(g, "market", id), {
      status,
      embedding: Buffer.from(new Float32Array(vector(axis)).buffer),
    });
  }
  await redis.set(EMBEDDING_ACTIVE_KEY, JSON.stringify(g));
}
try {
  await seed(generation);
  // Synthetic vectors test routing/caching mechanics, NOT live multilingual model quality.
  const authors = [
    { userId: "a", interests: "比特币和加密货币" },
    { userId: "b", interests: "Температура в Лиссабоне" },
    { userId: "c", interests: "Elon Musk, including political appointments" },
  ];
  let calls = 0;
  const embed = async (_g: EmbeddingGeneration, texts: string[]) => {
    calls++;
    return texts.map((t) =>
      vector(t.includes("比特币") ? 0 : t.includes("Лиссабоне") ? 1 : 2),
    );
  };
  const input = {
    redis,
    authors,
    maximum: 120,
    embed,
    assertLease: async () => {},
  };
  const first = await retrieveAgentInterests(input);
  assert.equal(first.stats.generated, 3);
  assert.equal(calls, 1, "one bounded batch, not a call per market");
  assert.equal(first.byAuthor.a[0], "crypto");
  assert.equal(first.byAuthor.b[0], "weather");
  assert.equal(
    first.byAuthor.c[0],
    "musk-politics",
    "category is not a topic gate",
  );
  assert.ok(!first.marketIds.includes("closed-crypto"));
  assert.equal(new Set(first.marketIds).size, first.marketIds.length);
  assert.equal((await retrieveAgentInterests(input)).stats.cacheHits, 3);
  assert.equal(calls, 1);
  assert.deepEqual(
    await relatedAgentMarkets(redis, "crypto"),
    [],
    "unrelated nearest neighbors are not added as context",
  );
  assert.deepEqual(
    interleaveAgentMatches(
      [
        ["a", "b"],
        ["a", "c"],
      ],
      3,
    ),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    (await retrieveAgentInterests({ ...input, maximum: 1 })).marketIds,
    [],
  );
  const changed = await retrieveAgentInterests({
    ...input,
    authors: [{ ...authors[0], interests: "比特币，协议升级" }],
  });
  assert.equal(changed.stats.generated, 1);
  assert.equal(calls, 2);

  // Concurrent cron/preview: no duplicate provider request for the same cache miss.
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const racing = {
    ...input,
    authors: [{ userId: "race", interests: "New narrow topic" }],
    embed: async () => {
      entered();
      await blocked;
      return [vector(2)];
    },
  };
  const active = retrieveAgentInterests(racing);
  await started;
  const concurrent = await retrieveAgentInterests({
    ...racing,
    embed: async () => {
      throw new Error("duplicate charge");
    },
  });
  assert.equal(concurrent.stats.busy, 1);
  assert.ok(concurrent.diagnostics.includes("interest_cache_busy_fallback"));
  finish();
  assert.equal((await active).stats.generated, 1);

  const partial = await retrieveAgentInterests({
    ...input,
    authors: [
      authors[0],
      { userId: "new", interests: "Uncached failed topic" },
    ],
    embed: async () => {
      throw new Error("provider_timeout");
    },
  });
  assert.equal(
    partial.byAuthor.a[0],
    "crypto",
    "cache miss failure preserves cached matches",
  );
  assert.ok(partial.diagnostics.includes("interest_embedding_unavailable"));
  assert.equal(
    (
      await retrieveAgentInterests({
        ...input,
        authors: [{ userId: "new", interests: "Uncached failed topic" }],
      })
    ).stats.generated,
    1,
    "failed cache can recover next pass",
  );
  for (const code of [
    "agent_budget_exhausted",
    "agent_lease_lost",
    "preview_interrupted",
  ]) {
    await assert.rejects(
      retrieveAgentInterests({
        ...input,
        authors: [{ userId: "budget", interests: code }],
        embed: async () => {
          throw new Error(code);
        },
      }),
      new RegExp(code),
    );
  }
  await assert.rejects(
    retrieveAgentInterests({
      ...input,
      assertLease: async () => {
        throw new Error("agent_lease_lost");
      },
    }),
    /agent_lease_lost/,
  );

  const changedGeneration = generationForPolicy({
    ...DEFAULT_EMBEDDING_POLICY,
    model: "intfloat/e5-large-v2",
  });
  await redis.set(EMBEDDING_ACTIVE_KEY, JSON.stringify(changedGeneration));
  const noIndex = await retrieveAgentInterests(input);
  assert.deepEqual(noIndex.marketIds, []);
  assert.ok(noIndex.diagnostics.includes("interest_semantic_unavailable"));
  assert.equal(calls, 3, "missing index cannot trigger paid embeddings");
  await seed(changedGeneration);
  const migrated = await retrieveAgentInterests(input);
  assert.equal(
    migrated.stats.generated,
    3,
    "no reuse of vectors from another generation",
  );
  assert.equal(calls, 4);
  const hugeTeam = await retrieveAgentInterests({
    ...input,
    authors: Array.from({ length: 70 }, (_, i) => ({
      ...authors[i % 3],
      userId: `owner${i}`,
    })),
  });
  assert.equal(hugeTeam.stats.authors, 60);
  assert.equal(hugeTeam.stats.deferred, 10);
  assert.equal(hugeTeam.stats.cacheHits, 3, "shared interests deduplicate");
  assert.ok(hugeTeam.marketIds.length <= 60);

  // Actual Redis budget reservation: preview is separate; unknown timeout is not free.
  const state = new AgentRunState(
    redis,
    "retrieval-accounting",
    AGENT_PREVIEW_PREFIX,
  );
  const cron = new AgentRunState(redis, "cron-accounting", AGENT_THESES_PREFIX);
  assert.ok(await state.acquire());
  assert.ok(await cron.acquire());
  try {
    const records: Record<string, unknown>[] = [];
    const accounting = {
      apiKey: "fixture-not-a-key",
      runId: "retrieval-accounting",
      reserve: (
        id: string,
        amount: number,
        metadata: Record<string, unknown>,
      ) => state.reserve(id, amount, 2, metadata),
      settle: (id: string, amount: number | null) => state.settle(id, amount),
      record: (entry: Record<string, unknown>) => {
        records.push(entry);
      },
    };
    const success = createAgentInterestEmbedder({
      ...accounting,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            model: generation.model,
            data: [{ index: 0, embedding: vector(0) }],
            usage: { prompt_tokens: 5, cost: 0.00001 },
          }),
        ),
    });
    await success(generation, ["Test query"]);
    assert.equal(records[0].costSource, "provider");
    assert.equal(records[0].chargedUsd, 0.00001);
    const timeout = createAgentInterestEmbedder({
      ...accounting,
      runId: "retrieval-timeout",
      fetchImpl: async () => {
        throw new Error("timeout");
      },
    });
    await assert.rejects(timeout(generation, ["Test query"]));
    assert.equal(records[1].costSource, "reserved_unknown");
    assert.equal(records[1].chargedUsd, 0.001);
    assert.equal(await redis.hLen(`${AGENT_PREVIEW_PREFIX}:costs`), 2);
    assert.equal(await redis.hLen(`${AGENT_THESES_PREFIX}:costs`), 0);
    assert.equal(
      (await redis.keys(`${AGENT_THESES_PREFIX}:cursor*`)).length,
      0,
    );
    assert.equal(
      (await redis.keys(`${AGENT_THESES_PREFIX}:considered*`)).length,
      0,
    );
    const denied = createAgentInterestEmbedder({
      ...accounting,
      reserve: async () => {
        throw new Error("agent_budget_exhausted");
      },
      fetchImpl: async () => {
        assert.fail("no provider call without reservation");
      },
    });
    await assert.rejects(
      denied(generation, ["Test"]),
      /agent_budget_exhausted/,
    );
  } finally {
    await state.close();
    await cron.close();
  }
  const peerVector = vector(0);
  peerVector[1] = 0.1;
  await redis.hSet(embeddingKey(changedGeneration, "market", "crypto-peer"), {
    status: "ACTIVE",
    embedding: Buffer.from(new Float32Array(peerVector).buffer),
  });
  assert.deepEqual(await relatedAgentMarkets(redis, "crypto"), ["crypto-peer"]);
  const deep = await enrichAgentSelectedContext({
    redis,
    now: new Date(),
    candidates: [
      {
        marketId: "crypto",
        title: "Bitcoin",
        condition: "Exact contract rule",
        category: "Crypto",
        eventTitle: "BTC",
        closesAt: null,
        sides: [],
        sources: [],
      },
    ],
    db: {
      query: async (_sql: string, values: unknown[] = []) => ({
        rows: (values[0] as string[]).includes("crypto-peer")
          ? [
              {
                market_id: "crypto-peer",
                id: "peer-note",
                title: "Saved peer interpretation",
                description: "Opinion on a different deadline",
                direction: "down",
                created_at: new Date(Date.now() - 1000),
              },
            ]
          : [],
      }),
    } as unknown as Parameters<typeof enrichAgentSelectedContext>[0]["db"],
  });
  assert.equal(deep.candidates[0].sources.length, 1);
  assert.equal(deep.candidates[0].sources[0].kind, "hunch_analysis");
  assert.ok(
    deep.candidates[0].sources[0].excerpt.includes(
      "Related contract crypto-peer; background, not evidence",
    ),
  );
  assert.ok(
    deep.candidates[0].sources[0].excerpt.includes("Prior NO interpretation"),
  );
  console.log(
    "agent retrieval: real Redis Search KNN, generation/cache, multilingual routing fixtures, concurrency and separate cost accounting passed (no live model calls)",
  );
} finally {
  // Empty-at-start, explicitly fenced fixture only. Never use FLUSH on an application Redis.
  for (const g of generations)
    await redis.sendCommand(["FT.DROPINDEX", embeddingIndex(g, "market")]);
  const keys = await redis.keys("*");
  if (keys.length) await redis.del(keys);
  await redis.quit();
}
