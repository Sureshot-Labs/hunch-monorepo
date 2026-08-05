import type {
  SignalBotTelegramClient,
  TelegramSendMessageInput,
  TelegramSendResult,
} from "./signal-bot-contracts.js";
import type { TelegramInputRichMessage } from "./telegram-rich-message.js";

export type TelegramDeliverySendResult =
  | {
      fallbackToMarkdown: boolean;
      fallbackStandalone: boolean;
      messageId: number | null;
      ok: true;
      replyToMessageId: number | null;
    }
  | Extract<TelegramSendResult, { ok: false }>;

export async function sendTelegramMessageWithReplyFallback(input: {
  beforeStandaloneFallback?: () => Promise<boolean>;
  message: TelegramSendMessageInput;
  replyToMessageId: number | null;
  richMessage?: TelegramInputRichMessage;
  telegram: Pick<SignalBotTelegramClient, "sendMessage" | "sendRichMessage">;
}): Promise<TelegramDeliverySendResult> {
  const send = async (
    replyToMessageId: number | null,
  ): Promise<{
    fallbackToMarkdown: boolean;
    result: TelegramSendResult;
  }> => {
    const replyParameters =
      replyToMessageId == null ? undefined : { message_id: replyToMessageId };
    if (input.richMessage && input.telegram.sendRichMessage) {
      const richResult = await input.telegram.sendRichMessage({
        chat_id: input.message.chat_id,
        reply_markup: input.message.reply_markup,
        reply_parameters: replyParameters,
        rich_message: input.richMessage,
      });
      if (
        richResult.ok ||
        richResult.error === "ambiguous" ||
        richResult.error === "blocked_or_missing" ||
        richResult.error === "reply_target_missing" ||
        richResult.retryAfterSec != null
      ) {
        return { fallbackToMarkdown: false, result: richResult };
      }
    }
    return {
      fallbackToMarkdown: Boolean(
        input.richMessage && input.telegram.sendRichMessage,
      ),
      result: await input.telegram.sendMessage({
        ...input.message,
        reply_parameters: replyParameters,
      }),
    };
  };

  const first = await send(input.replyToMessageId);
  if (first.result.ok) {
    return {
      fallbackToMarkdown: first.fallbackToMarkdown,
      fallbackStandalone: false,
      messageId: first.result.messageId,
      ok: true,
      replyToMessageId: input.replyToMessageId,
    };
  }
  if (first.result.error !== "reply_target_missing") return first.result;
  if (input.replyToMessageId == null) return first.result;
  if (
    input.beforeStandaloneFallback &&
    !(await input.beforeStandaloneFallback())
  ) {
    return {
      error: "other",
      message: "reply_fallback_state_conflict",
      ok: false,
    };
  }

  const standalone = await send(null);
  return standalone.result.ok
    ? {
        fallbackToMarkdown: standalone.fallbackToMarkdown,
        fallbackStandalone: true,
        messageId: standalone.result.messageId,
        ok: true,
        replyToMessageId: null,
      }
    : standalone.result;
}
