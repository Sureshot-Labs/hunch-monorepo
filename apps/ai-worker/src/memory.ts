import {
  embeddingIndex,
  embeddingKey,
  type EmbeddingGeneration,
} from "@hunch/embeddings";
import { record, type EmbeddingStore } from "./store.js";

const REDIS_LIMIT = 6 * 1024 ** 3;
const HEADROOM = 2 * 1024 ** 3;

export type MemoryAdmission = {
  generation: string;
  checkedAt: string;
  redisUsedBytes: number;
  workerAvailableBytes: number;
  projectedBytes: number;
  bytesPerItem: number;
  remainingItems: number;
  blockedBy:
    | "redis_used"
    | "worker_available"
    | "projection"
    | "invalid_measurement"
    | null;
};

export class EmbeddingMemoryError extends Error {
  constructor(readonly admission: MemoryAdmission) {
    super("embedding_memory_headroom");
  }
}

export function embeddingIndexMemoryBytes(
  info: Record<string, unknown>,
): number {
  const size = (value: unknown): number => {
    const parsed = value == null ? NaN : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new Error("embedding_memory_measurement_invalid");
    return parsed;
  };
  // RediSearch reports HNSW separately: total_index_memory_sz_mb excludes it.
  // Add vector memory exactly once in both the total and older-field fallback.
  const nonVectorMb =
    info.total_index_memory_sz_mb != null
      ? size(info.total_index_memory_sz_mb)
      : [
          "inverted_sz_mb",
          "doc_table_size_mb",
          "key_table_size_mb",
          "sortable_values_size_mb",
          "tag_overhead_sz_mb",
          "text_overhead_sz_mb",
        ].reduce((sum, field) => sum + size(info[field] ?? 0), 0);
  const bytes = (nonVectorMb + size(info.vector_index_sz_mb)) * 1024 ** 2;
  if (!Number.isFinite(bytes))
    throw new Error("embedding_memory_measurement_invalid");
  return bytes;
}

export function memoryAdmission(
  generation: string,
  used: number,
  available: number,
  remaining: number,
  perItem: number,
): MemoryAdmission {
  // Existing global memory is charged once, never extrapolated as per-item growth.
  const projected = used + Math.max(0, remaining) * perItem * 1.25;
  const blockedBy =
    ![used, available, remaining, perItem, projected].every(Number.isFinite) ||
    used < 0 ||
    available < 0 ||
    perItem < 0
      ? "invalid_measurement"
      : used > REDIS_LIMIT
        ? "redis_used"
        : available < HEADROOM
          ? "worker_available"
          : projected > REDIS_LIMIT
            ? "projection"
            : null;
  return {
    generation,
    checkedAt: new Date().toISOString(),
    redisUsedBytes: used,
    workerAvailableBytes: available,
    projectedBytes: projected,
    bytesPerItem: perItem,
    remainingItems: remaining,
    blockedBy,
  };
}

/** Bounded generation-owned measurements, not INFO memory deltas or a keyspace scan.
 * The 12 KiB floor and 25% projection margin remain conservative estimates,
 * not a proof of future allocation. Actual Redis/host limits are checked each tick.
 */
export async function embeddingBytesPerItem(
  store: EmbeddingStore,
  generation: EmbeddingGeneration,
) {
  let perItem = 12288;
  for (const kind of ["event", "market"] as const) {
    const index = embeddingIndex(generation, kind);
    const info = record(await store.redis.sendCommand(["FT.INFO", index]));
    const docs = Number(info.num_docs);
    const indexBytes = embeddingIndexMemoryBytes(info);
    if (
      !Number.isFinite(docs) ||
      docs < 0 ||
      !Number.isFinite(indexBytes) ||
      indexBytes < 0
    )
      throw new Error("embedding_memory_measurement_invalid");
    if (!docs) continue;
    const results = (await store.redis.sendCommand([
      "FT.SEARCH",
      index,
      "*",
      "NOCONTENT",
      "LIMIT",
      "0",
      "16",
    ])) as unknown[];
    let largestHash = 0;
    for (const result of results.slice(1)) {
      const key = String(result);
      if (!key.startsWith(embeddingKey(generation, kind, "")))
        throw new Error("embedding_memory_sample_invalid");
      const usage = Number(
        await store.redis.sendCommand(["MEMORY", "USAGE", key, "SAMPLES", "0"]),
      );
      if (!Number.isFinite(usage) || usage < 0)
        throw new Error("embedding_memory_measurement_invalid");
      largestHash = Math.max(largestHash, usage);
    }
    perItem = Math.max(perItem, largestHash + indexBytes / docs);
  }
  return perItem;
}
