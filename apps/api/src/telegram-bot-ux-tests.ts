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
import { telegramTradeLifecycleProgressTestHooks } from "./services/telegram-trade-lifecycle-progress.js";

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
    name: "open market callback remains valid and bounded",
    run: () => {
      const intentId = "00000000-0000-4000-8000-000000000001";
      const data = `hbt:open_market:${intentId}`;
      assert.ok(data.length <= 64);
      assert.deepEqual(parseTelegramBotTradingCallbackData(data), {
        intentId,
        type: "open_market",
      });
    },
  },
  {
    name: "terminal lifecycle cards expose the same safe market escape",
    run: () => {
      const intentId = "00000000-0000-4000-8000-000000000001";
      for (const progress of [
        { action: "sell", isDirectHandoff: true, state: "filled" },
        { action: "sell", isDirectHandoff: true, state: "failed" },
        { action: "buy", isDirectHandoff: false, state: "stopped" },
      ]) {
        const keyboard =
          telegramTradeLifecycleProgressTestHooks.progressKeyboard({
            amountUsd: "5",
            canCancel: false,
            canCancelBuy: false,
            intentId,
            marketTitle: "Market",
            requiresMiniAppContinuation: false,
            sideLabel: "YES",
            venue: "polymarket",
            ...progress,
          } as never).inline_keyboard;
        assert.equal(
          keyboard
            .flat()
            .some(
              (button) =>
                "callback_data" in button &&
                button.callback_data === `hbt:open_market:${intentId}`,
            ),
          true,
          `${progress.action}/${progress.state} must expose Open market`,
        );
        assert.equal(
          keyboard
            .flat()
            .some(
              (button) =>
                "callback_data" in button &&
                button.callback_data === "hm:v1:home",
            ),
          true,
          `${progress.action}/${progress.state} must expose Home`,
        );
      }
    },
  },
  {
    name: "ready funded handoff exposes Continue and Cancel Buy",
    run: () => {
      const intentId = "00000000-0000-4000-8000-000000000001";
      const keyboard = telegramTradeLifecycleProgressTestHooks.progressKeyboard(
        {
          action: "buy",
          amountUsd: "5",
          canCancel: false,
          canCancelBuy: true,
          intentId,
          isDirectHandoff: false,
          marketTitle: "Market",
          requiresMiniAppContinuation: true,
          sideLabel: "YES",
          state: "ready",
          venue: "limitless",
        } as never,
      ).inline_keyboard;
      assert.equal(
        keyboard
          .flat()
          .some((button) => button.text === "▶️ Continue in Hunch"),
        true,
      );
      assert.equal(
        keyboard.flat().some((button) => button.text === "❌ Cancel Buy"),
        true,
      );
    },
  },
  {
    name: "submitted funded trade never renders as stopped or cancellable",
    run: () => {
      const intentId = "00000000-0000-4000-8000-000000000001";
      const progress = {
        action: "buy",
        amountUsd: "5",
        canCancel: false,
        canCancelBuy: false,
        intentId,
        isDirectHandoff: false,
        marketTitle: "Market",
        requiresMiniAppContinuation: false,
        sideLabel: "YES",
        state: "confirming_trade",
        venue: "polymarket",
      } as never;
      const text =
        telegramTradeLifecycleProgressTestHooks.progressText(progress);
      assert.match(text, /Checking order/u);
      assert.doesNotMatch(text, /No trade was submitted/u);
      const keyboard =
        telegramTradeLifecycleProgressTestHooks.progressKeyboard(
          progress,
        ).inline_keyboard;
      assert.equal(
        keyboard
          .flat()
          .some(
            (button) =>
              "callback_data" in button &&
              (button.callback_data.includes(":cancel:") ||
                button.callback_data.includes(":open_market:")),
          ),
        false,
      );
      assert.equal(
        keyboard
          .flat()
          .some(
            (button) =>
              "callback_data" in button &&
              button.callback_data === "hm:v1:home",
          ),
        true,
      );
    },
  },
  {
    name: "unknown Polymarket relayer submission stays non-rebroadcast and diagnostic",
    run: () => {
      const text = telegramTradeLifecycleProgressTestHooks.progressText({
        action: "buy",
        amountUsd: "5",
        canCancel: false,
        canCancelBuy: false,
        fundingAmountLabel: "1.02 pUSD",
        intentId: "00000000-0000-4000-8000-000000000001",
        isDirectHandoff: false,
        marketTitle: "Market",
        reasonCode: "external_handoff_submission_unknown",
        requiresMiniAppContinuation: false,
        sideLabel: "YES",
        sourceRoute: "Polymarket pUSD → controller pUSD",
        state: "needs_attention",
        venue: "polymarket",
      } as never);
      assert.match(text, /Checking Polymarket funding/u);
      assert.match(text, /will not send it again blindly/u);
      assert.doesNotMatch(text, /Funding stopped/u);
    },
  },
  {
    name: "automatic funding reconciliation is presented as progress, not attention",
    run: () => {
      const candidate = {
        action: "buy",
        amount_usd: "2.000000",
        attempt_reason_code: null,
        attempt_state_fingerprint: "0:1:started",
        consumer_reservation_id: null,
        continuation_id: null,
        delivery_mode: "app_handoff",
        error_code: null,
        error_message: null,
        external_handoff_receipt_reason_code: null,
        funding_destination_asset_id: null,
        funding_destination_decimals: null,
        funding_destination_raw: null,
        funding_operation_id: "00000000-0000-4000-8000-000000000002",
        funding_source_updated_at_us: "1",
        consumer_may_remain_linked: false,
        has_broadcast_boundary: false,
        has_started_attempt: true,
        has_terminal_external_handoff_receipt: false,
        id: "00000000-0000-4000-8000-000000000001",
        intent_source_updated_at_us: "1",
        is_direct_v2_handoff: false,
        market_title: "Market",
        operation_error_code: null,
        operation_status: "reconcile_required",
        progress_stage: "source_action",
        receipt_state_fingerprint: "",
        result: {
          appHandoffExecution: { kind: "funding", version: 2 },
        },
        root_requires_router_continuation: false,
        shares_raw: null,
        side: "NO",
        source_asset_decimals: null,
        source_asset_id: null,
        source_network_id: null,
        status: "funding",
        step_state_fingerprint: "0:action_required",
        submit_started_at: null,
        telegram_message_id: "1",
        telegram_user_id: "1",
        tracked_operation_id: "00000000-0000-4000-8000-000000000002",
        user_id: "00000000-0000-4000-8000-000000000003",
        venue: "limitless",
        venue_order_id: null,
      };
      assert.equal(
        telegramTradeLifecycleProgressTestHooks.liveProgressFor(
          candidate as never,
        ).state,
        "preparing",
      );
      assert.equal(
        telegramTradeLifecycleProgressTestHooks.liveProgressFor({
          ...candidate,
          has_broadcast_boundary: true,
          has_started_attempt: false,
        } as never).state,
        "submitted",
      );
      const routineRecovery =
        telegramTradeLifecycleProgressTestHooks.liveProgressFor({
          ...candidate,
          consumer_may_remain_linked: true,
          operation_status: "recovery_required",
        } as never);
      assert.deepEqual(
        {
          canCancelBuy: routineRecovery.canCancelBuy,
          state: routineRecovery.state,
        },
        { canCancelBuy: true, state: "preparing" },
        "routine recovery keeps the confirmed Buy in progress and lets its owner detach it",
      );
      assert.equal(
        telegramTradeLifecycleProgressTestHooks.liveProgressFor({
          ...candidate,
          has_broadcast_boundary: true,
          has_started_attempt: false,
          has_terminal_external_handoff_receipt: true,
        } as never).state,
        "needs_attention",
      );
    },
  },
  {
    name: "change amount callback remains valid and bounded",
    run: () => {
      const intentId = "00000000-0000-4000-8000-000000000001";
      const data = `hbt:change_amount:${intentId}`;
      assert.ok(data.length <= 64);
      assert.deepEqual(parseTelegramBotTradingCallbackData(data), {
        intentId,
        type: "change_amount",
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
      const firstResult = results[0];
      assert.ok(firstResult);
      const directional = buildSignalBotMarketSearchScreen({
        callbackPrefix: "hm:v1:",
        query: "Robinhood",
        sessionId,
        results: [
          {
            ...firstResult,
            marketTitle: "Robinhood Up or Down?",
            outcomes: '["Up","Down"]',
          },
        ],
      });
      assert.match(directional.text, /Up 21¢/u);
      assert.match(directional.text, /Down 80¢/u);
      assert.doesNotMatch(directional.text, /YES 21¢/u);
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
      assert.deepEqual(parseSignalBotInteractiveMenuRoute("deposit"), {
        kind: "deposit_menu",
      });
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
