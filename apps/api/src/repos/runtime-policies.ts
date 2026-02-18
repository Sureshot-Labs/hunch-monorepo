import type { DbQuery } from "../db.js";

export type RuntimePolicyRow = {
  id: string;
  policy_key: string;
  effective_at: Date;
  payload: unknown;
  created_by: string | null;
  created_at: Date;
};

function isMissingRuntimePoliciesTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "42P01";
}

export async function fetchActiveRuntimePolicy(
  pool: DbQuery,
  policyKey: string,
  asOf: Date = new Date(),
): Promise<RuntimePolicyRow | null> {
  try {
    const { rows } = await pool.query<RuntimePolicyRow>(
      `
        select
          id,
          policy_key,
          effective_at,
          payload,
          created_by,
          created_at
        from runtime_policies
        where policy_key = $1
          and effective_at <= $2::timestamptz
        order by effective_at desc, created_at desc
        limit 1
      `,
      [policyKey, asOf],
    );
    return rows[0] ?? null;
  } catch (error) {
    if (isMissingRuntimePoliciesTable(error)) return null;
    throw error;
  }
}

export async function listActiveRuntimePolicies(
  pool: DbQuery,
  asOf: Date = new Date(),
): Promise<RuntimePolicyRow[]> {
  try {
    const { rows } = await pool.query<RuntimePolicyRow>(
      `
        with ranked as (
          select
            rp.*,
            row_number() over (
              partition by rp.policy_key
              order by rp.effective_at desc, rp.created_at desc
            ) as rn
          from runtime_policies rp
          where rp.effective_at <= $1::timestamptz
        )
        select
          id,
          policy_key,
          effective_at,
          payload,
          created_by,
          created_at
        from ranked
        where rn = 1
        order by policy_key asc
      `,
      [asOf],
    );
    return rows;
  } catch (error) {
    if (isMissingRuntimePoliciesTable(error)) return [];
    throw error;
  }
}

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
