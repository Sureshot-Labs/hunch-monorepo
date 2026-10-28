/** Short-lived public market data only. Never cache balances or credentials here. */
export type TradingBookSnapshot = {
  payload: unknown;
  observedAt: string;
  sourceAsOf: string | null;
  expiresAt: string;
};

export function createTradingBookCache(now = Date.now, maxEntries = 500) {
  const entries = new Map<
    string,
    { until: number; pending: boolean; promise: Promise<TradingBookSnapshot> }
  >();
  return {
    clear: () => entries.clear(),
    load(
      key: string,
      fetchBook: () => Promise<unknown>,
    ): Promise<TradingBookSnapshot> {
      const startedAt = now();
      const previous = entries.get(key);
      if (previous && (previous.pending || previous.until > startedAt))
        return previous.promise;
      for (const [entryKey, entry] of entries)
        if (!entry.pending && entry.until <= startedAt)
          entries.delete(entryKey);
      while (entries.size >= maxEntries) {
        const oldest = [...entries].find(([, entry]) => !entry.pending);
        if (!oldest) return Promise.reject(new Error("book_cache_busy"));
        entries.delete(oldest[0]);
      }
      const entry = {
        until: startedAt + 2_000,
        pending: true,
        promise: undefined as unknown as Promise<TradingBookSnapshot>,
      };
      entry.promise = fetchBook()
        .then((payload) => {
          const wrapped =
            payload != null && typeof payload === "object"
              ? (payload as Record<string, unknown>)
              : {};
          const raw =
            wrapped.data != null && typeof wrapped.data === "object"
              ? (wrapped.data as Record<string, unknown>)
              : wrapped;
          const timestamp = raw.timestamp;
          const milliseconds =
            typeof timestamp === "number" ||
            (typeof timestamp === "string" && /^\d+$/.test(timestamp))
              ? Number(timestamp)
              : typeof timestamp === "string"
                ? Date.parse(timestamp)
                : NaN;
          const sourceMs =
            milliseconds > 0 && milliseconds < 10_000_000_000
              ? milliseconds * 1000
              : milliseconds;
          // Receipt time is not a substitute for a venue timestamp. Future dates
          // cannot extend the local lifetime. Slow requests also consume it.
          const sourceAsOf =
            Number.isFinite(sourceMs) &&
            sourceMs > 0 &&
            sourceMs <= now() + 1_000
              ? new Date(sourceMs).toISOString()
              : null;
          return {
            payload,
            observedAt: new Date(startedAt).toISOString(),
            sourceAsOf,
            expiresAt: new Date(
              Math.min(
                startedAt + 5_000,
                sourceAsOf ? sourceMs + 5_000 : Infinity,
              ),
            ).toISOString(),
          };
        })
        .catch((error: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        })
        .finally(() => {
          entry.pending = false;
        });
      entries.set(key, entry);
      return entry.promise;
    },
  };
}
