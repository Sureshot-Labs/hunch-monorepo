import type { Pool } from "@hunch/infra";

import { lookupHmac } from "./canonical.js";
import type { RouteExperienceObservation } from "../planner/route-experience.js";

const ROUTE_EXPERIENCE_DOMAIN = "hunch:funding:route-experience:v1:";

export function fundingRouteExperienceFingerprint(
  routeKey: string,
  lookupHmacKey: string,
): string {
  const normalized = routeKey.trim();
  if (normalized.length < 8 || normalized.length > 512) {
    throw new Error("funding route experience key is outside policy");
  }
  return lookupHmac(`${ROUTE_EXPERIENCE_DOMAIN}${normalized}`, lookupHmacKey);
}

export async function fetchFundingRouteExperience(
  db: Pick<Pool, "query">,
  input: Readonly<{
    routeKeyHmac: string;
    routeKeyVersion: number;
    maximumAgeMs: number;
    now?: Date;
  }>,
): Promise<RouteExperienceObservation | null> {
  if (
    !Number.isInteger(input.routeKeyVersion) ||
    input.routeKeyVersion <= 0 ||
    !Number.isInteger(input.maximumAgeMs) ||
    input.maximumAgeMs <= 0
  ) {
    throw new Error("funding route experience query policy is invalid");
  }
  const now = input.now ?? new Date();
  const oldest = new Date(now.getTime() - input.maximumAgeMs);
  const { rows } = await db.query<{
    observation_count: string | number;
    succeeded_count: string | number;
    p95_latency_ms: string | number | null;
  }>(
    `
      select
        count(*)::bigint as observation_count,
        count(*) filter (where outcome = 'succeeded')::bigint
          as succeeded_count,
        percentile_cont(0.95) within group (
          order by extract(epoch from (finished_at - started_at)) * 1000
        ) as p95_latency_ms
      from funding_route_observations
      where route_key_hmac = $1
        and route_key_version = $2
        and started_at >= $3
        and finished_at is not null
        and outcome in (
          'succeeded',
          'refunded',
          'failed',
          'reconcile_required',
          'recovery_required',
          'cancelled'
        )
    `,
    [input.routeKeyHmac, input.routeKeyVersion, oldest],
  );
  const row = rows[0];
  const count = Number(row?.observation_count ?? 0);
  if (count === 0) return null;
  return {
    observationCount: count,
    succeededCount: Number(row?.succeeded_count ?? 0),
    p95LatencyMs:
      row?.p95_latency_ms == null ? null : Number(row.p95_latency_ms),
  };
}
