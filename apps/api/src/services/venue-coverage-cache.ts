export type VenueCoverageRow = {
  venue: string;
  active_markets: number;
  markets_with_volume: number;
  markets_with_liquidity: number;
  markets_with_price: number;
};

type Snapshot = { measuredAt: number; rows: VenueCoverageRow[] };
type Entry = { snapshot?: Snapshot; pending: boolean; retryAt: number };
const FRESH_MS = 5 * 60_000;
export const VENUE_COVERAGE_STALE_SECONDS = 24 * 60 * 60;

async function boundedStorage<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Venue coverage storage timed out")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Counters are advisory metadata, not a prerequisite for discovering venues.
// Only one refresh per venue set runs in this API process. A failed refresh
// retains the last measured values and backs off instead of retrying per GET.
export function createVenueCoverageCache(deps: {
  refresh: (venues: string[]) => Promise<VenueCoverageRow[]>;
  load: (key: string) => Promise<unknown>;
  save: (key: string, snapshot: Snapshot) => Promise<void>;
  onError: (error: unknown) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const valid = (value: unknown, venues: string[]): value is Snapshot => {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Snapshot;
    if (
      !Number.isFinite(snapshot.measuredAt) ||
      snapshot.measuredAt > now() ||
      now() - snapshot.measuredAt > VENUE_COVERAGE_STALE_SECONDS * 1000 ||
      !Array.isArray(snapshot.rows) ||
      snapshot.rows.length !== venues.length
    )
      return false;
    return (
      new Set(snapshot.rows.map((row) => row?.venue)).size === venues.length &&
      snapshot.rows.every(
        (row) =>
          row &&
          venues.includes(row.venue) &&
          [
            row.active_markets,
            row.markets_with_volume,
            row.markets_with_liquidity,
            row.markets_with_price,
          ].every((count) => Number.isSafeInteger(count) && count >= 0) &&
          row.markets_with_volume <= row.active_markets &&
          row.markets_with_liquidity <= row.active_markets &&
          row.markets_with_price <= row.active_markets,
      )
    );
  };
  return {
    get(requestedVenues: string[]) {
      const venues = [...new Set(requestedVenues)].sort();
      const key = `meta:venue-coverage:v1:${venues.join(",")}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = { pending: false, retryAt: 0 };
        entries.set(key, entry);
      }
      const state = entry;
      const snapshot =
        state.snapshot && valid(state.snapshot, venues)
          ? state.snapshot
          : undefined;
      const fresh = snapshot != null && now() - snapshot.measuredAt < FRESH_MS;
      if (!fresh && !state.pending && now() >= state.retryAt) {
        state.pending = true;
        void (async () => {
          try {
            if (!snapshot) {
              try {
                const loaded = await boundedStorage(deps.load(key));
                if (valid(loaded, venues)) state.snapshot = loaded;
              } catch (error) {
                deps.onError(error);
              }
            }
            if (state.snapshot && now() - state.snapshot.measuredAt < FRESH_MS)
              return;
            const refreshed = {
              measuredAt: now(),
              rows: await deps.refresh(venues),
            };
            if (!valid(refreshed, venues))
              throw new Error("Invalid venue coverage snapshot");
            state.snapshot = refreshed;
            await boundedStorage(deps.save(key, refreshed));
          } catch (error) {
            deps.onError(error);
          } finally {
            state.pending = false;
            state.retryAt = now() + 60_000;
          }
        })();
      }
      return {
        rows: snapshot?.rows ?? null,
        measuredAt: snapshot
          ? new Date(snapshot.measuredAt).toISOString()
          : null,
        status: snapshot ? (fresh ? "ready" : "stale") : "pending",
      };
    },
  };
}
