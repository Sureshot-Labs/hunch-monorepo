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
    name: "published Hunch emoji IDs stay pinned to their semantic names",
    run: () => {
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(TELEGRAM_CUSTOM_EMOJI).map(([name, emoji]) => [
            name,
            emoji.id,
          ]),
        ),
        {
          base: "5398023908177780475",
          hunch: "5397843223198607684",
          hyperliquid: "5398028456548149441",
          kalshi: "5398048814693133057",
          limitless: "5397603233311008494",
          polygon: "5397682080320627397",
          polymarket: "5397868305807613791",
          solana: "5397929071004918446",
          usdc: "5400178203643911271",
        },
      );
    },
  },
  {
    name: "USDC, USDC.e, and pUSD resolve to the same custom emoji",
    run: () => {
      for (const asset of ["USDC", "usdc.e", "pUSD"]) {
        assert.equal(telegramAssetCustomEmojiName(asset), "usdc");
      }
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
    name: "fallback removes entities and native button icons without losing copy",
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
          ],
        }),
        {
          inline_keyboard: [[{ callback_data: "trade", text: "Polymarket" }]],
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
