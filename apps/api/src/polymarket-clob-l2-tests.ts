#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  extractSingleOrder,
  normalizeOpenOrder,
} from "./services/polymarket-clob-l2.js";

type TestCase = {
  name: string;
  run: () => void;
};

const tests: TestCase[] = [
  {
    name: "extractSingleOrder accepts raw order response",
    run: () => {
      const payload = {
        id: "0xabc",
        status: "matched",
        price: "0.2",
        side: "BUY",
        size_matched: "5",
      };

      assert.equal(extractSingleOrder(payload), payload);
    },
  },
  {
    name: "normalizeOpenOrder accepts camelCase fields",
    run: () => {
      const order = normalizeOpenOrder({
        orderId: "0xabc",
        status: "matched",
        price: "0.2",
        side: "BUY",
        sizeMatched: "5",
        associateTrades: [" trade-1 ", ""],
        assetId: "123",
        createdAt: "2026-05-28T16:00:00Z",
      });

      assert.ok(order);
      assert.equal(order.id, "0xabc");
      assert.equal(order.status, "matched");
      assert.equal(order.price, "0.2");
      assert.equal(order.side, "BUY");
      assert.equal(order.sizeMatched, "5");
      assert.deepEqual(order.associateTrades, ["trade-1"]);
      assert.equal(order.assetId, "123");
      assert.equal(order.createdAt, "2026-05-28T16:00:00Z");
    },
  },
];

let passed = 0;
for (const test of tests) {
  test.run();
  passed += 1;
  console.log(`[polymarket-clob-l2-tests] ok ${test.name}`);
}

console.log(`[polymarket-clob-l2-tests] passed ${passed}/${tests.length}`);
