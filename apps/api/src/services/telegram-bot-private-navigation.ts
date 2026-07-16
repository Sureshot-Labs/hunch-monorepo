import type {
  TelegramBotTradingClientButton,
  TelegramBotTradingClientMessage,
} from "./telegram-bot-trading-client.js";

const MENU_PREFIX = "hm:v1:";

function hasCallback(
  rows: TelegramBotTradingClientButton[][],
  callbackData: string,
): boolean {
  return rows.some((row) =>
    row.some(
      (button) =>
        "callback_data" in button && button.callback_data === callbackData,
    ),
  );
}

export function withTelegramPrivateNavigation<
  T extends TelegramBotTradingClientMessage,
>(
  message: T,
  options: { positions?: boolean } = {},
): T & {
  reply_markup: { inline_keyboard: TelegramBotTradingClientButton[][] };
} {
  const rows = [...(message.reply_markup?.inline_keyboard ?? [])];
  const navigation: TelegramBotTradingClientButton[] = [];
  if (options.positions && !hasCallback(rows, `${MENU_PREFIX}positions`)) {
    navigation.push({
      callback_data: `${MENU_PREFIX}positions`,
      text: "💼 My positions",
    });
  }
  if (!hasCallback(rows, `${MENU_PREFIX}home`)) {
    navigation.push({
      callback_data: `${MENU_PREFIX}home`,
      text: "🏠 Home",
    });
  }
  return {
    ...message,
    reply_markup: {
      inline_keyboard: [
        ...rows,
        ...(navigation.length > 0 ? [navigation] : []),
      ],
    },
  };
}
