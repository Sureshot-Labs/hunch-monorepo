import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramCalloutMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";

const CALLBACK_PREFIX = "hm:v1:";

export function buildTelegramAccountValueKeyboard(): NonNullable<
  TelegramBotTradingClientMessage["reply_markup"]
> {
  return {
    inline_keyboard: [
      [{ callback_data: `${CALLBACK_PREFIX}balance`, text: "🔄 Refresh" }],
      [
        { callback_data: `${CALLBACK_PREFIX}deposit`, text: "➕ Add funds" },
        {
          callback_data: `${CALLBACK_PREFIX}trading:market_input`,
          text: "💸 Buy",
        },
      ],
      [{ callback_data: `${CALLBACK_PREFIX}home`, text: "⬅️ Back" }],
    ],
  };
}

export function buildTelegramAccountValueUnavailableMessage(): TelegramBotTradingClientMessage {
  return {
    parse_mode: "MarkdownV2",
    reply_markup: buildTelegramAccountValueKeyboard(),
    text: joinTelegramMarkdownV2Lines([
      `💰 ${formatTelegramBoldMarkdownV2("Balance")}`,
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(
          "Balance could not be refreshed. This read-only failure does not change funding or trading state.",
        ),
        icon: "⚠️",
        title: "Account Value unavailable",
      }),
    ]),
  };
}
