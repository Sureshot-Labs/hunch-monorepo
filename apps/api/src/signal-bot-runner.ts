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
  configureSignalBotTelegramUi,
  createSignalBotTelegramTransport,
  drainSignalBotConfirmTasks,
  parseSignalBotAggMarketConfig,
  parseSignalBotConfig,
  pollSignalBotCommands,
  publishSignalBotFollowthroughTick,
  publishSignalBotTick,
  refreshSignalBotLock,
  releaseSignalBotLock,
  SIGNAL_BOT_MENU_CALLBACK_PREFIX,
  sendSignalBotFollowthroughPreview,
  sendSignalBotRichLayoutPreview,
  sendSignalBotStatsReport,
  sendLatestSignalBotTestSignal,
  TelegramBotApiClient,
} from "./services/signal-bot.js";
import { drainSignalBotFundingOpenTasks } from "./services/telegram-bot-menu-actions.js";
import {
  attachTelegramBotReferralCode,
  loadTelegramBotRewardsMessage,
  prepareTelegramBotReferralCodeChange,
  updateTelegramBotReferralCode,
} from "./services/telegram-bot-rewards.js";
import {
  cleanupTelegramNotificationOutbox,
  deliverTelegramNotificationOutbox,
  enqueueTelegramActivityNotifications,
  enqueueTelegramPositionSignals,
} from "./services/telegram-notification-delivery.js";
import {
  cleanupTelegramBotActionOutbox,
  deliverTelegramBotOnboardingActions,
} from "./services/telegram-bot-onboarding-delivery.js";
import {
  cleanupTelegramFundingContexts,
  createTelegramFundingRenderCoordinator,
  deliverTelegramFundingActions,
} from "./services/telegram-funding-delivery.js";
import { resolveTelegramNotificationsPolicy } from "./services/telegram-notification-policy.js";
import {
  createTelegramBotTradingInternalApiClient,
  describeTelegramBotTradingInternalApiError,
} from "./services/telegram-bot-trading-client.js";
import { createTelegramAccountValueLoader } from "./services/telegram-account-value-menu.js";
import { beginSignalBotTradeInput } from "./services/telegram-bot-trade-input.js";
import { withTelegramPrivateNavigation } from "./services/telegram-bot-private-navigation.js";
import { formatTelegramCalloutMarkdownV2 } from "./services/telegram-bot-trading-presentation.js";
import { buildHunchMiniAppWebButton } from "./services/telegram-mini-app-buttons.js";
import { createOpenRouterXEditorialDraftComposer } from "./services/x-editorial-draft.js";

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
  operation:
    | "account-value"
    | "callback"
    | "deposit"
    | "disable"
    | "market-card"
    | "market-search"
    | "funding"
    | "position-card"
    | "positions"
    | "status"
    | "trade-input",
  error: unknown,
): void {
  log("signal_bot_trading_internal_api_error", {
    operation,
    ...describeTelegramBotTradingInternalApiError(error),
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
  const signalTransports = [createSignalBotTelegramTransport(telegram)];
  const xEditorialComposer = config.xEditorial.enabled
    ? createOpenRouterXEditorialDraftComposer({
        apiKey: requiredEnv("OPENROUTER_API_KEY"),
        config: config.xEditorial,
      })
    : undefined;
  const botUsername = await telegram
    .getMe()
    .then((user) => user.username ?? null)
    .catch((error: unknown) => {
      log("signal_bot_get_me_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const telegramUi = await configureSignalBotTelegramUi({ config, telegram });
  log("signal_bot_telegram_ui_configured", {
    configured: telegramUi.configured,
    failures: telegramUi.failures.length,
  });
  for (const failure of telegramUi.failures) {
    log("signal_bot_telegram_ui_config_failed", failure);
  }

  log("signal_bot_started", {
    adminCount: config.adminUserIds.size,
    aggAlternativesConfigured: aggConfig != null,
    aggCredentialSource: aggConfig?.credentialSource ?? "none",
    buyAmountUsd: config.buyAmountUsd,
    maxSignalsPerTick: config.maxSignalsPerTick,
    publishIntervalSec: config.publishIntervalSec,
    xEditorialEnabled: config.xEditorial.enabled,
    xEditorialMaxCharacters: config.xEditorial.maxCharacters,
    xEditorialModel: config.xEditorial.model,
  });

  let nextPublishAt = 0;
  let nextNotificationAt = 0;
  let nextNotificationCleanupAt = 0;
  let lastNotificationPolicySignature: string | null = null;
  let heartbeatLost = false;
  let fundingDeliveryTimer: ReturnType<typeof setInterval> | null = null;
  let fundingDeliveryInFlight: Promise<void> | null = null;
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
    const loadAccountValue = createTelegramAccountValueLoader({
      load: ({ chatId, telegramUserId }) =>
        tradingInternalApi
          ? tradingInternalApi.buildAccountValueMessage({
              chatId,
              telegramUserId,
            })
          : Promise.reject(new Error("Account Value API is unavailable")),
      maxConcurrency: 4,
    });
    const drainFundingDelivery = (): Promise<void> => {
      fundingDeliveryInFlight ??= (async () => {
        try {
          const fundingDelivery = await deliverTelegramFundingActions({
            pool: db,
            limit: 25,
            renderCoordinator: createTelegramFundingRenderCoordinator(redis),
            ...(tradingInternalApi
              ? {
                  resolveMessage: ({ contextId, projection, telegramUserId }) =>
                    tradingInternalApi.getFundingSession({
                      chatId: telegramUserId,
                      contextId,
                      deliveryProjection: projection,
                      telegramUserId,
                      view: "delivery",
                    }),
                }
              : {}),
            telegram,
          });
          if (fundingDelivery.claimed > 0) {
            log("signal_bot_funding_delivery", fundingDelivery);
          }
        } catch (error) {
          log("signal_bot_funding_delivery_error", {
            errorCode: error instanceof Error ? error.name : "unexpected_error",
          });
        }
      })().finally(() => {
        fundingDeliveryInFlight = null;
      });
      return fundingDeliveryInFlight;
    };
    // Telegram long polling is independent from durable financial delivery.
    fundingDeliveryTimer = setInterval(
      () => void drainFundingDelivery(),
      1_000,
    );
    fundingDeliveryTimer.unref?.();
    while (!shuttingDown) {
      try {
        if (heartbeatLost) break;

        const handledCommands = await pollSignalBotCommands({
          attachRewardsReferralCode: ({ code, telegramUserId }) =>
            attachTelegramBotReferralCode({
              code,
              pool: db,
              telegramUserId,
            }),
          botUsername,
          config,
          db,
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
              xEditorialComposer,
            }),
          sendTestRich: (chatId, kind) =>
            sendSignalBotRichLayoutPreview({ chatId, kind, telegram }),
          sendTestSignal: (chatId, selector) =>
            sendLatestSignalBotTestSignal({
              chatId,
              config,
              db,
              redis,
              selector,
              telegram,
              xEditorialComposer,
            }),
          loadAccountValue,
          completeTradeInput: (input) =>
            tradingInternalApi
              ? tradingInternalApi
                  .completeTradeInput({
                    ...input,
                    appBaseUrl: config.appBaseUrl,
                  })
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("trade-input", error);
                    throw error;
                  })
              : Promise.reject(
                  new Error("Custom trade input API is unavailable"),
                ),
          onAccountValueError: (error) =>
            logTradingInternalApiFailure("account-value", error),
          onFundingMenuDelivery: ({ action, outcome, retryAfterSec }) =>
            log("signal_bot_funding_menu_delivery", {
              action,
              outcome,
              ...(retryAfterSec == null ? {} : { retryAfterSec }),
            }),
          onFundingMenuOperationError: ({ action, errorCode }) =>
            log("signal_bot_funding_menu_operation_error", {
              action,
              errorCode,
            }),
          loadPositions: (telegramUserId) =>
            tradingInternalApi
              ? tradingInternalApi
                  .buildPositionsMessage({
                    appBaseUrl: config.appBaseUrl,
                    telegramMiniAppEnabled:
                      config.telegramMiniAppLinkBase != null,
                    telegramUserId,
                  })
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("positions", error);
                    throw error;
                  })
              : Promise.reject(new Error("Positions API is unavailable")),
          loadRewards: ({ notice, telegramUserId, view }) =>
            loadTelegramBotRewardsMessage({
              appBaseUrl: config.appBaseUrl,
              callbackPrefix: SIGNAL_BOT_MENU_CALLBACK_PREFIX,
              miniAppEnabled: config.telegramMiniAppLinkBase != null,
              miniAppLinkBase: config.telegramMiniAppLinkBase,
              notice,
              pool: db,
              telegramUserId,
              view,
            }),
          loadDeposit: ({ telegramUserId, venue }) =>
            tradingInternalApi
              ? tradingInternalApi
                  .buildDepositMessage({
                    appBaseUrl: config.appBaseUrl,
                    telegramMiniAppEnabled:
                      config.telegramMiniAppLinkBase != null,
                    telegramUserId,
                    venue,
                  })
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("deposit", error);
                    throw error;
                  })
              : Promise.reject(new Error("Deposit API is unavailable")),
          loadFunding: (input) => {
            if (!tradingInternalApi) {
              return Promise.reject(new Error("Funding API is unavailable"));
            }
            const request =
              input.action === "open"
                ? tradingInternalApi.openFunding({
                    appBaseUrl: config.appBaseUrl,
                    chatId: input.chatId,
                    idempotencyKey: input.idempotencyKey,
                    telegramMiniAppEnabled:
                      config.telegramMiniAppLinkBase != null,
                    telegramMessageId: input.telegramMessageId,
                    telegramUserId: input.telegramUserId,
                    venue: "polymarket",
                  })
                : input.action === "select" &&
                    input.contextId &&
                    input.choiceToken
                  ? tradingInternalApi.selectFundingTarget({
                      chatId: input.chatId,
                      choiceToken: input.choiceToken,
                      contextId: input.contextId,
                      idempotencyKey: input.idempotencyKey,
                      telegramMessageId: input.telegramMessageId,
                      telegramUserId: input.telegramUserId,
                    })
                  : input.action === "resume_buy" &&
                      input.continuationToken &&
                      input.telegramMessageId
                    ? tradingInternalApi.resumeFundingBuy({
                        appBaseUrl: config.appBaseUrl,
                        chatId: input.chatId,
                        continuationToken: input.continuationToken,
                        idempotencyKey: input.idempotencyKey,
                        telegramMessageId: input.telegramMessageId,
                        telegramMiniAppEnabled:
                          config.telegramMiniAppLinkBase != null,
                        telegramUserId: input.telegramUserId,
                      })
                    : input.action === "confirm_conversion" &&
                        input.consentToken
                      ? tradingInternalApi.confirmFundingConversion({
                          chatId: input.chatId,
                          consentToken: input.consentToken,
                          idempotencyKey: input.idempotencyKey,
                          telegramMessageId: input.telegramMessageId,
                          telegramUserId: input.telegramUserId,
                        })
                      : input.action === "review_conversion" && input.receiptId
                        ? tradingInternalApi.reviewFundingConversion({
                            chatId: input.chatId,
                            idempotencyKey: input.idempotencyKey,
                            receiptId: input.receiptId,
                            telegramMessageId: input.telegramMessageId,
                            telegramUserId: input.telegramUserId,
                          })
                        : input.action === "cancel" && input.contextId
                          ? tradingInternalApi.cancelFunding({
                              chatId: input.chatId,
                              contextId: input.contextId,
                              idempotencyKey: input.idempotencyKey,
                              telegramMessageId: input.telegramMessageId,
                              telegramUserId: input.telegramUserId,
                            })
                          : input.action === "session" && input.contextId
                            ? tradingInternalApi.getFundingSession({
                                chatId: input.chatId,
                                contextId: input.contextId,
                                telegramMessageId: input.telegramMessageId,
                                telegramUserId: input.telegramUserId,
                                view: input.view,
                              })
                            : Promise.reject(
                                new Error("Funding callback is invalid"),
                              );
            return request.catch((error: unknown) => {
              logTradingInternalApiFailure("funding", error);
              throw error;
            });
          },
          loadPositionCard: ({ messageId, positionId, telegramUserId }) =>
            tradingInternalApi
              ? tradingInternalApi
                  .buildPositionMessage({
                    appBaseUrl: config.appBaseUrl,
                    telegramMessageId: messageId,
                    positionId,
                    telegramMiniAppEnabled:
                      config.telegramMiniAppLinkBase != null,
                    telegramUserId,
                  })
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("position-card", error);
                    throw error;
                  })
              : Promise.reject(new Error("Positions API is unavailable")),
          searchMarkets: (body) =>
            tradingInternalApi
              ? tradingInternalApi
                  .searchMarkets(body)
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("market-search", error);
                    throw error;
                  })
              : Promise.reject(new Error("Market search is unavailable")),
          loadMarketCard: (input) =>
            tradingInternalApi
              ? tradingInternalApi
                  .buildMarketMessage({
                    appBaseUrl: config.appBaseUrl,
                    chatId: input.chatId,
                    context: input.context,
                    marketRef: input.marketRef,
                    publicBrowseOnly: input.publicBrowseOnly,
                    telegramMessageId: input.telegramMessageId,
                    telegramMiniAppEnabled:
                      config.telegramMiniAppLinkBase != null,
                    telegramUserId: input.telegramUserId,
                  })
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("market-card", error);
                    throw error;
                  })
              : Promise.reject(new Error("Market card API is unavailable")),
          loadTradeStatus: (telegramUserId) =>
            tradingInternalApi
              ? tradingInternalApi
                  .buildStatusMessage(telegramUserId)
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("status", error);
                    throw error;
                  })
              : Promise.reject(new Error("Trading status is unavailable")),
          prepareRewardsReferralCodeChange: ({ code, telegramUserId }) =>
            prepareTelegramBotReferralCodeChange({
              code,
              pool: db,
              telegramUserId,
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
                      text: formatTelegramCalloutMarkdownV2({
                        bodyMarkdownV2: "Open Hunch to trade\\.",
                        icon: "⚠️",
                        title: "Trading unavailable",
                      }),
                    };
                  })
              : {
                  parse_mode: "MarkdownV2" as const,
                  reply_markup: undefined,
                  text: formatTelegramCalloutMarkdownV2({
                    bodyMarkdownV2: "Open Hunch to trade\\.",
                    icon: "⚠️",
                    title: "Trading unavailable",
                  }),
                };
            const navigableMessage = withTelegramPrivateNavigation(message);
            const result = await telegram.sendMessage({
              chat_id: chatId,
              disable_web_page_preview: true,
              parse_mode: navigableMessage.parse_mode ?? "MarkdownV2",
              reply_markup: navigableMessage.reply_markup,
              text: navigableMessage.text,
            });
            return result.ok;
          },
          updateRewardsReferralCode: ({ code, telegramUserId }) =>
            updateTelegramBotReferralCode({
              code,
              pool: db,
              telegramUserId,
            }),
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
            const fallbackButton = buildHunchMiniAppWebButton({
              appBaseUrl: config.appBaseUrl,
              enabled: config.telegramMiniAppLinkBase != null,
              text: "Open in Hunch",
            });
            const fallbackMessage = {
              parse_mode: "MarkdownV2" as const,
              ...(fallbackButton
                ? { reply_markup: { inline_keyboard: [[fallbackButton]] } }
                : {}),
              text: formatTelegramCalloutMarkdownV2({
                bodyMarkdownV2: "Open Hunch to trade\\.",
                icon: "⚠️",
                title: "Trading unavailable",
              }),
            };
            const message = tradingInternalApi
              ? await tradingInternalApi
                  .buildMarketMessage({
                    appBaseUrl: config.appBaseUrl,
                    chatId: input.chatId,
                    isAdminTest: input.isAdminTest,
                    marketRef: input.marketRef,
                    publicBrowseOnly: input.publicBrowseOnly,
                    telegramMessageId: input.telegramMessageId,
                    telegramMiniAppEnabled:
                      config.telegramMiniAppLinkBase != null,
                    telegramUserId: input.telegramUserId,
                  })
                  .catch((error: unknown) => {
                    logTradingInternalApiFailure("market-card", error);
                    return fallbackMessage;
                  })
              : fallbackMessage;
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
                    beginTradeInput: (begin) => {
                      const chatId =
                        callbackQuery.message?.chat?.id == null
                          ? null
                          : String(callbackQuery.message.chat.id);
                      const telegramUserId = callbackQuery.from?.id;
                      const menuMessageId = callbackQuery.message?.message_id;
                      if (!chatId || !telegramUserId || menuMessageId == null)
                        return Promise.resolve(false);
                      return beginSignalBotTradeInput({
                        action: begin.action,
                        chatId,
                        contextId: begin.contextId,
                        expiresAt: begin.expiresAt,
                        menuMessageId,
                        message: begin.message,
                        redis,
                        telegramUserId,
                        transport: telegram,
                      });
                    },
                    callbackQuery,
                    editMessageText: (message) =>
                      telegram.editMessageText({
                        ...message,
                        disable_web_page_preview: true,
                        parse_mode: message.parse_mode ?? "MarkdownV2",
                      }),
                    sendMessage: (message) =>
                      telegram.sendMessage({
                        ...message,
                        disable_web_page_preview: true,
                        parse_mode: message.parse_mode ?? "MarkdownV2",
                      }),
                    telegramMiniAppEnabled:
                      config.telegramMiniAppLinkBase != null,
                  })
                  .catch(async (error: unknown) => {
                    logTradingInternalApiFailure("callback", error);
                    await telegram.answerCallbackQuery({
                      callbackQueryId: callbackQuery.id,
                      showAlert: true,
                      text: "⚠️ Trading is unavailable. Open Hunch to trade.",
                    });
                    return true;
                  })
              : telegram
                  .answerCallbackQuery({
                    callbackQueryId: callbackQuery.id,
                    showAlert: true,
                    text: "⚠️ Trading is unavailable. Open Hunch to trade.",
                  })
                  .then(() => true),
          telegram,
        });
        if (handledCommands > 0) {
          log("signal_bot_commands", { handled: handledCommands });
          // Long polling must not add another 5-30 seconds after a financial
          // callback. The periodic drain below remains crash/retry recovery.
          await drainFundingDelivery();
        }

        const now = Date.now();
        if (!heartbeatLost && now >= nextNotificationAt) {
          try {
            const onboardingDelivery =
              await deliverTelegramBotOnboardingActions({
                config,
                db,
                limit: 25,
                telegram,
              });
            if (
              onboardingDelivery.claimed > 0 ||
              onboardingDelivery.quarantined > 0
            ) {
              log("signal_bot_onboarding_delivery", onboardingDelivery);
            }
          } catch (error) {
            log("signal_bot_onboarding_delivery_error", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          let cleaned = 0;
          let onboardingCleaned = 0;
          let fundingCleaned = 0;
          if (now >= nextNotificationCleanupAt) {
            try {
              [cleaned, onboardingCleaned, fundingCleaned] = await Promise.all([
                cleanupTelegramNotificationOutbox({ db }),
                cleanupTelegramBotActionOutbox({ db }),
                cleanupTelegramFundingContexts({ pool: db }),
              ]);
              nextNotificationCleanupAt = now + 60 * 60 * 1_000;
            } catch (error) {
              log("signal_bot_user_notifications_cleanup_error", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          try {
            const resolvedPolicy = await resolveTelegramNotificationsPolicy(db);
            const policySignature = JSON.stringify({
              effectiveAt: resolvedPolicy.effectiveAt,
              invalidOverride: resolvedPolicy.invalidOverride,
              policy: resolvedPolicy.policy,
              source: resolvedPolicy.source,
            });
            if (policySignature !== lastNotificationPolicySignature) {
              lastNotificationPolicySignature = policySignature;
              log("signal_bot_user_notifications_policy", {
                effectiveAt: resolvedPolicy.effectiveAt,
                invalidOverride: resolvedPolicy.invalidOverride,
                ...resolvedPolicy.policy,
                source: resolvedPolicy.source,
              });
            }

            const activityEnqueued = resolvedPolicy.policy
              .activityEnqueueEnabled
              ? await enqueueTelegramActivityNotifications({
                  limit: 200,
                  pool: db,
                })
              : 0;
            const positionSignals = resolvedPolicy.policy
              .positionSignalEnqueueEnabled
              ? await enqueueTelegramPositionSignals({
                  config,
                  limit: config.maxSignalsPerTick,
                  pool: db,
                })
              : { enqueued: 0, notes: 0 };
            const delivery = resolvedPolicy.policy.deliveryEnabled
              ? await deliverTelegramNotificationOutbox({
                  db,
                  limit: 25,
                  miniAppLinkBase: config.telegramMiniAppLinkBase,
                  telegram,
                })
              : {
                  blocked: 0,
                  claimed: 0,
                  deferred: 0,
                  failed: 0,
                  quarantined: 0,
                  sent: 0,
                  skipped: 0,
                };
            if (
              activityEnqueued > 0 ||
              positionSignals.enqueued > 0 ||
              delivery.claimed > 0 ||
              delivery.quarantined > 0 ||
              cleaned > 0 ||
              onboardingCleaned > 0 ||
              fundingCleaned > 0
            ) {
              log("signal_bot_user_notifications", {
                activityEnqueued,
                cleaned,
                fundingCleaned,
                onboardingCleaned,
                positionSignalEnqueued: positionSignals.enqueued,
                positionSignalNotes: positionSignals.notes,
                ...delivery,
              });
            }
          } catch (error) {
            log("signal_bot_user_notifications_error", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          nextNotificationAt = now + 5_000;
        }
        if (!heartbeatLost && now >= nextPublishAt) {
          const result = await publishSignalBotTick({
            config,
            db,
            redis,
            telegram,
            transports: signalTransports,
            xEditorialComposer,
          });
          log("signal_bot_publish_tick", result);
          const followthrough = await publishSignalBotFollowthroughTick({
            config,
            db,
            redis,
            telegram,
            transports: signalTransports,
            xEditorialComposer,
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
    if (fundingDeliveryTimer) clearInterval(fundingDeliveryTimer);
    // A successful Telegram mutation is not durable until its result is stored.
    // Keep the pool alive for the one bounded delivery already in progress.
    await fundingDeliveryInFlight;
    const drainedConfirmTasks = await drainSignalBotConfirmTasks(10_000);
    if (!drainedConfirmTasks) {
      log("signal_bot_confirm_tasks_drain_timeout");
    }
    const drainedFundingOpenTasks =
      await drainSignalBotFundingOpenTasks(10_000);
    if (!drainedFundingOpenTasks) {
      log("signal_bot_funding_open_tasks_drain_timeout");
    }
    await releaseSignalBotLock({ owner, redis }).catch(() => undefined);
    await dbPool?.end().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runSignalBotRunner();
}
