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
  description?: string;
  category?: string;
  outcomes?: string;
  market_type?: string;
  updated_at?: string | number | Date;
  source?: string;
};

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
