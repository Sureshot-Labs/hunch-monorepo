import { createHash, randomUUID } from "node:crypto";
import {
  acquireEmbeddingGenerationPin,
  buildNewsEmbeddingInput,
  embeddingCachePrefix,
  embeddingIndex,
  embeddingKey,
  fetchEmbeddingBatch,
  parseEmbeddingVector,
  readActiveGeneration,
  type EmbeddingGeneration,
} from "@hunch/embeddings";
import { RESP_TYPES } from "redis";
import type { AgentAuthor } from "./agent-theses-policy.js";
import type { AgentRedis } from "./agent-theses-state.js";

export type AgentInterestEmbedder = (
  generation: EmbeddingGeneration,
  texts: string[],
) => Promise<number[][]>;

/** Same rolling ledger as the caller's Jev/writer, never a separate free budget. */
export function createAgentInterestEmbedder(input: {
  apiKey: string;
  runId: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  reserve: (
    id: string,
    amount: number,
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  settle: (id: string, amount: number | null) => Promise<void>;
  record: (record: Record<string, unknown>) => void | Promise<void>;
}): AgentInterestEmbedder {
  let sequence = 0;
  return async (generation, texts) => {
    const callId = `${input.runId}:embedding:${++sequence}`;
    let cost: number | null = null;
    let reserved = false;
    let reserveUsd = 0;
    let status = "error";
    try {
      const result = await fetchEmbeddingBatch({
        generation,
        texts,
        apiKey: input.apiKey,
        timeoutMs: 15000,
        maxAttempts: 1,
        fetch: (url, init) =>
          (input.fetchImpl ?? fetch)(url, {
            ...init,
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              ...(input.signal ? [input.signal] : []),
            ]),
          }),
        beforeAttempt: async ({ estimatedCostUsd }) => {
          input.signal?.throwIfAborted();
          reserveUsd = Math.max(0.001, estimatedCostUsd);
          await input.reserve(callId, reserveUsd, {
            stage: "interest_embedding",
            model: generation.model,
          });
          reserved = true;
        },
      });
      cost = result.usage.costUsd;
      status = "response";
      return result.embeddings;
    } finally {
      if (reserved) {
        await input.settle(callId, cost);
        await input.record({
          callId,
          stage: "interest_embedding",
          model: generation.model,
          status,
          chargedUsd: cost ?? reserveUsd,
          costSource: cost == null ? "reserved_unknown" : "provider",
        });
      }
    }
  };
}

/** IDs are derived routing hints, not facts or a permission to settle related contracts. */
export async function agentSemanticNeighbors(
  redis: AgentRedis,
  generation: EmbeddingGeneration,
  vector: number[],
  maximum: number,
  minimumSimilarity = -1,
): Promise<string[]> {
  if (!parseEmbeddingVector(vector, generation)) return [];
  const take = Math.min(120, Math.max(1, Math.floor(maximum)));
  const raw = (await redis.sendCommand([
    "FT.SEARCH",
    embeddingIndex(generation, "market"),
    `(@status:{ACTIVE})=>[KNN ${take} @embedding $vec AS score]`,
    "PARAMS",
    "2",
    "vec",
    Buffer.from(new Float32Array(vector).buffer),
    "SORTBY",
    "score",
    "RETURN",
    "1",
    "score",
    "LIMIT",
    "0",
    String(take),
    "TIMEOUT",
    "1000",
    "DIALECT",
    "2",
  ])) as unknown[];
  const prefix = embeddingKey(generation, "market", "");
  const ids = new Set<string>();
  for (let i = 1; i < raw.length; i += 2) {
    const key = String(raw[i]);
    const fields = raw[i + 1];
    if (!key.startsWith(prefix) || !Array.isArray(fields)) continue;
    const at = fields.findIndex((field) => String(field) === "score");
    const distance = at < 0 ? NaN : Number(fields[at + 1]);
    if (
      Number.isFinite(distance) &&
      distance >= 0 &&
      distance <= 1 - minimumSimilarity &&
      key.length > prefix.length
    )
      ids.add(key.slice(prefix.length));
  }
  return [...ids].slice(0, take);
}

export function interleaveAgentMatches(groups: string[][], maximum: number) {
  const result = new Set<string>();
  for (let i = 0; i < Math.max(0, ...groups.map((g) => g.length)); i++) {
    for (const group of groups) {
      if (result.size >= maximum) return [...result];
      if (group[i]) result.add(group[i]);
    }
  }
  return [...result];
}

export async function retrieveAgentInterests(input: {
  redis: AgentRedis;
  authors: Pick<AgentAuthor, "userId" | "interests">[];
  maximum: number;
  embed?: AgentInterestEmbedder;
  assertLease: () => Promise<void>;
}) {
  const started = Date.now();
  const byAuthor: Record<string, string[]> = {};
  const diagnostics: string[] = [];
  const stats = {
    authors: 0,
    cacheHits: 0,
    generated: 0,
    busy: 0,
    deferred: 0,
    boundedInputs: 0,
    durationMs: 0,
  };
  const capacity = Math.floor(input.maximum / 2);
  // At most one query per reserved pool slot. The scheduled pool owner rotates,
  // so even teams larger than the pool are not permanently omitted.
  const authors = input.authors.slice(0, capacity);
  stats.authors = authors.length;
  stats.deferred = input.authors.length - authors.length;
  if (!authors.length) return { marketIds: [], byAuthor, diagnostics, stats };
  const owner = randomUUID();
  const locks: string[] = [];
  let pin: Awaited<ReturnType<typeof acquireEmbeddingGenerationPin>> = null;
  try {
    await input.assertLease();
    const generation = await readActiveGeneration(input.redis);
    pin = await acquireEmbeddingGenerationPin(
      input.redis,
      generation,
      `agent-interest:${owner}`,
      120,
    );
    if (!pin) throw new Error("interest_generation_unavailable");
    // Do not charge for an interest vector when the matching catalogue is absent.
    await input.redis.sendCommand([
      "FT.INFO",
      embeddingIndex(generation, "market"),
    ]);
    const groups = new Map<
      string,
      { text: string; authors: string[]; vector: number[] | null }
    >();
    for (const author of authors) {
      const prepared = buildNewsEmbeddingInput(
        author.interests,
        "",
        generation,
      );
      if (prepared.truncated) stats.boundedInputs++;
      const text = prepared.text;
      const hash = createHash("sha256")
        .update(JSON.stringify([author.interests, text]))
        .digest("hex");
      const key = `${embeddingCachePrefix(generation)}:agent-interest:v1:${hash}`;
      const group = groups.get(key) ?? { text, authors: [], vector: null };
      group.authors.push(author.userId);
      groups.set(key, group);
    }
    const cached = await input.redis.mGet([...groups.keys()]);
    const missing: string[] = [];
    for (const [i, [key, group]] of [...groups.entries()].entries()) {
      try {
        group.vector = parseEmbeddingVector(
          JSON.parse(cached[i] ?? "null"),
          generation,
        );
      } catch {
        /* rebuild malformed derived cache */
      }
      if (group.vector) {
        stats.cacheHits++;
        continue;
      }
      if (!input.embed) continue;
      const lockKey = `${key}:lock`;
      if (
        (await input.redis.set(lockKey, owner, { NX: true, EX: 60 })) === "OK"
      ) {
        locks.push(lockKey);
        // Another run may have populated/released between mGet and SET NX.
        try {
          group.vector = parseEmbeddingVector(
            JSON.parse((await input.redis.get(key)) ?? "null"),
            generation,
          );
        } catch {
          /* rebuild malformed derived cache */
        }
        if (group.vector) stats.cacheHits++;
        else missing.push(key);
      } else stats.busy++;
    }
    if (missing.length && input.embed) {
      const pendingGroups = [...groups.entries()].filter(([key]) =>
        missing.includes(key),
      );
      pin.assertHeld();
      await input.assertLease();
      let vectors: number[][] = [];
      try {
        vectors = await input.embed(
          generation,
          pendingGroups.map(([, group]) => group.text),
        );
        if (
          vectors.length !== missing.length ||
          vectors.some((v) => !parseEmbeddingVector(v, generation))
        )
          throw new Error("interest_invalid_vectors");
      } catch (error) {
        if (
          error instanceof Error &&
          [
            "agent_budget_exhausted",
            "agent_lease_lost",
            "preview_interrupted",
          ].includes(error.message)
        )
          throw error;
        // Optional cache misses must not discard already cached interest matches.
        diagnostics.push("interest_embedding_unavailable");
        vectors = [];
      }
      pin.assertHeld();
      await input.assertLease();
      for (const [i, [key, group]] of pendingGroups.entries()) {
        if (!vectors[i]) continue;
        if ((await input.redis.get(`${key}:lock`)) !== owner) {
          diagnostics.push("interest_cache_lease_lost");
          continue;
        }
        group.vector = vectors[i];
        await input.redis.set(key, JSON.stringify(vectors[i]), {
          EX: 30 * 86400,
        });
        stats.generated++;
      }
    }
    const take = Math.min(
      120,
      Math.max(3, Math.ceil(capacity / Math.max(1, groups.size)) * 3),
    );
    for (const group of groups.values()) {
      if (!group.vector) continue;
      pin.assertHeld();
      await input.assertLease();
      const ids = await agentSemanticNeighbors(
        input.redis,
        generation,
        group.vector,
        take,
      );
      pin.assertHeld();
      for (const id of group.authors) byAuthor[id] = ids;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (
      [
        "agent_budget_exhausted",
        "agent_lease_lost",
        "preview_interrupted",
      ].includes(code)
    )
      throw error;
    diagnostics.push("interest_semantic_unavailable");
    // A lost generation pin invalidates every derived match in this pass.
    for (const id of Object.keys(byAuthor)) delete byAuthor[id];
  } finally {
    await pin?.release();
    for (const key of locks)
      await input.redis.eval(
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
        { keys: [key], arguments: [owner] },
      );
    stats.durationMs = Date.now() - started;
  }
  if (stats.busy) diagnostics.push("interest_cache_busy_fallback");
  if (stats.deferred) diagnostics.push("interest_authors_rotated");
  if (stats.boundedInputs) diagnostics.push("interest_text_token_bounded");
  return {
    marketIds: interleaveAgentMatches(
      authors.map((a) => byAuthor[a.userId] ?? []),
      capacity,
    ),
    byAuthor,
    diagnostics,
    stats,
  };
}

export async function relatedAgentMarkets(redis: AgentRedis, marketId: string) {
  const generation = await readActiveGeneration(redis);
  const pin = await acquireEmbeddingGenerationPin(
    redis,
    generation,
    `agent-context:${randomUUID()}`,
    120,
  );
  if (!pin) return [];
  try {
    const binary = redis.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
    const vector = parseEmbeddingVector(
      await binary.hGet(
        embeddingKey(generation, "market", marketId),
        "embedding",
      ),
      generation,
    );
    if (!vector) return [];
    // Same broad relevance floor as cached-news enrichment, not a publication gate.
    const ids = await agentSemanticNeighbors(
      redis,
      generation,
      vector,
      5,
      0.35,
    );
    pin.assertHeld();
    return ids.filter((id) => id !== marketId).slice(0, 4);
  } finally {
    await pin.release();
  }
}
