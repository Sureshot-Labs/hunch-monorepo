import {
  stripTelegramCustomEmojiButtonIcons,
  stripTelegramCustomEmojiMarkdownV2,
} from "./telegram-custom-emoji.js";
import { sendTelegramPhotoRequest } from "./telegram-api-photo.js";
import {
  stripTelegramCustomEmojiRichMessage,
  telegramRichMessageHasCustomEmoji,
} from "./telegram-rich-message.js";

import type {
  SignalBotTelegramClient,
  TelegramBotCommandDefinition,
  TelegramBotCommandScope,
  TelegramBotMenuButton,
  TelegramBotUpdate,
  TelegramBotUser,
  TelegramEditMessageInput,
  TelegramInlineKeyboard,
  TelegramSendMessageInput,
  TelegramSendResult,
  TelegramSendRichMessageInput,
} from "./signal-bot.js";

function telegramPayloadHasCustomEmoji(input: {
  reply_markup?: TelegramInlineKeyboard;
  text: string;
}): boolean {
  return (
    stripTelegramCustomEmojiMarkdownV2(input.text) !== input.text ||
    input.reply_markup?.inline_keyboard.some((row) =>
      row.some((button) => Boolean(button.icon_custom_emoji_id)),
    ) === true
  );
}

function isTelegramCustomEmojiRejection(
  status: number,
  description: string | null | undefined,
): boolean {
  return (
    status === 400 &&
    /custom[ _-]?emoji|button_type_invalid/i.test(description ?? "")
  );
}

function stripTelegramCustomEmojiFromPayload<
  T extends { reply_markup?: TelegramInlineKeyboard; text: string },
>(input: T): T {
  return {
    ...input,
    ...(input.reply_markup
      ? {
          reply_markup: stripTelegramCustomEmojiButtonIcons(input.reply_markup),
        }
      : {}),
    text: stripTelegramCustomEmojiMarkdownV2(input.text),
  };
}

function telegramRichPayloadHasCustomEmoji(input: {
  reply_markup?: TelegramInlineKeyboard;
  rich_message: TelegramSendRichMessageInput["rich_message"];
}): boolean {
  return (
    telegramRichMessageHasCustomEmoji(input.rich_message) ||
    input.reply_markup?.inline_keyboard.some((row) =>
      row.some((button) => Boolean(button.icon_custom_emoji_id)),
    ) === true
  );
}

function stripTelegramCustomEmojiFromRichPayload<
  T extends {
    reply_markup?: TelegramInlineKeyboard;
    rich_message: TelegramSendRichMessageInput["rich_message"];
  },
>(input: T): T {
  return {
    ...input,
    ...(input.reply_markup
      ? {
          reply_markup: stripTelegramCustomEmojiButtonIcons(input.reply_markup),
        }
      : {}),
    rich_message: stripTelegramCustomEmojiRichMessage(input.rich_message),
  };
}

export class TelegramBotApiClient implements SignalBotTelegramClient {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async callBooleanMethod(
    method: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(this.baseUrl + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as {
      description?: string;
      ok?: boolean;
      result?: boolean;
    } | null;
    if (!response.ok || !payload?.ok || payload.result !== true) {
      throw new Error(
        "Telegram " +
          method +
          " failed: " +
          response.status +
          " " +
          (payload?.description ?? ""),
      );
    }
  }

  async setMyCommands(input: {
    commands: TelegramBotCommandDefinition[];
    scope?: TelegramBotCommandScope;
  }): Promise<void> {
    await this.callBooleanMethod("setMyCommands", input);
  }

  async getMyCommands(
    input: {
      scope?: TelegramBotCommandScope;
    } = {},
  ): Promise<TelegramBotCommandDefinition[]> {
    const response = await fetch(this.baseUrl + "/getMyCommands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => null)) as {
      description?: string;
      ok?: boolean;
      result?: TelegramBotCommandDefinition[];
    } | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.result)) {
      throw new Error(
        "Telegram getMyCommands failed: " +
          response.status +
          " " +
          (payload?.description ?? ""),
      );
    }
    return payload.result;
  }

  async setChatMenuButton(input: {
    chat_id?: number | string;
    menu_button: TelegramBotMenuButton;
  }): Promise<void> {
    await this.callBooleanMethod("setChatMenuButton", input);
  }

  async getMe(): Promise<TelegramBotUser> {
    const response = await fetch(`${this.baseUrl}/getMe`);
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: TelegramBotUser;
      description?: string;
    } | null;
    if (!response.ok || !payload?.ok || !payload.result) {
      throw new Error(
        `Telegram getMe failed: ${response.status} ${payload?.description ?? ""}`.trim(),
      );
    }
    return payload.result;
  }

  async getUpdates(input: {
    offset: number | null;
    timeoutSec: number;
  }): Promise<TelegramBotUpdate[]> {
    const url = new URL(`${this.baseUrl}/getUpdates`);
    url.searchParams.set("timeout", String(input.timeoutSec));
    url.searchParams.set(
      "allowed_updates",
      JSON.stringify(["message", "callback_query"]),
    );
    if (input.offset != null)
      url.searchParams.set("offset", String(input.offset));
    const response = await fetch(url);
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: TelegramBotUpdate[];
      description?: string;
    } | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.result)) {
      throw new Error(
        `Telegram getUpdates failed: ${response.status} ${payload?.description ?? ""}`.trim(),
      );
    }
    return payload.result;
  }

  async answerCallbackQuery(input: {
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: input.callbackQueryId,
        show_alert: input.showAlert ?? false,
        text: input.text,
      }),
    });
    return response.json().catch(() => null);
  }

  async editMessageText(
    input: TelegramEditMessageInput,
  ): Promise<TelegramSendResult> {
    const request = async (body: TelegramEditMessageInput) => {
      const response = await fetch(`${this.baseUrl}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as {
        description?: string;
        ok?: boolean;
        result?: { message_id?: number };
      } | null;
      return { payload, response };
    };
    let requestInput = input;
    let { payload, response } = await request(requestInput);
    if (
      isTelegramCustomEmojiRejection(response.status, payload?.description) &&
      ("rich_message" in requestInput && requestInput.rich_message
        ? telegramRichPayloadHasCustomEmoji({
            reply_markup: requestInput.reply_markup,
            rich_message: requestInput.rich_message,
          })
        : "text" in requestInput && typeof requestInput.text === "string"
          ? telegramPayloadHasCustomEmoji({
              reply_markup: requestInput.reply_markup,
              text: requestInput.text,
            })
          : false)
    ) {
      requestInput =
        "rich_message" in requestInput && requestInput.rich_message
          ? stripTelegramCustomEmojiFromRichPayload(requestInput)
          : stripTelegramCustomEmojiFromPayload(
              requestInput as Extract<
                TelegramEditMessageInput,
                { text: string }
              >,
            );
      ({ payload, response } = await request(requestInput));
    }
    if (response.ok && payload?.ok) {
      const messageId = payload.result?.message_id;
      return {
        messageId: typeof messageId === "number" ? messageId : input.message_id,
        ok: true,
      };
    }
    return {
      error: "other",
      message: payload?.description ?? `HTTP ${response.status}`,
      ok: false,
    };
  }

  async sendPhoto(input: {
    caption?: string;
    chat_id: string;
    filename: string;
    parse_mode?: "MarkdownV2";
    photo: Uint8Array;
    reply_markup?: TelegramInlineKeyboard;
  }): Promise<TelegramSendResult> {
    return sendTelegramPhotoRequest({
      baseUrl: this.baseUrl,
      caption: input.caption,
      chatId: input.chat_id,
      filename: input.filename,
      parseMode: input.parse_mode,
      photo: input.photo,
      replyMarkup: input.reply_markup,
    });
  }

  async sendRichMessage(
    input: TelegramSendRichMessageInput,
  ): Promise<TelegramSendResult> {
    const request = async (body: TelegramSendRichMessageInput) => {
      const response = await fetch(`${this.baseUrl}/sendRichMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as {
        description?: string;
        ok?: boolean;
        parameters?: { retry_after?: number };
        result?: { message_id?: number };
      } | null;
      return { payload, response };
    };
    let requestInput = input;
    let { payload, response } = await request(requestInput);
    if (
      isTelegramCustomEmojiRejection(response.status, payload?.description) &&
      telegramRichPayloadHasCustomEmoji(requestInput)
    ) {
      requestInput = stripTelegramCustomEmojiFromRichPayload(requestInput);
      ({ payload, response } = await request(requestInput));
    }
    if (response.ok && payload?.ok) {
      const messageId = payload.result?.message_id;
      return {
        messageId: typeof messageId === "number" ? messageId : null,
        ok: true,
      };
    }
    const message = payload?.description ?? `HTTP ${response.status}`;
    if (
      response.status === 403 ||
      /chat not found|bot was blocked|user is deactivated/i.test(message)
    ) {
      return { error: "blocked_or_missing", message, ok: false };
    }
    const retryAfterSec = payload?.parameters?.retry_after;
    return {
      error: "other",
      message,
      ok: false,
      ...(typeof retryAfterSec === "number" ? { retryAfterSec } : {}),
    };
  }

  async sendMessage(
    input: TelegramSendMessageInput,
  ): Promise<TelegramSendResult> {
    const request = async (body: TelegramSendMessageInput) => {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as {
        description?: string;
        ok?: boolean;
        parameters?: { retry_after?: number };
        result?: { message_id?: number };
      } | null;
      return { payload, response };
    };
    let requestInput = input;
    let { payload, response } = await request(requestInput);
    if (
      isTelegramCustomEmojiRejection(response.status, payload?.description) &&
      telegramPayloadHasCustomEmoji(requestInput)
    ) {
      requestInput = stripTelegramCustomEmojiFromPayload(requestInput);
      ({ payload, response } = await request(requestInput));
    }
    if (response.ok && payload?.ok) {
      const messageId = payload.result?.message_id;
      return {
        messageId: typeof messageId === "number" ? messageId : null,
        ok: true,
      };
    }
    const message = payload?.description ?? `HTTP ${response.status}`;
    if (
      response.status === 403 ||
      /chat not found|bot was blocked|user is deactivated/i.test(message)
    ) {
      return { error: "blocked_or_missing", message, ok: false };
    }
    const retryAfterSec = payload?.parameters?.retry_after;
    return {
      error: "other",
      message,
      ok: false,
      retryAfterSec:
        typeof retryAfterSec === "number" && retryAfterSec > 0
          ? Math.trunc(retryAfterSec)
          : undefined,
    };
  }
}
