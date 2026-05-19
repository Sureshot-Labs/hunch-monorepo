import type { Pool } from "@hunch/infra";

export type FeePolicyRow = {
  id: string;
  venue: "polymarket" | "kalshi";
  fee_bps: number;
  fee_scale: number | null;
  polymarket_builder_code: string | null;
  polymarket_builder_taker_fee_bps: number | null;
  polymarket_builder_maker_fee_bps: number | null;
  effective_at: Date;
  created_at: Date;
};

export async function fetchActiveFeePolicy(
  pool: Pool,
  venue: "polymarket" | "kalshi",
): Promise<FeePolicyRow | null> {
  const { rows } = await pool.query<FeePolicyRow>(
    `
      select
        id,
        venue,
        fee_bps,
        fee_scale,
        polymarket_builder_code,
        polymarket_builder_taker_fee_bps,
        polymarket_builder_maker_fee_bps,
        effective_at,
        created_at
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
    polymarketBuilderCode?: string | null;
    polymarketBuilderTakerFeeBps?: number | null;
    polymarketBuilderMakerFeeBps?: number | null;
    effectiveAt: Date;
  },
): Promise<FeePolicyRow> {
  const { rows } = await pool.query<FeePolicyRow>(
    `
      insert into fee_policy (
        venue,
        fee_bps,
        fee_scale,
        polymarket_builder_code,
        polymarket_builder_taker_fee_bps,
        polymarket_builder_maker_fee_bps,
        effective_at
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      returning
        id,
        venue,
        fee_bps,
        fee_scale,
        polymarket_builder_code,
        polymarket_builder_taker_fee_bps,
        polymarket_builder_maker_fee_bps,
        effective_at,
        created_at
    `,
    [
      inputs.venue,
      inputs.feeBps,
      inputs.feeScale,
      inputs.polymarketBuilderCode ?? null,
      inputs.polymarketBuilderTakerFeeBps ?? null,
      inputs.polymarketBuilderMakerFeeBps ?? null,
      inputs.effectiveAt,
    ],
  );
  return rows[0];
}
