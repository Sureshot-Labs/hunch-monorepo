import assert from "node:assert/strict";

import {
  stripTelegramCustomEmojiButtonIcons,
  stripTelegramCustomEmojiMarkdownV2,
  TELEGRAM_CUSTOM_EMOJI,
  telegramAssetCustomEmojiName,
  telegramCustomEmojiIdForVenue,
  telegramCustomEmojiMarkdownV2,
  telegramNetworkCustomEmojiName,
  telegramVenueCustomEmojiName,
} from "./services/telegram-custom-emoji.js";
import {
  formatTelegramVenueButtonIcon,
  formatTelegramVenueLabelMarkdownV2,
} from "./services/telegram-market-identity.js";

const tests: Array<{ name: string; run: () => void }> = [
  {
    name: "published Hunch emoji IDs and fallbacks stay pinned to semantics",
    run: () => {
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(TELEGRAM_CUSTOM_EMOJI).map(([name, emoji]) => [
            name,
            emoji.id,
          ]),
        ),
        {
          base: "5399884702758770830",
          positionBuy: "5269682928094325366",
          positionSell: "5269614187142752548",
          hunch: "5400370308941127529",
          hyperliquid: "5397762885835332158",
          kalshi: "5399820394213450697",
          limitless: "5400267199661253196",
          polygon: "5399966058029293176",
          polymarket: "5397905371375383129",
          solana: "5400271155326130010",
          usdc: "5400187523722944017",
        },
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(TELEGRAM_CUSTOM_EMOJI).map(([name, emoji]) => [
            name,
            emoji.fallback,
          ]),
        ),
        {
          base: "🟦",
          positionBuy: "⬆️",
          positionSell: "⬇️",
          hunch: "🟠",
          hyperliquid: "♾️",
          kalshi: "♻️",
          limitless: "↔️",
          polygon: "🟣",
          polymarket: "🔵",
          solana: "🪙",
          usdc: "💲",
        },
      );
    },
  },
  {
    name: "funding assets reuse their matching USDC and Solana custom emoji",
    run: () => {
      for (const asset of ["USDC", "usdc.e", "pUSD"]) {
        assert.equal(telegramAssetCustomEmojiName(asset), "usdc");
      }
      assert.equal(telegramAssetCustomEmojiName("SOL"), "solana");
    },
  },
  {
    name: "venue and network aliases resolve case-insensitively",
    run: () => {
      assert.equal(telegramVenueCustomEmojiName(" Polymarket "), "polymarket");
      assert.equal(telegramVenueCustomEmojiName("LIMITLESS"), "limitless");
      assert.equal(telegramVenueCustomEmojiName("Kalshi"), "kalshi");
      assert.equal(telegramVenueCustomEmojiName("Hyperliquid"), "hyperliquid");
      assert.equal(telegramNetworkCustomEmojiName("Polygon"), "polygon");
      assert.equal(telegramNetworkCustomEmojiName("Base"), "base");
      assert.equal(telegramNetworkCustomEmojiName("Solana"), "solana");
      assert.equal(telegramVenueCustomEmojiName("unknown"), null);
      assert.match(
        formatTelegramVenueLabelMarkdownV2("hyperliquid"),
        /Hyperliquid/,
      );
    },
  },
  {
    name: "MarkdownV2 entities and button icons use the same venue ID",
    run: () => {
      const polymarketId = TELEGRAM_CUSTOM_EMOJI.polymarket.id;
      assert.equal(
        telegramCustomEmojiMarkdownV2("polymarket"),
        `![🔵](tg://emoji?id=${polymarketId})`,
      );
      assert.equal(telegramCustomEmojiIdForVenue("polymarket"), polymarketId);
      assert.equal(formatTelegramVenueButtonIcon("polymarket"), polymarketId);
      assert.equal(
        formatTelegramVenueLabelMarkdownV2("polymarket"),
        `![🔵](tg://emoji?id=${polymarketId}) Polymarket`,
      );
    },
  },
  {
    name: "text entities keep one space before their semantic label",
    run: () => {
      for (const venue of [
        "polymarket",
        "limitless",
        "kalshi",
        "hyperliquid",
      ]) {
        assert.match(
          formatTelegramVenueLabelMarkdownV2(venue),
          /\(tg:\/\/emoji\?id=\d+\) [A-Z]/,
        );
      }
    },
  },
  {
    name: "fallback removes native button icons and preserves position action semantics",
    run: () => {
      assert.equal(
        stripTelegramCustomEmojiMarkdownV2(
          `${telegramCustomEmojiMarkdownV2("polymarket")} Polymarket`,
        ),
        "🔵 Polymarket",
      );
      assert.deepEqual(
        stripTelegramCustomEmojiButtonIcons({
          inline_keyboard: [
            [
              {
                callback_data: "trade",
                icon_custom_emoji_id: TELEGRAM_CUSTOM_EMOJI.polymarket.id,
                text: "Polymarket",
              },
            ],
            [
              {
                callback_data: "buy",
                icon_custom_emoji_id: TELEGRAM_CUSTOM_EMOJI.positionBuy.id,
                text: "Buy",
              },
            ],
            [
              {
                callback_data: "sell",
                icon_custom_emoji_id: TELEGRAM_CUSTOM_EMOJI.positionSell.id,
                text: "Sell",
              },
            ],
          ],
        }),
        {
          inline_keyboard: [
            [{ callback_data: "trade", text: "Polymarket" }],
            [{ callback_data: "buy", text: "⬆️ Buy" }],
            [{ callback_data: "sell", text: "⬇️ Sell" }],
          ],
        },
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    test.run();
    passed += 1;
  } catch (error) {
    console.error(`[telegram-custom-emoji-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[telegram-custom-emoji-tests] passed ${passed}/${tests.length}`);
