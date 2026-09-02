import assert from "node:assert/strict";

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { createTelegramBotTradingRoutes } from "./routes/telegram-bot-trading.js";
import {
  drainSignalBotFundingOpenTasks,
  handleSignalBotInteractiveMenuCallback,
  parseSignalBotInteractiveMenuRoute,
} from "./services/telegram-bot-menu-actions.js";
import { buildTelegramDepositMessage } from "./services/telegram-bot-deposit.js";
import { TelegramFundingError } from "./services/telegram-funding.js";
import { TELEGRAM_CUSTOM_EMOJI } from "./services/telegram-custom-emoji.js";

function authorizationDb(walletAddress: string | null) {
  return {
    query: async () => ({
      rows: walletAddress == null ? [] : [{ wallet_address: walletAddress }],
    }),
  } as never;
}

const owner = "0x1111111111111111111111111111111111111111";
const deposit = "0x3333333333333333333333333333333333333333";

assert.equal(parseSignalBotInteractiveMenuRoute("deposit_route:pw"), null);
assert.deepEqual(parseSignalBotInteractiveMenuRoute("deposit_route:pd"), {
  kind: "deposit_route",
  route: "polymarket_polygon_pusd_direct_v1",
  venue: "polymarket",
});
assert.deepEqual(parseSignalBotInteractiveMenuRoute("deposit_route:ld"), {
  kind: "deposit_route",
  route: "limitless_base_usdc_direct_v1",
  venue: "limitless",
});
assert.equal(parseSignalBotInteractiveMenuRoute("deposit_route:pn"), null);
assert.equal(parseSignalBotInteractiveMenuRoute("deposit_route:pb"), null);
assert.deepEqual(parseSignalBotInteractiveMenuRoute("deposit_cancel_active"), {
  kind: "deposit_cancel_active",
});

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "funding target selection receives the Buy-return decorator immediately",
    run: async () => {
      let receivedDecorator: unknown;
      const app = Fastify({ logger: false });
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(
        createTelegramBotTradingRoutes({
          createTrading: () => ({}) as never,
          db: { query: async () => ({ fields: [], rows: [] }) } as never,
          fundingService: {
            cancel: async () => ({ text: "cancel" }),
            open: async () => ({ text: "open" }),
            selectTarget: async (_input, _now, decorateProgress) => {
              receivedDecorator = decorateProgress;
              return { text: "selected with amount guidance" };
            },
            session: async () => ({ text: "session" }),
          },
          internalPreHandler: async () => undefined,
        }),
      );
      try {
        const response = await app.inject({
          method: "POST",
          payload: {
            chatId: 20,
            choiceToken: "p",
            contextId: "11111111-1111-4111-8111-111111111111",
            idempotencyKey: "funding:select:amount",
            telegramMessageId: 42,
            telegramUserId: 20,
          },
          url: "/internal/telegram-bot/funding/select-target",
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().text, "selected with amount guidance");
        assert.equal(typeof receivedDecorator, "function");
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "main Add funds callback reaches the venue picker route",
    run: async () => {
      const loadedVenues: Array<string | null | undefined> = [];
      let rendered = "";
      await handleSignalBotInteractiveMenuCallback({
        callbackPrefix: "hm:v1:",
        chatId: "20",
        loadDeposit: async ({ venue }) => {
          loadedVenues.push(venue);
          return { text: "Choose a trading venue." };
        },
        messageId: 42,
        redis: { get: async () => null },
        render: async (message) => {
          rendered = message.text;
        },
        renderExpiredSearch: async () => undefined,
        route: { kind: "deposit_menu" },
        telegramUserId: 20,
      });
      assert.deepEqual(loadedVenues, [null]);
      assert.equal(rendered, "Choose a trading venue.");

      const routeCalls: Array<string | null | undefined> = [];
      const directSelections: Array<Record<string, unknown>> = [];
      const activeCancellations: Array<Record<string, unknown>> = [];
      const app = Fastify({ logger: false });
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(
        createTelegramBotTradingRoutes({
          buildDepositMessage: async ({ venue }) => {
            routeCalls.push(venue);
            return { text: venue ? `Deposit ${venue}` : "Choose venues" };
          },
          db: {
            query: async (sql: string) => ({
              fields: [],
              rows: sql.includes("funding_context.id as context_id")
                ? [
                    {
                      context_id: "223e4567-e89b-42d3-a456-426614174000",
                      telegram_message_id: "741",
                    },
                  ]
                : [],
            }),
          } as never,
          fundingService: {
            cancel: async (input) => {
              activeCancellations.push(input);
              return { text: "cancel" };
            },
            open: async () => ({
              fundingContextId: "123e4567-e89b-42d3-a456-426614174000",
              text: "open",
            }),
            selectTarget: async (input) => {
              directSelections.push(input);
              return { text: "direct selected" };
            },
            session: async () => ({ text: "session" }),
          },
          internalPreHandler: async () => undefined,
          resolveInternalWallets: async () => [],
        }),
      );
      try {
        const picker = await app.inject({
          method: "POST",
          payload: {
            appBaseUrl: "https://app.hunch.trade",
            telegramUserId: 20,
            venue: null,
          },
          url: "/internal/telegram-bot/deposit",
        });
        assert.equal(picker.statusCode, 200);
        assert.equal(picker.json().text, "Choose venues");
        const limitless = await app.inject({
          method: "POST",
          payload: {
            appBaseUrl: "https://app.hunch.trade",
            telegramUserId: 20,
            venue: "limitless",
          },
          url: "/internal/telegram-bot/deposit",
        });
        assert.match(limitless.json().text, /Receive unavailable/u);
        assert.doesNotMatch(limitless.json().text, /address|USDC|Base/iu);
        const polymarket = await app.inject({
          method: "POST",
          payload: {
            appBaseUrl: "https://app.hunch.trade",
            telegramUserId: 20,
            venue: "polymarket",
          },
          url: "/internal/telegram-bot/deposit",
        });
        assert.doesNotMatch(polymarket.json().text, /address/iu);
        const direct = await app.inject({
          method: "POST",
          payload: {
            appBaseUrl: "https://app.hunch.trade",
            chatId: 20,
            fundingRoute: "polymarket_polygon_usdce_wrap_v1",
            idempotencyKey: "funding:direct:test",
            telegramMessageId: 42,
            telegramUserId: 20,
            venue: "polymarket",
          },
          url: "/internal/telegram-bot/funding/open-route",
        });
        assert.equal(direct.statusCode, 400);
        assert.equal(directSelections.length, 0);
        const cancelActive = await app.inject({
          method: "POST",
          payload: {
            appBaseUrl: "https://app.hunch.trade",
            chatId: 20,
            idempotencyKey: "funding:cancel-active:test",
            telegramMessageId: 42,
            telegramUserId: 20,
          },
          url: "/internal/telegram-bot/funding/cancel-active",
        });
        assert.equal(cancelActive.statusCode, 200);
        assert.equal(cancelActive.json().text, "cancel");
        assert.equal(
          activeCancellations[0]?.contextId,
          "223e4567-e89b-42d3-a456-426614174000",
        );
        assert.equal(activeCancellations[0]?.telegramMessageId, 741);
        assert.deepEqual(routeCalls, [null]);
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "disabled Telegram Receive fails closed without a legacy address",
    run: async () => {
      const fallbackCalls: unknown[] = [];
      const app = Fastify({ logger: false });
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(
        createTelegramBotTradingRoutes({
          buildDepositMessage: async (input) => {
            fallbackCalls.push(input);
            return {
              depositAddress: deposit,
              qrText: deposit,
              text: `Send only pUSD on Polygon to ${deposit}`,
              venue: "polymarket",
            };
          },
          db: { query: async () => ({ fields: [], rows: [] }) } as never,
          fundingService: {
            cancel: async () => ({ text: "cancel" }),
            open: async () => {
              throw new TelegramFundingError("funding_receive_disabled");
            },
            selectTarget: async () => ({ text: "select" }),
            session: async () => ({ text: "session" }),
          },
          internalPreHandler: async () => undefined,
        }),
      );
      try {
        const response = await app.inject({
          method: "POST",
          payload: {
            appBaseUrl: "https://app.hunch.trade",
            chatId: 20,
            idempotencyKey: "funding:callback:disabled",
            telegramMessageId: 42,
            telegramMiniAppEnabled: true,
            telegramUserId: 20,
            venue: "polymarket",
          },
          url: "/internal/telegram-bot/funding/open",
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().depositAddress, undefined);
        assert.equal(response.json().qrText, undefined);
        assert.match(response.json().text, /Receive unavailable/u);
        assert.match(response.json().text, /not enabled/u);
        assert.doesNotMatch(response.json().text, new RegExp(deposit, "iu"));
        assert.equal(fallbackCalls.length, 0);
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "Telegram Receive success and non-disabled failures never use legacy deposit",
    run: async () => {
      let fallbackCalls = 0;
      let openedVenue = "";
      let openResult:
        | "success"
        | "ambiguous"
        | "private"
        | "unavailable"
        | "unexpected" = "success";
      const app = Fastify({ logger: false });
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(
        createTelegramBotTradingRoutes({
          buildDepositMessage: async () => {
            fallbackCalls += 1;
            return { text: "legacy" };
          },
          db: { query: async () => ({ fields: [], rows: [] }) } as never,
          fundingService: {
            cancel: async () => ({ text: "cancel" }),
            open: async (input) => {
              openedVenue = input.venue;
              if (openResult === "ambiguous") {
                throw new TelegramFundingError("destination_ambiguous");
              }
              if (openResult === "private") {
                throw new TelegramFundingError("private_chat_required");
              }
              if (openResult === "unavailable") {
                throw new TelegramFundingError("funding_session_unavailable");
              }
              if (openResult === "unexpected") {
                throw new Error("unexpected funding failure");
              }
              return { text: "current funding progress" };
            },
            selectTarget: async () => ({ text: "select" }),
            session: async () => ({ text: "session" }),
          },
          internalPreHandler: async () => undefined,
        }),
      );
      const request = () =>
        app.inject({
          method: "POST",
          payload: {
            appBaseUrl: "https://app.hunch.trade",
            chatId: 20,
            idempotencyKey: "funding:callback:result",
            telegramMessageId: 42,
            telegramUserId: 20,
            venue: "polymarket",
          },
          url: "/internal/telegram-bot/funding/open",
        });
      try {
        const success = await request();
        assert.equal(success.statusCode, 200);
        assert.equal(success.json().text, "current funding progress");
        assert.equal(openedVenue, "polymarket");

        const limitlessSuccess = await app.inject({
          method: "POST",
          payload: {
            appBaseUrl: "https://app.hunch.trade",
            chatId: 20,
            idempotencyKey: "funding:callback:limitless",
            telegramMessageId: 42,
            telegramUserId: 20,
            venue: "limitless",
          },
          url: "/internal/telegram-bot/funding/open",
        });
        assert.equal(limitlessSuccess.statusCode, 200);
        assert.equal(openedVenue, "limitless");

        openResult = "ambiguous";
        const ambiguous = await request();
        assert.equal(ambiguous.statusCode, 409);
        assert.equal(ambiguous.json().error, "destination_ambiguous");

        openResult = "private";
        const privateChat = await request();
        assert.equal(privateChat.statusCode, 403);
        assert.equal(privateChat.json().error, "private_chat_required");

        openResult = "unavailable";
        const unavailable = await request();
        assert.equal(unavailable.statusCode, 200);
        assert.match(unavailable.json().text, /Receive unavailable/u);
        assert.doesNotMatch(unavailable.json().text, /expired/u);

        openResult = "unexpected";
        const unexpected = await request();
        assert.equal(unexpected.statusCode, 503);
        assert.equal(
          unexpected.json().error,
          "telegram_funding_unexpected_error",
        );
        assert.equal(fallbackCalls, 0);
      } finally {
        await app.close();
      }
    },
  },
  {
    name: "Deposit menu exposes direct Polymarket and Limitless receive venues",
    run: async () => {
      const menu = await buildTelegramDepositMessage({
        dependencies: { allowedVenues: ["polymarket", "limitless"] },
        pool: authorizationDb(null),
      });
      assert.match(menu.text, /Polymarket[\s\S]*Polygon/);
      assert.match(menu.text, /Limitless[\s\S]*Base/);
      assert.match(menu.text, new RegExp(TELEGRAM_CUSTOM_EMOJI.usdc.id));
      assert.match(JSON.stringify(menu.reply_markup), /deposit:limitless/);
      assert.match(JSON.stringify(menu.reply_markup), /deposit:any/);
      const venueButtons = menu.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        venueButtons.find((button) => button.text === "Polymarket")
          ?.icon_custom_emoji_id,
        TELEGRAM_CUSTOM_EMOJI.polymarket.id,
      );
      assert.doesNotMatch(menu.text, /Kalshi/);

      const menuWithActive = await buildTelegramDepositMessage({
        dependencies: { allowedVenues: ["polymarket", "limitless"] },
        pool: {
          query: async (sql: string) => ({
            rows: sql.includes("telegram_funding_sessions")
              ? [{ venue_id: "polymarket" }]
              : [],
          }),
        } as never,
        telegramUserId: 20,
      });
      assert.match(
        JSON.stringify(menuWithActive.reply_markup),
        /Active Deposit/u,
      );

      let activeDepositLookupSql = "";
      const menuWithReadyOnlyActive = await buildTelegramDepositMessage({
        dependencies: { allowedVenues: ["polymarket", "limitless"] },
        pool: {
          query: async (sql: string) => {
            if (sql.includes("telegram_funding_sessions")) {
              activeDepositLookupSql = sql;
              return {
                rows: [
                  {
                    has_uncancellable_workflow: false,
                    venue_id: "polymarket",
                  },
                ],
              };
            }
            return { rows: [] };
          },
        } as never,
        telegramUserId: 20,
      });
      assert.match(
        JSON.stringify(menuWithReadyOnlyActive.reply_markup),
        /Active Deposit/u,
      );
      assert.match(
        JSON.stringify(menuWithReadyOnlyActive.reply_markup),
        /deposit_cancel_active/u,
        "a settled ready-only receipt must not hide the safe Cancel action",
      );
      assert.equal(
        [
          ...activeDepositLookupSql.matchAll(
            /status in \('observed', 'routing'\)/gu,
          ),
        ].length,
        2,
        "both the menu priority and late-observation branch must use the same money-in-flight receipt states",
      );
      assert.doesNotMatch(activeDepositLookupSql, /review_required/u);
      assert.match(activeDepositLookupSql, /observe_until > now\(\)/u);

      const menuWithUnresolvedReceipt = await buildTelegramDepositMessage({
        dependencies: { allowedVenues: ["polymarket", "limitless"] },
        pool: {
          query: async (sql: string) => ({
            rows: sql.includes("telegram_funding_sessions")
              ? [
                  {
                    has_uncancellable_workflow: true,
                    venue_id: "polymarket",
                  },
                ]
              : [],
          }),
        } as never,
        telegramUserId: 20,
      });
      assert.doesNotMatch(
        JSON.stringify(menuWithUnresolvedReceipt.reply_markup),
        /deposit_cancel_active/u,
        "an unresolved receipt must keep Cancel hidden while money is handled",
      );

      const justDeposit = await buildTelegramDepositMessage({
        pool: authorizationDb(null),
        venue: "any",
      });
      assert.match(justDeposit.text, /Any \/ Just Deposit/u);
      assert.match(justDeposit.text, /automatically prepare/u);
      assert.match(JSON.stringify(justDeposit.reply_markup), /pUSD · Polygon/u);
      assert.match(
        JSON.stringify(justDeposit.reply_markup),
        /USDC\.e · Polygon/u,
      );
      assert.match(JSON.stringify(justDeposit.reply_markup), /USDC · Base/u);
      assert.doesNotMatch(
        JSON.stringify(justDeposit.reply_markup),
        /deposit_route:(?:pn|pb)/u,
      );

      const limitless = await buildTelegramDepositMessage({
        pool: authorizationDb(owner),
        venue: "limitless",
      });
      assert.equal(limitless.venue, undefined);
      assert.match(limitless.text, /Receive unavailable/);
      assert.doesNotMatch(limitless.text, new RegExp(owner, "i"));
      const markup = JSON.stringify(limitless.reply_markup);
      assert.doesNotMatch(
        markup,
        /deposit_qr:limitless|venue=limitless|address=/,
      );
    },
  },
  {
    name: "legacy Polymarket builder has no address resolution path",
    run: async () => {
      const calls: string[] = [];
      const message = await buildTelegramDepositMessage({
        pool: {
          query: async (sql: string) => {
            calls.push(sql);
            return { rows: [] };
          },
        } as never,
        venue: "polymarket",
      });
      assert.match(message.text, /Receive unavailable/);
      assert.doesNotMatch(message.text, new RegExp(deposit, "i"));
      assert.deepEqual(calls, []);
    },
  },
  {
    name: "funding QR data is rejected outside durable delivery",
    run: async () => {
      let legacyRenderCalls = 0;
      let legacyRenderedText = "";
      assert.equal(
        await handleSignalBotInteractiveMenuCallback({
          callbackPrefix: "hm:v1:",
          chatId: "20",
          idempotencyKey: "funding:legacy-qr",
          loadFunding: async () => ({
            qrText: deposit,
            text: "Legacy Polymarket deposit",
            venue: "polymarket",
          }),
          messageId: 420,
          redis: { get: async () => null },
          render: async (message) => {
            legacyRenderCalls += 1;
            legacyRenderedText = message.text;
          },
          renderExpiredSearch: async () => undefined,
          route: { kind: "deposit", showQr: true, venue: "polymarket" },
          telegramUserId: 20,
        }),
        true,
      );
      assert.equal(await drainSignalBotFundingOpenTasks(1_000), true);
      assert.equal(legacyRenderCalls, 1);
      assert.match(legacyRenderedText, /Receive unavailable/u);
      assert.doesNotMatch(legacyRenderedText, new RegExp(deposit, "iu"));

      let a1RenderCalls = 0;
      assert.equal(
        await handleSignalBotInteractiveMenuCallback({
          callbackPrefix: "hm:v1:",
          chatId: "21",
          idempotencyKey: "funding:a1-no-qr",
          loadFunding: async () => ({ text: "Choose pUSD on Polygon" }),
          messageId: 421,
          redis: { get: async () => null },
          render: async () => {
            a1RenderCalls += 1;
          },
          renderExpiredSearch: async () => undefined,
          route: { kind: "deposit", showQr: true, venue: "polymarket" },
          telegramUserId: 21,
        }),
        true,
      );
      assert.equal(await drainSignalBotFundingOpenTasks(1_000), true);
      assert.equal(a1RenderCalls, 1);
    },
  },
  {
    name: "Limitless callback opens the durable funding flow",
    run: async () => {
      let renderCalls = 0;
      let fundingCalls = 0;
      let requestedVenue = "";
      let renderedText = "";
      await handleSignalBotInteractiveMenuCallback({
        callbackPrefix: "hm:v1:",
        chatId: "20",
        loadFunding: async (input) => {
          fundingCalls += 1;
          requestedVenue = input.venue ?? "";
          return { text: "Choose USDC on Base" };
        },
        messageId: 42,
        redis: { get: async () => null },
        render: async (message) => {
          renderCalls += 1;
          renderedText = message.text;
        },
        renderExpiredSearch: async () => undefined,
        route: { kind: "deposit", showQr: true, venue: "limitless" },
        telegramUserId: 20,
      });
      assert.equal(await drainSignalBotFundingOpenTasks(1_000), true);
      assert.equal(fundingCalls, 1);
      assert.equal(requestedVenue, "limitless");
      assert.equal(renderCalls, 1);
      assert.match(renderedText, /Choose USDC on Base/);
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
