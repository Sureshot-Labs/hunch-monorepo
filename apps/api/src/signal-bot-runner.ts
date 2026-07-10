#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";

import {
  createPgPool,
  createRedisClient,
  ensureRedis,
  type Pool,
} from "@hunch/infra";

import {
  acquireSignalBotLock,
  drainSignalBotConfirmTasks,
  parseSignalBotAggMarketConfig,
  parseSignalBotConfig,
  pollSignalBotCommands,
  publishSignalBotFollowthroughTick,
  publishSignalBotTick,
  refreshSignalBotLock,
  releaseSignalBotLock,
  sendSignalBotFollowthroughPreview,
  sendSignalBotStatsReport,
  sendLatestSignalBotTestSignal,
  TelegramBotApiClient,
} from "./services/signal-bot.js";
import { createTelegramBotTradingInternalApiClient } from "./services/telegram-bot-trading-client.js";

function log(event: string, fields?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...(fields ?? {}),
    }),
  );
}

function logTradingInternalApiFailure(
  operation: "callback" | "disable" | "market-card" | "status",
  error: unknown,
): void {
  log("signal_bot_trading_internal_api_error", {
    operation,
    error: error instanceof Error ? error.message : String(error),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when signal bot is enabled`);
  }
  return value;
}

function createSignalBotDbPool(): Pool {
  const pool = createPgPool({
    connectionString: requiredEnv("DATABASE_URL"),
    options: "-c jit=off",
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max: 5,
  });
  pool.on("error", (error: unknown) =>
    console.error("[signal-bot] pg error", error),
  );
  return pool;
}

async function keepAliveDisabled(): Promise<never> {
  log("signal_bot_disabled");
  while (true) {
    await delay(60_000);
  }
}

async function waitForSignalBotLock(input: {
  owner: string;
  redis: Parameters<typeof acquireSignalBotLock>[0]["redis"];
  shouldStop: () => boolean;
}): Promise<boolean> {
  let attempts = 0;
  while (!input.shouldStop()) {
    const locked = await acquireSignalBotLock({
      owner: input.owner,
      redis: input.redis,
    });
    if (locked) {
      if (attempts > 0) {
        log("signal_bot_lock_acquired_after_wait", { attempts });
      }
      return true;
    }
    log(attempts === 0 ? "signal_bot_lock_held" : "signal_bot_lock_wait", {
      retrySec: 5,
    });
    attempts += 1;
    await delay(5_000);
  }
  return false;
}

export async function runSignalBotRunner(): Promise<void> {
  const config = parseSignalBotConfig();
  const aggConfig = parseSignalBotAggMarketConfig();
  if (!config.enabled) {
    await keepAliveDisabled();
  }
  if (!config.token) {
    throw new Error(
      "HUNCH_SIGNAL_BOT_TOKEN is required when signal bot is enabled",
    );
  }
  const redisUrl = requiredEnv("REDIS_URL");
  if (config.adminUserIds.size === 0) {
    throw new Error(
      "HUNCH_SIGNAL_BOT_ADMIN_USER_IDS is required when signal bot is enabled",
    );
  }

  const redis = createRedisClient({ url: redisUrl });
  await ensureRedis(redis, {
    logLabel: "signal-bot",
    waitForReady: true,
  });

  const owner = `${process.pid}:${randomUUID()}`;
  let shuttingDown = false;
  const shutdown = () => {
    shuttingDown = true;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const locked = await waitForSignalBotLock({
    owner,
    redis,
    shouldStop: () => shuttingDown,
  });
  if (!locked) {
    await redis.quit().catch(() => undefined);
    return;
  }

  let dbPool: Pool | null = null;
  const telegram = new TelegramBotApiClient(config.token);
  const botUsername = await telegram
    .getMe()
    .then((user) => user.username ?? null)
    .catch((error: unknown) => {
      log("signal_bot_get_me_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

  log("signal_bot_started", {
    adminCount: config.adminUserIds.size,
    aggAlternativesConfigured: aggConfig != null,
    aggCredentialSource: aggConfig?.credentialSource ?? "none",
    buyAmountUsd: config.buyAmountUsd,
    maxSignalsPerTick: config.maxSignalsPerTick,
    minConfidence: config.minConfidence,
    publishIntervalSec: config.publishIntervalSec,
  });

  let nextPublishAt = 0;
  let heartbeatLost = false;
  const lockHeartbeat = setInterval(() => {
    void refreshSignalBotLock({ owner, redis })
      .then((stillLocked) => {
        if (stillLocked) return;
        heartbeatLost = true;
        log("signal_bot_lock_lost");
      })
      .catch((error: unknown) => {
        log("signal_bot_lock_refresh_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, 20_000);
  lockHeartbeat.unref?.();
  try {
    dbPool = createSignalBotDbPool();
    const db = dbPool;
    const tradingInternalApi =
      config.tradingInternalApiBaseUrl && config.tradingInternalApiToken
        ? createTelegramBotTradingInternalApiClient({
            baseUrl: config.tradingInternalApiBaseUrl,
            token: config.tradingInternalApiToken,
          })
        : null;
    while (!shuttingDown) {
      try {
        if (heartbeatLost) break;

        const handledCommands = await pollSignalBotCommands({
          botUsername,
          config,
          redis,
          sendStatsReport: (chatId, period, detail) =>
            sendSignalBotStatsReport({
              chatId,
              config,
              db,
              detail,
              period,
              telegram,
            }),
          sendTestFollowthrough: (chatId, kind) =>
            sendSignalBotFollowthroughPreview({
              chatId,
              config,
              db,
              kind,
              redis,
              telegram,
            }),
          sendTestSignal: (chatId) =>
            sendLatestSignalBotTestSignal({
              chatId,
              config,
              db,
              redis,
              telegram,
            }),
          sendTradeStatus: async (chatId, telegramUserId) => {
            const message = tradingInternalApi
              ? await tradingInternalApi
                  .buildStatusMessage(telegramUserId)
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("status", error);
                    return {
                      parse_mode: "MarkdownV2" as const,
                      reply_markup: undefined,
                      text: "Trading is unavailable right now\\. Open Hunch to trade\\.",
                    };
                  })
              : {
                  parse_mode: "MarkdownV2" as const,
                  reply_markup: undefined,
                  text: "Trading is unavailable right now\\. Open Hunch to trade\\.",
                };
            const result = await telegram.sendMessage({
              chat_id: chatId,
              disable_web_page_preview: true,
              parse_mode: message.parse_mode ?? "MarkdownV2",
              reply_markup: message.reply_markup,
              text: message.text,
            });
            return result.ok;
          },
          disableTrading: async (_chatId, telegramUserId) =>
            tradingInternalApi
              ? await tradingInternalApi
                  .disableTrading(telegramUserId)
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("disable", error);
                    return "unavailable" as const;
                  })
              : "unavailable",
          sendTradeMarket: async (input) => {
            const message = tradingInternalApi
              ? await tradingInternalApi
                  .buildMarketMessage({
                    appBaseUrl: config.appBaseUrl,
                    chatId: input.chatId,
                    isAdminTest: input.isAdminTest,
                    marketRef: input.marketRef,
                    telegramMessageId: input.telegramMessageId,
                    telegramUserId: input.telegramUserId,
                  })
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("market-card", error);
                    return {
                      parse_mode: "MarkdownV2" as const,
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "Open in Hunch", url: config.appBaseUrl }],
                        ],
                      },
                      text: "Trading is unavailable\\. Open Hunch to trade\\.",
                    };
                  })
              : {
                  parse_mode: "MarkdownV2" as const,
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "Open in Hunch", url: config.appBaseUrl }],
                    ],
                  },
                  text: "Trading is unavailable\\. Open Hunch to trade\\.",
                };
            const result = await telegram.sendMessage({
              chat_id: input.chatId,
              disable_web_page_preview: true,
              parse_mode: message.parse_mode ?? "MarkdownV2",
              reply_markup: message.reply_markup,
              text: message.text,
            });
            return result.ok;
          },
          handleCallback: (callbackQuery) =>
            tradingInternalApi
              ? tradingInternalApi
                  .handleCallback({
                    answerCallbackQuery: (answer) =>
                      telegram.answerCallbackQuery(answer),
                    appBaseUrl: config.appBaseUrl,
                    callbackQuery,
                    sendMessage: (message) =>
                      telegram.sendMessage({
                        ...message,
                        disable_web_page_preview: true,
                        parse_mode: message.parse_mode ?? "MarkdownV2",
                      }),
                  })
                  .catch(async (error: unknown) => {
                    logTradingInternalApiFailure("callback", error);
                    await telegram.answerCallbackQuery({
                      callbackQueryId: callbackQuery.id,
                      showAlert: true,
                      text: "Trading is unavailable. Open Hunch to trade.",
                    });
                    return true;
                  })
              : telegram
                  .answerCallbackQuery({
                    callbackQueryId: callbackQuery.id,
                    showAlert: true,
                    text: "Trading is unavailable. Open Hunch to trade.",
                  })
                  .then(() => true),
          telegram,
        });
        if (handledCommands > 0) {
          log("signal_bot_commands", { handled: handledCommands });
        }

        const now = Date.now();
        if (!heartbeatLost && now >= nextPublishAt) {
          const result = await publishSignalBotTick({
            config,
            db,
            redis,
            telegram,
          });
          log("signal_bot_publish_tick", result);
          const followthrough = await publishSignalBotFollowthroughTick({
            config,
            db,
            redis,
            telegram,
          });
          log("signal_bot_followthrough_tick", followthrough);
          nextPublishAt = now + config.publishIntervalSec * 1_000;
        }
      } catch (error) {
        log("signal_bot_loop_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        await delay(5_000);
      }
    }
  } finally {
    clearInterval(lockHeartbeat);
    const drainedConfirmTasks = await drainSignalBotConfirmTasks(10_000);
    if (!drainedConfirmTasks) {
      log("signal_bot_confirm_tasks_drain_timeout");
    }
    await releaseSignalBotLock({ owner, redis }).catch(() => undefined);
    await dbPool?.end().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runSignalBotRunner();
}
