import { createHash } from "node:crypto";
import { z } from "zod";

export const EMBEDDING_MODELS = [
  "intfloat/e5-large-v2",
  "qwen/qwen3-embedding-8b",
] as const;
export type EmbeddingModel = (typeof EMBEDDING_MODELS)[number];
const policyFields = {
  enabled: z.boolean(),
  model: z.enum(EMBEDDING_MODELS),
  dimensions: z.literal(1024),
  textVersion: z.literal("clean-v1"),
  autoActivate: z.boolean(),
  generationBudgetUsd: z.number().finite().positive().max(100),
  batchSize: z.number().int().min(1).max(128),
  concurrency: z.number().int().min(1).max(4),
  requestTimeoutMs: z.number().int().min(1000).max(120000),
};
export const embeddingPolicyOverrideSchema = z
  .object(policyFields)
  .partial()
  .strict();
export const embeddingPolicySchema = z
  .object({
    enabled: policyFields.enabled.default(true),
    model: policyFields.model.default("qwen/qwen3-embedding-8b"),
    dimensions: policyFields.dimensions.default(1024),
    textVersion: policyFields.textVersion.default("clean-v1"),
    autoActivate: policyFields.autoActivate.default(true),
    generationBudgetUsd: policyFields.generationBudgetUsd.default(5),
    batchSize: policyFields.batchSize.default(64),
    concurrency: policyFields.concurrency.default(2),
    requestTimeoutMs: policyFields.requestTimeoutMs.default(30000),
  })
  .strict();
export type EmbeddingPolicy = z.infer<typeof embeddingPolicySchema>;
export const DEFAULT_EMBEDDING_POLICY: Readonly<EmbeddingPolicy> =
  Object.freeze(embeddingPolicySchema.parse({}));

export type EmbeddingKind = "market" | "event";
export type EmbeddingSource = {
  kind: EmbeddingKind;
  id: string;
  venue: string;
  status: string;
  title: string;
  eventTitle?: string | null;
  description?: string | null;
  category?: string | null;
  outcomes?: string[];
  topMarkets?: string[];
  marketType?: string | null;
  eligible: boolean;
};
export type EmbeddingGeneration = {
  id: string;
  model: EmbeddingModel;
  dimensions: 1024;
  textVersion: string;
  adapterVersion: string;
  legacy?: boolean;
};
export const LEGACY_EMBEDDING_GENERATION: Readonly<EmbeddingGeneration> =
  Object.freeze({
    id: "legacy-e5",
    model: "intfloat/e5-large-v2",
    dimensions: 1024,
    textVersion: "legacy-v1",
    adapterVersion: "legacy-v1",
    legacy: true,
  });
const ADAPTER_VERSIONS: Record<EmbeddingModel, string> = {
  "intfloat/e5-large-v2": "e5-query-v1",
  "qwen/qwen3-embedding-8b": "qwen-retrieval-v1",
};
export function generationForPolicy(
  policy: EmbeddingPolicy,
): EmbeddingGeneration {
  const validated = embeddingPolicySchema.parse(policy);
  const descriptor = {
    model: validated.model,
    dimensions: validated.dimensions,
    textVersion: validated.textVersion,
    adapterVersion: ADAPTER_VERSIONS[validated.model],
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(descriptor))
    .digest("hex")
    .slice(0, 20);
  return { id: `g-${digest}`, ...descriptor };
}

export function parseEmbeddingGeneration(value: unknown): EmbeddingGeneration {
  const parsed = z
    .object({
      id: z.string(),
      model: z.enum(EMBEDDING_MODELS),
      dimensions: z.literal(1024),
      textVersion: z.string(),
      adapterVersion: z.string(),
      legacy: z.boolean().optional(),
    })
    .strict()
    .parse(value);
  const expected = parsed.legacy
    ? LEGACY_EMBEDDING_GENERATION
    : generationForPolicy(
        embeddingPolicySchema.parse({
          model: parsed.model,
          textVersion: parsed.textVersion,
        }),
      );
  if (
    parsed.id !== expected.id ||
    parsed.model !== expected.model ||
    parsed.textVersion !== expected.textVersion ||
    parsed.adapterVersion !== expected.adapterVersion
  ) {
    throw new Error("Invalid or unsupported embedding generation descriptor");
  }
  return parsed;
}

export const EMBEDDING_ACTIVE_KEY = "ai:embed:control:active";
export const EMBEDDING_STATUS_KEY = "ai:embed:control:status";
export const embeddingGenerationKey = (generation: EmbeddingGeneration) =>
  `ai:embed:control:generation:${generation.id}`;
export const embeddingPinsKey = (generation: EmbeddingGeneration) =>
  `ai:embed:control:pins:${generation.id}`;
export function embeddingKey(
  generation: EmbeddingGeneration,
  kind: EmbeddingKind,
  id: string,
): string {
  return `${generation.legacy ? "ai:embed" : `ai:embed:${generation.id}`}:${kind}:${id}`;
}
export function embeddingIndex(
  generation: EmbeddingGeneration,
  kind: EmbeddingKind,
): string {
  return `${generation.legacy ? "idx:ai:embed" : `idx:ai:embed:${generation.id}`}:${kind}`;
}
export function embeddingCachePrefix(generation: EmbeddingGeneration): string {
  return `ai:embed:cache:${generation.id}`;
}
type ReadableRedis = { get(key: string): Promise<string | null> };
type CommandRedis = { sendCommand(args: string[]): Promise<unknown> };
export const PIN_EMBEDDING_GENERATION_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
if ARGV[3] == '1' then
  local active = redis.call('GET', KEYS[4])
  local activeId = ARGV[5]
  if active then activeId = cjson.decode(active).id end
  if activeId ~= ARGV[4] then return 0 end
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
return 1`;
export async function readActiveGeneration(
  redis: ReadableRedis,
): Promise<EmbeddingGeneration> {
  const raw = await redis.get(EMBEDDING_ACTIVE_KEY);
  return raw == null
    ? LEGACY_EMBEDDING_GENERATION
    : parseEmbeddingGeneration(JSON.parse(raw));
}
export function generationForSnapshot(metadata?: unknown): EmbeddingGeneration {
  if (!metadata || typeof metadata !== "object")
    return LEGACY_EMBEDDING_GENERATION;
  const value = (metadata as Record<string, unknown>).embeddingGeneration;
  return value == null
    ? LEGACY_EMBEDDING_GENERATION
    : parseEmbeddingGeneration(value);
}
export async function pinGeneration(
  redis: CommandRedis,
  generation: EmbeddingGeneration,
  owner: string,
  ttlSec: number,
  options: { requireActive?: boolean } = {},
): Promise<boolean> {
  if (!owner.trim() || !Number.isFinite(ttlSec) || ttlSec <= 0)
    throw new Error("Invalid embedding generation pin");
  const result = await redis.sendCommand([
    "EVAL",
    PIN_EMBEDDING_GENERATION_LUA,
    "4",
    embeddingPinsKey(generation),
    `ai:embed:control:deleting:${generation.id}`,
    `ai:embed:control:deleted:${generation.id}`,
    EMBEDDING_ACTIVE_KEY,
    String(Date.now() + ttlSec * 1000),
    owner,
    options.requireActive ? "1" : "0",
    generation.id,
    LEGACY_EMBEDDING_GENERATION.id,
  ]);
  if (Number(result) !== 1 && !options.requireActive)
    throw new Error("Embedding generation is no longer available");
  return Number(result) === 1;
}

/** A running job, unlike its published artifacts, retains its captured generation.
 * Call assertHeld before vector/provider work; always release in finally. */
export async function acquireEmbeddingGenerationPin(
  redis: CommandRedis,
  generation: EmbeddingGeneration,
  owner: string,
  ttlSec = 300,
): Promise<null | { assertHeld(): void; release(): Promise<void> }> {
  let deadline = Date.now() + ttlSec * 1000;
  if (
    !(await pinGeneration(redis, generation, owner, ttlSec, {
      requireActive: true,
    }))
  )
    return null;
  let released = false;
  let failed = false;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const assertHeld = () => {
    if (released || failed || Date.now() >= deadline)
      throw new Error("embedding_generation_pin_lost");
  };
  const schedule = () => {
    timer = setTimeout(
      () => {
        pending = (async () => {
          try {
            assertHeld();
            const nextDeadline = Date.now() + ttlSec * 1000;
            await pinGeneration(redis, generation, owner, ttlSec);
            // A delayed response cannot resurrect an expired local lease.
            assertHeld();
            deadline = nextDeadline;
          } catch {
            failed = true;
          }
          if (!released && !failed) schedule();
        })();
      },
      (ttlSec * 1000) / 3,
    );
    timer.unref();
  };
  schedule();
  return {
    assertHeld,
    async release() {
      released = true;
      clearTimeout(timer);
      // Finish any in-flight renewal before deleting this execution's unique pin.
      await pending;
      await redis.sendCommand(["ZREM", embeddingPinsKey(generation), owner]);
    },
  };
}

export function embeddingTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
/** Never coerce malformed values or compare vectors from a different-sized space. */
export function parseEmbeddingVector(
  input: unknown,
  generation: EmbeddingGeneration,
): number[] | null {
  let values: number[];
  if (input instanceof Uint8Array) {
    if (input.byteLength !== generation.dimensions * 4) return null;
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    values = Array.from({ length: generation.dimensions }, (_, i) =>
      view.getFloat32(i * 4, true),
    );
  } else if (Array.isArray(input)) {
    if (
      input.length !== generation.dimensions ||
      !input.every((value) => typeof value === "number")
    )
      return null;
    values = input;
  } else return null;
  if (!values.every(Number.isFinite)) return null;
  const norm = Math.hypot(...values);
  return Number.isFinite(norm) && norm > 0 ? values : null;
}
export function embeddingVectorBuffer(
  vector: number[],
  generation: EmbeddingGeneration,
): Buffer {
  const validated = parseEmbeddingVector(vector, generation);
  if (!validated) throw new Error("Invalid embedding vector");
  const norm = Math.hypot(...validated);
  const buffer = Buffer.alloc(generation.dimensions * 4);
  validated.forEach((value, index) =>
    buffer.writeFloatLE(value / norm, index * 4),
  );
  return buffer;
}
