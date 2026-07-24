import {
  telegramCustomEmojiId,
  telegramCustomEmojiMarkdownV2,
} from "./telegram-custom-emoji.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
} from "./telegram-bot-trading-presentation.js";

export function buildSignalBotPrivateMenuEntry(input: {
  botUsername?: string | null;
  chatId: string;
  chatType?: string | null;
  miniAppLinkBase: string | null;
}) {
  const targetUrl = input.botUsername
    ? `https://t.me/${input.botUsername}`
    : input.miniAppLinkBase;
  return {
    chat_id: input.chatId,
    disable_web_page_preview: true,
    parse_mode: "MarkdownV2" as const,
    ...(targetUrl
      ? {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  ...(input.chatType === "channel"
                    ? {}
                    : {
                        icon_custom_emoji_id: telegramCustomEmojiId("hunch"),
                      }),
                  text:
                    input.chatType === "channel"
                      ? "🟠 Open bot menu"
                      : "Open bot menu",
                  url: targetUrl,
                },
              ],
            ],
          },
        }
      : {}),
    text: [
      input.chatType === "channel"
        ? `🟠 ${formatTelegramBoldMarkdownV2("Hunch Signal Bot")}`
        : `${telegramCustomEmojiMarkdownV2(
            "hunch",
          )} ${formatTelegramBoldMarkdownV2("Hunch Signal Bot")}`,
      "",
      escapeTelegramMarkdownV2(
        "Open a private chat with the bot to use trading, account controls, and the Hunch Mini App.",
      ),
    ].join("\n"),
  };
}
