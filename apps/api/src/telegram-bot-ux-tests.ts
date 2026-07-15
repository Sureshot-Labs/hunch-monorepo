import assert from "node:assert/strict";

import { PNG } from "pngjs";

import { generateTelegramDepositQr } from "./services/telegram-bot-deposit-qr.js";
import { parseSignalBotInteractiveMenuRoute } from "./services/telegram-bot-menu-actions.js";
import {
  buildSignalBotMarketSearchScreen,
  readSignalBotMarketSearchSession,
  writeSignalBotMarketSearchSession,
} from "./services/telegram-bot-menu-markets.js";
import { handleSignalBotMarketSearchInput } from "./services/telegram-bot-menu-search-input.js";
import {
  readSignalBotMenuInput,
  writeSignalBotMenuInput,
} from "./services/telegram-bot-menu-state.js";
import { parseTelegramBotTradingCallbackData } from "./services/telegram-bot-trading-client.js";

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "retry buy callback remains valid and bounded",
    run: () => {
      const intentId = "00000000-0000-4000-8000-000000000001";
      const data = `hbt:retry_buy:${intentId}`;
      assert.ok(data.length <= 64);
      assert.deepEqual(parseTelegramBotTradingCallbackData(data), {
        intentId,
        type: "retry_buy",
      });
    },
  },
  {
    name: "market search sessions are scoped to chat and Telegram user",
    run: async () => {
      const values = new Map<string, string>();
      const redis = {
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => {
          values.set(key, value);
          return "OK";
        },
      };
      const results = [
        {
          eventId: "event-1",
          eventTitle: "World Cup Winner",
          lastPrice: 0.21,
          marketId: "polymarket:1",
          marketTitle: "Spain",
          noAsk: 0.8,
          venue: "polymarket",
          yesAsk: 0.21,
        },
      ];
      const sessionId = await writeSignalBotMarketSearchSession({
        chatId: "10",
        query: "Spain",
        redis,
        results,
        telegramUserId: 20,
      });
      assert.ok(
        await readSignalBotMarketSearchSession({
          chatId: "10",
          redis,
          sessionId,
          telegramUserId: 20,
        }),
      );
      assert.equal(
        await readSignalBotMarketSearchSession({
          chatId: "11",
          redis,
          sessionId,
          telegramUserId: 20,
        }),
        null,
      );
      const rendered = buildSignalBotMarketSearchScreen({
        callbackPrefix: "hm:v1:",
        query: "Spain",
        results,
        sessionId,
      });
      assert.match(rendered.text, /Spain/);
      assert.ok(
        (rendered.reply_markup.inline_keyboard[0]?.[0]?.callback_data.length ??
          65) <= 64,
      );
    },
  },
  {
    name: "deposit QR encodes a valid address into a PNG",
    run: async () => {
      const address = "0x018D243ab7fA9886E53b8FDb10652ea3f708Bb5e";
      const png = await generateTelegramDepositQr(address);
      assert.equal(png[0], 0x89);
      assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
      assert.ok(png.length > 1_000);
      const decodedPng = PNG.sync.read(png);
      const decoderModule = await import("jsqr");
      const decodeQr = (decoderModule.default ?? decoderModule) as unknown as (
        data: Uint8ClampedArray,
        width: number,
        height: number,
      ) => { data: string } | null;
      const decodedQr = decodeQr(
        new Uint8ClampedArray(decodedPng.data),
        decodedPng.width,
        decodedPng.height,
      );
      assert.equal(decodedQr?.data, address);
      assert.deepEqual(
        parseSignalBotInteractiveMenuRoute("deposit_qr:polymarket"),
        { kind: "deposit", showQr: true, venue: "polymarket" },
      );
    },
  },
  {
    name: "invalid direct market input stays in search mode",
    run: async () => {
      const values = new Map<string, string>();
      const redis = {
        del: async (key: string) => values.delete(key),
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => {
          values.set(key, value);
          return "OK";
        },
      };
      await writeSignalBotMenuInput({
        chatId: "10",
        menuMessageId: 42,
        redis,
        telegramUserId: 20,
      });
      let rendered = "";
      assert.equal(
        await handleSignalBotMarketSearchInput({
          callbackPrefix: "hm:v1:",
          chatId: "10",
          loadMarketCard: async () => ({
            marketFound: false,
            text: "Market not found",
          }),
          redis,
          render: async (message) => {
            rendered = message.text;
          },
          renderCancelled: async () => undefined,
          searchMarkets: async () => [],
          telegramUserId: 20,
          text: "https://polymarket.com/event/missing",
        }),
        true,
      );
      assert.match(rendered, /No active markets found/);
      assert.ok(
        await readSignalBotMenuInput({
          chatId: "10",
          redis,
          telegramUserId: 20,
        }),
      );
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
