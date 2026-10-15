// @requires-db
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import "./integration-test-database-guard.js";
import { pool } from "./db.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import { buildTelegramBotTradingMarketMessage } from "./services/telegram-bot-trading.js";
import { createTelegramBotTradingRoutes } from "./routes/telegram-bot-trading.js";

const client = await pool.connect();
try {
  await client.query("begin");
  const lifecycle = await installHip4TestLifecycle(client);
  await client.query(
    "insert into runtime_policies(id,policy_key,effective_at,payload) values($1,'hip4_read',now(),$2)",
    [randomUUID(), JSON.stringify({ environment: "mainnet" })],
  );
  const outcome = randomInt(100_000_000, 800_000_000);
  const eventId = `hyperliquid:mainnet:question:${outcome}`;
  const marketId = `hyperliquid:mainnet:outcome:${outcome}`;
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'hyperliquid',$2,'Premier League Winner','ACTIVE')",
    [eventId, String(outcome)],
  );
  await client.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes) values($1,'hyperliquid',$2,$3,'Arsenal','ACTIVE','binary',$4)",
    [marketId, String(outcome), eventId, JSON.stringify(["Yes", "No"])],
  );

  const telegramUserId = `navigation-only-${randomUUID()}`;
  const input = {
    db: client,
    appBaseUrl: "https://app.hunch.test",
    telegramMiniAppEnabled: true,
    chatId: "123",
    telegramUserId,
    marketRef: marketId,
    context: { origin: "search" as const, focusSide: "NO" as const },
    signerInspector: async () => {
      throw new Error("Navigation must not inspect a signer grant");
    },
  };
  for (const marketRef of [
    marketId,
    `https://app.hunch.test/events/${encodeURIComponent(eventId)}?market=${encodeURIComponent(marketId)}`,
  ]) {
    const message = await buildTelegramBotTradingMarketMessage({
      ...input,
      marketRef,
    });
    assert.equal(message.marketFound, true);
    assert.match(message.text, /Arsenal/);
    const buttons = message.reply_markup?.inline_keyboard.flat() ?? [];
    const launch = buttons.find((button) => "web_app" in button);
    assert.ok(launch && "web_app" in launch);
    const start = new URL(launch.web_app.url).searchParams.get(
      "tgWebAppStartParam",
    );
    assert.ok(start);
    assert.ok(start.startsWith("m_"));
    assert.equal(
      Buffer.from(start.slice(2), "base64url").toString(),
      `${eventId}|${marketId}|N`,
    );
    assert.equal(
      buttons.some(
        (button) =>
          "callback_data" in button &&
          /buy|sell|confirm|deposit/.test(button.callback_data),
      ),
      false,
    );
  }
  // Re-read policy for each card: stale persisted rows must not bypass hiding.
  await client.query(
    "update runtime_policies set payload=jsonb_set(payload,'{venues,hyperliquid,lifecycle}','\"unreleased\"') where id=$1",
    [lifecycle.id],
  );
  assert.equal(
    (await buildTelegramBotTradingMarketMessage(input)).marketFound,
    false,
  );
  await client.query(
    "update runtime_policies set payload=jsonb_set(payload,'{venues,hyperliquid,lifecycle}','\"active\"') where id=$1",
    [lifecycle.id],
  );
  assert.equal(
    (await buildTelegramBotTradingMarketMessage(input)).marketFound,
    true,
  );
  const intents = await client.query(
    "select id from telegram_trade_intents where telegram_user_id=$1",
    [telegramUserId],
  );
  assert.equal(intents.rowCount, 0);
  for (const reconciliationEnabled of [false, true]) {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      createTelegramBotTradingRoutes({
        db: client,
        reconciliationEnabled,
        internalPreHandler: async (request, reply) => {
          if (request.headers["x-test-internal"] !== "yes")
            return reply.code(401).send({ error: "unauthorized" });
        },
        createTrading: () => {
          throw new Error("Navigation must not create a trading executor");
        },
        signerInspector: async () => {
          throw new Error("Navigation must not inspect a signer");
        },
      }),
    );
    try {
      const body = {
        appBaseUrl: input.appBaseUrl,
        chatId: input.chatId,
        telegramUserId,
        marketRef: marketId,
        context: input.context,
        telegramMiniAppEnabled: true,
      };
      const denied = await app.inject({
        method: "POST",
        url: "/internal/telegram-bot/trading/market-card",
        payload: body,
      });
      assert.equal(denied.statusCode, 401);
      const response = await app.inject({
        method: "POST",
        url: "/internal/telegram-bot/trading/market-card",
        headers: { "x-test-internal": "yes" },
        payload: body,
      });
      assert.equal(response.statusCode, 200, response.body);
      const message = response.json();
      assert.equal(message.marketFound, true);
      const launch = message.reply_markup.inline_keyboard
        .flat()
        .find((button: { web_app?: { url: string } }) => button.web_app);
      assert.ok(launch);
      const start = new URL(launch.web_app.url).searchParams.get(
        "tgWebAppStartParam",
      );
      assert.ok(start);
      assert.equal(
        Buffer.from(start.slice(2), "base64url").toString(),
        `${eventId}|${marketId}|N`,
      );
      const review = message.reply_markup.inline_keyboard
        .flat()
        .find(
          (button: { text: string }) => button.text === "Review NO in Hunch",
        );
      assert.ok(review?.web_app);
      const reviewStart = new URL(review.web_app.url).searchParams.get(
        "tgWebAppStartParam",
      );
      assert.ok(reviewStart);
      assert.ok(reviewStart.startsWith("b_"));
      assert.equal(
        Buffer.from(reviewStart.slice(2), "base64url").toString(),
        `${eventId}|${marketId}|N|`,
      );
      const pasted = await app.inject({
        method: "POST",
        url: "/internal/telegram-bot/trading/market-card",
        headers: { "x-test-internal": "yes" },
        payload: {
          ...body,
          context: undefined,
          marketRef: `https://app.hunch.test/events/${encodeURIComponent(eventId)}?market=${encodeURIComponent(marketId)}&side=NO`,
        },
      });
      assert.equal(pasted.statusCode, 200, pasted.body);
      assert.equal(
        pasted.json().reply_markup.inline_keyboard[0][0].web_app.url,
        launch.web_app.url,
        "pasted link keeps selected NO without separately supplied context",
      );
      if (!reconciliationEnabled) {
        const legacy = await app.inject({
          method: "POST",
          url: "/internal/telegram-bot/trading/market-card",
          headers: { "x-test-internal": "yes" },
          payload: { ...body, marketRef: "limitless:123" },
        });
        assert.equal(legacy.statusCode, 200);
        assert.match(legacy.json().text, /Trading temporarily unavailable/);
      }
    } finally {
      await app.close();
    }
  }
  assert.equal(
    (
      await client.query(
        "select id from telegram_trade_intents where telegram_user_id=$1",
        [telegramUserId],
      )
    ).rowCount,
    0,
  );
  console.log(
    "[telegram-app-market-navigation-integration-tests] actual card issuer, policy off/on, exact navigation and no trade intents passed",
  );
} finally {
  await client.query("rollback");
  client.release();
}
