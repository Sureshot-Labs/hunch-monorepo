import type { RedisClientType } from "redis";

type EmbedEntityType = "market" | "event";

export type EmbedQueueItem = {
  entity_type: EmbedEntityType;
  market_id?: string;
  event_id?: string;
  venue?: string;
  status?: string;
  market_title?: string;
  event_title?: string;
  top_markets?: string;
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

export function getEmbedStreamKey(): string {
  return process.env.AI_EMBED_STREAM_KEY || DEFAULT_STREAM_KEY;
}

function toFieldValue(value: EmbedQueueItem[keyof EmbedQueueItem]): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function enqueueEmbedItems(
  redis: RedisClientType,
  items: EmbedQueueItem[],
  streamKey = getEmbedStreamKey(),
): Promise<void> {
  if (!items.length) return;
  const pipeline = redis.multi();
  for (const item of items) {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(item)) {
      if (value == null) continue;
      fields[key] = toFieldValue(value as EmbedQueueItem[keyof EmbedQueueItem]);
    }
    pipeline.xAdd(streamKey, "*", fields);
  }
  await pipeline.exec();
}
