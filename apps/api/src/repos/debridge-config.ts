import type { Pool } from "pg";

export type DebridgeConfigRow = {
  id: string;
  effective_at: Date;
  dln_base: string | null;
  stats_base: string | null;
  affiliate_fee_percent: number | null;
  affiliate_fee_recipients: Record<string, string> | null;
  referral_code: number | null;
  created_at: Date;
};

export async function fetchActiveDebridgeConfig(
  pool: Pool,
): Promise<DebridgeConfigRow | null> {
  const { rows } = await pool.query<DebridgeConfigRow>(
    `
      select
        id,
        effective_at,
        dln_base,
        stats_base,
        affiliate_fee_percent,
        affiliate_fee_recipients,
        referral_code,
        created_at
      from debridge_config
      where effective_at <= now()
      order by effective_at desc, created_at desc
      limit 1
    `,
  );
  return rows[0] ?? null;
}

export async function insertDebridgeConfig(
  pool: Pool,
  inputs: {
    effectiveAt: Date;
    dlnBase: string | null;
    statsBase: string | null;
    affiliateFeePercent: number | null;
    affiliateFeeRecipients: Record<string, string> | null;
    referralCode: number | null;
  },
): Promise<DebridgeConfigRow> {
  const { rows } = await pool.query<DebridgeConfigRow>(
    `
      insert into debridge_config (
        effective_at,
        dln_base,
        stats_base,
        affiliate_fee_percent,
        affiliate_fee_recipients,
        referral_code
      )
      values ($1, $2, $3, $4, $5, $6)
      returning
        id,
        effective_at,
        dln_base,
        stats_base,
        affiliate_fee_percent,
        affiliate_fee_recipients,
        referral_code,
        created_at
    `,
    [
      inputs.effectiveAt,
      inputs.dlnBase,
      inputs.statsBase,
      inputs.affiliateFeePercent,
      inputs.affiliateFeeRecipients,
      inputs.referralCode,
    ],
  );
  if (!rows.length) {
    throw new Error("Failed to insert debridge config");
  }
  return rows[0];
}
