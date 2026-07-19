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
          base: "5398022443593935276",
          hunch: "5397843223198607684",
          hyperliquid: "5399869069077813370",
          kalshi: "5398021142218842700",
          limitless: "5399931384758312849",
          polygon: "5397636596616964415",
          polymarket: "5397742643654470005",
          solana: "5397588853760501094",
          usdc: "5397914592670165457",
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
