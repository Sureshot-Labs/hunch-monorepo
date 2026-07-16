export type RuntimePolicyRow = {
  id: string;
  policy_key: string;
  effective_at: Date;
  payload: unknown;
  created_by: string | null;
  created_at: Date;
};

export type RuntimePolicyQuery = {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export function isMissingRuntimePoliciesTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "42P01";
}

export async function fetchActiveRuntimePolicy(
  pool: RuntimePolicyQuery,
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
  pool: RuntimePolicyQuery,
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
