import type { PoolClient } from "pg";
import { acquireRewardsUserAdvisoryXactLock } from "../lib/rewards-user-lock.js";
import { parseUsdcToMicro, usdcMicroToDecimalString } from "../lib/usdc.js";

const OBSERVER_THRESHOLD = 500;

type RewardsTier = {
  tier: number;
  name: string;
  points: number;
  cashbackBps: number;
};

type ReferralBonus = {
  minReferrals: number;
  bonusBps: number;
};

const DEFAULT_POLICY: { tiers: RewardsTier[]; referralBonus: ReferralBonus[] } = {
  tiers: [
    { tier: 0, name: "Novice", points: 0, cashbackBps: 0 },
    { tier: 1, name: "Observer", points: 500, cashbackBps: 2500 },
    { tier: 2, name: "Seeker", points: 5000, cashbackBps: 3000 },
    { tier: 3, name: "Analyst", points: 30000, cashbackBps: 3500 },
    { tier: 4, name: "Forecaster", points: 120000, cashbackBps: 4000 },
    { tier: 5, name: "Sage", points: 350000, cashbackBps: 4500 },
    { tier: 6, name: "Ascendant", points: 1000000, cashbackBps: 5000 },
    { tier: 7, name: "Oracle", points: 2500000, cashbackBps: 5500 },
  ],
  referralBonus: [
    { minReferrals: 3, bonusBps: 500 },
    { minReferrals: 5, bonusBps: 1000 },
    { minReferrals: 10, bonusBps: 1500 },
    { minReferrals: 20, bonusBps: 2000 },
    { minReferrals: 25, bonusBps: 2500 },
  ],
};

function clampBps(value: number, max = 10_000): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

function resolveTier(points: number, tiers: RewardsTier[]): RewardsTier {
  let current = tiers[0];
  for (const tier of tiers) {
    if (points >= tier.points) {
      current = tier;
    } else {
      break;
    }
  }
  return current;
}

function resolveReferralBonus(
  count: number,
  bonuses: ReferralBonus[],
): ReferralBonus | null {
  let current: ReferralBonus | null = null;
  for (const bonus of bonuses) {
    if (count >= bonus.minReferrals) {
      if (!current || bonus.minReferrals > current.minReferrals) {
        current = bonus;
      }
    }
  }
  return current;
}

function normalizeTier(raw: unknown): RewardsTier | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const tier = Number(record.tier);
  const points = Number(record.points);
  const cashbackBps = Number(record.cashbackBps);
  const name = typeof record.name === "string" ? record.name : "";
  if (!Number.isFinite(tier) || !Number.isFinite(points)) return null;
  if (!Number.isFinite(cashbackBps)) return null;
  if (!name.trim()) return null;
  return { tier, name, points, cashbackBps };
}

function normalizeReferralBonus(raw: unknown): ReferralBonus | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const minReferrals = Number(record.minReferrals);
  const bonusBps = Number(record.bonusBps);
  if (!Number.isFinite(minReferrals) || !Number.isFinite(bonusBps)) return null;
  return { minReferrals, bonusBps };
}

function parsePolicy(raw: {
  tiers: unknown;
  referral_bonus: unknown;
}): { tiers: RewardsTier[]; referralBonus: ReferralBonus[] } | null {
  if (!Array.isArray(raw.tiers) || !Array.isArray(raw.referral_bonus)) return null;

  const tiers = raw.tiers.map(normalizeTier).filter(Boolean) as RewardsTier[];
  const referralBonus = raw.referral_bonus
    .map(normalizeReferralBonus)
    .filter(Boolean) as ReferralBonus[];
  if (!tiers.length || !referralBonus.length) return null;
  return {
    tiers: tiers.sort((a, b) => a.points - b.points),
    referralBonus,
  };
}

async function lockUser(client: PoolClient, userId: string): Promise<void> {
  await acquireRewardsUserAdvisoryXactLock(client, userId);
}

async function fetchUserPointsAtEvent(
  client: PoolClient,
  userId: string,
  eventTime: Date,
): Promise<number> {
  const { rows } = await client.query<{ total: string | null }>(
    `
      select coalesce(sum(points_awarded), 0)::text as total
      from volume_events
      where user_id = $1
        and created_at <= $2
    `,
    [userId, eventTime],
  );
  return Number(rows[0]?.total ?? 0);
}

async function fetchPolicyAtEvent(
  client: PoolClient,
  eventTime: Date,
): Promise<{ tiers: RewardsTier[]; referralBonus: ReferralBonus[] }> {
  const { rows } = await client.query<{
    tiers: unknown;
    referral_bonus: unknown;
  }>(
    `
      select tiers, referral_bonus
      from rewards_policy
      where effective_at <= $1
      order by effective_at desc
      limit 1
    `,
    [eventTime],
  );
  const parsed = rows[0] ? parsePolicy(rows[0]) : null;
  if (!parsed) return DEFAULT_POLICY;
  return parsed;
}

async function fetchReferrerId(
  client: PoolClient,
  referredUserId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ referrer_user_id: string | null }>(
    `
      select referrer_user_id
      from referrals
      where referred_user_id = $1
      limit 1
    `,
    [referredUserId],
  );
  return rows[0]?.referrer_user_id ?? null;
}

async function fetchQualifiedReferralCountAtEvent(
  client: PoolClient,
  referrerUserId: string,
  eventTime: Date,
): Promise<number> {
  const { rows } = await client.query<{ total: string | null }>(
    `
      with referred_points as (
        select
          user_id,
          coalesce(sum(points_awarded), 0)::numeric as points
        from volume_events
        where created_at <= $2
        group by user_id
      )
      select count(*)::text as total
      from referrals r
      left join referred_points rp
        on rp.user_id = r.referred_user_id
      where r.referrer_user_id = $1
        and r.created_at <= $2
        and r.status <> 'blocked'
        and coalesce(rp.points, 0) >= $3
    `,
    [referrerUserId, eventTime, OBSERVER_THRESHOLD],
  );
  return Number(rows[0]?.total ?? 0);
}

async function markReferralQualified(
  client: PoolClient,
  referredUserId: string,
  qualifiedAt: Date,
): Promise<void> {
  await client.query(
    `
      update referrals
      set status = 'qualified',
          qualified_at = coalesce(qualified_at, $2),
          updated_at = now()
      where referred_user_id = $1
        and status = 'pending'
    `,
    [referredUserId, qualifiedAt],
  );
}

export type FeeEventSnapshot = {
  cashbackBpsApplied: number;
  referralBpsApplied: number;
  cashbackEarnedUsdc: string;
  referralEarnedUsdc: string;
  liabilitySnapshotSource: "event_time_frozen";
};

export async function resolveFeeEventSnapshotAtWrite(
  client: PoolClient,
  inputs: {
    userId: string;
    eventTime: Date;
    feeUsd: string;
  },
): Promise<FeeEventSnapshot> {
  const referrerUserId = await fetchReferrerId(client, inputs.userId);
  const lockUsers = referrerUserId
    ? [inputs.userId, referrerUserId].sort((a, b) => a.localeCompare(b))
    : [inputs.userId];
  for (const userId of lockUsers) {
    await lockUser(client, userId);
  }

  const policy = await fetchPolicyAtEvent(client, inputs.eventTime);
  const [referredPoints, referrerPoints] = await Promise.all([
    fetchUserPointsAtEvent(client, inputs.userId, inputs.eventTime),
    referrerUserId
      ? fetchUserPointsAtEvent(client, referrerUserId, inputs.eventTime)
      : Promise.resolve(0),
  ]);

  const tier = resolveTier(referredPoints, policy.tiers);
  const cashbackBpsApplied = clampBps(tier.cashbackBps);

  let referralBpsApplied = 0;
  const hasQualifiedReferralLink = Boolean(
    referrerUserId &&
      referredPoints >= OBSERVER_THRESHOLD &&
      referrerPoints >= OBSERVER_THRESHOLD,
  );
  if (hasQualifiedReferralLink && referrerUserId) {
    await markReferralQualified(client, inputs.userId, inputs.eventTime);
    const qualifiedReferrals = await fetchQualifiedReferralCountAtEvent(
      client,
      referrerUserId,
      inputs.eventTime,
    );
    referralBpsApplied = clampBps(
      resolveReferralBonus(qualifiedReferrals, policy.referralBonus)?.bonusBps ?? 0,
      Math.max(
        0,
        10_000 - Math.max(...policy.tiers.map((entry) => clampBps(entry.cashbackBps))),
      ),
    );
  }

  const feeMicro = parseUsdcToMicro(inputs.feeUsd);
  if (feeMicro == null || feeMicro < 0n) {
    throw new Error("Invalid feeUsd for frozen liability snapshot");
  }
  const cashbackEarnedMicro = (feeMicro * BigInt(cashbackBpsApplied)) / 10_000n;
  const referralEarnedMicro = (feeMicro * BigInt(referralBpsApplied)) / 10_000n;

  return {
    cashbackBpsApplied,
    referralBpsApplied,
    cashbackEarnedUsdc: usdcMicroToDecimalString(cashbackEarnedMicro),
    referralEarnedUsdc: usdcMicroToDecimalString(referralEarnedMicro),
    liabilitySnapshotSource: "event_time_frozen",
  };
}
