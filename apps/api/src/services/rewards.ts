import { randomBytes } from "node:crypto";
import type { DbQuery } from "../db.js";
import {
  fetchActiveRewardsPolicy,
  fetchClaimedTotalsByChain,
  fetchFeeTotalsByChain,
  fetchQualifiedReferralCount,
  fetchReferralFeeTotalsByChain,
  fetchRewardsLeaderboardMe,
  fetchRewardsLeaderboardRows,
  fetchReferralsForUser,
  fetchUserPoints,
  fetchUserReferralCode,
  findUserByReferralCode,
  insertReferral,
  insertRewardClaim,
  type RewardsLeaderboardInterval,
  type RewardsLeaderboardMetric,
  type RewardsLeaderboardRow,
  markQualifiedReferralsForUser,
  setUserReferralCode,
} from "../repos/rewards.js";
import { reconcileSolanaFeeEvents } from "./fee-reconcile.js";

const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const DEFAULT_POLICY = {
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

const OBSERVER_THRESHOLD = 500;
const SOLANA_FEE_RECONCILE_LIMIT = 10;
const SOLANA_FEE_RECONCILE_MIN_AGE_SEC = 60;

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

function clampBps(value: number, max = 10_000): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

function maxBps(values: number[]): number {
  if (!values.length) return 0;
  return Math.max(...values.map((value) => (Number.isFinite(value) ? value : 0)));
}

function resolveEffectiveBps(
  policy: RewardsPolicy,
  tierBps: number,
  bonusBps: number,
) {
  const maxCashbackBps = maxBps(policy.tiers.map((tier) => tier.cashbackBps));
  const cappedCashbackBps = clampBps(tierBps);
  const maxReferralCap = Math.max(0, 10_000 - maxCashbackBps);
  const cappedBonusBps = clampBps(bonusBps, maxReferralCap);
  return {
    cappedCashbackBps,
    cappedBonusBps,
  };
}

export type RewardsPolicy = {
  effectiveAt: Date | null;
  tiers: RewardsTier[];
  referralBonus: ReferralBonus[];
};

export type RewardsLeaderboardEntry = RewardsLeaderboardRow & { isYou: boolean };

export type RewardsLeaderboard = {
  metric: RewardsLeaderboardMetric;
  intervalRequested: RewardsLeaderboardInterval;
  intervalApplied: RewardsLeaderboardInterval;
  entries: RewardsLeaderboardEntry[];
  me: RewardsLeaderboardEntry | null;
};

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

function resolveLeaderboardStart(
  interval: RewardsLeaderboardInterval,
): Date | null {
  const now = new Date();
  switch (interval) {
    case "daily":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "weekly":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "monthly": {
      const date = new Date(now);
      date.setMonth(date.getMonth() - 1);
      return date;
    }
    case "yearly": {
      const date = new Date(now);
      date.setFullYear(date.getFullYear() - 1);
      return date;
    }
    case "alltime":
    default:
      return null;
  }
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
  return { tiers, referralBonus };
}

function sortTiers(tiers: RewardsTier[]): RewardsTier[] {
  return [...tiers].sort((a, b) => a.points - b.points);
}

function resolveTier(points: number, tiers: RewardsTier[]): RewardsTier {
  let current = tiers[0];
  for (const tier of tiers) {
    if (points >= tier.points) current = tier;
    else break;
  }
  return current;
}

function resolveNextTier(
  points: number,
  tiers: RewardsTier[],
): RewardsTier | null {
  for (const tier of tiers) {
    if (points < tier.points) return tier;
  }
  return null;
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

function normalizeReferralCode(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  const sanitized = upper.replace(/[^A-Z0-9]/g, "");
  if (!sanitized) return null;
  return sanitized.slice(0, 32);
}

function generateReferralCode(): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let output = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    const idx = bytes[i] % REFERRAL_ALPHABET.length;
    output += REFERRAL_ALPHABET[idx];
  }
  return output;
}

export async function getRewardsPolicy(pool: DbQuery): Promise<RewardsPolicy> {
  const row = await fetchActiveRewardsPolicy(pool);
  if (!row) {
    return {
      effectiveAt: null,
      tiers: sortTiers(DEFAULT_POLICY.tiers),
      referralBonus: DEFAULT_POLICY.referralBonus,
    };
  }
  const parsed = parsePolicy({
    tiers: row.tiers,
    referral_bonus: row.referral_bonus,
  });

  if (!parsed) {
    return {
      effectiveAt: row.effective_at,
      tiers: sortTiers(DEFAULT_POLICY.tiers),
      referralBonus: DEFAULT_POLICY.referralBonus,
    };
  }

  return {
    effectiveAt: row.effective_at,
    tiers: sortTiers(parsed.tiers),
    referralBonus: parsed.referralBonus,
  };
}

export async function getOrCreateReferralCode(
  pool: DbQuery,
  userId: string,
): Promise<string> {
  const existing = await fetchUserReferralCode(pool, userId);
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode();
    const found = await findUserByReferralCode(pool, code);
    if (found) continue;
    await setUserReferralCode(pool, userId, code);
    return code;
  }

  const fallback = `${generateReferralCode()}${Math.floor(Date.now() / 1000)}`;
  const truncated = fallback.slice(0, 32);
  await setUserReferralCode(pool, userId, truncated);
  return truncated;
}

export async function attachReferralCode(
  pool: DbQuery,
  inputs: { userId: string; referralCode: string },
): Promise<void> {
  const normalized = normalizeReferralCode(inputs.referralCode);
  if (!normalized) return;

  const referrer = await findUserByReferralCode(pool, normalized);
  if (!referrer) return;
  if (referrer.id === inputs.userId) return;

  await insertReferral(pool, {
    referrerUserId: referrer.id,
    referredUserId: inputs.userId,
    code: normalized,
    status: "pending",
  });
}

export async function getRewardsSummary(
  pool: DbQuery,
  inputs: { userId: string },
  options?: { skipReconcile?: boolean; skipReferralQualification?: boolean },
): Promise<{
  policy: RewardsPolicy;
  clout: { points: number };
  tier: RewardsTier;
  nextTier: RewardsTier | null;
  progress: { pct: number; remaining: number | null };
  cashback: {
    pending: number;
    collected: number;
    claimable: number;
    bps: number;
    byChain: Record<string, { pending: number; collected: number; claimable: number }>;
  };
  referralBonus: {
    qualifiedCount: number;
    bonusBps: number;
    pending: number;
    collected: number;
    byChain: Record<string, { pending: number; collected: number }>;
  };
}> {
  const policy = await getRewardsPolicy(pool);
  if (!options?.skipReconcile) {
    try {
      await reconcileSolanaFeeEvents(pool, {
        limit: SOLANA_FEE_RECONCILE_LIMIT,
        minAgeSec: SOLANA_FEE_RECONCILE_MIN_AGE_SEC,
      });
    } catch {
      // Best-effort only; summary should still render if RPC fails.
    }
  }
  if (!options?.skipReferralQualification) {
    await markQualifiedReferralsForUser(pool, {
      userId: inputs.userId,
      threshold: OBSERVER_THRESHOLD,
    });
  }

  const points = await fetchUserPoints(pool, inputs.userId);
  const tier = resolveTier(points, policy.tiers);
  const nextTier = resolveNextTier(points, policy.tiers);
  const progressPct = nextTier
    ? Math.min(
        1,
        Math.max(
          0,
          (points - tier.points) / (nextTier.points - tier.points),
        ),
      )
    : 1;
  const remaining = nextTier ? Math.max(0, nextTier.points - points) : null;

  const feeTotalsByChain = await fetchFeeTotalsByChain(pool, {
    userId: inputs.userId,
  });
  const qualifiedCount = await fetchQualifiedReferralCount(pool, {
    userId: inputs.userId,
  });
  const bonus = resolveReferralBonus(qualifiedCount, policy.referralBonus);
  const bonusBps = bonus?.bonusBps ?? 0;
  const { cappedCashbackBps, cappedBonusBps } = resolveEffectiveBps(
    policy,
    tier.cashbackBps,
    bonusBps,
  );
  const referralFeeTotalsByChain = await fetchReferralFeeTotalsByChain(pool, {
    userId: inputs.userId,
  });
  const claimedTotalsByChain = await fetchClaimedTotalsByChain(pool, {
    userId: inputs.userId,
  });

  const chainIds = new Set<string>([
    ...Object.keys(feeTotalsByChain),
    ...Object.keys(referralFeeTotalsByChain),
    ...Object.keys(claimedTotalsByChain),
  ]);

  const cashbackByChain: Record<
    string,
    { pending: number; collected: number; claimable: number }
  > = {};
  const referralByChain: Record<string, { pending: number; collected: number }> =
    {};

  let totalCashbackPending = 0;
  let totalCashbackCollected = 0;
  let totalReferralPending = 0;
  let totalReferralCollected = 0;
  let totalClaimable = 0;

  for (const chainId of chainIds) {
    const feeTotals = feeTotalsByChain[chainId] ?? {
      pending: 0,
      collected: 0,
    };
    const referralTotals = referralFeeTotalsByChain[chainId] ?? {
      pending: 0,
      collected: 0,
    };
    const claimed = claimedTotalsByChain[chainId] ?? 0;

    const cashbackPending =
      (feeTotals.pending * cappedCashbackBps) / 10_000;
    const cashbackCollected =
      (feeTotals.collected * cappedCashbackBps) / 10_000;
    const referralPending =
      (referralTotals.pending * cappedBonusBps) / 10_000;
    const referralCollected =
      (referralTotals.collected * cappedBonusBps) / 10_000;

    const totalCollected = cashbackCollected + referralCollected;
    const claimable = Math.max(0, totalCollected - claimed);
    const totalPending = cashbackPending + referralPending;

    cashbackByChain[chainId] = {
      pending: totalPending,
      collected: totalCollected,
      claimable,
    };
    referralByChain[chainId] = {
      pending: referralPending,
      collected: referralCollected,
    };

    totalCashbackPending += cashbackPending;
    totalCashbackCollected += cashbackCollected;
    totalReferralPending += referralPending;
    totalReferralCollected += referralCollected;
    totalClaimable += claimable;
  }

  const totalCollected = totalCashbackCollected + totalReferralCollected;
  const totalPending = totalCashbackPending + totalReferralPending;

  return {
    policy,
    clout: { points },
    tier,
    nextTier,
    progress: { pct: progressPct, remaining },
    cashback: {
      pending: totalPending,
      collected: totalCollected,
      claimable: totalClaimable,
      bps: cappedCashbackBps,
      byChain: cashbackByChain,
    },
    referralBonus: {
      qualifiedCount,
      bonusBps: cappedBonusBps,
      pending: totalReferralPending,
      collected: totalReferralCollected,
      byChain: referralByChain,
    },
  };
}

export async function getRewardsReferrals(
  pool: DbQuery,
  inputs: { userId: string; limit: number; offset: number },
): Promise<{
  referrals: Array<{
    id: string;
    walletAddress: string | null;
    status: string;
    qualifiedAt: Date | null;
    createdAt: Date;
    tier: RewardsTier;
    points: number;
  }>;
  policy: RewardsPolicy;
}> {
  const policy = await getRewardsPolicy(pool);
  await markQualifiedReferralsForUser(pool, {
    userId: inputs.userId,
    threshold: OBSERVER_THRESHOLD,
  });

  const rows = await fetchReferralsForUser(pool, inputs);
  const referrals = rows.map((row) => {
    const tier = resolveTier(row.points, policy.tiers);
    return {
      id: row.id,
      walletAddress: row.wallet_address ?? null,
      status: row.status,
      qualifiedAt: row.qualified_at,
      createdAt: row.created_at,
      points: row.points,
      tier,
    };
  });

  return { referrals, policy };
}

export async function createRewardClaim(
  pool: DbQuery,
  inputs: {
    userId: string;
    walletAddress: string;
    chainId: string;
    amountUsd: number;
  },
): Promise<{ claimId: string }> {
  const claim = await insertRewardClaim(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    chainId: inputs.chainId,
    amountUsd: inputs.amountUsd,
    status: "pending",
  });
  return { claimId: claim.id };
}

export async function getRewardsLeaderboard(
  pool: DbQuery,
  inputs: {
    userId: string;
    metric: RewardsLeaderboardMetric;
    interval: RewardsLeaderboardInterval;
    limit: number;
    offset: number;
  },
): Promise<RewardsLeaderboard> {
  const intervalApplied =
    inputs.metric === "pnl" ? "alltime" : inputs.interval;
  const startAt = resolveLeaderboardStart(intervalApplied);

  const [rows, me] = await Promise.all([
    fetchRewardsLeaderboardRows(pool, {
      metric: inputs.metric,
      startAt,
      limit: inputs.limit,
      offset: inputs.offset,
    }),
    fetchRewardsLeaderboardMe(pool, {
      userId: inputs.userId,
      metric: inputs.metric,
      startAt,
    }),
  ]);

  const entries = rows.map((row) => ({
    ...row,
    isYou: row.userId === inputs.userId,
  }));

  return {
    metric: inputs.metric,
    intervalRequested: inputs.interval,
    intervalApplied,
    entries,
    me: me ? { ...me, isYou: true } : null,
  };
}
