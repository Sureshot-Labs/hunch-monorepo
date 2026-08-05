import type {
  SignalBotTelegramClient,
  TelegramInlineKeyboard,
  TelegramSendResult,
} from "./signal-bot-contracts.js";
import {
  isSignalBotMenuRenderCurrent,
  withSignalBotMenuRenderLock,
} from "./telegram-bot-menu-state.js";

export type TelegramBotMenuMessage = {
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: TelegramInlineKeyboard;
  text: string;
};

export type TelegramBotMenuTransport = {
  editMessageText?: SignalBotTelegramClient["editMessageText"];
  sendMessage: SignalBotTelegramClient["sendMessage"];
};

export function isTelegramBotMenuRenderSuppressed(
  result: TelegramSendResult,
): boolean {
  return (
    !result.ok &&
    result.error === "other" &&
    /^menu_render_(?:superseded|unavailable)$/u.test(result.message)
  );
}

export function createTelegramBotCallbackMenuTransport(input: {
  chatId: string;
  messageId: number;
  redis: {
    eval(
      script: string,
      options: { arguments: string[]; keys: string[] },
    ): Promise<unknown>;
    get(key: string): Promise<string | null>;
    set(
      key: string,
      value: string,
      options?: { NX?: boolean; PX?: number },
    ): Promise<unknown>;
  };
  renderToken: string;
  transport: TelegramBotMenuTransport;
}): TelegramBotMenuTransport {
  const editMessageText = input.transport.editMessageText;
  const deliver = async (
    operation: () => Promise<TelegramSendResult>,
  ): Promise<TelegramSendResult> => {
    const result = await withSignalBotMenuRenderLock({
      chatId: input.chatId,
      messageId: input.messageId,
      redis: input.redis,
      isCurrent: () =>
        isSignalBotMenuRenderCurrent({
          chatId: input.chatId,
          messageId: input.messageId,
          redis: input.redis,
          renderToken: input.renderToken,
        }),
      deliver: operation,
    });
    if (result.status === "completed") return result.value;
    return {
      error: "other",
      message: `menu_render_${result.status}`,
      ok: false,
    };
  };
  return {
    ...(editMessageText
      ? {
          editMessageText: (message) =>
            deliver(() => editMessageText.call(input.transport, message)),
        }
      : {}),
    sendMessage: (message) =>
      deliver(() => input.transport.sendMessage(message)),
  };
}

export async function sendOrEditTelegramBotMenuMessage(input: {
  chatId: string;
  message: TelegramBotMenuMessage;
  messageId?: number | null;
  shouldDeliver?: () => Promise<boolean>;
  transport: TelegramBotMenuTransport;
}): Promise<TelegramSendResult> {
  const superseded = (): TelegramSendResult => ({
    error: "other",
    message: "superseded",
    ok: false,
  });
  if (input.shouldDeliver && !(await input.shouldDeliver())) {
    return superseded();
  }
  if (input.messageId != null && input.transport.editMessageText) {
    const edited = await input.transport.editMessageText({
      chat_id: input.chatId,
      disable_web_page_preview: true,
      message_id: input.messageId,
      parse_mode: input.message.parse_mode ?? "MarkdownV2",
      reply_markup: input.message.reply_markup,
      text: input.message.text,
    });
    if (edited.ok || /message is not modified/i.test(edited.message)) {
      return edited;
    }
    if (isTelegramBotMenuRenderSuppressed(edited)) return edited;
    if (edited.error !== "message_not_editable") return edited;
  }
  if (input.shouldDeliver && !(await input.shouldDeliver())) {
    return superseded();
  }
  return input.transport.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: true,
    parse_mode: input.message.parse_mode ?? "MarkdownV2",
    reply_markup: input.message.reply_markup,
    text: input.message.text,
  });
}
