import {
  buildTelegramTradeProgressMessage,
  formatTelegramCalloutMarkdownV2,
  formatTelegramTextWithCommandsMarkdownV2,
} from "./telegram-bot-trading-presentation.js";
import { withTelegramPrivateNavigation } from "./telegram-bot-private-navigation.js";
import type { TelegramFundingProgressProjection } from "./telegram-funding-contracts.js";

export type TelegramBotTradingClientButton = (
  | { text: string; callback_data: string }
  | { text: string; copy_text: { text: string } }
  | { text: string; web_app: { url: string } }
  | { text: string; url: string }
) & { icon_custom_emoji_id?: string };

export type TelegramBotTradingClientReplyMarkup = {
  inline_keyboard: TelegramBotTradingClientButton[][];
};

export type TelegramBotTradingClientMessage = {
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: TelegramBotTradingClientReplyMarkup;
  text: string;
};

export type TelegramFundingClientMessage = TelegramBotTradingClientMessage & {
  durableFundingDeliveryRequired?: boolean;
  fundingContextId?: string;
  qrText?: string;
  venue?: string;
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
  beginTradeInput?: (input: {
    action: "buy" | "sell";
    contextId: string;
    expiresAt: string;
    message: TelegramBotTradingClientMessage;
  }) => Promise<boolean>;
  telegramMiniAppEnabled?: boolean;
  sendMessage: (input: {
    chat_id: string;
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramBotTradingClientReplyMarkup;
    text: string;
  }) => Promise<unknown>;
};

export type TelegramBotTradingInternalApiClient = {
  buildAccountValueMessage: (input: {
    chatId: string | number;
    telegramUserId: string | number;
  }) => Promise<TelegramBotTradingClientMessage>;
  buildMarketMessage: (input: {
    appBaseUrl: string;
    chatId: string | number;
    context?: {
      focusPositionId?: string;
      focusPositionWalletAddress?: string | null;
      focusSide?: "YES" | "NO";
      observedNoAsk?: number | null;
      observedYesAsk?: number | null;
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
    telegramMessageId: number;
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
  openFunding: (input: {
    appBaseUrl: string;
    chatId: string | number;
    idempotencyKey: string;
    telegramMiniAppEnabled?: boolean;
    telegramMessageId: number | null;
    telegramUserId: string | number;
    venue: "limitless" | "polymarket";
  }) => Promise<TelegramFundingClientMessage>;
  getFundingSession: (input: {
    chatId: string | number;
    contextId: string;
    deliveryProjection?: TelegramFundingProgressProjection;
    requestObservation?: boolean;
    telegramMessageId?: number | null;
    telegramUserId: string | number;
    view?: "address" | "delivery" | "progress";
  }) => Promise<TelegramFundingClientMessage>;
  selectFundingTarget: (input: {
    chatId: string | number;
    choiceToken: string;
    contextId: string;
    idempotencyKey: string;
    telegramMessageId: number | null;
    telegramUserId: string | number;
  }) => Promise<TelegramFundingClientMessage>;
  cancelFunding: (input: {
    chatId: string | number;
    contextId: string;
    idempotencyKey: string;
    telegramMessageId: number | null;
    telegramUserId: string | number;
  }) => Promise<TelegramFundingClientMessage>;
  reviewFundingConversion: (input: {
    chatId: string | number;
    idempotencyKey: string;
    receiptId: string;
    telegramMessageId: number | null;
    telegramUserId: string | number;
  }) => Promise<TelegramFundingClientMessage>;
  confirmFundingConversion: (input: {
    chatId: string | number;
    consentToken: string;
    idempotencyKey: string;
    telegramMessageId: number | null;
    telegramUserId: string | number;
  }) => Promise<TelegramFundingClientMessage>;
  resumeFundingBuy: (input: {
    appBaseUrl: string;
    chatId: string | number;
    continuationToken: string;
    idempotencyKey: string;
    telegramMessageId: number;
    telegramMiniAppEnabled?: boolean;
    telegramUserId: string | number;
  }) => Promise<TelegramFundingClientMessage>;
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
  completeTradeInput: (input: {
    appBaseUrl: string;
    chatId: string;
    contextId: string;
    telegramMessageId: number;
    telegramMiniAppEnabled?: boolean;
    telegramUserId: number;
    value: string;
  }) => Promise<{
    completed: boolean;
    message: TelegramFundingClientMessage;
  }>;
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
  messages: Array<TelegramFundingClientMessage & { chat_id: string }>;
};

export const TELEGRAM_BOT_TRADING_CALLBACK_PREFIX = "hbt";
const DEFAULT_INTERNAL_API_TIMEOUT_MS = 10_000;
const TELEGRAM_MARKET_SEARCH_TIMEOUT_MS = 12_000;
const TELEGRAM_TRENDING_MARKETS_TIMEOUT_MS = 2_000;
const DEFAULT_ACCOUNT_VALUE_TIMEOUT_MS = 30_000;
const DEFAULT_INTERNAL_API_EXECUTE_TIMEOUT_MS = 120_000;

const EXACT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParsedTelegramBotTradingCallback =
  | {
      intentId: string;
      type: "buy" | "sell" | "redeem" | "retry_buy" | "cancel" | "confirm";
    }
  | {
      inputContextId: string;
      type: "buy_input" | "sell_input";
    };

export function parseTelegramBotTradingCallbackData(
  data: string | undefined,
): ParsedTelegramBotTradingCallback | null {
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
    type !== "buy_input" &&
    type !== "sell_input" &&
    type !== "confirm" &&
    type !== "cancel"
  )
    return null;
  if (!EXACT_UUID_RE.test(intentId ?? "")) return null;
  return type === "buy_input" || type === "sell_input"
    ? { inputContextId: intentId, type }
    : { type, intentId };
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

export type TelegramBotTradingInternalApiErrorCode =
  | "empty_response"
  | "http_error"
  | "invalid_response"
  | "timeout"
  | "transport_error";

export class TelegramBotTradingInternalApiError extends Error {
  readonly code: TelegramBotTradingInternalApiErrorCode;
  readonly path: string;
  readonly statusCode?: number;

  constructor(input: {
    code: TelegramBotTradingInternalApiErrorCode;
    message?: string;
    path: string;
    statusCode?: number;
  }) {
    super(
      input.message ?? `Internal trading API request failed (${input.code}).`,
    );
    this.name = "TelegramBotTradingInternalApiError";
    this.code = input.code;
    this.path = input.path;
    this.statusCode = input.statusCode;
  }
}

async function readInternalApiJson<T>(
  response: Response,
  path: string,
): Promise<T> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TelegramBotTradingInternalApiError({
      code: "http_error",
      path,
      statusCode: response.status,
    });
  }
  let payload: T | null;
  try {
    payload = (await response.json()) as T | null;
  } catch {
    throw new TelegramBotTradingInternalApiError({
      code: "invalid_response",
      path,
    });
  }
  if (payload == null) {
    throw new TelegramBotTradingInternalApiError({
      code: "empty_response",
      path,
    });
  }
  return payload;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export class TelegramBotTradingInternalApiTimeoutError extends TelegramBotTradingInternalApiError {
  readonly timeoutMs: number;

  constructor(path: string, timeoutMs: number) {
    super({
      code: "timeout",
      message: `Internal trading API timed out after ${timeoutMs}ms.`,
      path,
    });
    this.name = "TelegramBotTradingInternalApiTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function describeTelegramBotTradingInternalApiError(
  error: unknown,
): Readonly<{
  errorCode: TelegramBotTradingInternalApiErrorCode | "unexpected_error";
  path?: string;
  statusCode?: number;
  timeoutMs?: number;
}> {
  if (!(error instanceof TelegramBotTradingInternalApiError)) {
    return { errorCode: "unexpected_error" };
  }
  return {
    errorCode: error.code,
    path: error.path,
    statusCode: error.statusCode,
    timeoutMs:
      error instanceof TelegramBotTradingInternalApiTimeoutError
        ? error.timeoutMs
        : undefined,
  };
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
      return readInternalApiJson<T>(response, path);
    } catch (error) {
      if (isAbortError(error)) {
        throw new TelegramBotTradingInternalApiTimeoutError(path, timeoutMs);
      }
      if (error instanceof TelegramBotTradingInternalApiError) throw error;
      throw new TelegramBotTradingInternalApiError({
        code: "transport_error",
        path,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createTelegramBotTradingInternalApiClient(input: {
  accountValueTimeoutMs?: number;
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
  const accountValueTimeoutMs =
    Number.isFinite(input.accountValueTimeoutMs) &&
    (input.accountValueTimeoutMs ?? 0) > 0
      ? Math.trunc(input.accountValueTimeoutMs ?? 0)
      : DEFAULT_ACCOUNT_VALUE_TIMEOUT_MS;
  return {
    buildAccountValueMessage: (body) =>
      post<TelegramBotTradingClientMessage>(
        "/internal/telegram-bot/account",
        body,
        { timeoutMs: accountValueTimeoutMs },
      ),
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
          telegramMessageId: body.telegramMessageId,
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
    openFunding: (body) =>
      post<TelegramFundingClientMessage>(
        "/internal/telegram-bot/funding/open",
        body,
        { timeoutMs: executeTimeoutMs },
      ),
    getFundingSession: (body) =>
      post<TelegramFundingClientMessage>(
        "/internal/telegram-bot/funding/session",
        body,
      ),
    selectFundingTarget: (body) =>
      post<TelegramFundingClientMessage>(
        "/internal/telegram-bot/funding/select-target",
        body,
      ),
    cancelFunding: (body) =>
      post<TelegramFundingClientMessage>(
        "/internal/telegram-bot/funding/cancel",
        body,
      ),
    reviewFundingConversion: (body) =>
      post<TelegramFundingClientMessage>(
        "/internal/telegram-bot/funding/review-conversion",
        body,
      ),
    confirmFundingConversion: (body) =>
      post<TelegramFundingClientMessage>(
        "/internal/telegram-bot/funding/confirm-conversion",
        body,
        { timeoutMs: executeTimeoutMs },
      ),
    resumeFundingBuy: (body) =>
      post<TelegramFundingClientMessage>(
        "/internal/telegram-bot/funding/resume-buy",
        body,
        { timeoutMs: executeTimeoutMs },
      ),
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
    completeTradeInput: (body) =>
      post<{
        completed: boolean;
        message: TelegramFundingClientMessage;
      }>(
        `/internal/telegram-bot/trading/input-contexts/${body.contextId}/complete`,
        {
          appBaseUrl: body.appBaseUrl,
          chatId: body.chatId,
          telegramMessageId: body.telegramMessageId,
          telegramMiniAppEnabled: body.telegramMiniAppEnabled,
          telegramUserId: body.telegramUserId,
          value: body.value,
        },
        { timeoutMs: executeTimeoutMs },
      ),
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
          text: "⚠️ Trade button expired or invalid. Send /market again.",
        });
        return true;
      }
      if (parsed.type === "buy_input" || parsed.type === "sell_input") {
        const chat = callbackInput.callbackQuery.message?.chat;
        const telegramUserId = callbackInput.callbackQuery.from?.id;
        const telegramMessageId =
          callbackInput.callbackQuery.message?.message_id;
        if (
          chat?.type !== "private" ||
          chat.id == null ||
          telegramUserId == null ||
          telegramMessageId == null ||
          String(chat.id) !== String(telegramUserId) ||
          !callbackInput.beginTradeInput
        ) {
          await callbackInput.answerCallbackQuery({
            callbackQueryId: callbackInput.callbackQuery.id,
            showAlert: true,
            text: "⚠️ Open the original private bot chat to enter an amount.",
          });
          return true;
        }
        const action = parsed.type === "sell_input" ? "sell" : "buy";
        const begun = await post<{
          action: "buy" | "sell";
          contextId: string;
          expiresAt: string;
          message: TelegramBotTradingClientMessage;
        }>(
          `/internal/telegram-bot/trading/input-contexts/${parsed.inputContextId}/begin`,
          {
            action,
            chatId: String(chat.id),
            telegramMessageId,
            telegramUserId,
          },
        ).catch(() => null);
        if (!begun) {
          await callbackInput.answerCallbackQuery({
            callbackQueryId: callbackInput.callbackQuery.id,
            showAlert: true,
            text: "⚠️ Custom input is unavailable or expired.",
          });
          return true;
        }
        const started = await callbackInput
          .beginTradeInput(begun)
          .catch(() => false);
        await callbackInput.answerCallbackQuery({
          callbackQueryId: callbackInput.callbackQuery.id,
          showAlert: !started,
          text: started
            ? action === "buy"
              ? "Enter the USD amount."
              : "Enter shares, a percentage, or all."
            : "⚠️ Custom input is temporarily unavailable.",
        });
        return true;
      }
      if (!("intentId" in parsed)) return true;
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
          text: "⏳ Processing trade…",
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
              parse_mode: "MarkdownV2",
              text: formatTelegramCalloutMarkdownV2({
                bodyMarkdownV2: formatTelegramTextWithCommandsMarkdownV2(
                  "Use /trade_status or open Hunch before retrying.",
                ),
                icon: "⚠️",
                title: "Trade status uncertain",
              }),
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
          !confirmAcknowledged &&
          index === result.messages.length - 1 &&
          // A funding preview is bound to this callback message in the API.
          // Never copy its actionable keyboard to a different message ID.
          (previewEdited ||
            typeof deliveredMessage.fundingContextId === "string")
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
