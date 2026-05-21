#!/usr/bin/env tsx

import assert from "node:assert/strict";
import {
  getMarketMapDropReason,
  hasMarketMapOddsSignal,
  isMarketMapUsable,
} from "./services/market-map-quality.js";

type TestCase = {
  name: string;
  run: () => void;
};

const tests: TestCase[] = [
  {
    name: "missing token pair is excluded",
    run: () => {
      const usable = isMarketMapUsable({
        tokenYes: "yes-token",
        tokenNo: null,
        acceptingOrders: true,
        yesBid: 0.41,
      });
      assert.equal(usable, false);
      assert.equal(
        getMarketMapDropReason({
          tokenYes: "yes-token",
          tokenNo: null,
          acceptingOrders: true,
          yesBid: 0.41,
        }),
        "missing_token_pair",
      );
    },
  },
  {
    name: "explicitly untradeable market is excluded",
    run: () => {
      const reason = getMarketMapDropReason({
        tokenYes: "yes-token",
        tokenNo: "no-token",
        acceptingOrders: false,
        yesBid: 0.52,
      });
      assert.equal(reason, "untradeable");
    },
  },
  {
    name: "resolved market is excluded",
    run: () => {
      const reason = getMarketMapDropReason({
        tokenYes: "yes-token",
        tokenNo: "no-token",
        acceptingOrders: true,
        marketStatus: "ACTIVE",
        resolvedOutcome: "YES",
        yesBid: 1,
      });
      assert.equal(reason, "untradeable");
    },
  },
  {
    name: "past close market is excluded",
    run: () => {
      const reason = getMarketMapDropReason({
        tokenYes: "yes-token",
        tokenNo: "no-token",
        acceptingOrders: true,
        marketStatus: "ACTIVE",
        closeTime: new Date(Date.now() - 60_000).toISOString(),
        yesBid: 0.52,
      });
      assert.equal(reason, "untradeable");
    },
  },
  {
    name: "null odds market is excluded",
    run: () => {
      const reason = getMarketMapDropReason({
        tokenYes: "yes-token",
        tokenNo: "no-token",
        acceptingOrders: true,
        marketStatus: "ACTIVE",
      });
      assert.equal(reason, "missing_odds");
      assert.equal(
        hasMarketMapOddsSignal({
          tokenYes: "yes-token",
          tokenNo: "no-token",
          acceptingOrders: true,
          marketStatus: "ACTIVE",
        }),
        false,
      );
    },
  },
  {
    name: "fallback odds fields are accepted",
    run: () => {
      const usable = isMarketMapUsable({
        tokenYes: "yes-token",
        tokenNo: "no-token",
        acceptingOrders: true,
        marketStatus: "ACTIVE",
        lastPrice: 0.63,
      });
      assert.equal(usable, true);
    },
  },
  {
    name: "probability-only odds signal is accepted",
    run: () => {
      const usable = isMarketMapUsable({
        tokenYes: "yes-token",
        tokenNo: "no-token",
        acceptingOrders: true,
        marketStatus: "ACTIVE",
        yesProbability: 0.12,
      });
      assert.equal(usable, true);
    },
  },
];

let passed = 0;
for (const test of tests) {
  test.run();
  passed += 1;
  console.log(`[market-map-quality-tests] ok ${test.name}`);
}

console.log(`[market-map-quality-tests] passed ${passed}/${tests.length}`);
