import { buildTelegramTradeProgressMessage } from "./telegram-bot-trading-presentation.js";
import { withTelegramPrivateNavigation } from "./telegram-bot-private-navigation.js";

export type TelegramBotTradingClientButton =
  | { text: string; callback_data: string }
  | { text: string; copy_text: { text: string } }
  | { text: string; web_app: { url: string } }
  | { text: string; url: string };

export type TelegramBotTradingClientReplyMarkup = {
  inline_keyboard: TelegramBotTradingClientButton[][];
};

export type TelegramBotTradingClientMessage = {
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: TelegramBotTradingClientReplyMarkup;
  text: string;
};

export type TelegramBotTradingClientCallbackInput = {
  answerCallbackQuery: (input: {
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }) => Promise<unknown>;
  appBaseUrl: string;
  editMessageText?: (input: {
    chat_id: string;
    message_id: number;
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramBotTradingClientReplyMarkup;
    text: string;
  }) => Promise<unknown>;
  callbackQuery: {
    data?: string;
    from?: { id?: number };
    id: string;
    message?: {
      chat?: { id: string | number; type?: string };
      message_id?: number;
    };
  };
  telegramMiniAppEnabled?: boolean;
  sendMessage: (input: {
    chat_id: string;
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramBotTradingClientReplyMarkup;
    text: string;
  }) => Promise<unknown>;
};

export type TelegramBotTradingInternalApiClient = {
  buildMarketMessage: (input: {
    appBaseUrl: string;
    chatId: string | number;
    context?: {
      focusPositionId?: string;
      focusPositionWalletAddress?: string | null;
      focusSide?: "YES" | "NO";
      origin: "direct" | "position" | "search";
      positionLines?: string[];
      positionRedemptionStatus?: string | null;
      returnCallbackData?: string;
    };
    isAdminTest?: boolean;
    marketRef: string;
    publicBrowseOnly?: boolean;
    telegramMessageId?: number | null;
    telegramMiniAppEnabled?: boolean;
    telegramUserId: string | number;
  }) => Promise<TelegramBotTradingClientMessage>;
  buildStatusMessage: (
    telegramUserId: string | number,
  ) => Promise<TelegramBotTradingClientMessage>;
  buildPositionsMessage: (input: {
    appBaseUrl: string;
    telegramMiniAppEnabled?: boolean;
    telegramUserId: string | number;
  }) => Promise<TelegramBotTradingClientMessage>;
  buildPositionMessage: (input: {
    appBaseUrl: string;
    positionId: string;
    telegramMiniAppEnabled?: boolean;
    telegramUserId: string | number;
  }) => Promise<TelegramBotTradingClientMessage>;
  buildDepositMessage: (input: {
    appBaseUrl: string;
    telegramMiniAppEnabled?: boolean;
    telegramUserId: string | number;
    venue?: string | null;
  }) => Promise<
    TelegramBotTradingClientMessage & {
      depositAddress?: string;
      qrText?: string;
      venue?: string;
    }
  >;
  searchMarkets: (input: { query?: string | null }) => Promise<
    Array<{
      eventId: string;
      eventTitle: string | null;
      lastPrice: number | null;
      marketId: string;
      marketTitle: string;
      noAsk: number | null;
      venue: string;
      yesAsk: number | null;
    }>
  >;
  disableTrading: (
    telegramUserId: string | number,
  ) => Promise<"already_disabled" | "disabled" | "unavailable">;
  handleCallback: (
    input: TelegramBotTradingClientCallbackInput,
  ) => Promise<boolean>;
};

type CapturedTelegramBotTradingCallbackResult = {
  answers: Array<{
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }>;
  handled: boolean;
  messages: Array<{
    chat_id: string;
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramBotTradingClientReplyMarkup;
    text: string;
  }>;
};

export const TELEGRAM_BOT_TRADING_CALLBACK_PREFIX = "hbt";
const DEFAULT_INTERNAL_API_TIMEOUT_MS = 10_000;
const TELEGRAM_MARKET_SEARCH_TIMEOUT_MS = 12_000;
const TELEGRAM_TRENDING_MARKETS_TIMEOUT_MS = 2_000;
const DEFAULT_INTERNAL_API_EXECUTE_TIMEOUT_MS = 120_000;

const EXACT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseTelegramBotTradingCallbackData(data: string | undefined): {
  intentId: string;
  type: "buy" | "sell" | "redeem" | "retry_buy" | "cancel" | "confirm";
} | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, type, intentId] = parts;
  if (prefix !== TELEGRAM_BOT_TRADING_CALLBACK_PREFIX) return null;
  if (
    type !== "buy" &&
    type !== "sell" &&
    type !== "redeem" &&
    type !== "retry_buy" &&
    type !== "confirm" &&
    type !== "cancel"
  )
    return null;
  if (!EXACT_UUID_RE.test(intentId ?? "")) return null;
  return { type, intentId };
}

function isTelegramBotTradingCallbackData(data: string | undefined): boolean {
  if (!data) return false;
  return (
    data === TELEGRAM_BOT_TRADING_CALLBACK_PREFIX ||
    data.startsWith(`${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:`)
  );
}

function readSuccessfulTelegramResult(value: unknown): {
  messageId: number | null;
  ok: boolean;
} {
  if (!value || typeof value !== "object")
    return { messageId: null, ok: false };
  const result = value as { messageId?: unknown; ok?: unknown };
  return {
    messageId:
      typeof result.messageId === "number" && Number.isInteger(result.messageId)
        ? result.messageId
        : null,
    ok: result.ok === true,
  };
}

async function readInternalApiJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `Internal trading API failed (${response.status})`;
    throw new Error(message);
  }
  if (payload == null) {
    throw new Error("Internal trading API returned an empty response.");
  }
  return payload;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export class TelegramBotTradingInternalApiTimeoutError extends Error {
  readonly path: string;
  readonly timeoutMs: number;

  constructor(path: string, timeoutMs: number) {
    super(`Internal trading API timed out after ${timeoutMs}ms.`);
    this.name = "TelegramBotTradingInternalApiTimeoutError";
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createInternalApiPost(input: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): <T>(
  path: string,
  body: unknown,
  options?: { timeoutMs?: number },
) => Promise<T> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const token = input.token.trim();
  const defaultTimeoutMs =
    Number.isFinite(input.timeoutMs) && (input.timeoutMs ?? 0) > 0
      ? Math.trunc(input.timeoutMs ?? 0)
      : DEFAULT_INTERNAL_API_TIMEOUT_MS;
  return async <T>(
    path: string,
    body: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> => {
    const timeoutMs =
      Number.isFinite(options?.timeoutMs) && (options?.timeoutMs ?? 0) > 0
        ? Math.trunc(options?.timeoutMs ?? 0)
        : defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return readInternalApiJson<T>(response);
    } catch (error) {
      if (isAbortError(error)) {
        throw new TelegramBotTradingInternalApiTimeoutError(path, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createTelegramBotTradingInternalApiClient(input: {
  baseUrl: string;
  executeTimeoutMs?: number;
  token: string;
  timeoutMs?: number;
}): TelegramBotTradingInternalApiClient {
  const post = createInternalApiPost(input);
  const executeTimeoutMs =
    Number.isFinite(input.executeTimeoutMs) && (input.executeTimeoutMs ?? 0) > 0
      ? Math.trunc(input.executeTimeoutMs ?? 0)
      : DEFAULT_INTERNAL_API_EXECUTE_TIMEOUT_MS;
  return {
    buildPositionsMessage: (body) =>
      post<TelegramBotTradingClientMessage>(
        "/internal/telegram-bot/positions",
        body,
        { timeoutMs: executeTimeoutMs },
      ),
    buildPositionMessage: (body) =>
      post<TelegramBotTradingClientMessage>(
        `/internal/telegram-bot/positions/${body.positionId}/card`,
        {
          appBaseUrl: body.appBaseUrl,
          telegramMiniAppEnabled: body.telegramMiniAppEnabled,
          telegramUserId: body.telegramUserId,
        },
      ),
    buildDepositMessage: (body) =>
      post<
        TelegramBotTradingClientMessage & {
          depositAddress?: string;
          qrText?: string;
          venue?: string;
        }
      >("/internal/telegram-bot/deposit", body),
    searchMarkets: (body) =>
      post<
        Array<{
          eventId: string;
          eventTitle: string | null;
          lastPrice: number | null;
          marketId: string;
          marketTitle: string;
          noAsk: number | null;
          venue: string;
          venueOptions?: Array<{
            eventId: string;
            eventTitle: string | null;
            lastPrice: number | null;
            marketId: string;
            marketTitle: string;
            noAsk: number | null;
            venue: string;
            yesAsk: number | null;
          }>;
          yesAsk: number | null;
        }>
      >("/internal/telegram-bot/trading/market-search", body, {
        timeoutMs: body.query
          ? TELEGRAM_MARKET_SEARCH_TIMEOUT_MS
          : TELEGRAM_TRENDING_MARKETS_TIMEOUT_MS,
      }),
    buildMarketMessage: (body) =>
      post<TelegramBotTradingClientMessage>(
        "/internal/telegram-bot/trading/market-card",
        body,
      ),
    buildStatusMessage: (telegramUserId) =>
      post<TelegramBotTradingClientMessage>(
        "/internal/telegram-bot/trading/status",
        { telegramUserId },
      ),
    disableTrading: async (telegramUserId) => {
      const result = await post<{
        disabled?: boolean;
        status?: "already_disabled" | "disabled" | "unavailable";
      }>("/internal/telegram-bot/trading/disable", { telegramUserId });
      return (
        result.status ?? (result.disabled ? "disabled" : "already_disabled")
      );
    },
    handleCallback: async (callbackInput) => {
      const parsed = parseTelegramBotTradingCallbackData(
        callbackInput.callbackQuery.data,
      );
      if (!parsed) {
        if (
          !isTelegramBotTradingCallbackData(callbackInput.callbackQuery.data)
        ) {
          return false;
        }
        await callbackInput.answerCallbackQuery({
          callbackQueryId: callbackInput.callbackQuery.id,
          showAlert: true,
          text: "Trade button expired or invalid. Send /market again.",
        });
        return true;
      }
      const path =
        parsed.type === "buy" ||
        parsed.type === "retry_buy" ||
        parsed.type === "sell" ||
        parsed.type === "redeem"
          ? "/internal/telegram-bot/trading/preview-intent"
          : parsed.type === "cancel"
            ? `/internal/telegram-bot/trading/intents/${parsed.intentId}/cancel`
            : `/internal/telegram-bot/trading/intents/${parsed.intentId}/execute`;
      const confirmAcknowledged = parsed.type === "confirm";
      if (confirmAcknowledged) {
        await callbackInput.answerCallbackQuery({
          callbackQueryId: callbackInput.callbackQuery.id,
          text: "Processing trade…",
        });
        const chatId = callbackInput.callbackQuery.message?.chat?.id;
        const messageId = callbackInput.callbackQuery.message?.message_id;
        if (chatId != null && messageId != null) {
          await callbackInput
            .editMessageText?.({
              chat_id: String(chatId),
              message_id: messageId,
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: [] },
              text: buildTelegramTradeProgressMessage("processing"),
            })
            .catch(() => undefined);
        }
      }
      let result: CapturedTelegramBotTradingCallbackResult;
      try {
        result = await post<CapturedTelegramBotTradingCallbackResult>(
          path,
          {
            appBaseUrl: callbackInput.appBaseUrl,
            callbackQuery: callbackInput.callbackQuery,
            telegramMiniAppEnabled: callbackInput.telegramMiniAppEnabled,
          },
          parsed.type === "confirm" ? { timeoutMs: executeTimeoutMs } : {},
        );
      } catch (error) {
        if (
          parsed.type === "confirm" &&
          error instanceof TelegramBotTradingInternalApiTimeoutError
        ) {
          const text = buildTelegramTradeProgressMessage("resolving");
          const resolvingMessage = withTelegramPrivateNavigation({
            parse_mode: "MarkdownV2",
            text,
          });
          const chatId = callbackInput.callbackQuery.message?.chat?.id;
          const messageId = callbackInput.callbackQuery.message?.message_id;
          if (chatId != null) {
            const edited =
              messageId != null
                ? await callbackInput
                    .editMessageText?.({
                      chat_id: String(chatId),
                      message_id: messageId,
                      parse_mode: resolvingMessage.parse_mode,
                      reply_markup: resolvingMessage.reply_markup,
                      text: resolvingMessage.text,
                    })
                    .then(() => true)
                    .catch(() => false)
                : false;
            if (!edited) {
              await callbackInput.sendMessage({
                chat_id: String(chatId),
                ...resolvingMessage,
              });
            }
          }
          return true;
        }
        if (parsed.type === "confirm") {
          const chatId = callbackInput.callbackQuery.message?.chat?.id;
          if (chatId != null) {
            const failureMessage = withTelegramPrivateNavigation({
              text: "Trade execution failed or its status is unknown. Use /trade_status or open Hunch before retrying.",
            });
            await callbackInput.sendMessage({
              chat_id: String(chatId),
              ...failureMessage,
            });
          }
          return true;
        }
        throw error;
      }
      if (!confirmAcknowledged) {
        for (const answer of result.answers) {
          await callbackInput.answerCallbackQuery(answer);
        }
      }
      const terminalMessageRaw = confirmAcknowledged
        ? result.messages.at(-1)
        : null;
      const terminalMessage = terminalMessageRaw
        ? withTelegramPrivateNavigation(terminalMessageRaw, {
            positions: true,
          })
        : null;
      const previewMessage = !confirmAcknowledged
        ? result.messages.at(-1)
        : null;
      const chatId = callbackInput.callbackQuery.message?.chat?.id;
      const messageId = callbackInput.callbackQuery.message?.message_id;
      let terminalEdited = false;
      let receiptDelivery: "edit" | "send" | null = null;
      let receiptMessageId: number | null = null;
      let previewEdited = false;
      if (previewMessage && chatId != null && messageId != null) {
        const editResult = await callbackInput
          .editMessageText?.({
            chat_id: String(chatId),
            message_id: messageId,
            parse_mode: previewMessage.parse_mode,
            reply_markup: previewMessage.reply_markup,
            text: previewMessage.text,
          })
          .catch(() => null);
        previewEdited = readSuccessfulTelegramResult(editResult).ok;
      }
      if (terminalMessage && chatId != null && messageId != null) {
        const editResult = await callbackInput
          .editMessageText?.({
            chat_id: String(chatId),
            message_id: messageId,
            parse_mode: terminalMessage.parse_mode,
            reply_markup: terminalMessage.reply_markup,
            text: terminalMessage.text,
          })
          .catch(() => null);
        const successfulEdit = readSuccessfulTelegramResult(editResult);
        terminalEdited = successfulEdit.ok;
        if (terminalEdited) {
          receiptDelivery = "edit";
          receiptMessageId = successfulEdit.messageId ?? messageId;
        }
      }
      for (const [index, message] of result.messages.entries()) {
        const deliveredMessage =
          confirmAcknowledged && index === result.messages.length - 1
            ? (terminalMessage ?? message)
            : message;
        if (
          previewEdited &&
          !confirmAcknowledged &&
          index === result.messages.length - 1
        ) {
          continue;
        }
        if (
          terminalEdited &&
          confirmAcknowledged &&
          index === result.messages.length - 1
        ) {
          continue;
        }
        const sendResult = await callbackInput.sendMessage(deliveredMessage);
        if (confirmAcknowledged && index === result.messages.length - 1) {
          const successfulSend = readSuccessfulTelegramResult(sendResult);
          if (successfulSend.ok) {
            receiptDelivery = "send";
            receiptMessageId = successfulSend.messageId;
          }
        }
      }
      if (confirmAcknowledged && receiptDelivery) {
        await post(
          `/internal/telegram-bot/trading/intents/${parsed.intentId}/receipt`,
          {
            delivery: receiptDelivery,
            messageId: receiptMessageId,
            telegramUserId: callbackInput.callbackQuery.from?.id,
          },
        ).catch(() => undefined);
      }
      return result.handled;
    },
  };
}
