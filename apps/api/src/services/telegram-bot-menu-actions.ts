import { generateTelegramDepositQr } from "./telegram-bot-deposit-qr.js";
import {
  buildSignalBotMarketUnavailableResultScreen,
  buildSignalBotMarketSearchScreen,
  readSignalBotMarketSearchSession,
} from "./telegram-bot-menu-markets.js";
import { escapeTelegramMarkdownV2 } from "./telegram-bot-trading-presentation.js";

export type SignalBotInteractiveMenuRoute =
  | { kind: "deposit"; showQr: boolean; venue: string }
  | { index: number; kind: "market_search_result"; sessionId: string }
  | { kind: "market_search_back"; sessionId: string }
  | { kind: "position"; positionId: string };

export function parseSignalBotInteractiveMenuRoute(
  route: string,
): SignalBotInteractiveMenuRoute | null {
  const searchMatch = route.match(/^search:([a-f0-9]{12}):(\d)$/i);
  if (searchMatch) {
    return {
      index: Number(searchMatch[2]),
      kind: "market_search_result",
      sessionId: searchMatch[1] ?? "",
    };
  }
  const searchBackMatch = route.match(/^search_back:([a-f0-9]{12})$/i);
  if (searchBackMatch) {
    return {
      kind: "market_search_back",
      sessionId: searchBackMatch[1] ?? "",
    };
  }
  const positionMatch = route.match(
    /^pos:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (positionMatch) {
    return { kind: "position", positionId: positionMatch[1] ?? "" };
  }
  if (route === "deposit") {
    return { kind: "deposit", showQr: false, venue: "polymarket" };
  }
  const depositMatch = route.match(/^(deposit|deposit_qr):([a-z0-9_-]+)$/i);
  if (!depositMatch) return null;
  return {
    kind: "deposit",
    showQr: depositMatch[1] === "deposit_qr",
    venue: depositMatch[2] ?? "polymarket",
  };
}

type MenuButton =
  | { callback_data: string; text: string }
  | { copy_text: { text: string }; text: string }
  | { text: string; url: string }
  | { text: string; web_app: { url: string } };

type MenuMessage = {
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: { inline_keyboard: MenuButton[][] };
  text: string;
};

type MenuRedis = {
  get(key: string): Promise<string | null>;
};

export async function handleSignalBotInteractiveMenuCallback(input: {
  callbackPrefix: string;
  chatId: string;
  loadDeposit?: (input: {
    telegramUserId: number;
    venue: string;
  }) => Promise<MenuMessage & { qrText?: string }>;
  loadMarketCard?: (input: {
    chatId: string;
    context: { origin: "search"; returnCallbackData: string };
    marketRef: string;
    telegramMessageId: number | null;
    telegramUserId: number;
  }) => Promise<MenuMessage>;
  loadPositionCard?: (input: {
    positionId: string;
    telegramUserId: number;
  }) => Promise<MenuMessage>;
  messageId: number | null;
  redis: MenuRedis;
  render: (message: MenuMessage) => Promise<unknown>;
  renderExpiredSearch: () => Promise<unknown>;
  route: SignalBotInteractiveMenuRoute;
  sendPhoto?: (input: {
    caption?: string;
    chat_id: string;
    filename: string;
    parse_mode?: "MarkdownV2";
    photo: Uint8Array;
    reply_markup?: { inline_keyboard: MenuButton[][] };
  }) => Promise<unknown>;
  telegramUserId: number;
}): Promise<boolean> {
  const { route } = input;
  if (
    route.kind === "market_search_result" ||
    route.kind === "market_search_back"
  ) {
    const session = await readSignalBotMarketSearchSession({
      chatId: input.chatId,
      redis: input.redis,
      sessionId: route.sessionId,
      telegramUserId: input.telegramUserId,
    });
    if (!session) {
      await input.renderExpiredSearch();
      return true;
    }
    if (route.kind === "market_search_back") {
      await input.render(
        buildSignalBotMarketSearchScreen({
          callbackPrefix: input.callbackPrefix,
          query: session.query,
          results: session.results,
          sessionId: route.sessionId,
        }),
      );
      return true;
    }
    const selected = session.results[route.index];
    if (!selected || !input.loadMarketCard) {
      await input.renderExpiredSearch();
      return true;
    }
    try {
      const marketMessage = await input.loadMarketCard({
        chatId: input.chatId,
        context: {
          origin: "search",
          returnCallbackData: `${input.callbackPrefix}search_back:${route.sessionId}`,
        },
        marketRef: selected.marketId,
        telegramMessageId: input.messageId,
        telegramUserId: input.telegramUserId,
      });
      await input.render(
        marketMessage.marketFound === false
          ? buildSignalBotMarketUnavailableResultScreen({
              callbackPrefix: input.callbackPrefix,
              sessionId: route.sessionId,
            })
          : marketMessage,
      );
    } catch {
      await input.render(
        buildSignalBotMarketUnavailableResultScreen({
          callbackPrefix: input.callbackPrefix,
          sessionId: route.sessionId,
          temporary: true,
        }),
      );
    }
    return true;
  }
  if (route.kind === "position") {
    let positionMessage: MenuMessage;
    try {
      positionMessage = input.loadPositionCard
        ? await input.loadPositionCard({
            positionId: route.positionId,
            telegramUserId: input.telegramUserId,
          })
        : {
            parse_mode: "MarkdownV2",
            text: "Position is unavailable right now\\.",
          };
    } catch {
      positionMessage = {
        parse_mode: "MarkdownV2",
        text: "Position is unavailable right now\\.",
      };
    }
    await input.render(positionMessage);
    return true;
  }
  let depositMessage: MenuMessage & { qrText?: string };
  try {
    depositMessage = input.loadDeposit
      ? await input.loadDeposit({
          telegramUserId: input.telegramUserId,
          venue: route.venue,
        })
      : {
          parse_mode: "MarkdownV2" as const,
          text: "Deposit is unavailable right now\\.",
        };
  } catch {
    depositMessage = {
      parse_mode: "MarkdownV2",
      text: "Deposit is unavailable right now\\.",
    };
  }
  if (!route.showQr) {
    await input.render({
      ...depositMessage,
      reply_markup: {
        inline_keyboard: [
          ...(depositMessage.reply_markup?.inline_keyboard ?? []),
          [
            {
              callback_data: input.callbackPrefix + "home",
              text: "🏠 Home",
            },
          ],
        ],
      },
    });
  }
  if (route.showQr && depositMessage.qrText && input.sendPhoto) {
    try {
      const qr = await generateTelegramDepositQr(depositMessage.qrText);
      await input.sendPhoto({
        caption: [
          `*${escapeTelegramMarkdownV2("Hunch deposit address")}*`,
          "",
          escapeTelegramMarkdownV2(depositMessage.qrText),
          "",
          escapeTelegramMarkdownV2("Polygon · pUSD or USDC.e"),
        ].join("\n"),
        chat_id: input.chatId,
        filename: "hunch-polymarket-deposit.png",
        parse_mode: "MarkdownV2",
        photo: qr,
        reply_markup: {
          inline_keyboard: [
            [
              {
                copy_text: { text: depositMessage.qrText },
                text: "Copy address",
              },
            ],
          ],
        },
      });
    } catch {
      // The address remains visible and copyable in the edited menu card.
    }
  }
  return true;
}
