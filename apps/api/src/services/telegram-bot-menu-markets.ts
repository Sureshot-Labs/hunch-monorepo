import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramCalloutMarkdownV2,
  formatTelegramFieldWithMarkdownV2,
  formatTelegramItalicMarkdownV2,
} from "./telegram-bot-trading-presentation.js";
import {
  canAppendTelegramBlock,
  compactTelegramText,
  TELEGRAM_INLINE_BUTTON_GRAPHEME_LIMIT,
} from "./telegram-bot-text-budget.js";
import {
  buildTelegramMarketIdentity,
  formatTelegramVenueButtonIcon,
  formatTelegramVenueFieldMarkdownV2,
  formatTelegramVenueLabel,
  formatTelegramVenueLabelMarkdownV2,
} from "./telegram-market-identity.js";

const SEARCH_KEY_PREFIX = "tg:signal_bot:v1:market_search";
const SEARCH_TTL_SEC = 10 * 60;
export const SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE = 5;
const SIGNAL_BOT_MARKET_SEARCH_GRID_COLUMNS = 3;
const SEARCH_SESSION_RESULT_LIMIT = 25;

type SearchRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

export type SignalBotMarketSearchVenueOption = {
  eventId: string;
  eventTitle: string | null;
  lastPrice: number | null;
  marketId: string;
  marketTitle: string;
  noAsk: number | null;
  venue: string;
  yesAsk: number | null;
};

export type SignalBotMarketSearchResult = SignalBotMarketSearchVenueOption & {
  venueOptions?: SignalBotMarketSearchVenueOption[];
};

export type SignalBotMarketSearchSession = {
  chatId: string;
  query: string | null;
  results: SignalBotMarketSearchResult[];
  telegramUserId: number;
};

export type SignalBotMarketSearchMessage = {
  reply_markup: {
    inline_keyboard: Array<
      Array<{
        callback_data: string;
        icon_custom_emoji_id?: string;
        text: string;
      }>
    >;
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
    results: input.results.slice(0, SEARCH_SESSION_RESULT_LIMIT),
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
      results: parsed.results.slice(
        0,
        SEARCH_SESSION_RESULT_LIMIT,
      ) as SignalBotMarketSearchResult[],
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
  return formatTelegramBoldMarkdownV2(value);
}

function venueOptions(
  result: SignalBotMarketSearchResult,
): SignalBotMarketSearchVenueOption[] {
  return result.venueOptions && result.venueOptions.length > 0
    ? result.venueOptions
    : [result];
}

export function buildSignalBotMarketSearchScreen(input: {
  callbackPrefix: string;
  page?: number;
  query: string | null;
  results: SignalBotMarketSearchResult[];
  sessionId: string;
}): SignalBotMarketSearchMessage {
  const pageCount = Math.max(
    1,
    Math.ceil(input.results.length / SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE),
  );
  const page = Math.min(
    pageCount - 1,
    Math.max(0, Math.trunc(input.page ?? 0)),
  );
  const pageStart = page * SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE;
  const pageResults = input.results.slice(
    pageStart,
    pageStart + SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE,
  );
  const title = input.query
    ? `Results for “${compactTelegramText(input.query, 120)}”`
    : "Trending markets";
  const lines = [`🔎 ${bold(title)}`, ""];
  const visibleResults: SignalBotMarketSearchResult[] = [];
  if (input.results.length === 0) {
    lines.push(
      `ℹ️ ${bold("Nothing found")}`,
      "",
      escapeTelegramMarkdownV2(
        "No active markets found. Send another search or paste a market URL.",
      ),
    );
  } else {
    for (const result of pageResults) {
      const index = pageStart + visibleResults.length;
      const identity = buildTelegramMarketIdentity({
        eventTitle: result.eventTitle,
        marketTitle: result.marketTitle,
      });
      const options = venueOptions(result);
      const venueLineMarkdownV2 =
        options.length > 1
          ? `🌐 ${formatTelegramFieldWithMarkdownV2(
              "Venues",
              options
                .map((option) =>
                  formatTelegramVenueLabelMarkdownV2(option.venue),
                )
                .join(escapeTelegramMarkdownV2(" · ")),
            )}`
          : `${formatTelegramVenueFieldMarkdownV2(result.venue)} ${escapeTelegramMarkdownV2(
              "·",
            )} ${formatTelegramFieldWithMarkdownV2(
              "Odds",
              escapeTelegramMarkdownV2(
                `YES ${price(result.yesAsk)} · NO ${price(result.noAsk)}`,
              ),
            )}`;
      const block = [
        bold(`${index + 1}. ${compactTelegramText(identity.lines[0], 160)}`),
        ...(identity.lines[1]
          ? [
              `🎯 ${formatTelegramFieldWithMarkdownV2(
                "Market",
                escapeTelegramMarkdownV2(
                  compactTelegramText(identity.lines[1], 160),
                ),
              )}`,
            ]
          : []),
        venueLineMarkdownV2,
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
    if (visibleResults.length < pageResults.length) {
      lines.push(
        escapeTelegramMarkdownV2(
          `+ ${pageResults.length - visibleResults.length} more on this page`,
        ),
        "",
      );
    }
  }
  const resultButtonRows: SignalBotMarketSearchMessage["reply_markup"]["inline_keyboard"] =
    [];
  for (
    let localIndex = 0;
    localIndex < visibleResults.length;
    localIndex += 1
  ) {
    const result = visibleResults[localIndex];
    if (!result) continue;
    const index = pageStart + localIndex;
    const options = venueOptions(result);
    const venueIcon =
      options.length === 1
        ? formatTelegramVenueButtonIcon(result.venue)
        : undefined;
    const rowIndex = Math.floor(
      localIndex / SIGNAL_BOT_MARKET_SEARCH_GRID_COLUMNS,
    );
    const row = resultButtonRows[rowIndex] ?? [];
    row.push({
      callback_data: `${input.callbackPrefix}search:${input.sessionId}:${index}`,
      ...(venueIcon ? { icon_custom_emoji_id: venueIcon } : {}),
      text: `${venueIcon ? "" : "🌐 "}${index + 1}.`,
    });
    resultButtonRows[rowIndex] = row;
  }
  return {
    reply_markup: {
      inline_keyboard: [
        ...resultButtonRows,
        ...(input.results.length > SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE
          ? [
              [
                {
                  callback_data: `${input.callbackPrefix}search_page:${input.sessionId}:${Math.max(0, page - 1)}`,
                  text:
                    page === 0
                      ? `· Page ${page + 1}/${pageCount}`
                      : "⬅️ Previous",
                },
                {
                  callback_data: `${input.callbackPrefix}search_page:${input.sessionId}:${Math.min(pageCount - 1, page + 1)}`,
                  text:
                    page === pageCount - 1
                      ? `Page ${page + 1}/${pageCount} ·`
                      : "Next ➡️",
                },
              ],
            ]
          : []),
        [
          {
            callback_data: `${input.callbackPrefix}trading:market_input`,
            text: "🔎 New search",
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

export function buildSignalBotMarketVenuePickerScreen(input: {
  callbackPrefix: string;
  result: SignalBotMarketSearchResult;
  resultIndex: number;
  sessionId: string;
}): SignalBotMarketSearchMessage {
  const returnPage = Math.floor(
    input.resultIndex / SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE,
  );
  const identity = buildTelegramMarketIdentity({
    eventTitle: input.result.eventTitle,
    marketTitle: input.result.marketTitle,
  });
  const options = venueOptions(input.result);
  return {
    reply_markup: {
      inline_keyboard: [
        ...options.map((option, optionIndex) => [
          {
            callback_data: `${input.callbackPrefix}search_venue:${input.sessionId}:${input.resultIndex}:${optionIndex}`,
            icon_custom_emoji_id: formatTelegramVenueButtonIcon(option.venue),
            text: compactTelegramText(
              `${formatTelegramVenueLabel(option.venue)} · YES ${price(option.yesAsk)}`,
              TELEGRAM_INLINE_BUTTON_GRAPHEME_LIMIT,
            ),
          },
        ]),
        [
          {
            callback_data: `${input.callbackPrefix}search_back:${input.sessionId}:${returnPage}`,
            text: "⬅️ Back to results",
          },
          {
            callback_data: `${input.callbackPrefix}home`,
            text: "🏠 Home",
          },
        ],
      ],
    },
    text: [
      `🌐 ${bold("Choose a venue")}`,
      "",
      bold(compactTelegramText(identity.lines[0], 180)),
      ...(identity.lines[1]
        ? [
            `🎯 ${formatTelegramFieldWithMarkdownV2(
              "Market",
              escapeTelegramMarkdownV2(
                compactTelegramText(identity.lines[1], 180),
              ),
            )}`,
          ]
        : []),
      "",
      escapeTelegramMarkdownV2(
        `This market is available on ${options.length} venues. Choose where to trade.`,
      ),
      "",
      ...options.map(
        (option) =>
          `${formatTelegramVenueFieldMarkdownV2(option.venue)} ${escapeTelegramMarkdownV2(
            "·",
          )} ${formatTelegramFieldWithMarkdownV2(
            "Odds",
            escapeTelegramMarkdownV2(
              `YES ${price(option.yesAsk)} · NO ${price(option.noAsk)}`,
            ),
          )}`,
      ),
    ].join("\n"),
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
            text: "🔄 Try again",
          },
          {
            callback_data: `${input.callbackPrefix}home`,
            text: "🏠 Home",
          },
        ],
      ],
    },
    text: [
      `🔎 ${bold("Markets")}`,
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(
          "Search is temporarily unavailable. Send another search to try again.",
        ),
        icon: "⚠️",
        title: "Search unavailable",
      }),
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
            text: "🔎 New search",
          },
          {
            callback_data: `${input.callbackPrefix}home`,
            text: "🏠 Home",
          },
        ],
      ],
    },
    text: [
      `🔎 ${bold("Markets")}`,
      "",
      escapeTelegramMarkdownV2(
        "Send a market name, person, team, market URL, or market ID.",
      ),
      "",
      formatTelegramItalicMarkdownV2("Enter at least 2 characters."),
    ].join("\n"),
  };
}

export function buildSignalBotMarketSearchProgressScreen(): SignalBotMarketSearchMessage {
  return {
    reply_markup: { inline_keyboard: [] },
    text: [
      `🔎 ${bold("Markets")}`,
      "",
      escapeTelegramMarkdownV2("Searching…"),
    ].join("\n"),
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
            text: "⬅️ Back to results",
          },
          {
            callback_data: `${input.callbackPrefix}home`,
            text: "🏠 Home",
          },
        ],
      ],
    },
    text: formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2: escapeTelegramMarkdownV2(
        input.temporary
          ? "Market details could not be refreshed. Try again or return to the results."
          : "Market is no longer available.",
      ),
      icon: "⚠️",
      title: input.temporary
        ? "Market temporarily unavailable"
        : "Market unavailable",
    }),
  };
}
