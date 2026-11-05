type CategoryRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, body: string, options: { EX: number }): Promise<unknown>;
};
type Entry = {
  body?: string;
  retryAt: number;
  error?: unknown;
  pending?: Promise<string>;
};
export type CategoryCacheResult = {
  body: string;
  cacheStatus: "disabled" | "fallback" | "hit" | "miss" | "stale";
};

/** Derived metadata: keep the last complete body and share a single refresh.
 * A failed SQL refresh gets the same cadence as a successful refresh, rather
 * than being retried by every HTTP reader. No timer, cron or cache reset needed.
 */
export class DefaultCategoryCache {
  private entries = new Map<string, Entry>();
  constructor(
    readonly ttlSeconds = 600,
    readonly staleSeconds = 86400,
    readonly clock: () => number = Date.now,
    readonly onFailure: (error: unknown) => void = () => {},
  ) {}
  async load(
    key: string,
    redis: CategoryRedis | null,
    compute: () => Promise<string>,
    fallback: () => string,
    recoverable: (error: unknown) => boolean,
  ): Promise<CategoryCacheResult> {
    const state = this.entries.get(key) ?? { retryAt: 0 };
    this.entries.set(key, state);
    const write = async (body: string) => {
      if (!redis) return;
      // A cache failure never discards successfully computed counts.
      await Promise.all([
        redis.set(key, body, { EX: this.ttlSeconds }),
        redis.set(`${key}:stale`, body, { EX: this.staleSeconds }),
      ]).catch(() => {});
    };
    if (redis) {
      try {
        const fresh = await redis.get(key);
        if (fresh) {
          state.body = fresh;
          await redis
            .set(`${key}:stale`, fresh, { EX: this.staleSeconds })
            .catch(() => {});
          return { body: fresh, cacheStatus: "hit" };
        }
        const stale = await redis.get(`${key}:stale`);
        if (stale && !state.body) state.body = stale;
      } catch {
        // Continue with local last-good state or the read-only SQL fallback.
        redis = null;
      }
    }
    const refresh = (): Promise<string> => {
      if (state.pending) return state.pending;
      if (state.retryAt > this.clock())
        return Promise.reject(state.error ?? Error("category_refresh_not_due"));
      const pending = Promise.resolve()
        .then(compute)
        .then(async (body) => {
          state.body = body;
          state.error = undefined;
          state.retryAt = this.clock() + this.ttlSeconds * 1000;
          await write(body);
          return body;
        })
        .catch((error) => {
          state.error = error;
          state.retryAt = this.clock() + this.ttlSeconds * 1000;
          try {
            this.onFailure(error);
          } catch {
            /* Logging is not a cache dependency. */
          }
          throw error;
        })
        .finally(() => {
          state.pending = undefined;
        });
      state.pending = pending;
      return pending;
    };
    if (state.body) {
      if (state.retryAt <= this.clock()) void refresh().catch(() => {});
      return { body: state.body, cacheStatus: "stale" };
    }
    try {
      return {
        body: await refresh(),
        cacheStatus: redis ? "miss" : "disabled",
      };
    } catch (error) {
      if (!recoverable(error)) throw error;
      return { body: fallback(), cacheStatus: "fallback" };
    }
  }
}
