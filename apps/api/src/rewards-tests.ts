#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { normalizeRewardsChainId } from "./lib/rewards-chain.js";
import {
  parseUsdcToMicro,
  parseUsdcToMicroFloor,
  usdcDecimalStringHasValidScale,
  usdcMicroFromUnsafeNumber,
  usdcMicroToDecimalString,
} from "./lib/usdc.js";
import {
  computeCashbackBreakdown,
  resolveEffectiveBps,
  type RewardsPolicy,
} from "./services/rewards.js";
import {
  computeTreasuryChainMath,
} from "./services/rewards-treasury.js";
import {
  resolveBlockedRewardsMigrations,
} from "./rewards-migration-preflight.js";

type TestCase = {
  name: string;
  run: () => void;
};

function toNumber(value: bigint): number {
  return Number(usdcMicroToDecimalString(value));
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
];

let passed = 0;
for (const test of tests) {
  try {
    test.run();
    passed += 1;
  } catch (error) {
    console.error(`[rewards-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[rewards-tests] passed ${passed}/${tests.length}`);
