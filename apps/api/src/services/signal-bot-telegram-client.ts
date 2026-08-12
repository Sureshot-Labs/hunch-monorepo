import {
  stripTelegramCustomEmojiButtonIcons,
  stripTelegramCustomEmojiMarkdownV2,
} from "./telegram-custom-emoji.js";
import {
  isValidTelegramMessageId,
  sendTelegramPhotoRequest,
} from "./telegram-api-photo.js";

import type {
  SignalBotTelegramClient,
  TelegramBotCommandDefinition,
  TelegramBotCommandScope,
  TelegramBotMenuButton,
  TelegramBotUpdate,
  TelegramBotUser,
  TelegramInlineKeyboard,
  TelegramMutationResult,
  TelegramSendMessageInput,
  TelegramSendResult,
  TelegramSendRichMessageInput,
} from "./signal-bot.js";

export const TELEGRAM_MUTATION_TIMEOUT_MS = 20_000;

function telegramMutationSignal(): AbortSignal {
  return AbortSignal.timeout(TELEGRAM_MUTATION_TIMEOUT_MS);
}

export function classifyTelegramEditFailure(input: {
  description?: string;
  messageId: number;
  responseOk: boolean;
  retryAfterSec?: number;
  status: number;
}): TelegramSendResult {
  const message = input.description ?? `HTTP ${input.status}`;
  if (/message is not modified/i.test(message)) {
    return { messageId: input.messageId, ok: true };
  }
  if (
    input.status === 403 ||
    /chat not found|bot was blocked|user is deactivated/i.test(message)
  ) {
    return { error: "blocked_or_missing", message, ok: false };
  }
  if (
    /message to edit not found|message can(?:not|'t) be edited|message_id_invalid/i.test(
      message,
    )
  ) {
    return { error: "message_not_editable", message, ok: false };
  }
  return {
    error: input.responseOk || input.status >= 500 ? "ambiguous" : "other",
    message,
    ok: false,
    ...(typeof input.retryAfterSec === "number" && input.retryAfterSec > 0
      ? { retryAfterSec: Math.trunc(input.retryAfterSec) }
      : {}),
  };
}

function telegramTransportFailure(error: unknown): TelegramSendResult {
  return {
    error: "ambiguous",
    message:
      error instanceof Error ? error.message : "telegram_transport_error",
    ok: false,
  };
}

function isTelegramReplyTargetMissing(message: string): boolean {
  return /reply message not found|message to (?:be )?repl(?:y|ied) (?:to )?not found|reply_to_message_id_invalid/i.test(
    message,
  );
}

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

export class TelegramBotApiClient implements SignalBotTelegramClient {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async callBooleanMethod(
    method: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const signal = telegramMutationSignal();
    const response = await fetch(this.baseUrl + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
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
  }): Promise<TelegramMutationResult> {
    const signal = telegramMutationSignal();
    let response: Response;
    let payload: {
      description?: string;
      ok?: boolean;
      parameters?: { retry_after?: number };
    } | null;
    try {
      response = await fetch(`${this.baseUrl}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: input.callbackQueryId,
          show_alert: input.showAlert ?? false,
          text: input.text,
        }),
        signal,
      });
      payload = (await response.json().catch(() => null)) as typeof payload;
    } catch (error) {
      return telegramTransportFailure(error);
    }
    if (response.ok && payload?.ok) return { ok: true };
    const message = payload?.description ?? `HTTP ${response.status}`;
    if (
      response.status === 403 ||
      /chat not found|bot was blocked|user is deactivated/i.test(message)
    ) {
      return { error: "blocked_or_missing", message, ok: false };
    }
    const retryAfterSec = payload?.parameters?.retry_after;
    return {
      error: response.ok || response.status >= 500 ? "ambiguous" : "other",
      message,
      ok: false,
      ...(typeof retryAfterSec === "number" && retryAfterSec > 0
        ? { retryAfterSec: Math.trunc(retryAfterSec) }
        : {}),
    };
  }

  async editMessageText(input: {
    chat_id: string;
    disable_web_page_preview: boolean;
    message_id: number;
    parse_mode: "MarkdownV2";
    reply_markup?: TelegramInlineKeyboard;
    text: string;
  }): Promise<TelegramSendResult> {
    const signal = telegramMutationSignal();
    const request = async (body: typeof input) => {
      const response = await fetch(`${this.baseUrl}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
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
    let payload: Awaited<ReturnType<typeof request>>["payload"];
    let response: Awaited<ReturnType<typeof request>>["response"];
    try {
      ({ payload, response } = await request(requestInput));
    } catch (error) {
      return telegramTransportFailure(error);
    }
    if (
      isTelegramCustomEmojiRejection(response.status, payload?.description) &&
      telegramPayloadHasCustomEmoji(requestInput)
    ) {
      requestInput = stripTelegramCustomEmojiFromPayload(requestInput);
      try {
        ({ payload, response } = await request(requestInput));
      } catch (error) {
        return telegramTransportFailure(error);
      }
    }
    if (response.ok && payload?.ok) {
      const messageId = payload.result?.message_id;
      return {
        messageId: typeof messageId === "number" ? messageId : input.message_id,
        ok: true,
      };
    }
    return classifyTelegramEditFailure({
      description: payload?.description,
      messageId: input.message_id,
      responseOk: response.ok,
      retryAfterSec: payload?.parameters?.retry_after,
      status: response.status,
    });
  }

  async sendPhoto(input: {
    caption?: string;
    chat_id: string;
    filename: string;
    parse_mode?: "MarkdownV2";
    photo: Uint8Array;
    reply_markup?: TelegramInlineKeyboard;
  }): Promise<TelegramSendResult> {
    const signal = telegramMutationSignal();
    try {
      return await sendTelegramPhotoRequest({
        baseUrl: this.baseUrl,
        caption: input.caption,
        chatId: input.chat_id,
        filename: input.filename,
        parseMode: input.parse_mode,
        photo: input.photo,
        replyMarkup: input.reply_markup,
        signal,
      });
    } catch (error) {
      return telegramTransportFailure(error);
    }
  }

  async deleteMessage(input: {
    chat_id: string;
    message_id: number;
  }): Promise<TelegramSendResult> {
    const signal = telegramMutationSignal();
    try {
      const response = await fetch(`${this.baseUrl}/deleteMessage`, {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal,
      });
      const payload = (await response.json().catch(() => null)) as {
        description?: string;
        ok?: boolean;
        parameters?: { retry_after?: number };
        result?: boolean;
      } | null;
      if (response.ok && payload?.ok && payload.result === true) {
        return { messageId: input.message_id, ok: true };
      }
      const message = payload?.description ?? `HTTP ${response.status}`;
      if (/message to delete not found|message not found/i.test(message)) {
        return { messageId: input.message_id, ok: true };
      }
      if (
        response.status === 403 ||
        /chat not found|bot was blocked|user is deactivated/i.test(message)
      ) {
        return { error: "blocked_or_missing", message, ok: false };
      }
      return {
        error: response.ok || response.status >= 500 ? "ambiguous" : "other",
        message,
        ok: false,
        ...(payload?.parameters?.retry_after
          ? { retryAfterSec: payload.parameters.retry_after }
          : {}),
      };
    } catch (error) {
      return telegramTransportFailure(error);
    }
  }

  async sendRichMessage(
    input: TelegramSendRichMessageInput,
  ): Promise<TelegramSendResult> {
    const signal = telegramMutationSignal();
    const request = async (body: TelegramSendRichMessageInput) => {
      const response = await fetch(`${this.baseUrl}/sendRichMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
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
    let payload: Awaited<ReturnType<typeof request>>["payload"];
    let response: Awaited<ReturnType<typeof request>>["response"];
    try {
      ({ payload, response } = await request(requestInput));
    } catch (error) {
      return telegramTransportFailure(error);
    }
    const hasButtonCustomEmoji =
      requestInput.reply_markup?.inline_keyboard.some((row) =>
        row.some((button) => Boolean(button.icon_custom_emoji_id)),
      ) === true;
    if (
      isTelegramCustomEmojiRejection(response.status, payload?.description) &&
      hasButtonCustomEmoji &&
      requestInput.reply_markup
    ) {
      requestInput = {
        ...requestInput,
        reply_markup: stripTelegramCustomEmojiButtonIcons(
          requestInput.reply_markup,
        ),
      };
      try {
        ({ payload, response } = await request(requestInput));
      } catch (error) {
        return telegramTransportFailure(error);
      }
    }
    if (response.ok && payload?.ok) {
      const messageId = payload.result?.message_id;
      if (!isValidTelegramMessageId(messageId)) {
        return {
          error: "ambiguous",
          message: "invalid telegram success response",
          ok: false,
        };
      }
      return {
        messageId,
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
    if (input.reply_parameters && isTelegramReplyTargetMissing(message)) {
      return { error: "reply_target_missing", message, ok: false };
    }
    const retryAfterSec = payload?.parameters?.retry_after;
    return {
      error: response.ok || response.status >= 500 ? "ambiguous" : "other",
      message,
      ok: false,
      ...(typeof retryAfterSec === "number" ? { retryAfterSec } : {}),
    };
  }

  async sendMessage(
    input: TelegramSendMessageInput,
  ): Promise<TelegramSendResult> {
    const signal = telegramMutationSignal();
    const request = async (body: TelegramSendMessageInput) => {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
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
    let payload: Awaited<ReturnType<typeof request>>["payload"];
    let response: Awaited<ReturnType<typeof request>>["response"];
    try {
      ({ payload, response } = await request(requestInput));
    } catch (error) {
      return telegramTransportFailure(error);
    }
    if (
      isTelegramCustomEmojiRejection(response.status, payload?.description) &&
      telegramPayloadHasCustomEmoji(requestInput)
    ) {
      requestInput = stripTelegramCustomEmojiFromPayload(requestInput);
      try {
        ({ payload, response } = await request(requestInput));
      } catch (error) {
        return telegramTransportFailure(error);
      }
    }
    if (response.ok && payload?.ok) {
      const messageId = payload.result?.message_id;
      if (!isValidTelegramMessageId(messageId)) {
        return {
          error: "ambiguous",
          message: "invalid telegram success response",
          ok: false,
        };
      }
      return {
        messageId,
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
    if (input.reply_parameters && isTelegramReplyTargetMissing(message)) {
      return { error: "reply_target_missing", message, ok: false };
    }
    const retryAfterSec = payload?.parameters?.retry_after;
    return {
      error: response.ok || response.status >= 500 ? "ambiguous" : "other",
      message,
      ok: false,
      retryAfterSec:
        typeof retryAfterSec === "number" && retryAfterSec > 0
          ? Math.trunc(retryAfterSec)
          : undefined,
    };
  }
}
