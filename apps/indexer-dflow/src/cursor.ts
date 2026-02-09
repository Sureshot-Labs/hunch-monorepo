import { ensureRedis, redis } from "./redis.js";

export const DFLOW_EVENTS_OFFSET_KEY = "indexer:dflow:events_offset:v1";
const DFLOW_EVENTS_OFFSET_STATUS_PREFIX = "indexer:dflow:events_offset";

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

function statusOffsetKey(status: string): string {
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  if (!normalized || normalized === "active") return DFLOW_EVENTS_OFFSET_KEY;
  return `${DFLOW_EVENTS_OFFSET_STATUS_PREFIX}:${normalized}:v1`;
}

export async function getDflowEventsOffsetByStatus(
  status: string,
): Promise<number> {
  await ensureRedis();
  const raw = await redis.get(statusOffsetKey(status));
  return parseNonNegativeInt(raw) ?? 0;
}

export async function setDflowEventsOffsetByStatus(
  status: string,
  offset: number,
): Promise<void> {
  await ensureRedis();
  const next = Math.max(0, Math.trunc(offset));
  await redis.set(statusOffsetKey(status), String(next));
}

export async function resetDflowEventsOffsetByStatus(
  status: string,
): Promise<void> {
  await ensureRedis();
  await redis.set(statusOffsetKey(status), "0");
}
