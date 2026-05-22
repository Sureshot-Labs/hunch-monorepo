import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { DbQuery } from "../db.js";
import {
  clearUserReferralCodeIfMatches,
  countReferralsForReferralCode,
  createCampaignReferralCode,
  ensureUserReferralCodePolicy,
  fetchActiveRewardsPolicy,
  fetchClaimedTotalsByChain,
  fetchFeeTotalsByChain,
  fetchInboundReferralForUser,
  findActiveReferralCodeForAttach,
  findReferralCodeByCode,
  fetchUserTutorialDismissal,
  fetchQualifiedReferralCount,
  fetchReferralFeeTotalsByChain,
  fetchRewardsLeaderboardMe,
  fetchRewardsLeaderboardRows,
  fetchReferralsForUser,
  fetchReferralsForReferralCode,
  fetchUserPoints,
  fetchUserQualificationPoints,
  fetchUserTierPoints,
  fetchUserVolume,
  fetchUserReferralCode,
  insertExactManualVolumeEvent,
  insertExactReferralCodeDropEvent,
  insertReferralCodeAlias,
  lockUserReferralCodeByUserId,
  insertReferral,
  insertRewardClaim,
  listReferralCodes,
  retireActiveUserReferralCodes,
  retireReferralCodeForUsageLimit,
  updateReferralCodePolicy,
  type RewardsManualFilterMode,
  type RewardsLeaderboardInterval,
  type RewardsLeaderboardMetric,
  type RewardsLeaderboardRow,
  type RewardsReferralsSortBy,
  type RewardsReferralsSortDir,
  type ReferralCodeListRow,
  type ReferralCodePolicyType,
  type ReferralCodeUsageLimitFilter,
  REFERRAL_CODE_TIER_DROP_SOURCE_PREFIX,
  REFERRAL_CODE_VISIBLE_DROP_SOURCE_PREFIX,
  markQualifiedReferralsForUser,
  setUserReferralCode,
  upsertUserTutorialDismissal,
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

const REFERRAL_CODE_MIN_LENGTH = 3;
const REFERRAL_CODE_MAX_LENGTH = 10;
const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ONBOARDING_SHARE_BONUS_SOURCE_ID = "manual:onboarding-share-v1";
const ONBOARDING_SHARE_BONUS_POINTS = 200;
const ONBOARDING_SHARE_BONUS_SOURCE_TYPE = "execution";
const ONBOARDING_SHARE_BONUS_VENUE = "growth";

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

function resolveEffectiveReferralStatus(inputs: {
  storedStatus: string;
  referrerPoints: number;
  referredPoints: number;
  threshold: number;
}): string {
  if (inputs.storedStatus === "blocked") return "blocked";
  return inputs.referrerPoints >= inputs.threshold &&
    inputs.referredPoints >= inputs.threshold
    ? "qualified"
    : "pending";
}

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
  return Math.max(
    ...values.map((value) => (Number.isFinite(value) ? value : 0)),
  );
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

export type RewardsLeaderboardEntry = RewardsLeaderboardRow & {
  isYou: boolean;
};

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
  referralCode: {
    id: string;
    policyId: string;
    policyType: ReferralCodePolicyType;
    label: string | null;
    multiplierOverride: number | null;
    ownerUserId: string | null;
  } | null;
};

export type InboundReferralSummary = {
  code: string;
  referralCodeId: string | null;
  policyType: ReferralCodePolicyType | null;
  label: string | null;
  multiplierOverride: number | null;
  ownerUserId: string | null;
  status: string;
  attachedAt: Date;
};

export type RewardsTutorialState = {
  dismissedAt: Date | null;
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
  if (!Array.isArray(raw.tiers) || !Array.isArray(raw.referral_bonus))
    return null;

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

export function normalizeReferralCode(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  const sanitized = upper.replace(/[^A-Z0-9]/g, "");
  if (
    sanitized.length < REFERRAL_CODE_MIN_LENGTH ||
    sanitized.length > REFERRAL_CODE_MAX_LENGTH
  ) {
    return null;
  }
  return sanitized;
}

function emptyReferralAttachmentState(): ReferralAttachmentState {
  return {
    hasReferrer: false,
    code: null,
    status: null,
    linkedAt: null,
    qualifiedAt: null,
    referrer: null,
    referralCode: null,
  };
}

function buildInboundReferralSummary(
  row: Awaited<ReturnType<typeof fetchInboundReferralForUser>>,
): InboundReferralSummary | null {
  if (!row) return null;
  return {
    code: row.code,
    referralCodeId: row.referral_code_id,
    policyType: row.policy_type,
    label: row.policy_label,
    multiplierOverride:
      row.policy_multiplier_override == null
        ? null
        : Number(row.policy_multiplier_override),
    ownerUserId: row.policy_owner_user_id,
    status: row.status,
    attachedAt: row.linked_at,
  };
}

async function buildReferralAttachmentState(
  pool: DbQuery,
  userId: string,
): Promise<ReferralAttachmentState> {
  const row = await fetchInboundReferralForUser(pool, userId);
  if (!row) return emptyReferralAttachmentState();
  const status =
    row.status === "pending" ||
    row.status === "qualified" ||
    row.status === "blocked"
      ? row.status
      : null;
  return {
    hasReferrer: true,
    code: row.code,
    status,
    linkedAt: row.linked_at,
    qualifiedAt: row.qualified_at,
    referrer: row.referrer_user_id
      ? {
          userId: row.referrer_user_id,
          username: row.referrer_username,
          displayName: row.referrer_display_name,
        }
      : null,
    referralCode:
      row.referral_code_id && row.policy_id && row.policy_type
        ? {
            id: row.referral_code_id,
            policyId: row.policy_id,
            policyType: row.policy_type,
            label: row.policy_label,
            multiplierOverride:
              row.policy_multiplier_override == null
                ? null
                : Number(row.policy_multiplier_override),
            ownerUserId: row.policy_owner_user_id,
          }
        : null,
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
  if (existing) {
    const normalizedExisting = normalizeReferralCode(existing);
    if (normalizedExisting) {
      const policy = await ensureUserReferralCodePolicy(pool, userId);
      const registered = await findReferralCodeByCode(pool, normalizedExisting);
      if (!registered) {
        await insertReferralCodeAlias(pool, {
          code: normalizedExisting,
          policyId: policy.id,
          isActive: true,
        });
      }
    }
    return existing;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode();
    const found = await findReferralCodeByCode(pool, code);
    if (found) continue;
    await setReferralCodeForUser(pool, {
      userId,
      referralCode: code,
      forceTransfer: false,
    });
    return code;
  }

  const fallback = `${generateReferralCode()}${Math.floor(Date.now() / 1000)}`;
  const truncated = fallback.slice(0, REFERRAL_CODE_MAX_LENGTH);
  await setReferralCodeForUser(pool, {
    userId,
    referralCode: truncated,
    forceTransfer: false,
  });
  return truncated;
}

async function grantReferralCodeDrops(
  pool: DbQuery,
  inputs: {
    userId: string;
    referralId: string;
    visibleDropPoints: number;
    tierDropPoints: number;
  },
): Promise<void> {
  if (
    Number.isFinite(inputs.visibleDropPoints) &&
    inputs.visibleDropPoints > 0
  ) {
    await insertExactReferralCodeDropEvent(pool, {
      userId: inputs.userId,
      sourceId: `${REFERRAL_CODE_VISIBLE_DROP_SOURCE_PREFIX}${inputs.referralId}`,
      points: inputs.visibleDropPoints,
    });
  }
  if (Number.isFinite(inputs.tierDropPoints) && inputs.tierDropPoints > 0) {
    await insertExactReferralCodeDropEvent(pool, {
      userId: inputs.userId,
      sourceId: `${REFERRAL_CODE_TIER_DROP_SOURCE_PREFIX}${inputs.referralId}`,
      points: inputs.tierDropPoints,
    });
  }
}

async function insertReferralWithUsageLimit(
  pool: DbQuery,
  inputs: { userId: string; referralCode: string },
): Promise<{
  status: "attached" | "already_attached" | "not_found" | "self_referral";
  referralCode: Awaited<ReturnType<typeof findActiveReferralCodeForAttach>> | null;
  referralId: string | null;
}> {
  const referralCode = await findActiveReferralCodeForAttach(
    pool,
    inputs.referralCode,
    { lockForUpdate: true },
  );
  if (!referralCode) {
    return { status: "not_found", referralCode: null, referralId: null };
  }
  if (
    referralCode.policy_type === "user" &&
    referralCode.owner_user_id === inputs.userId
  ) {
    return { status: "self_referral", referralCode, referralId: null };
  }

  const maxUses =
    referralCode.max_uses == null ? null : Number(referralCode.max_uses);
  const currentUses =
    maxUses == null
      ? 0
      : await countReferralsForReferralCode(pool, referralCode.referral_code_id);
  if (maxUses != null && currentUses >= maxUses) {
    await retireReferralCodeForUsageLimit(pool, referralCode.referral_code_id);
    return { status: "not_found", referralCode, referralId: null };
  }

  const inserted = await insertReferral(pool, {
    referrerUserId:
      referralCode.policy_type === "user" ? referralCode.owner_user_id : null,
    referredUserId: inputs.userId,
    code: referralCode.code,
    referralCodeId: referralCode.referral_code_id,
    status: "pending",
  });
  if (!inserted.inserted || !inserted.id) {
    return { status: "already_attached", referralCode, referralId: null };
  }

  if (maxUses != null && currentUses + 1 >= maxUses) {
    await retireReferralCodeForUsageLimit(pool, referralCode.referral_code_id);
  }

  return { status: "attached", referralCode, referralId: inserted.id };
}

export async function attachReferralCode(
  pool: DbQuery,
  inputs: { userId: string; referralCode: string },
): Promise<void> {
  const normalized = normalizeReferralCode(inputs.referralCode);
  if (!normalized) return;

  const attached = await insertReferralWithUsageLimit(pool, {
    userId: inputs.userId,
    referralCode: normalized,
  });
  if (attached.status === "attached" && attached.referralId) {
    await grantReferralCodeDrops(pool, {
      userId: inputs.userId,
      referralId: attached.referralId,
      visibleDropPoints: Number(
        attached.referralCode?.visible_drop_points ?? 0,
      ),
      tierDropPoints: Number(attached.referralCode?.tier_drop_points ?? 0),
    });
  }
}

export async function getReferralAttachmentStatus(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<ReferralAttachmentState> {
  return buildReferralAttachmentState(pool, inputs.userId);
}

export async function getRewardsTutorialState(
  pool: DbQuery,
  inputs: { userId: string; tutorialKey: string },
): Promise<RewardsTutorialState> {
  const row = await fetchUserTutorialDismissal(pool, inputs);
  return {
    dismissedAt: row?.dismissed_at ?? null,
  };
}

export async function dismissRewardsTutorial(
  pool: DbQuery,
  inputs: { userId: string; tutorialKey: string },
): Promise<RewardsTutorialState> {
  const row = await upsertUserTutorialDismissal(pool, inputs);
  return {
    dismissedAt: row.dismissed_at,
  };
}

export async function claimOnboardingShareBonus(
  pool: Pool,
  inputs: { userId: string; walletAddress: string | null },
): Promise<{
  granted: boolean;
  alreadyGranted: boolean;
  pointsAwarded: number;
}> {
  const inserted = await insertExactManualVolumeEvent(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: ONBOARDING_SHARE_BONUS_VENUE,
    sourceType: ONBOARDING_SHARE_BONUS_SOURCE_TYPE,
    sourceId: ONBOARDING_SHARE_BONUS_SOURCE_ID,
    points: ONBOARDING_SHARE_BONUS_POINTS,
    createdAt: new Date(),
  });

  return {
    granted: inserted.inserted,
    alreadyGranted: !inserted.inserted,
    pointsAwarded: ONBOARDING_SHARE_BONUS_POINTS,
  };
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

  const attached = await insertReferralWithUsageLimit(pool, {
    userId: inputs.userId,
    referralCode: normalized,
  });
  if (attached.status === "not_found") {
    return {
      status: "not_found",
      referral: existing,
    };
  }
  if (attached.status === "self_referral") {
    return {
      status: "self_referral",
      referral: existing,
    };
  }

  if (attached.status === "attached" && attached.referralId) {
    await grantReferralCodeDrops(pool, {
      userId: inputs.userId,
      referralId: attached.referralId,
      visibleDropPoints: Number(
        attached.referralCode?.visible_drop_points ?? 0,
      ),
      tierDropPoints: Number(attached.referralCode?.tier_drop_points ?? 0),
    });
  }

  const current = await buildReferralAttachmentState(pool, inputs.userId);
  return {
    status: attached.status === "attached" ? "attached" : "already_attached",
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
  const preCode = await findReferralCodeByCode(pool, normalized);
  const preOwnerId =
    preCode?.policy_type === "user" ? preCode.owner_user_id : null;
  const lockIds = Array.from(
    new Set([
      targetId,
      ...(preOwnerId && preOwnerId !== targetId ? [preOwnerId] : []),
    ]),
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

  const codeRow = await findReferralCodeByCode(pool, normalized);
  const ownerId =
    codeRow?.policy_type === "user" ? codeRow.owner_user_id : null;

  if (codeRow) {
    if (!codeRow.is_active || codeRow.retired_at) {
      throw createReferralCodeError(409, "Referral code is retired");
    }
    if (codeRow.policy_type === "campaign") {
      throw createReferralCodeError(409, "Referral code is reserved");
    }
  }

  if (ownerId && ownerId !== targetId && !lockIds.includes(ownerId)) {
    throw createReferralCodeError(
      409,
      "Referral code changed during update, retry",
    );
  }

  let transferredFromUserId: string | null = null;
  if (codeRow && ownerId === targetId) {
    await setUserReferralCode(pool, targetId, normalized);
    return {
      code: normalized,
      transferredFromUserId: null,
    };
  }

  if (codeRow && ownerId && ownerId !== targetId) {
    if (!inputs.forceTransfer) {
      throw createReferralCodeError(409, "Referral code already taken");
    }
    const historicalReferrals = await countReferralsForReferralCode(
      pool,
      codeRow.referral_code_id,
    );
    if (historicalReferrals > 0) {
      throw createReferralCodeError(
        409,
        "Referral code has historical referrals and cannot be transferred",
      );
    }
    const targetPolicy = await ensureUserReferralCodePolicy(pool, targetId);
    await retireActiveUserReferralCodes(pool, targetId, "user_code_changed");
    const cleared = await clearUserReferralCodeIfMatches(
      pool,
      ownerId,
      normalized,
    );
    if (cleared) {
      transferredFromUserId = ownerId;
    }
    await pool.query(
      `
        update referral_codes
        set policy_id = $2,
            is_active = true,
            retired_at = null,
            retired_reason = null
        where id = $1
      `,
      [codeRow.referral_code_id, targetPolicy.id],
    );
    await setUserReferralCode(pool, targetId, normalized);
    return {
      code: normalized,
      transferredFromUserId,
    };
  }

  try {
    const targetPolicy = await ensureUserReferralCodePolicy(pool, targetId);
    await retireActiveUserReferralCodes(pool, targetId, "user_code_changed");
    await insertReferralCodeAlias(pool, {
      code: normalized,
      policyId: targetPolicy.id,
      isActive: true,
    });
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

function mapReferralCodeListRow(row: ReferralCodeListRow) {
  const uses = Number(row.referral_count ?? 0);
  const maxUses = row.max_uses == null ? null : Number(row.max_uses);
  return {
    id: row.referral_code_id,
    code: row.code,
    isActive: row.is_active,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    maxUses,
    uses,
    remainingUses: maxUses == null ? null : Math.max(0, maxUses - uses),
    policy: {
      id: row.policy_id,
      type: row.policy_type,
      label: row.label,
      multiplierOverride:
        row.multiplier_override == null
          ? null
          : Number(row.multiplier_override),
      visibleDropPoints: Number(row.visible_drop_points ?? 0),
      tierDropPoints: Number(row.tier_drop_points ?? 0),
      ownerUserId: row.owner_user_id,
      owner:
        row.owner_user_id != null
          ? {
              id: row.owner_user_id,
              email: row.owner_email,
              username: row.owner_username,
              displayName: row.owner_display_name,
            }
          : null,
    },
    referralCount: uses,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAdminReferralCodes(
  pool: DbQuery,
  inputs: {
    q?: string | null;
    policyType?: ReferralCodePolicyType | null;
    active?: boolean | null;
    usageLimit?: ReferralCodeUsageLimitFilter | null;
    limit: number;
    offset: number;
  },
) {
  const result = await listReferralCodes(pool, inputs);
  return {
    total: result.total,
    items: result.rows.map(mapReferralCodeListRow),
  };
}

export async function getAdminReferralCodeReferralsByCode(
  pool: DbQuery,
  inputs: {
    code: string;
    limit: number;
    offset: number;
  },
) {
  const normalized = normalizeReferralCode(inputs.code);
  if (!normalized) {
    throw createReferralCodeError(400, "Invalid referral code");
  }

  const row = await findReferralCodeByCode(pool, normalized);
  if (!row) return null;

  const [total, referrals] = await Promise.all([
    countReferralsForReferralCode(pool, row.referral_code_id),
    fetchReferralsForReferralCode(pool, {
      referralCodeId: row.referral_code_id,
      limit: inputs.limit,
      offset: inputs.offset,
    }),
  ]);

  return {
    code: mapReferralCodeListRow({
      ...row,
      owner_email: null,
      owner_username: null,
      owner_display_name: null,
      referral_count: String(total),
    }),
    referrals: referrals.map((referral) => ({
      id: referral.id,
      referredUserId: referral.referred_user_id,
      email: referral.email,
      username: referral.username,
      displayName: referral.display_name,
      primaryWallet: referral.primary_wallet,
      status: referral.status,
      qualifiedAt: referral.qualified_at,
      attachedAt: referral.attached_at,
      publicPoints: Number(referral.public_points ?? 0),
      tierPoints: Number(referral.tier_points ?? 0),
      qualificationPoints: Number(referral.qualification_points ?? 0),
      referralBonus: Number(referral.referral_bonus ?? 0),
    })),
    total,
  };
}

export async function createAdminCampaignReferralCode(
  pool: DbQuery,
  inputs: {
    code: string;
    label?: string | null;
    multiplierOverride?: number | null;
    visibleDropPoints?: number | null;
    tierDropPoints?: number | null;
    maxUses?: number | null;
  },
) {
  const normalized = normalizeReferralCode(inputs.code);
  if (!normalized) {
    throw createReferralCodeError(400, "Invalid referral code");
  }
  const existing = await findReferralCodeByCode(pool, normalized);
  if (existing) {
    throw createReferralCodeError(409, "Referral code is reserved");
  }
  const row = await createCampaignReferralCode(pool, {
    code: normalized,
    label: inputs.label,
    multiplierOverride: inputs.multiplierOverride,
    visibleDropPoints: inputs.visibleDropPoints,
    tierDropPoints: inputs.tierDropPoints,
    maxUses: inputs.maxUses,
  });
  return mapReferralCodeListRow({
    ...row,
    owner_email: null,
    owner_username: null,
    owner_display_name: null,
    referral_count: "0",
  });
}

export async function updateAdminReferralCodePolicy(
  pool: DbQuery,
  inputs: {
    referralCodeId: string;
    label?: string | null;
    multiplierOverride?: number | null;
    visibleDropPoints?: number | null;
    tierDropPoints?: number | null;
    maxUses?: number | null;
    deactivate?: boolean;
    reactivate?: boolean;
  },
) {
  const current = await pool.query<ReferralCodeListRow>(
    `
      select
        rc.id as referral_code_id,
        rc.code,
        rc.is_active,
        rc.retired_at,
        rc.retired_reason,
        rc.max_uses,
        p.id as policy_id,
        p.policy_type,
        p.owner_user_id,
        p.label,
        p.multiplier_override::text as multiplier_override,
        p.visible_drop_points::text as visible_drop_points,
        p.tier_drop_points::text as tier_drop_points,
        rc.created_at,
        rc.updated_at,
        u.email as owner_email,
        u.username as owner_username,
        u.display_name as owner_display_name,
        (
          select count(*)::text
          from referrals r
          where r.referral_code_id = rc.id
        ) as referral_count
      from referral_codes rc
      join referral_code_policies p
        on p.id = rc.policy_id
      left join users u
        on u.id = p.owner_user_id
      where rc.id = $1
      limit 1
    `,
    [inputs.referralCodeId],
  );
  const currentRow = current.rows[0];
  if (!currentRow) {
    throw createReferralCodeError(404, "Referral code not found");
  }
  if (inputs.deactivate && currentRow.policy_type !== "campaign") {
    throw createReferralCodeError(
      400,
      "Only campaign codes can be deactivated",
    );
  }
  if (inputs.reactivate && currentRow.policy_type !== "campaign") {
    throw createReferralCodeError(
      400,
      "Only campaign codes can be reactivated",
    );
  }
  if (inputs.deactivate && inputs.reactivate) {
    throw createReferralCodeError(
      400,
      "Referral code cannot be deactivated and reactivated in one request",
    );
  }
  if (inputs.maxUses !== undefined && currentRow.policy_type !== "campaign") {
    throw createReferralCodeError(400, "Only campaign codes can be limited");
  }
  const currentUses = Number(currentRow.referral_count ?? 0);
  const effectiveMaxUses =
    inputs.maxUses === undefined
      ? currentRow.max_uses == null
        ? null
        : Number(currentRow.max_uses)
      : inputs.maxUses;
  if (effectiveMaxUses != null && effectiveMaxUses < currentUses) {
    throw createReferralCodeError(
      400,
      "Usage limit cannot be lower than current uses",
    );
  }
  if (
    inputs.reactivate &&
    effectiveMaxUses != null &&
    effectiveMaxUses <= currentUses
  ) {
    throw createReferralCodeError(
      400,
      "Usage limit must be higher than current uses to reactivate",
    );
  }

  const updated = await updateReferralCodePolicy(pool, {
    referralCodeId: inputs.referralCodeId,
    label: inputs.label,
    multiplierOverride: inputs.multiplierOverride,
    visibleDropPoints: inputs.visibleDropPoints,
    tierDropPoints: inputs.tierDropPoints,
    maxUses: inputs.maxUses,
    deactivateCampaign: inputs.deactivate,
    reactivateCampaign: inputs.reactivate,
  });
  if (!updated) {
    throw createReferralCodeError(404, "Referral code not found");
  }

  return mapReferralCodeListRow({
    ...updated,
    owner_email: currentRow.owner_email,
    owner_username: currentRow.owner_username,
    owner_display_name: currentRow.owner_display_name,
    referral_count: currentRow.referral_count,
  });
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

  for (const [chainId, values] of Object.entries(
    inputs.referralFeeTotalsByChain,
  )) {
    const canonicalChainId = normalizeRewardsChainId(chainId);
    if (!canonicalChainId) continue;
    const bucket = ensureChain(canonicalChainId);
    bucket.referralPending += parseMicro(values.pending);
    bucket.referralCollected += parseMicro(values.collected);
  }

  for (const [chainId, claimed] of Object.entries(
    inputs.claimedTotalsByChain,
  )) {
    const canonicalChainId = normalizeRewardsChainId(chainId);
    if (!canonicalChainId) continue;
    const bucket = ensureChain(canonicalChainId);
    bucket.claimed += parseMicro(claimed);
  }

  const cashbackByChain: Record<
    string,
    { pending: number; collected: number; claimable: number }
  > = {};
  const referralByChain: Record<
    string,
    { pending: number; collected: number }
  > = {};
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
    totalPending: microToNumber(
      totalCashbackPendingMicro + totalReferralPendingMicro,
    ),
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
  clout: {
    points: number;
    tierPoints: number;
    qualificationPoints: number;
    volumeUsd: number;
  };
  tier: RewardsTier;
  nextTier: RewardsTier | null;
  progress: { pct: number; remaining: number | null };
  cashback: {
    pending: number;
    collected: number;
    claimable: number;
    bps: number;
    byChain: Record<
      string,
      { pending: number; collected: number; claimable: number }
    >;
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
    label: string | null;
    asOf: Date;
    referralCode: {
      code: string;
      label: string | null;
      policyType: ReferralCodePolicyType;
    } | null;
  };
  inboundReferral: InboundReferralSummary | null;
}> {
  // Summary stays read-only; reconciliation/qualification mutations are handled outside this path.
  const policy = await getRewardsPolicy(pool);

  const [points, tierPoints, qualificationPoints, volumeUsd] =
    await Promise.all([
      fetchUserPoints(pool, inputs.userId),
      fetchUserTierPoints(pool, inputs.userId),
      fetchUserQualificationPoints(pool, inputs.userId),
      fetchUserVolume(pool, inputs.userId),
    ]);
  const tier = resolveTier(tierPoints, policy.tiers);
  const nextTier = resolveNextTier(tierPoints, policy.tiers);
  const progressPct = nextTier
    ? Math.min(
        1,
        Math.max(
          0,
          (tierPoints - tier.points) / (nextTier.points - tier.points),
        ),
      )
    : 1;
  const remaining = nextTier ? Math.max(0, nextTier.points - tierPoints) : null;

  const feeTotalsByChain = await fetchFeeTotalsByChain(pool, {
    userId: inputs.userId,
  });
  const multiplierAsOf = new Date();
  const multiplier = await resolveRewardsMultiplierAtEvent(pool, {
    userId: inputs.userId,
    eventTime: multiplierAsOf,
  });
  const inboundReferral = buildInboundReferralSummary(
    await fetchInboundReferralForUser(pool, inputs.userId),
  );
  const qualifiedCount = await fetchQualifiedReferralCount(pool, {
    userId: inputs.userId,
    threshold: OBSERVER_THRESHOLD,
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
    clout: { points, tierPoints, qualificationPoints, volumeUsd },
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
      label: multiplier.label?.trim() || null,
      asOf: multiplierAsOf,
      referralCode: multiplier.referralCodeContext
        ? {
            code: multiplier.referralCodeContext.code,
            label: multiplier.referralCodeContext.label,
            policyType: multiplier.referralCodeContext.policyType,
          }
        : null,
    },
    inboundReferral,
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
  inputs: {
    userId: string;
    sortBy: RewardsReferralsSortBy;
    sortDir: RewardsReferralsSortDir;
    limit: number;
    offset: number;
  },
): Promise<{
  referrals: Array<{
    id: string;
    walletAddress: string | null;
    status: string;
    qualifiedAt: Date | null;
    createdAt: Date;
    tier: RewardsTier;
    points: number;
    bonus: number;
  }>;
  policy: RewardsPolicy;
}> {
  const [policy, referrerQualificationPoints] = await Promise.all([
    getRewardsPolicy(pool),
    fetchUserQualificationPoints(pool, inputs.userId),
  ]);
  await markQualifiedReferralsForUser(pool, {
    userId: inputs.userId,
    threshold: OBSERVER_THRESHOLD,
  });

  const rows = await fetchReferralsForUser(pool, inputs);
  const referrals = rows.map((row) => {
    const tier = resolveTier(row.tierPoints, policy.tiers);
    const status = resolveEffectiveReferralStatus({
      storedStatus: row.status,
      referrerPoints: referrerQualificationPoints,
      referredPoints: row.qualificationPoints,
      threshold: OBSERVER_THRESHOLD,
    });
    return {
      id: row.id,
      walletAddress: row.wallet_address ?? null,
      status,
      qualifiedAt: status === "qualified" ? row.qualified_at : null,
      createdAt: row.created_at,
      points: row.points,
      bonus: row.bonus,
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
    excludeManual: boolean;
  },
): Promise<RewardsLeaderboard> {
  const intervalApplied = inputs.metric === "pnl" ? "alltime" : inputs.interval;
  const startAt = resolveLeaderboardStart(intervalApplied);
  const manualMode: RewardsManualFilterMode = inputs.excludeManual
    ? "exclude_all"
    : "include_all";

  const [rows, me] = await Promise.all([
    fetchRewardsLeaderboardRows(pool, {
      metric: inputs.metric,
      startAt,
      limit: inputs.limit,
      offset: inputs.offset,
      manualMode,
    }),
    fetchRewardsLeaderboardMe(pool, {
      userId: inputs.userId,
      metric: inputs.metric,
      startAt,
      manualMode,
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
