// @requires-db — disposable PG16; synthetic identities, no provider or Telegram IO.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createTelegramBotTradingRoutes } from "./routes/telegram-bot-trading.js";
import { tx } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { findTradeMarketById } from "./services/api-trading-market-repo.js";
import {
  HIP4_ORDER_CONTROLLER_SQL,
  HIP4_ORDER_UNAMBIGUOUS_CONTROLLER_SQL,
  readHip4OrderController,
  readUnambiguousHip4OrderController,
} from "./repos/hip4-order-controller.js";
import { buildTelegramAppHandoffNativeAuthority } from "./services/telegram-app-handoff-native-authority.js";
import {
  createTelegramNativeTradeDraft,
  prepareTelegramNativeAppHandoff,
  cancelTelegramNativeReview,
  handleTelegramNativeAppHandoffCallback,
  readTelegramNativeTradeIntent,
  TELEGRAM_NATIVE_REVIEW_INTENT_SQL,
  TelegramNativeAppHandoffError,
  addTelegramNativeTradeChoices,
  TELEGRAM_NATIVE_INPUT_REPLAY_SQL,
  type TelegramNativeReviewDependencies,
} from "./services/telegram-native-app-handoff.js";
import {
  telegramAppHandoffV2CurrentScope,
  telegramBotTradingTestHooks,
  completeTelegramBotTradeInput,
  handleTelegramBotTradingCallback,
  resolveTelegramTradeExecutionCapability,
} from "./services/telegram-bot-trading.js";
import { completeTelegramNativeTradeInput } from "./services/telegram-native-trade-input.js";
import type { TelegramNativeTradeInputContext } from "./services/telegram-bot-trade-input-context.js";
import { telegramAppHandoffNativeAuthoritySchema } from "./services/telegram-app-handoff-native-authority.js";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { telegramAppHandoffNativeTradeSchema } from "./services/telegram-app-handoff-native-trade.js";
import { parseTelegramAppHandoffV2Plan } from "./services/telegram-app-handoff-v2.js";
import {
  claimTelegramAppHandoff,
  cancelTelegramAppHandoff,
  TelegramAppHandoffError,
} from "./services/telegram-app-handoff.js";
import { buildTelegramNativeTradeShortfallRequest } from "./services/telegram-native-trade-shortfall.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=10000 -c lock_timeout=5000 -c jit=off",
});
const tokenSecret = "synthetic-offline-native-review-producer";
const policyIds: string[] = [];
let quoteCalls = 0,
  fundingCalls = 0;
let beforeQuoteReturn: (() => Promise<void>) | undefined;
const signalPolicy = {
  miniAppHandoffMode: "always",
  miniAppHandoffContractVersion: 2,
  buyContinuationEnabled: true,
  fundingReceiveEnabled: true,
  tradingEnabled: true,
  tradingActions: ["buy", "sell"],
  customTradeInputEnabled: true,
  maxTradeAmountUsd: 100,
};
const dependencies: TelegramNativeReviewDependencies = {
  scope: telegramAppHandoffV2CurrentScope,
  hasOtherUnresolved: async (db, input) =>
    (await telegramBotTradingTestHooks.loadUnresolvedTelegramTradeIntent(
      db,
      input,
    )) != null,
  quote: async (db, input) => {
    quoteCalls++;
    const profile = await readHip4OrderController(db, {
      userId: input.userId,
      controllerWalletRef: input.request.controllerWalletRef,
    });
    const nativeTrade = telegramAppHandoffNativeTradeSchema.parse({
      version: "hip4-ioc-v1",
      environment: "mainnet",
      marketId: input.request.marketId,
      outcomeSide: input.request.outcomeSide,
      side: input.request.side,
      controllerWalletRef: input.request.controllerWalletRef,
      consentedDebitCapRaw: input.request.consentedDebitCapRaw,
      outcomeTokenId:
        input.request.outcomeSide === "YES"
          ? input.market.token_yes
          : input.market.token_no,
      timeInForce: "Ioc",
      quantity:
        input.request.side === "SELL"
          ? (BigInt(input.request.consentedDebitCapRaw) / 100000n).toString()
          : "4",
      limitPrice: "0.4",
    });
    const authority = buildTelegramAppHandoffNativeAuthority({
      ...input,
      profile,
    });
    const expiresAt = new Date(Date.now() + 60000);
    await beforeQuoteReturn?.();
    return {
      authority,
      expiresAt,
      trade: {
        action: input.request.side.toLowerCase(),
        venue: "hyperliquid",
        marketId: input.market.id,
        eventId: input.market.event_id,
        marketTitle: input.market.title,
        side: input.request.outcomeSide,
        controllerWalletAddress: profile.address,
        outcomeTokenId: nativeTrade.outcomeTokenId,
        nativeTrade,
      },
      quoteSnapshot: {
        version: "hip4-ioc-v1",
        nativeTrade,
        expiresAt: expiresAt.toISOString(),
      },
      requiredSpend:
        input.request.side === "BUY"
          ? { asset: HYPERCORE_MAINNET_USDC, raw: "160000000" }
          : null,
    };
  },
  inspectFunding: async () => {
    fundingCalls++;
    return { kind: "destination_ready" };
  },
};

async function fixture(side: "BUY" | "SELL" = "BUY") {
  const base = await tx(pool, (db) => hip4OrderTestFixture(db));
  await pool.query(
    `insert into unified_market_tokens(market_id,token_id,venue,outcome_side)
    select market_id,token_id,venue,side from unified_tokens where market_id=$1`,
    [base.request.marketId],
  );
  const telegramUserId = `88${BigInt(`0x${randomBytes(5).toString("hex")}`)}`;
  await pool.query(
    "insert into user_telegram_accounts(user_id,privy_user_id,telegram_user_id) values($1,$2,$3)",
    [base.userId, `did:privy:${base.userId}`, telegramUserId],
  );
  const market = await findTradeMarketById(pool, base.request.marketId);
  assert.ok(market);
  const request = {
    requestKey: randomUUID(),
    marketId: market.id,
    side,
    outcomeSide: base.request.outcomeSide,
    controllerWalletRef: base.request.controllerWalletRef,
    consentedDebitCapRaw: side === "BUY" ? "1000000000" : "450000",
    slippageBps: 100,
  };
  const input = {
    db: pool,
    telegramUserId,
    chatId: telegramUserId,
    market,
    request,
  };
  const id = await createTelegramNativeTradeDraft(input);
  const prepareInput = {
    db: pool,
    intentId: id,
    telegramUserId,
    chatId: telegramUserId,
    telegramMessageId: 22,
    tokenSecret,
  };
  return { ...base, telegramUserId, market, request, input, id, prepareInput };
}

try {
  assert.match(
    (await pool.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  policyIds.push(
    (
      await pool.query(
        `insert into runtime_policies(policy_key,effective_at,payload)
    values('signal_bot',clock_timestamp(),$1::jsonb) returning id`,
        [signalPolicy],
      )
    ).rows[0].id,
  );
  policyIds.push(
    (
      await pool.query(
        "insert into runtime_policies(policy_key,effective_at,payload) values('venue_lifecycle',clock_timestamp(),$1::jsonb) returning id",
        [
          {
            ...DEFAULT_VENUE_LIFECYCLE_POLICY,
            venues: {
              ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
              hyperliquid: { lifecycle: "active", indexerMode: "full" },
            },
          },
        ],
      )
    ).rows[0].id,
  );

  for (const action of ["buy", "sell"] as const) {
    const data = await fixture(action === "buy" ? "BUY" : "SELL");
    const baseIntent = await readTelegramNativeTradeIntent(pool, data.id);
    assert.ok(baseIntent);
    const context: TelegramNativeTradeInputContext = {
      version: 3,
      venue: "hyperliquid",
      deliveryMode: "app_handoff",
      action,
      side: data.request.outcomeSide,
      authority: telegramAppHandoffNativeAuthoritySchema.parse(
        baseIntent.result.appHandoffNativeAuthority,
      ),
      id: randomUUID(),
      marketId: data.market.id,
      eventId: data.market.event_id,
      chatId: data.telegramUserId,
      telegramUserId: data.telegramUserId,
      controlledPositionId: null,
      funderAddress: null,
      messageScope: { kind: "exact_message", messageId: 22 },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const completeInput = {
      db: pool,
      context,
      contextId: context.id,
      telegramUserId: data.telegramUserId,
      chatId: data.telegramUserId,
      telegramMessageId: 22,
      value: action === "buy" ? "$2.50" : "25%",
      tokenSecret,
      miniAppEnabled: true,
      isLinkCurrent: async () => true,
    };
    const customDependencies = {
      ...dependencies,
      sellAvailable: async () => 1050000n,
    };
    const result = await completeTelegramNativeTradeInput(
      completeInput,
      customDependencies,
    );
    assert.ok(
      result.completed,
      result.completed ? undefined : result.notice.body,
    );
    const recorded = await readTelegramNativeTradeIntent(
      pool,
      result.review.intent.id,
    );
    assert.ok(recorded);
    const marker = recorded.result.nativeInput;
    assert.ok(marker);
    const nativePlan = parseTelegramAppHandoffV2Plan(
      result.review.handoff.planSnapshot,
    );
    assert.equal(nativePlan.trade.venue, "hyperliquid");
    if (action === "sell")
      assert.equal(
        (nativePlan.trade.nativeTrade as { quantity: string }).quantity,
        "2",
      );
    const calls = quoteCalls;
    const resumed = await completeTelegramNativeTradeInput(
      {
        ...completeInput,
        context: undefined,
        intentId: result.review.intent.id,
        value: action === "buy" ? "2.5" : "25.000000%",
      },
      customDependencies,
    );
    assert.ok(resumed.completed);
    assert.equal(resumed.review.handoff.id, result.review.handoff.id);
    assert.equal(
      quoteCalls,
      calls,
      "same input resumes existing Review before provider IO",
    );
    const sharedReplay = await completeTelegramBotTradeInput({
      appBaseUrl: "https://app.example.test",
      db: pool,
      contextId: context.id,
      chatId: data.telegramUserId,
      telegramUserId: data.telegramUserId,
      value: completeInput.value,
      telegramMessageId: 22,
      telegramMiniAppEnabled: true,
      isLinkCurrent: async () => true,
      loadContext: async () => {
        throw new Error(
          "Redis is not required to replay a saved native selection",
        );
      },
      nativeReviewQuote: async () => {
        throw new Error("Replay may not quote again");
      },
      inspectNativeMiniAppFunding: async () => {
        throw new Error("Replay may not discover funding again");
      },
      trading: {} as never,
    });
    assert.equal(
      sharedReplay.completed,
      true,
      "shared custom handler dispatches native before legacy signer/economics",
    );
    assert.match(sharedReplay.message.text, /Review/u);
    assert.ok(
      sharedReplay.message.reply_markup?.inline_keyboard
        .flat()
        .some((button) => button.text === `Confirm ${action}`),
    );
    assert.equal(quoteCalls, calls);
    const conflict = await completeTelegramNativeTradeInput(
      {
        ...completeInput,
        intentId: result.review.intent.id,
        value: action === "buy" ? "3" : "50%",
      },
      customDependencies,
    );
    assert.ok(!conflict.completed);
    assert.equal(conflict.notice.title, "Input conflict");
    assert.equal(quoteCalls, calls);
    const otherCard = await completeTelegramNativeTradeInput(
      {
        ...completeInput,
        intentId: result.review.intent.id,
        telegramMessageId: 23,
      },
      customDependencies,
    );
    assert.ok(!otherCard.completed);
    assert.equal(quoteCalls, calls);
    const noIo = await pool.query<{ count: number }>(
      "select (select count(*) from hip4_order_actions native_action join orders placed_order on placed_order.id=native_action.order_id where placed_order.user_id=$1)::int+(select count(*) from funding_operations where user_id=$1)::int as count",
      [data.userId],
    );
    assert.equal(noIo.rows[0].count, 0);
  }
  console.log(
    "PASS custom native BUY/Sell exact Review, normalized idempotent resume, conflicting input/card refusal and no financial mutation",
  );

  for (const action of ["buy", "sell"] as const) {
    const data = await fixture(action === "buy" ? "BUY" : "SELL");
    const initial = await readTelegramNativeTradeIntent(pool, data.id);
    assert.ok(initial);
    const selection = {
      contextId: randomUUID(),
      normalized: action === "buy" ? "2.50" : "2",
      mode: action === "buy" ? ("usd" as const) : ("shares" as const),
      authority: telegramAppHandoffNativeAuthoritySchema.parse(
        initial.result.appHandoffNativeAuthority,
      ),
    };
    const customId = await createTelegramNativeTradeDraft({
      ...data.input,
      inputSelection: selection,
    });
    const prepareInput = { ...data.prepareInput, intentId: customId };
    await assert.rejects(
      prepareTelegramNativeAppHandoff(prepareInput, {
        ...dependencies,
        quote: async () => {
          throw new TelegramNativeAppHandoffError("funding_unavailable");
        },
      }),
      /funding_unavailable/u,
    );
    for (const override of [
      { customTradeInputEnabled: false },
      { tradingEnabled: false },
      { tradingActions: [] },
    ] as const) {
      const changed = (
        await pool.query(
          "insert into runtime_policies(policy_key,effective_at,payload) values('signal_bot',clock_timestamp(),$1::jsonb) returning id",
          [{ ...signalPolicy, ...override }],
        )
      ).rows[0].id as string;
      policyIds.push(changed);
      const callsBefore = quoteCalls;
      await assert.rejects(
        prepareTelegramNativeAppHandoff(prepareInput, dependencies),
        /policy_changed/u,
      );
      assert.equal(
        quoteCalls,
        callsBefore,
        "disabled custom policy prevents publication before provider IO",
      );
      await pool.query("delete from runtime_policies where id=$1", [changed]);
    }
    const recovered = await prepareTelegramNativeAppHandoff(
      prepareInput,
      dependencies,
    );
    const disabled = (
      await pool.query(
        "insert into runtime_policies(policy_key,effective_at,payload) values('signal_bot',clock_timestamp(),$1::jsonb) returning id",
        [{ ...signalPolicy, customTradeInputEnabled: false }],
      )
    ).rows[0].id as string;
    policyIds.push(disabled);
    assert.equal(
      (
        await prepareTelegramNativeAppHandoff(prepareInput, {
          ...dependencies,
          quote: async () => {
            throw new Error("existing Review cannot re-quote");
          },
        })
      ).handoff.id,
      recovered.handoff.id,
      "disabled input does not hide an already-issued Review",
    );
    await pool.query("delete from runtime_policies where id=$1", [disabled]);
    const racedData = await fixture(action === "buy" ? "BUY" : "SELL");
    const racedIntent = await readTelegramNativeTradeIntent(pool, racedData.id);
    assert.ok(racedIntent);
    const racedSelection = {
      ...selection,
      contextId: randomUUID(),
      authority: telegramAppHandoffNativeAuthoritySchema.parse(
        racedIntent.result.appHandoffNativeAuthority,
      ),
    };
    const same = await Promise.all([
      createTelegramNativeTradeDraft({
        ...racedData.input,
        inputSelection: racedSelection,
      }),
      createTelegramNativeTradeDraft({
        ...racedData.input,
        inputSelection: racedSelection,
        request: { ...racedData.request, requestKey: randomUUID() },
      }),
    ]);
    assert.equal(
      same[0],
      same[1],
      "concurrent exact selection stores one immutable purchase intent",
    );
    await assert.rejects(
      createTelegramNativeTradeDraft({
        ...racedData.input,
        inputSelection: {
          ...racedSelection,
          normalized: action === "buy" ? "3.00" : "3",
        },
      }),
      /input_conflict/u,
    );
  }
  console.log(
    "PASS custom retry respects current policy, recovers after re-enable, retains issued Review and CAS-deduplicates concurrent selections",
  );

  const choiceData = await fixture();
  const contexts: TelegramNativeTradeInputContext[] = [];
  const choices = await addTelegramNativeTradeChoices(
    {
      db: pool,
      telegramUserId: choiceData.telegramUserId,
      chatId: choiceData.telegramUserId,
      telegramMessageId: 22,
      marketId: choiceData.market.id,
      miniAppEnabled: true,
      navigation: { marketFound: true, text: "Market" },
      writeTradeInputContext: async (context) => {
        assert.equal(context.version, 3);
        contexts.push(context as TelegramNativeTradeInputContext);
        return true;
      },
    },
    { sellAvailable: async () => 450000n },
  );
  const choiceButtons = choices.reply_markup?.inline_keyboard.flat() ?? [];
  assert.ok(choiceButtons.some((button) => button.text === "Custom Buy YES"));
  assert.ok(choiceButtons.some((button) => button.text === "Custom Sell NO"));
  assert.ok(choiceButtons.some((button) => button.text === "Sell YES all"));
  assert.equal(contexts.length, 4);
  for (const action of ["buy", "sell"] as const)
    assert.deepEqual(
      resolveTelegramTradeExecutionCapability({
        action,
        venue: "hyperliquid",
        walletChain: "ethereum",
      }),
      { sealedAppHandoffExact: true, serverBotExact: false },
    );
  console.log(
    "PASS native market card uses shared buy/custom/Sell input buttons and never grants a bot executor",
  );
  const buyOnlyPolicy = (
    await pool.query(
      "insert into runtime_policies(policy_key,effective_at,payload) values('signal_bot',clock_timestamp(),$1::jsonb) returning id",
      [{ ...signalPolicy, tradingActions: ["buy"] }],
    )
  ).rows[0].id as string;
  policyIds.push(buyOnlyPolicy);
  const reopenedContexts: TelegramNativeTradeInputContext[] = [];
  const reopenedMessages: Array<{ text: string }> = [];
  assert.equal(
    await handleTelegramBotTradingCallback({
      db: pool,
      appBaseUrl: "https://app.example.test",
      telegramMiniAppEnabled: true,
      callbackQuery: {
        id: randomUUID(),
        data: `hbt:open_market:${choiceData.id}`,
        from: { id: Number(choiceData.telegramUserId) },
        message: {
          chat: { id: choiceData.telegramUserId, type: "private" },
          message_id: 22,
        },
      },
      answerCallbackQuery: async () => {},
      sendMessage: async (message) => {
        reopenedMessages.push(message);
      },
      writeTradeInputContext: async (context) => {
        assert.equal(context.version, 3);
        reopenedContexts.push(context as TelegramNativeTradeInputContext);
        return true;
      },
    }),
    true,
  );
  assert.equal(reopenedMessages.length, 1);
  assert.equal(
    reopenedContexts.length,
    2,
    "normal callback retains custom Buy on both outcomes",
  );
  assert.ok(
    reopenedContexts.every(
      (context) => context.messageScope.kind === "new_message_unbound",
    ),
    "a new market card does not inherit the old Review message carrier",
  );
  assert.equal(
    (await readTelegramNativeTradeIntent(pool, choiceData.id))
      ?.telegram_message_id,
    null,
    "navigation never rebinds the previous intent",
  );
  for (const reconciliationEnabled of [false, true]) {
    const routeContexts: TelegramNativeTradeInputContext[] = [];
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      createTelegramBotTradingRoutes({
        db: pool,
        reconciliationEnabled,
        internalPreHandler: async (request, reply) => {
          if (request.headers["x-fixture-internal"] !== "yes")
            return reply.code(401).send({ error: "unauthorized" });
        },
        createTrading: () => {
          throw new Error("native card does not create a bot executor");
        },
        signerInspector: async () => {
          throw new Error("native card does not inspect bot grants");
        },
        writeTradeInputContext: async (context) => {
          assert.equal(context.version, 3);
          routeContexts.push(context as TelegramNativeTradeInputContext);
          return true;
        },
      }),
    );
    try {
      const payload = {
        appBaseUrl: "https://app.example.test",
        chatId: choiceData.telegramUserId,
        telegramUserId: choiceData.telegramUserId,
        marketRef: choiceData.market.id,
        telegramMessageId: 32,
        telegramMiniAppEnabled: true,
        context: { origin: "search", focusSide: "NO" },
      };
      const denied = await app.inject({
        method: "POST",
        url: "/internal/telegram-bot/trading/market-card",
        payload,
      });
      assert.equal(denied.statusCode, 401);
      assert.equal(routeContexts.length, 0);
      const response = await app.inject({
        method: "POST",
        url: "/internal/telegram-bot/trading/market-card",
        headers: { "x-fixture-internal": "yes" },
        payload,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(
        routeContexts.length,
        1,
        "ordinary market-card wires the shared custom writer",
      );
      assert.equal(routeContexts[0].side, "NO");
      assert.equal(routeContexts[0].origin, "search");
      assert.deepEqual(routeContexts[0].messageScope, {
        kind: "exact_message",
        messageId: 32,
      });
    } finally {
      await app.close();
    }
  }
  await pool.query("delete from runtime_policies where id=$1", [buyOnlyPolicy]);
  console.log(
    "PASS normal Open market callback preserves custom choices on a fresh carrier, without rebinding an old Review",
  );
  quoteCalls = fundingCalls = 0;
  for (const side of ["BUY", "SELL"] as const) {
    const data = await fixture(side);
    assert.equal(
      (await readUnambiguousHip4OrderController(pool, data.userId))
        ?.controllerWalletRef,
      data.profile.controllerWalletRef,
    );
    const issued = await prepareTelegramNativeAppHandoff(
      data.prepareInput,
      dependencies,
    );
    assert.equal(issued.handoff.state, "issued");
    const plan = parseTelegramAppHandoffV2Plan(issued.handoff.planSnapshot);
    assert.equal(plan.kind, "direct_trade");
    assert.equal(plan.trade.venue, "hyperliquid");
    assert.equal(plan.trade.minimumReceiveRaw, undefined);
    const stored = await readTelegramNativeTradeIntent(pool, data.id);
    assert.ok(stored);
    assert.equal(stored?.status, "previewed");
    assert.equal(stored?.telegram_message_id, "22");
    assert.ok(
      stored.expires_at.getTime() > Date.now() + 60000,
      "economic consent TTL is not the book TTL",
    );
    const noIO = {
      ...dependencies,
      quote: async () => {
        throw new Error("must not re-quote");
      },
      inspectFunding: async () => {
        throw new Error("must not rediscover");
      },
    };
    assert.deepEqual(
      await prepareTelegramNativeAppHandoff(data.prepareInput, noIO),
      issued,
      "lost response reopens original Review",
    );
    const token = issued.startParam.slice("handoff_".length);
    await claimTelegramAppHandoff({
      db: pool,
      userId: data.userId,
      telegramUserId: data.telegramUserId,
      token,
    });
    assert.equal(
      (await prepareTelegramNativeAppHandoff(data.prepareInput, noIO)).handoff
        .state,
      "claimed",
    );
    await cancelTelegramAppHandoff({
      db: pool,
      userId: data.userId,
      telegramUserId: data.telegramUserId,
      token,
    });
    assert.equal(
      (await prepareTelegramNativeAppHandoff(data.prepareInput, noIO)).handoff
        .state,
      "cancelled",
    );
  }
  assert.equal(quoteCalls, 2);
  assert.equal(fundingCalls, 1, "SELL never creates a funding request");
  console.log(
    "PASS real shared issuer/scope/claim/cancel, native direct BUY+SELL, immutable replay without quote/funding IO",
  );

  for (const state of ["draft", "issued", "expired", "started"] as const) {
    const data = await fixture();
    if (state !== "draft")
      await prepareTelegramNativeAppHandoff(data.prepareInput, dependencies);
    if (state === "expired")
      await pool.query(
        "update telegram_trade_intents set expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [data.id],
      );
    if (state === "started")
      await pool.query(
        `update telegram_trade_intents set status='executing',submit_started_at=clock_timestamp(),
          result=result||jsonb_build_object('appHandoffExecution',jsonb_build_object(
            'version',2,'kind','direct_trade','committedAt',clock_timestamp())) where id=$1`,
        [data.id],
      );
    const current = await readTelegramNativeTradeIntent(pool, data.id);
    assert.ok(current);
    const expected =
      state === "expired"
        ? "expired"
        : state === "started"
          ? "in_flight"
          : "cancelled";
    assert.equal(
      await cancelTelegramNativeReview({
        db: pool,
        intent: current,
        tokenSecret,
      }),
      expected,
    );
    assert.equal(
      await cancelTelegramNativeReview({
        db: pool,
        intent: current,
        tokenSecret,
      }),
      expected,
      "lost Cancel response is idempotent",
    );
    const answers: unknown[] = [];
    assert.equal(
      await handleTelegramNativeAppHandoffCallback({
        callback: {
          db: pool,
          appBaseUrl: "https://app.example.test",
          callbackQuery: {
            id: randomUUID(),
            from: { id: Number(data.telegramUserId) },
            message: {
              chat: { id: data.telegramUserId, type: "private" },
              message_id: 22,
            },
          },
          answerCallbackQuery: async (answer) => {
            answers.push(answer);
          },
          sendMessage: async () => {
            throw new Error("cancel is a callback acknowledgement");
          },
        },
        callbackType: "cancel",
        intentId: data.id,
        tokenSecret,
        miniAppLinkBase: null,
        dependencies,
        buildMarket: async () => ({ text: "Market" }),
        fundingReviewLines: async () => [],
        renderLifecycle:
          telegramBotTradingTestHooks.formatTelegramTradeLifecycleMessageMarkdownV2,
      }),
      true,
    );
    assert.equal(
      answers.length,
      1,
      "cancel callback must acknowledge instead of throwing an HTTP error",
    );
  }
  console.log(
    "PASS repeated draft/issued/expired/submit-won Cancel callbacks are factual, idempotent and never throw",
  );

  const stalePolicy = await fixture();
  const reduced = (
    await pool.query(
      "insert into runtime_policies(policy_key,effective_at,payload) values('signal_bot',clock_timestamp(),$1::jsonb) returning id",
      [
        {
          miniAppHandoffMode: "always",
          miniAppHandoffContractVersion: 2,
          buyContinuationEnabled: true,
          fundingReceiveEnabled: true,
          maxSlippageBps: 10,
        },
      ],
    )
  ).rows[0].id as string;
  policyIds.push(reduced);
  const beforeCalls = quoteCalls;
  await assert.rejects(
    prepareTelegramNativeAppHandoff(stalePolicy.prepareInput, dependencies),
    /policy_changed/u,
  );
  assert.equal(
    quoteCalls,
    beforeCalls,
    "stale wider slippage does not reach provider quote under a new policy revision",
  );
  const freshId = await createTelegramNativeTradeDraft({
    ...stalePolicy.input,
    request: { ...stalePolicy.request, slippageBps: 10 },
  });
  assert.equal(
    (
      await prepareTelegramNativeAppHandoff(
        { ...stalePolicy.prepareInput, intentId: freshId },
        dependencies,
      )
    ).handoff.state,
    "issued",
  );
  await pool.query("delete from runtime_policies where id=$1", [reduced]);
  console.log(
    "PASS tightened current slippage rejects old unconsented draft; fresh policy-sized choice recovers",
  );

  const funded = await fixture();
  const issuedFunded = await prepareTelegramNativeAppHandoff(
    funded.prepareInput,
    {
      ...dependencies,
      inspectFunding: async (input, trade) => ({
        kind: "web_funding_plan",
        plan: parseTelegramAppHandoffV2Plan({
          version: 2,
          executionContractVersion: 2,
          kind: "funding",
          trade,
          funding: {
            discoveryRequest: buildTelegramNativeTradeShortfallRequest(
              input,
              trade,
            ),
            destination: {
              controllerWalletId: funded.request.controllerWalletRef,
              destinationOptionId: randomUUID(),
              requiredAsset: HYPERCORE_MAINNET_USDC,
              topology: "native_hypercore",
              venueBindingId: randomUUID(),
              venueBindingOptionId: randomUUID(),
              venueId: "hyperliquid",
            },
            fundingPolicyRevision: "offline-test",
            sourceDebits: [
              {
                asset: HYPERCORE_MAINNET_USDC,
                maximumRaw: "160000000",
                locationId: randomUUID(),
                sourceFingerprint: "a".repeat(64),
              },
            ],
          },
        }),
      }),
    },
  );
  assert.equal(issuedFunded.handoff.planSnapshot.kind, "funding");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as row_count from funding_operations where user_id=$1",
        [funded.userId],
      )
    ).rows[0].row_count,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as row_count from hip4_order_actions native_action join orders placed_order on placed_order.id=native_action.order_id where placed_order.user_id=$1",
        [funded.userId],
      )
    ).rows[0].row_count,
    0,
  );
  console.log(
    "PASS native BUY funding Review retains exact cash8 scope without creating an operation or order",
  );

  const concurrent = await fixture();
  const secondId = await createTelegramNativeTradeDraft({
    ...concurrent.input,
    request: { ...concurrent.request, requestKey: randomUUID() },
  });
  const raced = await Promise.allSettled([
    prepareTelegramNativeAppHandoff(concurrent.prepareInput, dependencies),
    prepareTelegramNativeAppHandoff(
      { ...concurrent.prepareInput, intentId: secondId },
      dependencies,
    ),
  ]);
  assert.equal(raced.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as row_count from telegram_app_handoffs where user_id=$1",
        [concurrent.userId],
      )
    ).rows[0].row_count,
    1,
  );
  console.log(
    "PASS concurrent same-market choices publish exactly one Review under existing M/U authority",
  );

  for (const reason of [
    "wallet",
    "link",
    "policy",
    "quote",
    "funding",
    "source",
  ] as const) {
    const data = await fixture();
    let policyId: string | undefined;
    beforeQuoteReturn = async () => {
      if (reason === "wallet")
        await pool.query(
          "update user_wallets set is_verified=false where id=$1",
          [data.profile.controllerWalletRef],
        );
      if (reason === "link")
        await pool.query(
          "delete from user_telegram_accounts where user_id=$1",
          [data.userId],
        );
      if (reason === "policy") {
        policyId = (
          await pool.query(
            "insert into runtime_policies(policy_key,effective_at,payload) values('signal_bot',clock_timestamp(),$1::jsonb) returning id",
            [{ miniAppHandoffMode: "off" }],
          )
        ).rows[0].id;
        assert.ok(policyId);
        policyIds.push(policyId);
      }
      if (reason === "source")
        await pool.query(
          "update telegram_trade_intents set telegram_message_id=23 where id=$1",
          [data.id],
        );
    };
    const broken = { ...dependencies };
    if (reason === "quote") {
      const quote = dependencies.quote;
      assert.ok(quote);
      broken.quote = async (...args) => ({
        ...(await quote(...args)),
        expiresAt: new Date(0),
      });
    }
    if (reason === "funding")
      broken.inspectFunding = async () => ({
        kind: "temporarily_unavailable",
        reasonCodes: ["test"],
      });
    await assert.rejects(
      prepareTelegramNativeAppHandoff(data.prepareInput, broken),
      (error) =>
        error instanceof TelegramNativeAppHandoffError ||
        error instanceof TelegramAppHandoffError,
    );
    beforeQuoteReturn = undefined;
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as row_count from telegram_app_handoffs where user_id=$1",
          [data.userId],
        )
      ).rows[0].row_count,
      0,
    );
    assert.equal(
      (await readTelegramNativeTradeIntent(pool, data.id))?.status,
      "draft",
    );
    if (policyId)
      await pool.query("delete from runtime_policies where id=$1", [policyId]);
    if (reason === "quote" || reason === "funding")
      assert.equal(
        (await prepareTelegramNativeAppHandoff(data.prepareInput, dependencies))
          .handoff.state,
        "issued",
        "normal retry recovers without housekeeping delay",
      );
  }
  console.log(
    "PASS wallet/link/policy/source changes, stale quote and unavailable funding roll back publication; explicit retry recovers",
  );

  const ambiguous = await fixture();
  await pool.query(
    `insert into user_wallets(id,user_id,wallet_address,wallet_type,is_verified,wallet_source,is_internal_wallet,privy_profile_updated_at)
    values($1,$2,$3,'ethereum',true,'external',false,clock_timestamp())`,
    [
      randomUUID(),
      ambiguous.userId,
      `0x${randomUUID().replaceAll("-", "")}12345678`,
    ],
  );
  assert.equal(
    await readUnambiguousHip4OrderController(pool, ambiguous.userId),
    null,
    "never arbitrarily select a controller",
  );
  await assert.rejects(
    prepareTelegramNativeAppHandoff(
      { ...ambiguous.prepareInput, telegramUserId: "1" },
      dependencies,
    ),
    /draft_unavailable/u,
  );
  console.log(
    "PASS ambiguous controllers and foreign TG identity cannot mint a Review",
  );

  // Exact production reads, same installed indexes, representative wallet
  // history. Temp tables avoid touching the app or persisting synthetic scale.
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const table of ["user_wallets", "users", "telegram_trade_intents"])
      await client.query(
        `create temporary table ${table}(like public.${table} including defaults including indexes) on commit drop`,
      );
    await client.query(
      "insert into users select * from public.users where id=$1",
      [ambiguous.userId],
    );
    await client.query(
      "insert into user_wallets select * from public.user_wallets where user_id=$1",
      [ambiguous.userId],
    );
    await client.query(`insert into user_wallets(id,user_id,wallet_address,wallet_type,is_verified,wallet_source,is_internal_wallet)
      select md5('review-wallet-'||entry)::uuid,md5('review-owner-'||entry)::uuid,'0x'||md5(entry::text)||'12345678','ethereum',true,'external',false
      from generate_series(1,50000) entry`);
    await client.query(
      "insert into telegram_trade_intents select * from public.telegram_trade_intents",
    );
    // Bounded fixture loading, not a raised timeout for a production query.
    for (let firstEntry = 1; firstEntry <= 50000; firstEntry += 5000)
      await client.query(
        `insert into telegram_trade_intents(
      id,telegram_user_id,user_id,chat_id,delivery_mode,action,venue,market_id,event_id,side,
      amount_usd,shares_raw,status,quote_snapshot,policy_snapshot,result,expires_at,idempotency_key)
      select md5('native-input-history-'||history_entry)::uuid,seed_intent.telegram_user_id,
        seed_intent.user_id,seed_intent.chat_id,seed_intent.delivery_mode,seed_intent.action,seed_intent.venue,
        seed_intent.market_id,seed_intent.event_id,seed_intent.side,seed_intent.amount_usd,seed_intent.shares_raw,
        seed_intent.status,seed_intent.quote_snapshot,seed_intent.policy_snapshot,seed_intent.result,
        seed_intent.expires_at,'telegram-bot-input:history-'||history_entry
      from public.telegram_trade_intents seed_intent cross join generate_series($2::int,$3::int) history_entry
      where seed_intent.id=$1`,
        [ambiguous.id, firstEntry, firstEntry + 4999],
      );
    for (const table of ["users", "user_wallets", "telegram_trade_intents"])
      await client.query(`analyze ${table}`);
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await client.query(`set local plan_cache_mode=${mode}`);
      for (const [name, sql, args] of [
        [
          "controller",
          HIP4_ORDER_CONTROLLER_SQL,
          [ambiguous.profile.controllerWalletRef, ambiguous.userId],
        ],
        ["choices", HIP4_ORDER_UNAMBIGUOUS_CONTROLLER_SQL, [ambiguous.userId]],
        [
          "choices-empty",
          HIP4_ORDER_UNAMBIGUOUS_CONTROLLER_SQL,
          [randomUUID()],
        ],
        ["intent", TELEGRAM_NATIVE_REVIEW_INTENT_SQL, [ambiguous.id]],
        ["intent-empty", TELEGRAM_NATIVE_REVIEW_INTENT_SQL, [randomUUID()]],
        [
          "input-replay",
          TELEGRAM_NATIVE_INPUT_REPLAY_SQL,
          ["telegram-bot-input:history-25000"],
        ],
        [
          "input-empty",
          TELEGRAM_NATIVE_INPUT_REPLAY_SQL,
          ["telegram-bot-input:missing"],
        ],
      ] as const) {
        const statement = `native_review_${name.replaceAll("-", "_")}_${mode}`;
        await client.query(`prepare ${statement} as ${sql}`);
        const literals = args
          .map((value) => `'${String(value).replaceAll("'", "''")}'`)
          .join(",");
        const plan = (
          await client.query(
            `explain(analyze,buffers,format json) execute ${statement}(${literals})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.ok(
          plan["Execution Time"] < 250,
          `${name} must stay an indexed exact-owner/PK read`,
        );
        console.log(
          `PLAN ${mode} ${name}: ${plan["Execution Time"]}ms, ${plan.Plan["Shared Hit Blocks"]} shared + ${plan.Plan["Local Hit Blocks"]} local buffers`,
        );
      }
    }
  } finally {
    await client.query("rollback");
    client.release();
  }
  console.log(
    "PASS native Review producer PG16; no live requests, signers, financial execution or personal Telegram access",
  );
} finally {
  beforeQuoteReturn = undefined;
  if (policyIds.length)
    await pool.query("delete from runtime_policies where id=any($1::uuid[])", [
      policyIds,
    ]);
  await pool.end();
}
