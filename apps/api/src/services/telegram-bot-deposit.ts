import type { DbQuery } from "../db.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramCalloutMarkdownV2,
  formatTelegramFieldMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";
import { filterVenuesForLifecycleCapability } from "./venue-lifecycle.js";
import {
  telegramCustomEmojiIdForVenue,
  telegramCustomEmojiMarkdownV2,
  telegramCustomEmojiMarkdownV2ForNetwork,
  telegramCustomEmojiMarkdownV2ForVenue,
} from "./telegram-custom-emoji.js";

export type TelegramDepositVenue = "limitless" | "polymarket";

export type TelegramDepositMessage = TelegramBotTradingClientMessage & {
  venue?: TelegramDepositVenue;
};

export type TelegramDepositResolverDependencies = {
  allowedVenues?: readonly TelegramDepositVenue[];
};

function depositVenueLabel(venue: TelegramDepositVenue): string {
  return venue === "polymarket" ? "Polymarket" : "Limitless";
}

function depositNetwork(venue: TelegramDepositVenue): "Base" | "Polygon" {
  return venue === "polymarket" ? "Polygon" : "Base";
}

function depositAssetLabel(venue: TelegramDepositVenue): string {
  return venue === "polymarket" ? "pUSD" : "USDC";
}

function buildDepositTitleMarkdownV2(venue?: TelegramDepositVenue): string {
  const emoji = venue
    ? telegramCustomEmojiMarkdownV2ForVenue(venue)
    : telegramCustomEmojiMarkdownV2("usdc");
  const label = venue ? `${depositVenueLabel(venue)} Deposit` : "Deposit";
  return `${emoji ?? telegramCustomEmojiMarkdownV2("usdc")} *${escapeTelegramMarkdownV2(label)}*`;
}

function buildDepositVenueSummaryMarkdownV2(
  venue: TelegramDepositVenue,
): string {
  const network = depositNetwork(venue);
  return [
    `${telegramCustomEmojiMarkdownV2ForVenue(venue)} ${formatTelegramFieldMarkdownV2(
      "Venue",
      depositVenueLabel(venue),
    )}`,
    `${telegramCustomEmojiMarkdownV2ForNetwork(network)} ${formatTelegramFieldMarkdownV2(
      "Network",
      network,
    )}`,
    `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramFieldMarkdownV2(
      venue === "polymarket" ? "Assets" : "Asset",
      depositAssetLabel(venue),
    )}`,
  ].join("\n");
}

async function resolveDepositVenues(input: {
  db: DbQuery;
  dependencies?: TelegramDepositResolverDependencies;
}): Promise<TelegramDepositVenue[]> {
  if (input.dependencies?.allowedVenues) {
    return input.dependencies.allowedVenues.includes("polymarket")
      ? ["polymarket"]
      : [];
  }
  const resolved = await filterVenuesForLifecycleCapability(
    input.db,
    ["polymarket"],
    "increaseExposure",
  );
  return resolved.venues.filter(
    (venue): venue is TelegramDepositVenue => venue === "polymarket",
  );
}

function buildDepositVenueMenu(
  venues: readonly TelegramDepositVenue[],
): TelegramDepositMessage {
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: venues.map((venue) => [
        {
          callback_data: `hm:v1:deposit:${venue}`,
          icon_custom_emoji_id: telegramCustomEmojiIdForVenue(venue),
          text: depositVenueLabel(venue),
        },
      ]),
    },
    text: joinTelegramMarkdownV2Lines([
      buildDepositTitleMarkdownV2(),
      "",
      escapeTelegramMarkdownV2("Choose a trading venue."),
      "",
      ...(venues.includes("polymarket")
        ? [buildDepositVenueSummaryMarkdownV2("polymarket"), ""]
        : []),
      ...(venues.includes("limitless")
        ? [buildDepositVenueSummaryMarkdownV2("limitless")]
        : []),
      ...(venues.length === 0
        ? [
            formatTelegramCalloutMarkdownV2({
              bodyMarkdownV2: escapeTelegramMarkdownV2(
                "No trading venue can be funded right now.",
              ),
              icon: "⚠️",
              title: "Funding unavailable",
            }),
          ]
        : []),
    ]),
  };
}

function buildLegacyDepositUnavailableMessage(
  requestedVenue: string,
): TelegramDepositMessage {
  const venue =
    requestedVenue === "polymarket" || requestedVenue === "limitless"
      ? requestedVenue
      : undefined;
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [{ callback_data: "hm:v1:deposit", text: "⬅️ Back to Receive" }],
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      buildDepositTitleMarkdownV2(venue),
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(
          "This legacy deposit route is unavailable. Open Receive again.",
        ),
        icon: "⚠️",
        title: "Receive unavailable",
      }),
    ]),
  };
}

export async function buildTelegramDepositMessage(input: {
  dependencies?: TelegramDepositResolverDependencies;
  pool: DbQuery;
  venue?: string | null;
}): Promise<TelegramDepositMessage> {
  const requestedVenue = input.venue?.trim().toLowerCase() || null;
  if (!requestedVenue) {
    return buildDepositVenueMenu(
      await resolveDepositVenues({
        db: input.pool,
        dependencies: input.dependencies,
      }),
    );
  }
  // Financial addresses have one egress gateway: the durable funding outbox.
  // Explicit legacy callbacks (including future Relay venues) fail closed here.
  return buildLegacyDepositUnavailableMessage(requestedVenue);
}
