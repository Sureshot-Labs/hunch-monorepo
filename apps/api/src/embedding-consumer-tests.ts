import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  EMBEDDING_ACTIVE_KEY,
  LEGACY_EMBEDDING_GENERATION,
  embeddingPolicySchema,
  generationForPolicy,
  generationForSnapshot,
  readActiveGeneration,
  embeddingKey,
  embeddingIndex,
  embeddingCachePrefix,
  embeddingVectorBuffer,
} from "@hunch/embeddings";
import {
  resolveConsumerEmbeddingModel,
  validEmbeddingBuffer,
} from "./lib/embedding-consumer.js";

const e5 = generationForPolicy(
  embeddingPolicySchema.parse({ model: "intfloat/e5-large-v2" }),
);
const qwen = generationForPolicy(
  embeddingPolicySchema.parse({ model: "qwen/qwen3-embedding-8b" }),
);
let active = JSON.stringify(e5);
let reads = 0;
const redis = {
  async get(key: string) {
    assert.equal(key, EMBEDDING_ACTIVE_KEY);
    reads += 1;
    return active;
  },
};

// A request/job captures once: activation mid-request must not mix seed/index.
const captured = await readActiveGeneration(redis);
active = JSON.stringify(qwen);
assert.equal(reads, 1);
assert.equal(captured.id, e5.id);
assert.notEqual(
  embeddingIndex(captured, "event"),
  embeddingIndex(qwen, "event"),
);
assert.notEqual(
  embeddingKey(captured, "market", "polymarket:1"),
  embeddingKey(qwen, "market", "polymarket:1"),
);
assert.notEqual(embeddingCachePrefix(captured), embeddingCachePrefix(qwen));
assert.equal((await readActiveGeneration(redis)).id, qwen.id);

// Static maps retain provenance, but only running jobs pin the old vector space.
assert.deepEqual(
  generationForSnapshot({ runId: "old-map" }),
  LEGACY_EMBEDDING_GENERATION,
);
assert.equal(generationForSnapshot({ embeddingGeneration: e5 }).id, e5.id);
assert.equal(resolveConsumerEmbeddingModel(e5), e5.model);
assert.equal(resolveConsumerEmbeddingModel(e5, e5.model), e5.model);
assert.throws(
  () => resolveConsumerEmbeddingModel(e5, qwen.model),
  /snapshot_mismatch/,
);
assert.throws(() =>
  generationForSnapshot({ embeddingGeneration: { ...e5, dimensions: 4096 } }),
);

const vector = embeddingVectorBuffer(
  Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
  e5,
);
assert.equal(validEmbeddingBuffer(vector, e5), vector);
assert.equal(validEmbeddingBuffer(null, e5), null);
assert.equal(validEmbeddingBuffer(Buffer.alloc(4096), e5), null);
assert.equal(validEmbeddingBuffer(Buffer.alloc(4092), e5), null);
const invalid = Buffer.from(vector);
invalid.writeFloatLE(Number.NaN, 0);
assert.equal(validEmbeddingBuffer(invalid, e5), null);

// Guard the concrete consumer integrations: no hard-coded old key/index can
// silently bypass generation isolation when a second model is introduced.
const consumers = [
  "routes/markets.ts",
  "routes/events.ts",
  "routes/feed.ts",
  "ai-map-build-run.ts",
  "ai-map-search-run.ts",
  "ai-map-signals-run.ts",
  "ai-embed-cluster.ts",
];
for (const path of consumers) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:idx:)?ai:embed:(?:market|event):?/, path);
  assert.match(source, /embeddingKey\(\s*generation,/, path);
  if (path.startsWith("routes/")) {
    assert.match(source, /withEmbeddingPinScope/, path);
    assert.match(source, /acquirePin\(\s*redis,\s*generation,/, path);
    assert.match(source, /pin\.assertHeld\(\)/, path);
    assert.match(source, /randomUUID\(\)/, path);
  } else {
    assert.match(
      source,
      /acquireEmbeddingGenerationPin\(\s*redis,\s*generation,/,
      path,
    );
  }
  if (path.startsWith("ai-map-")) {
    assert.match(source, /generationPin\?\.release\(\)/, path);
    assert.match(source, /randomUUID\(\)/, path);
    assert.doesNotMatch(source, /`map:\$\{runId\}`/, path);
  }
}
for (const path of ["ai-map-search-runner.ts", "ai-map-signals-runner.ts"]) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /addArgIfMissing\(searchArgs, "--embed-model"/,
    path,
  );
}
console.log(
  "✓ Embedding consumers: captured generation, bounded job pins, distinct caches/indexes, model override rejection, malformed seeds, runner compatibility",
);
