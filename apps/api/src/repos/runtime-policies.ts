import {
  fetchActiveRuntimePolicy,
  listActiveRuntimePolicies,
  type RuntimePolicyRow,
} from "@hunch/db";
import type { DbQuery } from "../db.js";

export { fetchActiveRuntimePolicy, listActiveRuntimePolicies };
export type { RuntimePolicyRow };

export type RuntimePolicyActor = Readonly<{
  id: string;
  kind: "admin_account" | "legacy_user";
}>;

export function runtimePolicyCreatorIds(actor: RuntimePolicyActor): Readonly<{
  createdByAdminId: string | null;
  createdByUserId: string | null;
}> {
  return actor.kind === "admin_account"
    ? { createdByAdminId: actor.id, createdByUserId: null }
    : { createdByAdminId: null, createdByUserId: actor.id };
}

export async function insertRuntimePolicy(
  pool: DbQuery,
  inputs: {
    policyKey: string;
    effectiveAt: Date;
    payload: unknown;
    createdByUserId: string | null;
    createdByAdminId: string | null;
  },
): Promise<RuntimePolicyRow> {
  const { rows } = await pool.query<RuntimePolicyRow>(
    `
      insert into runtime_policies (
        policy_key,
        effective_at,
        payload,
        created_by,
        created_by_admin_id
      )
      values ($1, $2, $3::jsonb, $4, $5)
      returning
        id,
        policy_key,
        effective_at,
        payload,
        created_by,
        created_by_admin_id,
        created_at
    `,
    [
      inputs.policyKey,
      inputs.effectiveAt,
      JSON.stringify(inputs.payload ?? {}),
      inputs.createdByUserId,
      inputs.createdByAdminId,
    ],
  );
  return rows[0];
}
