import { ensureRedis, redis } from "./redis";

export const POLYMARKET_EVENTS_OFFSET_KEY =
  "indexer:polymarket:gamma:events_offset:v1";

function parseNonNegativeInt(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

export async function getPolymarketEventsOffset(): Promise<number> {
  await ensureRedis();
  const raw = await redis.get(POLYMARKET_EVENTS_OFFSET_KEY);
  return parseNonNegativeInt(raw) ?? 0;
}

export async function setPolymarketEventsOffset(offset: number): Promise<void> {
  await ensureRedis();
  const next = Math.max(0, Math.trunc(offset));
  await redis.set(POLYMARKET_EVENTS_OFFSET_KEY, String(next));
}

export async function resetPolymarketEventsOffset(): Promise<void> {
  await ensureRedis();
  await redis.set(POLYMARKET_EVENTS_OFFSET_KEY, "0");
}
