import type { Pool } from "@hunch/infra";

export type FeePolicyRow = {
  id: string;
  venue: "polymarket" | "kalshi";
  fee_bps: number;
  fee_scale: number | null;
  effective_at: Date;
  created_at: Date;
};

export async function fetchActiveFeePolicy(
  pool: Pool,
  venue: "polymarket" | "kalshi",
): Promise<FeePolicyRow | null> {
  const { rows } = await pool.query<FeePolicyRow>(
    `
      select id, venue, fee_bps, fee_scale, effective_at, created_at
      from fee_policy
      where venue = $1
        and effective_at <= now()
      order by effective_at desc
      limit 1
    `,
    [venue],
  );
  return rows[0] ?? null;
}

export async function insertFeePolicy(
  pool: Pool,
  inputs: {
    venue: "polymarket" | "kalshi";
    feeBps: number;
    feeScale: number | null;
    effectiveAt: Date;
  },
): Promise<FeePolicyRow> {
  const { rows } = await pool.query<FeePolicyRow>(
    `
      insert into fee_policy (venue, fee_bps, fee_scale, effective_at)
      values ($1, $2, $3, $4)
      returning id, venue, fee_bps, fee_scale, effective_at, created_at
    `,
    [inputs.venue, inputs.feeBps, inputs.feeScale, inputs.effectiveAt],
  );
  return rows[0];
}
