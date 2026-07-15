import { escapeTelegramMarkdownV2 } from "./telegram-bot-trading-presentation.js";
import {
  canAppendTelegramBlock,
  compactTelegramText,
  TELEGRAM_INLINE_BUTTON_GRAPHEME_LIMIT,
} from "./telegram-bot-text-budget.js";

const SEARCH_KEY_PREFIX = "tg:signal_bot:v1:market_search";
const SEARCH_TTL_SEC = 10 * 60;

type SearchRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

export type SignalBotMarketSearchResult = {
  eventId: string;
  eventTitle: string | null;
  lastPrice: number | null;
  marketId: string;
  marketTitle: string;
  noAsk: number | null;
  venue: string;
  yesAsk: number | null;
};

export type SignalBotMarketSearchSession = {
  chatId: string;
  query: string | null;
  results: SignalBotMarketSearchResult[];
  telegramUserId: number;
};

export type SignalBotMarketSearchMessage = {
  reply_markup: {
    inline_keyboard: Array<Array<{ callback_data: string; text: string }>>;
  };
  text: string;
};

function searchKey(sessionId: string): string {
  return `${SEARCH_KEY_PREFIX}:${sessionId}`;
}

export async function writeSignalBotMarketSearchSession(input: {
  chatId: string;
  query: string | null;
  redis: SearchRedis;
  results: SignalBotMarketSearchResult[];
  telegramUserId: number;
}): Promise<string> {
  const sessionId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const session: SignalBotMarketSearchSession = {
    chatId: input.chatId,
    query: input.query,
    results: input.results.slice(0, 5),
    telegramUserId: input.telegramUserId,
  };
  await input.redis.set(searchKey(sessionId), JSON.stringify(session), {
    EX: SEARCH_TTL_SEC,
  });
  return sessionId;
}

export async function readSignalBotMarketSearchSession(input: {
  chatId: string;
  redis: Pick<SearchRedis, "get">;
  sessionId: string;
  telegramUserId: number;
}): Promise<SignalBotMarketSearchSession | null> {
  const raw = await input.redis.get(searchKey(input.sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SignalBotMarketSearchSession>;
    if (
      parsed.chatId !== input.chatId ||
      parsed.telegramUserId !== input.telegramUserId ||
      !Array.isArray(parsed.results)
    ) {
      return null;
    }
    return {
      chatId: parsed.chatId,
      query: typeof parsed.query === "string" ? parsed.query : null,
      results: parsed.results.slice(0, 5) as SignalBotMarketSearchResult[],
      telegramUserId: parsed.telegramUserId,
    };
  } catch {
    return null;
  }
}

function price(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 0.1 ? 1 : 0,
  }).format(value * 100)}¢`;
}

function bold(value: string): string {
  return `*${escapeTelegramMarkdownV2(value)}*`;
}

export function buildSignalBotMarketSearchScreen(input: {
  callbackPrefix: string;
  query: string | null;
  results: SignalBotMarketSearchResult[];
  sessionId: string;
}): SignalBotMarketSearchMessage {
  const title = input.query
    ? `Results for “${compactTelegramText(input.query, 120)}”`
    : "Trending markets";
  const lines = [bold(`🔎 ${title}`), ""];
  const visibleResults: SignalBotMarketSearchResult[] = [];
  if (input.results.length === 0) {
    lines.push(
      escapeTelegramMarkdownV2(
        "No active markets found. Send another search or paste a market URL.",
      ),
    );
  } else {
    for (const result of input.results.slice(0, 5)) {
      const index = visibleResults.length;
      const block = [
        bold(`${index + 1}. ${compactTelegramText(result.marketTitle, 160)}`),
        escapeTelegramMarkdownV2(
          `${result.venue} · YES ${price(result.yesAsk)} · NO ${price(result.noAsk)}`,
        ),
        "",
      ].join("\n");
      if (
        !canAppendTelegramBlock({
          block,
          currentLines: lines,
          reserve: 260,
        })
      ) {
        break;
      }
      visibleResults.push(result);
      lines.push(block);
    }
    if (visibleResults.length < input.results.length) {
      lines.push(
        escapeTelegramMarkdownV2(
          `+ ${input.results.length - visibleResults.length} more`,
        ),
        "",
      );
    }
  }
  return {
    reply_markup: {
      inline_keyboard: [
        ...visibleResults.map((result, index) => [
          {
            callback_data: `${input.callbackPrefix}search:${input.sessionId}:${index}`,
            text: compactTelegramText(
              `${index + 1}. ${result.marketTitle}`,
              TELEGRAM_INLINE_BUTTON_GRAPHEME_LIMIT,
            ),
          },
        ]),
        [
          {
            callback_data: `${input.callbackPrefix}trading:market_input`,
            text: "New search",
          },
          {
            callback_data: `${input.callbackPrefix}home`,
            text: "🏠 Home",
          },
        ],
      ],
    },
    text: lines.join("\n"),
  };
}

export function buildSignalBotMarketSearchUnavailableScreen(input: {
  callbackPrefix: string;
}): SignalBotMarketSearchMessage {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: `${input.callbackPrefix}trading:market_input`,
            text: "Try again",
          },
          {
            callback_data: `${input.callbackPrefix}home`,
            text: "🏠 Home",
          },
        ],
      ],
    },
    text: [
      bold("🔎 Markets"),
      "",
      escapeTelegramMarkdownV2(
        "Search is temporarily unavailable. Send another search to try again.",
      ),
    ].join("\n"),
  };
}

export function buildSignalBotMarketSearchQueryPrompt(input: {
  callbackPrefix: string;
}): SignalBotMarketSearchMessage {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: `${input.callbackPrefix}trading:market_input`,
            text: "New search",
          },
          {
            callback_data: `${input.callbackPrefix}home`,
            text: "🏠 Home",
          },
        ],
      ],
    },
    text: [
      bold("🔎 Markets"),
      "",
      escapeTelegramMarkdownV2(
        "Send at least 2 characters, a market URL, or a market ID.",
      ),
    ].join("\n"),
  };
}

export function buildSignalBotMarketSearchProgressScreen(): SignalBotMarketSearchMessage {
  return {
    reply_markup: { inline_keyboard: [] },
    text: [bold("🔎 Markets"), "", escapeTelegramMarkdownV2("Searching…")].join(
      "\n",
    ),
  };
}

export function buildSignalBotMarketUnavailableResultScreen(input: {
  callbackPrefix: string;
  sessionId: string;
  temporary?: boolean;
}): SignalBotMarketSearchMessage {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: `${input.callbackPrefix}search_back:${input.sessionId}`,
            text: "Back to results",
          },
          {
            callback_data: `${input.callbackPrefix}home`,
            text: "🏠 Home",
          },
        ],
      ],
    },
    text: [
      bold(
        input.temporary
          ? "Market temporarily unavailable"
          : "Market unavailable",
      ),
      "",
      escapeTelegramMarkdownV2(
        input.temporary
          ? "Market details could not be refreshed. Try again or return to the results."
          : "Market is no longer available.",
      ),
    ].join("\n"),
  };
}
