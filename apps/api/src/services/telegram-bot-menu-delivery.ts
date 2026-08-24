import type {
  SignalBotTelegramClient,
  TelegramInlineKeyboard,
  TelegramSendResult,
} from "./signal-bot-contracts.js";
import {
  isSignalBotMenuRenderCurrent,
  withSignalBotMenuRenderLock,
  type SignalBotMenuStateRedis,
} from "./telegram-bot-menu-state.js";

export type TelegramBotMenuMessage = {
  fundingContextId?: string;
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: TelegramInlineKeyboard;
  text: string;
};

export type TelegramBotMenuTransport = {
  editMessageText?: SignalBotTelegramClient["editMessageText"];
  sendMessage: SignalBotTelegramClient["sendMessage"];
};

export type TelegramBotMenuDeliveryOutcome =
  | "success"
  | "ambiguous"
  | "rate_limited"
  | "blocked"
  | "message_not_editable"
  | "render_superseded"
  | "render_unavailable"
  | "other";

const HOME_CALLBACK_DATA = "hm:v1:home";

/**
 * Every private interactive card needs one deterministic escape route.  This
 * runs at the last menu-delivery boundary, so refresh/edit paths cannot drop
 * Home or append it twice.
 */
function withTelegramBotMenuHome(
  message: TelegramBotMenuMessage,
): TelegramBotMenuMessage {
  const rows = message.reply_markup?.inline_keyboard ?? [];
  const hasHome = rows.some((row) =>
    row.some(
      (button) =>
        "callback_data" in button &&
        button.callback_data === HOME_CALLBACK_DATA,
    ),
  );
  if (hasHome) return message;
  return {
    ...message,
    reply_markup: {
      inline_keyboard: [
        ...rows,
        [{ callback_data: HOME_CALLBACK_DATA, text: "🏠 Home" }],
      ],
    },
  };
}

export function classifyTelegramBotMenuDeliveryResult(
  result: TelegramSendResult,
): Readonly<{
  outcome: TelegramBotMenuDeliveryOutcome;
  retryAfterSec?: number;
}> {
  // Telegram returns HTTP 400 when an edit already matches the visible card.
  // That is successful delivery, not a reason to tear down the Redis state
  // owned by the unchanged prompt. The production transport normally
  // normalises this first; keeping the rule at this shared boundary also
  // protects injected transports and future callers.
  if (result.ok || /message is not modified/i.test(result.message)) {
    return { outcome: "success" };
  }
  if (result.retryAfterSec != null) {
    return { outcome: "rate_limited", retryAfterSec: result.retryAfterSec };
  }
  if (
    result.message === "superseded" ||
    result.message === "menu_render_superseded"
  ) {
    return { outcome: "render_superseded" };
  }
  if (result.message === "menu_render_unavailable") {
    return { outcome: "render_unavailable" };
  }
  if (result.error === "ambiguous") return { outcome: "ambiguous" };
  if (result.error === "blocked_or_missing") return { outcome: "blocked" };
  if (result.error === "message_not_editable") {
    return { outcome: "message_not_editable" };
  }
  return { outcome: "other" };
}

export function isTelegramBotMenuRenderSuppressed(
  result: TelegramSendResult,
): boolean {
  return (
    !result.ok &&
    result.error === "other" &&
    /^menu_render_(?:superseded|unavailable)$/u.test(result.message)
  );
}

export function createTelegramBotCallbackMenuTransport(input: {
  chatId: string;
  messageId: number;
  redis: Pick<SignalBotMenuStateRedis, "eval" | "get" | "set">;
  renderToken: string;
  transport: TelegramBotMenuTransport;
}): TelegramBotMenuTransport {
  const editMessageText = input.transport.editMessageText;
  const deliver = async (
    operation: () => Promise<TelegramSendResult>,
  ): Promise<TelegramSendResult> => {
    const result = await withSignalBotMenuRenderLock({
      chatId: input.chatId,
      messageId: input.messageId,
      redis: input.redis,
      isCurrent: () =>
        isSignalBotMenuRenderCurrent({
          chatId: input.chatId,
          messageId: input.messageId,
          redis: input.redis,
          renderToken: input.renderToken,
        }),
      deliver: operation,
    });
    if (result.status === "completed") return result.value;
    return {
      error: "other",
      message: `menu_render_${result.status}`,
      ok: false,
    };
  };
  return {
    ...(editMessageText
      ? {
          editMessageText: (message) =>
            deliver(() => editMessageText.call(input.transport, message)),
        }
      : {}),
    sendMessage: (message) =>
      deliver(() => input.transport.sendMessage(message)),
  };
}

export async function sendOrEditTelegramBotMenuMessage(input: {
  chatId: string;
  message: TelegramBotMenuMessage;
  messageId?: number | null;
  shouldDeliver?: () => Promise<boolean>;
  transport: TelegramBotMenuTransport;
}): Promise<TelegramSendResult> {
  const message = withTelegramBotMenuHome(input.message);
  const superseded = (): TelegramSendResult => ({
    error: "other",
    message: "superseded",
    ok: false,
  });
  if (input.shouldDeliver && !(await input.shouldDeliver())) {
    return superseded();
  }
  if (input.messageId != null && input.transport.editMessageText) {
    const edited = await input.transport.editMessageText({
      chat_id: input.chatId,
      disable_web_page_preview: true,
      message_id: input.messageId,
      parse_mode: message.parse_mode ?? "MarkdownV2",
      reply_markup: message.reply_markup,
      text: message.text,
    });
    if (edited.ok || /message is not modified/i.test(edited.message)) {
      return edited;
    }
    if (isTelegramBotMenuRenderSuppressed(edited)) return edited;
    // Funding callbacks are valid only in the message that owns the context.
    // Sending the same keyboard as a new message would create a dead card.
    if (
      edited.error !== "message_not_editable" ||
      typeof message.fundingContextId === "string"
    ) {
      return edited;
    }
  }
  if (input.shouldDeliver && !(await input.shouldDeliver())) {
    return superseded();
  }
  return input.transport.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: true,
    parse_mode: message.parse_mode ?? "MarkdownV2",
    reply_markup: message.reply_markup,
    text: message.text,
  });
}
