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

type ActiveTelegramDeposit = Readonly<{
  canCancel: boolean;
  venue: TelegramDepositVenue;
}>;

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
    return (["polymarket", "limitless"] as const).filter((venue) =>
      input.dependencies?.allowedVenues?.includes(venue),
    );
  }
  const resolved = await filterVenuesForLifecycleCapability(
    input.db,
    ["polymarket", "limitless"],
    "increaseExposure",
  );
  return resolved.venues.filter(
    (venue): venue is TelegramDepositVenue =>
      venue === "polymarket" || venue === "limitless",
  );
}

async function resolveActiveTelegramDeposit(input: {
  db: DbQuery;
  telegramUserId?: string | number;
}): Promise<ActiveTelegramDeposit | null> {
  if (input.telegramUserId == null) return null;
  const result = await input.db.query<{
    has_received: boolean;
    venue_id: string;
  }>(
    `
      select
        receive_session.venue_id,
        exists (
          select 1
          from funding_receive_receipts receive_receipt
          where receive_receipt.receive_session_id = receive_session.id
        ) as has_received
      from user_telegram_accounts telegram_account
      join telegram_funding_sessions funding_context
        on funding_context.user_id = telegram_account.user_id
       and funding_context.telegram_account_id = telegram_account.id
       and funding_context.telegram_user_id = telegram_account.telegram_user_id
      join funding_receive_sessions receive_session
        on receive_session.id = funding_context.receive_session_id
       and receive_session.user_id = funding_context.user_id
       and receive_session.owner_channel = 'telegram'
      where telegram_account.telegram_user_id = $1
        and funding_context.cancelled_at is null
        and funding_context.latest_terminal_projection is null
        and funding_context.expires_at > now()
        and receive_session.status in ('open', 'processing', 'review_required')
        and receive_session.expires_at > now()
        and receive_session.venue_id in ('polymarket', 'limitless')
      order by funding_context.created_at desc, funding_context.id desc
      limit 1
    `,
    [String(input.telegramUserId)],
  );
  const activeDeposit = result.rows[0];
  const venue = activeDeposit?.venue_id;
  return venue === "polymarket" || venue === "limitless"
    ? { canCancel: activeDeposit.has_received !== true, venue }
    : null;
}

function buildDepositVenueMenu(
  venues: readonly TelegramDepositVenue[],
  activeDeposit: ActiveTelegramDeposit | null,
): TelegramDepositMessage {
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        ...(activeDeposit
          ? [
              activeDeposit.canCancel
                ? [
                    {
                      callback_data: `hm:v1:deposit:${activeDeposit.venue}`,
                      text: "🔄 Active Deposit",
                    },
                    {
                      callback_data: "hm:v1:deposit_cancel_active",
                      text: "Cancel active",
                    },
                  ]
                : [
                    {
                      callback_data: `hm:v1:deposit:${activeDeposit.venue}`,
                      text: "🔄 Active Deposit",
                    },
                  ],
            ]
          : []),
        [
          {
            callback_data: "hm:v1:deposit:any",
            text: "💳 Any / Just Deposit",
          },
        ],
        ...venues.map((venue) => [
          {
            callback_data: `hm:v1:deposit:${venue}`,
            icon_custom_emoji_id: telegramCustomEmojiIdForVenue(venue),
            text: depositVenueLabel(venue),
          },
        ]),
      ],
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

function buildJustDepositMenu(): TelegramDepositMessage {
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: "hm:v1:deposit_route:pd",
            text: "pUSD · Polygon · Direct",
          },
          {
            callback_data: "hm:v1:deposit_route:pw",
            text: "USDC.e · Polygon",
          },
        ],
        [
          {
            callback_data: "hm:v1:deposit_route:ld",
            text: "USDC · Base · Limitless",
          },
        ],
        [{ callback_data: "hm:v1:deposit", text: "⬅️ Back" }],
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      buildDepositTitleMarkdownV2(),
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(
          "Choose the network and asset you already have. Hunch will deposit it directly or automatically prepare the venue asset.",
        ),
        icon: "💳",
        title: "Any / Just Deposit",
      }),
      "",
      `${telegramCustomEmojiMarkdownV2ForNetwork("Polygon")} ${formatTelegramFieldMarkdownV2("Polygon", "pUSD direct · USDC.e → pUSD")}`,
      `${telegramCustomEmojiMarkdownV2ForNetwork("Base")} ${formatTelegramFieldMarkdownV2("Base", "USDC direct to Limitless")}`,
      "",
      escapeTelegramMarkdownV2(
        "Relay routes that require a target venue are available after choosing that venue, not from Just Deposit.",
      ),
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
  telegramUserId?: string | number;
  venue?: string | null;
}): Promise<TelegramDepositMessage> {
  const requestedVenue = input.venue?.trim().toLowerCase() || null;
  if (!requestedVenue) {
    const [venues, activeDeposit] = await Promise.all([
      resolveDepositVenues({
        db: input.pool,
        dependencies: input.dependencies,
      }),
      resolveActiveTelegramDeposit({
        db: input.pool,
        telegramUserId: input.telegramUserId,
      }),
    ]);
    return buildDepositVenueMenu(venues, activeDeposit);
  }
  if (requestedVenue === "any") return buildJustDepositMenu();
  // Financial addresses have one egress gateway: the durable funding outbox.
  // Explicit legacy callbacks (including future Relay venues) fail closed here.
  return buildLegacyDepositUnavailableMessage(requestedVenue);
}
