import { buildTelegramAccountValueUnavailableMessage } from "./telegram-account-value-contract.js";
import {
  sendOrEditTelegramBotMenuMessage,
  type TelegramBotMenuMessage,
  type TelegramBotMenuTransport,
} from "./telegram-bot-menu-delivery.js";
import { clearSignalBotMenuInput } from "./telegram-bot-menu-state.js";

type TelegramAccountValueLoader = (input: {
  chatId: string;
  telegramUserId: number;
}) => Promise<TelegramBotMenuMessage>;

export function createTelegramAccountValueLoader(input: {
  load: TelegramAccountValueLoader;
  maxConcurrency?: number;
}): TelegramAccountValueLoader {
  const maxConcurrency = Math.max(1, Math.trunc(input.maxConcurrency ?? 4));
  const inFlight = new Map<number, Promise<TelegramBotMenuMessage>>();
  let active = 0;

  return (request) => {
    const existing = inFlight.get(request.telegramUserId);
    if (existing) return existing;
    if (active >= maxConcurrency) {
      return Promise.resolve(buildTelegramAccountValueUnavailableMessage());
    }
    active += 1;
    const pending = (async () => {
      try {
        return await input.load(request);
      } finally {
        active -= 1;
      }
    })().finally(() => {
      inFlight.delete(request.telegramUserId);
    });
    inFlight.set(request.telegramUserId, pending);
    return pending;
  };
}

export async function handleTelegramAccountValueMenu(input: {
  chatId: string;
  loadAccountValue?: TelegramAccountValueLoader;
  messageId: number | null;
  onError?: (error: unknown) => void;
  redis: { del(key: string): Promise<unknown> };
  shouldDeliver?: () => Promise<boolean>;
  telegramUserId: number;
  transport: TelegramBotMenuTransport;
}): Promise<void> {
  void clearSignalBotMenuInput({
    chatId: input.chatId,
    redis: input.redis,
    telegramUserId: input.telegramUserId,
  }).catch((error: unknown) => input.onError?.(error));
  let message: TelegramBotMenuMessage;
  try {
    message = input.loadAccountValue
      ? await input.loadAccountValue({
          chatId: input.chatId,
          telegramUserId: input.telegramUserId,
        })
      : buildTelegramAccountValueUnavailableMessage();
  } catch (error) {
    input.onError?.(error);
    message = buildTelegramAccountValueUnavailableMessage();
  }
  try {
    await sendOrEditTelegramBotMenuMessage({
      chatId: input.chatId,
      message,
      messageId: input.messageId,
      shouldDeliver: input.shouldDeliver,
      transport: input.transport,
    });
  } catch (error) {
    input.onError?.(error);
  }
}
