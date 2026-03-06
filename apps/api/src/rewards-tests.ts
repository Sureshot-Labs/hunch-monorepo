#!/usr/bin/env tsx

import assert from "node:assert/strict";
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
  resolveEffectiveBps,
  setReferralCodeForUser,
  type RewardsPolicy,
} from "./services/rewards.js";
import {
  fetchQualifiedReferralCount,
  markQualifiedReferralsForUser,
} from "./repos/rewards.js";
import {
  capTreasurySweepAmountMicro,
  computeTreasuryChainMath,
} from "./services/rewards-treasury.js";
import {
  resolveBlockedRewardsMigrations,
} from "./rewards-migration-preflight.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

function toNumber(value: bigint): number {
  return Number(usdcMicroToDecimalString(value));
}

function createReferralDb(
  seed: Array<{ id: string; referral_code: string | null }>,
): import("./db.js").DbQuery {
  const users = seed.map((row) => ({ ...row }));
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
        return { rows: row ? [{ id: row.id, referral_code: row.referral_code }] : [] };
      }

      if (sql.includes("upper(referral_code) = upper($1)")) {
        const code = String(values[0] ?? "").toUpperCase();
        const row =
          users.find(
            (user) => user.referral_code?.toUpperCase() === code,
          ) ?? null;
        return { rows: row ? [{ id: row.id, referral_code: row.referral_code }] : [] };
      }

      if (sql.includes("update users set referral_code = $2 where id = $1")) {
        const userId = String(values[0] ?? "");
        const referralCode =
          values[1] == null ? null : String(values[1]);
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
  } as import("./db.js").DbQuery;
}

function createReferralAttachDb(seed: {
  users: Array<{
    id: string;
    referral_code: string | null;
    username?: string | null;
    display_name?: string | null;
  }>;
  referrals?: Array<{
    referrer_user_id: string;
    referred_user_id: string;
    code: string;
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
    qualified_at: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...row,
  }));

  return {
    query: async (sql: string, params?: unknown[]) => {
      const values = Array.isArray(params) ? params : [];
      if (
        sql.includes("from referrals r") &&
        sql.includes("where r.referred_user_id = $1")
      ) {
        const userId = String(values[0] ?? "");
        const row = referrals.find((entry) => entry.referred_user_id === userId);
        if (!row) return { rows: [] };
        const referrer =
          users.find((entry) => entry.id === row.referrer_user_id) ?? null;
        return {
          rows: [
            {
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

      if (sql.includes("upper(referral_code) = upper($1)")) {
        const code = String(values[0] ?? "").toUpperCase();
        const row =
          users.find((entry) => entry.referral_code?.toUpperCase() === code) ?? null;
        return { rows: row ? [{ id: row.id }] : [] };
      }

      if (
        sql.includes("insert into referrals") &&
        sql.includes("on conflict (referred_user_id) do nothing")
      ) {
        const referrerUserId = String(values[0] ?? "");
        const referredUserId = String(values[1] ?? "");
        const code = String(values[2] ?? "");
        const status = String(values[3] ?? "pending") as
          | "pending"
          | "qualified"
          | "blocked";
        const qualifiedAt =
          values[4] instanceof Date
            ? (values[4] as Date)
            : values[4] == null
              ? null
              : new Date(String(values[4]));
        if (referrals.some((entry) => entry.referred_user_id === referredUserId)) {
          return { rows: [] };
        }
        referrals.push({
          referrer_user_id: referrerUserId,
          referred_user_id: referredUserId,
          code,
          status,
          qualified_at: qualifiedAt,
          created_at: new Date("2026-02-01T00:00:00.000Z"),
        });
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
}): import("./db.js").DbQuery {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const values = Array.isArray(params) ? params : [];

      if (
        sql.includes("select count(*)::text as total") &&
        sql.includes("from referrals r") &&
        sql.includes("left join points pref")
      ) {
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

      throw new Error(`Unhandled SQL in qualified referral count test db: ${sql}`);
    },
  } as import("./db.js").DbQuery;
}

const samplePolicy: RewardsPolicy = {
  effectiveAt: null,
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
      assert.equal(calls[0], "select pg_advisory_xact_lock(hashtext($1)::bigint)");
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
    name: "get referral attachment status returns empty when not attached",
    run: async () => {
      const db = createReferralAttachDb({
        users: [{ id: "user-a", referral_code: null }],
      });
      const status = await getReferralAttachmentStatus(db, { userId: "user-a" });
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
    name: "qualified referral count uses effective qualification from current points",
    run: async () => {
      const db = createQualifiedReferralCountDb({
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
    },
  },
  {
    name: "mark qualified referrals upgrades pending rows once threshold is met",
    run: async () => {
      const db = createQualifiedReferralCountDb({
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
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[rewards-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[rewards-tests] passed ${passed}/${tests.length}`);
