import type { DbQuery } from "../db.js";
import { findTradeMarketById } from "./api-trading-market-repo.js";
import { readHip4Policy } from "./hip4-repository.js";
import {
  buildSignalBotBuyStartParam,
  buildSignalBotMarketStartParam,
} from "./signal-bot-mini-app-links.js";
import { buildHunchMiniAppWebButton } from "./telegram-mini-app-buttons.js";
import {
  normalizeTelegramMarketRef,
  readTelegramMarketLinkSide,
} from "./telegram-market-reference.js";
import {
  buildTelegramMarketIdentity,
  formatTelegramVenueLabelMarkdownV2,
} from "./telegram-market-identity.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
} from "./telegram-bot-trading-presentation.js";
import type { TelegramBotTradingMessage } from "./telegram-bot-trading.js";
import { outcomeLabelOrSide } from "./wallet-intel-helpers.js";

type NavigationMarket = Readonly<{
  id: string;
  event_id: string;
  event_title: string | null;
  title: string;
  venue: string;
  status: string;
  outcomes?: unknown;
}>;

/** Read-only app navigation is not a bot executor or a sealed trade capability. */
export async function buildTelegramAppMarketNavigation(
  input: Readonly<{
    db: DbQuery;
    marketRef: string;
    appBaseUrl: string;
    telegramMiniAppEnabled?: boolean;
    side?: "YES" | "NO" | null;
    returnCallbackData?: string | null;
  }>,
  dependencies: Readonly<{
    readPolicy?: (db: DbQuery) => Promise<{
      policy: { enabled: boolean; environment: "mainnet" | "testnet" };
    }>;
    readMarket?: (db: DbQuery, id: string) => Promise<NavigationMarket | null>;
  }> = {},
): Promise<TelegramBotTradingMessage | null> {
  const marketRef = normalizeTelegramMarketRef(input.marketRef) ?? "";
  if (!marketRef.startsWith("hyperliquid:")) return null;
  const unavailable: TelegramBotTradingMessage = {
    marketFound: false,
    text: "This market is unavailable. Open Hunch to browse available markets.",
  };
  const identity = /^hyperliquid:(mainnet|testnet):outcome:(0|[1-9]\d*)$/.exec(
    marketRef,
  );
  if (!identity || marketRef.length > 80) return unavailable;
  // The same policy as the ordinary public market API, before even reading a
  // saved row. No legacy canary allowlist or server-signer grant is involved.
  const { policy } = await (dependencies.readPolicy ?? readHip4Policy)(
    input.db,
  );
  if (!policy.enabled || policy.environment !== identity[1]) return unavailable;
  const market = await (dependencies.readMarket ?? findTradeMarketById)(
    input.db,
    marketRef,
  );
  if (
    !market ||
    market.venue !== "hyperliquid" ||
    market.id !== marketRef ||
    !new RegExp(
      `^hyperliquid:${policy.environment}:(question|outcome):(0|[1-9]\\d*)$`,
    ).test(market.event_id)
  )
    return unavailable;

  const focusedSide = input.side ?? readTelegramMarketLinkSide(input.marketRef);
  const startParam = buildSignalBotMarketStartParam({
    eventId: market.event_id,
    marketId: market.id,
    side: focusedSide,
  });
  if (!startParam) return unavailable;
  const button = buildHunchMiniAppWebButton({
    appBaseUrl: input.appBaseUrl,
    enabled: input.telegramMiniAppEnabled === true,
    startParam,
    text: "Open market in Hunch",
  });
  // Reuse the ordinary editable buy-link contract. It opens the app ticket;
  // it does not grant a bot signer, create an intent or confirm an order.
  const reviewButtons =
    market.status === "ACTIVE"
      ? (focusedSide ? [focusedSide] : (["YES", "NO"] as const)).flatMap(
          (side) => {
            const review = buildHunchMiniAppWebButton({
              appBaseUrl: input.appBaseUrl,
              enabled: input.telegramMiniAppEnabled === true,
              startParam: buildSignalBotBuyStartParam({
                eventId: market.event_id,
                marketId: market.id,
                side,
              }),
              text: `Review ${outcomeLabelOrSide(market.outcomes, side)} in Hunch`,
            });
            return review ? [review] : [];
          },
        )
      : [];
  const marketIdentity = buildTelegramMarketIdentity({
    eventTitle: market.event_title,
    marketTitle: market.title,
  });
  return {
    marketFound: true,
    parse_mode: "MarkdownV2",
    text: [
      ...marketIdentity.lines.map(formatTelegramBoldMarkdownV2),
      "",
      formatTelegramVenueLabelMarkdownV2(market.venue),
      escapeTelegramMarkdownV2("Open this market in Hunch."),
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        ...(button ? [[button]] : []),
        ...(reviewButtons.length ? [reviewButtons] : []),
        [
          {
            text: input.returnCallbackData ? "⬅️ Back" : "🏠 Home",
            callback_data: input.returnCallbackData ?? "hm:v1:home",
          },
        ],
      ],
    },
  };
}
