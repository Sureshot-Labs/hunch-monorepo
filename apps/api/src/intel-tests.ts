#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  fetchActiveRuntimePolicy,
  listActiveRuntimePolicies,
} from "./repos/runtime-policies.js";
import { resolveIntelPolicy } from "./services/runtime-policies.js";

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

