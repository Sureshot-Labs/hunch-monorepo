import { ensureRedis, redis } from "./redis.js";

export const DFLOW_EVENTS_OFFSET_KEY = "indexer:dflow:events_offset:v1";

function parseNonNegativeInt(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

export async function getDflowEventsOffset(): Promise<number> {
  await ensureRedis();
  const raw = await redis.get(DFLOW_EVENTS_OFFSET_KEY);
  return parseNonNegativeInt(raw) ?? 0;
}

export async function setDflowEventsOffset(offset: number): Promise<void> {
  await ensureRedis();
  const next = Math.max(0, Math.trunc(offset));
  await redis.set(DFLOW_EVENTS_OFFSET_KEY, String(next));
}

export async function resetDflowEventsOffset(): Promise<void> {
  await ensureRedis();
  await redis.set(DFLOW_EVENTS_OFFSET_KEY, "0");
}
