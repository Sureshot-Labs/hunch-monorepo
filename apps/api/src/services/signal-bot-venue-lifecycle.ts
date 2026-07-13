import { fetchActiveRuntimePolicy } from "@hunch/db";
import {
  buildVenueLifecyclePolicyRevision,
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  filterVenuesByLifecycleCapability,
  getVenuesWithLifecycleCapability,
  parseVenueLifecyclePolicy,
  type HunchVenue,
  type VenueLifecycleCapability,
  type VenueLifecyclePolicy,
} from "@hunch/shared";

import type { DbQuery } from "../db.js";

export type SignalBotVenueLifecycle = {
  invalidOverride: boolean;
  policy: VenueLifecyclePolicy;
  revision: string;
  source: "db" | "default";
};

const CACHE_TTL_MS = 15_000;
let cache = new WeakMap<
  object,
  { expiresAt: number; result: SignalBotVenueLifecycle }
>();

export function clearSignalBotVenueLifecycleCache(db?: DbQuery): void {
  if (db && typeof db === "object") {
    cache.delete(db as object);
    return;
  }
  cache = new WeakMap();
}

export async function resolveSignalBotVenueLifecycle(
  db: DbQuery,
): Promise<SignalBotVenueLifecycle> {
  const key = db as object;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  let result: SignalBotVenueLifecycle;
  try {
    const row = await fetchActiveRuntimePolicy(db, "venue_lifecycle");
    const policy = row ? parseVenueLifecyclePolicy(row.payload) : null;
    result = policy
      ? {
          invalidOverride: false,
          policy,
          revision: buildVenueLifecyclePolicyRevision(row?.effective_at),
          source: "db",
        }
      : {
          invalidOverride: row != null,
          policy: DEFAULT_VENUE_LIFECYCLE_POLICY,
          revision: buildVenueLifecyclePolicyRevision(null),
          source: "default",
        };
  } catch {
    result = {
      invalidOverride: true,
      policy: DEFAULT_VENUE_LIFECYCLE_POLICY,
      revision: buildVenueLifecyclePolicyRevision(null),
      source: "default",
    };
  }

  cache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}

export async function filterSignalBotVenuesForLifecycleCapability(
  db: DbQuery,
  venues: readonly unknown[] | null | undefined,
  capability: VenueLifecycleCapability,
): Promise<{ revision: string; venues: HunchVenue[] }> {
  const resolved = await resolveSignalBotVenueLifecycle(db);
  return {
    revision: resolved.revision,
    venues:
      venues == null
        ? getVenuesWithLifecycleCapability(resolved.policy, capability)
        : filterVenuesByLifecycleCapability(
            resolved.policy,
            venues,
            capability,
          ),
  };
}
