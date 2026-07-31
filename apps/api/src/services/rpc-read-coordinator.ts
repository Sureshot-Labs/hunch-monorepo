type CachedRead = Readonly<{
  value: unknown;
  expiresAt: number;
}>;

export type RpcMemoOptions<T> = Readonly<{
  ttlMs: number;
  bypass?: boolean;
  cacheIf?: (value: T) => boolean;
}>;

export class RpcReadCoordinator {
  private readonly cached = new Map<string, CachedRead>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("RPC read coordinator maxEntries must be positive");
    }
  }

  async singleFlight<T>(
    key: string,
    loader: () => Promise<T>,
    onInflightHit?: () => void,
  ): Promise<T> {
    const pending = this.inflight.get(key);
    if (pending) {
      onInflightHit?.();
      return pending as Promise<T>;
    }
    const request = loader().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, request);
    return request;
  }

  async memo<T>(
    key: string,
    options: RpcMemoOptions<T>,
    loader: () => Promise<T>,
  ): Promise<T> {
    if (options.ttlMs <= 0) return loader();
    if (options.bypass) {
      return this.singleFlight(`memo:${key}`, async () => {
        const value = await loader();
        this.storeIfCacheable(key, value, options);
        return value;
      });
    }

    const cached = this.read<T>(key);
    if (cached.found) {
      return cached.value;
    }

    return this.singleFlight(`memo:${key}`, async () => {
      const value = await loader();
      this.storeIfCacheable(key, value, options);
      return value;
    });
  }

  private read<T>(
    key: string,
  ): Readonly<{ found: true; value: T }> | Readonly<{ found: false }> {
    const entry = this.cached.get(key);
    if (!entry) return { found: false };
    if (entry.expiresAt <= Date.now()) {
      this.cached.delete(key);
      return { found: false };
    }
    // Refresh insertion order so the bounded map behaves as a small LRU.
    this.cached.delete(key);
    this.cached.set(key, entry);
    return { found: true, value: entry.value as T };
  }

  private storeIfCacheable<T>(
    key: string,
    value: T,
    options: RpcMemoOptions<T>,
  ): void {
    const cacheIf = options.cacheIf ?? ((candidate: T) => candidate != null);
    if (!cacheIf(value)) return;
    this.cached.delete(key);
    this.cached.set(key, {
      value,
      expiresAt: Date.now() + options.ttlMs,
    });
    while (this.cached.size > this.maxEntries) {
      const oldest = this.cached.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cached.delete(oldest);
    }
  }
}

// One coordinator is shared by every direct EVM and Solana RPC helper in the
// current process. It deliberately does not cross process boundaries: Redis
// would add stale-state and availability coupling to authoritative reads.
export const rpcReadCoordinator = new RpcReadCoordinator(2_048);
