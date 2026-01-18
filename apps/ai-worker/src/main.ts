import { createHash } from "crypto";
import { setTimeout as delay } from "timers/promises";
import { createRedisClient, ensureRedis } from "@hunch/infra";
import { env } from "./env.js";

const INDEX_MARKET = "idx:ai:embed:market";
const INDEX_EVENT = "idx:ai:embed:event";
const STREAM_KEY = env.streamKey;
const DLQ_KEY = "ai:embed:dead";
const LOG_INTERVAL_MS = env.logIntervalMs;

type StreamMessage = {
  id: string;
  fields: Record<string, string>;
};

type EmbedEntityType = "market" | "event";

type EmbedPayload = {
  entityType: EmbedEntityType;
  entityId: string;
  status: string;
  venue?: string;
  marketTitle?: string;
  eventTitle?: string;
  topMarkets?: string;
  description?: string;
  category?: string;
  outcomes?: string;
  marketType?: string;
  updatedAt?: string;
};

type WorkerStats = {
  received: number;
  invalid: number;
  inactive: number;
  cached: number;
  queued: number;
  embedded: number;
  missing: number;
  failed: number;
  lastLogAt: number;
};

const stats: WorkerStats = {
  received: 0,
  invalid: 0,
  inactive: 0,
  cached: 0,
  queued: 0,
  embedded: 0,
  missing: 0,
  failed: 0,
  lastLogAt: Date.now(),
};

function addStats(update: Partial<WorkerStats>): void {
  stats.received += update.received ?? 0;
  stats.invalid += update.invalid ?? 0;
  stats.inactive += update.inactive ?? 0;
  stats.cached += update.cached ?? 0;
  stats.queued += update.queued ?? 0;
  stats.embedded += update.embedded ?? 0;
  stats.missing += update.missing ?? 0;
  stats.failed += update.failed ?? 0;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const s = Math.round(seconds);
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours > 0) return `${hours}h ${remMins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

async function getGroupLag(
  redis: ReturnType<typeof createRedisClient>,
): Promise<number | null> {
  try {
    const groups = await redis.xInfoGroups(STREAM_KEY);
    const group = groups.find((entry) => entry.name === env.group);
    if (!group || group.lag == null) return null;
    return Number(group.lag);
  } catch {
    return null;
  }
}

async function maybeTrimStream(
  redis: ReturnType<typeof createRedisClient>,
): Promise<void> {
  if (env.streamMaxLen <= 0) return;
  try {
    const length = await redis.xLen(STREAM_KEY);
    if (length <= env.streamMaxLen) return;
    const removed = await redis.xTrim(STREAM_KEY, "MAXLEN", env.streamMaxLen, {
      strategyModifier: "~",
    });
    if (removed > 0) {
      console.log("[ai-worker] stream trimmed", {
        removed,
        maxLen: env.streamMaxLen,
        lengthBefore: length,
      });
    }
  } catch (err) {
    console.warn("[ai-worker] stream trim failed", err);
  }
}

async function flushStats(
  redis: ReturnType<typeof createRedisClient>,
  force = false,
): Promise<void> {
  const now = Date.now();
  const intervalMs = now - stats.lastLogAt;
  if (!force && intervalMs < LOG_INTERVAL_MS) return;
  const total =
    stats.received +
    stats.invalid +
    stats.inactive +
    stats.cached +
    stats.queued +
    stats.embedded +
    stats.missing +
    stats.failed;
  if (total === 0) {
    stats.lastLogAt = now;
    return;
  }
  const ratePerSec =
    intervalMs > 0 ? stats.received / (intervalMs / 1000) : 0;
  const lag = await getGroupLag(redis);
  const etaSec =
    lag != null && ratePerSec > 0 ? Math.ceil(lag / ratePerSec) : null;

  console.log("[ai-worker] progress", {
    received: stats.received,
    invalid: stats.invalid,
    inactive: stats.inactive,
    cached: stats.cached,
    queued: stats.queued,
    embedded: stats.embedded,
    missing: stats.missing,
    failed: stats.failed,
    lag,
    rate_per_sec: Number.isFinite(ratePerSec)
      ? Number(ratePerSec.toFixed(1))
      : null,
    eta: etaSec != null ? formatDuration(etaSec) : null,
  });

  stats.received = 0;
  stats.invalid = 0;
  stats.inactive = 0;
  stats.cached = 0;
  stats.queued = 0;
  stats.embedded = 0;
  stats.missing = 0;
  stats.failed = 0;
  stats.lastLogAt = now;

  await maybeTrimStream(redis);
}

function normalizeText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length ? trimmed : undefined;
}

function truncate(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars).trim();
}

function parseOutcomes(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v)).join(", ");
    }
  } catch {
    // ignore
  }
  return value;
}

function normalizeOutcomes(value: string | undefined): string | undefined {
  const outcomes = normalizeText(parseOutcomes(value));
  if (!outcomes) return undefined;
  const parts = outcomes
    .split(",")
    .map((part) => normalizeText(part))
    .filter((part): part is string => Boolean(part));
  if (!parts.length) return undefined;
  const lowers = new Set(parts.map((part) => part.toLowerCase()));
  const isYesNo =
    lowers.size <= 2 && lowers.has("yes") && lowers.has("no");
  const isTrueFalse =
    lowers.size <= 2 && lowers.has("true") && lowers.has("false");
  if (isYesNo || isTrueFalse) return undefined;
  return parts.join(", ");
}

function normalizeTopMarkets(
  value: string | undefined,
  eventTitle: string | undefined,
): string | undefined {
  const cleaned = normalizeText(value);
  if (!cleaned) return undefined;
  const eventLower = normalizeText(eventTitle)?.toLowerCase();
  const parts = cleaned
    .split("|")
    .map((part) => normalizeText(part))
    .filter((part): part is string => Boolean(part));
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (eventLower && lower === eventLower) continue;
    if (lower === "yes" || lower === "no" || lower === "true" || lower === "false")
      continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    filtered.push(part);
    if (filtered.length >= 20) break;
  }
  if (!filtered.length) return undefined;
  const joined = filtered.join(" | ");
  return truncate(joined, env.maxTopMarketsChars) ?? joined;
}

function buildMarketText(payload: EmbedPayload): string {
  const lines: string[] = ["passage: market"];
  const marketTitle = normalizeText(payload.marketTitle);
  const eventTitle = normalizeText(payload.eventTitle);
  const category = normalizeText(payload.category);
  const outcomes = normalizeOutcomes(payload.outcomes);
  const marketType = normalizeText(payload.marketType);
  const description = truncate(
    normalizeText(payload.description),
    env.maxDescriptionChars,
  );

  if (marketTitle) lines.push(`market_title=${marketTitle}`);
  if (eventTitle && eventTitle !== marketTitle)
    lines.push(`event_title=${eventTitle}`);
  if (category) lines.push(`category=${category}`);
  if (outcomes) lines.push(`outcomes=${outcomes}`);
  if (marketType && marketType !== "binary")
    lines.push(`market_type=${marketType}`);
  if (description) lines.push(`description=${description}`);

  const text = lines.join("\n");
  return truncate(text, env.maxTextChars) ?? text;
}

function buildEventText(payload: EmbedPayload): string {
  const lines: string[] = ["passage: event"];
  const eventTitle = normalizeText(payload.eventTitle);
  const category = normalizeText(payload.category);
  const topMarkets = normalizeTopMarkets(payload.topMarkets, eventTitle);
  const description = truncate(
    normalizeText(payload.description),
    env.maxDescriptionChars,
  );

  if (eventTitle) lines.push(`event_title=${eventTitle}`);
  if (topMarkets) lines.push(`top_markets=${topMarkets}`);
  if (category) lines.push(`category=${category}`);
  if (description) lines.push(`description=${description}`);

  const text = lines.join("\n");
  return truncate(text, env.maxTextChars) ?? text;
}

function computeHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseUpdatedAt(value: string | undefined): number {
  if (!value) return Date.now();
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function normalizeStatus(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function parsePayload(fields: Record<string, string>): EmbedPayload | null {
  const entityType = (fields.entity_type ?? "").toLowerCase();
  if (entityType !== "market" && entityType !== "event") return null;

  const entityId =
    entityType === "market" ? fields.market_id : fields.event_id;
  if (!entityId) return null;

  return {
    entityType,
    entityId,
    status: normalizeStatus(fields.status),
    venue: normalizeText(fields.venue),
    marketTitle: normalizeText(fields.market_title),
    eventTitle: normalizeText(fields.event_title),
    topMarkets: normalizeText(fields.top_markets),
    description: normalizeText(fields.description),
    category: normalizeText(fields.category),
    outcomes: fields.outcomes,
    marketType: normalizeText(fields.market_type),
    updatedAt: fields.updated_at,
  };
}

function vectorToBuffer(values: number[]): Buffer {
  const arr = new Float32Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] ?? 0;
    sum += v * v;
    arr[i] = v;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < arr.length; i += 1) {
    arr[i] = arr[i] / norm;
  }
  return Buffer.from(arr.buffer);
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function ensureConsumerGroup(redis: ReturnType<typeof createRedisClient>) {
  try {
    await redis.xGroupCreate(STREAM_KEY, env.group, "0", { MKSTREAM: true });
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("BUSYGROUP")) throw err;
  }
}

async function ensureIndex(
  redis: ReturnType<typeof createRedisClient>,
  indexName: string,
  prefix: string,
  includeMarketType: boolean,
) {
  try {
    await redis.sendCommand(["FT.INFO", indexName]);
    return;
  } catch {
    // continue to create
  }

  const schema = [
    "venue",
    "TAG",
    "status",
    "TAG",
    "updated_at",
    "NUMERIC",
  ];
  if (includeMarketType) {
    schema.push("market_type", "TAG");
  }
  schema.push(
    "embedding",
    "VECTOR",
    "HNSW",
    "6",
    "TYPE",
    "FLOAT32",
    "DIM",
    "1024",
    "DISTANCE_METRIC",
    "COSINE",
  );

  await redis.sendCommand([
    "FT.CREATE",
    indexName,
    "ON",
    "HASH",
    "PREFIX",
    "1",
    prefix,
    "SCHEMA",
    ...schema,
  ]);
}

async function ensureIndexes(redis: ReturnType<typeof createRedisClient>) {
  try {
    await ensureIndex(redis, INDEX_MARKET, "ai:embed:market:", true);
    await ensureIndex(redis, INDEX_EVENT, "ai:embed:event:", false);
  } catch (err) {
    console.warn("[ai-worker] Failed to ensure Redis indexes", err);
  }
}

async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openRouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: env.embedModel, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter embeddings failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  if (!json.data) throw new Error("OpenRouter embeddings missing data");

  const vectors: number[][] = [];
  for (const item of json.data) {
    if (!item.embedding) throw new Error("OpenRouter embedding missing vector");
    vectors[item.index ?? vectors.length] = item.embedding;
  }
  return vectors;
}

async function deleteEmbedding(
  redis: ReturnType<typeof createRedisClient>,
  payload: EmbedPayload,
): Promise<void> {
  const keyPrefix = payload.entityType === "market" ? "ai:embed:market:" : "ai:embed:event:";
  const key = `${keyPrefix}${payload.entityId}`;
  const multi = redis.multi();
  multi.del(key);
  if (payload.entityType === "market") {
    multi.del(`ai:similar:market:${payload.entityId}`);
  }
  await multi.exec();
}

async function processStreamBatch(
  redis: ReturnType<typeof createRedisClient>,
  messages: StreamMessage[],
) {
  const batchStats: Omit<WorkerStats, "lastLogAt"> = {
    received: messages.length,
    invalid: 0,
    inactive: 0,
    cached: 0,
    queued: 0,
    embedded: 0,
    missing: 0,
    failed: 0,
  };
  const pending: Array<{
    messageId: string;
    payload: EmbedPayload;
    text: string;
    textHash: string;
    embeddingVersion: string;
  }> = [];

  for (const entry of messages) {
    const payload = parsePayload(entry.fields);
    if (!payload) {
      batchStats.invalid += 1;
      await redis.xAdd(DLQ_KEY, "*", {
        error: "invalid_payload",
        payload: JSON.stringify(entry.fields),
        source_id: entry.id,
      });
      await redis.xAck(STREAM_KEY, env.group, entry.id);
      continue;
    }

    if (payload.status !== "ACTIVE") {
      batchStats.inactive += 1;
      await deleteEmbedding(redis, payload);
      await redis.xAck(STREAM_KEY, env.group, entry.id);
      continue;
    }

    const text =
      payload.entityType === "market"
        ? buildMarketText(payload)
        : buildEventText(payload);
    const textHash = computeHash(text);
    const embeddingVersion = `${env.embedModel}@${env.textVersion}`;

    const keyPrefix =
      payload.entityType === "market" ? "ai:embed:market:" : "ai:embed:event:";
    const key = `${keyPrefix}${payload.entityId}`;

    const [prevHash, prevVersion] = await redis.hmGet(key, [
      "text_hash",
      "embedding_version",
    ]);

    if (prevHash === textHash && prevVersion === embeddingVersion) {
      batchStats.cached += 1;
      await redis.xAck(STREAM_KEY, env.group, entry.id);
      continue;
    }

    pending.push({
      messageId: entry.id,
      payload,
      text,
      textHash,
      embeddingVersion,
    });
  }

  batchStats.queued = pending.length;
  if (!pending.length) {
    addStats(batchStats);
    await flushStats(redis);
    return;
  }

  const chunks = chunk(pending, env.batchSize);
  const results = await Promise.all(
    chunks.map(async (batch) => {
      let embedded = 0;
      let missing = 0;
      try {
        const texts = batch.map((item) => item.text);
        const vectors = await fetchEmbeddings(texts);

        const multi = redis.multi();
        for (let i = 0; i < batch.length; i += 1) {
          const item = batch[i];
          const vector = vectors[i];
          if (!vector) {
            missing += 1;
            multi.xAdd(DLQ_KEY, "*", {
              error: "missing_embedding",
              payload: JSON.stringify(item.payload),
              source_id: item.messageId,
            });
            multi.xAck(STREAM_KEY, env.group, item.messageId);
              continue;
          }
          embedded += 1;
          const keyPrefix =
            item.payload.entityType === "market"
              ? "ai:embed:market:"
              : "ai:embed:event:";
          const key = `${keyPrefix}${item.payload.entityId}`;
          const updatedAt = parseUpdatedAt(item.payload.updatedAt);
          multi.hSet(key, {
            embedding: vectorToBuffer(vector),
            venue: item.payload.venue ?? "",
            status: item.payload.status ?? "",
            market_type: item.payload.marketType ?? "",
            updated_at: String(updatedAt),
            text_hash: item.textHash,
            embedding_version: item.embeddingVersion,
          });
          multi.expire(key, env.embedTtlSec);
          multi.xAck(STREAM_KEY, env.group, item.messageId);
        }
        await multi.exec();
        return { embedded, missing, failed: 0 };
      } catch (err) {
        const multi = redis.multi();
        for (const item of batch) {
          multi.xAdd(DLQ_KEY, "*", {
            error: "embedding_request_failed",
            message: String(err),
            payload: JSON.stringify(item.payload),
            source_id: item.messageId,
          });
          multi.xAck(STREAM_KEY, env.group, item.messageId);
        }
        await multi.exec();
        return { embedded: 0, missing: 0, failed: batch.length };
      }
    }),
  );

  for (const result of results) {
    batchStats.embedded += result.embedded;
    batchStats.missing += result.missing;
    batchStats.failed += result.failed;
  }
  addStats(batchStats);
  await flushStats(redis);
}

async function readLoop() {
  if (!env.enabled) {
    console.log("[ai-worker] AI embeddings disabled");
    return;
  }

  const redis = createRedisClient({ url: env.redisUrl });
  redis.on("error", (e: unknown) => console.warn("[redis] err", String(e)));
  await ensureRedis(redis);
  await ensureConsumerGroup(redis);
  await ensureIndexes(redis);
  console.log("[ai-worker] ready", {
    stream: STREAM_KEY,
    group: env.group,
    consumer: env.consumer,
    model: env.embedModel,
    batchSize: env.batchSize,
    concurrency: env.concurrency,
  });

  const count = Math.max(1, env.batchSize * env.concurrency);

  while (true) {
    const response = await redis.xReadGroup(
      env.group,
      env.consumer,
      { key: STREAM_KEY, id: ">" },
      { COUNT: count, BLOCK: env.blockMs },
    );

    if (!response) {
      await delay(200);
      continue;
    }

    const messages: StreamMessage[] = [];
    for (const stream of response) {
      for (const msg of stream.messages) {
        messages.push({ id: msg.id, fields: msg.message });
      }
    }

    if (messages.length) {
      try {
        await processStreamBatch(redis, messages);
      } catch (err) {
        console.warn("[ai-worker] batch failed", err);
        await delay(1000);
      }
    }
  }
}

readLoop().catch((err) => {
  console.error("[ai-worker] fatal", err);
  process.exit(1);
});
