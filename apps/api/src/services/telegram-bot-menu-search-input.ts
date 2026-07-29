import {
  buildSignalBotMarketSearchProgressScreen,
  buildSignalBotMarketSearchScreen,
  buildSignalBotMarketSearchUnavailableScreen,
  writeSignalBotMarketSearchSession,
  type SignalBotMarketSearchResult,
} from "./telegram-bot-menu-markets.js";
import {
  clearSignalBotMenuInput,
  readSignalBotMenuInput,
  writeSignalBotMenuInput,
} from "./telegram-bot-menu-state.js";

type SearchInputRedis = {
  del(key: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

type SearchMessage = {
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: {
    inline_keyboard: Array<
      Array<
        | { callback_data: string; text: string }
        | { copy_text: { text: string }; text: string }
        | { text: string; url: string }
        | { text: string; web_app: { url: string } }
      >
    >;
  };
  text: string;
};

const CANONICAL_MARKET_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDirectMarketReference(value: string): boolean {
  const normalized = value.trim();
  return (
    /^https?:\/\//i.test(normalized) ||
    /^(polymarket|limitless|kalshi):.+/i.test(normalized) ||
    /^\d+$/.test(normalized) ||
    CANONICAL_MARKET_UUID.test(normalized)
  );
}

export async function handleSignalBotMarketSearchInput(input: {
  beginResponse?: (message: SearchMessage) => Promise<number | null>;
  callbackPrefix: string;
  chatId: string;
  loadMarketCard?: (input: {
    chatId: string;
    marketRef: string;
    telegramMessageId: number | null;
    telegramUserId: number;
  }) => Promise<SearchMessage>;
  redis: SearchInputRedis;
  render: (
    message: SearchMessage,
    messageId: number | null,
  ) => Promise<unknown>;
  renderCancelled: (messageId: number | null) => Promise<unknown>;
  searchMarkets?: (input: {
    query?: string | null;
  }) => Promise<SignalBotMarketSearchResult[]>;
  telegramUserId: number;
  text: string;
}): Promise<boolean> {
  const state = await readSignalBotMenuInput(input);
  if (state && state.kind !== "awaiting_market_query") return false;
  const query = input.text.trim();
  if (!query) return false;
  if (query.startsWith("/")) {
    if (!state) return false;
    await clearSignalBotMenuInput(input);
    await input.renderCancelled(state.menuMessageId);
    return true;
  }

  const responseMessageId =
    (await input
      .beginResponse?.(buildSignalBotMarketSearchProgressScreen())
      .catch(() => null)) ??
    state?.menuMessageId ??
    null;
  await writeSignalBotMenuInput({
    chatId: input.chatId,
    menuMessageId: responseMessageId,
    redis: input.redis,
    telegramUserId: input.telegramUserId,
  });

  const looksDirect = isDirectMarketReference(query);
  if (looksDirect && input.loadMarketCard) {
    try {
      const message = await input.loadMarketCard({
        chatId: input.chatId,
        marketRef: query,
        telegramMessageId: responseMessageId,
        telegramUserId: input.telegramUserId,
      });
      if (message.marketFound === false) {
        await writeSignalBotMenuInput({
          chatId: input.chatId,
          menuMessageId: responseMessageId,
          redis: input.redis,
          telegramUserId: input.telegramUserId,
        });
        await input.render(
          buildSignalBotMarketSearchScreen({
            callbackPrefix: input.callbackPrefix,
            query,
            results: [],
            sessionId: "direct",
          }),
          responseMessageId,
        );
        return true;
      }
      await clearSignalBotMenuInput(input);
      await input.render(message, responseMessageId);
      return true;
    } catch {
      await writeSignalBotMenuInput({
        chatId: input.chatId,
        menuMessageId: responseMessageId,
        redis: input.redis,
        telegramUserId: input.telegramUserId,
      });
      await input.render(
        buildSignalBotMarketSearchUnavailableScreen({
          callbackPrefix: input.callbackPrefix,
        }),
        responseMessageId,
      );
      return true;
    }
  }

  let results: SignalBotMarketSearchResult[];
  try {
    if (!input.searchMarkets) throw new Error("market_search_unavailable");
    results = await input.searchMarkets({ query });
  } catch {
    await writeSignalBotMenuInput({
      chatId: input.chatId,
      menuMessageId: responseMessageId,
      redis: input.redis,
      telegramUserId: input.telegramUserId,
    });
    await input.render(
      buildSignalBotMarketSearchUnavailableScreen({
        callbackPrefix: input.callbackPrefix,
      }),
      responseMessageId,
    );
    return true;
  }
  const sessionId = await writeSignalBotMarketSearchSession({
    chatId: input.chatId,
    query,
    redis: input.redis,
    results,
    telegramUserId: input.telegramUserId,
  });
  if (results.length > 0) {
    await clearSignalBotMenuInput(input);
  } else {
    await writeSignalBotMenuInput({
      chatId: input.chatId,
      menuMessageId: responseMessageId,
      redis: input.redis,
      telegramUserId: input.telegramUserId,
    });
  }
  await input.render(
    buildSignalBotMarketSearchScreen({
      callbackPrefix: input.callbackPrefix,
      query,
      results,
      sessionId,
    }),
    responseMessageId,
  );
  return true;
}
