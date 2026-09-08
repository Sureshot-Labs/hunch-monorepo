import {
  buildSignalBotMarketUnavailableResultScreen,
  buildSignalBotMarketSearchScreen,
  buildSignalBotMarketVenuePickerScreen,
  readSignalBotMarketSearchSession,
  writeSignalBotMarketSearchSession,
  type SignalBotMarketSearchResult,
  SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE,
} from "./telegram-bot-menu-markets.js";
import type {
  SignalBotTelegramClient,
  TelegramBotCallbackQuery,
} from "./signal-bot-contracts.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramCalloutMarkdownV2,
} from "./telegram-bot-trading-presentation.js";
import {
  parseTelegramFundingCallbackRoute,
  type TelegramFundingCallbackRoute,
} from "./telegram-funding-contracts.js";
import {
  telegramFundingDepositRouteDescriptorForChoiceToken,
  type TelegramFundingDepositRouteKey,
} from "./telegram-funding-route.js";
import { parseTelegramMarketDeposit } from "./telegram-funding-navigation.js";

export type SignalBotFundingMenuRoute =
  | {
      kind: "deposit";
      showQr: boolean;
      venue: string;
      navigationMarketId?: string;
      navigationSide?: "YES" | "NO";
    }
  | {
      kind: "deposit_route";
      route: TelegramFundingDepositRouteKey;
      venue: "limitless" | "polymarket";
    }
  | { kind: "deposit_cancel_active" }
  | { kind: "deposit_menu" }
  | TelegramFundingCallbackRoute;

export type SignalBotInteractiveMenuRoute =
  | SignalBotFundingMenuRoute
  | { kind: "market_search_filters"; sessionId: string; venue?: string }
  | { index: number; kind: "market_search_result"; sessionId: string }
  | { kind: "market_search_back"; page: number; sessionId: string }
  | { kind: "market_search_page"; page: number; sessionId: string }
  | {
      index: number;
      kind: "market_search_venue";
      resultIndex: number;
      sessionId: string;
    }
  | { kind: "position"; positionId: string };

export function parseSignalBotInteractiveMenuRoute(
  route: string,
): SignalBotInteractiveMenuRoute | null {
  const funding = parseTelegramFundingCallbackRoute(route);
  if (funding) return funding;
  const filters = route.match(
    /^search_filters:([a-f0-9]{12})(?::(polymarket|limitless|kalshi|all|sort|categories|s_trending|s_totalvol|s_time|c_all|c_politics|c_sports|c_crypto|c_economics|c_tech|c_culture))?$/i,
  );
  if (filters)
    return {
      kind: "market_search_filters",
      sessionId: filters[1] ?? "",
      venue: filters[2]?.toLowerCase(),
    };
  const searchMatch = route.match(/^search:([a-f0-9]{12}):(\d{1,2})$/i);
  if (searchMatch) {
    return {
      index: Number(searchMatch[2]),
      kind: "market_search_result",
      sessionId: searchMatch[1] ?? "",
    };
  }
  const searchBackMatch = route.match(
    /^search_back:([a-f0-9]{12})(?::(\d{1,2}))?$/i,
  );
  if (searchBackMatch) {
    return {
      kind: "market_search_back",
      page: Number(searchBackMatch[2] ?? 0),
      sessionId: searchBackMatch[1] ?? "",
    };
  }
  const searchPageMatch = route.match(
    /^search_page:([a-f0-9]{12}):(\d{1,2})$/i,
  );
  if (searchPageMatch) {
    return {
      kind: "market_search_page",
      page: Number(searchPageMatch[2]),
      sessionId: searchPageMatch[1] ?? "",
    };
  }
  const searchVenueMatch = route.match(
    /^search_venue:([a-f0-9]{12}):(\d{1,2}):(\d)$/i,
  );
  if (searchVenueMatch) {
    return {
      index: Number(searchVenueMatch[3]),
      kind: "market_search_venue",
      resultIndex: Number(searchVenueMatch[2]),
      sessionId: searchVenueMatch[1] ?? "",
    };
  }
  const positionMatch = route.match(
    /^pos:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (positionMatch) {
    return { kind: "position", positionId: positionMatch[1] ?? "" };
  }
  if (route === "deposit") {
    return { kind: "deposit_menu" };
  }
  if (route === "deposit_cancel_active") {
    return { kind: "deposit_cancel_active" };
  }
  const depositMatch = route.match(/^(deposit|deposit_qr):([a-z0-9_-]+)$/i);
  const marketDeposit = parseTelegramMarketDeposit(route);
  if (marketDeposit)
    return { kind: "deposit", showQr: false, ...marketDeposit };
  const depositRouteMatch = route.match(/^deposit_route:([a-z0-9]{1,8})$/i);
  if (depositRouteMatch) {
    const token = depositRouteMatch[1]?.toLowerCase();
    const descriptor = token
      ? telegramFundingDepositRouteDescriptorForChoiceToken(token)
      : null;
    if (!descriptor) return null;
    return {
      kind: "deposit_route",
      route: descriptor.routeKey,
      venue: descriptor.venueId,
    };
  }
  if (!depositMatch) return null;
  return {
    kind: "deposit",
    showQr: depositMatch[1] === "deposit_qr",
    venue: depositMatch[2] ?? "polymarket",
  };
}

export function isSignalBotFundingMenuRoute(
  route: Readonly<{ kind: string; venue?: string }>,
): route is SignalBotFundingMenuRoute {
  return signalBotFundingMenuAction(route) != null;
}

/** Only callbacks whose response is owned by the durable funding outbox hand
 * over their message generation. Navigation/cancel callbacks keep ownership. */
export function menuRenderToken(
  route: Readonly<{ kind: string; venue?: string }>,
  callbackQueryId: string,
): string {
  return route.kind === "deposit" ||
    route.kind === "deposit_route" ||
    route.kind === "select" ||
    route.kind === "refresh" ||
    route.kind === "qr" ||
    route.kind === "confirm_conversion"
    ? `funding:callback:${callbackQueryId}`
    : callbackQueryId;
}

export async function hideSignalBotFundingQr(
  callbackQuery: TelegramBotCallbackQuery,
  telegram: SignalBotTelegramClient,
): Promise<true> {
  const message = callbackQuery.message;
  const senderId = callbackQuery.from?.id;
  const deleteMessage = telegram.deleteMessage?.bind(telegram);
  if (
    message?.message_id == null ||
    senderId == null ||
    String(message.chat.id) !== String(senderId) ||
    !deleteMessage
  ) {
    await telegram.answerCallbackQuery({
      callbackQueryId: callbackQuery.id,
      showAlert: true,
      text: "⚠️ This QR could not be hidden.",
    });
    return true;
  }
  const deleted = await deleteMessage({
    chat_id: String(message.chat.id),
    message_id: message.message_id,
  }).catch(() => ({ ok: false as const }));
  await telegram.answerCallbackQuery({
    callbackQueryId: callbackQuery.id,
    ...(!deleted.ok
      ? { showAlert: true, text: "⚠️ This QR could not be hidden." }
      : { text: "QR hidden." }),
  });
  return true;
}

export type SignalBotFundingMenuAction =
  | "back_to_market"
  | "cancel"
  | "cancel_active"
  | "change_buy_amount"
  | "confirm_conversion"
  | "open"
  | "open_route"
  | "review_conversion"
  | "resume_buy"
  | "select"
  | "session";

export function signalBotFundingMenuAction(
  route: Readonly<{ kind: string; venue?: string }>,
): SignalBotFundingMenuAction | null {
  return route.kind === "select"
    ? "select"
    : route.kind === "change_buy_amount"
      ? "change_buy_amount"
      : route.kind === "review_buy"
        ? "resume_buy"
        : route.kind === "confirm_conversion"
          ? "confirm_conversion"
          : route.kind === "review_conversion"
            ? "review_conversion"
            : route.kind === "back_to_market"
              ? "back_to_market"
              : route.kind === "deposit_cancel_active"
                ? "cancel_active"
                : route.kind === "cancel"
                  ? "cancel"
                  : route.kind === "refresh" ||
                      route.kind === "qr" ||
                      route.kind === "targets"
                    ? "session"
                    : route.kind === "deposit_route"
                      ? "open_route"
                      : route.kind === "deposit" &&
                          (route.venue === "polymarket" ||
                            route.venue === "limitless")
                        ? "open"
                        : null;
}

type MenuButton =
  | { callback_data: string; text: string }
  | { copy_text: { text: string }; text: string }
  | { text: string; url: string }
  | { text: string; web_app: { url: string } };

type MenuMessage = {
  durableFundingDeliveryRequired?: boolean;
  fundingContextId?: string;
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: { inline_keyboard: MenuButton[][] };
  text: string;
  venue?: string;
};

type MenuRedis = {
  set?(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

export type SignalBotInteractiveMenuLoaders = {
  deposit: (input: {
    telegramUserId: number;
    venue: string | null;
  }) => Promise<MenuMessage & { qrText?: string }>;
  funding: (input: {
    action:
      | "back_to_market"
      | "cancel"
      | "cancel_active"
      | "change_buy_amount"
      | "confirm_conversion"
      | "open"
      | "open_route"
      | "review_conversion"
      | "resume_buy"
      | "select"
      | "session";
    chatId: string;
    choiceToken?: string;
    consentToken?: string;
    contextId?: string;
    continuationToken?: string;
    fundingRoute?:
      | "limitless_base_usdc_direct_v1"
      | "limitless_solana_sol_retained_v1"
      | "polymarket_solana_usdc_retained_v1"
      | "limitless_solana_usdc_retained_v1"
      | "polymarket_polygon_pusd_direct_v1"
      | "polymarket_solana_sol_retained_v1";
    idempotencyKey: string;
    navigationMarketId?: string;
    navigationSide?: "YES" | "NO";
    receiptId?: string;
    requestObservation?: boolean;
    telegramMessageId: number | null;
    telegramUserId: number;
    venue?: "limitless" | "polymarket";
    view?: "address" | "progress" | "targets";
  }) => Promise<MenuMessage & { qrText?: string }>;
};

type SignalBotInteractiveMenuCallbackInput = {
  searchOptions?: () => Promise<{ venues: string[] }>;
  searchMarkets?: (input: {
    category?: string;
    sort?: "trending" | "totalvol" | "time";
    query?: string | null;
    venues?: string[];
  }) => Promise<SignalBotMarketSearchResult[]>;
  callbackPrefix: string;
  chatId: string;
  loadDeposit?: SignalBotInteractiveMenuLoaders["deposit"];
  loadFunding?: SignalBotInteractiveMenuLoaders["funding"];
  loadMarketCard?: (input: {
    chatId: string;
    context: {
      observedNoAsk?: number | null;
      observedYesAsk?: number | null;
      origin: "search";
      returnCallbackData: string;
    };
    marketRef: string;
    publicBrowseOnly?: boolean;
    telegramMessageId: number | null;
    telegramUserId: number;
  }) => Promise<MenuMessage>;
  loadPositionCard?: (input: {
    messageId: number;
    positionId: string;
    telegramUserId: number;
  }) => Promise<MenuMessage>;
  messageId: number | null;
  idempotencyKey?: string;
  onFundingOperationError?: (action: SignalBotFundingMenuAction) => void;
  redis: MenuRedis;
  render: (message: MenuMessage) => Promise<unknown>;
  renderExpiredSearch: () => Promise<unknown>;
  route: SignalBotInteractiveMenuRoute;
  telegramUserId: number;
};

async function deliverSignalBotInteractiveMenuCallback(
  input: SignalBotInteractiveMenuCallbackInput,
): Promise<boolean> {
  const { route } = input;
  if (
    route.kind === "market_search_filters" ||
    route.kind === "market_search_result" ||
    route.kind === "market_search_back" ||
    route.kind === "market_search_page" ||
    route.kind === "market_search_venue"
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
    if (route.kind === "market_search_filters") {
      if (route.venue === "sort" || route.venue === "categories") {
        const choices =
          route.venue === "sort"
            ? [
                ["s_trending", "Trending"],
                ["s_totalvol", "Volume"],
                ["s_time", "Closing soon"],
              ]
            : [
                ["c_all", "All categories"],
                ["c_politics", "Politics"],
                ["c_sports", "Sports"],
                ["c_crypto", "Crypto"],
                ["c_economics", "Economics"],
                ["c_tech", "Tech"],
                ["c_culture", "Culture"],
              ];
        await input.render({
          text: route.venue === "sort" ? "↕️ Sort results" : "🗂 Category",
          reply_markup: {
            inline_keyboard: [
              ...choices.map(([value, label]) => [
                {
                  text: label ?? "",
                  callback_data: `${input.callbackPrefix}search_filters:${route.sessionId}:${value}`,
                },
              ]),
              [
                {
                  text: "⬅️ Results",
                  callback_data: `${input.callbackPrefix}search_back:${route.sessionId}:0`,
                },
              ],
            ],
          },
        });
        return true;
      }
      if (!route.venue) {
        const options = await input.searchOptions?.().catch(() => null);
        if (!options) {
          await input.render({
            text: escapeTelegramMarkdownV2(
              "Filters temporarily unavailable. Try again.",
            ),
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🔄 Retry",
                    callback_data: `${input.callbackPrefix}search_filters:${route.sessionId}`,
                  },
                ],
                [
                  {
                    text: "⬅️ Results",
                    callback_data: `${input.callbackPrefix}search_back:${route.sessionId}:0`,
                  },
                ],
              ],
            },
          });
          return true;
        }
        await input.render({
          text: escapeTelegramMarkdownV2(
            "⚙️ Search filters\nChoose a venue. Your search query is preserved.",
          ),
          reply_markup: {
            inline_keyboard: [
              ...[
                ["polymarket", "🔵 Polymarket"],
                ["limitless", "🟡 Limitless"],
                ["kalshi", "🟢 Kalshi"],
              ]
                .filter(([venue]) => options.venues.includes(venue ?? ""))
                .map(([venue, label]) => [
                  {
                    text: `${session.venues?.includes(venue ?? "") ? "✓ " : ""}${label}`,
                    callback_data: `${input.callbackPrefix}search_filters:${route.sessionId}:${venue}`,
                  },
                ]),
              [
                {
                  text: `🗂 Category (${session.category ?? "All"})`,
                  callback_data: `${input.callbackPrefix}search_filters:${route.sessionId}:categories`,
                },
              ],
              [
                {
                  text: "🧹 Clear filters",
                  callback_data: `${input.callbackPrefix}search_filters:${route.sessionId}:all`,
                },
              ],
              [
                {
                  text: "⬅️ Results",
                  callback_data: `${input.callbackPrefix}search_back:${route.sessionId}:0`,
                },
              ],
            ],
          },
        });
        return true;
      }
      const venues =
        route.venue === "all"
          ? []
          : route.venue.startsWith("s_") || route.venue.startsWith("c_")
            ? (session.venues ?? [])
            : [route.venue];
      const category =
        route.venue === "all" || route.venue === "c_all"
          ? undefined
          : route.venue === "c_tech"
            ? "technology"
            : route.venue === "c_culture"
              ? "entertainment"
              : route.venue.startsWith("c_")
                ? route.venue.slice(2)
                : session.category;
      const sort =
        route.venue === "s_totalvol"
          ? "totalvol"
          : route.venue === "s_time"
            ? "time"
            : route.venue === "s_trending"
              ? "trending"
              : (session.sort ?? "trending");
      try {
        if (!input.searchMarkets || !input.redis.set)
          throw new Error("search_unavailable");
        const results = await input.searchMarkets({
          query: session.query,
          venues,
          category,
          sort,
        });
        const sessionId = await writeSignalBotMarketSearchSession({
          chatId: input.chatId,
          telegramUserId: input.telegramUserId,
          redis: {
            get: input.redis.get.bind(input.redis),
            set: input.redis.set.bind(input.redis),
          },
          query: session.query,
          results,
          venues,
          category,
          sort,
        });
        await input.render(
          buildSignalBotMarketSearchScreen({
            callbackPrefix: input.callbackPrefix,
            query: session.query,
            results,
            sessionId,
            venues,
            category,
            sort,
          }),
        );
      } catch {
        await input.render({
          text: escapeTelegramMarkdownV2(
            "Search temporarily unavailable. Try the filter again.",
          ),
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🔄 Retry",
                  callback_data: `${input.callbackPrefix}search_filters:${route.sessionId}:${route.venue}`,
                },
              ],
              [
                {
                  text: "⬅️ Results",
                  callback_data: `${input.callbackPrefix}search_back:${route.sessionId}:0`,
                },
              ],
            ],
          },
        });
      }
      return true;
    }
    if (
      route.kind === "market_search_back" ||
      route.kind === "market_search_page"
    ) {
      const pageCount = Math.max(
        1,
        Math.ceil(session.results.length / SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE),
      );
      if (
        !Number.isInteger(route.page) ||
        route.page < 0 ||
        route.page >= pageCount
      ) {
        await input.renderExpiredSearch();
        return true;
      }
      await input.render(
        buildSignalBotMarketSearchScreen({
          callbackPrefix: input.callbackPrefix,
          page: route.page,
          query: session.query,
          results: session.results,
          venues: session.venues,
          category: session.category,
          sort: session.sort,
          sessionId: route.sessionId,
        }),
      );
      return true;
    }
    const resultIndex =
      route.kind === "market_search_venue" ? route.resultIndex : route.index;
    const selected = session.results[resultIndex];
    if (!selected || !input.loadMarketCard) {
      await input.renderExpiredSearch();
      return true;
    }
    const options =
      selected.venueOptions && selected.venueOptions.length > 0
        ? selected.venueOptions
        : [selected];
    if (route.kind === "market_search_result" && options.length > 1) {
      await input.render(
        buildSignalBotMarketVenuePickerScreen({
          callbackPrefix: input.callbackPrefix,
          result: selected,
          resultIndex,
          sessionId: route.sessionId,
        }),
      );
      return true;
    }
    const selectedVenue =
      route.kind === "market_search_venue" ? options[route.index] : selected;
    if (!selectedVenue) {
      await input.renderExpiredSearch();
      return true;
    }
    try {
      const marketMessage = await input.loadMarketCard({
        chatId: input.chatId,
        context: {
          observedNoAsk: selectedVenue.noAsk,
          observedYesAsk: selectedVenue.yesAsk,
          origin: "search",
          returnCallbackData:
            options.length > 1
              ? `${input.callbackPrefix}search:${route.sessionId}:${resultIndex}`
              : `${input.callbackPrefix}search_back:${route.sessionId}:${Math.floor(
                  resultIndex / SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE,
                )}`,
        },
        marketRef: selectedVenue.marketId,
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
      positionMessage =
        input.loadPositionCard && input.messageId != null
          ? await input.loadPositionCard({
              messageId: input.messageId,
              positionId: route.positionId,
              telegramUserId: input.telegramUserId,
            })
          : {
              parse_mode: "MarkdownV2",
              text: formatTelegramCalloutMarkdownV2({
                bodyMarkdownV2: "Try again from My positions\\.",
                icon: "⚠️",
                title: "Position unavailable",
              }),
            };
    } catch {
      positionMessage = {
        parse_mode: "MarkdownV2",
        text: formatTelegramCalloutMarkdownV2({
          bodyMarkdownV2: "Try again from My positions\\.",
          icon: "⚠️",
          title: "Position unavailable",
        }),
      };
    }
    await input.render(positionMessage);
    return true;
  }
  let depositMessage: MenuMessage & {
    depositAddress?: string;
    qrText?: string;
    receiveAddress?: string;
  };
  const fundingAction = signalBotFundingMenuAction(route);
  const reportFundingOperationError = (): void => {
    if (!fundingAction) return;
    try {
      input.onFundingOperationError?.(fundingAction);
    } catch {
      // Observability must never alter the safe unavailable response.
    }
  };
  const depositVenue =
    route.kind === "deposit" || route.kind === "deposit_route"
      ? route.venue
      : fundingAction != null
        ? "polymarket"
        : null;
  if (!fundingAction && route.kind === "deposit" && route.venue !== "any") {
    await input.render({
      parse_mode: "MarkdownV2",
      text: formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: "Open Receive again\\.",
        icon: "⚠️",
        title: "Receive unavailable",
      }),
    });
    return true;
  }
  try {
    if (fundingAction) {
      depositMessage = input.loadFunding
        ? await input.loadFunding({
            action: fundingAction,
            chatId: input.chatId,
            ...(route.kind === "deposit" && route.navigationMarketId
              ? {
                  navigationMarketId: route.navigationMarketId,
                  navigationSide: route.navigationSide,
                }
              : {}),
            ...(route.kind === "select"
              ? {
                  choiceToken: route.choiceToken,
                  contextId: route.contextId,
                }
              : route.kind === "deposit_route"
                ? { fundingRoute: route.route }
                : route.kind === "review_buy"
                  ? { continuationToken: route.continuationToken }
                  : route.kind === "change_buy_amount"
                    ? { continuationToken: route.continuationToken }
                    : route.kind === "confirm_conversion"
                      ? { consentToken: route.consentToken }
                      : route.kind === "review_conversion"
                        ? { receiptId: route.receiptId }
                        : route.kind === "back_to_market" ||
                            route.kind === "cancel" ||
                            route.kind === "refresh" ||
                            route.kind === "qr" ||
                            route.kind === "targets"
                          ? { contextId: route.contextId }
                          : {}),
            idempotencyKey:
              "funding:" + (input.idempotencyKey ?? "legacy-callback"),
            telegramMessageId: input.messageId,
            telegramUserId: input.telegramUserId,
            ...((fundingAction === "open" || fundingAction === "open_route") &&
            (depositVenue === "polymarket" || depositVenue === "limitless")
              ? { venue: depositVenue }
              : {}),
            ...(route.kind === "qr" ? { view: "address" as const } : {}),
            ...(route.kind === "targets" ? { view: "targets" as const } : {}),
            ...(route.kind === "refresh" ? { requestObservation: true } : {}),
          })
        : {
            parse_mode: "MarkdownV2" as const,
            text: formatTelegramCalloutMarkdownV2({
              bodyMarkdownV2: "Try again shortly\\.",
              icon: "⚠️",
              title: "Receive unavailable",
            }),
          };
    } else {
      depositMessage = input.loadDeposit
        ? await input.loadDeposit({
            telegramUserId: input.telegramUserId,
            venue: depositVenue,
          })
        : {
            parse_mode: "MarkdownV2" as const,
            text: formatTelegramCalloutMarkdownV2({
              bodyMarkdownV2: "Try again shortly\\.",
              icon: "⚠️",
              title: "Deposit unavailable",
            }),
          };
    }
  } catch {
    reportFundingOperationError();
    depositMessage = {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            {
              callback_data: input.callbackPrefix + "deposit",
              text: "Open Deposit",
            },
          ],
          [
            {
              callback_data: input.callbackPrefix + "home",
              text: "🏠 Home",
            },
          ],
        ],
      },
      text: formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: "Try again shortly\\.",
        icon: "⚠️",
        title: "Deposit unavailable",
      }),
    };
  }
  // Financial addresses and QR data have one egress gateway: the durable
  // funding outbox. Interactive callbacks may request an operation, but must
  // never race revocation by sending the returned address themselves.
  if (fundingAction && depositMessage.durableFundingDeliveryRequired) {
    return true;
  }
  if (
    depositMessage.qrText ||
    depositMessage.depositAddress ||
    depositMessage.receiveAddress
  ) {
    reportFundingOperationError();
    await input.render({
      parse_mode: "MarkdownV2",
      text: formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: "Try again shortly\\.",
        icon: "⚠️",
        title: "Receive unavailable",
      }),
    });
    return true;
  }
  const fundingRows = depositMessage.reply_markup?.inline_keyboard ?? [];
  const homeCallback = input.callbackPrefix + "home";
  const hasHome = fundingRows.some((row) =>
    row.some(
      (button) =>
        "callback_data" in button && button.callback_data === homeCallback,
    ),
  );
  await input.render({
    ...depositMessage,
    reply_markup: {
      inline_keyboard: [
        ...fundingRows,
        ...(!hasHome
          ? [
              [
                {
                  callback_data: homeCallback,
                  text: "🏠 Home",
                },
              ],
            ]
          : []),
      ],
    },
  });
  return true;
}

export function handleSignalBotInteractiveMenuCallback(
  input: SignalBotInteractiveMenuCallbackInput,
): Promise<boolean> {
  if (
    input.loadFunding &&
    isSignalBotFundingMenuRoute(input.route) &&
    input.route.kind === "deposit"
  ) {
    return scheduleSignalBotFundingOpen(input);
  }
  return deliverSignalBotInteractiveMenuCallback(input);
}

const MAX_BACKGROUND_FUNDING_OPENS = 4;

type FundingOpenEntry = {
  latestInput: SignalBotInteractiveMenuCallbackInput;
  task: Promise<void>;
  version: number;
};

const backgroundFundingOpens = new Map<string, FundingOpenEntry>();

function fundingOpenKey(input: SignalBotInteractiveMenuCallbackInput): string {
  return `${input.telegramUserId}:${input.chatId}:${input.messageId ?? "new"}`;
}

function fundingOpenBusyMessage(callbackPrefix: string): MenuMessage {
  return {
    parse_mode: "MarkdownV2",
    text: formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2:
        "Too many receive requests are already loading\\. Try again shortly\\.",
      icon: "⏳",
      title: "Receive busy",
    }),
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: callbackPrefix + "home",
            text: "🏠 Home",
          },
        ],
      ],
    },
  };
}

function scheduleSignalBotFundingOpen(
  input: SignalBotInteractiveMenuCallbackInput,
): Promise<boolean> {
  const key = fundingOpenKey(input);
  const existing = backgroundFundingOpens.get(key);
  if (existing) {
    existing.latestInput = input;
    existing.version += 1;
    return Promise.resolve(true);
  }
  if (backgroundFundingOpens.size >= MAX_BACKGROUND_FUNDING_OPENS) {
    return input
      .render(fundingOpenBusyMessage(input.callbackPrefix))
      .then(() => true)
      .catch(() => true);
  }

  const firstLoader = input.loadFunding;
  if (!firstLoader) return Promise.resolve(true);
  let operationErrorReported = false;
  const reportOperationError = (action: SignalBotFundingMenuAction): void => {
    if (operationErrorReported) return;
    operationErrorReported = true;
    try {
      input.onFundingOperationError?.(action);
    } catch {
      // Telemetry must never alter menu delivery or task cleanup.
    }
  };
  let sharedLoad: ReturnType<
    SignalBotInteractiveMenuLoaders["funding"]
  > | null = null;
  const coalescedLoader: SignalBotInteractiveMenuLoaders["funding"] = (
    request,
  ) => {
    sharedLoad ??= firstLoader(request);
    return sharedLoad;
  };
  const entry = {
    latestInput: input,
    task: Promise.resolve(),
    version: 0,
  } satisfies FundingOpenEntry;
  entry.task = (async () => {
    let deliveredVersion = -1;
    while (deliveredVersion !== entry.version) {
      const currentVersion = entry.version;
      const currentInput = entry.latestInput;
      await deliverSignalBotInteractiveMenuCallback({
        ...currentInput,
        loadFunding: coalescedLoader,
        onFundingOperationError: reportOperationError,
      });
      deliveredVersion = currentVersion;
    }
  })().finally(() => {
    if (backgroundFundingOpens.get(key) === entry) {
      backgroundFundingOpens.delete(key);
    }
  });
  backgroundFundingOpens.set(key, entry);
  void entry.task.catch(() => reportOperationError("open"));
  return Promise.resolve(true);
}

export async function drainSignalBotFundingOpenTasks(
  timeoutMs = 10_000,
): Promise<boolean> {
  const pending = Array.from(
    backgroundFundingOpens.values(),
    ({ task }) => task,
  );
  if (pending.length === 0) return true;
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
