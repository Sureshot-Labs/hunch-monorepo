type NullablePrice = number | null;

type GateEntry = {
  publishedBid: NullablePrice;
  publishedAsk: NullablePrice;
  lastPublishedAtMs: number;
  lastPublishedTsMs: number;
  lastSeenTsMs: number;
  pendingBid: NullablePrice;
  pendingAsk: NullablePrice;
  pendingTsMs: number | null;
  hasPending: boolean;
  flushTimer: NodeJS.Timeout | null;
};

export type TopTickGateInputs = {
  tokenId: string;
  bestBid: NullablePrice;
  bestAsk: NullablePrice;
  tsMs: number;
  nowMs?: number;
};

type DeferredPublishPayload = {
  tokenId: string;
  bestBid: NullablePrice;
  bestAsk: NullablePrice;
  tsMs: number;
};

export type TopTickGateOptions = {
  minIntervalMs?: number;
  heartbeatMs?: number;
  epsilon?: number;
  maxEntries?: number;
  pruneBatch?: number;
  onDeferredPublish?: (payload: DeferredPublishPayload) => void;
};

type ResolvedTopTickGateOptions = Required<
  Omit<TopTickGateOptions, "onDeferredPublish">
>;

const DEFAULT_MIN_INTERVAL_MS = 100;
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_EPSILON = 1e-9;
const DEFAULT_MAX_ENTRIES = 200_000;
const DEFAULT_PRUNE_BATCH = 20_000;

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.trunc(parsed));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function parsePositiveFloat(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function isEqualPrice(a: NullablePrice, b: NullablePrice, epsilon: number): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= epsilon;
}

export function resolveTopTickGateOptionsFromEnv(): ResolvedTopTickGateOptions {
  return {
    minIntervalMs: parseNonNegativeInt(
      process.env.INDEXER_TOP_MIN_INTERVAL_MS,
      DEFAULT_MIN_INTERVAL_MS,
    ),
    heartbeatMs: parseNonNegativeInt(
      process.env.INDEXER_TOP_HEARTBEAT_MS,
      DEFAULT_HEARTBEAT_MS,
    ),
    epsilon: parsePositiveFloat(
      process.env.INDEXER_TOP_EQUAL_EPSILON,
      DEFAULT_EPSILON,
    ),
    maxEntries: parsePositiveInt(
      process.env.INDEXER_TOP_CACHE_MAX,
      DEFAULT_MAX_ENTRIES,
    ),
    pruneBatch: parsePositiveInt(
      process.env.INDEXER_TOP_CACHE_PRUNE_BATCH,
      DEFAULT_PRUNE_BATCH,
    ),
  };
}

function normalizeTsMs(tsMs: number, fallback: number): number {
  if (!Number.isFinite(tsMs)) return fallback;
  return Math.trunc(tsMs);
}

function createEntry(
  bestBid: NullablePrice,
  bestAsk: NullablePrice,
  nowMs: number,
  tsMs: number,
): GateEntry {
  return {
    publishedBid: bestBid,
    publishedAsk: bestAsk,
    lastPublishedAtMs: nowMs,
    lastPublishedTsMs: tsMs,
    lastSeenTsMs: tsMs,
    pendingBid: null,
    pendingAsk: null,
    pendingTsMs: null,
    hasPending: false,
    flushTimer: null,
  };
}

function touchEntry(cache: Map<string, GateEntry>, tokenId: string, entry: GateEntry): void {
  cache.delete(tokenId);
  cache.set(tokenId, entry);
}

function maybePrune(
  cache: Map<string, GateEntry>,
  maxEntries: number,
  pruneBatch: number,
  onDelete?: (entry: GateEntry) => void,
): void {
  if (cache.size <= maxEntries) return;
  for (let i = 0; i < pruneBatch; i += 1) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    const entry = cache.get(oldest);
    if (entry && onDelete) onDelete(entry);
    cache.delete(oldest);
  }
}

export type TopTickGate = {
  shouldPublish: (inputs: TopTickGateInputs) => boolean;
  size: () => number;
  clear: () => void;
};

export function createTopTickGate(options: TopTickGateOptions = {}): TopTickGate {
  const defaults = resolveTopTickGateOptionsFromEnv();
  const minIntervalMs =
    options.minIntervalMs != null
      ? Math.max(0, Math.trunc(options.minIntervalMs))
      : defaults.minIntervalMs;
  const heartbeatMs =
    options.heartbeatMs != null
      ? Math.max(0, Math.trunc(options.heartbeatMs))
      : defaults.heartbeatMs;
  const epsilon =
    options.epsilon != null ? Math.max(0, options.epsilon) : defaults.epsilon;
  const maxEntries =
    options.maxEntries != null
      ? Math.max(1, Math.trunc(options.maxEntries))
      : defaults.maxEntries;
  const pruneBatch =
    options.pruneBatch != null
      ? Math.max(1, Math.trunc(options.pruneBatch))
      : defaults.pruneBatch;
  const onDeferredPublish = options.onDeferredPublish;

  const cache = new Map<string, GateEntry>();
  const clearTimer = (entry: GateEntry): void => {
    if (!entry.flushTimer) return;
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  };

  const schedulePendingFlush = (tokenId: string, entry: GateEntry, delayMs: number): void => {
    clearTimer(entry);
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      const current = cache.get(tokenId);
      if (!current || !current.hasPending) return;

      const now = Date.now();
      const elapsedSincePublishMs = now - current.lastPublishedAtMs;
      if (minIntervalMs > 0 && elapsedSincePublishMs < minIntervalMs) {
        schedulePendingFlush(tokenId, current, minIntervalMs - elapsedSincePublishMs);
        touchEntry(cache, tokenId, current);
        return;
      }

      const pendingTs = current.pendingTsMs ?? now;
      current.publishedBid = current.pendingBid;
      current.publishedAsk = current.pendingAsk;
      current.lastPublishedAtMs = now;
      current.lastPublishedTsMs = pendingTs;
      current.pendingBid = null;
      current.pendingAsk = null;
      current.pendingTsMs = null;
      current.hasPending = false;
      touchEntry(cache, tokenId, current);

      if (current.publishedBid == null && current.publishedAsk == null) return;
      onDeferredPublish?.({
        tokenId,
        bestBid: current.publishedBid,
        bestAsk: current.publishedAsk,
        tsMs: pendingTs,
      });
    }, Math.max(0, Math.trunc(delayMs)));
    if (typeof entry.flushTimer.unref === "function") {
      entry.flushTimer.unref();
    }
  };

  return {
    shouldPublish: ({
      tokenId,
      bestBid,
      bestAsk,
      tsMs,
      nowMs,
    }: TopTickGateInputs): boolean => {
      if (!tokenId) return false;
      if (bestBid == null && bestAsk == null) return false;

      const now = nowMs != null && Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
      const ts = normalizeTsMs(tsMs, now);
      const prev = cache.get(tokenId);
      if (!prev) {
        const next = createEntry(bestBid, bestAsk, now, ts);
        cache.set(tokenId, next);
        maybePrune(cache, maxEntries, pruneBatch, clearTimer);
        return true;
      }

      if (ts < prev.lastSeenTsMs) return false;
      prev.lastSeenTsMs = ts;

      const changedVsPublished =
        !isEqualPrice(prev.publishedBid, bestBid, epsilon) ||
        !isEqualPrice(prev.publishedAsk, bestAsk, epsilon);
      const elapsedSincePublishMs = now - prev.lastPublishedAtMs;

      if (changedVsPublished) {
        if (minIntervalMs > 0 && elapsedSincePublishMs < minIntervalMs) {
          prev.pendingBid = bestBid;
          prev.pendingAsk = bestAsk;
          prev.pendingTsMs = ts;
          prev.hasPending = true;
          schedulePendingFlush(tokenId, prev, minIntervalMs - elapsedSincePublishMs);
          touchEntry(cache, tokenId, prev);
          return false;
        }

        clearTimer(prev);
        prev.publishedBid = bestBid;
        prev.publishedAsk = bestAsk;
        prev.lastPublishedAtMs = now;
        prev.lastPublishedTsMs = ts;
        prev.pendingBid = null;
        prev.pendingAsk = null;
        prev.pendingTsMs = null;
        prev.hasPending = false;
        touchEntry(cache, tokenId, prev);
        return true;
      }

      if (prev.hasPending) {
        // A newer frame matches the currently published top, so any queued
        // throttled delta is stale and should not be emitted later.
        clearTimer(prev);
        prev.pendingBid = null;
        prev.pendingAsk = null;
        prev.pendingTsMs = null;
        prev.hasPending = false;
      }

      if (heartbeatMs <= 0 || elapsedSincePublishMs < heartbeatMs) {
        touchEntry(cache, tokenId, prev);
        return false;
      }

      prev.lastPublishedAtMs = now;
      prev.lastPublishedTsMs = ts;
      touchEntry(cache, tokenId, prev);
      return true;
    },
    size: () => cache.size,
    clear: () => {
      for (const entry of cache.values()) {
        clearTimer(entry);
      }
      cache.clear();
    },
  };
}
