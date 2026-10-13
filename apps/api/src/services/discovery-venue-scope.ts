import type { DbQuery } from "../db.js";
import { filterVenuesForLifecycleCapability } from "./venue-lifecycle.js";
import { readHip4Policy } from "./hip4-repository.js";
import { VENUE_LIFECYCLE_CACHE_TTL_MS } from "./runtime-policies.js";

/** Share the existing lifecycle freshness bound; do not add DB reads to each
 * cached feed request. A lifecycle revision change invalidates the protocol
 * context immediately. Failed reads are not cached or served stale. */
export function createDiscoveryVenueScopeResolver(
  dependencies: {
    lifecycle?: typeof filterVenuesForLifecycleCapability;
    protocol?: typeof readHip4Policy;
    now?: () => number;
  } = {},
) {
  const lifecycleScope =
    dependencies.lifecycle ?? filterVenuesForLifecycleCapability;
  const protocol = dependencies.protocol ?? readHip4Policy;
  const now = dependencies.now ?? Date.now;
  const cache = new WeakMap<
    object,
    {
      lifecycleRevision: string;
      expiresAt: number;
      pending: ReturnType<typeof readHip4Policy>;
    }
  >();

  return async (
    db: DbQuery,
    requested: readonly unknown[] | null | undefined,
  ) => {
    const lifecycle = await lifecycleScope(db, requested, "discovery");
    if (!lifecycle.venues.includes("hyperliquid"))
      return { ...lifecycle, hip4Environment: null, hip4Policy: null };
    let entry = cache.get(db);
    if (
      !entry ||
      entry.lifecycleRevision !== lifecycle.revision ||
      entry.expiresAt <= now()
    ) {
      const pending = protocol(db);
      const next = {
        lifecycleRevision: lifecycle.revision,
        expiresAt: now() + VENUE_LIFECYCLE_CACHE_TTL_MS,
        pending,
      };
      cache.set(db, next);
      // Single-flight, including a cold burst. An older rejected request must
      // not evict a newer lifecycle generation that is already in flight.
      void pending.catch(() => {
        if (cache.get(db) === next) cache.delete(db);
      });
      entry = next;
    }
    const hip4 = await entry.pending;
    return {
      venues: hip4.policy.enabled
        ? lifecycle.venues
        : lifecycle.venues.filter((venue) => venue !== "hyperliquid"),
      revision: `${lifecycle.revision}:${hip4.revision}`,
      hip4Environment: hip4.policy.enabled ? hip4.policy.environment : null,
      hip4Policy: hip4.policy.enabled ? hip4.policy : null,
    };
  };
}

/** Product access is common; environment is a protocol identity constraint.
 * Include both in response/cache context so switching environments cannot
 * re-serve the prior network's markets. No provider calls are made here. */
export const resolveDiscoveryVenueScope = createDiscoveryVenueScopeResolver();
