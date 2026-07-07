export type TelegramBotTradingClientButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export type TelegramBotTradingClientReplyMarkup = {
  inline_keyboard: TelegramBotTradingClientButton[][];
};

export type TelegramBotTradingClientMessage = {
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
  callbackQuery: {
    data?: string;
    from?: { id?: number };
    id: string;
    message?: {
      chat?: { id: string | number };
      message_id?: number;
    };
  };
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
    isAdminTest?: boolean;
    marketRef: string;
    telegramMessageId?: number | null;
    telegramUserId: string | number;
  }) => Promise<TelegramBotTradingClientMessage>;
  buildStatusMessage: (
    telegramUserId: string | number,
  ) => Promise<TelegramBotTradingClientMessage>;
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
const DEFAULT_INTERNAL_API_EXECUTE_TIMEOUT_MS = 120_000;

const EXACT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseTelegramBotTradingCallbackData(
  data: string | undefined,
): { intentId: string; type: "buy" | "cancel" | "confirm" } | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, type, intentId] = parts;
  if (prefix !== TELEGRAM_BOT_TRADING_CALLBACK_PREFIX) return null;
  if (type !== "buy" && type !== "confirm" && type !== "cancel") return null;
  if (!EXACT_UUID_RE.test(intentId ?? "")) return null;
  return { type, intentId };
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
      if (!parsed) return false;
      const path =
        parsed.type === "buy"
          ? "/internal/telegram-bot/trading/preview-intent"
          : parsed.type === "cancel"
            ? `/internal/telegram-bot/trading/intents/${parsed.intentId}/cancel`
            : `/internal/telegram-bot/trading/intents/${parsed.intentId}/execute`;
      let result: CapturedTelegramBotTradingCallbackResult;
      try {
        result = await post<CapturedTelegramBotTradingCallbackResult>(
          path,
          {
            appBaseUrl: callbackInput.appBaseUrl,
            callbackQuery: callbackInput.callbackQuery,
          },
          parsed.type === "confirm" ? { timeoutMs: executeTimeoutMs } : {},
        );
      } catch (error) {
        if (
          parsed.type === "confirm" &&
          error instanceof TelegramBotTradingInternalApiTimeoutError
        ) {
          const text =
            "Trade status is unknown. Use /trade_status or open Hunch before retrying.";
          await callbackInput.answerCallbackQuery({
            callbackQueryId: callbackInput.callbackQuery.id,
            showAlert: true,
            text,
          });
          const chatId = callbackInput.callbackQuery.message?.chat?.id;
          if (chatId != null) {
            await callbackInput.sendMessage({
              chat_id: String(chatId),
              text,
            });
          }
          return true;
        }
        throw error;
      }
      for (const answer of result.answers) {
        await callbackInput.answerCallbackQuery(answer);
      }
      for (const message of result.messages) {
        await callbackInput.sendMessage(message);
      }
      return result.handled;
    },
  };
}
