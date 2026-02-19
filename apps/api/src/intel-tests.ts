#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  fetchActiveRuntimePolicy,
  listActiveRuntimePolicies,
} from "./repos/runtime-policies.js";
import {
  resolveIntelPolicy,
  resolveSignalWindowHours,
} from "./services/runtime-policies.js";
import {
  evaluateSignalMarketWindow,
  mergeWalletIdsForScope,
} from "./services/wallet-intel-filters.js";
import {
  computeApproxLegPnlUsd,
  NET_SHARES_EPSILON,
} from "./services/wallet-intel-pnl.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const tests: TestCase[] = [
  {
    name: "runtime policy reads fall back when migration table is missing",
    run: async () => {
      const missingTableDb = {
        query: async () => {
          const error = new Error("relation does not exist") as Error & {
            code?: string;
          };
          error.code = "42P01";
          throw error;
        },
      } as import("./db.js").DbQuery;

      const row = await fetchActiveRuntimePolicy(
        missingTableDb,
        "wallet_intel_signals",
      );
      const rows = await listActiveRuntimePolicies(missingTableDb);

      assert.equal(row, null);
      assert.deepEqual(rows, []);
    },
  },
  {
    name: "runtime policy sanitizer ignores deprecated override fields",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000001",
              policy_key: "arbitrage_defaults",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                limit: 30,
                minVenueCount: 3,
                minSpread: 0.07,
                minQualityScore: 0.7,
                minAnalysisConfidence: 0.8, // deprecated key
                maxOutlierRatio: 0.2, // deprecated key
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "arbitrage_defaults");
      assert.equal(resolved.source, "db");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.effective.limit, 30);
      assert.equal(resolved.effective.minVenueCount, 3);
      assert.equal(resolved.effective.minSpread, 0.07);
      assert.equal(resolved.effective.minQualityScore, 0.7);
      assert.equal(
        "minAnalysisConfidence" in (resolved.effective as Record<string, unknown>),
        false,
      );
      assert.equal(
        "maxOutlierRatio" in (resolved.effective as Record<string, unknown>),
        false,
      );
    },
  },
  {
    name: "signal window hours resolve uses policy default and max clamp",
    run: () => {
      const policy = {
        windowHoursDefault: 36,
        windowHoursMax: 48,
      };

      assert.equal(resolveSignalWindowHours(undefined, policy), 36);
      assert.equal(resolveSignalWindowHours(12, policy), 12);
      assert.equal(resolveSignalWindowHours(200, policy), 48);
      assert.equal(
        resolveSignalWindowHours(24, { windowHoursDefault: 72, windowHoursMax: 24 }),
        24,
      );
    },
  },
  {
    name: "runtime policy boolean parsing honors explicit true/false strings",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000002",
              policy_key: "ai_clusters",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                analysisEnabled: "false",
                useWebContext: "true",
                debugLogs: false,
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "ai_clusters");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.analysisEnabled, false);
      assert.equal(resolved.effective.useWebContext, true);
      assert.equal(resolved.effective.debugLogs, false);
    },
  },
  {
    name: "runtime policy boolean parsing rejects non-boolean strings",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000003",
              policy_key: "ai_whale_profiles",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                autoRun: "nope",
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "ai_whale_profiles");
      assert.equal(resolved.invalidOverride, true);
      assert.equal(resolved.source, "env");
    },
  },
  {
    name: "scope=all wallet candidates use following+active union with dedupe",
    run: () => {
      const merged = mergeWalletIdsForScope(
        "all",
        ["follow-a", "shared", "follow-b"],
        ["active-a", "shared", "active-b"],
      );
      assert.deepEqual(merged, [
        "follow-a",
        "shared",
        "follow-b",
        "active-a",
        "active-b",
      ]);
      assert.deepEqual(
        mergeWalletIdsForScope("following", ["a", "b"], ["c"]),
        ["a", "b"],
      );
      assert.deepEqual(mergeWalletIdsForScope("active", ["a"], ["b", "c"]), [
        "b",
        "c",
      ]);
    },
  },
  {
    name: "signal market open-now gate requires ACTIVE unresolved with future close",
    run: () => {
      const nowMs = Date.UTC(2026, 1, 19, 12, 0, 0);
      const future = new Date(nowMs + 60_000);
      const past = new Date(nowMs - 60_000);

      const open = evaluateSignalMarketWindow(
        {
          marketStatus: "ACTIVE",
          resolvedOutcome: null,
          closeTime: future,
          expirationTime: null,
        },
        nowMs,
      );
      assert.equal(open.isOpenNow, true);
      assert.equal(open.isActiveWithInvalidClose, false);

      const missingClose = evaluateSignalMarketWindow(
        {
          marketStatus: "ACTIVE",
          resolvedOutcome: null,
          closeTime: null,
          expirationTime: null,
        },
        nowMs,
      );
      assert.equal(missingClose.isOpenNow, false);
      assert.equal(missingClose.isActiveWithInvalidClose, true);

      const pastClose = evaluateSignalMarketWindow(
        {
          marketStatus: "ACTIVE",
          resolvedOutcome: null,
          closeTime: past,
          expirationTime: null,
        },
        nowMs,
      );
      assert.equal(pastClose.isOpenNow, false);
      assert.equal(pastClose.isActiveWithInvalidClose, true);

      const resolved = evaluateSignalMarketWindow(
        {
          marketStatus: "ACTIVE",
          resolvedOutcome: "YES",
          closeTime: future,
          expirationTime: null,
        },
        nowMs,
      );
      assert.equal(resolved.isOpenNow, false);
      assert.equal(resolved.isResolved, true);
    },
  },
  {
    name: "approx pnl scenario matrix stays aligned with refresh formula semantics",
    run: () => {
      const buyHold = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 10,
        netCost: 5,
        markPrice: 0.6,
      });
      assert.ok(Math.abs((buyHold ?? 0) - 1) < 1e-9);

      const buySell = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 6,
        netCost: 2.8,
        markPrice: 0.6,
      });
      assert.ok(Math.abs((buySell ?? 0) - 0.8) < 1e-9);

      const resolvedWin = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 4,
        netCost: 1.2,
        resolvedOutcome: "YES",
      });
      assert.ok(Math.abs((resolvedWin ?? 0) - 2.8) < 1e-9);

      const resolvedLoss = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 4,
        netCost: 1.2,
        resolvedOutcome: "NO",
      });
      assert.ok(Math.abs((resolvedLoss ?? 0) + 1.2) < 1e-9);

      const clampedHigh = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 2,
        netCost: 0.5,
        markPrice: 1.8,
      });
      assert.ok(Math.abs((clampedHigh ?? 0) - 1.5) < 1e-9);

      const clampedLow = computeApproxLegPnlUsd({
        outcomeSide: "NO",
        netShares: 3,
        netCost: 1.2,
        markPrice: -4,
      });
      assert.ok(Math.abs((clampedLow ?? 0) - 1.8) < 1e-9);

      const nearZeroNetShares = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: NET_SHARES_EPSILON / 2,
        netCost: 1,
        markPrice: 0.9,
      });
      assert.equal(nearZeroNetShares, null);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[intel-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[intel-tests] passed ${passed}/${tests.length}`);
