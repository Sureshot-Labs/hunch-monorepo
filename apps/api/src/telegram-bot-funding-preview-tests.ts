import assert from "node:assert/strict";

import {
  resolveTelegramBuyFundingPreview,
  resolveTelegramBuyFundingState,
} from "./services/telegram-bot-trading.js";

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "funding preview distinguishes router-ready, convert, and deposit",
    run: () => {
      assert.equal(
        resolveTelegramBuyFundingState({
          controlledFundsUsd: 5,
          executableFundsUsd: 1.06,
          requiredUsd: 1.06,
        }),
        "ready",
      );
      assert.equal(
        resolveTelegramBuyFundingState({
          controlledFundsUsd: 2,
          executableFundsUsd: 0.25,
          requiredUsd: 1.06,
        }),
        "convert",
      );
      assert.equal(
        resolveTelegramBuyFundingState({
          controlledFundsUsd: 0.25,
          executableFundsUsd: 0.25,
          requiredUsd: 1.06,
        }),
        "deposit",
      );
    },
  },
  {
    name: "funding preview computes fee-inclusive shortfall from controlled funds",
    run: () => {
      const preview = resolveTelegramBuyFundingPreview({
        controlledFundsUsd: 0.75,
        executableFundsUsd: 0.25,
        requiredUsd: 1.06,
      });
      assert.equal(preview.availableUsd, 0.75);
      assert.ok(Math.abs(preview.shortfallUsd - 0.31) < 1e-9);
      assert.equal(preview.state, "deposit");
    },
  },
];

for (const test of tests) {
  try {
    await test.run();
    console.log(`✓ ${test.name}`);
  } catch (error) {
    console.error(`✗ ${test.name}`);
    throw error;
  }
}
