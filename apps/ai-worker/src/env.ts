import { config } from "dotenv";
import { dirname, resolve } from "path";
import { hostname } from "os";
import { fileURLToPath } from "url";

const envPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
if (process.env.HUNCH_RUNTIME_SECRETS_LOADED !== "1") {
  config({ path: envPath, override: true });
}

function parseOptionalInt(v: string | undefined): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function clampInt(
  v: number | undefined,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  if (v == null || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[env] Missing ${name}. Make sure it's in ${envPath}`);
    process.exit(1);
  }
  return v;
}

const batchSizeRaw = parseOptionalInt(process.env.AI_EMBED_BATCH_SIZE);
const batchSize = clampInt(batchSizeRaw, { min: 1, max: 200, fallback: 50 });

const concurrencyRaw = parseOptionalInt(process.env.AI_EMBED_CONCURRENCY);
const concurrency = clampInt(concurrencyRaw, { min: 1, max: 32, fallback: 4 });

const blockMsRaw = parseOptionalInt(process.env.AI_EMBED_BLOCK_MS);
const blockMs = clampInt(blockMsRaw, {
  min: 100,
  max: 60_000,
  fallback: 2_000,
});

const textVersion = process.env.AI_EMBED_TEXT_VERSION ?? "v3";
const ttlRaw = parseOptionalInt(process.env.AI_EMBED_TTL_SEC);
const embedTtlSec = clampInt(ttlRaw, {
  min: 3600,
  max: 30 * 24 * 3600,
  fallback: 2 * 24 * 3600,
});

const streamMaxLenRaw = parseOptionalInt(process.env.AI_EMBED_STREAM_MAXLEN);
const streamMaxLen =
  streamMaxLenRaw === 0
    ? 0
    : clampInt(streamMaxLenRaw, {
        min: 10_000,
        max: 5_000_000,
        fallback: 200_000,
      });

const logIntervalRaw = parseOptionalInt(process.env.AI_EMBED_LOG_INTERVAL_MS);
const logIntervalMs = clampInt(logIntervalRaw, {
  min: 1000,
  max: 600_000,
  fallback: 10_000,
});

export const env = {
  redisUrl: req("REDIS_URL"),
  openRouterKey: req("OPENROUTER_API_KEY"),
  embedModel: process.env.OPENROUTER_EMBED_MODEL ?? "intfloat/e5-large-v2",
  streamKey: process.env.AI_EMBED_STREAM_KEY ?? "ai:embed:queue:active",
  group: process.env.AI_EMBED_GROUP ?? "ai-embedder",
  consumer: process.env.AI_EMBED_CONSUMER ?? `ai-worker-${hostname()}`,
  batchSize,
  concurrency,
  blockMs,
  textVersion,
  embedTtlSec,
  streamMaxLen,
  logIntervalMs,
  maxTextChars: clampInt(parseOptionalInt(process.env.AI_EMBED_MAX_CHARS), {
    min: 200,
    max: 5000,
    fallback: 1500,
  }),
  maxDescriptionChars: clampInt(
    parseOptionalInt(process.env.AI_EMBED_DESC_MAX_CHARS),
    { min: 50, max: 2000, fallback: 500 },
  ),
  maxTopMarketsChars: clampInt(
    parseOptionalInt(process.env.AI_EMBED_TOP_MARKETS_MAX_CHARS),
    { min: 50, max: 2000, fallback: 320 },
  ),
  enabled: (process.env.AI_EMBED_ENABLED ?? "true") !== "false",
};
