import {
  TELEGRAM_BOT_TRADING_CALLBACK_PREFIX,
  type TelegramBotTradingClientMessage,
  type TelegramFundingClientMessage,
} from "./telegram-bot-trading-client.js";
import {
  clearSignalBotPrimaryMenuInputIfCurrent,
  clearSignalBotMenuInputIfCurrent,
  readSignalBotMenuInput,
  readSignalBotTradeInputGuard,
  type SignalBotMenuStateRedis,
  writeSignalBotTradeMenuInput,
} from "./telegram-bot-menu-state.js";
import { withTelegramPrivateNavigation } from "./telegram-bot-private-navigation.js";
import {
  classifyTelegramBotMenuDeliveryResult,
  sendOrEditTelegramBotMenuMessage,
  type TelegramBotMenuTransport,
} from "./telegram-bot-menu-delivery.js";
import { escapeTelegramMarkdownV2 } from "./telegram-bot-trading-presentation.js";

type TradeInputRedis = Pick<SignalBotMenuStateRedis, "eval" | "get" | "set">;

export async function beginSignalBotTradeInput(input: {
  action: "buy" | "sell";
  chatId: string;
  contextId: string;
  expiresAt: string;
  menuMessageId: number;
  message: TelegramBotTradingClientMessage;
  redis: TradeInputRedis;
  telegramUserId: number;
  transport: TelegramBotMenuTransport;
}): Promise<boolean> {
  const activePreviousState = await readSignalBotMenuInput({
    chatId: input.chatId,
    redis: input.redis,
    telegramUserId: input.telegramUserId,
  });
  // The primary state expires with the economic input, while the short guard
  // deliberately survives a little longer so text sent to an old card cannot
  // become a market search. Read that guard before replacing it so the old
  // visible card is also made inert when a new custom input is opened.
  const previousState =
    activePreviousState?.kind === "awaiting_custom_buy_amount" ||
    activePreviousState?.kind === "awaiting_custom_sell_amount"
      ? activePreviousState
      : await readSignalBotTradeInputGuard({
          chatId: input.chatId,
          redis: input.redis,
          telegramUserId: input.telegramUserId,
        });
  const state = await writeSignalBotTradeMenuInput({
    action: input.action,
    chatId: input.chatId,
    contextId: input.contextId,
    expiresAt: input.expiresAt,
    menuMessageId: input.menuMessageId,
    redis: input.redis,
    telegramUserId: input.telegramUserId,
  });
  if (!state) return false;
  const delivered = await sendOrEditTelegramBotMenuMessage({
    chatId: input.chatId,
    message: input.message,
    messageId: input.menuMessageId,
    transport: input.transport,
  });
  const outcome = classifyTelegramBotMenuDeliveryResult(delivered).outcome;
  if (
    previousState &&
    (previousState.kind === "awaiting_custom_buy_amount" ||
      previousState.kind === "awaiting_custom_sell_amount") &&
    previousState.menuMessageId != null &&
    previousState.menuMessageId !== input.menuMessageId
  ) {
    await sendOrEditTelegramBotMenuMessage({
      chatId: input.chatId,
      message: withTelegramPrivateNavigation(
        {
          text: escapeTelegramMarkdownV2(
            "This custom input was replaced by a newer trade card. Use the latest card or reopen this market.",
          ),
        },
        {
          marketCallbackData: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:open_market:${previousState.contextId}`,
        },
      ),
      messageId: previousState.menuMessageId,
      transport: input.transport,
    }).catch(() => undefined);
  }
  if (outcome === "success" || outcome === "ambiguous") return true;
  await clearSignalBotMenuInputIfCurrent({
    chatId: input.chatId,
    redis: input.redis,
    stateToken: state.stateToken,
    telegramUserId: input.telegramUserId,
  }).catch(() => false);
  return false;
}

/** Replace the input prompt with its originating market and release Redis state. */
export async function cancelSignalBotTradeInput(input: {
  chatId: string;
  contextId: string;
  message: TelegramBotTradingClientMessage;
  redis: TradeInputRedis;
  telegramUserId: number;
  transport: TelegramBotMenuTransport;
}): Promise<boolean> {
  const state = await readSignalBotMenuInput({
    chatId: input.chatId,
    redis: input.redis,
    telegramUserId: input.telegramUserId,
  });
  if (
    !state ||
    (state.kind !== "awaiting_custom_buy_amount" &&
      state.kind !== "awaiting_custom_sell_amount") ||
    state.contextId !== input.contextId ||
    state.menuMessageId == null
  ) {
    return false;
  }
  const delivered = await sendOrEditTelegramBotMenuMessage({
    chatId: input.chatId,
    message: input.message,
    messageId: state.menuMessageId,
    transport: input.transport,
  });
  const outcome = classifyTelegramBotMenuDeliveryResult(delivered).outcome;
  if (outcome === "ambiguous") {
    return clearSignalBotPrimaryMenuInputIfCurrent({
      chatId: input.chatId,
      redis: input.redis,
      stateToken: state.stateToken,
      telegramUserId: input.telegramUserId,
    }).catch(() => false);
  }
  if (outcome !== "success") return false;
  return clearSignalBotMenuInputIfCurrent({
    chatId: input.chatId,
    redis: input.redis,
    stateToken: state.stateToken,
    telegramUserId: input.telegramUserId,
  }).catch(() => false);
}

export async function handleSignalBotTradeInput(input: {
  chatId: string;
  complete: (input: {
    chatId: string;
    contextId: string;
    telegramMessageId: number;
    telegramMiniAppEnabled?: boolean;
    telegramUserId: number;
    value: string;
  }) => Promise<{
    completed: boolean;
    message: TelegramFundingClientMessage;
  }>;
  redis: TradeInputRedis;
  telegramUserId: number;
  telegramMiniAppEnabled?: boolean;
  text: string;
  transport: TelegramBotMenuTransport;
}): Promise<boolean> {
  const state = await readSignalBotMenuInput(input);
  if (
    !state ||
    (state.kind !== "awaiting_custom_buy_amount" &&
      state.kind !== "awaiting_custom_sell_amount")
  ) {
    // An explicit newer Search/Rewards input owns the next free-text message.
    // The guard is only a fallback when no primary menu state remains.
    if (state) return false;
    const staleTradeInput = await readSignalBotTradeInputGuard(input);
    if (!staleTradeInput) return false;
    const expiredMessage = withTelegramPrivateNavigation(
      {
        text: escapeTelegramMarkdownV2(
          "This custom input is no longer active. Reopen the market to enter a new amount.",
        ),
      },
      {
        marketCallbackData: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:open_market:${staleTradeInput.contextId}`,
      },
    );
    const delivered =
      staleTradeInput.menuMessageId != null
        ? await sendOrEditTelegramBotMenuMessage({
            chatId: input.chatId,
            message: expiredMessage,
            messageId: staleTradeInput.menuMessageId,
            transport: input.transport,
          })
        : await input.transport.sendMessage({
            chat_id: input.chatId,
            disable_web_page_preview: true,
            reply_markup: expiredMessage.reply_markup,
            text: expiredMessage.text,
          });
    if (
      classifyTelegramBotMenuDeliveryResult(delivered).outcome === "success"
    ) {
      await clearSignalBotMenuInputIfCurrent({
        chatId: input.chatId,
        redis: input.redis,
        stateToken: staleTradeInput.stateToken,
        telegramUserId: input.telegramUserId,
      }).catch(() => false);
    }
    return true;
  }
  if (state.menuMessageId == null) {
    await clearSignalBotMenuInputIfCurrent({
      chatId: input.chatId,
      redis: input.redis,
      stateToken: state.stateToken,
      telegramUserId: input.telegramUserId,
    }).catch(() => false);
    await input.transport.sendMessage({
      chat_id: input.chatId,
      disable_web_page_preview: true,
      text: "Custom input expired. Open the market and try again.",
    });
    return true;
  }
  let result: Awaited<ReturnType<typeof input.complete>>;
  try {
    result = await input.complete({
      chatId: input.chatId,
      contextId: state.contextId,
      // The returned card is edited into this message, so it must also own
      // any funding context opened while completing the Buy preview.
      telegramMessageId: state.menuMessageId,
      telegramMiniAppEnabled: input.telegramMiniAppEnabled,
      telegramUserId: input.telegramUserId,
      value: input.text,
    });
  } catch {
    await sendOrEditTelegramBotMenuMessage({
      chatId: input.chatId,
      message: {
        text: "Could not verify that input. Send the exact same amount again. Do not enter a different amount for this request.",
      },
      messageId: state.menuMessageId,
      transport: input.transport,
    });
    return true;
  }
  const delivered = await sendOrEditTelegramBotMenuMessage({
    chatId: input.chatId,
    message: result.message,
    messageId: state.menuMessageId,
    transport: input.transport,
  });
  const outcome = classifyTelegramBotMenuDeliveryResult(delivered).outcome;
  if (result.completed && outcome === "success") {
    await clearSignalBotMenuInputIfCurrent({
      chatId: input.chatId,
      redis: input.redis,
      stateToken: state.stateToken,
      telegramUserId: input.telegramUserId,
    }).catch(() => false);
  }
  return true;
}
