import { fetchActiveRuntimePolicy } from "@hunch/db";
import { DEFAULT_VENUE_LIFECYCLE_POLICY, venueLifecyclePolicySchema, venueHasLifecycleCapability } from "@hunch/shared";
import type { Pool } from "@hunch/infra";
import { SocialPolicyUnavailableError, type SocialPolicy } from "./social-policy.js";

/** Social qualifies attribution; the existing lifecycle still owns exposure. */
export async function readSocialCopyVenues(db: Pick<Pool, "query">, policy: SocialPolicy): Promise<SocialPolicy["copyVenues"]> {
  if (!policy.enabled || !policy.copyEnabled) return [];
  try {
    const row = await fetchActiveRuntimePolicy(db, "venue_lifecycle", new Date(), { missingTable: "error" });
    const lifecycle = venueLifecyclePolicySchema.parse(row?.payload ?? DEFAULT_VENUE_LIFECYCLE_POLICY);
    return policy.copyVenues.filter(venue => venueHasLifecycleCapability(lifecycle, venue, "increaseExposure"));
  } catch { throw new SocialPolicyUnavailableError(); }
}
