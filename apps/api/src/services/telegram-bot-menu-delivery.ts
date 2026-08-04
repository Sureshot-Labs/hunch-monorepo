import type {
  SignalBotTelegramClient,
  TelegramInlineKeyboard,
  TelegramSendResult,
} from "./signal-bot-contracts.js";

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

export async function sendOrEditTelegramBotMenuMessage(input: {
  chatId: string;
  message: TelegramBotMenuMessage;
  messageId?: number | null;
  transport: TelegramBotMenuTransport;
}): Promise<TelegramSendResult> {
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
  }
  return input.transport.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: true,
    parse_mode: input.message.parse_mode ?? "MarkdownV2",
    reply_markup: input.message.reply_markup,
    text: input.message.text,
  });
}
