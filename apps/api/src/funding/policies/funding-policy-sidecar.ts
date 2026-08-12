import type { Pool } from "@hunch/infra";

import {
  FUNDING_POLICY_KEY,
  fundingPolicyRevision,
  type FundingRuntimePolicy,
} from "./funding-policy.js";
import {
  DEFAULT_FUNDING_INTENT_POLICY,
  compileFundingIntentPolicy,
  validateFundingIntentPolicy,
  type FundingIntentPolicy,
} from "./funding-policy-v2.js";

type Queryable = Pick<Pool, "query">;

export type FundingControlPlaneSnapshot = Readonly<{
  policy: FundingIntentPolicy;
  runtime: FundingRuntimePolicy;
  revision: string;
  invalidStoredPolicy: boolean;
}>;

export async function lockFundingPolicyForTransaction(
  db: Queryable,
): Promise<void> {
  await db.query<{ locked: unknown }>(
    "select pg_advisory_xact_lock(hashtext($1)) as locked",
    [FUNDING_POLICY_KEY],
  );
}

function snapshot(
  policy: FundingIntentPolicy,
  invalidStoredPolicy: boolean,
): FundingControlPlaneSnapshot {
  return {
    policy,
    runtime: compileFundingIntentPolicy(policy),
    revision: fundingPolicyRevision(policy),
    invalidStoredPolicy,
  };
}

export async function resolveFundingControlPlaneSnapshot(
  db: Queryable,
): Promise<FundingControlPlaneSnapshot> {
  const { rows } = await db.query<{ payload: unknown }>(
    `
      select payload
      from runtime_policies
      where policy_key = $1
        and effective_at <= now()
      order by effective_at desc, created_at desc
      limit 1
    `,
    [FUNDING_POLICY_KEY],
  );
  const row = rows[0];
  if (!row) return snapshot(DEFAULT_FUNDING_INTENT_POLICY, false);
  const validated = validateFundingIntentPolicy(row.payload);
  return validated.ok
    ? snapshot(validated.policy, false)
    : snapshot(DEFAULT_FUNDING_INTENT_POLICY, true);
}
