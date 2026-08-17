import assert from "node:assert/strict";

import { TelegramBotApiClient } from "./services/signal-bot-telegram-client.js";
import type { TelegramInlineKeyboard } from "./services/signal-bot-contracts.js";
import {
  classifyTelegramBotMenuDeliveryResult,
  sendOrEditTelegramBotMenuMessage,
} from "./services/telegram-bot-menu-delivery.js";
import { sendTelegramMessageWithReplyFallback } from "./services/telegram-delivery-safety.js";

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "menu delivery telemetry exposes only normalized safe outcomes",
    run: () => {
      const cases = [
        [{ messageId: 8, ok: true }, { outcome: "success" }],
        [
          { error: "ambiguous", message: "raw timeout", ok: false },
          { outcome: "ambiguous" },
        ],
        [
          {
            error: "other",
            message: "raw Telegram rate limit body",
            ok: false,
            retryAfterSec: 11,
          },
          { outcome: "rate_limited", retryAfterSec: 11 },
        ],
        [
          { error: "blocked_or_missing", message: "raw block", ok: false },
          { outcome: "blocked" },
        ],
        [
          {
            error: "message_not_editable",
            message: "raw missing message",
            ok: false,
          },
          { outcome: "message_not_editable" },
        ],
        [
          { error: "other", message: "menu_render_superseded", ok: false },
          { outcome: "render_superseded" },
        ],
        [
          { error: "other", message: "menu_render_unavailable", ok: false },
          { outcome: "render_unavailable" },
        ],
        [
          { error: "other", message: "raw backend body", ok: false },
          { outcome: "other" },
        ],
      ] as const;
      for (const [result, expected] of cases) {
        const normalized = classifyTelegramBotMenuDeliveryResult(result);
        assert.deepEqual(normalized, expected);
        assert.equal("message" in normalized, false);
        assert.equal("error" in normalized, false);
      }
    },
  },
  {
    name: "menu delivery adds one Home escape route without duplicating refresh output",
    run: async () => {
      const delivered: Array<{
        reply_markup?: TelegramInlineKeyboard;
      }> = [];
      for (const message of [
        { text: "First render" },
        {
          reply_markup: {
            inline_keyboard: [
              [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
            ],
          },
          text: "Refreshed render",
        },
      ]) {
        const result = await sendOrEditTelegramBotMenuMessage({
          chatId: "99",
          message,
          transport: {
            sendMessage: async (sent) => {
              delivered.push(sent);
              return { messageId: delivered.length, ok: true };
            },
          },
        });
        assert.equal(result.ok, true);
      }
      for (const message of delivered) {
        const homes = (message.reply_markup?.inline_keyboard ?? [])
          .flat()
          .filter(
            (button) =>
              "callback_data" in button &&
              button.callback_data === "hm:v1:home",
          );
        assert.equal(homes.length, 1);
      }
    },
  },
  {
    name: "menu fallback is limited to definitive message-not-editable",
    run: async () => {
      const failures = [
        { error: "ambiguous", message: "timeout", ok: false },
        { error: "blocked_or_missing", message: "blocked", ok: false },
        {
          error: "other",
          message: "rate limited",
          ok: false,
          retryAfterSec: 9,
        },
      ] as const;
      for (const failure of failures) {
        let sends = 0;
        const result = await sendOrEditTelegramBotMenuMessage({
          chatId: "99",
          message: { text: "Menu" },
          messageId: 7,
          transport: {
            editMessageText: async () => failure,
            sendMessage: async () => {
              sends += 1;
              return { messageId: 8, ok: true };
            },
          },
        });
        assert.deepEqual(result, failure);
        assert.equal(sends, 0);
      }

      let sends = 0;
      const result = await sendOrEditTelegramBotMenuMessage({
        chatId: "99",
        message: { text: "Menu" },
        messageId: 7,
        transport: {
          editMessageText: async () => ({
            error: "message_not_editable",
            message: "message to edit not found",
            ok: false,
          }),
          sendMessage: async () => {
            sends += 1;
            return { messageId: 8, ok: true };
          },
        },
      });
      assert.deepEqual(result, { messageId: 8, ok: true });
      assert.equal(sends, 1);
    },
  },
  {
    name: "owner-scoped funding cards never fall back to a new message",
    run: async () => {
      for (const failure of [
        {
          error: "message_not_editable",
          message: "message to edit not found",
          ok: false,
        },
        { error: "ambiguous", message: "timeout", ok: false },
      ] as const) {
        let sends = 0;
        const result = await sendOrEditTelegramBotMenuMessage({
          chatId: "99",
          message: { fundingContextId: "funding-1", text: "Funding" },
          messageId: 7,
          transport: {
            editMessageText: async () => failure,
            sendMessage: async () => {
              sends += 1;
              return { messageId: 8, ok: true };
            },
          },
        });
        assert.deepEqual(result, failure);
        assert.equal(sends, 0);
      }
    },
  },
  {
    name: "menu supersession between edit and fallback prevents standalone send",
    run: async () => {
      let checks = 0;
      let sends = 0;
      const result = await sendOrEditTelegramBotMenuMessage({
        chatId: "99",
        message: { text: "Menu" },
        messageId: 7,
        shouldDeliver: async () => {
          checks += 1;
          return checks === 1;
        },
        transport: {
          editMessageText: async () => ({
            error: "message_not_editable",
            message: "message to edit not found",
            ok: false,
          }),
          sendMessage: async () => {
            sends += 1;
            return { messageId: 8, ok: true };
          },
        },
      });
      assert.equal(sends, 0);
      assert.deepEqual(result, {
        error: "other",
        message: "superseded",
        ok: false,
      });
    },
  },
  {
    name: "reply fallback runs once only after definitive missing target",
    run: async () => {
      const messages: Array<{ reply_parameters?: { message_id: number } }> = [];
      const result = await sendTelegramMessageWithReplyFallback({
        message: {
          chat_id: "99",
          disable_web_page_preview: true,
          text: "Update",
        },
        replyToMessageId: 7,
        telegram: {
          sendMessage: async (message) => {
            messages.push(message);
            return messages.length === 1
              ? {
                  error: "reply_target_missing",
                  message: "reply message not found",
                  ok: false,
                }
              : { messageId: 8, ok: true };
          },
        },
      });
      assert.equal(messages.length, 2);
      assert.deepEqual(messages[0]?.reply_parameters, { message_id: 7 });
      assert.equal(messages[1]?.reply_parameters, undefined);
      assert.deepEqual(result, {
        fallbackToMarkdown: false,
        fallbackStandalone: true,
        messageId: 8,
        ok: true,
        replyToMessageId: null,
      });
    },
  },
  {
    name: "rich, photo, and callback transport failures are bounded ambiguous mutations",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const signals: AbortSignal[] = [];
      try {
        globalThis.fetch = (async (_url, init) => {
          assert.ok(init?.signal instanceof AbortSignal);
          signals.push(init.signal);
          throw new DOMException("request timed out", "TimeoutError");
        }) as typeof fetch;
        const client = new TelegramBotApiClient("token");
        const rich = await client.sendRichMessage({
          chat_id: "99",
          rich_message: { blocks: [] },
        });
        const photo = await client.sendPhoto({
          chat_id: "99",
          filename: "qr.png",
          photo: new Uint8Array([1]),
        });
        const callback = await client.answerCallbackQuery({
          callbackQueryId: "callback-1",
        });
        const deleted = await client.deleteMessage({
          chat_id: "99",
          message_id: 7,
        });
        for (const result of [rich, photo, callback, deleted]) {
          assert.deepEqual(result, {
            error: "ambiguous",
            message: "request timed out",
            ok: false,
          });
        }
        assert.equal(signals.length, 4);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "deleting an already absent Telegram message is idempotent",
    run: async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              description: "Bad Request: message to delete not found",
              ok: false,
            }),
            { status: 400 },
          )) as typeof fetch;
        assert.deepEqual(
          await new TelegramBotApiClient("token").deleteMessage({
            chat_id: "99",
            message_id: 7,
          }),
          { messageId: 7, ok: true },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "successful new-message responses require a positive safe message id",
    run: async () => {
      const originalFetch = globalThis.fetch;
      try {
        const malformedSuccess = () =>
          new Response(JSON.stringify({ ok: true, result: {} }), {
            status: 200,
          });
        const responses = [
          malformedSuccess(),
          malformedSuccess(),
          malformedSuccess(),
        ];
        globalThis.fetch = (async () =>
          responses.shift() ?? malformedSuccess()) as typeof fetch;
        const client = new TelegramBotApiClient("token");
        const results = [
          await client.sendRichMessage({
            chat_id: "99",
            rich_message: { blocks: [] },
          }),
          await client.sendPhoto({
            chat_id: "99",
            filename: "qr.png",
            photo: new Uint8Array([1]),
          }),
          await client.sendMessage({
            chat_id: "99",
            disable_web_page_preview: true,
            text: "hello",
          }),
        ];
        for (const result of results) {
          assert.deepEqual(result, {
            error: "ambiguous",
            message: "invalid telegram success response",
            ok: false,
          });
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "invalid successful payloads and server failures stay ambiguous while 429 stays retryable",
    run: async () => {
      const originalFetch = globalThis.fetch;
      try {
        const responses = [
          new Response("", { status: 200 }),
          new Response("not-json", { status: 200 }),
          new Response(JSON.stringify({ ok: false }), { status: 500 }),
          new Response(
            JSON.stringify({
              description: "Too Many Requests",
              ok: false,
              parameters: { retry_after: 13 },
            }),
            { status: 429 },
          ),
        ];
        globalThis.fetch = (async () =>
          responses.shift() ??
          new Response("", { status: 500 })) as typeof fetch;
        const client = new TelegramBotApiClient("token");
        const results = [
          await client.sendRichMessage({
            chat_id: "99",
            rich_message: { blocks: [] },
          }),
          await client.sendPhoto({
            chat_id: "99",
            filename: "qr.png",
            photo: new Uint8Array([1]),
          }),
          await client.answerCallbackQuery({ callbackQueryId: "callback-1" }),
        ];
        for (const result of results) {
          assert.equal(result.ok, false);
          if (!result.ok) assert.equal(result.error, "ambiguous");
        }
        const rateLimited = await client.answerCallbackQuery({
          callbackQueryId: "callback-2",
        });
        assert.deepEqual(rateLimited, {
          error: "other",
          message: "Too Many Requests",
          ok: false,
          retryAfterSec: 13,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "custom-emoji retry shares the original mutation deadline",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const signals: AbortSignal[] = [];
      try {
        const responses = [
          new Response(
            JSON.stringify({
              description: "Bad Request: custom emoji is invalid",
              ok: false,
            }),
            { status: 400 },
          ),
          new Response(
            JSON.stringify({ ok: true, result: { message_id: 8 } }),
            { status: 200 },
          ),
        ];
        globalThis.fetch = (async (_url, init) => {
          assert.ok(init?.signal instanceof AbortSignal);
          signals.push(init.signal);
          return responses.shift() ?? new Response("", { status: 500 });
        }) as typeof fetch;
        const result = await new TelegramBotApiClient("token").sendMessage({
          chat_id: "99",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  icon_custom_emoji_id: "emoji-1",
                  text: "Open",
                  url: "https://hunch.trade",
                },
              ],
            ],
          },
          text: "Menu",
        });
        assert.deepEqual(result, { messageId: 8, ok: true });
        assert.equal(signals.length, 2);
        assert.equal(signals[0], signals[1]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[telegram-delivery-safety-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(
  `[telegram-delivery-safety-tests] passed ${passed}/${tests.length}`,
);
