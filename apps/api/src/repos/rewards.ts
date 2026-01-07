import type { DbQuery } from "../db.js";
import type { PgParams } from "../server-types.js";

export type RewardsPolicyRow = {
  id: string;
  effective_at: Date;
  tiers: unknown;
  referral_bonus: unknown;
  created_at: Date;
};

export type ReferralRow = {
  id: string;
  referrer_user_id: string;
  referred_user_id: string;
  code: string;
  status: string;
  qualified_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function fetchActiveRewardsPolicy(
  pool: DbQuery,
): Promise<RewardsPolicyRow | null> {
  const { rows } = await pool.query<RewardsPolicyRow>(
    `
      select id, effective_at, tiers, referral_bonus, created_at
      from rewards_policy
      where effective_at <= now()
      order by effective_at desc
      limit 1
    `,
  );
  return rows[0] ?? null;
}

export async function fetchUserReferralCode(
  pool: DbQuery,
  userId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ referral_code: string | null }>(
    `select referral_code from users where id = $1`,
    [userId],
  );
  return rows[0]?.referral_code ?? null;
}

export async function setUserReferralCode(
  pool: DbQuery,
  userId: string,
  referralCode: string,
): Promise<void> {
  await pool.query(`update users set referral_code = $2 where id = $1`, [
    userId,
    referralCode,
  ]);
}

export async function findUserByReferralCode(
  pool: DbQuery,
  referralCode: string,
): Promise<{ id: string } | null> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from users where upper(referral_code) = upper($1) limit 1`,
    [referralCode],
  );
  return rows[0] ?? null;
}

export async function insertReferral(
  pool: DbQuery,
  inputs: {
    referrerUserId: string;
    referredUserId: string;
    code: string;
    status?: "pending" | "qualified" | "blocked";
    qualifiedAt?: Date | null;
  },
): Promise<boolean> {
  const { rows } = await pool.query<{ inserted: boolean }>(
    `
      insert into referrals (
        referrer_user_id,
        referred_user_id,
        code,
        status,
        qualified_at
      )
      values ($1, $2, $3, $4, $5)
      on conflict (referred_user_id) do nothing
      returning true as inserted
    `,
    [
      inputs.referrerUserId,
      inputs.referredUserId,
      inputs.code,
      inputs.status ?? "pending",
      inputs.qualifiedAt ?? null,
    ],
  );
  return Boolean(rows[0]?.inserted);
}

export async function fetchUserPoints(
  pool: DbQuery,
  userId: string,
): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `select coalesce(sum(notional_usd), 0)::text as total from volume_events where user_id = $1`,
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function fetchFeeTotals(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<{ pending: number; collected: number }> {
  const { rows } = await pool.query<{
    pending: string | null;
    collected: string | null;
  }>(
    `
      select
        coalesce(sum(case when status = 'pending' then fee_usd else 0 end), 0)::text as pending,
        coalesce(sum(case when status = 'collected' then fee_usd else 0 end), 0)::text as collected
      from fee_events
      where user_id = $1
    `,
    [inputs.userId],
  );
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    collected: Number(row?.collected ?? 0),
  };
}

export async function fetchFeeTotalsByChain(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<Record<string, { pending: number; collected: number }>> {
  const { rows } = await pool.query<{
    chain_id: string | null;
    pending: string | null;
    collected: string | null;
  }>(
    `
      select
        coalesce(chain_id, 'unknown') as chain_id,
        coalesce(sum(case when status = 'pending' then fee_usd else 0 end), 0)::text as pending,
        coalesce(sum(case when status = 'collected' then fee_usd else 0 end), 0)::text as collected
      from fee_events
      where user_id = $1
      group by chain_id
    `,
    [inputs.userId],
  );
  const totals: Record<string, { pending: number; collected: number }> = {};
  for (const row of rows) {
    const key = row.chain_id ?? "unknown";
    totals[key] = {
      pending: Number(row.pending ?? 0),
      collected: Number(row.collected ?? 0),
    };
  }
  return totals;
}

export async function fetchReferralFeeTotals(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<{ pending: number; collected: number }> {
  const { rows } = await pool.query<{
    pending: string | null;
    collected: string | null;
  }>(
    `
      select
        coalesce(sum(case when fe.status = 'pending' then fe.fee_usd else 0 end), 0)::text as pending,
        coalesce(sum(case when fe.status = 'collected' then fe.fee_usd else 0 end), 0)::text as collected
      from fee_events fe
      join referrals r on r.referred_user_id = fe.user_id
      where r.referrer_user_id = $1
        and r.status = 'qualified'
    `,
    [inputs.userId],
  );
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    collected: Number(row?.collected ?? 0),
  };
}

export async function fetchReferralFeeTotalsByChain(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<Record<string, { pending: number; collected: number }>> {
  const { rows } = await pool.query<{
    chain_id: string | null;
    pending: string | null;
    collected: string | null;
  }>(
    `
      select
        coalesce(fe.chain_id, 'unknown') as chain_id,
        coalesce(sum(case when fe.status = 'pending' then fe.fee_usd else 0 end), 0)::text as pending,
        coalesce(sum(case when fe.status = 'collected' then fe.fee_usd else 0 end), 0)::text as collected
      from fee_events fe
      join referrals r on r.referred_user_id = fe.user_id
      where r.referrer_user_id = $1
        and r.status = 'qualified'
      group by fe.chain_id
    `,
    [inputs.userId],
  );
  const totals: Record<string, { pending: number; collected: number }> = {};
  for (const row of rows) {
    const key = row.chain_id ?? "unknown";
    totals[key] = {
      pending: Number(row.pending ?? 0),
      collected: Number(row.collected ?? 0),
    };
  }
  return totals;
}

export async function fetchQualifiedReferralCount(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    `select count(*)::text as total from referrals where referrer_user_id = $1 and status = 'qualified'`,
    [inputs.userId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function fetchClaimedTotalsByChain(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<Record<string, number>> {
  const { rows } = await pool.query<{
    chain_id: string | null;
    total: string | null;
  }>(
    `
      select
        coalesce(chain_id, 'unknown') as chain_id,
        coalesce(sum(amount_usdc), 0)::text as total
      from reward_claims
      where user_id = $1
        and status <> 'failed'
      group by chain_id
    `,
    [inputs.userId],
  );
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const key = row.chain_id ?? "unknown";
    totals[key] = Number(row.total ?? 0);
  }
  return totals;
}

export async function fetchClaimedTotal(
  pool: DbQuery,
  inputs: { userId: string; chainId?: string | null },
): Promise<number> {
  const params: PgParams = [inputs.userId];
  let whereClause = "where user_id = $1 and status <> 'failed'";
  if (inputs.chainId) {
    params.push(inputs.chainId);
    whereClause += ` and chain_id = $${params.length}`;
  }

  const { rows } = await pool.query<{ total: string | null }>(
    `select coalesce(sum(amount_usdc), 0)::text as total from reward_claims ${whereClause}`,
    params,
  );
  return Number(rows[0]?.total ?? 0);
}

export async function fetchReferralsForUser(
  pool: DbQuery,
  inputs: { userId: string; limit: number; offset: number },
): Promise<
  Array<{
    id: string;
    referred_user_id: string;
    status: string;
    qualified_at: Date | null;
    created_at: Date;
    wallet_address: string | null;
    points: number;
  }>
> {
  const { rows } = await pool.query<{
    id: string;
    referred_user_id: string;
    status: string;
    qualified_at: Date | null;
    created_at: Date;
    wallet_address: string | null;
    points: string | null;
  }>(
    `
      with points as (
        select user_id, coalesce(sum(notional_usd), 0)::text as points
        from volume_events
        group by user_id
      )
      select
        r.id,
        r.referred_user_id,
        r.status,
        r.qualified_at,
        r.created_at,
        w.wallet_address,
        p.points
      from referrals r
      left join user_wallets w
        on w.user_id = r.referred_user_id
       and w.is_primary = true
      left join points p
        on p.user_id = r.referred_user_id
      where r.referrer_user_id = $1
      order by r.created_at desc
      limit $2 offset $3
    `,
    [inputs.userId, inputs.limit, inputs.offset],
  );

  return rows.map((row) => ({
    id: row.id,
    referred_user_id: row.referred_user_id,
    status: row.status,
    qualified_at: row.qualified_at,
    created_at: row.created_at,
    wallet_address: row.wallet_address ?? null,
    points: Number(row.points ?? 0),
  }));
}

export async function markQualifiedReferralsForUser(
  pool: DbQuery,
  inputs: { userId: string; threshold: number },
): Promise<void> {
  await pool.query(
    `
      with points as (
        select user_id, coalesce(sum(notional_usd), 0) as points
        from volume_events
        group by user_id
      )
      update referrals r
      set status = 'qualified',
          qualified_at = coalesce(r.qualified_at, now())
      from points pref, points prefed
      where r.status = 'pending'
        and r.referrer_user_id = $1
        and pref.user_id = r.referrer_user_id
        and pref.points >= $2
        and prefed.user_id = r.referred_user_id
        and prefed.points >= $2
    `,
    [inputs.userId, inputs.threshold],
  );
}

export async function insertRewardClaim(
  pool: DbQuery,
  inputs: {
    userId: string;
    walletAddress: string;
    chainId: string;
    amountUsd: number;
    status: "pending" | "submitted" | "confirmed" | "failed";
    txHash?: string | null;
  },
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into reward_claims (
        id,
        user_id,
        wallet_address,
        chain_id,
        amount_usdc,
        tx_hash,
        status,
        created_at,
        updated_at
      )
      values (
        gen_random_uuid(),
        $1, $2, $3, $4, $5, $6,
        now(), now()
      )
      returning id
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.chainId,
      inputs.amountUsd,
      inputs.txHash ?? null,
      inputs.status,
    ],
  );
  return { id: rows[0].id };
}
