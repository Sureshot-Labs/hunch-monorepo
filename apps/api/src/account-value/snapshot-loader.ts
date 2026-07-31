export type AccountValueSnapshotLoader<T> = Readonly<{
  invalidate: (userId: string) => void;
  load: (userId: string) => Promise<T>;
}>;

export function createAccountValueSnapshotLoader<T>(
  build: (userId: string) => Promise<T>,
  options: Readonly<{
    maxEntries?: number;
    now?: () => number;
    ttlMs?: number;
  }> = {},
): AccountValueSnapshotLoader<T> {
  const ttlMs = Math.max(0, Math.trunc(options.ttlMs ?? 2_000));
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? 500));
  const now = options.now ?? Date.now;
  const snapshots = new Map<string, { expiresAt: number; value: T }>();
  const inFlight = new Map<string, Promise<T>>();

  const trim = () => {
    while (snapshots.size > maxEntries) {
      const oldest = snapshots.keys().next().value;
      if (typeof oldest !== "string") return;
      snapshots.delete(oldest);
    }
  };

  return {
    invalidate: (userId) => {
      snapshots.delete(userId);
    },
    load: async (userId) => {
      const cached = snapshots.get(userId);
      const currentTime = now();
      if (cached && cached.expiresAt > currentTime) return cached.value;
      if (cached) snapshots.delete(userId);

      const existing = inFlight.get(userId);
      if (existing) return existing;
      const pending = build(userId)
        .then((value) => {
          snapshots.delete(userId);
          snapshots.set(userId, { expiresAt: now() + ttlMs, value });
          trim();
          return value;
        })
        .finally(() => {
          inFlight.delete(userId);
        });
      inFlight.set(userId, pending);
      return pending;
    },
  };
}
