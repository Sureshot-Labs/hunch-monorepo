import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import {
  clearSignalBotMenuInputIfCurrent,
  readSignalBotMenuInput,
  type SignalBotMenuStateRedis,
  writeSignalBotTradeMenuInput,
} from "./telegram-bot-menu-state.js";
import {
  classifyTelegramBotMenuDeliveryResult,
  sendOrEditTelegramBotMenuMessage,
  type TelegramBotMenuTransport,
} from "./telegram-bot-menu-delivery.js";

type TradeInputRedis = Pick<SignalBotMenuStateRedis, "eval" | "get" | "set">;

export async function beginSignalBotTradeInput(input: {
  action: "buy" | "sell";
  chatId: string;
  contextId: string;
  expiresAt: string;
  menuMessageId: number | null;
  message: TelegramBotTradingClientMessage;
  redis: TradeInputRedis;
  telegramUserId: number;
  transport: TelegramBotMenuTransport;
}): Promise<boolean> {
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
  if (outcome === "success" || outcome === "ambiguous") return true;
  await clearSignalBotMenuInputIfCurrent({
    chatId: input.chatId,
    redis: input.redis,
    stateToken: state.stateToken,
    telegramUserId: input.telegramUserId,
  }).catch(() => false);
  return false;
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
    message: TelegramBotTradingClientMessage;
  }>;
  messageId: number;
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
    return false;
  }
  let result: Awaited<ReturnType<typeof input.complete>>;
  try {
    result = await input.complete({
      chatId: input.chatId,
      contextId: state.contextId,
      telegramMessageId: input.messageId,
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
