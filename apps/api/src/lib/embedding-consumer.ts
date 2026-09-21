import {
  acquireEmbeddingGenerationPin,
  fetchEmbeddingBatch,
  parseEmbeddingVector,
  type EmbeddingBatchOptions,
  type EmbeddingBatchResult,
  type EmbeddingGeneration,
} from "@hunch/embeddings";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Keep request pins alive through every exit without owning the shared Redis client. */
export function withEmbeddingPinScope<
  Request extends FastifyRequest,
  Result = unknown,
>(
  operation: (
    acquirePin: typeof acquireEmbeddingGenerationPin,
    request: Request,
    reply: FastifyReply,
  ) => Promise<Result>,
): (request: Request, reply: FastifyReply) => Promise<Result> {
  return async (request, reply) => {
    const pins: NonNullable<
      Awaited<ReturnType<typeof acquireEmbeddingGenerationPin>>
    >[] = [];
    const acquirePin: typeof acquireEmbeddingGenerationPin = async (
      ...inputs
    ) => {
      const pin = await acquireEmbeddingGenerationPin(...inputs);
      if (pin) pins.push(pin);
      return pin;
    };
    try {
      return await operation(acquirePin, request, reply);
    } finally {
      const releases = pins.map((pin) => pin.release());
      await Promise.allSettled(releases);
      // Propagate failures only after every renewal has stopped and cleanup settled.
      await Promise.all(releases);
    }
  };
}

/** A job may collect more evidence than fits one validated provider request. */
export async function fetchConsumerEmbeddings(
  options: EmbeddingBatchOptions,
): Promise<EmbeddingBatchResult> {
  const result: EmbeddingBatchResult = {
    embeddings: [],
    usage: { inputTokens: 0, costUsd: 0 },
    attempts: 0,
  };
  // Keep batches sequential and in input order; each response validates its own
  // zero-based indexes before concatenation. Never expose a partial result.
  for (let start = 0; start < options.texts.length; start += 128) {
    const batch = await fetchEmbeddingBatch({
      ...options,
      texts: options.texts.slice(start, start + 128),
    });
    result.embeddings.push(...batch.embeddings);
    result.attempts += batch.attempts;
    for (const field of ["inputTokens", "costUsd"] as const) {
      const previous = result.usage[field];
      const current = batch.usage[field];
      result.usage[field] =
        previous == null || current == null ? null : previous + current;
    }
  }
  return result;
}

/** The snapshot, never a per-job override, owns the vector space. */
export function resolveConsumerEmbeddingModel(
  generation: EmbeddingGeneration,
  explicitModel?: string | null,
): string {
  if (explicitModel && explicitModel !== generation.model) {
    throw new Error(`embedding_model_snapshot_mismatch:${generation.id}`);
  }
  return generation.model;
}

/** Avoid sending malformed or foreign-dimensional seed vectors to KNN. */
export function validEmbeddingBuffer(
  value: unknown,
  generation: EmbeddingGeneration,
): Buffer | null {
  return Buffer.isBuffer(value) && parseEmbeddingVector(value, generation)
    ? value
    : null;
}
