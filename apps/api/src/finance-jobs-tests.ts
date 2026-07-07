#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  isTelegramTradeIntentReconcileSchemaReady,
  runTelegramTradeIntentReconcileJob,
} from "./jobs/finance-jobs.js";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const tests: TestCase[] = [
  {
    name: "telegram trade intent reconcile skips when schema is missing",
    run: async () => {
      const queries: string[] = [];
      const db = {
        query: async (sql: string) => {
          queries.push(sql);
          return {
            rowCount: 1,
            rows: [
              {
                has_submit_started_at: false,
                has_telegram_trade_intents: false,
              },
            ],
          };
        },
      };

      const ready = await isTelegramTradeIntentReconcileSchemaReady(
        db as never,
      );
      const summary = await runTelegramTradeIntentReconcileJob({
        db: db as never,
      });

      assert.equal(ready, false);
      assert.equal(summary.skipped, true);
      assert.equal(
        summary.skipReason,
        "telegram_trade_intents_schema_not_ready",
      );
      assert.equal(summary.expiredPending, 0);
      assert.equal(queries.length, 2);
      assert.doesNotMatch(queries.join("\n"), /UPDATE telegram_trade_intents/);
    },
  },
  {
    name: "telegram trade intent reconcile runs when schema is ready",
    run: async () => {
      const queries: string[] = [];
      const db = {
        query: async (sql: string) => {
          queries.push(sql);
          if (/information_schema/i.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  has_submit_started_at: true,
                  has_telegram_trade_intents: true,
                },
              ],
            };
          }
          return { rowCount: 0, rows: [] };
        },
      };

      const summary = await runTelegramTradeIntentReconcileJob({
        db: db as never,
        executingGraceMs: 1,
      });

      assert.equal(summary.skipped, false);
      assert.equal(summary.expiredPending, 0);
      assert.match(queries.join("\n"), /UPDATE telegram_trade_intents/);
      assert.match(queries.join("\n"), /submit_started_at/);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
    console.log(`ok - ${test.name}`);
  } catch (error) {
    console.error(`not ok - ${test.name}`);
    throw error;
  }
}

console.log(`[finance-jobs-tests] passed ${passed}/${tests.length}`);
