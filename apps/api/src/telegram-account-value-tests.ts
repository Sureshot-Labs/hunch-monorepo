import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import type { AccountValueReadModel } from "./account-value/runtime-service.js";
import {
  projectAccountValue,
  resolveEffectiveHeadline,
} from "./account-value/account-value-projector.js";
import { projectCashAvailability } from "./account-value/cash-availability-projector.js";
import {
  createAccountValueReadService,
  retainAccountValueDuringRetryablePartial,
} from "./account-value/read-service.js";
import { fundingSidecarRuntimeConfig } from "./funding/runtime/sidecar-runtime-config.js";
import type {
  ValuedAssetComponent,
  ValuedPositionComponent,
} from "./funding/domain/types.js";
import { createTelegramBotTradingRoutes } from "./routes/telegram-bot-trading.js";
import {
  buildTelegramAccountValueMessage,
  buildTelegramAccountValueUnavailableMessage,
  telegramAccountValueTestHooks,
} from "./services/telegram-account-value.js";
import {
  createTelegramAccountValueLoader,
  handleTelegramAccountValueMenu,
} from "./services/telegram-account-value-menu.js";
import { createTelegramBotTradingInternalApiClient } from "./services/telegram-bot-trading-client.js";
import { TelegramBotTradingInternalApiTimeoutError } from "./services/telegram-bot-trading-client.js";
import {
  buildSignalBotMenuScreen,
  handleSignalBotMenuCallback,
  parseSignalBotConfig,
  pollSignalBotCommands,
} from "./services/signal-bot.js";

const AS_OF = "2026-08-04T12:34:00.000Z";

function asset(input: {
  assetId: string;
  networkId: string;
  decimals?: number;
}) {
  return {
    assetId: input.assetId,
    decimals: input.decimals ?? 6,
    networkId: input.networkId,
  };
}

function estimate(value: string) {
  return {
    asOf: AS_OF,
    confidence: "high" as const,
    policyId: "exact-stable",
    priceSource: "fixture",
    value,
  };
}

function component(input: {
  assetId: string;
  category?: "cash" | "in_transit" | "token";
  componentId: string;
  decimals?: number;
  estimatedUsd?: string | null;
  freshness?: "fresh" | "stale" | "unknown";
  kind?: string;
  networkId: string;
  raw: string;
  valuationEligibility?: ValuedAssetComponent["valuationEligibility"];
  venueId?: string;
}): ValuedAssetComponent {
  const itemAsset = asset(input);
  return {
    amount: { asset: itemAsset, raw: input.raw },
    category: input.category ?? "cash",
    componentId: input.componentId,
    estimatedUsd:
      input.estimatedUsd === null ? null : estimate(input.estimatedUsd ?? "0"),
    executionEligibility: "eligible" as const,
    location: {
      accountId: "user-1",
      asset: itemAsset,
      details: {
        balanceClass: input.venueId ?? "wallet",
        ...(input.venueId ? { venueId: input.venueId } : {}),
        ...(input.category === "in_transit"
          ? { representationStage: "in_transit" }
          : {}),
      },
      kind: input.kind ?? "wallet",
      locationId: `location-${input.componentId}`,
    },
    observationError: null,
    observationFreshness: input.freshness ?? "fresh",
    observedAt: AS_OF,
    reasonCodes: [],
    valuationEligibility:
      input.valuationEligibility ??
      (input.freshness === "stale" ? "stale" : "included"),
  };
}

function position(input: {
  componentId: string;
  estimatedUsd: string;
  freshness?: "fresh" | "stale" | "unknown";
  valuationEligibility?: ValuedPositionComponent["valuationEligibility"];
  venueId?: string;
}): ValuedPositionComponent {
  return {
    componentId: input.componentId,
    estimatedUsd: estimate(input.estimatedUsd),
    observationError: null,
    observationFreshness: input.freshness ?? "fresh",
    observedAt: AS_OF,
    positionActionRef: `action-${input.componentId}`,
    positionRef: `position-${input.componentId}`,
    reasonCodes: [],
    valuationEligibility: input.valuationEligibility ?? "included",
    valuationMethod: "fixture",
    venueBindingId: `binding-${input.componentId}`,
    venueId: input.venueId ?? "polymarket",
  };
}

function buildAccountFixture(): AccountValueReadModel {
  const components = [
    component({
      assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
      componentId: "pm-pusd",
      estimatedUsd: "12",
      kind: "venue_account",
      networkId: "evm:137",
      raw: "12000000",
      venueId: "polymarket",
    }),
    component({
      assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
      componentId: "base-usdc",
      estimatedUsd: "20",
      networkId: "evm:8453",
      raw: "20000000",
      venueId: "limitless",
    }),
    component({
      assetId: fundingSidecarRuntimeConfig.polymarketUsdceAddress,
      componentId: "polygon-usdce",
      estimatedUsd: "5",
      freshness: "stale",
      networkId: "evm:137",
      raw: "5000000",
      venueId: "polymarket",
    }),
    component({
      assetId: fundingSidecarRuntimeConfig.solanaUsdcMint,
      componentId: "solana-usdc",
      estimatedUsd: "3",
      networkId: "solana:mainnet",
      raw: "3000000",
    }),
    component({
      assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
      category: "in_transit",
      componentId: "secret-operation-id",
      estimatedUsd: "4",
      freshness: "unknown",
      kind: "in_transit_claim",
      networkId: "evm:8453",
      raw: "4000000",
    }),
  ];
  const [pmPusd, baseUsdc, polygonUsdce, solanaUsdc] = components;
  if (!pmPusd || !baseUsdc || !polygonUsdce || !solanaUsdc) {
    throw new Error("Telegram Account Value fixture is incomplete");
  }
  const collectorErrors = [
    {
      code: "wallet_balance_collection_failed",
      collectorId: "wallet-inventory",
      retryable: true,
    },
  ];
  const projection = projectAccountValue({
    accountId: "user-1",
    asOf: AS_OF,
    collectorErrors,
    components,
    headlineMode: "liquid_only",
    positionComponents: [
      position({ componentId: "position-1", estimatedUsd: "25" }),
    ],
  });
  const cashAvailability = projectCashAvailability({
    adjustments: [
      {
        componentId: pmPusd.componentId,
        lockedRaw: "2000000",
        reservedRaw: "1000000",
        submittedDebitRaw: "0",
        venueBindingId: "hidden-binding",
        venueId: "polymarket",
      },
      {
        componentId: baseUsdc.componentId,
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw: "0",
        venueBindingId: "hidden-limitless-binding",
        venueId: "limitless",
      },
      {
        availabilityKnown: false,
        componentId: polygonUsdce.componentId,
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw: "0",
        venueBindingId: null,
        venueId: "polymarket",
      },
      {
        componentId: solanaUsdc.componentId,
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw: "0",
        venueBindingId: null,
        venueId: null,
      },
    ],
    asOf: AS_OF,
    collectorErrors: [
      {
        code: "cash_lock_collection_failed",
        collectorId: "cash-availability-locks",
        retryable: true,
      },
    ],
    components,
  });
  return {
    assetPreferences: {},
    cashAvailability,
    duplicateAssetObservationCount: 0,
    headline: resolveEffectiveHeadline(projection),
    ownershipEvidenceRevision: "hidden-ownership-revision",
    policy: {
      creationMode: "on",
      invalidStoredPolicy: false,
      revision: "funding-policy-fixture",
      source: "db",
    },
    projection,
    venues: {
      kalshi: {
        cashAvailableEstimatedUsd: "0",
        cashEstimatedUsd: "0",
        positionsEstimatedUsd: "0",
        totalPortfolioEstimatedUsd: "0",
      },
      limitless: {
        cashAvailableEstimatedUsd: "20",
        cashEstimatedUsd: "20",
        positionsEstimatedUsd: "10",
        totalPortfolioEstimatedUsd: "30",
      },
      polymarket: {
        cashAvailableEstimatedUsd: "9",
        cashEstimatedUsd: "17",
        positionsEstimatedUsd: "8",
        totalPortfolioEstimatedUsd: "25",
      },
    },
  } satisfies AccountValueReadModel;
}

await test("Telegram Account Value presenter preserves accounting groups and degraded states", () => {
  const rendered = buildTelegramAccountValueMessage({
    account: buildAccountFixture(),
  });
  assert.equal(rendered.parse_mode, "MarkdownV2");
  assert.match(rendered.text, /Known estimated assets.*\$39\\\.00/u);
  assert.match(rendered.text, /Known cash available.*\$32\\\.00/u);
  assert.match(rendered.text, /Known portfolio value.*\$64\\\.00/u);
  assert.match(rendered.text, /Polymarket.*\$9\\\.00 known available/u);
  assert.match(rendered.text, /Limitless.*\$20\\\.00 known available/u);
  assert.match(rendered.text, /Base wallet.*20 USDC.*20 available/u);
  assert.match(rendered.text, /Polygon wallet.*5 USDC\\\.e.*stale/u);
  assert.match(rendered.text, /Solana wallet.*3 USDC.*3 available/u);
  assert.match(rendered.text, /Polymarket pUSD.*2 locked.*1 reserved/u);
  assert.match(rendered.text, /In transit/u);
  assert.match(rendered.text, /Estimated value.*\$4\\\.00/u);
  assert.match(rendered.text, /Base USDC.*4.*stale/u);
  assert.match(rendered.text, /Partial and stale data/u);
  assert.match(rendered.text, /Only currently known balances are shown/u);
  assert.match(rendered.text, /Some values are stale/u);
  assert.doesNotMatch(rendered.text, /secret-operation-id/u);
  assert.doesNotMatch(rendered.text, /wallet_balance_collection_failed/u);
  assert.doesNotMatch(rendered.text, /hidden-(?:binding|ownership)/u);

  const buttons = rendered.reply_markup?.inline_keyboard.flat() ?? [];
  assert.deepEqual(
    buttons.map((button) =>
      "callback_data" in button ? button.callback_data : null,
    ),
    [
      "hm:v1:balance",
      "hm:v1:deposit",
      "hm:v1:trading:market_input",
      "hm:v1:home",
    ],
  );
});

await test("Telegram Account Value formats raw and USD values without a floating-point round trip", () => {
  assert.equal(telegramAccountValueTestHooks.formatRaw(1n, 0), "1");
  assert.equal(
    telegramAccountValueTestHooks.formatRaw(1n, 18),
    "0.000000000000000001",
  );
  assert.equal(
    telegramAccountValueTestHooks.formatRaw(1n, 36),
    "0.000000000000000000000000000000000001",
  );
  assert.equal(
    telegramAccountValueTestHooks.formatUsd("900719925474099312345.675"),
    "$900,719,925,474,099,312,345.68",
  );
});

await test("Telegram Account Value excludes replaced components and keeps separate in-transit operations", () => {
  const account = buildAccountFixture();
  const excluded = component({
    assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
    componentId: "excluded-wallet-component",
    estimatedUsd: "999",
    networkId: "evm:137",
    raw: "999000000",
    valuationEligibility: "excluded",
  });
  const secondTransit = component({
    assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
    category: "in_transit",
    componentId: "second-operation-id",
    estimatedUsd: "2",
    kind: "in_transit_claim",
    networkId: "evm:8453",
    raw: "2000000",
  });
  const rendered = buildTelegramAccountValueMessage({
    account: {
      ...account,
      projection: {
        ...account.projection,
        components: [...account.projection.components, excluded, secondTransit],
      },
    },
  });
  assert.equal([...rendered.text.matchAll(/Base USDC/gu)].length, 2);
  assert.doesNotMatch(rendered.text, /999/u);
  assert.doesNotMatch(
    rendered.text,
    /(?:excluded-wallet|second-operation)-id/u,
  );
});

await test("Telegram Account Value preserves degraded zero balances and position-only stale status", () => {
  const account = buildAccountFixture();
  const zeroStale = component({
    assetId: "11111111111111111111111111111111",
    componentId: "zero-stale-sol",
    estimatedUsd: null,
    freshness: "stale",
    networkId: "solana:mainnet",
    raw: "0",
  });
  const rendered = buildTelegramAccountValueMessage({
    account: {
      ...account,
      cashAvailability: {
        ...account.cashAvailability,
        collectorErrors: [],
        completeness: "complete",
        freshness: "fresh",
      },
      headline: {
        ...account.headline,
        completeness: "complete",
        freshness: "fresh",
      },
      projection: {
        ...account.projection,
        collectorErrors: [],
        components: [...account.projection.components, zeroStale],
        positionValuationCompleteness: "complete",
        positionValuationFreshness: "stale",
        valuationCompleteness: "complete",
        valuationFreshness: "fresh",
      },
    },
  });
  assert.match(
    rendered.text,
    /Solana wallet.*0 SOL.*availability unknown.*stale/u,
  );
  assert.match(rendered.text, /Stale data/u);
  assert.doesNotMatch(rendered.text, /Partial data/u);
});

await test("Telegram Account Value uses safe unknown-asset grouping", () => {
  const account = buildAccountFixture();
  const unknown = ["unknown-token-a", "unknown-token-b"].map((assetId, index) =>
    component({
      assetId,
      componentId: `unknown-component-${index}`,
      estimatedUsd: null,
      networkId: "evm:8453",
      raw: String(index + 1),
    }),
  );
  const rendered = buildTelegramAccountValueMessage({
    account: {
      ...account,
      projection: {
        ...account.projection,
        components: [...account.projection.components, ...unknown],
      },
    },
  });
  assert.match(rendered.text, /Base.*Other assets.*2 balances tracked/u);
  assert.doesNotMatch(rendered.text, /unknown-(?:token|component)/u);
});

await test("Telegram Account Value stays within Telegram limits for 256 asset rows", () => {
  const account = buildAccountFixture();
  const transfers = Array.from({ length: 256 }, (_, index) =>
    component({
      assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
      category: "in_transit",
      componentId: `operation-${index}`,
      estimatedUsd: "1",
      kind: "in_transit_claim",
      networkId: "evm:8453",
      raw: "1000000",
    }),
  );
  const rendered = buildTelegramAccountValueMessage({
    account: {
      ...account,
      projection: {
        ...account.projection,
        components: [...account.projection.components, ...transfers],
      },
    },
  });
  assert.ok(rendered.text.length <= telegramAccountValueTestHooks.textBudget);
  assert.ok(rendered.text.length <= 4_096);
  assert.match(rendered.text, /more transfers in transit/u);
  assert.doesNotMatch(rendered.text, /operation-/u);
});

await test("Account Value unavailable response is stable and keeps other bot surfaces reachable", () => {
  const first = buildTelegramAccountValueUnavailableMessage();
  const second = buildTelegramAccountValueUnavailableMessage();
  assert.deepEqual(first, second);
  assert.match(first.text, /Account Value unavailable/u);
  assert.match(first.text, /does not change funding or trading state/u);
  assert.deepEqual(
    first.reply_markup?.inline_keyboard
      .flat()
      .map((button) =>
        "callback_data" in button ? button.callback_data : null,
      ),
    [
      "hm:v1:balance",
      "hm:v1:deposit",
      "hm:v1:trading:market_input",
      "hm:v1:home",
    ],
  );
});

function accountWithoutCollectorErrors(): AccountValueReadModel {
  const account = buildAccountFixture();
  return {
    ...account,
    cashAvailability: {
      ...account.cashAvailability,
      collectorErrors: [],
      completeness: "complete",
      freshness: "fresh",
    },
    headline: {
      ...account.headline,
      completeness: "complete",
      freshness: "fresh",
    },
    projection: {
      ...account.projection,
      collectorErrors: [],
      positionValuationCompleteness: "complete",
      positionValuationFreshness: "fresh",
      valuationCompleteness: "complete",
      valuationFreshness: "fresh",
    },
  };
}

function retryablePartialAccount(
  source: AccountValueReadModel,
  estimatedUsd: string,
): AccountValueReadModel {
  const error = {
    code: "wallet_balance_collection_failed",
    collectorId: "wallet-inventory",
    retryable: true,
  };
  return {
    ...source,
    cashAvailability: {
      ...source.cashAvailability,
      cashAvailableEstimatedUsd: estimatedUsd,
      collectorErrors: [error],
      completeness: "partial",
      freshness: "stale",
    },
    headline: {
      ...source.headline,
      completeness: "partial",
      estimatedUsd,
      freshness: "stale",
    },
    projection: {
      ...source.projection,
      collectorErrors: [error],
      liquidAssetsEstimatedUsd: estimatedUsd,
      totalPortfolioEstimatedUsd: estimatedUsd,
      valuationCompleteness: "partial",
      valuationFreshness: "stale",
    },
  };
}

await test("shared Account Value read service coalesces builds and retains recent truth only for retryable partials", async () => {
  const complete = accountWithoutCollectorErrors();
  let builds = 0;
  let now = 1_000;
  const service = createAccountValueReadService(
    async () => {
      builds += 1;
      await Promise.resolve();
      return builds === 1
        ? complete
        : retryablePartialAccount(complete, builds === 2 ? "1" : "2");
    },
    { now: () => now, retentionMs: 60_000, ttlMs: 2_000 },
  );
  const [first, concurrent] = await Promise.all([
    service.load("user-1"),
    service.load("user-1"),
  ]);
  assert.equal(first, concurrent);
  assert.equal(builds, 1);

  now += 2_001;
  const retained = await service.load("user-1");
  assert.equal(builds, 2);
  assert.equal(
    retained.projection.totalPortfolioEstimatedUsd,
    complete.projection.totalPortfolioEstimatedUsd,
  );
  assert.equal(retained.projection.valuationCompleteness, "partial");
  assert.equal(retained.projection.valuationFreshness, "stale");

  now += 60_001;
  const expired = await service.load("user-1");
  assert.equal(builds, 3);
  assert.equal(expired.projection.totalPortfolioEstimatedUsd, "2");
});

await test("retryable Account Value retention helper preserves new health metadata", () => {
  const previous = accountWithoutCollectorErrors();
  const next = retryablePartialAccount(previous, "1");
  const retained = retainAccountValueDuringRetryablePartial(previous, next);
  assert.equal(
    retained.cashAvailability.cashAvailableEstimatedUsd,
    previous.cashAvailability.cashAvailableEstimatedUsd,
  );
  assert.deepEqual(
    retained.cashAvailability.collectorErrors,
    next.cashAvailability.collectorErrors,
  );
  assert.equal(retained.cashAvailability.freshness, "stale");
});

await test("main private menu exposes the Balance tile", () => {
  const home = buildSignalBotMenuScreen({
    appBaseUrl: "https://app.hunch.trade",
    isAdmin: false,
    miniAppEnabled: false,
    screen: "home",
  });
  const balance = home.keyboard.inline_keyboard
    .flat()
    .find((button) => button.text === "💰 Balance");
  assert.ok(balance && "callback_data" in balance);
  assert.equal(balance.callback_data, "hm:v1:balance");
});

function buildMenuHandlerInput(input: {
  chatId: number;
  fromId: number;
  loadAccountValue?: (input: {
    chatId: string;
    telegramUserId: number;
  }) => Promise<{ parse_mode: "MarkdownV2"; text: string }>;
}) {
  const answers: Array<{ showAlert?: boolean; text?: string }> = [];
  const edits: Array<{ chat_id: string; text: string }> = [];
  let dbQueries = 0;
  return {
    answers,
    dbQueries: () => dbQueries,
    edits,
    handlerInput: {
      callbackQuery: {
        data: "hm:v1:balance",
        from: { id: input.fromId },
        id: "balance-callback",
        message: {
          chat: { id: input.chatId, type: "private" },
          message_id: 42,
        },
      },
      config: parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_TOKEN: "test-token",
      }),
      db: {
        query: async () => {
          dbQueries += 1;
          return {
            fields: [],
            rows: [{ link_id: "link-1", user_id: "user-1" }],
          };
        },
      } as never,
      loadAccountValue: input.loadAccountValue,
      redis: {
        del: async () => 1,
      } as never,
      sendTestSignal: async () => false,
      telegram: {
        answerCallbackQuery: async (answer: {
          showAlert?: boolean;
          text?: string;
        }) => {
          answers.push(answer);
          return true;
        },
        editMessageText: async (message: { chat_id: string; text: string }) => {
          edits.push(message);
          return { messageId: 42, ok: true as const };
        },
        sendMessage: async () => ({ messageId: 43, ok: true as const }),
      } as never,
    },
  };
}

await test("Balance callback loads and edits the Account Value card in the matching private chat", async () => {
  const loads: Array<{ chatId: string; telegramUserId: number }> = [];
  const state = buildMenuHandlerInput({
    chatId: 123,
    fromId: 123,
    loadAccountValue: async (input) => {
      loads.push(input);
      return { parse_mode: "MarkdownV2", text: "Account Value card" };
    },
  });
  assert.equal(await handleSignalBotMenuCallback(state.handlerInput), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(loads, [{ chatId: "123", telegramUserId: 123 }]);
  assert.equal(state.dbQueries(), 1);
  assert.equal(state.edits.at(-1)?.text, "Account Value card");
  assert.equal(state.answers[0]?.text, "⏳ Working…");
});

await test("Balance callback rejects a mismatched private chat before DB or loader access", async () => {
  let loads = 0;
  const state = buildMenuHandlerInput({
    chatId: 456,
    fromId: 123,
    loadAccountValue: async () => {
      loads += 1;
      return { parse_mode: "MarkdownV2", text: "must not render" };
    },
  });
  assert.equal(await handleSignalBotMenuCallback(state.handlerInput), true);
  assert.equal(loads, 0);
  assert.equal(state.dbQueries(), 0);
  assert.equal(state.edits.length, 0);
  assert.equal(state.answers[0]?.showAlert, true);
  assert.match(state.answers[0]?.text ?? "", /your own private chat/u);
});

await test("Balance callback returns before the Account Value loader completes", async () => {
  let resolveLoad:
    | ((message: { parse_mode: "MarkdownV2"; text: string }) => void)
    | undefined;
  const state = buildMenuHandlerInput({
    chatId: 123,
    fromId: 123,
    loadAccountValue: () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
  });
  assert.equal(await handleSignalBotMenuCallback(state.handlerInput), true);
  assert.ok(resolveLoad);
  assert.equal(state.edits.length, 0);
  resolveLoad({ parse_mode: "MarkdownV2", text: "Deferred Account Value" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.edits.at(-1)?.text, "Deferred Account Value");
});

await test("Signal Bot polling handles the next update while Account Value is pending", async () => {
  let resolveLoad:
    | ((message: { parse_mode: "MarkdownV2"; text: string }) => void)
    | undefined;
  const answers: string[] = [];
  const edits: string[] = [];
  const redisValues = new Map<string, string>();
  const handled = await pollSignalBotCommands({
    config: parseSignalBotConfig({ HUNCH_SIGNAL_BOT_TOKEN: "test-token" }),
    db: {
      query: async () => ({
        fields: [],
        rows: [{ link_id: "link-1", user_id: "user-1" }],
      }),
    } as never,
    loadAccountValue: () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    redis: {
      del: async (key: string) => redisValues.delete(key),
      get: async (key: string) => redisValues.get(key) ?? null,
      set: async (key: string, value: string) => {
        redisValues.set(key, value);
        return "OK";
      },
    } as never,
    sendTestSignal: async () => false,
    telegram: {
      answerCallbackQuery: async ({ callbackQueryId }) => {
        answers.push(callbackQueryId);
      },
      editMessageText: async ({ text }) => {
        edits.push(text);
        return { messageId: 42, ok: true };
      },
      getUpdates: async () => [
        {
          callback_query: {
            data: "hm:v1:balance",
            from: { id: 123 },
            id: "pending-balance",
            message: {
              chat: { id: 123, type: "private" },
              message_id: 42,
            },
          },
          update_id: 1,
        },
        {
          callback_query: {
            data: "hm:v1:help",
            from: { id: 123 },
            id: "next-help",
            message: {
              chat: { id: 123, type: "private" },
              message_id: 43,
            },
          },
          update_id: 2,
        },
      ],
      sendMessage: async () => ({ messageId: 43, ok: true }),
    },
  });
  assert.equal(handled, 2);
  assert.ok(resolveLoad);
  assert.deepEqual(answers, ["pending-balance", "next-help"]);
  assert.match(edits.at(-1) ?? "", /How Hunch works/u);
  resolveLoad({ parse_mode: "MarkdownV2", text: "Late balance" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(edits.includes("Late balance"));
});

await test("Account Value sidecar loader coalesces users and limits global concurrency", async () => {
  const started: number[] = [];
  const resolvers = new Map<
    number,
    (message: { parse_mode: "MarkdownV2"; text: string }) => void
  >();
  const loader = createTelegramAccountValueLoader({
    load: ({ telegramUserId }) =>
      new Promise((resolve) => {
        started.push(telegramUserId);
        resolvers.set(telegramUserId, resolve);
      }),
    maxConcurrency: 2,
  });
  const first = loader({ chatId: "1", telegramUserId: 1 });
  const duplicate = loader({ chatId: "1", telegramUserId: 1 });
  const second = loader({ chatId: "2", telegramUserId: 2 });
  const queued = loader({ chatId: "3", telegramUserId: 3 });
  await Promise.resolve();
  assert.equal(first, duplicate);
  assert.deepEqual(started, [1, 2]);
  resolvers.get(1)?.({ parse_mode: "MarkdownV2", text: "one" });
  await first;
  await Promise.resolve();
  assert.deepEqual(started, [1, 2, 3]);
  resolvers.get(2)?.({ parse_mode: "MarkdownV2", text: "two" });
  resolvers.get(3)?.({ parse_mode: "MarkdownV2", text: "three" });
  await Promise.all([duplicate, second, queued]);
});

await test("Account Value delivery survives Redis menu-state invalidation failure", async () => {
  const edits: string[] = [];
  const errors: unknown[] = [];
  await handleTelegramAccountValueMenu({
    chatId: "123",
    loadAccountValue: async () => ({
      parse_mode: "MarkdownV2",
      text: "Account Value after Redis failure",
    }),
    messageId: 42,
    onError: (error) => errors.push(error),
    redis: {
      del: async () => {
        throw new Error("redis unavailable");
      },
    },
    telegramUserId: 123,
    transport: {
      editMessageText: async ({ text }) => {
        edits.push(text);
        return { messageId: 42, ok: true };
      },
      sendMessage: async () => ({ messageId: 43, ok: true }),
    },
  });
  await Promise.resolve();
  assert.deepEqual(edits, ["Account Value after Redis failure"]);
  assert.equal(errors.length, 1);
});

await test("Account Value sidecar fallback import path does not reach funding runtime config", async () => {
  const source = await readFile(
    new URL("./services/telegram-account-value-menu.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /telegram-account-value\.js/u);
  assert.doesNotMatch(source, /sidecar-runtime-config/u);
  assert.match(source, /telegram-account-value-contract\.js/u);
});

async function buildRouteApp(input: {
  authorize?: boolean;
  buildError?: boolean;
  links?: Array<{ link_id: string; user_id: string } | null>;
  onBuild?: (userId: string) => void;
  onQuery?: (sql: string) => void;
}) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    createTelegramBotTradingRoutes({
      buildAccountValue: async (userId) => {
        input.onBuild?.(userId);
        if (input.buildError) throw new Error("projection unavailable");
        return buildAccountFixture();
      },
      db: {
        queryCount: 0,
        query: async (sql: string) => {
          input.onQuery?.(sql);
          if (/telegram_bot_trading_preferences|runtime_policies/iu.test(sql)) {
            throw new Error("Account Value must not read execution controls");
          }
          const next = input.links?.shift();
          return {
            fields: [],
            rows:
              next === null
                ? []
                : [
                    next ?? {
                      link_id: "link-1",
                      user_id: "user-1",
                    },
                  ],
          };
        },
      } as never,
      ...(input.authorize === false
        ? {}
        : { internalPreHandler: async () => undefined }),
    }),
  );
  return app;
}

await test("internal account endpoint is independent from desired_enabled and uses the linked user Account Value", async () => {
  const builtFor: string[] = [];
  const queries: string[] = [];
  const app = await buildRouteApp({
    onBuild: (userId) => builtFor.push(userId),
    onQuery: (sql) => queries.push(sql),
  });
  try {
    const response = await app.inject({
      method: "POST",
      payload: { chatId: "123", telegramUserId: 123 },
      url: "/internal/telegram-bot/account",
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().text, /Known estimated assets/u);
    assert.deepEqual(builtFor, ["user-1"]);
    assert.equal(queries.length, 2);
    assert.match(queries[0] ?? "", /user_telegram_accounts/u);
  } finally {
    await app.close();
  }
});

await test("Account Value returns stable Unavailable only when its projection fails", async () => {
  let builds = 0;
  let queries = 0;
  const app = await buildRouteApp({
    buildError: true,
    onBuild: () => {
      builds += 1;
    },
    onQuery: () => {
      queries += 1;
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      payload: { chatId: "123", telegramUserId: "123" },
      url: "/internal/telegram-bot/account",
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().text, /Account Value unavailable/u);
    assert.equal(builds, 1);
    assert.equal(queries, 1);
  } finally {
    await app.close();
  }
});

await test("internal account endpoint rejects group or cross-user chat before DB access", async () => {
  let builds = 0;
  let queries = 0;
  const app = await buildRouteApp({
    onBuild: () => {
      builds += 1;
    },
    onQuery: () => {
      queries += 1;
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      payload: { chatId: -100123, telegramUserId: 123 },
      url: "/internal/telegram-bot/account",
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { error: "private_chat_required" });
    assert.equal(builds, 0);
    assert.equal(queries, 0);
    assert.doesNotMatch(response.body, /\$|0x[0-9a-f]{40}/iu);
  } finally {
    await app.close();
  }
});

await test("internal account endpoint rejects inactive links and link changes without disclosing the prior account", async () => {
  let inactiveBuilds = 0;
  const inactive = await buildRouteApp({
    links: [null],
    onBuild: () => {
      inactiveBuilds += 1;
    },
  });
  try {
    const response = await inactive.inject({
      method: "POST",
      payload: { chatId: "123", telegramUserId: "123" },
      url: "/internal/telegram-bot/account",
    });
    assert.match(response.json().text, /Account Value unavailable/u);
    assert.equal(inactiveBuilds, 0);
  } finally {
    await inactive.close();
  }

  let raceBuilds = 0;
  const changed = await buildRouteApp({
    links: [
      { link_id: "link-1", user_id: "user-1" },
      { link_id: "link-2", user_id: "user-2" },
    ],
    onBuild: () => {
      raceBuilds += 1;
    },
  });
  try {
    const response = await changed.inject({
      method: "POST",
      payload: { chatId: "123", telegramUserId: "123" },
      url: "/internal/telegram-bot/account",
    });
    assert.match(response.json().text, /Account Value unavailable/u);
    assert.doesNotMatch(response.json().text, /Known estimated assets/u);
    assert.equal(raceBuilds, 1);
  } finally {
    await changed.close();
  }
});

await test("internal account endpoint requires its bearer boundary", async () => {
  const app = await buildRouteApp({ authorize: false });
  try {
    const missing = await app.inject({
      method: "POST",
      payload: { chatId: "123", telegramUserId: "123" },
      url: "/internal/telegram-bot/account",
    });
    const wrong = await app.inject({
      headers: { authorization: "Bearer definitely-wrong" },
      method: "POST",
      payload: { chatId: "123", telegramUserId: "123" },
      url: "/internal/telegram-bot/account",
    });
    assert.equal(missing.statusCode, 401);
    assert.equal(wrong.statusCode, 401);
  } finally {
    await app.close();
  }
});

await test("internal client sends Account Value requests to the exact account endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: unknown = null;
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body ?? "null"));
    return new Response(
      JSON.stringify({ parse_mode: "MarkdownV2", text: "Balance" }),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    );
  }) as typeof fetch;
  try {
    const client = createTelegramBotTradingInternalApiClient({
      baseUrl: "http://127.0.0.1:3000/",
      token: "test-token",
    });
    const result = await client.buildAccountValueMessage({
      chatId: "123",
      telegramUserId: 123,
    });
    assert.equal(result.text, "Balance");
    assert.equal(
      capturedUrl,
      "http://127.0.0.1:3000/internal/telegram-bot/account",
    );
    assert.deepEqual(capturedBody, { chatId: "123", telegramUserId: 123 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("internal client uses a dedicated Account Value timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;
  try {
    const client = createTelegramBotTradingInternalApiClient({
      accountValueTimeoutMs: 5,
      baseUrl: "http://127.0.0.1:3000",
      token: "test-token",
    });
    await assert.rejects(
      client.buildAccountValueMessage({
        chatId: "123",
        telegramUserId: 123,
      }),
      (error: unknown) =>
        error instanceof TelegramBotTradingInternalApiTimeoutError &&
        error.timeoutMs === 5 &&
        error.path === "/internal/telegram-bot/account",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
