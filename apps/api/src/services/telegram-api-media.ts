import { isValidTelegramMessageId } from "./telegram-api-photo.js";

export type TelegramMediaSendFailure = {
  error: "ambiguous" | "blocked_or_missing" | "other";
  message: string;
  ok: false;
  retryAfterSec?: number;
};

export type TelegramVideoSendResult =
  | {
      fileId: string | null;
      fileUniqueId: string | null;
      messageId: number;
      ok: true;
    }
  | TelegramMediaSendFailure;

export type TelegramMediaGroupSendResult =
  | {
      fileIds: Array<string | null>;
      fileUniqueIds: Array<string | null>;
      messageIds: number[];
      ok: true;
    }
  | TelegramMediaSendFailure;

type TelegramMediaResponse = {
  description?: string;
  ok?: boolean;
  parameters?: { retry_after?: number };
  result?:
    | Array<{
        message_id?: number;
        video?: { file_id?: string; file_unique_id?: string };
      }>
    | {
        message_id?: number;
        video?: { file_id?: string; file_unique_id?: string };
      };
};

function classifyFailure(
  response: Response,
  payload: TelegramMediaResponse | null,
): TelegramMediaSendFailure {
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
    ...(typeof payload?.parameters?.retry_after === "number"
      ? { retryAfterSec: payload.parameters.retry_after }
      : {}),
  };
}

async function postMedia(input: {
  baseUrl: string;
  form: FormData;
  method: "sendMediaGroup" | "sendVideo";
  signal: AbortSignal;
}): Promise<{ payload: TelegramMediaResponse | null; response: Response }> {
  const response = await fetch(`${input.baseUrl}/${input.method}`, {
    body: input.form,
    method: "POST",
    signal: input.signal,
  });
  const payload = (await response
    .json()
    .catch(() => null)) as TelegramMediaResponse | null;
  return { payload, response };
}

export async function sendTelegramVideoRequest(input: {
  baseUrl: string;
  caption?: string;
  chatId: string;
  filename: string;
  parseMode?: "MarkdownV2";
  signal: AbortSignal;
  video: Uint8Array;
}): Promise<TelegramVideoSendResult> {
  const form = new FormData();
  form.set("chat_id", input.chatId);
  form.set(
    "video",
    new Blob([input.video as BlobPart], { type: "video/mp4" }),
    input.filename,
  );
  form.set("supports_streaming", "true");
  if (input.caption) form.set("caption", input.caption);
  if (input.parseMode) form.set("parse_mode", input.parseMode);
  const { payload, response } = await postMedia({
    baseUrl: input.baseUrl,
    form,
    method: "sendVideo",
    signal: input.signal,
  });
  const result = Array.isArray(payload?.result) ? null : payload?.result;
  const messageId = result?.message_id;
  if (response.ok && payload?.ok && isValidTelegramMessageId(messageId)) {
    return {
      fileId:
        typeof result?.video?.file_id === "string"
          ? result.video.file_id
          : null,
      fileUniqueId:
        typeof result?.video?.file_unique_id === "string"
          ? result.video.file_unique_id
          : null,
      messageId,
      ok: true,
    };
  }
  if (response.ok && payload?.ok) {
    return {
      error: "ambiguous",
      message: "invalid Telegram sendVideo success response",
      ok: false,
    };
  }
  return classifyFailure(response, payload);
}

export async function sendTelegramMediaGroupRequest(input: {
  baseUrl: string;
  caption?: string;
  chatId: string;
  parseMode?: "MarkdownV2";
  signal: AbortSignal;
  videos: Array<{ bytes: Uint8Array; filename: string }>;
}): Promise<TelegramMediaGroupSendResult> {
  if (input.videos.length < 2 || input.videos.length > 10) {
    throw new Error("Telegram media groups require between 2 and 10 videos");
  }
  const form = new FormData();
  form.set("chat_id", input.chatId);
  const media = input.videos.map((video, index) => {
    const field = `video_${index}`;
    form.set(
      field,
      new Blob([video.bytes as BlobPart], { type: "video/mp4" }),
      video.filename,
    );
    return {
      type: "video",
      media: `attach://${field}`,
      supports_streaming: true,
      ...(index === 0 && input.caption ? { caption: input.caption } : {}),
      ...(index === 0 && input.parseMode
        ? { parse_mode: input.parseMode }
        : {}),
    };
  });
  form.set("media", JSON.stringify(media));
  const { payload, response } = await postMedia({
    baseUrl: input.baseUrl,
    form,
    method: "sendMediaGroup",
    signal: input.signal,
  });
  const result = Array.isArray(payload?.result) ? payload.result : null;
  const messageIds = result
    ?.map((message) => message.message_id)
    .filter(isValidTelegramMessageId);
  const fileIds = result?.map((message) =>
    typeof message.video?.file_id === "string" ? message.video.file_id : null,
  );
  const fileUniqueIds = result?.map((message) =>
    typeof message.video?.file_unique_id === "string"
      ? message.video.file_unique_id
      : null,
  );
  if (
    response.ok &&
    payload?.ok &&
    messageIds &&
    messageIds.length === input.videos.length
  ) {
    return {
      fileIds: fileIds ?? [],
      fileUniqueIds: fileUniqueIds ?? [],
      messageIds,
      ok: true,
    };
  }
  if (response.ok && payload?.ok) {
    return {
      error: "ambiguous",
      message: "invalid Telegram sendMediaGroup success response",
      ok: false,
    };
  }
  return classifyFailure(response, payload);
}
