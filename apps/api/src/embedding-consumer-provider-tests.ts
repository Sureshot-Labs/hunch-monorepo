import assert from "node:assert/strict";
import {
  buildNewsEmbeddingText,
  embeddingPolicySchema,
  generationForPolicy,
} from "@hunch/embeddings";

// The real job request builders, with inert config and no external requests.
Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/embedding_consumer_test",
  JWT_SECRET: "embedding-consumer-test",
  PRIVY_APP_ID: "embedding-consumer-test",
  PRIVY_APP_SECRET: "embedding-consumer-test",
  OPENROUTER_API_KEY: "test-not-a-provider-key",
  OPENROUTER_EMBED_MODEL: "unsupported/legacy-env-must-not-select-space",
  AI_EMBED_MODEL: "unsupported/other-legacy-env",
});
const { mapSearchModelTestHooks: search } =
  await import("./ai-map-search-run.js");
const { mapSignalsModelTestHooks: signals } =
  await import("./ai-map-signals-run.js");
const { marketMapModelTestHooks: build } =
  await import("./ai-map-build-run.js");
// Compatibility fields can retain old values for diagnostics, but neither
// programmatic adapter is allowed to use them instead of its pinned generation.
assert.equal(
  search.resolveArgs([]).embedModel,
  process.env.OPENROUTER_EMBED_MODEL,
);
assert.equal(
  signals.resolveArgs([]).embedModel,
  process.env.OPENROUTER_EMBED_MODEL,
);
const originalFetch = globalThis.fetch;
const requests: Array<{ model: string; input: string[]; dimensions?: number }> =
  [];
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/embeddings");
    const request = JSON.parse(String(options?.body));
    requests.push(request);
    return new Response(
      JSON.stringify({
        model: request.model,
        data: request.input
          .map((text: string, index: number) => ({
            index,
            embedding: Array.from({ length: 1024 }, (_, i) =>
              i === Number(text.match(/fixture-(\d+)/)?.[1] ?? index) ? 1 : 0,
            ),
          }))
          .reverse(),
        usage: { prompt_tokens: 19, cost: 0.000001 },
      }),
    );
  };
  for (const model of [
    "intfloat/e5-large-v2",
    "qwen/qwen3-embedding-8b",
  ] as const) {
    const generation = generationForPolicy(
      embeddingPolicySchema.parse({ model }),
    );
    const text = buildNewsEmbeddingText(
      "Bitcoin will not exceed $70,000",
      "By September 30, 2026.",
      generation,
    );
    const vectors = await search.fetchOpenRouterEmbeddings("test", generation, [
      text,
    ]);
    assert.equal(vectors[0].length, 1024);
    const result = await signals.callOpenRouterEmbeddings(
      signals.resolveArgs(["--max-retries", "0"]),
      [text],
      generation,
    );
    assert.equal(result.vectors[0]?.length, 1024);
    assert.equal(result.usage.promptTokens, 19);
    assert.equal(result.cost.chargedCostUsd, 0.000001);
    for (const request of requests.slice(-2)) {
      assert.equal(request.model, model);
      assert.deepEqual(request.input, [text]);
      assert.equal(
        request.dimensions,
        model.startsWith("qwen/") ? 1024 : undefined,
      );
    }
  }
  assert.equal(requests.length, 4);
  for (const model of [
    "intfloat/e5-large-v2",
    "qwen/qwen3-embedding-8b",
  ] as const) {
    const generation = generationForPolicy(
      embeddingPolicySchema.parse({ model }),
    );
    for (const count of [129, 200]) {
      const texts = Array.from({ length: count }, (_, i) =>
        buildNewsEmbeddingText(`fixture-${i}`, "", generation),
      );
      for (const consumer of ["search", "signals"] as const) {
        const requestOffset = requests.length;
        const result =
          consumer === "search"
            ? {
                vectors: await search.fetchOpenRouterEmbeddings(
                  "test",
                  generation,
                  texts,
                ),
              }
            : await signals.callOpenRouterEmbeddings(
                signals.resolveArgs(["--max-retries", "0"]),
                texts,
                generation,
              );
        assert.equal(result.vectors.length, count);
        result.vectors.forEach((vector, i) => {
          assert.ok(vector);
          assert.equal(vector.length, 1024);
          assert.equal(
            vector[i],
            1,
            `${consumer} ${model} vector ${i} reordered across batches`,
          );
          assert.equal(
            vector.reduce((sum, value) => sum + value, 0),
            1,
          );
        });
        const batches = requests.slice(requestOffset);
        assert.deepEqual(
          batches.map((request) => request.input.length),
          [128, count - 128],
        );
        assert.deepEqual(
          batches.flatMap((request) => request.input),
          texts,
        );
        for (const request of batches) {
          assert.equal(request.model, model);
          assert.equal(
            request.dimensions,
            model.startsWith("qwen/") ? 1024 : undefined,
          );
        }
        if ("usage" in result) {
          assert.equal(result.usage.promptTokens, 38);
          assert.equal(result.cost.chargedCostUsd, 0.000002);
        }
      }
    }
  }

  const generation = generationForPolicy(embeddingPolicySchema.parse({}));
  const assertLeaseError = new Error("embedding_generation_pin_lost");
  const pinnedCalls = [
    (assertPin: () => void) =>
      search.fetchOpenRouterEmbeddings(
        "test",
        generation,
        ["fixture"],
        assertPin,
      ),
    (assertPin: () => void) =>
      signals.callOpenRouterEmbeddings(
        signals.resolveArgs(["--max-retries", "1"]),
        ["fixture"],
        generation,
        assertPin,
      ),
    (assertPin: () => void) =>
      search.callXaiWithRetry(
        search.resolveArgs(["--max-retries", "1", "--retry-base-ms", "1"]),
        "test",
        { system: "fixture", user: "fixture" },
        [],
        assertPin,
      ),
    (assertPin: () => void) =>
      signals.callOpenRouter(
        signals.resolveArgs(["--max-retries", "1", "--retry-base-ms", "1"]),
        "fixture",
        "fixture",
        assertPin,
      ),
  ];
  for (const call of pinnedCalls) {
    let paidAttempts = 0;
    let pinChecks = 0;
    let pinLost = false;
    globalThis.fetch = async () => {
      paidAttempts += 1;
      pinLost = true;
      return new Response("temporary provider error", { status: 503 });
    };
    await assert.rejects(
      call(() => {
        pinChecks += 1;
        if (pinLost) throw assertLeaseError;
      }),
      (error) => error === assertLeaseError,
    );
    assert.equal(
      paidAttempts,
      1,
      "lost lease must prevent a second paid attempt",
    );
    assert.equal(pinChecks, 2, "lease errors escape instead of being retried");
  }

  for (const consumer of ["search", "signals"] as const) {
    let paidBatches = 0;
    let pinLost = false;
    globalThis.fetch = async (_url, options) => {
      paidBatches += 1;
      const request = JSON.parse(String(options?.body));
      pinLost = true;
      return new Response(
        JSON.stringify({
          model: generation.model,
          data: request.input.map((_text: string, index: number) => ({
            index,
            embedding: Array.from({ length: 1024 }, (_, i) =>
              i === 0 ? 1 : 0,
            ),
          })),
        }),
      );
    };
    const assertPin = () => {
      if (pinLost) throw assertLeaseError;
    };
    const texts = Array.from({ length: 129 }, (_, i) => `fixture-${i}`);
    await assert.rejects(
      consumer === "search"
        ? search.fetchOpenRouterEmbeddings("test", generation, texts, assertPin)
        : signals.callOpenRouterEmbeddings(
            signals.resolveArgs([]),
            texts,
            generation,
            assertPin,
          ),
      (error) => error === assertLeaseError,
    );
    assert.equal(
      paidBatches,
      1,
      "lost lease prevents the next embedding sub-batch",
    );
  }

  let repairPaidCalls = 0;
  let repairPinLost = false;
  globalThis.fetch = async () => {
    repairPaidCalls += 1;
    repairPinLost = true;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
    );
  };
  await assert.rejects(
    signals.evaluateNodeWithModel({
      args: signals.resolveArgs([]),
      runId: "fixture",
      bucket: {
        nodeId: "fixture",
        nodeLabel: "Fixture",
        level: 1,
        evidence: [
          {
            id: "evidence",
            headline: "Fixture",
            summary: "Fixture",
            sourceUrl: "https://example.test/fixture",
            sourceDomain: "example.test",
            publishedAt: null,
            confirmation: "confirmed",
            sourceTier: "official",
            relevance: 1,
            confidence: 1,
            nodeId: "fixture",
            callIndex: 0,
            assignedNodeId: "fixture",
            assignedSimilarity: 1,
            routeReason: "leaf_self",
          },
        ],
      },
      candidateMarkets: [
        {
          marketId: "market",
          eventId: "event",
          eventTitle: "Fixture",
          marketTitle: "Fixture",
          closeTime: null,
          venue: "polymarket",
          activityVolume: 1,
          depthProxy: 1,
          openInterest: null,
          eventScore: 1,
          affinityScore: 1,
          contractMatchScore: 1,
          selectionScore: 1,
          affinityRank: 1,
        },
      ],
      assertGenerationPin: () => {
        if (repairPinLost) throw assertLeaseError;
      },
    }),
    (error) => error === assertLeaseError,
  );
  assert.equal(
    repairPaidCalls,
    1,
    "lost lease blocks paid schema-repair calls",
  );

  // The caller's finally/release must not run while a nested sibling operation
  // is still in flight, even when its peer fails immediately.
  for (const drain of [
    build.drainPromises,
    signals.drainPromises,
    (work: Promise<Map<string, number[] | null>>[]) =>
      signals.toMarketCandidates([], new Map(), 1, [], {
        includeSemanticAffinity: true,
        getEvidenceEmbeddings: () => work[0],
        getMarketEmbeddings: () => work[1],
      }),
  ]) {
    let settleDelayed!: () => void;
    let released = false;
    const delayed = new Promise<Map<string, number[] | null>>((resolve) => {
      settleDelayed = () => resolve(new Map());
    });
    const pending = drain([
      delayed,
      Promise.reject(new Error("market_vector_read_failed")),
    ]).finally(() => {
      released = true;
    });
    const failure = assert.rejects(pending, /market_vector_read_failed/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      released,
      false,
      "pin must remain until the delayed sibling settles",
    );
    settleDelayed();
    await failure;
    assert.equal(released, true);
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "✓ Real map embedding requests honor model, vectors and usage; lease loss blocks retries/sub-batches and nested work drains before release",
);
