import {
  stripTelegramCustomEmojiButtonIcons,
  stripTelegramCustomEmojiMarkdownV2,
} from "./telegram-custom-emoji.js";

export type TelegramPhotoSendResult =
  | { messageId: number | null; ok: true }
  | {
      error: "ambiguous" | "blocked_or_missing" | "other";
      message: string;
      ok: false;
      retryAfterSec?: number;
    };

export function isValidTelegramMessageId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

export async function sendTelegramPhotoRequest(input: {
  baseUrl: string;
  caption?: string;
  chatId: string;
  filename: string;
  parseMode?: "MarkdownV2";
  photo: Uint8Array;
  replyMarkup?: unknown;
  signal: AbortSignal;
}): Promise<TelegramPhotoSendResult> {
  const request = async (requestInput: {
    caption?: string;
    replyMarkup?: unknown;
  }) => {
    const form = new FormData();
    form.set("chat_id", input.chatId);
    form.set(
      "photo",
      new Blob([input.photo as BlobPart], { type: "image/png" }),
      input.filename,
    );
    if (requestInput.caption) form.set("caption", requestInput.caption);
    if (input.parseMode) form.set("parse_mode", input.parseMode);
    if (requestInput.replyMarkup) {
      form.set("reply_markup", JSON.stringify(requestInput.replyMarkup));
    }
    const response = await fetch(`${input.baseUrl}/sendPhoto`, {
      body: form,
      method: "POST",
      signal: input.signal,
    });
    const payload = (await response.json().catch(() => null)) as {
      description?: string;
      ok?: boolean;
      parameters?: { retry_after?: number };
      result?: { message_id?: number };
    } | null;
    return { payload, response };
  };
  const hasCustomEmoji =
    (input.caption != null &&
      stripTelegramCustomEmojiMarkdownV2(input.caption) !== input.caption) ||
    JSON.stringify(input.replyMarkup ?? {}).includes('"icon_custom_emoji_id"');
  let { payload, response } = await request({
    caption: input.caption,
    replyMarkup: input.replyMarkup,
  });
  if (
    response.status === 400 &&
    /custom[ _-]?emoji|button_type_invalid/i.test(payload?.description ?? "") &&
    hasCustomEmoji
  ) {
    ({ payload, response } = await request({
      caption: input.caption
        ? stripTelegramCustomEmojiMarkdownV2(input.caption)
        : undefined,
      replyMarkup: input.replyMarkup
        ? stripTelegramCustomEmojiButtonIcons(input.replyMarkup)
        : undefined,
    }));
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
  return {
    error: response.ok || response.status >= 500 ? "ambiguous" : "other",
    message,
    ok: false,
    retryAfterSec: payload?.parameters?.retry_after,
  };
}
