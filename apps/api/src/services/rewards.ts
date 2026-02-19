import { randomBytes } from "node:crypto";
import type { DbQuery } from "../db.js";
import {
  clearUserReferralCodeIfMatches,
  fetchActiveRewardsPolicy,
  fetchClaimedTotalsByChain,
  fetchFeeTotalsByChain,
  fetchInboundReferralForUser,
  fetchQualifiedReferralCount,
  fetchReferralFeeTotalsByChain,
  fetchRewardsLeaderboardMe,
  fetchRewardsLeaderboardRows,
  fetchReferralsForUser,
  fetchUserPoints,
  fetchUserVolume,
  fetchUserReferralCode,
  lockUserReferralCodeByUserId,
  findUserByReferralCode,
  insertReferral,
  insertRewardClaim,
  type RewardsLeaderboardInterval,
  type RewardsLeaderboardMetric,
  type RewardsLeaderboardRow,
  markQualifiedReferralsForUser,
  setUserReferralCode,
} from "../repos/rewards.js";
import {
  normalizeRewardsChainId,
  type RewardsChainId,
} from "../lib/rewards-chain.js";
import {
  parseUsdcToMicroFloor,
  usdcMicroToDecimalString,
} from "../lib/usdc.js";
import {
  resolveRewardsMultiplierAtEvent,
  type RewardsMultiplierSource,
} from "./rewards-multiplier.js";

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

type ChainFeeTotalsRaw = Record<string, { pending: string; collected: string }>;
type ChainClaimedTotalsRaw = Record<string, string>;

function parseMicro(value: string): bigint {
  const parsed = parseUsdcToMicroFloor(value);
  return parsed ?? 0n;
}

function microToNumber(value: bigint): number {
  return Number(usdcMicroToDecimalString(value));
}

function maxMicro(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function clampBps(value: number, max = 10_000): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

function maxBps(values: number[]): number {
  if (!values.length) return 0;
  return Math.max(...values.map((value) => (Number.isFinite(value) ? value : 0)));
}

export function resolveEffectiveBps(
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

export type ReferralAttachmentStatus =
  | "attached"
  | "already_attached"
  | "invalid_code"
  | "not_found"
  | "self_referral";

export type ReferralAttachmentState = {
  hasReferrer: boolean;
  code: string | null;
  status: "pending" | "qualified" | "blocked" | null;
  linkedAt: Date | null;
  qualifiedAt: Date | null;
  referrer: {
    userId: string;
    username: string | null;
    displayName: string | null;
  } | null;
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

function emptyReferralAttachmentState(): ReferralAttachmentState {
  return {
    hasReferrer: false,
    code: null,
    status: null,
    linkedAt: null,
    qualifiedAt: null,
    referrer: null,
  };
}

async function buildReferralAttachmentState(
  pool: DbQuery,
  userId: string,
): Promise<ReferralAttachmentState> {
  const row = await fetchInboundReferralForUser(pool, userId);
  if (!row) return emptyReferralAttachmentState();
  const status =
    row.status === "pending" || row.status === "qualified" || row.status === "blocked"
      ? row.status
      : null;
  return {
    hasReferrer: true,
    code: row.code,
    status,
    linkedAt: row.linked_at,
    qualifiedAt: row.qualified_at,
    referrer: {
      userId: row.referrer_user_id,
      username: row.referrer_username,
      displayName: row.referrer_display_name,
    },
  };
}

function createReferralCodeError(
  statusCode: number,
  message: string,
): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: unknown }).code === "23505";
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

export async function getReferralAttachmentStatus(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<ReferralAttachmentState> {
  return buildReferralAttachmentState(pool, inputs.userId);
}

export async function attachReferralCodeForExistingUser(
  pool: DbQuery,
  inputs: { userId: string; referralCode: string },
): Promise<{
  status: ReferralAttachmentStatus;
  referral: ReferralAttachmentState;
}> {
  const existing = await buildReferralAttachmentState(pool, inputs.userId);
  if (existing.hasReferrer) {
    return { status: "already_attached", referral: existing };
  }

  const normalized = normalizeReferralCode(inputs.referralCode);
  if (!normalized) {
    return {
      status: "invalid_code",
      referral: existing,
    };
  }

  const referrer = await findUserByReferralCode(pool, normalized);
  if (!referrer) {
    return {
      status: "not_found",
      referral: existing,
    };
  }

  if (referrer.id === inputs.userId) {
    return {
      status: "self_referral",
      referral: existing,
    };
  }

  const inserted = await insertReferral(pool, {
    referrerUserId: referrer.id,
    referredUserId: inputs.userId,
    code: normalized,
    status: "pending",
  });

  const current = await buildReferralAttachmentState(pool, inputs.userId);
  return {
    status: inserted ? "attached" : "already_attached",
    referral: current,
  };
}

export async function setReferralCodeForUser(
  pool: DbQuery,
  inputs: {
    userId: string;
    referralCode: string;
    forceTransfer?: boolean;
  },
): Promise<{ code: string; transferredFromUserId: string | null }> {
  const normalized = normalizeReferralCode(inputs.referralCode);
  if (!normalized) {
    throw createReferralCodeError(400, "Invalid referral code");
  }

  const targetId = inputs.userId;
  const preOwner = await findUserByReferralCode(pool, normalized);
  const lockIds = Array.from(
    new Set([targetId, ...(preOwner?.id && preOwner.id !== targetId ? [preOwner.id] : [])]),
  ).sort((a, b) => a.localeCompare(b));

  let targetExists = false;
  for (const userId of lockIds) {
    const row = await lockUserReferralCodeByUserId(pool, userId);
    if (userId === targetId && row) {
      targetExists = true;
    }
  }

  if (!targetExists) {
    throw createReferralCodeError(404, "User not found");
  }

  const owner = await findUserByReferralCode(pool, normalized);
  const ownerId = owner?.id ?? null;

  if (ownerId && ownerId !== targetId && !inputs.forceTransfer) {
    throw createReferralCodeError(409, "Referral code already taken");
  }

  if (ownerId && ownerId !== targetId && !lockIds.includes(ownerId)) {
    throw createReferralCodeError(
      409,
      "Referral code changed during update, retry",
    );
  }

  let transferredFromUserId: string | null = null;
  if (ownerId && ownerId !== targetId) {
    const cleared = await clearUserReferralCodeIfMatches(pool, ownerId, normalized);
    if (cleared) {
      transferredFromUserId = ownerId;
    }
  }

  try {
    await setUserReferralCode(pool, targetId, normalized);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw createReferralCodeError(409, "Referral code already taken");
    }
    throw error;
  }

  return {
    code: normalized,
    transferredFromUserId,
  };
}

export function computeCashbackBreakdown(inputs: {
  feeTotalsByChain: ChainFeeTotalsRaw;
  referralFeeTotalsByChain: ChainFeeTotalsRaw;
  claimedTotalsByChain: ChainClaimedTotalsRaw;
}) {
  type ChainRollup = {
    feePending: bigint;
    feeCollected: bigint;
    referralPending: bigint;
    referralCollected: bigint;
    claimed: bigint;
  };

  const byChain = new Map<RewardsChainId, ChainRollup>();
  const ensureChain = (chainId: RewardsChainId): ChainRollup => {
    const existing = byChain.get(chainId);
    if (existing) return existing;
    const created: ChainRollup = {
      feePending: 0n,
      feeCollected: 0n,
      referralPending: 0n,
      referralCollected: 0n,
      claimed: 0n,
    };
    byChain.set(chainId, created);
    return created;
  };

  for (const [chainId, values] of Object.entries(inputs.feeTotalsByChain)) {
    const canonicalChainId = normalizeRewardsChainId(chainId);
    if (!canonicalChainId) continue;
    const bucket = ensureChain(canonicalChainId);
    bucket.feePending += parseMicro(values.pending);
    bucket.feeCollected += parseMicro(values.collected);
  }

  for (const [chainId, values] of Object.entries(inputs.referralFeeTotalsByChain)) {
    const canonicalChainId = normalizeRewardsChainId(chainId);
    if (!canonicalChainId) continue;
    const bucket = ensureChain(canonicalChainId);
    bucket.referralPending += parseMicro(values.pending);
    bucket.referralCollected += parseMicro(values.collected);
  }

  for (const [chainId, claimed] of Object.entries(inputs.claimedTotalsByChain)) {
    const canonicalChainId = normalizeRewardsChainId(chainId);
    if (!canonicalChainId) continue;
    const bucket = ensureChain(canonicalChainId);
    bucket.claimed += parseMicro(claimed);
  }

  const cashbackByChain: Record<
    string,
    { pending: number; collected: number; claimable: number }
  > = {};
  const referralByChain: Record<string, { pending: number; collected: number }> =
    {};
  const claimableByChainMicro: Record<string, bigint> = {};

  let totalCashbackPendingMicro = 0n;
  let totalCashbackCollectedMicro = 0n;
  let totalReferralPendingMicro = 0n;
  let totalReferralCollectedMicro = 0n;
  let totalClaimableMicro = 0n;

  for (const [chainId, bucket] of byChain.entries()) {
    const feePendingMicro = bucket.feePending;
    const feeCollectedMicro = bucket.feeCollected;
    const referralPendingSourceMicro = bucket.referralPending;
    const referralCollectedSourceMicro = bucket.referralCollected;
    const claimedMicro = bucket.claimed;

    const cashbackPendingMicro = feePendingMicro;
    const cashbackCollectedMicro = feeCollectedMicro;
    const referralPendingMicro = referralPendingSourceMicro;
    const referralCollectedMicro = referralCollectedSourceMicro;

    const totalCollectedMicro = cashbackCollectedMicro + referralCollectedMicro;
    const claimableMicro = maxMicro(totalCollectedMicro - claimedMicro);
    const totalPendingMicro = cashbackPendingMicro + referralPendingMicro;

    cashbackByChain[chainId] = {
      pending: microToNumber(totalPendingMicro),
      collected: microToNumber(totalCollectedMicro),
      claimable: microToNumber(claimableMicro),
    };
    referralByChain[chainId] = {
      pending: microToNumber(referralPendingMicro),
      collected: microToNumber(referralCollectedMicro),
    };
    claimableByChainMicro[chainId] = claimableMicro;

    totalCashbackPendingMicro += cashbackPendingMicro;
    totalCashbackCollectedMicro += cashbackCollectedMicro;
    totalReferralPendingMicro += referralPendingMicro;
    totalReferralCollectedMicro += referralCollectedMicro;
    totalClaimableMicro += claimableMicro;
  }

  return {
    cashbackByChain,
    referralByChain,
    claimableByChainMicro,
    totalPending: microToNumber(totalCashbackPendingMicro + totalReferralPendingMicro),
    totalCollected: microToNumber(
      totalCashbackCollectedMicro + totalReferralCollectedMicro,
    ),
    totalClaimable: microToNumber(totalClaimableMicro),
    totalReferralPending: microToNumber(totalReferralPendingMicro),
    totalReferralCollected: microToNumber(totalReferralCollectedMicro),
  };
}

export async function getRewardsSummary(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<{
  policy: RewardsPolicy;
  clout: { points: number; volumeUsd: number };
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
  multiplier: {
    value: number;
    source: RewardsMultiplierSource;
    asOf: Date;
  };
}> {
  // Summary stays read-only; reconciliation/qualification mutations are handled outside this path.
  const policy = await getRewardsPolicy(pool);

  const [points, volumeUsd] = await Promise.all([
    fetchUserPoints(pool, inputs.userId),
    fetchUserVolume(pool, inputs.userId),
  ]);
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
  const multiplierAsOf = new Date();
  const multiplier = await resolveRewardsMultiplierAtEvent(pool, {
    userId: inputs.userId,
    eventTime: multiplierAsOf,
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
  const computed = computeCashbackBreakdown({
    feeTotalsByChain,
    referralFeeTotalsByChain,
    claimedTotalsByChain,
  });

  return {
    policy,
    clout: { points, volumeUsd },
    tier,
    nextTier,
    progress: { pct: progressPct, remaining },
    cashback: {
      pending: computed.totalPending,
      collected: computed.totalCollected,
      claimable: computed.totalClaimable,
      bps: cappedCashbackBps,
      byChain: computed.cashbackByChain,
    },
    referralBonus: {
      qualifiedCount,
      bonusBps: cappedBonusBps,
      pending: computed.totalReferralPending,
      collected: computed.totalReferralCollected,
      byChain: computed.referralByChain,
    },
    multiplier: {
      value: multiplier.multiplierApplied,
      source: multiplier.multiplierSource,
      asOf: multiplierAsOf,
    },
  };
}

export async function getRewardsClaimableByChainMicro(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<Record<string, bigint>> {
  const [feeTotalsByChain, referralFeeTotalsByChain, claimedTotalsByChain] =
    await Promise.all([
      fetchFeeTotalsByChain(pool, { userId: inputs.userId }),
      fetchReferralFeeTotalsByChain(pool, { userId: inputs.userId }),
      fetchClaimedTotalsByChain(pool, { userId: inputs.userId }),
    ]);

  return computeCashbackBreakdown({
    feeTotalsByChain,
    referralFeeTotalsByChain,
    claimedTotalsByChain,
  }).claimableByChainMicro;
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
    amountUsd: string;
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
