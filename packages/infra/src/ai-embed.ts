import type { RedisClientType } from "redis";
import { createHash } from "node:crypto";

type EmbedEntityType = "market" | "event";

export type EmbedQueueItem = {
  entity_type: EmbedEntityType;
  market_id?: string;
  event_id?: string;
  venue?: string;
  status?: string;
  market_title?: string;
  event_title?: string;
  top_markets?: string | string[];
  description?: string;
  category?: string;
  outcomes?: string;
  market_type?: string;
  updated_at?: string | number | Date;
  source?: string;
};

export type TopMarketCandidate = {
  title?: string | null;
  volume_24h?: number | null;
  volume_total?: number | null;
  liquidity?: number | null;
  open_interest?: number | null;
};

function normalizeTitle(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length ? trimmed : undefined;
}

function isTrivialTitle(title: string, eventTitleLower?: string): boolean {
  const lower = title.toLowerCase();
  if (eventTitleLower && lower === eventTitleLower) return true;
  if (lower === "yes" || lower === "no") return true;
  if (lower === "true" || lower === "false") return true;
  return false;
}

function asNumber(value: number | null | undefined): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function buildTopMarketsText(
  markets: TopMarketCandidate[],
  eventTitle?: string | null,
  options?: {
    maxItems?: number;
    maxChars?: number;
    maxItemChars?: number;
  },
): string | undefined {
  if (!markets.length) return undefined;
  const eventTitleLower = normalizeTitle(eventTitle)?.toLowerCase();
  const maxItems = options?.maxItems ?? 10;
  const maxChars = options?.maxChars ?? 320;
  const maxItemChars = options?.maxItemChars ?? 80;

  const ranked = markets
    .map((market) => {
      const title = normalizeTitle(market.title);
      if (!title) return null;
      if (isTrivialTitle(title, eventTitleLower)) return null;
      const score =
        asNumber(market.volume_24h) * 2 +
        asNumber(market.liquidity) +
        asNumber(market.open_interest) +
        asNumber(market.volume_total) * 0.2;
      return { title, score };
    })
    .filter((entry): entry is { title: string; score: number } => entry != null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.title.localeCompare(b.title);
    });

  const seen = new Set<string>();
  const selected: string[] = [];
  for (const entry of ranked) {
    const normalized = entry.title.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const title =
      entry.title.length > maxItemChars
        ? `${entry.title.slice(0, Math.max(1, maxItemChars - 3)).trim()}...`
        : entry.title;
    selected.push(title);
    if (selected.length >= maxItems) break;
  }

  if (!selected.length) return undefined;

  const parts: string[] = [];
  let totalLength = 0;
  for (const title of selected) {
    const next = parts.length ? ` | ${title}` : title;
    if (totalLength + next.length > maxChars) break;
    parts.push(title);
    totalLength += next.length;
  }
  return parts.length ? parts.join(" | ") : undefined;
}

const DEFAULT_STREAM_KEY = "ai:embed:queue:active";

/** Stable candidate titles, not volume ranking. Canonical hydration bounds its
 * own rendering; keep all candidates here so collation/subset changes cannot
 * silently omit an event invalidation. */
export function buildEmbeddingEventTitles(
  markets: Array<{ title?: string | null; status?: string | null }>,
): string[] {
  return [
    ...new Set(
      markets
        .filter((row) => row.status === "ACTIVE")
        .map((row) => row.title)
        .filter(
          (title): title is string =>
            typeof title === "string" && title.length > 0,
        ),
    ),
  ].sort();
}

function text(value: string | undefined): string {
  return value?.normalize("NFC").replace(/\s+/g, " ").trim() ?? "";
}
function list(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(text);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    )
      return parsed.map(text);
  } catch {
    /* Legacy producer text. */
  }
  return [text(value)];
}
export function embeddingInputFingerprint(item: EmbedQueueItem): string {
  const status = item.status?.toUpperCase() ?? "";
  // Terminal text is never embedded; one lifecycle notification still reaches
  // canonical cleanup, without requeueing terminal markets for price refreshes.
  const fields =
    status && status !== "ACTIVE"
      ? [item.entity_type, item.venue ?? "", status]
      : [
          item.entity_type,
          item.venue ?? "",
          status,
          text(item.market_title),
          text(item.event_title),
          text(item.description),
          text(item.category),
          text(item.market_type),
          list(item.outcomes),
          [...new Set(list(item.top_markets))].sort(),
        ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
export function embeddingEnqueueStateKey(
  stream: string,
  kind: EmbedEntityType,
  id: string,
): string {
  return `ai:embed:enqueue:v2:${createHash("sha256")
    .update(JSON.stringify([stream, kind, id]))
    .digest("hex")}`;
}
export const EMBEDDING_ENQUEUE_LUA = `
if redis.call('GET',KEYS[2])==ARGV[3] then
 redis.call('HINCRBY',KEYS[4],'unchanged',1); return 0
end
if redis.call('XLEN',KEYS[1])>=200000 then
 redis.call('INCR',KEYS[3]); redis.call('HINCRBY',KEYS[4],'overflow',1); return -1
end
redis.call('XADD',KEYS[1],'*','entity_type',ARGV[1],'entity_id',ARGV[2])
redis.call('SET',KEYS[2],ARGV[3],'EX',604800)
redis.call('HINCRBY',KEYS[4],'enqueued',1); return 1`;

export function getEmbedStreamKey(): string {
  return process.env.AI_EMBED_STREAM_KEY || DEFAULT_STREAM_KEY;
}

export async function enqueueEmbedItems(
  redis: RedisClientType,
  items: EmbedQueueItem[],
  streamKey = getEmbedStreamKey(),
): Promise<{
  enqueued: number;
  unchanged: number;
  overflow: number;
  deduplicated: number;
}> {
  const unique = new Map<string, { id: string; item: EmbedQueueItem }>();
  for (const item of items) {
    const id = item.entity_type === "market" ? item.market_id : item.event_id;
    if (!id) continue;
    unique.set(JSON.stringify([item.entity_type, id]), { id, item });
  }
  const values = [...unique.values()];
  const result = {
    enqueued: 0,
    unchanged: 0,
    overflow: 0,
    deduplicated: items.length - values.length,
  };
  // Bound EXEC duration for large catalog pages. The fingerprint and accepted
  // notification are atomic; overflow/errors never mark missing work as seen.
  for (let offset = 0; offset < values.length; offset += 200) {
    const pipeline = redis.multi();
    for (const { id, item } of values.slice(offset, offset + 200)) {
      pipeline.eval(EMBEDDING_ENQUEUE_LUA, {
        keys: [
          streamKey,
          embeddingEnqueueStateKey(streamKey, item.entity_type, id),
          "ai:embed:control:reconcile",
          `${streamKey}:enqueue:stats:v2`,
        ],
        arguments: [item.entity_type, id, embeddingInputFingerprint(item)],
      });
    }
    for (const response of await pipeline.exec()) {
      if (Number(response) === 1) result.enqueued++;
      else if (Number(response) === 0) result.unchanged++;
      else if (Number(response) === -1) result.overflow++;
      else throw new Error("embedding_enqueue_result_invalid");
    }
  }
  return result;
}
