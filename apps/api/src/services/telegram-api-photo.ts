export type TelegramPhotoSendResult =
  | { messageId: number | null; ok: true }
  | {
      error: "blocked_or_missing" | "other";
      message: string;
      ok: false;
      retryAfterSec?: number;
    };

export async function sendTelegramPhotoRequest(input: {
  baseUrl: string;
  caption?: string;
  chatId: string;
  filename: string;
  parseMode?: "MarkdownV2";
  photo: Uint8Array;
  replyMarkup?: unknown;
}): Promise<TelegramPhotoSendResult> {
  const form = new FormData();
  form.set("chat_id", input.chatId);
  form.set(
    "photo",
    new Blob([input.photo as BlobPart], { type: "image/png" }),
    input.filename,
  );
  if (input.caption) form.set("caption", input.caption);
  if (input.parseMode) form.set("parse_mode", input.parseMode);
  if (input.replyMarkup) {
    form.set("reply_markup", JSON.stringify(input.replyMarkup));
  }
  const response = await fetch(`${input.baseUrl}/sendPhoto`, {
    body: form,
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as {
    description?: string;
    ok?: boolean;
    parameters?: { retry_after?: number };
    result?: { message_id?: number };
  } | null;
  if (response.ok && payload?.ok) {
    return {
      messageId:
        typeof payload.result?.message_id === "number"
          ? payload.result.message_id
          : null,
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
    error: "other",
    message,
    ok: false,
    retryAfterSec: payload?.parameters?.retry_after,
  };
}
