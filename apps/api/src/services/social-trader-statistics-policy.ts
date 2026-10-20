import { createHash } from "node:crypto";
import type { SocialPolicy } from "./social-policy.js";

/** Bump the algorithm version whenever profileStatistics changes its meaning.
 * Social publishing/rate-limit policy is unrelated to this cached calculation. */
export function buildSocialTraderStatisticsRevision(
  policy: Pick<
    SocialPolicy,
    "profileStatsWindowDays" | "profileStatsMinResolved"
  >,
) {
  return `trader-statistics:v1:${createHash("sha256")
    .update(
      JSON.stringify([
        policy.profileStatsWindowDays,
        policy.profileStatsMinResolved,
      ]),
    )
    .digest("hex")
    .slice(0, 16)}`;
}
