import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  resolveTelegramBuyFundingPreview,
  resolveTelegramBuyFundingState,
  telegramBotTradingTestHooks,
} from "./services/telegram-bot-trading.js";
import {
  formatTelegramBlockquoteMarkdownV2,
  joinTelegramMarkdownV2Lines,
  TELEGRAM_VISUAL_BLANK_LINE,
} from "./services/telegram-bot-trading-presentation.js";
import { TELEGRAM_CUSTOM_EMOJI } from "./services/telegram-custom-emoji.js";

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "menu text preserves a visual blank row after blockquotes",
    run: () => {
      const quote = formatTelegramBlockquoteMarkdownV2([
        "⚠️ *Important*",
        "Quoted explanation\\.",
      ]);
      assert.equal(
        joinTelegramMarkdownV2Lines([quote, "", "Next section\\."]),
        `${quote}\n${TELEGRAM_VISUAL_BLANK_LINE}\nNext section\\.`,
      );
      assert.equal(joinTelegramMarkdownV2Lines([quote]), quote);
    },
  },
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
  {
    name: "convert and shortfall messages reuse the canonical deposit presentation",
    run: () => {
      const source = readFileSync(
        new URL("./services/telegram-bot-trading.ts", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("const depositPresentation =");
      const end = source.indexOf("const previewRecorded =", start);
      assert.ok(start >= 0 && end > start);
      const fundingBlock = source.slice(start, end);
      assert.match(
        fundingBlock,
        /buildTelegramDepositAddressPresentation\(\{[\s\S]*?venue: "polymarket"/,
      );
      assert.equal(
        fundingBlock.match(/depositPresentation\?\.buttonRows/g)?.length,
        2,
      );
      assert.match(
        fundingBlock,
        /formatTelegramBoldMarkdownV2\("Deposit instead"\)[\s\S]*?\.\.\.depositPresentation\.markdownV2Lines/,
      );
      assert.match(
        fundingBlock,
        /\.\.\.\(depositPresentation\?\.markdownV2Lines \?\? \[/,
      );
      assert.equal(
        fundingBlock.match(/formatTelegramVenueFieldMarkdownV2\(/g)?.length,
        2,
      );
    },
  },
  {
    name: "trade lifecycle and pUSD lines use semantic custom emoji",
    run: () => {
      const lifecycle =
        telegramBotTradingTestHooks.formatTelegramTradeLifecycleMessageMarkdownV2(
          {
            heading: "Trade submitted.",
            lines: ["BUY YES · $10.00", "Check /trade_status before retrying."],
            marketTitle: "Will it happen?",
            venue: "polymarket",
          },
        );
      assert.match(lifecycle, new RegExp(TELEGRAM_CUSTOM_EMOJI.polymarket.id));
      assert.match(lifecycle, /\) \*Venue:\* Polymarket/);
      assert.match(lifecycle, /Check `\/trade_status` before retrying\\\./);
      const payout =
        telegramBotTradingTestHooks.formatTelegramUsdcLineMarkdownV2(
          "Received: $10.00 pUSD",
        );
      assert.match(payout, new RegExp(TELEGRAM_CUSTOM_EMOJI.usdc.id));
      assert.match(payout, /\) \*Received:\*/);
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
