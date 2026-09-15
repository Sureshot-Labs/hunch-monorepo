import assert from "node:assert/strict";
import { createTelegramBotTradingInternalApiClient } from "./services/telegram-bot-trading-client.js";

const originalFetch = globalThis.fetch;
const contextId = "ac49bd95-90d7-4268-a44c-378f2b2066c7";
const client = createTelegramBotTradingInternalApiClient({
  baseUrl: "https://internal.invalid",
  token: "test-only",
});
try {
  for (const editSucceeds of [true, false]) {
    const confirmation = {
      chat_id: "123",
      text: "Review updated price",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Confirm Buy", callback_data: `hbt:confirm:${contextId}` }],
        ],
      },
    };
    globalThis.fetch = async (url) => {
      assert.ok(
        String(url).endsWith("/preview-intent"),
        "refresh is never execution",
      );
      return Response.json({
        handled: true,
        intentStatus: "expired",
        answers: [],
        messages: [confirmation],
      });
    };
    let sent = 0;
    await client.handleCallback({
      appBaseUrl: "https://app.invalid",
      callbackQuery: {
        id: "refresh",
        data: `hbt:refresh_quote:${contextId}`,
        from: { id: 123 },
        message: { message_id: 7, chat: { id: 123, type: "private" } },
      },
      answerCallbackQuery: async () => undefined,
      editMessageText: async (message) => {
        assert.equal(message.message_id, 7);
        if (!editSucceeds) throw new Error("message cannot be edited");
        return { ok: true, result: { message_id: 7 } };
      },
      sendMessage: async (message) => {
        sent++;
        assert.doesNotMatch(JSON.stringify(message), /hbt:confirm:/);
        assert.match(message.text, /original review card could not be updated/);
      },
    });
    assert.equal(sent, editSucceeds ? 0 : 1);
  }
  for (const action of ["cancel_input", "open_input_market"] as const) {
    for (const customSide of ["Buy", "Sell"]) {
      const message = {
        text: `${customSide} market card`,
        parse_mode: "MarkdownV2",
        reply_markup: { inline_keyboard: [] },
      };
      globalThis.fetch = async (url) => {
        assert.ok(
          String(url).endsWith(
            `/input-contexts/${contextId}/${action === "cancel_input" ? "cancel" : "market"}`,
          ),
        );
        return Response.json(message);
      };
      let rendered = 0;
      await client.handleCallback({
        appBaseUrl: "https://app.invalid",
        callbackQuery: {
          id: "callback",
          data: `hbt:${action}:${contextId}`,
          from: { id: 123 },
          message: { message_id: 7, chat: { id: 123, type: "private" } },
        },
        cancelTradeInput: async (input) => {
          assert.deepEqual(input.message, message);
          assert.equal(input.contextId, contextId);
          assert.equal(input.menuMessageId, 7);
          rendered++;
          return true;
        },
        answerCallbackQuery: async (answer) => {
          assert.equal(answer.showAlert, false);
        },
        sendMessage: async () => {
          assert.fail(
            "cancellation must not submit a trade or send an unrelated card",
          );
        },
      });
      assert.equal(rendered, 1);
    }
  }
  globalThis.fetch = async () => Response.json({ unexpected: true });
  await client.handleCallback({
    appBaseUrl: "https://app.invalid",
    callbackQuery: {
      id: "bad-response",
      data: `hbt:cancel_input:${contextId}`,
      from: { id: 123 },
      message: { message_id: 7, chat: { id: 123, type: "private" } },
    },
    cancelTradeInput: async () => {
      assert.fail("invalid response must not clear input");
    },
    answerCallbackQuery: async (answer) => {
      assert.equal(answer.showAlert, true);
      assert.match(answer.text ?? "", /Custom input/);
    },
    sendMessage: async () => undefined,
  });
} finally {
  globalThis.fetch = originalFetch;
}
