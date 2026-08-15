import {
  buildSignalBotMarketUnavailableResultScreen,
  buildSignalBotMarketSearchScreen,
  buildSignalBotMarketVenuePickerScreen,
  readSignalBotMarketSearchSession,
  SIGNAL_BOT_MARKET_SEARCH_PAGE_SIZE,
} from "./telegram-bot-menu-markets.js";
import type {
  SignalBotTelegramClient,
  TelegramBotCallbackQuery,
} from "./signal-bot-contracts.js";
import { formatTelegramCalloutMarkdownV2 } from "./telegram-bot-trading-presentation.js";
import {
  parseTelegramFundingCallbackRoute,
  type TelegramFundingCallbackRoute,
} from "./telegram-funding-contracts.js";

export type SignalBotFundingMenuRoute =
  | { kind: "deposit"; showQr: boolean; venue: string }
  | {
      kind: "deposit_route";
      route:
        | "limitless_base_usdc_direct_v1"
        | "polymarket_polygon_pusd_direct_v1"
        | "polymarket_polygon_usdce_wrap_v1";
      venue: "limitless" | "polymarket";
    }
  | { kind: "deposit_cancel_active" }
  | { kind: "deposit_menu" }
  | TelegramFundingCallbackRoute;

export type SignalBotInteractiveMenuRoute =
  | SignalBotFundingMenuRoute
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
  const depositRouteMatch = route.match(/^deposit_route:(pd|pw|ld)$/i);
  if (depositRouteMatch) {
    const token = depositRouteMatch[1]?.toLowerCase();
    const routeByToken = {
      ld: "limitless_base_usdc_direct_v1",
      pd: "polymarket_polygon_pusd_direct_v1",
      pw: "polymarket_polygon_usdce_wrap_v1",
    } as const;
    const fundingRoute = token
      ? routeByToken[token as keyof typeof routeByToken]
      : null;
    if (!fundingRoute) return null;
    const venue = fundingRoute.startsWith("limitless_")
      ? "limitless"
      : "polymarket";
    return {
      kind: "deposit_route",
      route: fundingRoute,
      venue,
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
                  : route.kind === "refresh" || route.kind === "qr"
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
      | "polymarket_polygon_pusd_direct_v1"
      | "polymarket_polygon_usdce_wrap_v1";
    idempotencyKey: string;
    receiptId?: string;
    requestObservation?: boolean;
    telegramMessageId: number | null;
    telegramUserId: number;
    venue?: "limitless" | "polymarket";
    view?: "address" | "progress";
  }) => Promise<MenuMessage & { qrText?: string }>;
};

type SignalBotInteractiveMenuCallbackInput = {
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
                            route.kind === "qr"
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
