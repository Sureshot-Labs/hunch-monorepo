#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool } from "./db.js";
import { normalizeRewardsChainId } from "./lib/rewards-chain.js";
import { withRewardsUserAdvisoryXactLock } from "./lib/rewards-user-lock.js";
import {
  parseUsdcToMicro,
  parseUsdcToMicroFloor,
  usdcDecimalStringHasValidScale,
  usdcMicroFromUnsafeNumber,
  usdcMicroToDecimalString,
} from "./lib/usdc.js";
import {
  attachReferralCodeForExistingUser,
  computeCashbackBreakdown,
  getReferralAttachmentStatus,
  getRewardsLeaderboard,
  getRewardsReferrals,
  resolveEffectiveBps,
  setReferralCodeForUser,
  type RewardsPolicy,
} from "./services/rewards.js";
import {
  AdminRewardsBulkAdjustmentRetryExhaustedError,
  executeAdminRewardsBulkAdjustment,
  previewAdminRewardsBulkAdjustment,
  retryAdminRewardsBulkAdjustmentExecute,
} from "./services/admin-rewards-bulk-adjustments.js";
import {
  buildPublicPointsContributionSql,
  buildVolumeContributionSql,
  fetchAdminManualVolumeEvents,
  fetchReferralsForUser,
  fetchQualifiedReferralCount,
  fetchUserTierPoints,
  fetchUserPoints,
  fetchUserVolume,
  listReferralCodes as listReferralCodeRows,
  markQualifiedReferralsForUser,
  resolveRewardsReferralsOrderBy,
} from "./repos/rewards.js";
import {
  capTreasurySweepAmountMicro,
  computeTreasuryChainMath,
  reserveTreasurySweepAmountMicro,
} from "./services/rewards-treasury.js";
import {
  buildDepositWalletBatchTypedData,
  computePolymarketBuilderSweepAmount,
  deriveAddressFromPrivateKey,
} from "./services/polymarket-builder-sweeps.js";
import { resolveBlockedRewardsMigrations } from "./rewards-migration-preflight.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

function toNumber(value: bigint): number {
  return Number(usdcMicroToDecimalString(value));
}

function assertClose(actual: number, expected: number, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function createReferralDb(
  seed: Array<{
    id: string;
    referral_code: string | null;
    codeIsActive?: boolean;
    codeRetiredAt?: Date | null;
    codeRetiredReason?: string | null;
    referralCount?: number;
  }>,
  options: {
    extraCodes?: Array<{
      code: string;
      ownerUserId: string;
      isActive?: boolean;
      retiredAt?: Date | null;
      retiredReason?: string | null;
      referralCount?: number;
    }>;
    referrals?: Array<{
      referredUserId: string;
      referrerUserId: string | null;
      code: string;
      referralCodeId?: string;
    }>;
    firstTradeConversions?: Array<{
      referredUserId: string;
      referrerUserId: string | null;
      code: string;
    }>;
  } = {},
): import("./db.js").DbQuery & {
  snapshot: () => {
    users: Array<{ id: string; referral_code: string | null }>;
    codes: Array<{
      code: string;
      policy_id: string;
      is_active: boolean;
      retired_at: Date | null;
      retired_reason: string | null;
      referral_count: number;
    }>;
    referrals: Array<{
      referred_user_id: string;
      referrer_user_id: string | null;
      code: string;
      referral_code_id: string;
    }>;
    firstTradeConversions: Array<{
      referred_user_id: string;
      referrer_user_id: string | null;
      code: string;
    }>;
  };
} {
  const users = seed.map((row) => ({ ...row }));
  const policies = users.map((user) => ({
    id: `policy-${user.id}`,
    policy_type: "user" as const,
    owner_user_id: user.id,
  }));
  const codes = [
    ...users
      .filter((user) => user.referral_code)
      .map((user) => ({
        id: `code-${String(user.referral_code).toUpperCase()}`,
        code: String(user.referral_code).toUpperCase(),
        policy_id: `policy-${user.id}`,
        is_active: user.codeIsActive ?? true,
        retired_at:
          user.codeRetiredAt === undefined ? null : user.codeRetiredAt,
        retired_reason:
          user.codeRetiredReason === undefined ? null : user.codeRetiredReason,
        max_uses: null as number | null,
        referral_count: user.referralCount ?? 0,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        updated_at: new Date("2026-01-01T00:00:00.000Z"),
      })),
    ...(options.extraCodes ?? []).map((code) => ({
      id: `code-${code.code.toUpperCase()}`,
      code: code.code.toUpperCase(),
      policy_id: `policy-${code.ownerUserId}`,
      is_active: code.isActive ?? true,
      retired_at: code.retiredAt === undefined ? null : code.retiredAt,
      retired_reason:
        code.retiredReason === undefined ? null : code.retiredReason,
      max_uses: null as number | null,
      referral_count: code.referralCount ?? 0,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    })),
  ];
  const referrals = (options.referrals ?? []).map((referral) => ({
    referred_user_id: referral.referredUserId,
    referrer_user_id: referral.referrerUserId,
    code: referral.code.toUpperCase(),
    referral_code_id:
      referral.referralCodeId ?? `code-${referral.code.toUpperCase()}`,
  }));
  const firstTradeConversions = (options.firstTradeConversions ?? []).map(
    (conversion, index) => ({
      id: `conversion-${index}`,
      referred_user_id: conversion.referredUserId,
      referrer_user_id: conversion.referrerUserId,
      code: conversion.code.toUpperCase(),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    }),
  );
  const lookupCode = (code: string) => {
    const normalized = code.toUpperCase();
    const row = codes.find((entry) => entry.code === normalized);
    if (!row) return null;
    const policy = policies.find((entry) => entry.id === row.policy_id);
    if (!policy) return null;
    return {
      referral_code_id: row.id,
      code: row.code,
      is_active: row.is_active,
      retired_at: row.retired_at,
      retired_reason: row.retired_reason,
      max_uses: row.max_uses,
      policy_id: policy.id,
      policy_type: policy.policy_type,
      owner_user_id: policy.owner_user_id,
      label: null,
      multiplier_override: null,
      visible_drop_points: "0",
      tier_drop_points: "0",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  };
  return {
    query: async (sql: string, params?: unknown[]) => {
      const values = Array.isArray(params) ? params : [];
      if (
        sql.includes("from users") &&
        sql.includes("where id = $1") &&
        sql.includes("for update")
      ) {
        const userId = String(values[0] ?? "");
        const row = users.find((user) => user.id === userId) ?? null;
        return {
          rows: row ? [{ id: row.id, referral_code: row.referral_code }] : [],
        };
      }

      if (
        sql.includes("from referral_codes rc") &&
        sql.includes("where rc.code = upper($1)")
      ) {
        const row = lookupCode(String(values[0] ?? ""));
        return { rows: row ? [row] : [] };
      }

      if (
        sql.includes("select count(*)::text as total") &&
        sql.includes("referrer_user_id is distinct from $2::uuid")
      ) {
        const codeId = String(values[0] ?? "");
        const referrerUserId = String(values[1] ?? "");
        const total = referrals.filter(
          (referral) =>
            referral.referral_code_id === codeId &&
            referral.referrer_user_id !== referrerUserId,
        ).length;
        return { rows: [{ total: String(total) }] };
      }

      if (
        sql.includes("with moved_referrals as") &&
        sql.includes("update referrals r") &&
        sql.includes("moved_first_trades")
      ) {
        const sourceCodeId = String(values[0] ?? "");
        const sourceCode = String(values[1] ?? "").toUpperCase();
        const replacementCodeId = String(values[2] ?? "");
        const replacementCode = String(values[3] ?? "").toUpperCase();
        const referrerUserId = String(values[4] ?? "");
        const movedReferredUserIds = new Set<string>();
        for (const referral of referrals) {
          if (
            referral.referral_code_id === sourceCodeId &&
            referral.referrer_user_id === referrerUserId
          ) {
            referral.referral_code_id = replacementCodeId;
            referral.code = replacementCode;
            movedReferredUserIds.add(referral.referred_user_id);
          }
        }
        const firstTradeConversionsMoved = firstTradeConversions.filter(
          (conversion) =>
            movedReferredUserIds.has(conversion.referred_user_id) &&
            conversion.referrer_user_id === referrerUserId &&
            conversion.code.toUpperCase() === sourceCode,
        ).length;
        for (const conversion of firstTradeConversions) {
          if (
            movedReferredUserIds.has(conversion.referred_user_id) &&
            conversion.referrer_user_id === referrerUserId &&
            conversion.code.toUpperCase() === sourceCode
          ) {
            conversion.code = replacementCode;
            conversion.updated_at = new Date("2026-01-02T00:00:00.000Z");
          }
        }
        const source = codes.find((entry) => entry.id === sourceCodeId);
        if (source) source.referral_count -= movedReferredUserIds.size;
        const replacement = codes.find(
          (entry) => entry.id === replacementCodeId,
        );
        if (replacement) {
          replacement.referral_count += movedReferredUserIds.size;
        }
        return {
          rows: [
            {
              referrals_moved: String(movedReferredUserIds.size),
              first_trade_conversions_moved: String(firstTradeConversionsMoved),
            },
          ],
        };
      }

      if (
        sql.includes("select count(*)::text as total") &&
        sql.includes("from referrals")
      ) {
        const codeId = String(values[0] ?? "");
        const row = codes.find((entry) => entry.id === codeId);
        return { rows: [{ total: String(row?.referral_count ?? 0) }] };
      }

      if (sql.includes("insert into referral_code_policies")) {
        const userId = String(values[0] ?? "");
        let policy = policies.find((entry) => entry.owner_user_id === userId);
        if (!policy) {
          policy = {
            id: `policy-${userId}`,
            policy_type: "user",
            owner_user_id: userId,
          };
          policies.push(policy);
        }
        return { rows: [{ id: policy.id }] };
      }

      if (
        sql.includes("select id") &&
        sql.includes("from referral_code_policies")
      ) {
        const userId = String(values[0] ?? "");
        const policy = policies.find((entry) => entry.owner_user_id === userId);
        return { rows: policy ? [{ id: policy.id }] : [] };
      }

      if (
        sql.includes("update referral_codes rc") &&
        sql.includes("set is_active = false") &&
        sql.includes("p.owner_user_id = $1")
      ) {
        const userId = String(values[0] ?? "");
        const policy = policies.find((entry) => entry.owner_user_id === userId);
        if (policy) {
          for (const code of codes) {
            if (code.policy_id === policy.id && code.is_active) {
              code.is_active = false;
              code.retired_at = new Date("2026-01-02T00:00:00.000Z");
              code.retired_reason = String(values[1] ?? "");
            }
          }
        }
        return { rows: [] };
      }

      if (sql.includes("insert into referral_codes")) {
        const code = String(values[0] ?? "").toUpperCase();
        const policyId = String(values[1] ?? "");
        const isActive = Boolean(values[2]);
        const row = {
          id: `code-${code}`,
          code,
          policy_id: policyId,
          is_active: isActive,
          retired_at: isActive ? null : new Date("2026-01-02T00:00:00.000Z"),
          retired_reason: isActive ? null : String(values[3] ?? ""),
          max_uses: values[4] == null ? null : Number(values[4]),
          referral_count: 0,
          created_at: new Date("2026-01-02T00:00:00.000Z"),
          updated_at: new Date("2026-01-02T00:00:00.000Z"),
        };
        codes.push(row);
        return { rows: [lookupCode(code)] };
      }

      if (
        sql.includes("update referral_codes") &&
        sql.includes("set policy_id = $2")
      ) {
        const codeId = String(values[0] ?? "");
        const policyId = String(values[1] ?? "");
        const row = codes.find((entry) => entry.id === codeId);
        if (row) {
          row.policy_id = policyId;
          row.is_active = true;
          row.retired_at = null;
          row.retired_reason = null;
        }
        return { rows: [] };
      }

      if (sql.includes("upper(referral_code) = upper($1)")) {
        const code = String(values[0] ?? "").toUpperCase();
        const row =
          users.find((user) => user.referral_code?.toUpperCase() === code) ??
          null;
        return {
          rows: row ? [{ id: row.id, referral_code: row.referral_code }] : [],
        };
      }

      if (sql.includes("update users set referral_code = $2 where id = $1")) {
        const userId = String(values[0] ?? "");
        const referralCode = values[1] == null ? null : String(values[1]);
        const conflict =
          referralCode != null
            ? users.find(
                (user) =>
                  user.id !== userId &&
                  user.referral_code?.toUpperCase() ===
                    referralCode.toUpperCase(),
              )
            : null;
        if (conflict) {
          const error = new Error("duplicate key") as Error & { code?: string };
          error.code = "23505";
          throw error;
        }
        const target = users.find((user) => user.id === userId);
        if (target) target.referral_code = referralCode;
        return { rows: [] };
      }

      if (
        sql.includes("update users") &&
        sql.includes("set referral_code = null") &&
        sql.includes("upper(referral_code) = upper($2)")
      ) {
        const userId = String(values[0] ?? "");
        const referralCode = String(values[1] ?? "").toUpperCase();
        const target = users.find((user) => user.id === userId);
        if (!target) return { rows: [], rowCount: 0 };
        if (target.referral_code?.toUpperCase() !== referralCode) {
          return { rows: [], rowCount: 0 };
        }
        target.referral_code = null;
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unhandled SQL in referral test db: ${sql}`);
    },
    snapshot: () => ({
      users: users.map((user) => ({
        id: user.id,
        referral_code: user.referral_code,
      })),
      codes: codes.map((code) => ({
        code: code.code,
        policy_id: code.policy_id,
        is_active: code.is_active,
        retired_at: code.retired_at,
        retired_reason: code.retired_reason,
        referral_count: code.referral_count,
      })),
      referrals: referrals.map((referral) => ({ ...referral })),
      firstTradeConversions: firstTradeConversions.map((conversion) => ({
        referred_user_id: conversion.referred_user_id,
        referrer_user_id: conversion.referrer_user_id,
        code: conversion.code,
      })),
    }),
  } as import("./db.js").DbQuery & {
    snapshot: () => {
      users: Array<{ id: string; referral_code: string | null }>;
      codes: Array<{
        code: string;
        policy_id: string;
        is_active: boolean;
        retired_at: Date | null;
        retired_reason: string | null;
        referral_count: number;
      }>;
      referrals: Array<{
        referred_user_id: string;
        referrer_user_id: string | null;
        code: string;
        referral_code_id: string;
      }>;
      firstTradeConversions: Array<{
        referred_user_id: string;
        referrer_user_id: string | null;
        code: string;
      }>;
    };
  };
}

function createReferralAttachDb(seed: {
  users: Array<{
    id: string;
    referral_code: string | null;
    username?: string | null;
    display_name?: string | null;
  }>;
  codes?: Array<{
    id: string;
    code: string;
    policy_type: "user" | "campaign";
    owner_user_id?: string | null;
    is_active?: boolean;
    retired_at?: Date | null;
    max_uses?: number | null;
    visible_drop_points?: number;
    tier_drop_points?: number;
  }>;
  referrals?: Array<{
    id?: string;
    referrer_user_id: string | null;
    referred_user_id: string;
    code: string;
    referral_code_id?: string | null;
    status: "pending" | "qualified" | "blocked";
    qualified_at?: Date | null;
    created_at?: Date;
  }>;
}): import("./db.js").DbQuery {
  const users = seed.users.map((row) => ({
    username: null,
    display_name: null,
    ...row,
  }));
  const referrals = (seed.referrals ?? []).map((row) => ({
    id: `referral-${row.referred_user_id}`,
    qualified_at: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    referral_code_id: `code-${row.code.toUpperCase()}`,
    ...row,
  }));
  const codes = [
    ...users
      .filter((user) => user.referral_code)
      .map((user) => ({
        id: `code-${String(user.referral_code).toUpperCase()}`,
        code: String(user.referral_code).toUpperCase(),
        policy_type: "user" as const,
        owner_user_id: user.id,
        is_active: true,
        retired_at: null as Date | null,
        max_uses: null as number | null,
        visible_drop_points: 0,
        tier_drop_points: 0,
      })),
    ...(seed.codes ?? []).map((code) => ({
      is_active: true,
      retired_at: null as Date | null,
      max_uses: null as number | null,
      owner_user_id: null as string | null,
      visible_drop_points: 0,
      tier_drop_points: 0,
      ...code,
      code: code.code.toUpperCase(),
    })),
  ];
  const lookupCode = (code: string) => {
    const row = codes.find((entry) => entry.code === code.toUpperCase());
    if (!row) return null;
    return {
      referral_code_id: row.id,
      code: row.code,
      is_active: row.is_active,
      retired_at: row.retired_at,
      retired_reason: row.retired_at ? "campaign_deactivated" : null,
      max_uses: row.max_uses,
      policy_id: `policy-${row.id}`,
      policy_type: row.policy_type,
      owner_user_id: row.owner_user_id ?? null,
      label: null,
      multiplier_override: null,
      visible_drop_points: String(row.visible_drop_points ?? 0),
      tier_drop_points: String(row.tier_drop_points ?? 0),
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    };
  };

  return {
    query: async (sql: string, params?: unknown[]) => {
      const values = Array.isArray(params) ? params : [];
      if (
        sql.includes("from referrals r") &&
        sql.includes("where r.referred_user_id = $1")
      ) {
        const userId = String(values[0] ?? "");
        const row = referrals.find(
          (entry) => entry.referred_user_id === userId,
        );
        if (!row) return { rows: [] };
        const referrer =
          users.find((entry) => entry.id === row.referrer_user_id) ?? null;
        return {
          rows: [
            {
              referral_code_id: row.referral_code_id ?? null,
              policy_type: row.referral_code_id
                ? (codes.find((code) => code.id === row.referral_code_id)
                    ?.policy_type ?? null)
                : null,
              policy_id: row.referral_code_id
                ? `policy-${row.referral_code_id}`
                : null,
              policy_label: null,
              policy_multiplier_override: null,
              policy_owner_user_id: row.referral_code_id
                ? (codes.find((code) => code.id === row.referral_code_id)
                    ?.owner_user_id ?? null)
                : null,
              referrer_user_id: row.referrer_user_id,
              code: row.code,
              status: row.status,
              linked_at: row.created_at,
              qualified_at: row.qualified_at,
              referrer_username: referrer?.username ?? null,
              referrer_display_name: referrer?.display_name ?? null,
            },
          ],
        };
      }

      if (
        sql.includes("from referral_codes rc") &&
        sql.includes("where rc.code = upper($1)")
      ) {
        const row = lookupCode(String(values[0] ?? ""));
        if (!row || !row.is_active || row.retired_at) return { rows: [] };
        return { rows: [row] };
      }

      if (
        sql.includes("select count(*)::text as total") &&
        sql.includes("from referrals")
      ) {
        const referralCodeId = String(values[0] ?? "");
        return {
          rows: [
            {
              total: String(
                referrals.filter(
                  (entry) => entry.referral_code_id === referralCodeId,
                ).length,
              ),
            },
          ],
        };
      }

      if (
        sql.includes("insert into referrals") &&
        sql.includes("on conflict (referred_user_id) do nothing")
      ) {
        const referrerUserId = values[0] == null ? null : String(values[0]);
        const referredUserId = String(values[1] ?? "");
        const code = String(values[2] ?? "");
        const referralCodeId = String(values[3] ?? "");
        const status = String(values[4] ?? "pending") as
          | "pending"
          | "qualified"
          | "blocked";
        const qualifiedAt =
          values[5] instanceof Date
            ? (values[5] as Date)
            : values[5] == null
              ? null
              : new Date(String(values[5]));
        if (
          referrals.some((entry) => entry.referred_user_id === referredUserId)
        ) {
          return { rows: [] };
        }
        referrals.push({
          id: `referral-${referredUserId}`,
          referrer_user_id: referrerUserId,
          referred_user_id: referredUserId,
          code,
          referral_code_id: referralCodeId,
          status,
          qualified_at: qualifiedAt,
          created_at: new Date("2026-02-01T00:00:00.000Z"),
        });
        return { rows: [{ id: `referral-${referredUserId}` }] };
      }

      if (
        sql.includes("update referral_codes") &&
        sql.includes("usage_limit_reached")
      ) {
        const referralCodeId = String(values[0] ?? "");
        const code = codes.find((entry) => entry.id === referralCodeId);
        if (code) {
          code.is_active = false;
          code.retired_at = new Date("2026-02-01T00:00:00.000Z");
        }
        return { rows: [] };
      }

      if (sql.includes("insert into volume_events")) {
        return { rows: [{ inserted: true }] };
      }

      throw new Error(`Unhandled SQL in referral attach test db: ${sql}`);
    },
  } as import("./db.js").DbQuery;
}

function createQualifiedReferralCountDb(seed: {
  referrals: Array<{
    referrer_user_id: string;
    referred_user_id: string;
    status: "pending" | "qualified" | "blocked";
  }>;
  points: Record<string, number>;
  capture?: { countSql?: string; updateSql?: string };
}): import("./db.js").DbQuery {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const values = Array.isArray(params) ? params : [];

      if (
        sql.includes("select count(*)::text as total") &&
        sql.includes("from referrals r") &&
        sql.includes("left join points pref")
      ) {
        if (seed.capture) seed.capture.countSql = sql;
        const userId = String(values[0] ?? "");
        const threshold = Number(values[1] ?? 0);
        const total = seed.referrals.filter((row) => {
          if (row.referrer_user_id !== userId) return false;
          if (row.status === "blocked") return false;
          const referrerPoints = seed.points[row.referrer_user_id] ?? 0;
          const referredPoints = seed.points[row.referred_user_id] ?? 0;
          return referrerPoints >= threshold && referredPoints >= threshold;
        }).length;
        return { rows: [{ total: String(total) }] };
      }

      if (
        sql.includes("update referrals r") &&
        sql.includes("set status = 'qualified'")
      ) {
        if (seed.capture) seed.capture.updateSql = sql;
        const userId = String(values[0] ?? "");
        const threshold = Number(values[1] ?? 0);
        for (const row of seed.referrals) {
          if (row.referrer_user_id !== userId || row.status !== "pending") {
            continue;
          }
          const referrerPoints = seed.points[row.referrer_user_id] ?? 0;
          const referredPoints = seed.points[row.referred_user_id] ?? 0;
          if (referrerPoints >= threshold && referredPoints >= threshold) {
            row.status = "qualified";
          }
        }
        return { rows: [] };
      }

      throw new Error(
        `Unhandled SQL in qualified referral count test db: ${sql}`,
      );
    },
  } as import("./db.js").DbQuery;
}

function createUserPointsDb(seed: {
  total: string | null;
  capture?: { sql?: string; params?: unknown[] };
}): import("./db.js").DbQuery {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (seed.capture) {
        seed.capture.sql = sql;
        seed.capture.params = Array.isArray(params) ? params : [];
      }
      if (
        sql.includes("from volume_events ve") &&
        sql.includes("where ve.user_id = $1") &&
        sql.includes("as total")
      ) {
        return { rows: [{ total: seed.total }] };
      }
      throw new Error(`Unhandled SQL in user points test db: ${sql}`);
    },
  } as import("./db.js").DbQuery;
}

function createRewardsLeaderboardDb(seed: {
  publicPoints: string;
  tierPoints: string;
  capture?: {
    entriesSql?: string;
    meSql?: string;
    rankSql?: string;
    params: unknown[][];
  };
}): import("./db.js").DbQuery {
  const leaderboardRow = {
    user_id: "user-a",
    rank: 1,
    points: seed.publicPoints,
    tier_points: seed.tierPoints,
    volume_usd: "100",
    pnl_usd: "0",
    realized_pnl_usd: "0",
    unrealized_pnl_usd: "0",
    display_name: "User A",
    username: "usera",
    wallet_address: "0xabc",
  };

  return {
    query: async (sql: string, params?: unknown[]) => {
      seed.capture?.params.push(Array.isArray(params) ? [...params] : []);

      if (sql.includes("from rewards_policy")) {
        return {
          rows: [
            {
              id: "policy-a",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              tiers: [
                { tier: 0, name: "Novice", points: 0, cashbackBps: 0 },
                { tier: 1, name: "Observer", points: 500, cashbackBps: 2500 },
                { tier: 2, name: "Seeker", points: 5000, cashbackBps: 3000 },
              ],
              referral_bonus: [{ minReferrals: 1, bonusBps: 500 }],
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        };
      }

      if (sql.includes("select count(*)::text as higher")) {
        if (seed.capture) seed.capture.rankSql = sql;
        return { rows: [{ higher: "0" }] };
      }

      if (sql.includes("where u.id = $1")) {
        if (seed.capture) seed.capture.meSql = sql;
        return { rows: [leaderboardRow] };
      }

      if (sql.includes("page as") && sql.includes("dense_rank()")) {
        if (seed.capture) seed.capture.entriesSql = sql;
        return { rows: [leaderboardRow] };
      }

      throw new Error(`Unhandled SQL in rewards leaderboard test db: ${sql}`);
    },
  } as import("./db.js").DbQuery;
}

function createAdminManualPointsDb(seed: {
  capture?: { countSql?: string; listSql?: string; params: unknown[][] };
}): import("./db.js").DbQuery {
  let calls = 0;
  return {
    query: async (sql: string, params?: unknown[]) => {
      calls += 1;
      seed.capture?.params.push(Array.isArray(params) ? [...params] : []);
      if (sql.includes("select count(*)::text as total")) {
        if (seed.capture) seed.capture.countSql = sql;
        return { rows: [{ total: "2" }] };
      }
      if (sql.includes("from volume_events ve") && sql.includes("order by")) {
        if (seed.capture) seed.capture.listSql = sql;
        return {
          rows: [
            {
              id: "hidden-event",
              user_id: "user-a",
              wallet_address: "0xabc",
              venue: "admin",
              source_type: "execution",
              source_id: "manual:hidden",
              notional_usd: "500",
              points_awarded: "500",
              visible: false,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
            {
              id: "visible-event",
              user_id: "user-a",
              wallet_address: "0xabc",
              venue: "admin",
              source_type: "execution",
              source_id: "manual-visible:visible",
              notional_usd: "250",
              points_awarded: "250",
              visible: true,
              created_at: new Date("2026-01-02T00:00:00.000Z"),
            },
          ],
        };
      }
      throw new Error(
        `Unhandled SQL in admin manual points test db call ${calls}: ${sql}`,
      );
    },
  } as import("./db.js").DbQuery;
}

type BulkAdjustmentTestUser = {
  id: string;
  createdAt: Date;
  publicPoints: number;
  tierPoints: number;
  email?: string | null;
  username?: string | null;
  displayName?: string | null;
  walletAddress?: string | null;
  isActive?: boolean;
  isAdmin?: boolean;
  existing?: Map<string, number>;
};

function createBulkAdjustmentDb(seed: {
  users: BulkAdjustmentTestUser[];
  tiers?: Array<{
    tier: number;
    name: string;
    points: number;
    cashbackBps: number;
  }>;
  capture?: { insertCalls: number; queries: string[] };
}): import("./db.js").DbQuery {
  const tiers = seed.tiers ?? [
    { tier: 0, name: "Novice", points: 0, cashbackBps: 0 },
    { tier: 5, name: "Sage", points: 350_000, cashbackBps: 4500 },
  ];
  const capture = seed.capture ?? { insertCalls: 0, queries: [] };
  return {
    query: async (sql: string, params?: unknown[]) => {
      capture.queries.push(sql);
      if (
        sql.includes("set transaction isolation level serializable") ||
        sql.includes("pg_advisory_xact_lock")
      ) {
        return { rows: [] };
      }

      if (sql.includes("from rewards_policy")) {
        return {
          rows: [
            {
              id: "policy-1",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              tiers,
              referral_bonus: [{ minReferrals: 1, bonusBps: 100 }],
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        };
      }

      if (sql.includes("from users u")) {
        const hiddenSourcePrefix = String(params?.[0] ?? "");
        const visibleSourcePrefix = String(params?.[1] ?? "");
        const createdBefore = params?.[2] as Date;
        const requireActive = sql.includes("coalesce(u.is_active, true)");
        const excludeAdmins = sql.includes("coalesce(u.is_admin, false)");
        const requireWallet = sql.includes("required_wallet");
        const rows = seed.users
          .filter((user) => user.createdAt <= createdBefore)
          .filter((user) => !requireActive || user.isActive !== false)
          .filter((user) => !excludeAdmins || user.isAdmin !== true)
          .filter((user) => !requireWallet || Boolean(user.walletAddress))
          .map((user) => {
            const hiddenSourceId = `${hiddenSourcePrefix}${user.id}`;
            const visibleSourceId = `${visibleSourcePrefix}${user.id}`;
            const publicExcludedPoints =
              user.existing?.get(visibleSourceId) ?? 0;
            const tierExcludedPoints =
              (user.existing?.get(hiddenSourceId) ?? 0) + publicExcludedPoints;
            const existingSourceId = user.existing?.has(hiddenSourceId)
              ? hiddenSourceId
              : user.existing?.has(visibleSourceId)
                ? visibleSourceId
                : null;
            return {
              id: user.id,
              email: user.email ?? null,
              username: user.username ?? null,
              display_name: user.displayName ?? null,
              created_at: user.createdAt,
              wallet_address: user.walletAddress ?? null,
              public_points_basis: String(
                user.publicPoints - publicExcludedPoints,
              ),
              tier_points_basis: String(user.tierPoints - tierExcludedPoints),
              existing_source_id: existingSourceId,
            };
          });
        return { rows };
      }

      if (sql.includes("jsonb_to_recordset")) {
        capture.insertCalls += 1;
        const rows = JSON.parse(String(params?.[0] ?? "[]")) as Array<{
          user_id: string;
          hidden_source_id: string;
          source_id: string;
          visible_source_id: string;
          points: number;
        }>;
        let inserted = 0;
        let insertedPoints = 0;
        for (const row of rows) {
          const user = seed.users.find((item) => item.id === row.user_id);
          if (!user) continue;
          user.existing = user.existing ?? new Map<string, number>();
          if (
            user.existing.has(row.hidden_source_id) ||
            user.existing.has(row.visible_source_id)
          ) {
            continue;
          }
          const points = Number(row.points);
          user.existing.set(row.source_id, points);
          user.tierPoints += points;
          if (row.source_id.startsWith("manual-visible:")) {
            user.publicPoints += points;
          }
          inserted += 1;
          insertedPoints += points;
        }
        return {
          rows: [
            {
              inserted: String(inserted),
              inserted_points: String(insertedPoints),
            },
          ],
        };
      }

      throw new Error(`Unhandled SQL in bulk adjustment test db: ${sql}`);
    },
  } as import("./db.js").DbQuery;
}

function createFetchReferralsDb(seed: {
  rows: Array<{
    id: string;
    referred_user_id: string;
    status: string;
    qualified_at: Date | null;
    created_at: Date;
    wallet_address: string | null;
    points: string | null;
    tier_points?: string | null;
    qualification_points?: string | null;
    bonus: string | null;
  }>;
  referrerPoints?: string | null;
  capture?: { sql?: string; params?: unknown[] };
}): import("./db.js").DbQuery {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (seed.capture) {
        seed.capture.sql = sql;
        seed.capture.params = Array.isArray(params) ? params : [];
      }
      if (sql.includes("with referral_rows as")) {
        return { rows: seed.rows };
      }
      if (
        sql.includes("select count(*)::text as total") &&
        sql.includes("where referrer_user_id = $1")
      ) {
        return { rows: [{ total: String(seed.rows.length) }] };
      }
      if (sql.includes("from rewards_policy")) {
        return {
          rows: [
            {
              id: "policy-1",
              effective_at: null,
              tiers: samplePolicy.tiers,
              referral_bonus: samplePolicy.referralBonus,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        };
      }
      if (
        sql.includes("from volume_events ve") &&
        sql.includes("where ve.user_id = $1") &&
        sql.includes("as total")
      ) {
        return { rows: [{ total: seed.referrerPoints ?? "0" }] };
      }
      if (
        sql.includes("update referrals r") &&
        sql.includes("set status = 'qualified'")
      ) {
        return { rows: [] };
      }
      throw new Error(`Unhandled SQL in fetch referrals test db: ${sql}`);
    },
  } as import("./db.js").DbQuery;
}

const samplePolicy: RewardsPolicy = {
  effectiveAt: null,
  referralQualification: { pointsRequired: 500 },
  tiers: [
    { tier: 0, name: "Novice", points: 0, cashbackBps: 0 },
    { tier: 1, name: "Observer", points: 500, cashbackBps: 2500 },
    { tier: 2, name: "Seeker", points: 5000, cashbackBps: 3000 },
    { tier: 3, name: "Oracle", points: 25000, cashbackBps: 5500 },
  ],
  referralBonus: [
    { minReferrals: 3, bonusBps: 500 },
    { minReferrals: 5, bonusBps: 1000 },
    { minReferrals: 10, bonusBps: 3000 },
  ],
};

function randomRewardsEmail(): string {
  return `rewards-pnl-${crypto.randomUUID()}@example.com`;
}

function randomEvmAddress(): string {
  return `0x${crypto.randomBytes(20).toString("hex")}`;
}

async function createRewardsPnlFixture(inputs: {
  averagePrice: number | null;
  realizedPnl: number;
  resolvedOutcome?: "YES" | "NO" | null;
  side?: "YES" | "NO";
  size: number;
  topAsk?: number | null;
  topBid?: number | null;
  unrealizedPnl: number;
}): Promise<{
  cleanup: () => Promise<void>;
  tokenId: string;
  userId: string;
  walletAddress: string;
}> {
  const walletAddress = randomEvmAddress();
  const userInsert = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [randomRewardsEmail()],
  );
  const userId = userInsert.rows[0]?.id;
  if (!userId) throw new Error("Failed to create rewards pnl test user");

  const marketId = `rewards-pnl:${crypto.randomUUID()}`;
  const eventId = `event-${marketId}`;
  const tokenId = `limitless:${crypto.randomInt(1_000_000, 9_999_999)}`;
  const otherTokenId = `other-${tokenId}`;
  const side = inputs.side ?? "YES";
  const resolvedOutcome = inputs.resolvedOutcome ?? null;

  await pool.query(
    `
      insert into user_wallets (
        user_id,
        wallet_address,
        wallet_type,
        is_primary,
        is_verified
      )
      values ($1, $2, 'ethereum', true, true)
    `,
    [userId, walletAddress],
  );

  await pool.query(
    `
      insert into unified_events (
        id,
        venue,
        venue_event_id,
        title,
        status,
        start_date,
        end_date,
        volume_total,
        volume_24h,
        liquidity,
        slug,
        created_at,
        updated_at
      )
      values (
        $1,
        'limitless',
        $1,
        'Rewards PnL test event',
        $2,
        now() - interval '2 days',
        now() + interval '1 day',
        0,
        0,
        0,
        $3,
        now(),
        now()
      )
    `,
    [eventId, resolvedOutcome ? "SETTLED" : "ACTIVE", `slug-${eventId}`],
  );

  await pool.query(
    `
      insert into unified_markets (
        id,
        venue,
        venue_market_id,
        event_id,
        title,
        status,
        market_type,
        open_time,
        close_time,
        expiration_time,
        best_bid,
        best_ask,
        last_price,
        volume_total,
        volume_24h,
        liquidity,
        open_interest,
        outcomes,
        token_yes,
        token_no,
        slug,
        resolved_outcome,
        created_at,
        updated_at
      )
      values (
        $1,
        'limitless',
        $1,
        $2,
        'Rewards PnL test market',
        $3,
        'binary',
        now() - interval '2 days',
        now() + interval '1 day',
        now() + interval '1 day',
        0,
        0,
        null,
        0,
        0,
        0,
        0,
        '["Yes","No"]',
        case when $4 = 'YES' then $5 else $6 end,
        case when $4 = 'NO' then $5 else $6 end,
        $7,
        $8,
        now(),
        now()
      )
    `,
    [
      marketId,
      eventId,
      resolvedOutcome ? "SETTLED" : "ACTIVE",
      side,
      tokenId,
      otherTokenId,
      `slug-${marketId}`,
      resolvedOutcome,
    ],
  );

  await pool.query(
    `
      insert into unified_tokens(token_id, venue, market_id, side)
      values ($1, 'limitless', $2, $3)
    `,
    [tokenId, marketId, side],
  );

  if (inputs.topBid != null || inputs.topAsk != null) {
    await pool.query(
      `
        insert into unified_token_top_latest (
          token_id,
          venue,
          ts,
          best_bid,
          best_ask,
          mid,
          spread
        )
        values (
          $1,
          'limitless',
          now(),
          $2,
          $3,
          null,
          null
        )
      `,
      [tokenId, inputs.topBid ?? null, inputs.topAsk ?? null],
    );
  }

  await pool.query(
    `
      insert into positions (
        user_id,
        wallet_address,
        venue,
        position_scope,
        token_id,
        side,
        size,
        average_price,
        unrealized_pnl,
        realized_pnl,
        last_updated_at,
        created_at,
        updated_at
      )
      values (
        $1,
        $2,
        'limitless',
        'own',
        $3,
        'LONG',
        $4,
        $5,
        $6,
        $7,
        now(),
        now(),
        now()
      )
    `,
    [
      userId,
      walletAddress,
      tokenId,
      inputs.size,
      inputs.averagePrice,
      inputs.unrealizedPnl,
      inputs.realizedPnl,
    ],
  );

  return {
    cleanup: async () => {
      await pool.query("delete from positions where user_id = $1", [userId]);
      await pool.query("delete from user_wallets where user_id = $1", [userId]);
      await pool.query(
        "delete from unified_token_top_latest where token_id = $1",
        [tokenId],
      );
      await pool.query(
        "delete from unified_market_tokens where token_id = $1",
        [tokenId],
      );
      await pool.query("delete from unified_tokens where token_id = $1", [
        tokenId,
      ]);
      await pool.query("delete from unified_markets where id = $1", [marketId]);
      await pool.query("delete from unified_events where id = $1", [eventId]);
      await pool.query("delete from users where id = $1", [userId]);
    },
    tokenId,
    userId,
    walletAddress,
  };
}

function uppercaseOneHexChar(address: string): string {
  for (let index = 2; index < address.length; index += 1) {
    const char = address[index];
    if (char != null && char >= "a" && char <= "f") {
      return `${address.slice(0, index)}${char.toUpperCase()}${address.slice(index + 1)}`;
    }
  }
  throw new Error(`Cannot uppercase hex address without a-f chars: ${address}`);
}

async function loadRewardsPnlEntry(userId: string) {
  const leaderboard = await getRewardsLeaderboard(pool, {
    userId,
    metric: "pnl",
    interval: "alltime",
    limit: 10,
    offset: 0,
    excludeManual: true,
  });
  assert.ok(leaderboard.me);
  return leaderboard.me;
}

const tests: TestCase[] = [
  {
    name: "chain aliases normalize to canonical ids",
    run: () => {
      assert.equal(normalizeRewardsChainId("polygon"), "137");
      assert.equal(normalizeRewardsChainId("matic"), "137");
      assert.equal(normalizeRewardsChainId("base"), "8453");
      assert.equal(normalizeRewardsChainId("sol"), "solana");
      assert.equal(normalizeRewardsChainId("unknown"), null);
    },
  },
  {
    name: "usdc parse and format keep 6-decimal precision",
    run: () => {
      const parsed = parseUsdcToMicro("123.456789");
      assert.equal(parsed, 123_456_789n);
      assert.equal(usdcMicroToDecimalString(parsed ?? 0n), "123.456789");
    },
  },
  {
    name: "usdc parser rejects beyond 6 decimals",
    run: () => {
      const parsed = parseUsdcToMicro("1.23456789");
      assert.equal(parsed, null);
    },
  },
  {
    name: "usdc floor parser truncates beyond 6 decimals",
    run: () => {
      const parsed = parseUsdcToMicroFloor("1.23456789");
      assert.equal(parsed, 1_234_567n);
    },
  },
  {
    name: "usdc scale validator rejects > 6 decimals",
    run: () => {
      assert.equal(usdcDecimalStringHasValidScale("1.234567"), true);
      assert.equal(usdcDecimalStringHasValidScale("1.2345678"), false);
    },
  },
  {
    name: "unsafe number conversion floors to micro-usdc",
    run: () => {
      const micros = usdcMicroFromUnsafeNumber(0.1234569);
      assert.equal(micros, 123_456n);
    },
  },
  {
    name: "effective bps logic caps referral bonus by max cashback tier",
    run: () => {
      const resolved = resolveEffectiveBps(samplePolicy, 4000, 9000);
      assert.equal(resolved.cappedCashbackBps, 4000);
      assert.equal(resolved.cappedBonusBps, 4500);
    },
  },
  {
    name: "cashback breakdown uses frozen snapshot amounts directly",
    run: () => {
      const breakdown = computeCashbackBreakdown({
        feeTotalsByChain: { solana: { pending: "10", collected: "20" } },
        referralFeeTotalsByChain: { solana: { pending: "3", collected: "4" } },
        claimedTotalsByChain: { solana: "5" },
      });

      assert.equal(breakdown.totalPending, 13);
      assert.equal(breakdown.totalCollected, 24);
      assert.equal(breakdown.totalClaimable, 19);
    },
  },
  {
    name: "treasury sweep cap uses micro precision without float round-trip",
    run: () => {
      assert.equal(
        capTreasurySweepAmountMicro(1_000_001n, 1_000_000n),
        1_000_000n,
      );
      assert.equal(capTreasurySweepAmountMicro(999_999n, 1_000_000n), 999_999n);
      assert.equal(capTreasurySweepAmountMicro(999_999n, undefined), 999_999n);
    },
  },
  {
    name: "treasury sweep reserves waiting builder accruals",
    run: () => {
      assert.equal(reserveTreasurySweepAmountMicro(1_000n, 250n), 750n);
      assert.equal(reserveTreasurySweepAmountMicro(1_000n, 1_250n), 0n);
      assert.equal(reserveTreasurySweepAmountMicro(0n, 250n), 0n);
    },
  },
  {
    name: "polymarket builder sweep amount respects reserve min and max",
    run: () => {
      assert.deepEqual(
        computePolymarketBuilderSweepAmount({
          balanceRaw: 1_000_000n,
          reserveRaw: 100_000n,
          maxRaw: 250_000n,
          minRaw: 10_000n,
        }),
        { amountRaw: 250_000n, reason: null },
      );
      assert.deepEqual(
        computePolymarketBuilderSweepAmount({
          balanceRaw: 105_000n,
          reserveRaw: 100_000n,
          minRaw: 10_000n,
        }),
        { amountRaw: 0n, reason: "below_min_sweep" },
      );
      assert.deepEqual(
        computePolymarketBuilderSweepAmount({
          balanceRaw: 99_999n,
          reserveRaw: 100_000n,
        }),
        { amountRaw: 0n, reason: "reserved_builder_balance" },
      );
    },
  },
  {
    name: "polymarket builder sweep derives owner key and builds wallet typed data",
    run: () => {
      const privateKey =
        "0x0000000000000000000000000000000000000000000000000000000000000001";
      assert.equal(
        deriveAddressFromPrivateKey(privateKey),
        "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
      );
      const typedData = buildDepositWalletBatchTypedData({
        depositWalletAddress: "0x82E748661FA3DDD6aE486FcB7ADa88D52AB87AA9",
        nonce: "42",
        deadline: "1800000000",
        calls: [
          {
            target: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
            value: "0",
            data: "0x1234",
          },
        ],
      });
      assert.equal(typedData.domain.name, "DepositWallet");
      assert.equal(typedData.domain.version, "1");
      assert.equal(typedData.domain.chainId, 137);
      assert.equal(typedData.message.nonce, 42n);
      assert.equal(
        typedData.message.calls[0]?.target,
        "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
      );
    },
  },
  {
    name: "treasury chain math keeps deficit and sweep mutually exclusive",
    run: () => {
      const computed = computeTreasuryChainMath({
        liabilityCollectedMicro: 100_000_000n,
        liabilityPendingMicro: 40_000_000n,
        claimedConfirmedMicro: 30_000_000n,
        claimedNonFailedMicro: 50_000_000n,
        includePending: true,
        bufferUsd: 2,
        bufferPct: 0.1,
        controlledHotBalanceMicro: 80_000_000n,
        protocolReceivableBalanceMicro: 15_000_000n,
      });

      assert.equal(toNumber(computed.claimableNowMicro), 50);
      assert.equal(toNumber(computed.outstandingCollectedPayableMicro), 70);
      assert.equal(toNumber(computed.reserveFloorMicro), 121);
      assert.equal(toNumber(computed.bufferAppliedMicro), 11);
      assert.equal(toNumber(computed.deficitNowMicro), 41);
      assert.equal(toNumber(computed.sweepableNowMicro), 0);
      assert.equal(toNumber(computed.economicSurplusMicro), 0);
    },
  },
  {
    name: "treasury chain math computes surplus and sweep when reserve is covered",
    run: () => {
      const computed = computeTreasuryChainMath({
        liabilityCollectedMicro: 100_000_000n,
        liabilityPendingMicro: 10_000_000n,
        claimedConfirmedMicro: 20_000_000n,
        claimedNonFailedMicro: 20_000_000n,
        includePending: false,
        bufferUsd: 1,
        bufferPct: 0.05,
        controlledHotBalanceMicro: 100_000_000n,
        protocolReceivableBalanceMicro: 10_000_000n,
      });

      assert.equal(toNumber(computed.claimableNowMicro), 80);
      assert.equal(toNumber(computed.outstandingCollectedPayableMicro), 80);
      assert.equal(toNumber(computed.reserveFloorMicro), 84);
      assert.equal(toNumber(computed.deficitNowMicro), 0);
      assert.equal(toNumber(computed.sweepableNowMicro), 16);
      assert.equal(toNumber(computed.economicSurplusMicro), 26);
    },
  },
  {
    name: "cashback breakdown excludes non-canonical chains and merges aliases",
    run: () => {
      const breakdown = computeCashbackBreakdown({
        feeTotalsByChain: {
          polygon: { pending: "1", collected: "2" },
          "137": { pending: "0.5", collected: "0.25" },
          unknown: { pending: "9", collected: "9" },
        },
        referralFeeTotalsByChain: {
          matic: { pending: "0.1", collected: "0.2" },
          "137": { pending: "0.4", collected: "0.3" },
        },
        claimedTotalsByChain: {
          polygon: "0.5",
          "137": "0.05",
          unknown: "4",
        },
      });

      assert.deepEqual(Object.keys(breakdown.cashbackByChain), ["137"]);
      assert.equal(breakdown.cashbackByChain["137"]?.pending, 2);
      assert.equal(breakdown.cashbackByChain["137"]?.collected, 2.75);
      assert.equal(breakdown.cashbackByChain["137"]?.claimable, 2.2);
      assert.equal(breakdown.totalClaimable, 2.2);
    },
  },
  {
    name: "user advisory lock helper acquires lock before executing callback",
    run: async () => {
      const calls: string[] = [];
      const client = {
        query: async (sql: string) => {
          calls.push(sql);
          return { rows: [] };
        },
      } as unknown as import("pg").PoolClient;

      const result = await withRewardsUserAdvisoryXactLock(
        client,
        "USER-ID",
        async () => {
          calls.push("callback");
          return "ok";
        },
      );

      assert.equal(result, "ok");
      assert.equal(
        calls[0],
        "select pg_advisory_xact_lock(hashtext($1)::bigint)",
      );
      assert.equal(calls[1], "callback");
    },
  },
  {
    name: "migration preflight blocks mutable rewards migration set",
    run: () => {
      const blocked = resolveBlockedRewardsMigrations([
        "0069_old.sql",
        "0076_rewards_claims_usdc_scale.sql",
        "0073_rewards_points_awarded.sql",
      ]);
      assert.deepEqual(blocked, [
        "0073_rewards_points_awarded.sql",
        "0076_rewards_claims_usdc_scale.sql",
      ]);
    },
  },
  {
    name: "migration preflight passes when mutable rewards migrations are absent",
    run: () => {
      const blocked = resolveBlockedRewardsMigrations([
        "0001_init.sql",
        "0041_rewards_core.sql",
      ]);
      assert.deepEqual(blocked, []);
    },
  },
  {
    name: "referral code list search ranks exact code matches first",
    run: async () => {
      let dataSql = "";
      let dataParams: unknown[] = [];
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes("select count(*)::text as total")) {
            return { rows: [{ total: "0" }] };
          }
          dataSql = sql;
          dataParams = Array.isArray(params) ? params : [];
          return { rows: [] };
        },
      } as import("./db.js").DbQuery;

      await listReferralCodeRows(db, {
        q: "LEW",
        policyType: null,
        active: null,
        usageLimit: null,
        limit: 50,
        offset: 0,
      });

      assert.match(
        dataSql,
        /case\s+when rc\.code = \$2 then 0\s+when rc\.code like \$3 then 1\s+else 2\s+end asc,/,
      );
      assert.deepEqual(dataParams, ["%LEW%", "LEW", "LEW%", 50, 0]);
    },
  },
  {
    name: "set referral code succeeds when code is available",
    run: async () => {
      const db = createReferralDb([
        { id: "user-a", referral_code: null },
        { id: "user-b", referral_code: "TAKEN" },
      ]);
      const result = await setReferralCodeForUser(db, {
        userId: "user-a",
        referralCode: "  my-code  ",
      });
      assert.equal(result.code, "MYCODE");
      assert.equal(result.transferredFromUserId, null);
    },
  },
  {
    name: "set referral code rejects values outside 3-10 chars after normalization",
    run: async () => {
      const db = createReferralDb([{ id: "user-a", referral_code: null }]);

      await assert.rejects(
        () =>
          setReferralCodeForUser(db, {
            userId: "user-a",
            referralCode: "ab",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "statusCode" in error &&
          (error as Error & { statusCode?: number }).statusCode === 400,
      );

      await assert.rejects(
        () =>
          setReferralCodeForUser(db, {
            userId: "user-a",
            referralCode: "ABCDEFGHIJK",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "statusCode" in error &&
          (error as Error & { statusCode?: number }).statusCode === 400,
      );
    },
  },
  {
    name: "set referral code rejects conflicts without force transfer",
    run: async () => {
      const db = createReferralDb([
        { id: "user-a", referral_code: null },
        { id: "user-b", referral_code: "VIP" },
      ]);
      await assert.rejects(
        () =>
          setReferralCodeForUser(db, {
            userId: "user-a",
            referralCode: "vip",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "statusCode" in error &&
          (error as Error & { statusCode?: number }).statusCode === 409,
      );
    },
  },
  {
    name: "set referral code can force transfer ownership",
    run: async () => {
      const db = createReferralDb([
        { id: "user-a", referral_code: null },
        { id: "user-b", referral_code: "VIP" },
      ]);
      const result = await setReferralCodeForUser(db, {
        userId: "user-a",
        referralCode: "vip",
        forceTransfer: true,
      });
      assert.equal(result.code, "VIP");
      assert.equal(result.transferredFromUserId, "user-b");
    },
  },
  {
    name: "set referral code reactivates retired used code for same owner",
    run: async () => {
      const db = createReferralDb(
        [
          { id: "user-a", referral_code: "NEW" },
          { id: "user-b", referral_code: null },
        ],
        {
          extraCodes: [
            {
              code: "OLD",
              ownerUserId: "user-a",
              isActive: false,
              retiredAt: new Date("2026-01-02T00:00:00.000Z"),
              retiredReason: "user_code_changed",
              referralCount: 3,
            },
          ],
        },
      );

      const result = await setReferralCodeForUser(db, {
        userId: "user-a",
        referralCode: "old",
      });

      assert.equal(result.code, "OLD");
      assert.equal(result.transferredFromUserId, null);
      const snapshot = db.snapshot();
      assert.equal(
        snapshot.users.find((user) => user.id === "user-a")?.referral_code,
        "OLD",
      );
      assert.equal(
        snapshot.codes.find((code) => code.code === "OLD")?.is_active,
        true,
      );
      assert.equal(
        snapshot.codes.find((code) => code.code === "NEW")?.is_active,
        false,
      );
      assert.equal(
        snapshot.codes.find((code) => code.code === "OLD")?.referral_count,
        3,
      );
    },
  },
  {
    name: "set referral code rejects retired used code transfer to different owner",
    run: async () => {
      const db = createReferralDb([
        {
          id: "user-a",
          referral_code: "VIP",
          codeIsActive: false,
          codeRetiredAt: new Date("2026-01-02T00:00:00.000Z"),
          codeRetiredReason: "user_code_changed",
          referralCount: 2,
        },
        { id: "user-b", referral_code: null },
      ]);

      await assert.rejects(
        () =>
          setReferralCodeForUser(db, {
            userId: "user-b",
            referralCode: "vip",
            forceTransfer: true,
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            "Original owner needs a different active referral code before this used code can be force transferred",
      );
    },
  },
  {
    name: "set referral code force transfer moves used code attribution to owner replacement",
    run: async () => {
      const db = createReferralDb(
        [
          { id: "user-a", referral_code: "MADHAV" },
          { id: "user-b", referral_code: "BETA" },
        ],
        {
          extraCodes: [
            {
              code: "HUNCH",
              ownerUserId: "user-a",
              isActive: false,
              retiredAt: new Date("2026-01-02T00:00:00.000Z"),
              retiredReason: "user_code_changed",
              referralCount: 2,
            },
          ],
          referrals: [
            {
              referredUserId: "referred-1",
              referrerUserId: "user-a",
              code: "HUNCH",
            },
            {
              referredUserId: "referred-2",
              referrerUserId: "user-a",
              code: "HUNCH",
            },
          ],
          firstTradeConversions: [
            {
              referredUserId: "referred-1",
              referrerUserId: "user-a",
              code: "HUNCH",
            },
          ],
        },
      );

      const result = await setReferralCodeForUser(db, {
        userId: "user-b",
        referralCode: "hunch",
        forceTransfer: true,
      });

      assert.equal(result.code, "HUNCH");
      assert.equal(result.transferredFromUserId, "user-a");
      const snapshot = db.snapshot();
      assert.equal(
        snapshot.users.find((user) => user.id === "user-a")?.referral_code,
        "MADHAV",
      );
      assert.equal(
        snapshot.users.find((user) => user.id === "user-b")?.referral_code,
        "HUNCH",
      );
      assert.equal(
        snapshot.codes.find((code) => code.code === "HUNCH")?.policy_id,
        "policy-user-b",
      );
      assert.equal(
        snapshot.codes.find((code) => code.code === "HUNCH")?.referral_count,
        0,
      );
      assert.equal(
        snapshot.codes.find((code) => code.code === "MADHAV")?.referral_count,
        2,
      );
      assert.deepEqual(
        snapshot.referrals.map((referral) => ({
          referred_user_id: referral.referred_user_id,
          referrer_user_id: referral.referrer_user_id,
          code: referral.code,
          referral_code_id: referral.referral_code_id,
        })),
        [
          {
            referred_user_id: "referred-1",
            referrer_user_id: "user-a",
            code: "MADHAV",
            referral_code_id: "code-MADHAV",
          },
          {
            referred_user_id: "referred-2",
            referrer_user_id: "user-a",
            code: "MADHAV",
            referral_code_id: "code-MADHAV",
          },
        ],
      );
      assert.deepEqual(snapshot.firstTradeConversions, [
        {
          referred_user_id: "referred-1",
          referrer_user_id: "user-a",
          code: "MADHAV",
        },
      ]);
    },
  },
  {
    name: "set referral code rejects used transfer when replacement is retired",
    run: async () => {
      const db = createReferralDb(
        [
          {
            id: "user-a",
            referral_code: "MADHAV",
            codeIsActive: false,
            codeRetiredAt: new Date("2026-01-02T00:00:00.000Z"),
            codeRetiredReason: "user_code_changed",
          },
          { id: "user-b", referral_code: null },
        ],
        {
          extraCodes: [
            {
              code: "HUNCH",
              ownerUserId: "user-a",
              isActive: false,
              retiredAt: new Date("2026-01-02T00:00:00.000Z"),
              retiredReason: "user_code_changed",
              referralCount: 1,
            },
          ],
          referrals: [
            {
              referredUserId: "referred-1",
              referrerUserId: "user-a",
              code: "HUNCH",
            },
          ],
        },
      );

      await assert.rejects(
        () =>
          setReferralCodeForUser(db, {
            userId: "user-b",
            referralCode: "hunch",
            forceTransfer: true,
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            "Original owner replacement referral code is not active",
      );
    },
  },
  {
    name: "set referral code rejects used transfer with inconsistent referral owner",
    run: async () => {
      const db = createReferralDb(
        [
          { id: "user-a", referral_code: "MADHAV" },
          { id: "user-b", referral_code: null },
        ],
        {
          extraCodes: [
            {
              code: "HUNCH",
              ownerUserId: "user-a",
              isActive: false,
              retiredAt: new Date("2026-01-02T00:00:00.000Z"),
              retiredReason: "user_code_changed",
              referralCount: 1,
            },
          ],
          referrals: [
            {
              referredUserId: "referred-1",
              referrerUserId: "user-c",
              code: "HUNCH",
            },
          ],
        },
      );

      await assert.rejects(
        () =>
          setReferralCodeForUser(db, {
            userId: "user-b",
            referralCode: "hunch",
            forceTransfer: true,
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            "Referral code has inconsistent historical referrals and cannot be moved automatically",
      );
    },
  },
  {
    name: "set referral code can force transfer retired unused code",
    run: async () => {
      const db = createReferralDb([
        {
          id: "user-a",
          referral_code: "VIP",
          codeIsActive: false,
          codeRetiredAt: new Date("2026-01-02T00:00:00.000Z"),
          codeRetiredReason: "user_code_changed",
        },
        { id: "user-b", referral_code: "BETA" },
      ]);

      const result = await setReferralCodeForUser(db, {
        userId: "user-b",
        referralCode: "vip",
        forceTransfer: true,
      });

      assert.equal(result.code, "VIP");
      assert.equal(result.transferredFromUserId, "user-a");
      const snapshot = db.snapshot();
      assert.equal(
        snapshot.users.find((user) => user.id === "user-a")?.referral_code,
        null,
      );
      assert.equal(
        snapshot.users.find((user) => user.id === "user-b")?.referral_code,
        "VIP",
      );
      assert.equal(
        snapshot.codes.find((code) => code.code === "BETA")?.is_active,
        false,
      );
    },
  },
  {
    name: "set referral code rejects active used code transfer",
    run: async () => {
      const db = createReferralDb([
        { id: "user-a", referral_code: "VIP", referralCount: 1 },
        { id: "user-b", referral_code: null },
      ]);

      await assert.rejects(
        () =>
          setReferralCodeForUser(db, {
            userId: "user-b",
            referralCode: "vip",
            forceTransfer: true,
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            "Original owner needs a different active referral code before this used code can be force transferred",
      );
    },
  },
  {
    name: "get referral attachment status returns empty when not attached",
    run: async () => {
      const db = createReferralAttachDb({
        users: [{ id: "user-a", referral_code: null }],
      });
      const status = await getReferralAttachmentStatus(db, {
        userId: "user-a",
      });
      assert.equal(status.hasReferrer, false);
      assert.equal(status.code, null);
      assert.equal(status.status, null);
      assert.equal(status.referrer, null);
    },
  },
  {
    name: "attach referral for existing user succeeds once",
    run: async () => {
      const db = createReferralAttachDb({
        users: [
          { id: "user-a", referral_code: null },
          {
            id: "user-b",
            referral_code: "CREATOR",
            username: "creator",
            display_name: "Creator",
          },
        ],
      });
      const result = await attachReferralCodeForExistingUser(db, {
        userId: "user-a",
        referralCode: "creator",
      });
      assert.equal(result.status, "attached");
      assert.equal(result.referral.hasReferrer, true);
      assert.equal(result.referral.code, "CREATOR");
      assert.equal(result.referral.status, "pending");
      assert.equal(result.referral.referrer?.userId, "user-b");
    },
  },
  {
    name: "attach referral retires campaign code when usage limit is reached",
    run: async () => {
      const db = createReferralAttachDb({
        users: [{ id: "user-a", referral_code: null }],
        codes: [
          {
            id: "code-poly",
            code: "POLY",
            policy_type: "campaign",
            max_uses: 1,
            visible_drop_points: 420,
            tier_drop_points: 100_000,
          },
        ],
      });

      const first = await attachReferralCodeForExistingUser(db, {
        userId: "user-a",
        referralCode: "POLY",
      });
      assert.equal(first.status, "attached");
      assert.equal(first.referral.code, "POLY");

      const second = await attachReferralCodeForExistingUser(db, {
        userId: "user-b",
        referralCode: "POLY",
      });
      assert.equal(second.status, "not_found");
    },
  },
  {
    name: "attach referral rejects campaign code already at usage limit",
    run: async () => {
      const db = createReferralAttachDb({
        users: [{ id: "user-a", referral_code: null }],
        codes: [
          {
            id: "code-poly",
            code: "POLY",
            policy_type: "campaign",
            max_uses: 1,
          },
        ],
        referrals: [
          {
            id: "referral-existing",
            referrer_user_id: null,
            referred_user_id: "user-existing",
            code: "POLY",
            referral_code_id: "code-poly",
            status: "pending",
          },
        ],
      });

      const result = await attachReferralCodeForExistingUser(db, {
        userId: "user-a",
        referralCode: "POLY",
      });
      assert.equal(result.status, "not_found");
    },
  },
  {
    name: "attach referral for existing user reports already attached",
    run: async () => {
      const db = createReferralAttachDb({
        users: [
          { id: "user-a", referral_code: null },
          { id: "user-b", referral_code: "FIRST" },
          { id: "user-c", referral_code: "SECOND" },
        ],
        referrals: [
          {
            referrer_user_id: "user-b",
            referred_user_id: "user-a",
            code: "FIRST",
            status: "pending",
          },
        ],
      });
      const result = await attachReferralCodeForExistingUser(db, {
        userId: "user-a",
        referralCode: "SECOND",
      });
      assert.equal(result.status, "already_attached");
      assert.equal(result.referral.code, "FIRST");
    },
  },
  {
    name: "attach referral keeps already_attached precedence over malformed code",
    run: async () => {
      const db = createReferralAttachDb({
        users: [
          { id: "user-a", referral_code: null },
          { id: "user-b", referral_code: "FIRST" },
        ],
        referrals: [
          {
            referrer_user_id: "user-b",
            referred_user_id: "user-a",
            code: "FIRST",
            status: "pending",
          },
        ],
      });
      const result = await attachReferralCodeForExistingUser(db, {
        userId: "user-a",
        referralCode: "!!!",
      });
      assert.equal(result.status, "already_attached");
      assert.equal(result.referral.code, "FIRST");
    },
  },
  {
    name: "attach referral rejects self and missing code with stable statuses",
    run: async () => {
      const db = createReferralAttachDb({
        users: [{ id: "user-a", referral_code: "SELF" }],
      });
      const self = await attachReferralCodeForExistingUser(db, {
        userId: "user-a",
        referralCode: "self",
      });
      assert.equal(self.status, "self_referral");

      const missing = await attachReferralCodeForExistingUser(db, {
        userId: "user-a",
        referralCode: "missing",
      });
      assert.equal(missing.status, "not_found");
    },
  },
  {
    name: "attach referral rejects values outside 3-10 chars after normalization",
    run: async () => {
      const db = createReferralAttachDb({
        users: [{ id: "user-a", referral_code: null }],
      });

      const tooShort = await attachReferralCodeForExistingUser(db, {
        userId: "user-a",
        referralCode: "ab",
      });
      assert.equal(tooShort.status, "invalid_code");

      const tooLong = await attachReferralCodeForExistingUser(db, {
        userId: "user-a",
        referralCode: "ABCDEFGHIJK",
      });
      assert.equal(tooLong.status, "invalid_code");
    },
  },
  {
    name: "fetchUserPoints uses public points only",
    run: async () => {
      const capture: { sql?: string; params?: unknown[] } = {};
      const db = createUserPointsDb({ total: "750", capture });

      const points = await fetchUserPoints(db, "user-a");

      assert.equal(points, 750);
      assert.match(capture.sql ?? "", /source_id like 'manual:%'/);
      assert.match(capture.sql ?? "", /source_id like 'referral-code-tier:%'/);
      assert.doesNotMatch(capture.sql ?? "", /manual-visible:%/);
      assert.doesNotMatch(capture.sql ?? "", /referral-code-visible:%/);
      assert.deepEqual(capture.params, ["user-a"]);
    },
  },
  {
    name: "public points include visible admin/referral grants but exclude tier-only grants",
    run: async () => {
      const expression = buildPublicPointsContributionSql("ve");

      assert.match(expression, /source_id like 'manual:%'/);
      assert.match(expression, /source_id like 'referral-code-tier:%'/);
      assert.doesNotMatch(expression, /manual-visible:%/);
      assert.doesNotMatch(expression, /referral-code-visible:%/);
    },
  },
  {
    name: "fetchUserTierPoints includes manual and tier drops",
    run: async () => {
      const capture: { sql?: string; params?: unknown[] } = {};
      const db = createUserPointsDb({ total: "1250", capture });

      const points = await fetchUserTierPoints(db, "user-a");

      assert.equal(points, 1250);
      assert.doesNotMatch(capture.sql ?? "", /source_id like 'manual:%'/);
      assert.doesNotMatch(
        capture.sql ?? "",
        /source_id like 'referral-code-tier:%'/,
      );
      assert.deepEqual(capture.params, ["user-a"]);
    },
  },
  {
    name: "leaderboard exposes level from tier points without leaking tier points",
    run: async () => {
      const capture: {
        entriesSql?: string;
        meSql?: string;
        rankSql?: string;
        params: unknown[][];
      } = { params: [] };
      const db = createRewardsLeaderboardDb({
        publicPoints: "400",
        tierPoints: "5500",
        capture,
      });

      const leaderboard = await getRewardsLeaderboard(db, {
        userId: "user-a",
        metric: "points",
        interval: "alltime",
        limit: 10,
        offset: 0,
        excludeManual: true,
      });

      assert.equal(leaderboard.entries.length, 1);
      const entry = leaderboard.entries[0];
      assert.equal(entry?.points, 400);
      assert.equal(entry?.level, 3);
      assert.equal(
        (entry as Record<string, unknown> | undefined)?.tierPoints,
        undefined,
      );
      assert.equal(leaderboard.me?.points, 400);
      assert.equal(leaderboard.me?.level, 3);
      assert.equal(
        (leaderboard.me as Record<string, unknown> | null)?.tierPoints,
        undefined,
      );
      assert.match(capture.entriesSql ?? "", /source_id like 'manual:%'/);
      assert.match(
        capture.entriesSql ?? "",
        /source_id like 'referral-code-tier:%'/,
      );
      assert.match(
        capture.entriesSql ?? "",
        /sum\(ve\.points_awarded\).*as points/s,
      );
      assert.match(
        capture.meSql ?? "",
        /sum\(ve\.points_awarded\).*as points/s,
      );
      assert.match(capture.rankSql ?? "", /where points > \$1/);
    },
  },
  {
    name: "leaderboard pnl treats resolved winning unified_tokens position as realized",
    run: async () => {
      const fixture = await createRewardsPnlFixture({
        averagePrice: 0.4,
        realizedPnl: 0.25,
        resolvedOutcome: "YES",
        side: "YES",
        size: 2,
        unrealizedPnl: 99,
      });
      try {
        const entry = await loadRewardsPnlEntry(fixture.userId);

        assertClose(entry.pnlUsd, 1.45);
        assertClose(entry.realizedPnlUsd, 1.45);
        assertClose(entry.unrealizedPnlUsd, 0);
      } finally {
        await fixture.cleanup();
      }
    },
  },
  {
    name: "leaderboard pnl treats resolved losing unified_tokens position as realized",
    run: async () => {
      const fixture = await createRewardsPnlFixture({
        averagePrice: 0.2,
        realizedPnl: 0,
        resolvedOutcome: "NO",
        side: "YES",
        size: 3,
        unrealizedPnl: 99,
      });
      try {
        const entry = await loadRewardsPnlEntry(fixture.userId);

        assertClose(entry.pnlUsd, -0.6);
        assertClose(entry.realizedPnlUsd, -0.6);
        assertClose(entry.unrealizedPnlUsd, 0);
      } finally {
        await fixture.cleanup();
      }
    },
  },
  {
    name: "leaderboard pnl splits unresolved position into realized and unrealized",
    run: async () => {
      const fixture = await createRewardsPnlFixture({
        averagePrice: 0.25,
        realizedPnl: 1.25,
        resolvedOutcome: null,
        side: "YES",
        size: 4,
        unrealizedPnl: -0.5,
      });
      try {
        const entry = await loadRewardsPnlEntry(fixture.userId);

        assertClose(entry.pnlUsd, 0.75);
        assertClose(entry.realizedPnlUsd, 1.25);
        assertClose(entry.unrealizedPnlUsd, -0.5);
      } finally {
        await fixture.cleanup();
      }
    },
  },
  {
    name: "leaderboard pnl uses fresh top book for unresolved position pnl",
    run: async () => {
      const fixture = await createRewardsPnlFixture({
        averagePrice: 0.25,
        realizedPnl: 1.25,
        resolvedOutcome: null,
        side: "YES",
        size: 4,
        topBid: 0.5,
        topAsk: 0.55,
        unrealizedPnl: -99,
      });
      try {
        const entry = await loadRewardsPnlEntry(fixture.userId);

        assertClose(entry.pnlUsd, 2.25);
        assertClose(entry.realizedPnlUsd, 1.25);
        assertClose(entry.unrealizedPnlUsd, 1);
      } finally {
        await fixture.cleanup();
      }
    },
  },
  {
    name: "leaderboard pnl does not double count case-variant wallet positions",
    run: async () => {
      const fixture = await createRewardsPnlFixture({
        averagePrice: null,
        realizedPnl: 1.5,
        resolvedOutcome: null,
        side: "YES",
        size: 1,
        unrealizedPnl: 0,
      });
      try {
        const caseVariantWalletAddress = uppercaseOneHexChar(
          fixture.walletAddress,
        );
        await pool.query(
          `
            insert into positions (
              user_id,
              wallet_address,
              venue,
              position_scope,
              token_id,
              side,
              size,
              average_price,
              unrealized_pnl,
              realized_pnl,
              last_updated_at,
              created_at,
              updated_at
            )
            values (
              $1,
              $2,
              'limitless',
              'own',
              $3,
              'LONG',
              1,
              null,
              0,
              -20,
              now(),
              now(),
              now()
            )
          `,
          [fixture.userId, caseVariantWalletAddress, fixture.tokenId],
        );

        const entry = await loadRewardsPnlEntry(fixture.userId);

        assertClose(entry.pnlUsd, 1.5);
        assertClose(entry.realizedPnlUsd, 1.5);
        assertClose(entry.unrealizedPnlUsd, 0);
      } finally {
        await fixture.cleanup();
      }
    },
  },
  {
    name: "fetchUserVolume excludes manual grants and referral-code drops",
    run: async () => {
      const capture: { sql?: string; params?: unknown[] } = {};
      const db = createUserPointsDb({ total: "250", capture });

      const volume = await fetchUserVolume(db, "user-a");

      assert.equal(volume, 250);
      assert.match(capture.sql ?? "", /source_id like 'manual:%'/);
      assert.match(capture.sql ?? "", /manual-visible:%/);
      assert.match(capture.sql ?? "", /referral-code-visible:%/);
      assert.match(capture.sql ?? "", /referral-code-tier:%/);
      assert.deepEqual(capture.params, ["user-a"]);
    },
  },
  {
    name: "volume contribution honors leaderboard manual mode",
    run: async () => {
      const includeAll = buildVolumeContributionSql("ve", "include_all");
      assert.equal(includeAll, "ve.notional_usd");

      const excludeAll = buildVolumeContributionSql("ve", "exclude_all");
      assert.match(excludeAll, /source_id like 'manual:%'/);
      assert.match(excludeAll, /manual-visible:%/);
      assert.match(excludeAll, /referral-code-visible:%/);
      assert.match(excludeAll, /referral-code-tier:%/);

      const excludeVolumeOnly = buildVolumeContributionSql(
        "ve",
        "exclude_volume_only",
      );
      assert.equal(excludeVolumeOnly, excludeAll);
    },
  },
  {
    name: "qualified referral count uses effective qualification from current points",
    run: async () => {
      const capture: { countSql?: string } = {};
      const db = createQualifiedReferralCountDb({
        capture,
        referrals: [
          {
            referrer_user_id: "user-a",
            referred_user_id: "user-b",
            status: "pending",
          },
          {
            referrer_user_id: "user-a",
            referred_user_id: "user-c",
            status: "qualified",
          },
          {
            referrer_user_id: "user-a",
            referred_user_id: "user-d",
            status: "blocked",
          },
          {
            referrer_user_id: "user-a",
            referred_user_id: "user-e",
            status: "pending",
          },
        ],
        points: {
          "user-a": 750,
          "user-b": 600,
          "user-c": 800,
          "user-d": 900,
          "user-e": 100,
        },
      });

      const total = await fetchQualifiedReferralCount(db, {
        userId: "user-a",
        threshold: 500,
      });

      assert.equal(total, 2);
      assert.doesNotMatch(capture.countSql ?? "", /source_id like 'manual:%'/);
    },
  },
  {
    name: "qualified referral count includes manual qualification points",
    run: async () => {
      const db = createQualifiedReferralCountDb({
        referrals: [
          {
            referrer_user_id: "user-a",
            referred_user_id: "user-b",
            status: "pending",
          },
        ],
        points: {
          "user-a": 500,
          "user-b": 500,
        },
      });

      const total = await fetchQualifiedReferralCount(db, {
        userId: "user-a",
        threshold: 500,
      });

      assert.equal(total, 1);
    },
  },
  {
    name: "mark qualified referrals upgrades pending rows once threshold is met",
    run: async () => {
      const capture: { updateSql?: string } = {};
      const db = createQualifiedReferralCountDb({
        capture,
        referrals: [
          {
            referrer_user_id: "user-a",
            referred_user_id: "user-b",
            status: "pending",
          },
          {
            referrer_user_id: "user-a",
            referred_user_id: "user-c",
            status: "pending",
          },
        ],
        points: {
          "user-a": 600,
          "user-b": 550,
          "user-c": 250,
        },
      });

      await markQualifiedReferralsForUser(db, {
        userId: "user-a",
        threshold: 500,
      });

      const total = await fetchQualifiedReferralCount(db, {
        userId: "user-a",
        threshold: 500,
      });

      assert.equal(total, 1);
      assert.doesNotMatch(capture.updateSql ?? "", /source_id like 'manual:%'/);
    },
  },
  {
    name: "mark qualified referrals upgrades manual qualification rows",
    run: async () => {
      const db = createQualifiedReferralCountDb({
        referrals: [
          {
            referrer_user_id: "user-a",
            referred_user_id: "user-b",
            status: "pending",
          },
        ],
        points: {
          "user-a": 500,
          "user-b": 500,
        },
      });

      await markQualifiedReferralsForUser(db, {
        userId: "user-a",
        threshold: 500,
      });

      const total = await fetchQualifiedReferralCount(db, {
        userId: "user-a",
        threshold: 500,
      });

      assert.equal(total, 1);
    },
  },
  {
    name: "referrals order bonus desc uses deterministic tie breakers",
    run: () => {
      assert.equal(
        resolveRewardsReferralsOrderBy({ sortBy: "bonus", sortDir: "desc" }),
        "coalesce(rb.total_bonus, 0) desc, coalesce(p.points, 0) desc, rr.created_at desc, rr.id desc",
      );
    },
  },
  {
    name: "referrals order bonus asc uses deterministic tie breakers",
    run: () => {
      assert.equal(
        resolveRewardsReferralsOrderBy({ sortBy: "bonus", sortDir: "asc" }),
        "coalesce(rb.total_bonus, 0) asc, coalesce(p.points, 0) asc, rr.created_at asc, rr.id asc",
      );
    },
  },
  {
    name: "referrals order createdAt sorts by timestamp then id",
    run: () => {
      assert.equal(
        resolveRewardsReferralsOrderBy({
          sortBy: "createdAt",
          sortDir: "desc",
        }),
        "rr.created_at desc, rr.id desc",
      );
    },
  },
  {
    name: "manual points listing includes hidden and visible manual grants",
    run: async () => {
      const capture: {
        countSql?: string;
        listSql?: string;
        params: unknown[][];
      } = { params: [] };
      const db = createAdminManualPointsDb({ capture });

      const result = await fetchAdminManualVolumeEvents(db, {
        userId: "user-a",
        walletAddress: null,
        limit: 10,
        offset: 0,
      });

      assert.equal(result.total, 2);
      assert.equal(result.items.length, 2);
      assert.equal(result.items[0]?.visible, false);
      assert.equal(result.items[1]?.visible, true);
      assert.match(capture.countSql ?? "", /source_id like 'manual:%'/);
      assert.match(capture.countSql ?? "", /source_id like 'manual-visible:%'/);
      assert.match(capture.listSql ?? "", /source_id like 'manual:%'/);
      assert.match(capture.listSql ?? "", /source_id like 'manual-visible:%'/);
      assert.deepEqual(capture.params[0], ["user-a"]);
      assert.deepEqual(capture.params[1], ["user-a", 10, 0]);
    },
  },
  {
    name: "bulk adjustment preview is read-only and creates deterministic hidden sources",
    run: async () => {
      const capture = { insertCalls: 0, queries: [] as string[] };
      const db = createBulkAdjustmentDb({
        capture,
        users: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            publicPoints: 10,
            tierPoints: 20,
          },
        ],
      });

      const result = await previewAdminRewardsBulkAdjustment(db, {
        cohort: {
          activeOnly: true,
          createdBefore: "2026-07-09T00:00:00.000Z",
          excludeAdmins: true,
          requireWallet: false,
        },
        mode: "fixed_amount",
        runKey: "early-users-test",
        visibility: "hidden",
        amount: 500,
      });

      assert.equal(capture.insertCalls, 0);
      assert.equal(result.summary.matched, 1);
      assert.equal(result.summary.eligible, 1);
      assert.equal(
        result.items[0]?.sourceId,
        "manual:bulk:early-users-test:11111111-1111-1111-1111-111111111111",
      );
      assert.equal(result.items[0]?.resultingPublicPoints, 10);
      assert.equal(result.items[0]?.resultingTierPoints, 520);
    },
  },
  {
    name: "bulk adjustment visible fixed grant creates visible source and public points",
    run: async () => {
      const capture = { insertCalls: 0, queries: [] as string[] };
      const db = createBulkAdjustmentDb({
        capture,
        users: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            publicPoints: 10,
            tierPoints: 20,
          },
        ],
      });

      const result = await executeAdminRewardsBulkAdjustment(db, {
        cohort: {
          activeOnly: true,
          createdBefore: "2026-07-09T00:00:00.000Z",
          excludeAdmins: true,
          requireWallet: false,
        },
        mode: "fixed_amount",
        runKey: "visible-test",
        visibility: "visible",
        amount: 25,
        confirm: "EXECUTE BULK ADJUSTMENT",
      });

      assert.equal(result.summary.inserted, 1);
      assert.match(
        capture.queries[0] ?? "",
        /set transaction isolation level serializable/i,
      );
      assert.match(capture.queries[1] ?? "", /pg_advisory_xact_lock/i);
      assert.equal(
        result.items[0]?.sourceId,
        "manual-visible:bulk:visible-test:22222222-2222-2222-2222-222222222222",
      );
      assert.equal(result.items[0]?.resultingPublicPoints, 35);
      assert.equal(result.items[0]?.resultingTierPoints, 45);
    },
  },
  {
    name: "bulk adjustment retry helper retries transient write conflicts",
    run: async () => {
      let attempts = 0;

      const result = await retryAdminRewardsBulkAdjustmentExecute(async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("serialization failure") as Error & {
            code: string;
          };
          error.code = attempts === 1 ? "40001" : "40P01";
          throw error;
        }
        return "ok";
      });

      assert.equal(result, "ok");
      assert.equal(attempts, 3);
    },
  },
  {
    name: "bulk adjustment retry helper returns conflict after max transient retries",
    run: async () => {
      let attempts = 0;

      await assert.rejects(
        () =>
          retryAdminRewardsBulkAdjustmentExecute(async () => {
            attempts += 1;
            const error = new Error("serialization failure") as Error & {
              code: string;
            };
            error.code = "40001";
            throw error;
          }),
        AdminRewardsBulkAdjustmentRetryExhaustedError,
      );

      assert.equal(attempts, 3);
    },
  },
  {
    name: "bulk adjustment retry helper rethrows unexpected errors",
    run: async () => {
      let attempts = 0;
      const unexpected = new Error("database unavailable");

      await assert.rejects(
        () =>
          retryAdminRewardsBulkAdjustmentExecute(async () => {
            attempts += 1;
            throw unexpected;
          }),
        (error: unknown) => {
          assert.equal(error, unexpected);
          return true;
        },
      );

      assert.equal(attempts, 1);
    },
  },
  {
    name: "bulk adjustment top-up to tier resolves active policy and skips users above target",
    run: async () => {
      const db = createBulkAdjustmentDb({
        tiers: [
          { tier: 0, name: "Novice", points: 0, cashbackBps: 0 },
          { tier: 3, name: "Analyst", points: 30_000, cashbackBps: 3500 },
        ],
        users: [
          {
            id: "33333333-3333-3333-3333-333333333333",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            publicPoints: 100,
            tierPoints: 10_000,
          },
          {
            id: "44444444-4444-4444-4444-444444444444",
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
            publicPoints: 40_000,
            tierPoints: 40_000,
          },
        ],
      });

      const result = await previewAdminRewardsBulkAdjustment(db, {
        cohort: {
          activeOnly: true,
          createdBefore: "2026-07-09T00:00:00.000Z",
          excludeAdmins: true,
          requireWallet: false,
        },
        mode: "top_up_to_tier",
        runKey: "tier-test",
        visibility: "hidden",
        targetTier: 3,
      });

      assert.equal(result.targetPoints, 30_000);
      assert.equal(result.summary.matched, 2);
      assert.equal(result.summary.eligible, 1);
      assert.equal(result.summary.skipped, 1);
      assert.equal(result.items[0]?.grantAmount, 20_000);
      assert.equal(result.items[1]?.skippedReason, "at_or_above_target");
    },
  },
  {
    name: "bulk adjustment execute is idempotent for repeated run key",
    run: async () => {
      const db = createBulkAdjustmentDb({
        users: [
          {
            id: "55555555-5555-5555-5555-555555555555",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            publicPoints: 0,
            tierPoints: 0,
          },
        ],
      });
      const body = {
        cohort: {
          activeOnly: true,
          createdBefore: "2026-07-09T00:00:00.000Z",
          excludeAdmins: true,
          requireWallet: false,
        },
        mode: "top_up_to_points" as const,
        runKey: "retry-test",
        visibility: "hidden" as const,
        targetBasis: "tier_points" as const,
        targetPoints: 100,
        confirm: "EXECUTE BULK ADJUSTMENT" as const,
      };

      const first = await executeAdminRewardsBulkAdjustment(db, body);
      const second = await executeAdminRewardsBulkAdjustment(db, body);

      assert.equal(first.summary.inserted, 1);
      assert.equal(first.summary.alreadyExisting, 0);
      assert.equal(second.summary.inserted, 0);
      assert.equal(second.summary.alreadyExisting, 1);
      assert.equal(second.items[0]?.grantAmount, 100);
      assert.equal(second.items[0]?.existing, true);
    },
  },
  {
    name: "bulk adjustment run key is idempotent across visibility",
    run: async () => {
      const db = createBulkAdjustmentDb({
        users: [
          {
            id: "77777777-7777-7777-7777-777777777777",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            publicPoints: 0,
            tierPoints: 0,
          },
        ],
      });
      const base = {
        amount: 50,
        cohort: {
          activeOnly: true,
          createdBefore: "2026-07-09T00:00:00.000Z",
          excludeAdmins: true,
          requireWallet: false,
        },
        mode: "fixed_amount" as const,
        runKey: "same-run-visibility",
        confirm: "EXECUTE BULK ADJUSTMENT" as const,
      };

      const hidden = await executeAdminRewardsBulkAdjustment(db, {
        ...base,
        visibility: "hidden",
      });
      const visible = await executeAdminRewardsBulkAdjustment(db, {
        ...base,
        visibility: "visible",
      });

      assert.equal(hidden.summary.inserted, 1);
      assert.equal(visible.summary.inserted, 0);
      assert.equal(visible.summary.alreadyExisting, 1);
      assert.equal(visible.items[0]?.existing, true);
      assert.equal(
        visible.items[0]?.sourceId,
        "manual-visible:bulk:same-run-visibility:77777777-7777-7777-7777-777777777777",
      );
    },
  },
  {
    name: "bulk adjustment preview detects existing row from either visibility prefix",
    run: async () => {
      const existing = new Map<string, number>([
        [
          "manual-visible:bulk:existing-prefix:88888888-8888-8888-8888-888888888888",
          75,
        ],
      ]);
      const db = createBulkAdjustmentDb({
        users: [
          {
            id: "88888888-8888-8888-8888-888888888888",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            publicPoints: 75,
            tierPoints: 75,
            existing,
          },
        ],
      });

      const result = await previewAdminRewardsBulkAdjustment(db, {
        amount: 75,
        cohort: {
          activeOnly: true,
          createdBefore: "2026-07-09T00:00:00.000Z",
          excludeAdmins: true,
          requireWallet: false,
        },
        mode: "fixed_amount",
        runKey: "existing-prefix",
        visibility: "hidden",
      });

      assert.equal(result.summary.alreadyExisting, 1);
      assert.equal(result.items[0]?.existing, true);
      assert.equal(
        result.items[0]?.sourceId,
        "manual:bulk:existing-prefix:88888888-8888-8888-8888-888888888888",
      );
    },
  },
  {
    name: "bulk adjustment point basis excludes existing current-run sources",
    run: async () => {
      const existing = new Map<string, number>([
        [
          "manual-visible:bulk:exclude-current-run:99999999-9999-9999-9999-999999999999",
          50,
        ],
      ]);
      const db = createBulkAdjustmentDb({
        users: [
          {
            id: "99999999-9999-9999-9999-999999999999",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            publicPoints: 150,
            tierPoints: 150,
            existing,
          },
        ],
      });

      const result = await previewAdminRewardsBulkAdjustment(db, {
        cohort: {
          activeOnly: true,
          createdBefore: "2026-07-09T00:00:00.000Z",
          excludeAdmins: true,
          requireWallet: false,
        },
        mode: "top_up_to_points",
        runKey: "exclude-current-run",
        targetBasis: "tier_points",
        targetPoints: 200,
        visibility: "hidden",
      });

      assert.equal(result.items[0]?.tierPoints, 100);
      assert.equal(result.items[0]?.publicPoints, 100);
      assert.equal(result.items[0]?.grantAmount, 100);
      assert.equal(result.items[0]?.existing, true);
    },
  },
  {
    name: "bulk adjustment visible tier top-up warns that public points increase",
    run: async () => {
      const db = createBulkAdjustmentDb({
        users: [
          {
            id: "66666666-6666-6666-6666-666666666666",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            publicPoints: 5,
            tierPoints: 10,
          },
        ],
      });

      const result = await previewAdminRewardsBulkAdjustment(db, {
        cohort: {
          activeOnly: true,
          createdBefore: "2026-07-09T00:00:00.000Z",
          excludeAdmins: true,
          requireWallet: false,
        },
        mode: "top_up_to_points",
        runKey: "visible-tier-warning",
        visibility: "visible",
        targetBasis: "tier_points",
        targetPoints: 20,
      });

      assert.equal(result.warnings.length, 1);
      assert.equal(result.items[0]?.grantAmount, 10);
      assert.equal(result.items[0]?.resultingPublicPoints, 15);
      assert.equal(result.items[0]?.resultingTierPoints, 20);
    },
  },
  {
    name: "fetchReferralsForUser aggregates frozen referral bonus and maps numeric fields",
    run: async () => {
      const capture: { sql?: string; params?: unknown[] } = {};
      const db = createFetchReferralsDb({
        capture,
        rows: [
          {
            id: "ref-1",
            referred_user_id: "user-b",
            status: "qualified",
            qualified_at: new Date("2026-02-02T00:00:00.000Z"),
            created_at: new Date("2026-02-01T00:00:00.000Z"),
            wallet_address: "0xabc",
            points: "1250",
            bonus: "4.25",
          },
        ],
      });

      const rows = await fetchReferralsForUser(db, {
        userId: "user-a",
        sortBy: "bonus",
        sortDir: "desc",
        limit: 10,
        offset: 0,
      });

      assert.match(capture.sql ?? "", /sum\(fe\.referral_earned_usdc\)/);
      assert.match(capture.sql ?? "", /source_id like 'manual:%'/);
      assert.match(
        capture.sql ?? "",
        /fe\.liability_snapshot_source = 'event_time_frozen'/,
      );
      assert.match(capture.sql ?? "", /fe\.status <> 'failed'/);
      assert.deepEqual(capture.params, ["user-a", 10, 0]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.points, 1250);
      assert.equal(rows[0]?.bonus, 4.25);
      assert.equal(rows[0]?.wallet_address, "0xabc");
    },
  },
  {
    name: "getRewardsReferrals keeps manual tier grants hidden from displayed public points",
    run: async () => {
      const db = createFetchReferralsDb({
        referrerPoints: "500",
        rows: [
          {
            id: "ref-1",
            referred_user_id: "user-b",
            status: "qualified",
            qualified_at: new Date("2026-02-02T00:00:00.000Z"),
            created_at: new Date("2026-02-01T00:00:00.000Z"),
            wallet_address: "0xabc",
            points: "499",
            tier_points: "500",
            qualification_points: "500",
            bonus: "0",
          },
        ],
      });

      const result = await getRewardsReferrals(db, {
        userId: "user-a",
        sortBy: "bonus",
        sortDir: "desc",
        limit: 10,
        offset: 0,
      });

      assert.equal(result.referrals.length, 1);
      assert.equal(result.referrals[0]?.status, "qualified");
      assert.equal(
        result.referrals[0]?.qualifiedAt?.toISOString(),
        "2026-02-02T00:00:00.000Z",
      );
      assert.equal(result.referrals[0]?.points, 499);
      assert.equal(result.referrals[0]?.tier.tier, 1);
    },
  },
];

let passed = 0;
try {
  for (const test of tests) {
    try {
      await test.run();
      passed += 1;
    } catch (error) {
      console.error(`[rewards-tests] failed: ${test.name}`);
      throw error;
    }
  }
} finally {
  if (!process.argv[1]?.endsWith("test-runner.ts")) {
    await pool.end();
  }
}

console.log(`[rewards-tests] passed ${passed}/${tests.length}`);
