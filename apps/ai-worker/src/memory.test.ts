import assert from "node:assert/strict";
import { test } from "node:test";
import { embeddingIndexMemoryBytes, memoryAdmission } from "./memory.js";

test("HNSW is added to the non-vector total exactly once, including the fallback", () => {
  assert.equal(
    embeddingIndexMemoryBytes({
      total_index_memory_sz_mb: "7",
      vector_index_sz_mb: "3",
      inverted_sz_mb: 999,
    }),
    10 * 1024 ** 2,
  );
  assert.equal(
    embeddingIndexMemoryBytes({
      vector_index_sz_mb: 3,
      inverted_sz_mb: 2,
      doc_table_size_mb: 3,
      key_table_size_mb: 1,
      sortable_values_size_mb: 1,
    }),
    10 * 1024 ** 2,
  );
  // Production Qwen market FT.INFO sample: the 10 MiB total omits 151 MiB HNSW.
  assert.equal(
    embeddingIndexMemoryBytes({
      total_index_memory_sz_mb: 10.106850624084473,
      vector_index_sz_mb: 151.416015625,
    }),
    169369001,
  );
});

test("invalid or missing HNSW measurements cannot silently understate admission", () => {
  for (const vector of [undefined, null, -1, NaN, Infinity, "not-a-number"])
    assert.throws(
      () =>
        embeddingIndexMemoryBytes({
          total_index_memory_sz_mb: 1,
          vector_index_sz_mb: vector,
        }),
      /measurement_invalid/,
    );
  assert.throws(
    () =>
      embeddingIndexMemoryBytes({
        total_index_memory_sz_mb: -1,
        vector_index_sz_mb: 10,
      }),
    /measurement_invalid/,
  );
  assert.throws(
    () =>
      embeddingIndexMemoryBytes({
        total_index_memory_sz_mb: Infinity,
        vector_index_sz_mb: 0,
      }),
    /measurement_invalid/,
  );
});

test("unrelated Redis growth is added once, never multiplied by remaining entities", () => {
  const before = memoryAdmission(
    "qwen",
    2 * 1024 ** 3,
    8 * 1024 ** 3,
    224000,
    12288,
  );
  const after = memoryAdmission(
    "qwen",
    2 * 1024 ** 3 + 300000000,
    8 * 1024 ** 3,
    224000,
    12288,
  );
  assert.equal(after.projectedBytes - before.projectedBytes, 300000000);
  assert.equal(after.blockedBy, null);
});
test("real Redis/host limits and genuine generation projection still block", () => {
  assert.equal(
    memoryAdmission("q", 7 * 1024 ** 3, 8 * 1024 ** 3, 0, 0).blockedBy,
    "redis_used",
  );
  assert.equal(
    memoryAdmission("q", 1 * 1024 ** 3, 1 * 1024 ** 3, 0, 0).blockedBy,
    "worker_available",
  );
  assert.equal(
    memoryAdmission("q", 2 * 1024 ** 3, 8 * 1024 ** 3, 1000000, 12288)
      .blockedBy,
    "projection",
  );
  assert.equal(
    memoryAdmission("q", NaN, 8 * 1024 ** 3, 0, 0).blockedBy,
    "invalid_measurement",
  );
  assert.equal(
    memoryAdmission("q", 1, NaN, 0, 0).blockedBy,
    "invalid_measurement",
  );
});
