import {
  fetchActiveRuntimePolicy,
  listActiveRuntimePolicies,
  type RuntimePolicyRow,
} from "@hunch/db";
import type { DbQuery } from "../db.js";

export { fetchActiveRuntimePolicy, listActiveRuntimePolicies };
export type { RuntimePolicyRow };

export async function insertRuntimePolicy(
  pool: DbQuery,
  inputs: {
    policyKey: string;
    effectiveAt: Date;
    payload: unknown;
    createdBy: string | null;
  },
): Promise<RuntimePolicyRow> {
  const { rows } = await pool.query<RuntimePolicyRow>(
    `
      insert into runtime_policies (
        policy_key,
        effective_at,
        payload,
        created_by
      )
      values ($1, $2, $3::jsonb, $4)
      returning
        id,
        policy_key,
        effective_at,
        payload,
        created_by,
        created_at
    `,
    [
      inputs.policyKey,
      inputs.effectiveAt,
      JSON.stringify(inputs.payload ?? {}),
      inputs.createdBy,
    ],
  );
  return rows[0];
}
