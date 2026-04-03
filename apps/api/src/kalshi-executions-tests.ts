#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  getKalshiExecutionPurpose,
  normalizeDflowOrderStatusPayload,
  normalizeKalshiExecutionStatus,
} from "./services/kalshi-executions.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const tests: TestCase[] = [
  {
    name: "normalizes DFlow open status",
    run: () => {
      const normalized = normalizeDflowOrderStatusPayload({
        status: "open",
        fills: [],
      });
      assert.deepEqual(normalized?.status, "open");
    },
  },
  {
    name: "normalizes DFlow pendingClose status",
    run: () => {
      const normalized = normalizeDflowOrderStatusPayload({
        status: "pendingClose",
        fills: [],
      });
      assert.deepEqual(normalized?.status, "pending_close");
    },
  },
  {
    name: "normalizes DFlow closed status with fills to fulfilled",
    run: () => {
      const normalized = normalizeDflowOrderStatusPayload({
        status: "closed",
        fills: [{ signature: "sig" }],
      });
      assert.deepEqual(normalized?.status, "fulfilled");
    },
  },
  {
    name: "normalizes DFlow closed status without fills to no_fill",
    run: () => {
      const normalized = normalizeDflowOrderStatusPayload({
        status: "closed",
        fills: [],
      });
      assert.deepEqual(normalized?.status, "no_fill");
    },
  },
  {
    name: "recognizes redeem purpose from execution raw",
    run: () => {
      assert.equal(getKalshiExecutionPurpose({ purpose: "redeem" }), "redeem");
      assert.equal(getKalshiExecutionPurpose({ purpose: "trade" }), "trade");
      assert.equal(getKalshiExecutionPurpose(null), "trade");
    },
  },
  {
    name: "normalizes stored execution status values",
    run: () => {
      assert.equal(normalizeKalshiExecutionStatus("pending_close"), "pending_close");
      assert.equal(normalizeKalshiExecutionStatus("fulfilled"), "fulfilled");
      assert.equal(normalizeKalshiExecutionStatus("unknown"), null);
    },
  },
];

for (const testCase of tests) {
  await Promise.resolve(testCase.run());
  console.log(`[kalshi-executions-tests] ok ${testCase.name}`);
}
