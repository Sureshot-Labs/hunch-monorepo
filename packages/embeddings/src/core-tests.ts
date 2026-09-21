import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EMBEDDING_POLICY,
  LEGACY_EMBEDDING_GENERATION,
  embeddingPolicySchema,
  embeddingPolicyOverrideSchema,
  generationForPolicy,
  parseEmbeddingGeneration,
  generationForSnapshot,
  readActiveGeneration,
  pinGeneration,
  acquireEmbeddingGenerationPin,
  embeddingKey,
  embeddingIndex,
  embeddingTextHash,
  parseEmbeddingVector,
  embeddingVectorBuffer,
  type EmbeddingSource,
} from "./contracts.js";
import {
  buildEmbeddingText,
  buildLegacyEmbeddingText,
  buildNewsEmbeddingText,
  cleanEmbeddingText,
  countEmbeddingTokens,
} from "./text.js";
import {
  fetchEmbeddingBatch,
  EmbeddingProviderError,
  estimateEmbeddingCostUsd,
} from "./provider.js";

const e5 = generationForPolicy({
  ...DEFAULT_EMBEDDING_POLICY,
  model: "intfloat/e5-large-v2",
});
const qwen = generationForPolicy({
  ...DEFAULT_EMBEDDING_POLICY,
  model: "qwen/qwen3-embedding-8b",
});
const source: EmbeddingSource = {
  kind: "market",
  id: "polymarket:fixture",
  venue: "polymarket",
  status: "ACTIVE",
  eligible: true,
  title: "Below $74,000",
  eventTitle: "Bitcoin price on September 22, 2026?",
  description: "Must NOT reach $74,000 before 23:59 UTC.",
  outcomes: ["Yes", "No"],
};
const vector = Array.from({ length: 1024 }, (_, index) =>
  index === 0 ? 1 : 0,
);
function response(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), { status, headers });
}
function mockFetch(fn: () => Response | Promise<Response>): typeof fetch {
  return fn as typeof fetch;
}

test("policy defaults and sparse overrides are strict and independent", () => {
  assert.deepEqual(embeddingPolicySchema.parse({}), DEFAULT_EMBEDDING_POLICY);
  assert.equal(DEFAULT_EMBEDDING_POLICY.model, "qwen/qwen3-embedding-8b");
  assert.equal(DEFAULT_EMBEDDING_POLICY.autoActivate, true);
  assert.deepEqual(embeddingPolicyOverrideSchema.parse({ model: qwen.model }), {
    model: qwen.model,
  });
  assert.throws(() => embeddingPolicySchema.parse({ dimensions: 4096 }));
  assert.throws(() => embeddingPolicySchema.parse({ model: "invented" }));
  assert.throws(() =>
    embeddingPolicySchema.parse({ textVersion: "unknown-v2" }),
  );
  assert.throws(() => embeddingPolicySchema.parse({ generationBudgetUsd: 0 }));
  assert.throws(() => embeddingPolicySchema.parse({ unrecognized: true }));
});

test("generation identity excludes scheduling fields but includes embedding space", () => {
  assert.equal(
    e5.id,
    generationForPolicy({
      ...DEFAULT_EMBEDDING_POLICY,
      model: e5.model,
      concurrency: 4,
      generationBudgetUsd: 10,
    }).id,
  );
  assert.notEqual(e5.id, qwen.id);
  assert.deepEqual(parseEmbeddingGeneration(e5), e5);
  assert.deepEqual(
    parseEmbeddingGeneration(LEGACY_EMBEDDING_GENERATION),
    LEGACY_EMBEDDING_GENERATION,
  );
  assert.throws(() => parseEmbeddingGeneration({ ...e5, model: qwen.model }));
  assert.throws(() => parseEmbeddingGeneration({ ...e5, legacy: true }));
  assert.notEqual(
    embeddingKey(e5, "market", "id"),
    embeddingKey(qwen, "market", "id"),
  );
  assert.equal(
    embeddingKey(LEGACY_EMBEDDING_GENERATION, "market", "id"),
    "ai:embed:market:id",
  );
  assert.equal(
    embeddingIndex(LEGACY_EMBEDDING_GENERATION, "event"),
    "idx:ai:embed:event",
  );
});

test("absent state is legacy; corrupt state fails closed; pins use one scoped ZSET", async () => {
  assert.deepEqual(
    await readActiveGeneration({ get: async () => null }),
    LEGACY_EMBEDDING_GENERATION,
  );
  assert.deepEqual(
    await readActiveGeneration({ get: async () => JSON.stringify(e5) }),
    e5,
  );
  await assert.rejects(readActiveGeneration({ get: async () => "broken" }));
  assert.deepEqual(generationForSnapshot({ embeddingGeneration: e5 }), e5);
  assert.deepEqual(generationForSnapshot({}), LEGACY_EMBEDDING_GENERATION);
  assert.throws(() =>
    generationForSnapshot({ embeddingGeneration: { ...e5, dimensions: 4096 } }),
  );
  const calls: string[][] = [];
  await pinGeneration(
    {
      sendCommand: async (args) => {
        calls.push(args);
        return 1;
      },
    },
    e5,
    "map:123",
    60,
  );
  assert.equal(calls[0]?.[0], "EVAL");
  assert.equal(calls[0]?.[3], `ai:embed:control:pins:${e5.id}`);
  assert.equal(calls[0]?.[4], `ai:embed:control:deleting:${e5.id}`);
  assert.equal(calls[0]?.[5], `ai:embed:control:deleted:${e5.id}`);
  assert.equal(calls[0]?.[6], "ai:embed:control:active");
  assert.equal(calls[0]?.[8], "map:123");
  assert.ok(Number(calls[0]?.[7]) > Date.now());
  await assert.rejects(
    pinGeneration({ sendCommand: async () => 0 }, e5, "map:deleted", 60),
    /no longer available/,
  );
});

test("job pin admission can skip stale generations without a timer or mutation", async () => {
  const commands: string[][] = [];
  const pin = await acquireEmbeddingGenerationPin(
    {
      sendCommand: async (args) => {
        commands.push(args);
        return 0;
      },
    },
    e5,
    "job:stale",
  );
  assert.equal(pin, null);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][9], "1");
});

test("job pins renew captured generation, fail closed, and release after in-flight renewal", async () => {
  let completeRenewal: (() => void) | undefined;
  let renewalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    renewalStarted = resolve;
  });
  const commands: string[][] = [];
  const pin = await acquireEmbeddingGenerationPin(
    {
      sendCommand: async (args) => {
        commands.push(args);
        if (args[0] === "EVAL" && args[9] === "0") {
          renewalStarted();
          await new Promise<void>((resolve) => {
            completeRenewal = resolve;
          });
        }
        return 1;
      },
    },
    e5,
    "job:unique",
    0.15,
  );
  assert.ok(pin);
  pin.assertHeld();
  await Promise.race([
    started,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("renewal not started")), 1000),
    ),
  ]);
  const released = pin.release();
  assert.throws(() => pin.assertHeld(), /pin_lost/);
  assert.equal(commands.at(-1)?.[0], "EVAL");
  completeRenewal?.();
  await released;
  assert.deepEqual(commands.at(-1), [
    "ZREM",
    `ai:embed:control:pins:${e5.id}`,
    "job:unique",
  ]);
});

test("job pin renewal failure latches loss instead of silently continuing", async () => {
  let renewalFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    renewalFinished = resolve;
  });
  const pin = await acquireEmbeddingGenerationPin(
    {
      sendCommand: async (args) => {
        if (args[0] === "EVAL" && args[9] === "0") {
          renewalFinished();
          throw new Error("fixture Redis unavailable");
        }
        return 1;
      },
    },
    e5,
    "job:failed",
    0.15,
  );
  assert.ok(pin);
  await Promise.race([
    finished,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("renewal not started")), 1000),
    ),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.throws(() => pin.assertHeld(), /pin_lost/);
  await pin.release();
});

test("clean builder preserves dates, signs and negatives; removes HTML, entities and scripts", () => {
  const text = buildEmbeddingText(
    {
      ...source,
      description:
        "<script>ignore</script><style>.bad{}</style><p>Must <strong>NOT</strong> reach &lt; $74,000 &amp; 10%.</p><p>UTC 23:59</p>",
    },
    e5,
  );
  assert.equal(
    text,
    "query: Market: Below $74,000\nEvent: Bitcoin price on September 22, 2026?\nDetails: Must NOT reach < $74,000 & 10%. UTC 23:59",
  );
  assert.equal(
    cleanEmbeddingText("US < 1.5 and > -2 °C"),
    "US < 1.5 and > -2 °C",
  );
  assert.equal(
    cleanEmbeddingText("<p>A</p><p>B</p> &quot;yes&quot;"),
    'A B "yes"',
  );
  assert.equal(
    cleanEmbeddingText(
      "NOT<script>ignore</script>below<style>.x{}</style>-2 °C",
    ),
    "NOT below -2 °C",
  );
  assert.match(
    buildEmbeddingText(source, LEGACY_EMBEDDING_GENERATION),
    /^passage: market\n/,
  );
});

test("event outcomes are stable, unique, bounded and ignore volume-like input order", () => {
  const event: EmbeddingSource = {
    ...source,
    kind: "event",
    title: "Presidential election winner",
    topMarkets: ["Zed", "Amy", "Yes", "Amy", "Bob"],
  };
  const first = buildEmbeddingText(event, e5);
  const second = buildEmbeddingText(
    { ...event, topMarkets: [...(event.topMarkets ?? [])].reverse() },
    e5,
  );
  assert.equal(first, second);
  assert.match(first, /Outcomes: Amy; Bob; Zed/);
  const many = buildEmbeddingText(
    {
      ...event,
      topMarkets: Array.from(
        { length: 30 },
        (_, i) => `Candidate ${String(i).padStart(2, "0")}`,
      ),
    },
    e5,
  );
  assert.match(many, /Candidate 07/);
  assert.doesNotMatch(many, /Candidate 08/);
});

test("oversized parent context never erases sibling market thresholds or directions", () => {
  const titles = [
    "Below $74000",
    "Above $74000",
    "Below $75000",
    "NOT below -2 °C",
  ];
  for (const generation of [e5, qwen]) {
    const texts = titles.map((title) =>
      buildEmbeddingText(
        {
          ...source,
          title,
          eventTitle: "A long parent election scenario. ".repeat(600),
          category: "Very broad context ".repeat(600),
        },
        generation,
      ),
    );
    texts.forEach((text, index) => {
      assert.ok(text.includes(`Market: ${titles[index]}`));
      assert.ok(
        countEmbeddingTokens(text, generation) <=
          (generation === e5 ? 480 : 2048),
      );
    });
    assert.equal(new Set(texts.map(embeddingTextHash)).size, titles.length);
  }
});

test("literal angle comparisons survive HTML cleaning without permitting markup noise", () => {
  for (const text of [
    "Will BTC<ETH in 2026?",
    "A <B and C>D",
    "x<y and y>z",
    "below <0.5% or above >0.5%",
    "NO ≤ -2°C",
    "5 < 10 < 20",
  ]) {
    assert.equal(cleanEmbeddingText(text), text);
  }
  assert.equal(
    cleanEmbeddingText(
      '<p class="fixture">BTC&lt;ETH &amp; NOT below -2°C<br/>on September 22</p>',
    ),
    "BTC<ETH & NOT below -2°C on September 22",
  );
  assert.equal(
    cleanEmbeddingText("<p>Above<p>Below <b>NOT closed"),
    "Above Below NOT closed",
  );
  assert.equal(
    cleanEmbeddingText(
      'a<script type="text/javascript">ignore <p>also</p></script>b',
    ),
    "a b",
  );
  assert.equal(cleanEmbeddingText("a<!-- hidden words --> b"), "a b");
  assert.equal(
    cleanEmbeddingText(
      "Next Chairman of the Council of Ministers\u00a0of Bosnia and Herzegovina?",
    ),
    "Next Chairman of the Council of Ministers of Bosnia and Herzegovina?",
  );
});

test("real lower-ranked corpus cases retain their defining titles, dates, directions and people", () => {
  const fixtures = [
    [
      "Next French Presidential Election: who will advance to the 2nd round?",
      "Jean-Luc Mélenchon",
    ],
    ["Democratic VP Nominee 2028", "Alexandria Ocasio-Cortez"],
    ["Texas Senate Election Winner", "James Talarico (D)"],
    ["How many Fed rate cuts in 2026?", "0 (0 bps)"],
    ["How many Fed rate hikes in 2026?", "2 (50 bps)"],
  ];
  const texts = fixtures.map(([title = "", outcome = ""]) => {
    const text = buildEmbeddingText(
      {
        ...source,
        kind: "event",
        title,
        description: undefined,
        topMarkets: [outcome],
      },
      e5,
    );
    assert.equal(text, `query: Event: ${title}\nOutcomes: ${outcome}`);
    assert.equal(cleanEmbeddingText(title), title);
    assert.equal(cleanEmbeddingText(outcome), outcome);
    return text;
  });
  assert.equal(new Set(texts.map(embeddingTextHash)).size, fixtures.length);
});

test("legacy renderer maintains passage fields, raw HTML and old normalization independently of clean-v1", () => {
  const legacySource = {
    ...source,
    marketType: "categorical",
    category: "crypto",
    description: " <p>Must  NOT reach &lt; $74,000.</p> ",
    outcomes: ["True", "False"],
  };
  const legacy = buildLegacyEmbeddingText(legacySource);
  assert.equal(
    legacy,
    "passage: market\nmarket_title=Below $74,000\nevent_title=Bitcoin price on September 22, 2026?\ncategory=crypto\nmarket_type=categorical\ndescription=<p>Must NOT reach &lt; $74,000.</p>",
  );
  assert.equal(
    buildEmbeddingText(legacySource, LEGACY_EMBEDDING_GENERATION),
    legacy,
  );
  const clean = buildEmbeddingText(legacySource, e5);
  assert.match(clean, /^query: /);
  assert.doesNotMatch(clean, /<p>|&lt;|passage:/);
  assert.doesNotMatch(clean, /Outcomes: True; False/);
  assert.notEqual(embeddingTextHash(legacy), embeddingTextHash(clean));
  const event: EmbeddingSource = {
    ...source,
    kind: "event",
    title: "Winner",
    topMarkets: ["Winner", "Yes", "No", "TRUE", "False", "Bob", " bob ", "Amy"],
    description: undefined,
  };
  assert.equal(
    buildLegacyEmbeddingText(event),
    "passage: event\nevent_title=Winner\ntop_markets=Bob | Amy",
  );
  assert.match(
    buildLegacyEmbeddingText({
      ...source,
      description: undefined,
      outcomes: ["Yes", "Other"],
    }),
    /outcomes=Yes, Other/,
  );
  const long = buildLegacyEmbeddingText({
    ...source,
    title: "🙂 ; Chinese 北京 ".repeat(500),
    description: "x".repeat(1000),
  });
  assert.ok(countEmbeddingTokens(long, LEGACY_EMBEDDING_GENERATION) <= 510);
  assert.ok(long.length <= 1500);
});

test("actual pinned model tokenizers bound complete input and keep primary title", () => {
  assert.equal(countEmbeddingTokens("query: Hello world!", e5), 7);
  assert.equal(countEmbeddingTokens("Hello world!", qwen), 4);
  const text = buildEmbeddingText(
    {
      ...source,
      description: "Long rules not equal zero, € 50 北京. ".repeat(2000),
    },
    e5,
  );
  assert.ok(countEmbeddingTokens(text, e5) <= 480);
  assert.match(text, /Bitcoin price on September 22, 2026/);
  assert.match(text, /Below \$74,000/);
  const longTitle = buildEmbeddingText(
    {
      ...source,
      title: "Unusually long market title 🙂北京 ".repeat(1000),
      eventTitle: undefined,
      description: "no",
    },
    e5,
  );
  assert.ok(countEmbeddingTokens(longTitle, e5) <= 480);
  assert.ok(!longTitle.endsWith("\ud83d"));
  assert.notEqual(embeddingTextHash(text), embeddingTextHash(`${text} `));
});

test("news and query adapters share the generation but not legacy formatting", () => {
  assert.equal(
    buildNewsEmbeddingText("Headline", "Summary", LEGACY_EMBEDDING_GENERATION),
    "Headline Summary",
  );
  assert.equal(
    buildNewsEmbeddingText("<p>Headline</p>", "Summary", e5),
    "query: Headline\nSummary",
  );
  assert.match(
    buildNewsEmbeddingText("Headline", "Summary", qwen),
    /^Instruct: .*\nQuery: Headline\nSummary$/,
  );
  assert.doesNotMatch(buildEmbeddingText(source, qwen), /query:|Instruct:/);
});

test("vectors reject wrong dimensions, non-finite and zero values and normalize safely", () => {
  assert.equal(parseEmbeddingVector(new Uint8Array(4095), e5), null);
  assert.equal(parseEmbeddingVector(Array(1024).fill(0), e5), null);
  assert.equal(parseEmbeddingVector([NaN, ...vector.slice(1)], e5), null);
  assert.equal(parseEmbeddingVector(["1", ...vector.slice(1)], e5), null);
  const bytes = embeddingVectorBuffer([3, 4, ...vector.slice(2)], e5);
  const parsed = parseEmbeddingVector(bytes, e5);
  assert.ok(parsed);
  assert.ok(Math.abs((parsed[0] ?? 0) - 0.6) < 1e-6);
  assert.ok(Math.abs((parsed[1] ?? 0) - 0.8) < 1e-6);
});

test("provider validates indices and reorders results; passes explicit Qwen dimension", async () => {
  let payload: Record<string, unknown> = {};
  const request = (async (_input: unknown, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    return response({
      data: [
        { index: 1, embedding: vector },
        { index: 0, embedding: vector.map((value) => -value) },
      ],
      usage: { prompt_tokens: 8, cost: 0.00000008 },
    });
  }) as typeof fetch;
  const result = await fetchEmbeddingBatch({
    generation: qwen,
    texts: ["first", "second"],
    apiKey: "fixture-not-secret",
    timeoutMs: 1000,
    fetch: request,
  });
  assert.equal(result.embeddings[0]?.[0], -1);
  assert.equal(result.embeddings[1]?.[0], 1);
  assert.equal(result.usage.inputTokens, 8);
  assert.equal(result.attempts, 1);
  assert.equal(payload.dimensions, 1024);
  assert.deepEqual(payload.provider, { require_parameters: true });
});

test("budget estimates cover observed Qwen route prices without changing E5 pricing", () => {
  for (const [generation, rate] of [
    [e5, 0.01],
    [qwen, 0.04],
  ] as const) {
    const text = buildEmbeddingText(source, generation);
    const texts = [text];
    const tokens = countEmbeddingTokens(text, generation);
    assert.equal(
      estimateEmbeddingCostUsd(texts, generation),
      (tokens * rate * 2) / 1_000_000,
    );
    assert.ok(
      estimateEmbeddingCostUsd(texts, generation) >=
        (tokens * rate) / 1_000_000,
    );
  }
});

test("transient provider errors retry at most four times and reserve each attempt", async () => {
  let calls = 0;
  const reservations: number[] = [];
  const result = await fetchEmbeddingBatch({
    generation: e5,
    texts: ["query: one"],
    apiKey: "fixture",
    timeoutMs: 1000,
    fetch: mockFetch(() =>
      ++calls < 4
        ? response({}, 502)
        : response({ data: [{ index: 0, embedding: vector }] }),
    ),
    beforeAttempt: async ({ attempt, estimatedCostUsd }) => {
      assert.ok(estimatedCostUsd > 0);
      reservations.push(attempt);
    },
    sleep: async () => {},
  });
  assert.equal(calls, 4);
  assert.deepEqual(reservations, [1, 2, 3, 4]);
  assert.equal(result.attempts, 4);
  await assert.rejects(
    fetchEmbeddingBatch({
      generation: e5,
      texts: ["query: one"],
      apiKey: "fixture",
      timeoutMs: 1000,
      fetch: mockFetch(() => {
        calls++;
        return response({}, 502);
      }),
      sleep: async () => {},
    }),
    (error: unknown) =>
      error instanceof EmbeddingProviderError && error.retryable,
  );
  assert.equal(calls, 8);
});

test("provider explicit model must match the generation even when dimensions match", async () => {
  for (const actualModel of [
    qwen.model,
    "Qwen/Qwen3-Embedding-8B",
    "intfloat/e5-large-v2:unknown-revision",
    "e5-large-v2",
    null,
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchEmbeddingBatch({
        generation: e5,
        texts: ["query: example"],
        apiKey: "fixture",
        timeoutMs: 1000,
        fetch: mockFetch(() => {
          calls++;
          return response({
            model: actualModel,
            data: [{ index: 0, embedding: vector }],
          });
        }),
      }),
      (error: unknown) =>
        error instanceof EmbeddingProviderError &&
        error.code === "model_mismatch" &&
        !error.retryable,
    );
    assert.equal(calls, 1);
  }
  for (const generation of [e5, qwen]) {
    const result = await fetchEmbeddingBatch({
      generation,
      texts: ["example"],
      apiKey: "fixture",
      timeoutMs: 1000,
      fetch: mockFetch(() =>
        response({
          model: generation.model,
          data: [{ index: 0, embedding: vector }],
        }),
      ),
    });
    assert.equal(result.embeddings.length, 1);
    assert.equal(result.attempts, 1);
  }
});

test("Qwen accepts only its live-verified exact canonical response alias", async () => {
  const options = {
    generation: qwen,
    texts: ["Bitcoin above $100,000 on September 30, 2026?"],
    apiKey: "fixture",
    timeoutMs: 1000,
  };
  const result = await fetchEmbeddingBatch({
    ...options,
    fetch: mockFetch(() =>
      response({
        model: "Qwen/Qwen3-Embedding-8B",
        data: [{ index: 0, embedding: vector }],
      }),
    ),
  });
  assert.equal(result.embeddings.length, 1);
  for (const model of [
    e5.model,
    "Qwen/Qwen3-Embedding-8B:unknown-revision",
    "QWEN/QWEN3-EMBEDDING-8B",
    "Qwen/Qwen3-Embedding-4B",
  ]) {
    await assert.rejects(
      fetchEmbeddingBatch({
        ...options,
        fetch: mockFetch(() =>
          response({ model, data: [{ index: 0, embedding: vector }] }),
        ),
      }),
      (error: unknown) =>
        error instanceof EmbeddingProviderError &&
        error.code === "model_mismatch" &&
        !error.retryable,
    );
  }
});

test("credits/access errors trigger breaker without retries; budget veto prevents HTTP", async () => {
  for (const status of [401, 402, 403]) {
    let calls = 0;
    await assert.rejects(
      fetchEmbeddingBatch({
        generation: e5,
        texts: ["query: one"],
        apiKey: "fixture",
        timeoutMs: 1000,
        fetch: mockFetch(() => {
          calls++;
          return response({}, status);
        }),
      }),
      (error: unknown) =>
        error instanceof EmbeddingProviderError &&
        error.breaker &&
        !error.retryable &&
        error.status === status,
    );
    assert.equal(calls, 1);
  }
  let attempted = false;
  await assert.rejects(
    fetchEmbeddingBatch({
      generation: e5,
      texts: ["query: one"],
      apiKey: "fixture",
      timeoutMs: 1000,
      fetch: mockFetch(() => {
        attempted = true;
        return response({});
      }),
      beforeAttempt: async () => {
        throw new Error("budget exhausted");
      },
    }),
    /budget exhausted/,
  );
  assert.equal(attempted, false);
});

test("malformed response has no partial publication and no silent provider retry", async () => {
  const fixtures = [
    { data: [] },
    { data: [{ index: 2, embedding: vector }] },
    { data: [{ index: 0, embedding: vector.slice(1) }] },
    { data: [{ index: 0, embedding: Array(1024).fill(0) }] },
    {
      data: [
        { index: 0, embedding: vector },
        { index: 0, embedding: vector },
      ],
    },
  ];
  for (const fixture of fixtures) {
    let calls = 0;
    await assert.rejects(
      fetchEmbeddingBatch({
        generation: e5,
        texts: fixture.data.length === 2 ? ["one", "two"] : ["one"],
        apiKey: "fixture",
        timeoutMs: 1000,
        fetch: mockFetch(() => {
          calls++;
          return response(fixture);
        }),
      }),
      (error: unknown) =>
        error instanceof EmbeddingProviderError &&
        error.code === "invalid_response",
    );
    assert.equal(calls, 1);
  }
});

test("429 respects Retry-After; long cooldown returns immediately to worker scheduler", async () => {
  let calls = 0;
  const waits: number[] = [];
  await fetchEmbeddingBatch({
    generation: e5,
    texts: ["one"],
    apiKey: "fixture",
    timeoutMs: 1000,
    fetch: mockFetch(() =>
      ++calls === 1
        ? response({}, 429, { "Retry-After": "2" })
        : response({ data: [{ index: 0, embedding: vector }] }),
    ),
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  assert.deepEqual(waits, [2000]);
  await assert.rejects(
    fetchEmbeddingBatch({
      generation: e5,
      texts: ["one"],
      apiKey: "fixture",
      timeoutMs: 1000,
      fetch: mockFetch(() => response({}, 429, { "Retry-After": "120" })),
    }),
    (error: unknown) =>
      error instanceof EmbeddingProviderError && error.retryAfterMs === 120000,
  );
});

test("request timeout aborts and remains retryable; no HTTP for over-limit input", async () => {
  const abortingFetch = (async (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
  await assert.rejects(
    fetchEmbeddingBatch({
      generation: e5,
      texts: ["one"],
      apiKey: "fixture",
      timeoutMs: 5,
      maxAttempts: 1,
      fetch: abortingFetch,
    }),
    (error: unknown) =>
      error instanceof EmbeddingProviderError &&
      error.code === "timeout" &&
      error.retryable,
  );
  await assert.rejects(
    fetchEmbeddingBatch({
      generation: e5,
      texts: ["word ".repeat(1000)],
      apiKey: "fixture",
      timeoutMs: 1000,
      fetch: mockFetch(() => {
        throw new Error("must not call");
      }),
    }),
    (error: unknown) =>
      error instanceof EmbeddingProviderError && error.code === "invalid_input",
  );
});

test("HTTP 200 embedded provider errors retain Retry-After and access classification", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const success = await fetchEmbeddingBatch({
    generation: e5,
    texts: ["one"],
    apiKey: "fixture",
    timeoutMs: 1000,
    fetch: mockFetch(() =>
      ++attempts === 1
        ? response({ error: { code: 429 } }, 200, { "Retry-After": "2" })
        : response({ data: [{ index: 0, embedding: vector }] }),
    ),
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(success.attempts, 2);
  assert.deepEqual(waits, [2000]);
  for (const status of [402, 429, 503]) {
    let calls = 0;
    await assert.rejects(
      fetchEmbeddingBatch({
        generation: e5,
        texts: ["one"],
        apiKey: "fixture",
        timeoutMs: 1000,
        fetch: mockFetch(() => {
          calls++;
          return response({ error: { code: status } }, 200, {
            "Retry-After": "120",
          });
        }),
      }),
      (error: unknown) =>
        error instanceof EmbeddingProviderError &&
        error.status === status &&
        error.retryAfterMs === 120000 &&
        error.breaker === (status === 402),
    );
    assert.equal(calls, 1);
  }
});
