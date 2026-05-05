#!/usr/bin/env tsx

import assert from "node:assert/strict";
import {
  POLYMARKET_UNCONFIRMED_STATUS,
  resolvePolymarketUnconfirmedStatus,
  summarizePolymarketOnchainOrderExecution,
} from "./services/polymarket-order-execution.js";

type TestCase = {
  name: string;
  run: () => void;
};

const tests: TestCase[] = [
  {
    name: "summarize execution marks maker fill when remaining drops",
    run: () => {
      const summary = summarizePolymarketOnchainOrderExecution({
        makerAmount: 1_000_000n,
        remaining: 250_000n,
        isFilledOrCancelled: false,
      });
      assert.equal(summary.makerFilled, 750_000n);
      assert.equal(summary.hasExecution, true);
    },
  },
  {
    name: "unconfirmed stays unconfirmed when order is still live",
    run: () => {
      const resolution = resolvePolymarketUnconfirmedStatus({
        hasExecution: false,
        isFilledOrCancelled: false,
      });
      assert.equal(resolution, POLYMARKET_UNCONFIRMED_STATUS);
    },
  },
  {
    name: "unconfirmed resolves to unmatched when cancelled with no fill",
    run: () => {
      const resolution = resolvePolymarketUnconfirmedStatus({
        hasExecution: false,
        isFilledOrCancelled: true,
      });
      assert.equal(resolution, "unmatched");
    },
  },
  {
    name: "unconfirmed resolves to matched when on-chain execution exists",
    run: () => {
      const resolution = resolvePolymarketUnconfirmedStatus({
        hasExecution: true,
        isFilledOrCancelled: true,
      });
      assert.equal(resolution, "matched");
    },
  },
];

let passed = 0;
for (const test of tests) {
  test.run();
  passed += 1;
  console.log(`[polymarket-order-execution-tests] ok ${test.name}`);
}

console.log(
  `[polymarket-order-execution-tests] passed ${passed}/${tests.length}`,
);
