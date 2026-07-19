import { requestFreshMarketPrices, type PriceRefreshRedis } from "@hunch/infra";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  getVenuesWithLifecycleCapability,
  getMarketPriceSideState,
  normalizeHunchVenue,
  type MarketPriceBlocker,
  type HunchVenue,
} from "@hunch/shared";

import type { DbQuery } from "../db.js";
import { findTradeMarketById, isOrderable } from "./api-trading-market-repo.js";
import { resolveAggMarketCredential } from "../lib/agg-market-credentials.js";
import { type AggMarketAlternativesDiagnostics } from "./agg-market-clusters.js";
import type { ClusterMarketSummary } from "./clusters.js";
import {
  resolveNativeOutcomeForCanonicalSide,
  resolveStrictClusterNativeOffer,
} from "./cluster-execution.js";
import { loadClusterMarketNativeQuotes } from "./cluster-execution-quotes.js";
import { SIGNAL_BOT_QUOTE_MAX_AGE_MS } from "./signal-bot-delivery-policy.js";
import {
  HOLDER_RESEARCH_PUBLICATION_DECISION_V1_METRICS_JSON,
  parseHolderResearchUpdateV1,
  parseSignalPriceSnapshotV1,
  parseTelegramMarketIdentityV1,
  type HolderResearchUpdateV1,
  type SignalPriceSnapshotV1,
  type TelegramMarketIdentityV1,
} from "./signal-publication-contract.js";
import {
  auditHolderResearchSignalPerformance,
  HOLDER_RESEARCH_PERFORMANCE_APPROX_ENTRY_AFTER_HOURS,
  HOLDER_RESEARCH_PERFORMANCE_APPROX_ENTRY_BEFORE_HOURS,
  resolveHolderResearchFinalYesProbability,
  resolveHolderResearchSignalQuote,
  type HolderResearchPerformanceAuditResult,
} from "./holder-research-performance.js";
import {
  classifyMarketSegment,
  formatMarketSegmentLabel,
  formatMarketTypeLabel,
} from "./market-type-classifier.js";
import {
  buildMarketSideCopy,
  cleanPublicMarketText,
  type MarketSideCopy,
} from "./market-side-copy.js";
import {
  buildSignalNotificationHeadline,
  buildSignalNotificationSubject,
  type SignalNotificationHeadline,
  type SignalNotificationSubject,
} from "./signal-notification-headline.js";
import {
  resolveSignalPostCopyPolicy,
  type ResolvedSignalPostCopyPolicy,
} from "./signal-post-copy-policy.js";
import {
  normalizeTelegramPresentationAliases,
  resolvePersistedOrCurrentTelegramMarketPresentation,
} from "./telegram-market-presentation.js";
import type { SignalEvidenceMetricV1 } from "./holder-research-signal-evidence.js";
import { resolvePersistedSignalEvidence } from "./legacy-signal-evidence.js";
import { createSignalDeliveryRef } from "./signal-delivery-attribution.js";
import {
  defaultSignalBotFollowthroughPolicy,
  resolveSignalBotFollowthroughPolicy,
  type SignalBotFollowthroughDataQuality,
  type SignalBotFollowthroughPolicy,
} from "./signal-bot-followthrough-policy.js";
import {
  buildSignalBotBuyStartParam,
  buildSignalBotHolderStartParam,
  buildSignalBotMiniAppUrl,
  buildSignalBotMarketStartParam,
  normalizeTelegramMiniAppLinkBase,
  SIGNAL_BOT_TELEGRAM_WEB_APP_ENTRY_PATH,
} from "./signal-bot-mini-app-links.js";
import { parseTelegramBotTradingCallbackData } from "./telegram-bot-trading-client.js";
import {
  ensureTelegramNotificationPreferences,
  setTelegramNotificationTopic,
  type TelegramNotificationPreferences,
  type TelegramNotificationTopic,
} from "./telegram-notification-preferences.js";
import { buildWalletIntelAcceptingOrdersSql } from "./wallet-intel-market-eligibility.js";
import { parseMarketOutcomes } from "./wallet-intel-helpers.js";
import type { SignalDestinationPolicy } from "./signal-delivery-target.js";
import { resolveSignalBotVenueLifecycle } from "./signal-bot-venue-lifecycle.js";
import { sendTelegramPhotoRequest } from "./telegram-api-photo.js";
import {
  buildSignalBotMarketSearchQueryPrompt,
  buildSignalBotMarketSearchScreen,
  writeSignalBotMarketSearchSession,
  type SignalBotMarketSearchResult,
} from "./telegram-bot-menu-markets.js";
import {
  handleSignalBotInteractiveMenuCallback,
  parseSignalBotInteractiveMenuRoute,
  type SignalBotInteractiveMenuRoute,
} from "./telegram-bot-menu-actions.js";
import {
  resolveTelegramBotMenuAudience,
  type TelegramBotMenuAudience,
} from "./telegram-bot-menu-audience.js";
import { handleSignalBotMarketSearchInput } from "./telegram-bot-menu-search-input.js";
import {
  buildHunchMiniAppDeepLinkButton,
  buildHunchMiniAppWebButton,
} from "./telegram-mini-app-buttons.js";
import { withTelegramPrivateNavigation } from "./telegram-bot-private-navigation.js";
import {
  clearSignalBotMenuInput,
  writeSignalBotMenuInput,
} from "./telegram-bot-menu-state.js";
import {
  createTelegramSignalTransport,
  escapeTelegramMarkdownV2,
  type SignalDeliveryView,
  type SignalTransport,
  type TransportPayload,
} from "./signal-delivery.js";

export { escapeTelegramMarkdownV2 } from "./signal-delivery.js";

export type SignalBotConfig = {
  enabled: boolean;
  token: string;
  adminUserIds: Set<number>;
  appBaseUrl: string;
  publishIntervalSec: number;
  pollTimeoutSec: number;
  maxSignalsPerTick: number;
  buyAmountUsd: number;
  priceGuardDeferTtlSec: number;
  priceGuardMaxDefers: number;
  followthrough: SignalBotFollowthroughPolicy;
  telegramMiniAppLinkBase: string | null;
  tradingInternalApiBaseUrl: string | null;
  tradingInternalApiToken: string | null;
};

export type SignalBotCommand =
  | "disable_signals"
  | "enable_signals"
  | "help"
  | "market"
  | "menu"
  | "settings"
  | "signal_venues"
  | "start"
  | "stats"
  | "status"
  | "trade_status"
  | "disable_trading"
  | "test_followthrough"
  | "test_signal"
  | "test_trade";

export type SignalBotDisableTradingResult =
  | "already_disabled"
  | "disabled"
  | "unavailable";

export type SignalBotFollowthroughPreviewKind =
  | "resolved_loss"
  | "resolved_win"
  | "stats";

export type SignalBotFollowthroughPreviewRequest = {
  kind: SignalBotFollowthroughPreviewKind;
  targetChatId: string | null;
};

export type SignalBotChatState = {
  chatId: string;
  chatTitle: string | null;
  chatType: string | null;
  enabledBy: string;
  enabledAt: string;
  cursorCreatedAt: string;
  cursorId: string;
  destinationPolicy: SignalDestinationPolicy | null;
};

export type SignalBotRedisLike = {
  del(key: string): Promise<unknown>;
  eval(
    script: string,
    options: { arguments: string[]; keys: string[] },
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hSet(key: string, value: Record<string, string>): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  sRem(key: string, member: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    options?: { EX?: number; PX?: number; NX?: boolean },
  ): Promise<unknown>;
  zCard?(key: string): Promise<number>;
  zRemRangeByRank?(key: string, start: number, stop: number): Promise<number>;
};

export type SignalBotCheaperAlternative = {
  eventId: string;
  marketId: string;
  price: number;
  side: "NO" | "YES";
  venue: string;
};

export type SignalBotStatsPeriod = "24h" | "30d" | "7d";

export type SignalBotStatsRequest = {
  detail: boolean;
  period: SignalBotStatsPeriod;
};

export type TelegramBotChat = {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TelegramBotMessage = {
  message_id?: number;
  chat: TelegramBotChat;
  from?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
  };
  text?: string;
};

export type TelegramBotCallbackQuery = {
  id: string;
  from?: {
    id?: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
  };
  message?: TelegramBotMessage;
  data?: string;
};

export type TelegramBotUpdate = {
  update_id: number;
  callback_query?: TelegramBotCallbackQuery;
  message?: TelegramBotMessage;
};

export type TelegramBotUser = {
  id: number;
  is_bot: boolean;
  username?: string;
};

export type TelegramBotCommandDefinition = {
  command: string;
  description: string;
};

export type TelegramBotCommandScope =
  | { type: "all_private_chats" }
  | { chat_id: number | string; type: "chat" }
  | { type: "default" };

export type TelegramBotMenuButton =
  | { type: "commands" }
  | {
      text: string;
      type: "web_app";
      web_app: { url: string };
    };

export type TelegramInlineKeyboardButton =
  | {
      copy_text: { text: string };
      text: string;
      url?: never;
      web_app?: never;
    }
  | {
      text: string;
      url: string;
      web_app?: never;
    }
  | {
      text: string;
      url?: never;
      web_app: { url: string };
    }
  | {
      callback_data: string;
      text: string;
      url?: never;
      web_app?: never;
    };

export type TelegramInlineKeyboard = {
  inline_keyboard: Array<Array<TelegramInlineKeyboardButton>>;
};

export type TelegramSendMessageInput = {
  chat_id: string;
  disable_web_page_preview: boolean;
  parse_mode: "MarkdownV2";
  reply_parameters?: {
    allow_sending_without_reply?: boolean;
    message_id: number;
  };
  reply_markup?: TelegramInlineKeyboard;
  text: string;
};

export type TelegramSendResult =
  | { messageId: number | null; ok: true }
  | {
      error: "blocked_or_missing" | "other";
      message: string;
      ok: false;
      retryAfterSec?: number;
    };

export type SignalBotTelegramClient = {
  answerCallbackQuery(input: {
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }): Promise<unknown>;
  getUpdates(input: {
    offset: number | null;
    timeoutSec: number;
  }): Promise<TelegramBotUpdate[]>;
  editMessageText?(input: {
    chat_id: string;
    disable_web_page_preview: boolean;
    message_id: number;
    parse_mode: "MarkdownV2";
    reply_markup?: TelegramInlineKeyboard;
    text: string;
  }): Promise<TelegramSendResult>;
  sendPhoto?(input: {
    caption?: string;
    chat_id: string;
    filename: string;
    parse_mode?: "MarkdownV2";
    photo: Uint8Array;
    reply_markup?: TelegramInlineKeyboard;
  }): Promise<TelegramSendResult>;
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendResult>;
};

export type SignalBotNote = {
  id: string;
  noteKey: string;
  title: string;
  description: string;
  rationale: string | null;
  producerRunId: string;
  direction: "down" | "mixed" | "up" | null;
  confidence: number | null;
  modelMeta: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  holderResearchUpdateV1?: HolderResearchUpdateV1 | null;
  signalPriceSnapshotV1?: SignalPriceSnapshotV1 | null;
  telegramMarketIdentityV1?: TelegramMarketIdentityV1 | null;
  createdAt: string;
  revisionKind: "initial" | "research_update";
  meaningfulDeltaReasons?: string[];
  decisionSnapshot?: unknown;
  previousDecisionSnapshot?: unknown;
  thesisKey: string;
  thesisRootNoteId: string;
  primaryTargetMeta: Record<string, unknown>;
  marketId: string | null;
  eventId: string | null;
  marketVenue: string | null;
  marketTitle: string | null;
  marketSlug: string | null;
  marketDescription: string | null;
  marketMetadata?: unknown;
  eventTitle: string | null;
  eventDescription: string | null;
  outcomes: string[] | null;
  resolutionSource: string | null;
  marketSegment: string | null;
  closeTime: string | null;
  expirationTime: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  holderAddress: string | null;
  holderChain: string | null;
  holderWalletId?: string | null;
  holderDisplayName?: string | null;
  holderIdentityDisplayName?: string | null;
  holderOpenPnlUsd: number | null;
  holderPositionUsd: number | null;
  holderSide: "NO" | "YES" | null;
  holderActorMode: "none" | "sharp_cluster" | "single_holder" | null;
  holderCredentialBullets: string[];
  holderClusterPnl30dUsd: number | null;
  holderClusterSharpHolders: number | null;
  holderClusterSharpUsd: number | null;
};

type SignalBotMessageKind =
  | "followthrough_stats"
  | "initial"
  | "research_update"
  | "resolved_loss"
  | "resolved_win";

type SignalBotThreadContext = {
  baselineAt: string;
  messageKind: Extract<SignalBotMessageKind, "initial" | "research_update">;
  replyToMessageId: number | null;
  threadRootNoteId: string;
};

type SignalBotDeliverySendResult =
  | {
      fallbackStandalone: boolean;
      messageId: number | null;
      ok: true;
      replyToMessageId: number | null;
    }
  | {
      error: "blocked_or_missing" | "other";
      message: string;
      ok: false;
      retryAfterSec?: number;
    };

type SignalBotFollowthroughStats = {
  version: 1;
  evaluatedAt: string;
  threadRootNoteId: string;
  finalProbabilitySource:
    | "missing"
    | "resolved_outcome"
    | "resolved_outcome_pct"
    | "terminal_price";
  marketId: string;
  signalSide: "NO" | "YES" | null;
  state: "open" | "resolved" | "unknown";
  outcome: "loss" | "open" | "unknown" | "win";
  baselineAt: string;
  asOf: string;
  entryPrice: number | null;
  markPrice: number | null;
  priceMoveCents: number | null;
  joinedWallets: number;
  addedWallets: number;
  joinedOrAddedWallets: number;
  trimmedWallets: number;
  exitedWallets: number;
  stillHoldingWallets: number;
  missingBaselineSnapshots: number;
  netSignalSideFlowUsd: number;
  netOppositeSideFlowUsd: number;
  estimatedOpenPnlUsd: number | null;
  estimatedRealizedPnlUsd: number | null;
  dataQuality: SignalBotFollowthroughDataQuality;
  dataQualityTags: string[];
};

type SignalBotNoteRow = {
  id: string;
  note_key: string;
  title: string;
  description: string;
  rationale: string | null;
  producer_run_id: string;
  direction: "down" | "mixed" | "up" | null;
  confidence: string | number | null;
  model_meta: unknown;
  metrics: unknown;
  created_at: Date | string;
  revision_kind: string | null;
  meaningful_delta_reasons?: unknown;
  decision_snapshot?: unknown;
  previous_decision_snapshot?: unknown;
  thesis_key: string | null;
  thesis_root_note_id: string | null;
  primary_target_meta: unknown;
  market_id: string | null;
  event_id: string | null;
  market_venue: string | null;
  market_title: string | null;
  market_slug: string | null;
  market_description: string | null;
  market_metadata: unknown;
  event_title: string | null;
  event_description: string | null;
  category: string | null;
  event_category: string | null;
  series_key: string | null;
  series_title: string | null;
  close_time: Date | string | null;
  expiration_time: Date | string | null;
  outcomes: string | null;
  resolution_source: string | null;
  market_segment: string | null;
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
  holder_address: string | null;
  holder_chain: string | null;
  holder_wallet_id: string | null;
  holder_target_meta: unknown;
};

type SignalBotResearchDelta =
  | {
      currentPrice: number;
      kind: "price_move";
      priceMoveCents: number;
      supportsBuy: boolean;
    }
  | {
      afterUsd: number;
      beforeUsd: number;
      kind: "position_change";
      positionChangeUsd: number;
      scope: "representative_wallet" | "selected_side_cluster";
      supportsBuy: boolean;
      walletId: string | null;
    }
  | {
      afterWallets: number;
      beforeWallets: number;
      kind: "wallet_count_change";
      supportsBuy: boolean;
      walletChange: number;
    };

type SignalBotEligibilityCountRow = {
  non_directional: string | number | null;
  publish_notes_seen: string | number | null;
  total: string | number | null;
};

type SignalBotFollowthroughCandidateRow = {
  chat_id: string;
  thread_root_note_id: string;
  reply_to_message_id: string | number | null;
  baseline_at: Date | string;
  title: string;
  direction: "down" | "mixed" | "up" | null;
  metrics: unknown;
  root_metrics: unknown;
  target_meta: unknown;
  market_id: string;
  event_id: string | null;
  market_title: string | null;
  market_slug: string | null;
  market_description: string | null;
  event_title: string | null;
  event_description: string | null;
  outcomes: string | null;
  resolution_source: string | null;
  venue: string | null;
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | number | null;
  accepting_orders: boolean | null;
};

type SignalBotFollowthroughFlowRow = {
  wallet_id: string;
  outcome_side: "NO" | "YES";
  baseline_shares: string | number | null;
  latest_shares: string | number | null;
  latest_snapshot_at: Date | string | null;
  latest_size_usd: string | number | null;
  positive_usd: string | number | null;
  negative_usd: string | number | null;
  net_usd: string | number | null;
  net_shares: string | number | null;
  event_count: string | number | null;
};

const CHAT_SET_KEY = "tg:signal_bot:v1:enabled_chats";
const UPDATE_OFFSET_KEY = "tg:signal_bot:v1:update_offset";
const LOCK_KEY = "tg:signal_bot:v1:lock";
const PRICE_GUARD_DEFER_KEY_PREFIX = "tg:signal_bot:v1:price_guard_defer";
const PRICE_GUARD_MAX_FRESH_AGE_MS = SIGNAL_BOT_QUOTE_MAX_AGE_MS;
const HOLDER_RESEARCH_PUBLICATION_DECISION_SQL = `
  n.metrics @> '${HOLDER_RESEARCH_PUBLICATION_DECISION_V1_METRICS_JSON}'::jsonb
`;
const LOCK_TTL_MS = 120_000;
const DEFAULT_CURSOR_ID = "00000000-0000-0000-0000-000000000000";
const LATEST_CURSOR_CREATED_AT = "9999-12-31T23:59:59.999Z";
const LATEST_CURSOR_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEND_FAILURE_COOLDOWN_SEC = 300;
const FOLLOWTHROUGH_RETRY_COOLDOWN_MS = 15 * 60_000;
const FOLLOWTHROUGH_MIN_LATEST_SNAPSHOT_FRESH_MS = 24 * 60 * 60 * 1_000;
const SIGNAL_BOT_COPY_VERSION = "signal_bot_copy_v8";
const SIGNAL_BOT_MENU_CALLBACK_PREFIX = "hm:v1:";
const HOLDER_LINK_STOP_LABELS = new Set([
  "ATRACKEDWALLET",
  "TRACKEDWALLET",
  "THISWALLET",
]);
const HOLDER_LINK_STOP_WORDS = new Set([
  "A",
  "AN",
  "AND",
  "AT",
  "FOR",
  "FROM",
  "HAS",
  "HOLDER",
  "IT",
  "ITS",
  "MARKET",
  "NO",
  "NOT",
  "ON",
  "OR",
  "THAT",
  "THE",
  "THEIR",
  "THIS",
  "TO",
  "WALLET",
  "WE",
  "YES",
]);
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export function signalBotChatKey(chatId: string): string {
  return `tg:signal_bot:v1:chat:${chatId}`;
}

export function signalBotLockKey(): string {
  return LOCK_KEY;
}

function signalBotPriceGuardDeferKey(chatId: string, noteId: string): string {
  return `${PRICE_GUARD_DEFER_KEY_PREFIX}:${chatId}:${noteId}`;
}

function signalBotSendCooldownKey(chatId: string, noteId: string): string {
  return `tg:signal_bot:v1:send_cooldown:${chatId}:${noteId}`;
}

export function parseSignalBotConfig(
  env: NodeJS.ProcessEnv = process.env,
): SignalBotConfig {
  const config: SignalBotConfig = {
    enabled: parseBool(env.HUNCH_SIGNAL_BOT_ENABLED, false),
    token: env.HUNCH_SIGNAL_BOT_TOKEN?.trim() ?? "",
    adminUserIds: new Set(
      parseIntegerList(env.HUNCH_SIGNAL_BOT_ADMIN_USER_IDS),
    ),
    appBaseUrl: normalizeBaseUrl(
      env.HUNCH_SIGNAL_BOT_APP_BASE_URL?.trim() || "https://app.hunch.trade",
    ),
    publishIntervalSec: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_PUBLISH_INTERVAL_SEC,
      60,
    ),
    pollTimeoutSec: parsePositiveInt(env.HUNCH_SIGNAL_BOT_POLL_TIMEOUT_SEC, 25),
    maxSignalsPerTick: parsePositiveInt(
      env.HUNCH_SIGNAL_BOT_MAX_SIGNALS_PER_TICK,
      5,
    ),
    buyAmountUsd: parsePositiveInt(env.HUNCH_SIGNAL_BOT_BUY_AMOUNT_USD, 10),
    priceGuardDeferTtlSec: parsePositiveInt(
      env.SIGNAL_BOT_PRICE_GUARD_DEFER_TTL_SEC,
      1_800,
    ),
    priceGuardMaxDefers: parsePositiveInt(
      env.SIGNAL_BOT_PRICE_GUARD_MAX_DEFERS,
      5,
    ),
    followthrough: defaultSignalBotFollowthroughPolicy(env),
    telegramMiniAppLinkBase: normalizeTelegramMiniAppLinkBase(
      env.HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE,
    ),
    tradingInternalApiBaseUrl:
      env.HUNCH_SIGNAL_BOT_INTERNAL_API_BASE_URL?.trim() ||
      (env.HUNCH_SIGNAL_BOT_INTERNAL_API_TOKEN?.trim()
        ? "http://api:3001"
        : null),
    tradingInternalApiToken:
      env.HUNCH_SIGNAL_BOT_INTERNAL_API_TOKEN?.trim() || null,
  };
  if (
    config.enabled &&
    env.NODE_ENV?.trim().toLowerCase() === "production" &&
    !config.telegramMiniAppLinkBase
  ) {
    throw new Error(
      "HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE is required when the production signal bot is enabled",
    );
  }
  return config;
}

export function parseSignalBotCommand(
  text: string | null | undefined,
  botUsername?: string | null,
): SignalBotCommand | null {
  if (!text) return null;
  const firstToken = text.trim().split(/\s+/)[0];
  if (!firstToken?.startsWith("/")) return null;
  const raw = firstToken.slice(1);
  const [command, mention] = raw.split("@");
  if (!command) return null;
  if (
    mention &&
    botUsername &&
    mention.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return null;
  }
  switch (command.toLowerCase()) {
    case "disable_signals":
      return "disable_signals";
    case "enable_signals":
      return "enable_signals";
    case "help":
      return "help";
    case "market":
      return "market";
    case "menu":
      return "menu";
    case "settings":
      return "settings";
    case "signal_venues":
      return "signal_venues";
    case "start":
      return "start";
    case "stats":
      return "stats";
    case "status":
      return "status";
    case "trade_status":
      return "trade_status";
    case "disable_trading":
      return "disable_trading";
    case "test_followthrough":
      return "test_followthrough";
    case "test_signal":
      return "test_signal";
    case "test_trade":
      return "test_trade";
    default:
      return null;
  }
}

function parseSignalBotFollowthroughPreviewKind(
  value: string | null | undefined,
): SignalBotFollowthroughPreviewKind | null {
  switch (value?.trim().toLowerCase()) {
    case "stats":
      return "stats";
    case "resolved_win":
    case "win":
      return "resolved_win";
    case "resolved_loss":
    case "loss":
      return "resolved_loss";
    default:
      return null;
  }
}

export function parseSignalBotStatsPeriod(
  text: string | null | undefined,
): SignalBotStatsPeriod | null {
  return parseSignalBotStatsRequest(text)?.period ?? null;
}

export function parseSignalBotStatsRequest(
  text: string | null | undefined,
): SignalBotStatsRequest | null {
  if (!text) return { detail: false, period: "7d" };
  const [, ...rawArgs] = text.trim().split(/\s+/);
  let period: SignalBotStatsPeriod = "7d";
  let detail = false;
  for (const rawArg of rawArgs) {
    const normalized = rawArg.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "detail" || normalized === "details") {
      detail = true;
      continue;
    }
    if (normalized === "24h" || normalized === "7d" || normalized === "30d") {
      period = normalized;
      continue;
    }
    return null;
  }
  return { detail, period };
}

function signalBotStatsPeriodHours(period: SignalBotStatsPeriod): number {
  if (period === "24h") return 24;
  if (period === "30d") return 24 * 30;
  return 24 * 7;
}

function formatSignalBotStatsPeriodLabel(period: SignalBotStatsPeriod): string {
  return period.toUpperCase();
}

function parseSignalBotCommandTargetChatId(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const [, rawTarget] = text.trim().split(/\s+/, 2);
  return normalizeSignalBotCommandTargetChatId(rawTarget);
}

function parseSignalBotTestSignalRequest(text: string | null | undefined): {
  selector: SignalBotTestSignalSelector;
  targetChatId: string | null;
} {
  const parts = text?.trim().split(/\s+/).slice(1) ?? [];
  const targetChatId = normalizeSignalBotCommandTargetChatId(parts[0]);
  const rawSelector = targetChatId ? parts[1] : parts[0];
  const selector =
    rawSelector === "initial" ||
    rawSelector === "update" ||
    rawSelector === "latest" ||
    (rawSelector != null && UUID_RE.test(rawSelector))
      ? rawSelector
      : "latest";
  return { selector, targetChatId };
}

function parseSignalBotCommandFirstArg(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const [, rawArg] = text.trim().split(/\s+/, 2);
  const arg = rawArg?.trim();
  return arg ? arg : null;
}

function normalizeSignalBotCommandTargetChatId(
  rawTarget: string | null | undefined,
): string | null {
  if (!rawTarget) return null;
  const target = rawTarget.trim();
  if (/^-100\d{5,}$/.test(target)) return target;
  if (/^-\d{5,}$/.test(target)) return target;
  if (/^\d{5,}$/.test(target)) return `-100${target}`;
  return null;
}

export function parseSignalBotDestinationPolicyRequest(
  text: string | null | undefined,
): { rawVenues: string[] | "all"; targetChatId: string | null } | null {
  if (!text) return null;
  const [, ...args] = text.trim().split(/\s+/);
  if (args.length < 1 || args.length > 2) return null;
  const targetChatId =
    args.length === 2 ? normalizeSignalBotCommandTargetChatId(args[1]) : null;
  if (args.length === 2 && !targetChatId) return null;
  const raw = args[0]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "all") return { rawVenues: "all", targetChatId };
  const rawVenues = raw
    .split(",")
    .map((venue) => venue.trim())
    .filter(Boolean);
  return rawVenues.length > 0 ? { rawVenues, targetChatId } : null;
}

export function parseSignalBotFollowthroughPreviewRequest(
  text: string | null | undefined,
): SignalBotFollowthroughPreviewRequest | null {
  if (!text) return { kind: "stats", targetChatId: null };
  const [, ...args] = text.trim().split(/\s+/);
  let kind: SignalBotFollowthroughPreviewKind = "stats";
  let sawKind = false;
  let targetChatId: string | null = null;
  for (const rawArg of args) {
    const parsedKind = parseSignalBotFollowthroughPreviewKind(rawArg);
    if (parsedKind && !sawKind) {
      kind = parsedKind;
      sawKind = true;
      continue;
    }
    const parsedTarget = normalizeSignalBotCommandTargetChatId(rawArg);
    if (parsedTarget && !targetChatId) {
      targetChatId = parsedTarget;
      continue;
    }
    return null;
  }
  return { kind, targetChatId };
}

export function isSignalBotAdmin(
  config: Pick<SignalBotConfig, "adminUserIds">,
  userId: number | null | undefined,
): boolean {
  return typeof userId === "number" && config.adminUserIds.has(userId);
}

export function escapeTelegramMarkdownV2Url(value: string): string {
  return value.replace(/[)\\]/g, (char) => `\\${char}`);
}

function formatTelegramBold(value: string): string {
  return `*${escapeTelegramMarkdownV2(value)}*`;
}

function formatTelegramItalic(value: string): string {
  return `_${escapeTelegramMarkdownV2(value)}_`;
}

function formatTelegramLink(label: string, url: string): string {
  return `[${escapeTelegramMarkdownV2(label)}](${escapeTelegramMarkdownV2Url(url)})`;
}

function formatSignalNotificationHeadlineMarkdown(
  headline: SignalNotificationHeadline,
): string {
  const continuation = headline.continuation
    ? ` ${escapeTelegramMarkdownV2(headline.continuation)}`
    : "";
  return `${headline.emoji} ${formatTelegramBold(headline.hook)}${continuation}`;
}

// Telegram clients collapse ordinary empty lines at blockquote boundaries.
// U+2800 keeps one visually blank row without adding visible decoration.
const TELEGRAM_VISUAL_BLANK_LINE = "\u2800";

function joinTelegramMessageBlocks(
  blocks: Array<string | null | undefined>,
): string {
  return blocks
    .filter((block): block is string => Boolean(block?.trim()))
    .join(`\n${TELEGRAM_VISUAL_BLANK_LINE}\n`);
}

function formatTelegramBlockquote(lines: string[]): string {
  return lines
    .map((line) => `>${line || TELEGRAM_VISUAL_BLANK_LINE}`)
    .join("\n");
}

function cleanSignalBotDisplayText(
  value: string | null | undefined,
): string | null {
  const cleaned = value?.trim().replace(/\s+/g, " ") ?? "";
  return cleaned || null;
}

export function resolveSignalBotBuySide(
  note: Pick<SignalBotNote, "direction">,
): "NO" | "YES" | null {
  if (note.direction === "up") return "YES";
  if (note.direction === "down") return "NO";
  return null;
}

export function buildSignalBotTradeUrl(input: {
  amountUsd?: number | null;
  appBaseUrl: string;
  eventId: string;
  marketId: string;
  side: "NO" | "YES";
}): string {
  const url = new URL(
    `/events/${encodeURIComponent(input.eventId)}`,
    input.appBaseUrl,
  );
  url.searchParams.set("market", input.marketId);
  url.searchParams.set("side", input.side);
  url.searchParams.set("tradeSide", "BUY");
  url.searchParams.set("orderType", "market");
  url.searchParams.set("openTrade", "1");
  url.searchParams.set("utm_source", "telegram_signal_bot");
  if (input.amountUsd != null && input.amountUsd > 0) {
    url.searchParams.set("amountUsd", String(input.amountUsd));
  }
  return url.toString();
}

export function buildSignalBotOpenMarketUrl(input: {
  appBaseUrl: string;
  eventId: string;
  marketId: string | null;
  side?: "NO" | "YES" | null;
}): string {
  const url = new URL(
    `/events/${encodeURIComponent(input.eventId)}`,
    input.appBaseUrl,
  );
  if (input.marketId) url.searchParams.set("market", input.marketId);
  if (input.side) url.searchParams.set("side", input.side);
  url.searchParams.set("utm_source", "telegram_signal_bot");
  return url.toString();
}

export function buildSignalBotHolderUrl(input: {
  address: string | null | undefined;
  appBaseUrl?: string | null | undefined;
  chain: string | null | undefined;
  eventId?: string | null | undefined;
  marketId?: string | null | undefined;
  noteId?: string | null | undefined;
  side?: "NO" | "YES" | null | undefined;
}): string | null {
  const address = input.address?.trim();
  const chain = input.chain?.trim().toLowerCase();
  if (!address || !chain) return null;
  const url = new URL(
    `/tracking/wallet/${encodeURIComponent(address)}`,
    input.appBaseUrl ?? "https://app.hunch.trade",
  );
  url.searchParams.set("chain", chain);
  url.searchParams.set("utm_source", "telegram_signal_bot");
  if (input.eventId) url.searchParams.set("signalEventId", input.eventId);
  if (input.marketId) url.searchParams.set("signalMarketId", input.marketId);
  if (input.side) url.searchParams.set("signalSide", input.side);
  if (input.marketId) {
    url.searchParams.set("signalSource", "telegram_signal_bot");
  }
  if (input.noteId) url.searchParams.set("noteId", input.noteId);
  return url.toString();
}

type SignalBotHolderLinkMatch = {
  index: number;
  label: string;
};

type SignalBotBodyTextRenderer = {
  render(value: string): string;
};

function createSignalBotBodyTextRenderer(
  note: SignalBotNote,
  holderUrl: string | null,
  marketUrl: string | null,
  marketCandidates: string[],
): SignalBotBodyTextRenderer {
  const holderCandidates = holderUrl
    ? buildSignalBotHolderLinkCandidates(note)
    : [];
  const safeMarketCandidates = marketUrl
    ? [
        ...new Set(
          marketCandidates
            .map(cleanSignalBotDisplayText)
            .filter(
              (value): value is string =>
                value != null &&
                value.length >= 3 &&
                !["YES", "NO"].includes(value.toUpperCase()),
            ),
        ),
      ].sort((a, b) => b.length - a.length)
    : [];
  let didLinkHolder = false;
  let didLinkMarket = false;
  return {
    render: (value: string) => {
      const sanitizedValue = sanitizeSignalBotPublicHolderMentions(value, note);
      const matches: Array<
        SignalBotHolderLinkMatch & { kind: "holder" | "market"; url: string }
      > = [];
      if (holderUrl && !didLinkHolder && holderCandidates.length > 0) {
        const match = findSignalBotHolderLinkMatch(
          sanitizedValue,
          holderCandidates,
        );
        if (match) matches.push({ ...match, kind: "holder", url: holderUrl });
      }
      if (marketUrl && !didLinkMarket && safeMarketCandidates.length > 0) {
        const match = findSignalBotHolderLinkMatch(
          sanitizedValue,
          safeMarketCandidates,
        );
        if (match) matches.push({ ...match, kind: "market", url: marketUrl });
      }
      if (matches.length === 0) {
        return escapeTelegramMarkdownV2(sanitizedValue);
      }
      matches.sort(
        (a, b) => a.index - b.index || b.label.length - a.label.length,
      );
      const rendered: string[] = [];
      let cursor = 0;
      for (const match of matches) {
        if (match.index < cursor) continue;
        rendered.push(
          escapeTelegramMarkdownV2(sanitizedValue.slice(cursor, match.index)),
          formatTelegramLink(
            sanitizedValue.slice(match.index, match.index + match.label.length),
            match.url,
          ),
        );
        cursor = match.index + match.label.length;
        if (match.kind === "holder") didLinkHolder = true;
        if (match.kind === "market") didLinkMarket = true;
      }
      rendered.push(escapeTelegramMarkdownV2(sanitizedValue.slice(cursor)));
      return rendered.join("");
    },
  };
}

function buildSignalBotHolderLinkCandidates(note: SignalBotNote): string[] {
  const collisionLabels = buildSignalBotHolderLinkCollisionLabels(note);
  const candidates: string[] = [];
  for (const raw of [note.holderIdentityDisplayName, note.holderDisplayName]) {
    const label = normalizeSignalBotPublicHolderLabel(raw);
    if (!label) continue;
    candidates.push(label);
  }
  const unique = new Set<string>();
  const safeCandidates: string[] = [];
  for (const candidate of candidates) {
    const key = normalizeSignalBotHolderLinkKey(candidate);
    if (!key || unique.has(candidate)) continue;
    if (!isSafeSignalBotHolderLinkLabel(candidate, collisionLabels)) continue;
    unique.add(candidate);
    safeCandidates.push(candidate);
  }
  return safeCandidates.sort((a, b) => b.length - a.length);
}

function buildSignalBotHolderLinkCollisionLabels(
  note: SignalBotNote,
): Set<string> {
  const labels = new Set<string>();
  const addLabel = (value: string | null | undefined) => {
    const key = normalizeSignalBotHolderLinkKey(value);
    if (key) labels.add(key);
    for (const token of tokenizeSignalBotHolderLinkCollisionLabel(value)) {
      const tokenKey = normalizeSignalBotHolderLinkKey(token);
      if (tokenKey) labels.add(tokenKey);
    }
  };

  addLabel("YES");
  addLabel("NO");
  addLabel(note.marketVenue);
  addLabel(formatVenueLabel(note.marketVenue));
  addLabel(note.marketTitle);
  addLabel(note.eventTitle);
  if (note.marketSegment)
    addLabel(formatMarketSegmentLabel(note.marketSegment));
  for (const outcome of note.outcomes ?? []) addLabel(outcome);
  return labels;
}

function tokenizeSignalBotHolderLinkCollisionLabel(
  value: string | null | undefined,
): string[] {
  return (value ?? "")
    .split(/[^0-9A-Za-z@]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeSignalBotHolderLinkLabel(
  value: string | null | undefined,
): string | null {
  const label = value?.trim().replace(/\s+/g, " ");
  return label ? label : null;
}

function normalizeSignalBotPublicHolderLabel(
  value: string | null | undefined,
): string | null {
  const label = normalizeSignalBotHolderLinkLabel(value);
  if (!label) return null;
  return label.replace(/^@+/, "").trim() || label;
}

function normalizeSignalBotHolderLinkKey(
  value: string | null | undefined,
): string {
  return (value ?? "")
    .trim()
    .replace(/^@+/, "")
    .replace(/[^0-9A-Za-z]+/g, "")
    .toUpperCase();
}

function isSafeSignalBotHolderLinkLabel(
  label: string,
  collisionLabels: Set<string>,
): boolean {
  const key = normalizeSignalBotHolderLinkKey(label);
  if (key.length < 3) return false;
  if (HOLDER_LINK_STOP_LABELS.has(key)) return false;
  if (HOLDER_LINK_STOP_WORDS.has(key)) return false;
  return !collisionLabels.has(key);
}

function findSignalBotHolderLinkMatch(
  value: string,
  candidates: string[],
): SignalBotHolderLinkMatch | null {
  let best: SignalBotHolderLinkMatch | null = null;
  for (const label of candidates) {
    let start = 0;
    while (start < value.length) {
      const index = value.indexOf(label, start);
      if (index < 0) break;
      if (isSignalBotHolderLinkMatchAllowed(value, label, index)) {
        if (
          !best ||
          index < best.index ||
          (index === best.index && label.length > best.label.length)
        ) {
          best = { index, label };
        }
        break;
      }
      start = index + Math.max(label.length, 1);
    }
  }
  return best;
}

function isSignalBotHolderLinkMatchAllowed(
  value: string,
  label: string,
  index: number,
): boolean {
  const before = index > 0 ? value[index - 1] : "";
  const after = value[index + label.length] ?? "";
  if (!isSignalBotHolderLinkBoundary(before)) return false;
  if (!isSignalBotHolderLinkBoundary(after)) return false;
  if (/^\d+$/.test(label)) {
    if (isSignalBotNumericLinkBlockedBefore(value, index)) return false;
    if (isSignalBotNumericLinkBlockedAfter(value, index + label.length)) {
      return false;
    }
  }
  return true;
}

function isSignalBotHolderLinkBoundary(char: string): boolean {
  return !char || !/[0-9A-Za-z_@]/.test(char);
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeSignalBotPublicHolderMentions(
  value: string,
  note: SignalBotNote,
): string {
  let output = value;
  for (const raw of [note.holderIdentityDisplayName, note.holderDisplayName]) {
    const rawLabel = normalizeSignalBotHolderLinkLabel(raw);
    const publicLabel = normalizeSignalBotPublicHolderLabel(raw);
    if (!rawLabel || !publicLabel || rawLabel === publicLabel) continue;
    const pattern = new RegExp(
      `(^|[^0-9A-Za-z_])${escapeRegExpLiteral(rawLabel)}(?=$|[^0-9A-Za-z_])`,
      "g",
    );
    output = output.replace(pattern, `$1${publicLabel}`);
  }
  return output;
}

function isSignalBotNumericLinkBlockedBefore(
  value: string,
  index: number,
): boolean {
  const before = index > 0 ? value[index - 1] : "";
  const beforeBefore = index > 1 ? value[index - 2] : "";
  if (!before) return false;
  if ("$+-%¢".includes(before)) return true;
  if ("./:,".includes(before) && /\d/.test(beforeBefore)) return true;
  return false;
}

function isSignalBotNumericLinkBlockedAfter(
  value: string,
  index: number,
): boolean {
  const after = value[index] ?? "";
  const afterAfter = value[index + 1] ?? "";
  if (!after) return false;
  if ("$+-%¢".includes(after)) return true;
  if ("./:,".includes(after) && /\d/.test(afterAfter)) return true;
  return false;
}

function isSignalBotPrivateChat(chatType: string | null | undefined): boolean {
  return chatType === "private";
}

function buildSignalBotTelegramButton(input: {
  appBaseUrl: string;
  chatType?: string | null;
  miniAppLinkBase?: string | null;
  startParam: string | null | undefined;
  text: string;
}): TelegramInlineKeyboardButton | null {
  if (
    input.miniAppLinkBase &&
    isSignalBotPrivateChat(input.chatType) &&
    input.startParam
  ) {
    return buildHunchMiniAppWebButton({
      appBaseUrl: input.appBaseUrl,
      enabled: true,
      startParam: input.startParam,
      text: input.text,
    });
  }
  return buildHunchMiniAppDeepLinkButton({
    miniAppLinkBase: input.miniAppLinkBase,
    startParam: input.startParam,
    text: input.text,
  });
}

function pushSignalBotButtonRow(
  rows: TelegramInlineKeyboard["inline_keyboard"],
  button: TelegramInlineKeyboardButton | null,
): boolean {
  if (!button) return false;
  rows.push([button]);
  return true;
}

export function buildSignalBotMessage(input: {
  allowBuyCta?: boolean;
  appBaseUrl: string;
  buyAmountUsd: number;
  chatType?: string | null;
  cheaperAlternative?: SignalBotCheaperAlternative | null;
  deliveryTarget?: SignalBotCheaperAlternative | null;
  deliveryRef?: string | null;
  forceOpenMarket?: boolean;
  messageKind?: "initial" | "research_update";
  note: SignalBotNote;
  copyPolicy?: ResolvedSignalPostCopyPolicy;
  telegramMiniAppLinkBase?: string | null;
}): {
  keyboard: TelegramInlineKeyboard | undefined;
  publishable: boolean;
  text: string;
} {
  const messageKind = input.messageKind ?? "initial";
  const note = input.note;
  const buySide = resolveSignalBotBuySide(note);
  const price = buySide ? resolveSignalBotBuyPrice(note, buySide) : null;
  const displayPrice = buySide
    ? resolveSignalBotDisplayPrice(note, buySide)
    : null;
  const evidenceRows = resolvePersistedSignalEvidence(note);
  const presentation =
    resolvePersistedOrCurrentTelegramMarketPresentation(note);
  const buySideCopy = buySide ? buildSignalBotSideCopy(note, buySide) : null;
  const notificationCopy = buildSignalBotInitialNotificationCopy({
    copyPolicy: input.copyPolicy,
    messageKind,
    note,
    side: buySide,
  });
  const weakPublicInitial =
    messageKind === "initial" &&
    input.chatType != null &&
    !isSignalBotPrivateChat(input.chatType) &&
    notificationCopy.headline.templateKey === "initial_watch_v7";
  const publishable = notificationCopy.publishable && !weakPublicInitial;
  if (!publishable) {
    return { keyboard: undefined, publishable: false, text: "" };
  }
  const holderStartParam =
    !buySide || !note.holderSide || note.holderSide === buySide
      ? buildSignalBotHolderStartParam({
          address: note.holderAddress,
          chain: note.holderChain,
          eventId: note.eventId,
          marketId: note.marketId,
          noteId: note.id,
          side: note.holderSide,
        })
      : null;
  const holderMiniAppUrl = buildSignalBotMiniAppUrl({
    base: input.telegramMiniAppLinkBase,
    startParam: holderStartParam,
  });
  const marketStartParam = note.eventId
    ? buildSignalBotMarketStartParam({
        deliveryRef: input.deliveryRef,
        eventId: note.eventId,
        marketId: note.marketId,
        side: buySide,
      })
    : null;
  const marketMiniAppUrl = buildSignalBotMiniAppUrl({
    base: input.telegramMiniAppLinkBase,
    startParam: marketStartParam,
  });
  const bodyRenderer = createSignalBotBodyTextRenderer(
    note,
    holderMiniAppUrl,
    marketMiniAppUrl,
    [
      buySideCopy?.rawOutcomeLabel ?? null,
      buySideCopy?.sideLabel ?? null,
      buySide ? presentation.positions[buySide].canonicalLabel : null,
      note.marketTitle,
      note.eventTitle,
    ].filter((value): value is string => Boolean(value)),
  );
  const sanitizedDescription =
    messageKind === "research_update"
      ? sanitizeSignalBotResearchDescription(note.description, note, buySide)
      : sanitizeSignalBotInitialDescription(note.description);
  const canonicalDescription = sanitizedDescription
    ? normalizeTelegramPresentationAliases(sanitizedDescription, presentation)
    : null;
  const description =
    canonicalDescription ??
    (messageKind === "initial" && buySideCopy
      ? formatSignalBotDescriptionFallback(buySideCopy)
      : null);
  const summary = description ? bodyRenderer.render(description) : null;
  const researchPosition =
    messageKind === "research_update" && buySide
      ? formatSignalBotResearchPosition({
          note,
          price: displayPrice,
          researchDelta: notificationCopy.researchDelta,
          side: buySide,
          sideLabel: resolveSignalBotCurrentSideLabel({
            presentation,
            side: buySide,
            sideCopy: buySideCopy,
          }),
        })
      : null;
  const renderedResearchPosition = researchPosition
    ? bodyRenderer.render(
        normalizeTelegramPresentationAliases(
          researchPosition.text,
          presentation,
        ),
      )
    : null;
  const titleLine = formatSignalNotificationHeadlineMarkdown(
    notificationCopy.headline,
  );
  const supportingEvidenceRows = evidenceRows.filter(
    (row) => row.id !== notificationCopy.headline.primaryEvidenceId,
  );
  const credentialBlock =
    messageKind === "initial" && supportingEvidenceRows.length > 0
      ? formatSignalBotEvidenceBlock(supportingEvidenceRows)
      : null;
  const blocks = [
    titleLine,
    summary,
    ...(renderedResearchPosition && researchPosition
      ? [
          `${formatTelegramBold(researchPosition.label)}: ${renderedResearchPosition}`,
        ]
      : []),
    credentialBlock,
    ...(!input.telegramMiniAppLinkBase
      ? [escapeTelegramMarkdownV2("Mini App temporarily unavailable.")]
      : []),
  ];

  const keyboardRows: TelegramInlineKeyboard["inline_keyboard"] = [];
  const allowBuyCta = input.allowBuyCta ?? messageKind === "initial";
  let addedBuyButton = false;
  if (allowBuyCta && note.eventId && note.marketId && buySide) {
    const tradeTarget = input.deliveryTarget ?? {
      eventId: note.eventId,
      marketId: note.marketId,
      price: price ?? 0,
      side: buySide,
      venue: note.marketVenue ?? "unknown",
    };
    const tradeSideLabel =
      tradeTarget.side === buySide
        ? presentation.positions[buySide].shortLabel
        : tradeTarget.side;
    addedBuyButton = pushSignalBotButtonRow(
      keyboardRows,
      buildSignalBotTelegramButton({
        appBaseUrl: input.appBaseUrl,
        chatType: input.chatType,
        miniAppLinkBase: input.telegramMiniAppLinkBase,
        startParam: buildSignalBotBuyStartParam({
          amountUsd: input.buyAmountUsd,
          deliveryRef: input.deliveryRef,
          eventId: tradeTarget.eventId,
          marketId: tradeTarget.marketId,
          side: tradeTarget.side,
        }),
        text: formatSignalBotBuyButtonText({
          price: input.deliveryTarget ? tradeTarget.price : price,
          side: tradeTarget.side,
          sideLabel: tradeSideLabel,
          venue: tradeTarget.venue,
        }),
      }),
    );
    if (
      !input.deliveryTarget &&
      input.cheaperAlternative &&
      input.cheaperAlternative.side === buySide
    ) {
      const addedCheaperButton = pushSignalBotButtonRow(
        keyboardRows,
        buildSignalBotTelegramButton({
          appBaseUrl: input.appBaseUrl,
          chatType: input.chatType,
          miniAppLinkBase: input.telegramMiniAppLinkBase,
          startParam: buildSignalBotBuyStartParam({
            amountUsd: input.buyAmountUsd,
            deliveryRef: input.deliveryRef,
            eventId: input.cheaperAlternative.eventId,
            marketId: input.cheaperAlternative.marketId,
            side: input.cheaperAlternative.side,
          }),
          text: formatSignalBotCheaperButtonText({
            alternative: input.cheaperAlternative,
            sideLabel: presentation.positions[buySide].shortLabel,
          }),
        }),
      );
      addedBuyButton = addedBuyButton || addedCheaperButton;
    }
  }
  if (!addedBuyButton && note.eventId) {
    pushSignalBotButtonRow(
      keyboardRows,
      buildSignalBotTelegramButton({
        appBaseUrl: input.appBaseUrl,
        chatType: input.chatType,
        miniAppLinkBase: input.telegramMiniAppLinkBase,
        startParam: marketStartParam,
        text: "↗️ Open market",
      }),
    );
  }

  return {
    keyboard:
      keyboardRows.length > 0 ? { inline_keyboard: keyboardRows } : undefined,
    publishable: true,
    text: joinTelegramMessageBlocks(blocks),
  };
}

function resolveSignalBotFollowthroughBuyPrice(input: {
  candidate: SignalBotFollowthroughCandidateRow;
  side: "NO" | "YES";
}): number | null {
  return resolveSignalBotBuyPrice(
    {
      bestAsk: toNumber(input.candidate.best_ask),
      bestBid: toNumber(input.candidate.best_bid),
      lastPrice: toNumber(input.candidate.last_price),
    },
    input.side,
  );
}

function resolveSignalBotFollowthroughDeliveryTarget(
  candidate: SignalBotFollowthroughCandidateRow,
): SignalBotCheaperAlternative | null {
  const rootMetrics = asObject(candidate.root_metrics);
  const delivery = asObject(rootMetrics.delivery);
  const view = asObject(delivery.view);
  const target = asObject(view.target);
  const eventId = typeof target.eventId === "string" ? target.eventId : null;
  const marketId = typeof target.marketId === "string" ? target.marketId : null;
  const price = toNumber(target.price);
  const side = String(target.side ?? "").toUpperCase();
  const venue = normalizeHunchVenue(target.venue);
  if (
    eventId &&
    marketId &&
    price != null &&
    price > 0 &&
    price <= 1 &&
    (side === "YES" || side === "NO") &&
    venue
  ) {
    return { eventId, marketId, price, side, venue };
  }
  const sourceSide = sideFromSignalBotDirection(candidate.direction);
  const sourceVenue = normalizeHunchVenue(candidate.venue);
  if (!candidate.event_id || !sourceSide || !sourceVenue) return null;
  return {
    eventId: candidate.event_id,
    marketId: candidate.market_id,
    price:
      resolveSignalBotFollowthroughBuyPrice({
        candidate,
        side: sourceSide,
      }) ?? 0,
    side: sourceSide,
    venue: sourceVenue,
  };
}

function isSignalBotFollowthroughBuyCtaEligible(input: {
  allowBuyCta: boolean;
  buyPrice: number | null;
  stats: SignalBotFollowthroughStats;
}): boolean {
  if (!input.allowBuyCta) return false;
  if (input.stats.state !== "open") return false;
  if (!input.stats.signalSide) return false;
  if (input.buyPrice == null || input.buyPrice > 0.95) return false;
  const hasWalletEvidence =
    input.stats.joinedOrAddedWallets > 0 ||
    input.stats.netSignalSideFlowUsd > 0;
  if (!hasWalletEvidence) return false;
  return input.stats.priceMoveCents == null || input.stats.priceMoveCents >= 0;
}

function buildSignalBotFollowthroughKeyboard(input: {
  allowBuyCta: boolean;
  appBaseUrl: string;
  buyPrice: number | null;
  buyAmountUsd: number;
  candidate: SignalBotFollowthroughCandidateRow;
  chatType?: string | null;
  deliveryRef?: string | null;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  stats: SignalBotFollowthroughStats;
  telegramMiniAppLinkBase?: string | null;
  target: SignalBotCheaperAlternative | null;
}): TelegramInlineKeyboard | undefined {
  const target = input.target;
  if (
    input.kind !== "followthrough_stats" ||
    input.stats.state !== "open" ||
    !target
  ) {
    return undefined;
  }

  const eventId = target.eventId;
  const marketId = target.marketId;
  const side = target.side;
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [];
  let addedBuyButton = false;

  if (side) {
    const buyPrice = input.buyPrice;
    if (
      isSignalBotFollowthroughBuyCtaEligible({
        allowBuyCta: input.allowBuyCta,
        buyPrice,
        stats: input.stats,
      })
    ) {
      addedBuyButton = pushSignalBotButtonRow(
        rows,
        buildSignalBotTelegramButton({
          appBaseUrl: input.appBaseUrl,
          chatType: input.chatType,
          miniAppLinkBase: input.telegramMiniAppLinkBase,
          startParam: buildSignalBotBuyStartParam({
            amountUsd: input.buyAmountUsd,
            deliveryRef: input.deliveryRef,
            eventId,
            marketId,
            side,
          }),
          text: formatSignalBotBuyButtonText({
            price: buyPrice,
            side,
            sideLabel:
              target.marketId === input.candidate.market_id
                ? buildSignalBotFollowthroughSideCopy(input.candidate, side)
                    .buttonLabel
                : side,
            venue: target.venue,
          }),
        }),
      );
    }
  }

  if (!addedBuyButton) {
    pushSignalBotButtonRow(
      rows,
      buildSignalBotTelegramButton({
        appBaseUrl: input.appBaseUrl,
        chatType: input.chatType,
        miniAppLinkBase: input.telegramMiniAppLinkBase,
        startParam: buildSignalBotMarketStartParam({
          deliveryRef: input.deliveryRef,
          eventId,
          marketId,
          side,
        }),
        text: "↗️ Open market",
      }),
    );
  }

  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

async function resolveSignalBotFollowthroughBuyCtaPrice(input: {
  db: DbQuery;
  redis: SignalBotRedisLike;
  stats: SignalBotFollowthroughStats;
  target: SignalBotCheaperAlternative | null;
}): Promise<number | null> {
  const side = input.target?.side ?? null;
  const venue = normalizeHunchVenue(input.target?.venue);
  if (!side || !venue || input.stats.state !== "open" || !input.target) {
    return null;
  }
  const lifecycle = await resolveSignalBotVenueLifecycle(input.db);
  if (
    !getVenuesWithLifecycleCapability(
      lifecycle.policy,
      "signalDelivery",
    ).includes(venue) ||
    !getVenuesWithLifecycleCapability(
      lifecycle.policy,
      "increaseExposure",
    ).includes(venue)
  ) {
    return null;
  }
  const priceGuard = await loadSignalBotPriceGuardBlockers({
    buySide: side,
    db: input.db,
    note: { marketId: input.target.marketId },
    redis: input.redis,
  });
  if (
    priceGuard.defer ||
    !priceGuard.orderable ||
    priceGuard.blockers.length > 0 ||
    !isSignalBotFollowthroughBuyCtaEligible({
      allowBuyCta: true,
      buyPrice: priceGuard.buyPrice,
      stats: input.stats,
    })
  ) {
    return null;
  }
  return priceGuard.buyPrice;
}

export async function enableSignalBotChat(input: {
  chat: TelegramBotChat;
  enabledBy: number;
  now?: Date;
  redis: SignalBotRedisLike;
}): Promise<SignalBotChatState> {
  const now = input.now ?? new Date();
  const chatId = String(input.chat.id);
  const state: SignalBotChatState = {
    chatId,
    chatTitle: resolveChatTitle(input.chat),
    chatType: input.chat.type ?? null,
    enabledBy: String(input.enabledBy),
    enabledAt: now.toISOString(),
    cursorCreatedAt: now.toISOString(),
    cursorId: DEFAULT_CURSOR_ID,
    destinationPolicy: null,
  };
  await input.redis.sAdd(CHAT_SET_KEY, chatId);
  await writeChatState(input.redis, state);
  return state;
}

export async function disableSignalBotChat(
  redis: SignalBotRedisLike,
  chatId: string,
): Promise<void> {
  await redis.sRem(CHAT_SET_KEY, chatId);
  await redis.del(signalBotChatKey(chatId));
}

export async function getSignalBotChatState(
  redis: SignalBotRedisLike,
  chatId: string,
): Promise<SignalBotChatState | null> {
  const raw = await redis.hGetAll(signalBotChatKey(chatId));
  return parseChatState(raw);
}

export async function updateSignalBotChatCursor(input: {
  chatId: string;
  createdAt: string;
  id: string;
  redis: SignalBotRedisLike;
}): Promise<void> {
  const existing = await getSignalBotChatState(input.redis, input.chatId);
  if (!existing) return;
  await writeChatState(input.redis, {
    ...existing,
    cursorCreatedAt: input.createdAt,
    cursorId: input.id,
  });
}

export async function updateSignalBotDestinationPolicy(input: {
  chatId: string;
  policy: SignalDestinationPolicy;
  redis: SignalBotRedisLike;
}): Promise<boolean> {
  const existing = await getSignalBotChatState(input.redis, input.chatId);
  if (!existing) return false;
  await writeChatState(input.redis, {
    ...existing,
    destinationPolicy: input.policy,
  });
  return true;
}

export type SignalBotMenuScreenName =
  | "account"
  | "admin"
  | "admin_help"
  | "help"
  | "home"
  | "market_input"
  | "notification_funds"
  | "notification_trading"
  | "notifications"
  | "performance"
  | "positions"
  | "settings"
  | "signals"
  | "trading";

type SignalBotMenuCallbackRoute =
  | { kind: "admin_preview" }
  | { kind: "cancel_market_input" }
  | {
      enabled: boolean;
      kind: "notification_set";
      topic: TelegramNotificationTopic;
    }
  | { kind: "screen"; screen: SignalBotMenuScreenName }
  | {
      detail: boolean;
      kind: "stats";
      period: SignalBotStatsPeriod;
    }
  | { kind: "stale" }
  | SignalBotInteractiveMenuRoute
  | { kind: "trading_status" };

type SignalBotMenuTransport = {
  editMessageText?: SignalBotTelegramClient["editMessageText"];
  sendMessage: SignalBotTelegramClient["sendMessage"];
};

function buildSignalBotMainMiniAppButton(input: {
  appBaseUrl: string;
  miniAppEnabled: boolean;
  text?: string;
}): TelegramInlineKeyboardButton | null {
  return buildHunchMiniAppWebButton({
    appBaseUrl: input.appBaseUrl,
    enabled: input.miniAppEnabled,
    path: SIGNAL_BOT_TELEGRAM_WEB_APP_ENTRY_PATH,
    text: input.text ?? "Open Hunch",
  });
}

function buildSignalBotSettingsMiniAppButton(input: {
  appBaseUrl: string;
  miniAppEnabled: boolean;
  path: string;
  text: string;
}): TelegramInlineKeyboardButton | null {
  return buildHunchMiniAppWebButton({
    appBaseUrl: input.appBaseUrl,
    enabled: input.miniAppEnabled,
    path: input.path,
    text: input.text,
  });
}

function buildSignalBotOptionalButtonRows(
  button: TelegramInlineKeyboardButton | null,
): TelegramInlineKeyboardButton[][] {
  return button ? [[button]] : [];
}

function buildSignalBotMenuNavRow(input: {
  includeHome?: boolean;
  parent: SignalBotMenuScreenName;
}): TelegramInlineKeyboardButton[] {
  const row: TelegramInlineKeyboardButton[] = [
    {
      callback_data: SIGNAL_BOT_MENU_CALLBACK_PREFIX + input.parent,
      text: "◀ Back",
    },
  ];
  if (input.includeHome) {
    row.push({
      callback_data: SIGNAL_BOT_MENU_CALLBACK_PREFIX + "home",
      text: "🏠 Home",
    });
  }
  return row;
}

export function buildSignalBotMenuScreen(input: {
  appBaseUrl: string;
  audience?: TelegramBotMenuAudience;
  isAdmin: boolean;
  miniAppEnabled: boolean;
  notice?: string | null;
  notificationPreferences?: TelegramNotificationPreferences | null;
  screen: SignalBotMenuScreenName;
}): { keyboard: TelegramInlineKeyboard; text: string } {
  const miniAppButton = buildSignalBotMainMiniAppButton(input);
  const noticeLines = input.notice
    ? ["", formatTelegramItalic(input.notice)]
    : [];
  const callback = (
    route: string,
    text: string,
  ): TelegramInlineKeyboardButton => ({
    callback_data: SIGNAL_BOT_MENU_CALLBACK_PREFIX + route,
    text,
  });
  const countEnabled = (values: boolean[]) =>
    values.filter(Boolean).length + "/" + values.length + " on";
  const toggleLabel = (enabled: boolean, label: string) =>
    `${enabled ? "✅" : "⬜"} ${label}`;
  const toggleRoute = (route: string, enabled: boolean) =>
    `${route}:${enabled ? "off" : "on"}`;
  if (input.screen === "home") {
    if (input.audience === "guest") {
      const guestButton = buildSignalBotMainMiniAppButton({
        appBaseUrl: input.appBaseUrl,
        miniAppEnabled: input.miniAppEnabled,
        text: "Open Hunch · Create or sign in",
      });
      return {
        keyboard: {
          inline_keyboard: buildSignalBotOptionalButtonRows(guestButton),
        },
        text: [
          formatTelegramBold("👋 Welcome to Hunch"),
          "",
          escapeTelegramMarkdownV2(
            "Open Hunch to create an account or sign in. After signing in, enable Telegram Trading in Hunch if you want to trade from Telegram.",
          ),
          ...(!guestButton
            ? [
                "",
                escapeTelegramMarkdownV2(
                  "The Hunch Mini App is temporarily unavailable.",
                ),
              ]
            : []),
          ...noticeLines,
        ].join("\n"),
      };
    }
    if (input.audience === "unavailable") {
      return {
        keyboard: {
          inline_keyboard: [
            [callback("trading:market_input", "🔎 Markets")],
            ...buildSignalBotOptionalButtonRows(miniAppButton),
          ],
        },
        text: [
          formatTelegramBold("🔮 Hunch"),
          "",
          escapeTelegramMarkdownV2(
            "Account details could not refresh. You can still browse markets or open Hunch.",
          ),
          ...(!miniAppButton
            ? [
                "",
                escapeTelegramMarkdownV2(
                  "The Hunch Mini App is temporarily unavailable.",
                ),
              ]
            : []),
          ...noticeLines,
        ].join("\n"),
      };
    }
    const rows: TelegramInlineKeyboard["inline_keyboard"] = [
      [callback("trading:market_input", "🔎 Markets")],
      [callback("positions", "💼 My positions")],
      [callback("trading:status", "👤 My trading")],
      [callback("deposit", "💳 Deposit")],
      [callback("settings:notifications", "🔔 Notifications")],
      [callback("settings", "⚙️ Settings"), callback("help", "❓ Help")],
    ];
    if (input.isAdmin) {
      rows.push([callback("admin", "🛠 Admin")]);
    }
    return {
      keyboard: { inline_keyboard: rows },
      text: [
        formatTelegramBold("🔮 Hunch"),
        "",
        escapeTelegramMarkdownV2(
          "Market signals and trading without leaving Telegram.",
        ),
        "",
        escapeTelegramMarkdownV2("Choose what you want to do."),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "positions") {
    return {
      keyboard: {
        inline_keyboard: [buildSignalBotMenuNavRow({ parent: "home" })],
      },
      text: [
        formatTelegramBold("💼 My positions"),
        "",
        escapeTelegramMarkdownV2("Updating positions…"),
      ].join("\n"),
    };
  }
  if (input.screen === "trading") {
    return {
      keyboard: {
        inline_keyboard: [
          [callback("trading:status", "↻ Refresh trading status")],
          ...buildSignalBotOptionalButtonRows(miniAppButton),
          buildSignalBotMenuNavRow({ parent: "home" }),
        ],
      },
      text: [
        formatTelegramBold("👤 My trading"),
        "",
        escapeTelegramMarkdownV2(
          "Your detailed trading status is sent as a separate card below this menu.",
        ),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "market_input") {
    return {
      keyboard: {
        inline_keyboard: [
          [
            callback("trading:cancel_input", "✕ Cancel"),
            callback("home", "🏠 Home"),
          ],
        ],
      },
      text: [
        formatTelegramBold("🔎 Markets"),
        "",
        escapeTelegramMarkdownV2(
          "Send a market name, person, team, Hunch URL, venue URL, or market ID.",
        ),
        "",
        formatTelegramItalic(
          "This request expires automatically after 10 minutes.",
        ),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "settings") {
    const telegramTradingButton = buildSignalBotSettingsMiniAppButton({
      appBaseUrl: input.appBaseUrl,
      miniAppEnabled: input.miniAppEnabled,
      path: "/settings/telegram-trading",
      text: "🤖 Telegram trading",
    });
    return {
      keyboard: {
        inline_keyboard: [
          [callback("settings:notifications", "🔔 Notifications")],
          [callback("settings:signals", "📡 Signals")],
          [callback("settings:account", "👤 Account")],
          ...buildSignalBotOptionalButtonRows(telegramTradingButton),
          buildSignalBotMenuNavRow({ parent: "home" }),
        ],
      },
      text: [
        formatTelegramBold("⚙️ Settings"),
        "",
        escapeTelegramMarkdownV2(
          "Choose what Hunch can send you and manage trading permissions.",
        ),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "notifications") {
    const preferences = input.notificationPreferences;
    if (!preferences) {
      return {
        keyboard: {
          inline_keyboard: [
            ...buildSignalBotOptionalButtonRows(miniAppButton),
            buildSignalBotMenuNavRow({
              includeHome: true,
              parent: "settings",
            }),
          ],
        },
        text: [
          formatTelegramBold("🔔 Notifications"),
          "",
          escapeTelegramMarkdownV2(
            "Connect this Telegram account to Hunch before enabling personal notifications.",
          ),
          ...noticeLines,
        ].join("\n"),
      };
    }
    return {
      keyboard: {
        inline_keyboard: [
          [
            callback(
              "settings:notifications:trading",
              `📈 Trading · ${countEnabled([
                preferences.orderFilled,
                preferences.orderIssues,
                preferences.positionResolved,
              ])}`,
            ),
          ],
          [
            callback(
              "settings:notifications:funds",
              `💰 Funds & payouts · ${countEnabled([
                preferences.depositReceived,
                preferences.bridgeUpdates,
                preferences.payoutsRewards,
              ])}`,
            ),
          ],
          buildSignalBotMenuNavRow({
            includeHome: true,
            parent: "settings",
          }),
        ],
      },
      text: [
        formatTelegramBold("🔔 Notifications"),
        "",
        escapeTelegramMarkdownV2(
          "Choose a category. Each event can be controlled separately.",
        ),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "notification_trading") {
    const preferences = input.notificationPreferences;
    if (!preferences) {
      return {
        keyboard: {
          inline_keyboard: [
            ...buildSignalBotOptionalButtonRows(miniAppButton),
            buildSignalBotMenuNavRow({
              includeHome: true,
              parent: "notifications",
            }),
          ],
        },
        text: [
          formatTelegramBold("📈 Trading notifications"),
          "",
          escapeTelegramMarkdownV2(
            "Connect this Telegram account to Hunch before enabling personal notifications.",
          ),
          ...noticeLines,
        ].join("\n"),
      };
    }
    return {
      keyboard: {
        inline_keyboard: [
          [
            callback(
              toggleRoute("ntf:fill", preferences.orderFilled),
              toggleLabel(preferences.orderFilled, "Order fills"),
            ),
          ],
          [
            callback(
              toggleRoute("ntf:issues", preferences.orderIssues),
              toggleLabel(preferences.orderIssues, "Order problems"),
            ),
          ],
          [
            callback(
              toggleRoute("ntf:resolution", preferences.positionResolved),
              toggleLabel(preferences.positionResolved, "Position results"),
            ),
          ],
          buildSignalBotMenuNavRow({
            includeHome: true,
            parent: "notifications",
          }),
        ],
      },
      text: [
        formatTelegramBold("📈 Trading notifications"),
        "",
        escapeTelegramMarkdownV2(
          "Order execution, order problems, and resolved positions.",
        ),
        "",
        formatTelegramItalic("Tap a row to turn that notification on or off."),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "notification_funds") {
    const preferences = input.notificationPreferences;
    if (!preferences) {
      return {
        keyboard: {
          inline_keyboard: [
            ...buildSignalBotOptionalButtonRows(miniAppButton),
            buildSignalBotMenuNavRow({
              includeHome: true,
              parent: "notifications",
            }),
          ],
        },
        text: [
          formatTelegramBold("💰 Funds & payouts"),
          "",
          escapeTelegramMarkdownV2(
            "Connect this Telegram account to Hunch before enabling personal notifications.",
          ),
          ...noticeLines,
        ].join("\n"),
      };
    }
    return {
      keyboard: {
        inline_keyboard: [
          [
            callback(
              toggleRoute("ntf:deposit", preferences.depositReceived),
              toggleLabel(preferences.depositReceived, "Deposits received"),
            ),
          ],
          [
            callback(
              toggleRoute("ntf:bridge", preferences.bridgeUpdates),
              toggleLabel(preferences.bridgeUpdates, "Bridge results"),
            ),
          ],
          [
            callback(
              toggleRoute("ntf:payout", preferences.payoutsRewards),
              toggleLabel(preferences.payoutsRewards, "Payouts & rewards"),
            ),
          ],
          buildSignalBotMenuNavRow({
            includeHome: true,
            parent: "notifications",
          }),
        ],
      },
      text: [
        formatTelegramBold("💰 Funds & payouts"),
        "",
        escapeTelegramMarkdownV2(
          "Final deposit, bridge, redemption, and reward results.",
        ),
        "",
        formatTelegramItalic("Tap a row to turn that notification on or off."),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "signals") {
    const preferences = input.notificationPreferences;
    if (!preferences) {
      return {
        keyboard: {
          inline_keyboard: [
            ...buildSignalBotOptionalButtonRows(miniAppButton),
            buildSignalBotMenuNavRow({
              includeHome: true,
              parent: "settings",
            }),
          ],
        },
        text: [
          formatTelegramBold("📡 Signals"),
          "",
          escapeTelegramMarkdownV2(
            "Connect this Telegram account to Hunch before enabling personal signals.",
          ),
          ...noticeLines,
        ].join("\n"),
      };
    }
    return {
      keyboard: {
        inline_keyboard: [
          [
            callback(
              toggleRoute("ntf:position_signals", preferences.positionSignals),
              toggleLabel(
                preferences.positionSignals,
                "Signals for markets I hold",
              ),
            ),
          ],
          buildSignalBotMenuNavRow({
            includeHome: true,
            parent: "settings",
          }),
        ],
      },
      text: [
        formatTelegramBold("📡 Signals"),
        "",
        formatTelegramBold("Portfolio"),
        escapeTelegramMarkdownV2(
          "New Hunch research for markets in your open positions.",
        ),
        "",
        formatTelegramItalic(
          "Tracked-wallet alerts will appear here after server-side subscriptions are available.",
        ),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "account") {
    const accountButton = buildSignalBotSettingsMiniAppButton({
      appBaseUrl: input.appBaseUrl,
      miniAppEnabled: input.miniAppEnabled,
      path: "/settings/account",
      text: "Manage account",
    });
    const walletsButton = buildSignalBotSettingsMiniAppButton({
      appBaseUrl: input.appBaseUrl,
      miniAppEnabled: input.miniAppEnabled,
      path: "/settings/wallets",
      text: "Manage wallets",
    });
    return {
      keyboard: {
        inline_keyboard: [
          ...buildSignalBotOptionalButtonRows(accountButton),
          ...buildSignalBotOptionalButtonRows(walletsButton),
          buildSignalBotMenuNavRow({
            includeHome: true,
            parent: "settings",
          }),
        ],
      },
      text: [
        formatTelegramBold("👤 Account"),
        "",
        escapeTelegramMarkdownV2(
          input.notificationPreferences
            ? "Hunch account: Linked to this Telegram profile."
            : "Hunch account: Not linked to this Telegram profile.",
        ),
        "",
        escapeTelegramMarkdownV2(
          "Account, sign-in, and wallet changes are confirmed inside Hunch.",
        ),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "help") {
    return {
      keyboard: {
        inline_keyboard: [
          [callback("trading:market_input", "💸 Trade a market")],
          ...buildSignalBotOptionalButtonRows(miniAppButton),
          buildSignalBotMenuNavRow({ parent: "home" }),
        ],
      },
      text: [
        formatTelegramBold("❓ How Hunch works"),
        "",
        formatTelegramBlockquote([
          formatTelegramBold("Signals"),
          escapeTelegramMarkdownV2(
            "Channel posts explain the market read and link to the relevant market and wallet context.",
          ),
          "",
          formatTelegramBold("Trading"),
          escapeTelegramMarkdownV2(
            "Open a private market card, choose an amount, and confirm before anything is submitted.",
          ),
        ]),
        "",
        escapeTelegramMarkdownV2(
          "Use the buttons below. Slash commands remain optional shortcuts.",
        ),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "performance") {
    return {
      keyboard: {
        inline_keyboard: [
          [
            callback("performance:24h", "24h"),
            callback("performance:7d", "7d"),
            callback("performance:30d", "30d"),
          ],
          [callback("performance:7d:detail", "📋 Detailed 7d report")],
          buildSignalBotMenuNavRow({ parent: "home" }),
        ],
      },
      text: [
        formatTelegramBold("📊 Signal performance"),
        "",
        escapeTelegramMarkdownV2("Choose a period."),
        "",
        formatTelegramItalic(
          "The report is sent as a separate message so you can keep navigating.",
        ),
        ...noticeLines,
      ].join("\n"),
    };
  }
  if (input.screen === "admin_help") {
    return {
      keyboard: {
        inline_keyboard: [
          buildSignalBotMenuNavRow({ includeHome: true, parent: "admin" }),
        ],
      },
      text: [
        formatTelegramBold("🛠 Admin command reference"),
        "",
        formatTelegramBlockquote(
          [
            "/enable_signals — enable a channel",
            "/disable_signals — disable a channel",
            "/signal_venues — select trading venues",
            "/status — inspect channel delivery",
            "/test_followthrough — preview a follow-up",
            "/test_trade — preview a trade card",
          ].map(escapeTelegramMarkdownV2),
        ),
        "",
        formatTelegramItalic(
          "These operational commands remain protected by the admin allowlist.",
        ),
      ].join("\n"),
    };
  }
  return {
    keyboard: {
      inline_keyboard: [
        [callback("admin:test_signal", "🧪 Preview latest signal")],
        [callback("performance", "📊 Performance")],
        [callback("admin:help", "📋 Command reference")],
        buildSignalBotMenuNavRow({ parent: "home" }),
      ],
    },
    text: [
      formatTelegramBold("🛠 Admin"),
      "",
      escapeTelegramMarkdownV2(
        "Preview content and open operational controls. Admin authorization is checked again for every action.",
      ),
      ...noticeLines,
    ].join("\n"),
  };
}

function parseSignalBotMenuCallback(
  data: string | null | undefined,
): SignalBotMenuCallbackRoute | null {
  if (!data?.startsWith("hm:")) return null;
  if (!data.startsWith(SIGNAL_BOT_MENU_CALLBACK_PREFIX)) {
    return { kind: "stale" };
  }
  const route = data.slice(SIGNAL_BOT_MENU_CALLBACK_PREFIX.length);
  const interactiveRoute = parseSignalBotInteractiveMenuRoute(route);
  if (interactiveRoute) return interactiveRoute;
  const notificationParts = route.split(":");
  if (notificationParts.length === 3 && notificationParts[0] === "ntf") {
    const topics: Record<string, TelegramNotificationTopic> = {
      bridge: "bridge_updates",
      deposit: "deposit_received",
      fill: "order_filled",
      issues: "order_issues",
      payout: "payouts_rewards",
      position_signals: "position_signals",
      resolution: "position_resolved",
    };
    const topic = topics[notificationParts[1] ?? ""];
    const state = notificationParts[2];
    if (topic && (state === "on" || state === "off")) {
      return {
        enabled: state === "on",
        kind: "notification_set",
        topic,
      };
    }
  }
  switch (route) {
    case "home":
    case "trading":
    case "help":
    case "performance":
    case "positions":
    case "settings":
    case "admin":
      return { kind: "screen", screen: route };
    case "settings:notifications":
      return { kind: "screen", screen: "notifications" };
    case "settings:notifications:funds":
      return { kind: "screen", screen: "notification_funds" };
    case "settings:notifications:trading":
      return { kind: "screen", screen: "notification_trading" };
    case "settings:signals":
      return { kind: "screen", screen: "signals" };
    case "settings:account":
      return { kind: "screen", screen: "account" };
    case "admin:help":
      return { kind: "screen", screen: "admin_help" };
    case "trading:market_input":
      return { kind: "screen", screen: "market_input" };
    case "trading:cancel_input":
      return { kind: "cancel_market_input" };
    case "trading:status":
      return { kind: "trading_status" };
    case "admin:test_signal":
      return { kind: "admin_preview" };
    case "performance:24h":
    case "performance:7d":
    case "performance:30d":
      return {
        detail: false,
        kind: "stats",
        period: route.slice("performance:".length) as SignalBotStatsPeriod,
      };
    case "performance:7d:detail":
      return { detail: true, kind: "stats", period: "7d" };
    default:
      return { kind: "stale" };
  }
}

function signalBotMenuScreenForNotificationTopic(
  topic: TelegramNotificationTopic,
): SignalBotMenuScreenName {
  if (topic === "position_signals") return "signals";
  if (
    topic === "deposit_received" ||
    topic === "bridge_updates" ||
    topic === "payouts_rewards"
  ) {
    return "notification_funds";
  }
  return "notification_trading";
}

function signalBotMenuScreenNeedsNotificationPreferences(
  screen: SignalBotMenuScreenName,
): boolean {
  return (
    screen === "account" ||
    screen === "notification_funds" ||
    screen === "notification_trading" ||
    screen === "notifications" ||
    screen === "signals"
  );
}

function signalBotMenuRouteRequiresAdmin(
  route: SignalBotMenuCallbackRoute,
): boolean {
  return (
    route.kind === "admin_preview" ||
    route.kind === "stats" ||
    (route.kind === "screen" &&
      (route.screen === "admin" ||
        route.screen === "admin_help" ||
        route.screen === "performance"))
  );
}

async function sendOrEditSignalBotMenuScreen(input: {
  audience?: TelegramBotMenuAudience;
  chatId: string;
  db?: DbQuery;
  isAdmin: boolean;
  messageId?: number | null;
  notice?: string | null;
  notificationPreferences?: TelegramNotificationPreferences | null;
  screen: SignalBotMenuScreenName;
  telegramUserId?: string | number | null;
  config: SignalBotConfig;
  transport: SignalBotMenuTransport;
}): Promise<TelegramSendResult> {
  const audience =
    input.audience ??
    (input.screen === "home"
      ? await resolveTelegramBotMenuAudience({
          db: input.db,
          telegramUserId: input.telegramUserId,
        })
      : "linked");
  const screen = buildSignalBotMenuScreen({
    appBaseUrl: input.config.appBaseUrl,
    audience,
    isAdmin: input.isAdmin,
    miniAppEnabled: input.config.telegramMiniAppLinkBase != null,
    notice: input.notice,
    notificationPreferences: input.notificationPreferences,
    screen: input.screen,
  });
  if (input.messageId != null && input.transport.editMessageText) {
    const edited = await input.transport.editMessageText({
      chat_id: input.chatId,
      disable_web_page_preview: true,
      message_id: input.messageId,
      parse_mode: "MarkdownV2",
      reply_markup: screen.keyboard,
      text: screen.text,
    });
    if (edited.ok || /message is not modified/i.test(edited.message)) {
      return edited;
    }
  }
  return input.transport.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: true,
    parse_mode: "MarkdownV2",
    reply_markup: screen.keyboard,
    text: screen.text,
  });
}

async function sendOrEditSignalBotMenuMessage(input: {
  chatId: string;
  message: {
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramInlineKeyboard;
    text: string;
  };
  messageId?: number | null;
  transport: SignalBotMenuTransport;
}): Promise<TelegramSendResult> {
  if (input.messageId != null && input.transport.editMessageText) {
    const edited = await input.transport.editMessageText({
      chat_id: input.chatId,
      disable_web_page_preview: true,
      message_id: input.messageId,
      parse_mode: input.message.parse_mode ?? "MarkdownV2",
      reply_markup: input.message.reply_markup,
      text: input.message.text,
    });
    if (edited.ok || /message is not modified/i.test(edited.message)) {
      return edited;
    }
  }
  return input.transport.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: true,
    parse_mode: input.message.parse_mode ?? "MarkdownV2",
    reply_markup: input.message.reply_markup,
    text: input.message.text,
  });
}

function buildSignalBotPrivateMenuEntry(input: {
  botUsername?: string | null;
  chatId: string;
  config: SignalBotConfig;
}): TelegramSendMessageInput {
  const targetUrl = input.botUsername
    ? "https://t.me/" + input.botUsername
    : input.config.telegramMiniAppLinkBase;
  return {
    chat_id: input.chatId,
    disable_web_page_preview: true,
    parse_mode: "MarkdownV2",
    ...(targetUrl
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: "Open bot menu", url: targetUrl }]],
          },
        }
      : {}),
    text: [
      formatTelegramBold("🔮 Hunch Signal Bot"),
      "",
      escapeTelegramMarkdownV2(
        "Open a private chat with the bot to use trading, account controls, and the Hunch Mini App.",
      ),
    ].join("\n"),
  };
}

type SignalBotMenuMessage = {
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: TelegramInlineKeyboard;
  text: string;
};

type SignalBotMenuLoaders = {
  loadDeposit?: (input: {
    telegramUserId: number;
    venue: string | null;
  }) => Promise<
    SignalBotMenuMessage & {
      depositAddress?: string;
      qrText?: string;
      venue?: string;
    }
  >;
  loadMarketCard?: (input: {
    chatId: string;
    context?: {
      observedNoAsk?: number | null;
      observedYesAsk?: number | null;
      origin: "search";
      returnCallbackData: string;
    };
    marketRef: string;
    publicBrowseOnly?: boolean;
    telegramMessageId: number | null;
    telegramUserId: number;
  }) => Promise<SignalBotMenuMessage>;
  loadPositionCard?: (input: {
    positionId: string;
    telegramUserId: number;
  }) => Promise<SignalBotMenuMessage>;
  loadPositions?: (telegramUserId: number) => Promise<SignalBotMenuMessage>;
  loadTradeStatus?: (telegramUserId: number) => Promise<SignalBotMenuMessage>;
  searchMarkets?: (input: {
    query?: string | null;
  }) => Promise<SignalBotMarketSearchResult[]>;
};

type SignalBotTestSignalHandlerResult = boolean | SignalBotTestSignalOutcome;

function normalizeSignalBotTestSignalOutcome(
  value: SignalBotTestSignalHandlerResult,
): SignalBotTestSignalOutcome {
  return typeof value === "boolean"
    ? { reason: value ? null : "no_eligible_note", sent: value }
    : value;
}

export async function handleSignalBotMenuCallback(
  input: SignalBotMenuLoaders & {
    callbackQuery: TelegramBotCallbackQuery;
    config: SignalBotConfig;
    db?: DbQuery;
    redis: SignalBotRedisLike;
    sendStatsReport?: (
      chatId: string,
      period: SignalBotStatsPeriod,
      detail: boolean,
    ) => Promise<boolean>;
    sendTestSignal: (
      chatId: string,
      selector?: SignalBotTestSignalSelector,
    ) => Promise<SignalBotTestSignalHandlerResult>;
    sendTradeStatus?: (
      chatId: string,
      telegramUserId: number,
    ) => Promise<boolean>;
    telegram: SignalBotTelegramClient;
  },
): Promise<boolean> {
  const route = parseSignalBotMenuCallback(input.callbackQuery.data);
  if (!route) return false;
  const message = input.callbackQuery.message;
  const telegramUserId = input.callbackQuery.from?.id;
  const isAdmin = isSignalBotAdmin(input.config, telegramUserId);
  if (!message || !telegramUserId || message.chat.type !== "private") {
    await input.telegram.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Open the bot menu in a private chat.",
    });
    return true;
  }
  const chatId = String(message.chat.id);
  const messageId = message.message_id ?? null;
  const audience = await resolveTelegramBotMenuAudience({
    db: input.db,
    telegramUserId,
  });
  const loadMarketCard = input.loadMarketCard;
  const guestSearchRoute =
    route.kind === "market_search_result" ||
    route.kind === "market_search_back" ||
    (route.kind === "screen" && route.screen === "market_input");
  if (audience !== "linked" && !guestSearchRoute) {
    await input.telegram.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      ...(audience === "unavailable"
        ? {
            showAlert: true,
            text: "Account status is temporarily unavailable.",
          }
        : {}),
    });
    await sendOrEditSignalBotMenuScreen({
      audience,
      chatId,
      config: input.config,
      db: input.db,
      isAdmin,
      messageId,
      screen: "home",
      telegramUserId,
      transport: input.telegram,
    });
    return true;
  }
  if (signalBotMenuRouteRequiresAdmin(route) && !isAdmin) {
    await input.telegram.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "This menu is only available to Hunch admins.",
    });
    await sendOrEditSignalBotMenuScreen({
      chatId,
      config: input.config,
      db: input.db,
      isAdmin,
      messageId,
      notice: "The menu was refreshed.",
      screen: "home",
      telegramUserId,
      transport: input.telegram,
    });
    return true;
  }
  await input.telegram.answerCallbackQuery({
    callbackQueryId: input.callbackQuery.id,
    ...(route.kind === "stats" ||
    route.kind === "trading_status" ||
    route.kind === "admin_preview" ||
    (route.kind === "screen" && route.screen === "positions")
      ? { text: "Working…" }
      : {}),
  });
  if (
    route.kind === "market_search_result" ||
    route.kind === "market_search_back" ||
    route.kind === "market_search_venue" ||
    route.kind === "position" ||
    route.kind === "deposit" ||
    route.kind === "deposit_menu"
  ) {
    return handleSignalBotInteractiveMenuCallback({
      callbackPrefix: SIGNAL_BOT_MENU_CALLBACK_PREFIX,
      chatId,
      loadDeposit: input.loadDeposit,
      loadMarketCard: loadMarketCard
        ? (marketInput) =>
            loadMarketCard({
              ...marketInput,
              publicBrowseOnly: audience !== "linked",
            })
        : undefined,
      loadPositionCard: input.loadPositionCard,
      messageId,
      redis: input.redis,
      render: (interactiveMessage) =>
        sendOrEditSignalBotMenuMessage({
          chatId,
          message: interactiveMessage,
          messageId,
          transport: input.telegram,
        }),
      renderExpiredSearch: () =>
        sendOrEditSignalBotMenuScreen({
          chatId,
          config: input.config,
          isAdmin,
          messageId,
          notice: "Search expired. Start a new search.",
          screen: "market_input",
          transport: input.telegram,
        }),
      route,
      sendPhoto: input.telegram.sendPhoto?.bind(input.telegram),
      telegramUserId,
    });
  }
  if (route.kind === "stale") {
    await clearSignalBotMenuInput({
      chatId,
      redis: input.redis,
      telegramUserId,
    });
    await sendOrEditSignalBotMenuScreen({
      chatId,
      config: input.config,
      db: input.db,
      isAdmin,
      messageId,
      notice: "This menu expired, so it was refreshed.",
      screen: "home",
      telegramUserId,
      transport: input.telegram,
    });
    return true;
  }
  if (route.kind === "cancel_market_input") {
    await clearSignalBotMenuInput({
      chatId,
      redis: input.redis,
      telegramUserId,
    });
    await sendOrEditSignalBotMenuScreen({
      chatId,
      config: input.config,
      db: input.db,
      isAdmin,
      messageId,
      notice: "Market input cancelled.",
      screen: "home",
      telegramUserId,
      transport: input.telegram,
    });
    return true;
  }
  if (route.kind === "notification_set") {
    const preferences = input.db
      ? await setTelegramNotificationTopic({
          db: input.db,
          enabled: route.enabled,
          telegramUserId,
          topic: route.topic,
        }).catch(() => null)
      : null;
    await sendOrEditSignalBotMenuScreen({
      chatId,
      config: input.config,
      isAdmin,
      messageId,
      notice: preferences
        ? "Notification preference updated."
        : "Connect this Telegram account to Hunch first.",
      notificationPreferences: preferences,
      screen: signalBotMenuScreenForNotificationTopic(route.topic),
      transport: input.telegram,
    });
    return true;
  }
  if (route.kind === "screen" && route.screen === "positions") {
    await clearSignalBotMenuInput({
      chatId,
      redis: input.redis,
      telegramUserId,
    });
    await sendOrEditSignalBotMenuScreen({
      chatId,
      config: input.config,
      isAdmin,
      messageId,
      screen: "positions",
      transport: input.telegram,
    });
    let positionsMessage: {
      parse_mode?: "MarkdownV2";
      reply_markup?: TelegramInlineKeyboard;
      text: string;
    };
    try {
      positionsMessage = input.loadPositions
        ? await input.loadPositions(telegramUserId)
        : {
            parse_mode: "MarkdownV2",
            text: "*💼 My positions*\n\nPositions are unavailable right now\\.",
          };
    } catch {
      positionsMessage = {
        parse_mode: "MarkdownV2",
        text: "*💼 My positions*\n\nPositions are unavailable right now\\.",
      };
    }
    const positionsFallbackButton = buildSignalBotMainMiniAppButton({
      appBaseUrl: input.config.appBaseUrl,
      miniAppEnabled: input.config.telegramMiniAppLinkBase != null,
    });
    const keyboard: TelegramInlineKeyboard = {
      inline_keyboard: [
        ...(positionsMessage.reply_markup?.inline_keyboard ??
          buildSignalBotOptionalButtonRows(positionsFallbackButton)),
        [
          {
            callback_data: SIGNAL_BOT_MENU_CALLBACK_PREFIX + "home",
            text: "🏠 Home",
          },
        ],
      ],
    };
    const editResult =
      messageId != null
        ? await input.telegram.editMessageText?.({
            chat_id: chatId,
            disable_web_page_preview: true,
            message_id: messageId,
            parse_mode: positionsMessage.parse_mode ?? "MarkdownV2",
            reply_markup: keyboard,
            text: positionsMessage.text,
          })
        : null;
    if (
      !editResult?.ok &&
      !/message is not modified/i.test(editResult?.message ?? "")
    ) {
      await input.telegram.sendMessage({
        chat_id: chatId,
        disable_web_page_preview: true,
        parse_mode: positionsMessage.parse_mode ?? "MarkdownV2",
        reply_markup: keyboard,
        text: positionsMessage.text,
      });
    }
    return true;
  }
  if (route.kind === "trading_status") {
    await clearSignalBotMenuInput({
      chatId,
      redis: input.redis,
      telegramUserId,
    });
    let statusMessage: {
      parse_mode?: "MarkdownV2";
      reply_markup?: TelegramInlineKeyboard;
      text: string;
    };
    try {
      statusMessage = input.loadTradeStatus
        ? await input.loadTradeStatus(telegramUserId)
        : {
            parse_mode: "MarkdownV2",
            text: "Trading status is unavailable right now\\.",
          };
    } catch {
      statusMessage = {
        parse_mode: "MarkdownV2",
        text: "Trading status is unavailable right now\\.",
      };
    }
    await sendOrEditSignalBotMenuMessage({
      chatId,
      message: {
        ...statusMessage,
        reply_markup: {
          inline_keyboard: [
            ...(statusMessage.reply_markup?.inline_keyboard ?? []),
            [
              {
                callback_data: SIGNAL_BOT_MENU_CALLBACK_PREFIX + "home",
                text: "🏠 Home",
              },
            ],
          ],
        },
      },
      messageId,
      transport: input.telegram,
    });
    return true;
  }
  if (route.kind === "stats") {
    let sent = false;
    try {
      sent = await (input.sendStatsReport?.(
        chatId,
        route.period,
        route.detail,
      ) ?? Promise.resolve(false));
    } catch {
      sent = false;
    }
    await sendOrEditSignalBotMenuScreen({
      chatId,
      config: input.config,
      isAdmin,
      messageId,
      notice: sent
        ? route.period.toUpperCase() + " report was sent below."
        : "Performance is unavailable right now.",
      screen: "performance",
      transport: input.telegram,
    });
    return true;
  }
  if (route.kind === "admin_preview") {
    let outcome: SignalBotTestSignalOutcome = {
      reason: "no_eligible_note",
      sent: false,
    };
    try {
      outcome = normalizeSignalBotTestSignalOutcome(
        await input.sendTestSignal(chatId),
      );
    } catch {
      outcome = { reason: "no_eligible_note", sent: false };
    }
    await sendOrEditSignalBotMenuScreen({
      chatId,
      config: input.config,
      isAdmin,
      messageId,
      notice: outcome.sent
        ? "Latest eligible signal preview was sent below."
        : `Signal preview rejected: ${outcome.reason ?? "unknown"}.`,
      screen: "admin",
      transport: input.telegram,
    });
    return true;
  }
  if (signalBotMenuScreenNeedsNotificationPreferences(route.screen)) {
    const preferences = input.db
      ? await ensureTelegramNotificationPreferences({
          db: input.db,
          telegramUserId,
        }).catch(() => null)
      : null;
    await clearSignalBotMenuInput({
      chatId,
      redis: input.redis,
      telegramUserId,
    });
    await sendOrEditSignalBotMenuScreen({
      chatId,
      config: input.config,
      isAdmin,
      messageId,
      notificationPreferences: preferences,
      screen: route.screen,
      transport: input.telegram,
    });
    return true;
  }
  if (route.screen === "market_input") {
    await writeSignalBotMenuInput({
      chatId,
      menuMessageId: messageId,
      redis: input.redis,
      telegramUserId,
    });
    await sendOrEditSignalBotMenuMessage({
      chatId,
      message: buildSignalBotMarketSearchQueryPrompt({
        callbackPrefix: SIGNAL_BOT_MENU_CALLBACK_PREFIX,
      }),
      messageId,
      transport: input.telegram,
    });
    let results: SignalBotMarketSearchResult[];
    try {
      if (!input.searchMarkets) throw new Error("market_search_unavailable");
      results = await input.searchMarkets({ query: null });
    } catch {
      return true;
    }
    if (results.length === 0) return true;
    const sessionId = await writeSignalBotMarketSearchSession({
      chatId,
      query: null,
      redis: input.redis,
      results,
      telegramUserId,
    });
    await sendOrEditSignalBotMenuMessage({
      chatId,
      message: buildSignalBotMarketSearchScreen({
        callbackPrefix: SIGNAL_BOT_MENU_CALLBACK_PREFIX,
        query: null,
        results,
        sessionId,
      }),
      messageId,
      transport: input.telegram,
    });
    return true;
  } else {
    await clearSignalBotMenuInput({
      chatId,
      redis: input.redis,
      telegramUserId,
    });
  }
  await sendOrEditSignalBotMenuScreen({
    audience,
    chatId,
    config: input.config,
    isAdmin,
    messageId,
    screen: route.screen,
    transport: input.telegram,
  });
  return true;
}

export async function handleSignalBotMenuInput(input: {
  config: SignalBotConfig;
  db?: DbQuery;
  message: TelegramBotMessage;
  redis: SignalBotRedisLike;
  loadMarketCard?: (input: {
    chatId: string;
    marketRef: string;
    publicBrowseOnly?: boolean;
    telegramMessageId: number | null;
    telegramUserId: number;
  }) => Promise<{
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramInlineKeyboard;
    text: string;
  }>;
  searchMarkets?: (input: {
    query?: string | null;
  }) => Promise<SignalBotMarketSearchResult[]>;
  telegram: SignalBotTelegramClient;
}): Promise<boolean> {
  const telegramUserId = input.message.from?.id;
  const chatId = String(input.message.chat.id);
  if (
    !telegramUserId ||
    input.message.chat.type !== "private" ||
    !input.message.text
  ) {
    return false;
  }
  const audience = await resolveTelegramBotMenuAudience({
    db: input.db,
    telegramUserId,
  });
  const loadMarketCard = input.loadMarketCard;
  return handleSignalBotMarketSearchInput({
    beginResponse: async (message) => {
      const sent = await input.telegram.sendMessage({
        chat_id: chatId,
        disable_web_page_preview: true,
        parse_mode: message.parse_mode ?? "MarkdownV2",
        ...(input.message.message_id == null
          ? {}
          : {
              reply_parameters: {
                allow_sending_without_reply: true,
                message_id: input.message.message_id,
              },
            }),
        reply_markup: message.reply_markup,
        text: message.text,
      });
      return sent.ok ? sent.messageId : null;
    },
    callbackPrefix: SIGNAL_BOT_MENU_CALLBACK_PREFIX,
    chatId,
    loadMarketCard: loadMarketCard
      ? (marketInput) =>
          loadMarketCard({
            ...marketInput,
            publicBrowseOnly: audience !== "linked",
          })
      : undefined,
    redis: input.redis,
    render: (message, messageId) =>
      sendOrEditSignalBotMenuMessage({
        chatId,
        message,
        messageId,
        transport: input.telegram,
      }),
    renderCancelled: (messageId) =>
      sendOrEditSignalBotMenuScreen({
        chatId,
        config: input.config,
        db: input.db,
        isAdmin: isSignalBotAdmin(input.config, telegramUserId),
        messageId,
        notice: "Input cancelled because a command was received.",
        screen: "home",
        telegramUserId,
        transport: input.telegram,
      }),
    searchMarkets: input.searchMarkets,
    telegramUserId,
    text: input.message.text,
  });
}

export async function acquireSignalBotLock(input: {
  owner: string;
  redis: SignalBotRedisLike;
}): Promise<boolean> {
  const result = await input.redis.set(LOCK_KEY, input.owner, {
    NX: true,
    PX: LOCK_TTL_MS,
  });
  return result === "OK";
}

export async function releaseSignalBotLock(input: {
  owner: string;
  redis: SignalBotRedisLike;
}): Promise<void> {
  await input.redis.eval(RELEASE_LOCK_SCRIPT, {
    arguments: [input.owner],
    keys: [LOCK_KEY],
  });
}

export async function refreshSignalBotLock(input: {
  owner: string;
  redis: SignalBotRedisLike;
}): Promise<boolean> {
  const result = await input.redis.eval(REFRESH_LOCK_SCRIPT, {
    arguments: [input.owner, String(LOCK_TTL_MS)],
    keys: [LOCK_KEY],
  });
  return Number(result) === 1;
}

export async function readSignalBotUpdateOffset(
  redis: SignalBotRedisLike,
): Promise<number | null> {
  const raw = await redis.get(UPDATE_OFFSET_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export async function writeSignalBotUpdateOffset(
  redis: SignalBotRedisLike,
  offset: number,
): Promise<void> {
  await redis.set(UPDATE_OFFSET_KEY, String(offset));
}

export async function handleSignalBotCommand(input: {
  botUsername?: string | null;
  config: SignalBotConfig;
  db?: DbQuery;
  message: TelegramBotMessage;
  redis: SignalBotRedisLike;
  sendMessage: (
    message: TelegramSendMessageInput,
  ) => Promise<TelegramSendResult>;
  sendStatsReport?: (
    chatId: string,
    period: SignalBotStatsPeriod,
    detail: boolean,
  ) => Promise<boolean>;
  sendTestFollowthrough?: (
    chatId: string,
    kind: SignalBotFollowthroughPreviewKind,
  ) => Promise<boolean>;
  sendTestSignal: (
    chatId: string,
    selector?: SignalBotTestSignalSelector,
  ) => Promise<SignalBotTestSignalHandlerResult>;
  sendTradeMarket?: (input: {
    chatId: string;
    isAdminTest?: boolean;
    marketRef: string;
    publicBrowseOnly?: boolean;
    telegramMessageId?: number | null;
    telegramUserId: number;
  }) => Promise<boolean>;
  sendTradeStatus?: (
    chatId: string,
    telegramUserId: number,
  ) => Promise<boolean>;
  disableTrading?: (
    chatId: string,
    telegramUserId: number,
  ) => Promise<SignalBotDisableTradingResult>;
}): Promise<boolean> {
  const command = parseSignalBotCommand(input.message.text, input.botUsername);
  if (!command) return false;
  const chatId = String(input.message.chat.id);
  const targetChatId = parseSignalBotCommandTargetChatId(input.message.text);
  const isAdmin = isSignalBotAdmin(input.config, input.message.from?.id);
  const isPublicMenuCommand =
    command === "start" ||
    command === "menu" ||
    command === "settings" ||
    command === "help";
  const isPersonalTradingCommand =
    command === "market" ||
    command === "trade_status" ||
    command === "disable_trading";

  await clearSignalBotMenuInput({
    chatId,
    redis: input.redis,
    telegramUserId: input.message.from?.id,
  });

  if (!isAdmin && !isPublicMenuCommand && !isPersonalTradingCommand) {
    await input.sendMessage(buildPlainReply(chatId, "Not authorized."));
    return true;
  }

  if (command === "start" || command === "menu") {
    if (input.message.chat.type !== "private") {
      await input.sendMessage(
        buildSignalBotPrivateMenuEntry({
          botUsername: input.botUsername,
          chatId,
          config: input.config,
        }),
      );
      return true;
    }
    if (command === "start" && input.db && input.message.from?.id) {
      await ensureTelegramNotificationPreferences({
        db: input.db,
        markStarted: true,
        telegramUserId: input.message.from.id,
      }).catch(() => null);
    }
    await sendOrEditSignalBotMenuScreen({
      chatId,
      config: input.config,
      db: input.db,
      isAdmin,
      screen: "home",
      telegramUserId: input.message.from?.id,
      transport: { sendMessage: input.sendMessage },
    });
    return true;
  }
  if (command === "settings") {
    if (input.message.chat.type !== "private") {
      await input.sendMessage(
        buildSignalBotPrivateMenuEntry({
          botUsername: input.botUsername,
          chatId,
          config: input.config,
        }),
      );
      return true;
    }
    const audience = await resolveTelegramBotMenuAudience({
      db: input.db,
      telegramUserId: input.message.from?.id,
    });
    await sendOrEditSignalBotMenuScreen({
      audience,
      chatId,
      config: input.config,
      db: input.db,
      isAdmin,
      screen: audience === "linked" ? "settings" : "home",
      telegramUserId: input.message.from?.id,
      transport: { sendMessage: input.sendMessage },
    });
    return true;
  }
  if (command === "help") {
    if (input.message.chat.type !== "private") {
      if (isAdmin) {
        await input.sendMessage(
          buildPlainReply(
            chatId,
            helpText({
              isAdmin,
              miniAppEnabled: input.config.telegramMiniAppLinkBase != null,
            }),
          ),
        );
        return true;
      }
      await input.sendMessage(
        buildSignalBotPrivateMenuEntry({
          botUsername: input.botUsername,
          chatId,
          config: input.config,
        }),
      );
      return true;
    }
    const audience = await resolveTelegramBotMenuAudience({
      db: input.db,
      telegramUserId: input.message.from?.id,
    });
    await sendOrEditSignalBotMenuScreen({
      audience,
      chatId,
      config: input.config,
      db: input.db,
      isAdmin,
      screen: audience === "linked" ? "help" : "home",
      telegramUserId: input.message.from?.id,
      transport: { sendMessage: input.sendMessage },
    });
    return true;
  }
  if (command === "enable_signals") {
    if (targetChatId) {
      await enableSignalBotChat({
        chat: {
          id: targetChatId,
          title: `Telegram channel ${targetChatId}`,
          type: "channel",
        },
        enabledBy: input.message.from?.id ?? 0,
        redis: input.redis,
      });
      await input.sendMessage(
        buildPlainReply(chatId, `Signals enabled for ${targetChatId}.`),
      );
      return true;
    }
    await enableSignalBotChat({
      chat: input.message.chat,
      enabledBy: input.message.from?.id ?? 0,
      redis: input.redis,
    });
    await input.sendMessage(buildPlainReply(chatId, "Signals enabled here."));
    return true;
  }
  if (command === "signal_venues") {
    const request = parseSignalBotDestinationPolicyRequest(input.message.text);
    if (!request) {
      await input.sendMessage(
        buildPlainReply(
          chatId,
          "Usage: /signal_venues <venue,venue|all> [channel_id]",
        ),
      );
      return true;
    }
    const lifecycle = input.db
      ? (await resolveSignalBotVenueLifecycle(input.db)).policy
      : DEFAULT_VENUE_LIFECYCLE_POLICY;
    const available = getVenuesWithLifecycleCapability(
      lifecycle,
      "signalDelivery",
    ).filter((venue) =>
      getVenuesWithLifecycleCapability(lifecycle, "increaseExposure").includes(
        venue,
      ),
    );
    const targetVenues =
      request.rawVenues === "all"
        ? available
        : request.rawVenues
            .map((venue) => normalizeHunchVenue(venue))
            .filter((venue): venue is HunchVenue => venue != null);
    const uniqueTargetVenues = [...new Set(targetVenues)];
    if (
      uniqueTargetVenues.length === 0 ||
      (request.rawVenues !== "all" &&
        uniqueTargetVenues.length !== request.rawVenues.length) ||
      uniqueTargetVenues.some((venue) => !available.includes(venue))
    ) {
      await input.sendMessage(
        buildPlainReply(
          chatId,
          `Unavailable destination. Allowed: ${available.join(", ") || "none"}.`,
        ),
      );
      return true;
    }
    const destinationChatId = request.targetChatId ?? chatId;
    const updated = await updateSignalBotDestinationPolicy({
      chatId: destinationChatId,
      policy: {
        fallback: "skip",
        selectionMode: "best-executable",
        targetVenues: uniqueTargetVenues,
      },
      redis: input.redis,
    });
    await input.sendMessage(
      buildPlainReply(
        chatId,
        updated
          ? `Signal destinations for ${destinationChatId}: ${uniqueTargetVenues.join(", ")}.`
          : `Signals are not enabled for ${destinationChatId}.`,
      ),
    );
    return true;
  }
  if (command === "disable_signals") {
    const disabledChatId = targetChatId ?? chatId;
    await disableSignalBotChat(input.redis, disabledChatId);
    await input.sendMessage(
      buildPlainReply(
        chatId,
        targetChatId
          ? `Signals disabled for ${targetChatId}.`
          : "Signals disabled here.",
      ),
    );
    return true;
  }
  if (command === "status") {
    const statusChatId = targetChatId ?? chatId;
    const state = await getSignalBotChatState(input.redis, statusChatId);
    const lifecycle = input.db
      ? (await resolveSignalBotVenueLifecycle(input.db)).policy
      : DEFAULT_VENUE_LIFECYCLE_POLICY;
    const destinations =
      state?.destinationPolicy?.targetVenues ??
      getVenuesWithLifecycleCapability(lifecycle, "signalDelivery");
    await input.sendMessage(
      buildPlainReply(
        chatId,
        [
          state
            ? targetChatId
              ? `Signals are enabled for ${targetChatId}.`
              : "Signals are enabled here."
            : targetChatId
              ? `Signals are disabled for ${targetChatId}.`
              : "Signals are disabled here.",
          `Destinations: ${destinations.join(", ") || "none"}.`,
        ].join("\n"),
      ),
    );
    return true;
  }
  if (command === "stats") {
    const statsRequest = parseSignalBotStatsRequest(input.message.text);
    if (!statsRequest) {
      await input.sendMessage(
        buildPlainReply(chatId, "Usage: /stats [24h|7d|30d] [detail]"),
      );
      return true;
    }
    let sent = false;
    try {
      sent = await (input.sendStatsReport?.(
        chatId,
        statsRequest.period,
        statsRequest.detail,
      ) ?? Promise.resolve(false));
    } catch {
      sent = false;
    }
    if (!sent) {
      await input.sendMessage(
        buildPlainReply(chatId, "Stats are unavailable right now."),
      );
    }
    return true;
  }
  if (command === "trade_status") {
    if (input.message.chat.type !== "private" || !input.message.from?.id) {
      await input.sendMessage(
        buildPlainReply(chatId, "Open a private chat with the bot to trade."),
      );
      return true;
    }
    const audience = await resolveTelegramBotMenuAudience({
      db: input.db,
      telegramUserId: input.message.from.id,
    });
    if (audience !== "linked") {
      await sendOrEditSignalBotMenuScreen({
        audience,
        chatId,
        config: input.config,
        db: input.db,
        isAdmin,
        screen: "home",
        telegramUserId: input.message.from.id,
        transport: { sendMessage: input.sendMessage },
      });
      return true;
    }
    const sent = await (input.sendTradeStatus?.(
      chatId,
      input.message.from.id,
    ) ?? Promise.resolve(false));
    if (!sent) {
      await input.sendMessage(
        buildPlainReply(chatId, "Trading status is unavailable right now."),
      );
    }
    return true;
  }
  if (command === "disable_trading") {
    if (input.message.chat.type !== "private" || !input.message.from?.id) {
      await input.sendMessage(
        buildPlainReply(chatId, "Open a private chat with the bot to trade."),
      );
      return true;
    }
    const audience = await resolveTelegramBotMenuAudience({
      db: input.db,
      telegramUserId: input.message.from.id,
    });
    if (audience !== "linked") {
      await sendOrEditSignalBotMenuScreen({
        audience,
        chatId,
        config: input.config,
        db: input.db,
        isAdmin,
        screen: "home",
        telegramUserId: input.message.from.id,
        transport: { sendMessage: input.sendMessage },
      });
      return true;
    }
    const disableResult = await (input.disableTrading?.(
      chatId,
      input.message.from.id,
    ) ?? Promise.resolve("unavailable" as const));
    if (disableResult === "unavailable") {
      await input.sendMessage(
        buildPlainReply(
          chatId,
          "Trading is unavailable right now. Open Hunch to trade.",
        ),
      );
      return true;
    }
    const reply = buildPlainReply(
      chatId,
      [
        disableResult === "disabled"
          ? "Telegram trading disabled."
          : "Telegram trading was already disabled.",
        "Open Hunch Settings to revoke bot access from your Trading Wallet.",
      ].join("\n"),
    );
    const revokeButton = buildHunchMiniAppWebButton({
      appBaseUrl: input.config.appBaseUrl,
      enabled: input.config.telegramMiniAppLinkBase != null,
      path: "/settings/telegram-trading",
      text: "Revoke access in Hunch",
    });
    await input.sendMessage({
      ...reply,
      ...(revokeButton
        ? { reply_markup: { inline_keyboard: [[revokeButton]] } }
        : {}),
    });
    return true;
  }
  if (command === "market") {
    const marketRef = parseSignalBotCommandFirstArg(input.message.text);
    if (!marketRef) {
      await input.sendMessage(
        buildPlainReply(chatId, "Usage: /market <market_id or URL>"),
      );
      return true;
    }
    if (input.message.chat.type !== "private" || !input.message.from?.id) {
      await input.sendMessage(
        buildPlainReply(chatId, "Open a private chat with the bot to trade."),
      );
      return true;
    }
    const audience = await resolveTelegramBotMenuAudience({
      db: input.db,
      telegramUserId: input.message.from.id,
    });
    const sent = await (input.sendTradeMarket?.({
      chatId,
      marketRef,
      publicBrowseOnly: audience !== "linked",
      telegramMessageId: input.message.message_id ?? null,
      telegramUserId: input.message.from.id,
    }) ?? Promise.resolve(false));
    if (!sent) {
      await input.sendMessage(
        buildPlainReply(chatId, "Unable to render market card."),
      );
    }
    return true;
  }
  if (command === "test_followthrough") {
    const request = parseSignalBotFollowthroughPreviewRequest(
      input.message.text,
    );
    if (!request) {
      await input.sendMessage(
        buildPlainReply(
          chatId,
          "Usage: /test_followthrough [stats|win|loss] [channel_id]",
        ),
      );
      return true;
    }
    let sent = false;
    try {
      sent = await (input.sendTestFollowthrough?.(
        request.targetChatId ?? chatId,
        request.kind,
      ) ?? Promise.resolve(false));
    } catch {
      sent = false;
    }
    await input.sendMessage(
      buildPlainReply(
        chatId,
        sent
          ? "Sent follow-through preview."
          : `No follow-through preview found for ${request.kind} in ${
              request.targetChatId ?? chatId
            }. Check age/policy/type/thresholds, or pass the channel id.`,
      ),
    );
    return true;
  }
  if (command === "test_signal") {
    const request = parseSignalBotTestSignalRequest(input.message.text);
    const outcome = normalizeSignalBotTestSignalOutcome(
      await input.sendTestSignal(
        request.targetChatId ?? chatId,
        request.selector,
      ),
    );
    await input.sendMessage(
      buildPlainReply(
        chatId,
        outcome.sent
          ? "Sent latest eligible signal."
          : `Signal preview rejected: ${outcome.reason ?? "unknown"}.`,
      ),
    );
    return true;
  }
  if (command === "test_trade") {
    const marketRef = parseSignalBotCommandFirstArg(input.message.text);
    if (!marketRef) {
      await input.sendMessage(
        buildPlainReply(chatId, "Usage: /test_trade <market_id or URL>"),
      );
      return true;
    }
    if (!input.message.from?.id) {
      await input.sendMessage(
        buildPlainReply(chatId, "Missing Telegram user id."),
      );
      return true;
    }
    const sent = await (input.sendTradeMarket?.({
      chatId,
      isAdminTest: true,
      marketRef,
      telegramMessageId: input.message.message_id ?? null,
      telegramUserId: input.message.from.id,
    }) ?? Promise.resolve(false));
    await input.sendMessage(
      buildPlainReply(
        chatId,
        sent
          ? "Sent trade card preview."
          : "Unable to render trade card preview.",
      ),
    );
    return true;
  }
  return true;
}

const MAX_BACKGROUND_CONFIRM_CALLBACKS = 4;
const backgroundConfirmCallbacks = new Set<Promise<void>>();

export async function drainSignalBotConfirmTasks(
  timeoutMs = 10_000,
): Promise<boolean> {
  const pending = Array.from(backgroundConfirmCallbacks);
  if (pending.length === 0) return true;
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function pollSignalBotCommands(
  input: SignalBotMenuLoaders & {
    botUsername?: string | null;
    config: SignalBotConfig;
    db?: DbQuery;
    redis: SignalBotRedisLike;
    sendStatsReport?: (
      chatId: string,
      period: SignalBotStatsPeriod,
      detail: boolean,
    ) => Promise<boolean>;
    sendTestFollowthrough?: (
      chatId: string,
      kind: SignalBotFollowthroughPreviewKind,
    ) => Promise<boolean>;
    sendTestSignal: (
      chatId: string,
      selector?: SignalBotTestSignalSelector,
    ) => Promise<SignalBotTestSignalHandlerResult>;
    sendTradeMarket?: (input: {
      chatId: string;
      isAdminTest?: boolean;
      marketRef: string;
      publicBrowseOnly?: boolean;
      telegramMessageId?: number | null;
      telegramUserId: number;
    }) => Promise<boolean>;
    sendTradeStatus?: (
      chatId: string,
      telegramUserId: number,
    ) => Promise<boolean>;
    disableTrading?: (
      chatId: string,
      telegramUserId: number,
    ) => Promise<SignalBotDisableTradingResult>;
    handleCallback?: (
      callbackQuery: TelegramBotCallbackQuery,
    ) => Promise<boolean>;
    telegram: SignalBotTelegramClient;
  },
): Promise<number> {
  const offset = await readSignalBotUpdateOffset(input.redis);
  const updates = await input.telegram.getUpdates({
    offset,
    timeoutSec: input.config.pollTimeoutSec,
  });
  let handled = 0;
  for (const update of updates) {
    try {
      if (update.message) {
        let didHandle = false;
        try {
          didHandle = await handleSignalBotCommand({
            botUsername: input.botUsername,
            config: input.config,
            db: input.db,
            message: update.message,
            redis: input.redis,
            sendMessage: (message) => input.telegram.sendMessage(message),
            sendStatsReport: input.sendStatsReport,
            sendTestFollowthrough: input.sendTestFollowthrough,
            sendTestSignal: input.sendTestSignal,
            sendTradeMarket: input.sendTradeMarket,
            sendTradeStatus: input.sendTradeStatus,
            disableTrading: input.disableTrading,
          });
          if (!didHandle) {
            didHandle = await handleSignalBotMenuInput({
              config: input.config,
              db: input.db,
              message: update.message,
              redis: input.redis,
              loadMarketCard: input.loadMarketCard,
              searchMarkets: input.searchMarkets,
              telegram: input.telegram,
            });
          }
          if (
            !didHandle &&
            update.message.chat.type === "private" &&
            update.message.text
          ) {
            await sendOrEditSignalBotMenuScreen({
              chatId: String(update.message.chat.id),
              config: input.config,
              db: input.db,
              isAdmin: isSignalBotAdmin(input.config, update.message.from?.id),
              notice: "Use the menu buttons to choose an action.",
              screen: "home",
              telegramUserId: update.message.from?.id,
              transport: input.telegram,
            });
            didHandle = true;
          }
        } catch {
          didHandle = true;
          const failure = buildPlainReply(
            String(update.message.chat.id),
            "Command failed. Try again.",
          );
          const replyMarkup =
            update.message.chat.type === "private"
              ? withTelegramPrivateNavigation({
                  parse_mode: failure.parse_mode,
                  text: failure.text,
                }).reply_markup
              : undefined;
          await input.telegram
            .sendMessage({ ...failure, reply_markup: replyMarkup })
            .catch(() => undefined);
        }
        if (didHandle) handled += 1;
      }
      if (update.callback_query) {
        const callbackQuery = update.callback_query;
        const handledMenuCallback = await handleSignalBotMenuCallback({
          callbackQuery,
          config: input.config,
          db: input.db,
          redis: input.redis,
          loadMarketCard: input.loadMarketCard,
          loadDeposit: input.loadDeposit,
          loadPositionCard: input.loadPositionCard,
          loadPositions: input.loadPositions,
          searchMarkets: input.searchMarkets,
          loadTradeStatus: input.loadTradeStatus,
          sendStatsReport: input.sendStatsReport,
          sendTestSignal: input.sendTestSignal,
          sendTradeStatus: input.sendTradeStatus,
          telegram: input.telegram,
        }).catch(async () => {
          await input.telegram
            .answerCallbackQuery({
              callbackQueryId: callbackQuery.id,
              showAlert: true,
              text: "Menu action failed. The main menu is still available.",
            })
            .catch(() => undefined);
          return true;
        });
        if (handledMenuCallback) {
          handled += 1;
          continue;
        }
        const parsedCallback = parseTelegramBotTradingCallbackData(
          callbackQuery.data,
        );
        if (parsedCallback?.type === "confirm" && input.handleCallback) {
          if (
            backgroundConfirmCallbacks.size >= MAX_BACKGROUND_CONFIRM_CALLBACKS
          ) {
            await input.telegram
              .answerCallbackQuery({
                callbackQueryId: callbackQuery.id,
                showAlert: true,
                text: "Bot is busy. Retry confirmation shortly.",
              })
              .catch(() => undefined);
            handled += 1;
            continue;
          }
          const task = (async () => {
            try {
              await input.handleCallback?.(callbackQuery);
            } catch {
              await input.telegram
                .answerCallbackQuery({
                  callbackQueryId: callbackQuery.id,
                  showAlert: true,
                  text: "Action failed. Check /trade_status before retrying.",
                })
                .catch(() => undefined);
            }
          })();
          backgroundConfirmCallbacks.add(task);
          void task.finally(() => backgroundConfirmCallbacks.delete(task));
          handled += 1;
          continue;
        }
        let didHandle = false;
        try {
          didHandle = (await input.handleCallback?.(callbackQuery)) ?? false;
        } catch {
          didHandle = true;
          await input.telegram
            .answerCallbackQuery({
              callbackQueryId: callbackQuery.id,
              showAlert: true,
              text: "Action failed. Try again.",
            })
            .catch(() => undefined);
        }
        if (didHandle) handled += 1;
      }
    } finally {
      await writeSignalBotUpdateOffset(input.redis, update.update_id + 1);
    }
  }
  return handled;
}

const SIGNAL_BOT_STATS_AUDIT_LIMIT = 500;
const MIN_CHEAPER_ALTERNATIVE_DELTA = 0.005;

type SignalBotAggMarketConfig = {
  apiKey: string | null;
  appId: string;
  baseUrl: string;
  credentialSource: "AGG_APP_ID";
  matchedTtlSec: number;
  notFoundTtlSec: number;
  timeoutMs: number;
};

export type SignalBotCheaperAlternativeDiagnostics = {
  aggCheaperFound: number;
  aggDisabled: number;
  aggErrors: number;
  aggMatched: number;
  aggMatchedNotCheaper: number;
  aggNoResponse: number;
  aggNotFound: number;
  aggExternalMatchUnindexed: number;
  aggCanonicalMarketInactive: number;
  aggOutcomeMappingMissing: number;
  aggPriceUnavailable: number;
  aggTargetSearchEmpty: number;
  deliveryAmbiguousMapping: number;
  deliveryDestinationDisabled: number;
  deliveryNoExecutableTarget: number;
  deliveryStalePrice: number;
};

export type SignalBotPriceGuardDiagnostics = {
  priceGuardBuyPriceTooHigh: number;
  priceGuardDeferred: number;
  priceGuardInvalidSpread: number;
  priceGuardLivePriceStale: number;
  priceGuardMissingSidePrice: number;
  priceGuardNoBook: number;
  priceGuardSkipped: number;
  priceGuardStaleExpired: number;
  priceGuardTerminalPrice: number;
};

type SignalBotPriceGuardResult = {
  blockers: MarketPriceBlocker[];
  buyPrice: number | null;
  defer: boolean;
  orderable: boolean;
  timedOut: boolean;
};

type SignalBotCheaperAlternativeResult = {
  alternative: SignalBotCheaperAlternative | null;
  diagnostics: SignalBotCheaperAlternativeDiagnostics;
};

function normalizeServiceBaseUrl(value: string | undefined, fallback: string) {
  const raw = value?.trim() || fallback;
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

export function parseSignalBotAggMarketConfig(
  env: NodeJS.ProcessEnv = process.env,
): SignalBotAggMarketConfig | null {
  const credential = resolveAggMarketCredential(env);
  if (!credential) return null;
  return {
    apiKey: credential.apiKey,
    appId: credential.appId,
    baseUrl: normalizeServiceBaseUrl(
      env.AGG_MARKET_BASE_URL,
      "https://api.agg.market",
    ),
    credentialSource: credential.source,
    matchedTtlSec: parseNonNegativeInt(env.AGG_CLUSTERS_CACHE_TTL_SEC, 30),
    notFoundTtlSec: parseNonNegativeInt(
      env.AGG_MARKET_ALTERNATIVES_NOT_FOUND_CACHE_TTL_SEC,
      60,
    ),
    timeoutMs: parsePositiveInt(env.AGG_MARKET_TIMEOUT_MS, 5_000),
  };
}

function createSignalBotCheaperAlternativeDiagnostics(): SignalBotCheaperAlternativeDiagnostics {
  return {
    aggCheaperFound: 0,
    aggDisabled: 0,
    aggErrors: 0,
    aggMatched: 0,
    aggMatchedNotCheaper: 0,
    aggNoResponse: 0,
    aggNotFound: 0,
    aggExternalMatchUnindexed: 0,
    aggCanonicalMarketInactive: 0,
    aggOutcomeMappingMissing: 0,
    aggPriceUnavailable: 0,
    aggTargetSearchEmpty: 0,
    deliveryAmbiguousMapping: 0,
    deliveryDestinationDisabled: 0,
    deliveryNoExecutableTarget: 0,
    deliveryStalePrice: 0,
  };
}

function addAggAlternativesDiagnostics(
  target: SignalBotCheaperAlternativeDiagnostics,
  source: AggMarketAlternativesDiagnostics,
): void {
  target.aggExternalMatchUnindexed += source.externalMatchUnindexed;
  target.aggCanonicalMarketInactive += source.canonicalMarketInactive;
  target.aggOutcomeMappingMissing += source.outcomeMappingMissing;
  target.aggPriceUnavailable += source.priceUnavailable;
  target.aggTargetSearchEmpty += source.targetSearchEmpty;
}

function createSignalBotPriceGuardDiagnostics(): SignalBotPriceGuardDiagnostics {
  return {
    priceGuardBuyPriceTooHigh: 0,
    priceGuardDeferred: 0,
    priceGuardInvalidSpread: 0,
    priceGuardLivePriceStale: 0,
    priceGuardMissingSidePrice: 0,
    priceGuardNoBook: 0,
    priceGuardSkipped: 0,
    priceGuardStaleExpired: 0,
    priceGuardTerminalPrice: 0,
  };
}

function addSignalBotPriceGuardBlockers(
  target: SignalBotPriceGuardDiagnostics,
  blockers: MarketPriceBlocker[],
): void {
  for (const blocker of blockers) {
    switch (blocker) {
      case "buy_price_too_high":
        target.priceGuardBuyPriceTooHigh += 1;
        break;
      case "invalid_spread":
        target.priceGuardInvalidSpread += 1;
        break;
      case "live_price_stale":
        target.priceGuardLivePriceStale += 1;
        break;
      case "missing_side_price":
        target.priceGuardMissingSidePrice += 1;
        break;
      case "no_book":
        target.priceGuardNoBook += 1;
        break;
      case "terminal_price":
        target.priceGuardTerminalPrice += 1;
        break;
    }
  }
}

async function loadSignalBotPriceGuardBlockers(input: {
  buySide: "NO" | "YES";
  db: DbQuery;
  note: Pick<SignalBotNote, "marketId">;
  redis: SignalBotRedisLike;
}): Promise<SignalBotPriceGuardResult> {
  if (!input.note.marketId) {
    return {
      blockers: [],
      buyPrice: null,
      defer: false,
      orderable: false,
      timedOut: false,
    };
  }
  try {
    const market = await findTradeMarketById(input.db, input.note.marketId);
    if (!market || !isOrderable(market)) {
      return {
        blockers: [],
        buyPrice: null,
        defer: false,
        orderable: false,
        timedOut: false,
      };
    }
    const priceRedis =
      typeof input.redis.zCard === "function" &&
      typeof input.redis.zRemRangeByRank === "function"
        ? (input.redis as unknown as PriceRefreshRedis)
        : null;
    const result = await requestFreshMarketPrices({
      db: input.db,
      enqueue: Boolean(priceRedis),
      marketIds: [input.note.marketId],
      maxBuyPrice: 0.95,
      maxFreshAgeMs: PRICE_GUARD_MAX_FRESH_AGE_MS,
      maxTokens: 2,
      pollMs: 100,
      priority: "high",
      redis: priceRedis,
      timeoutMs: priceRedis ? 5_000 : 0,
    });
    const marketState = result.marketStates.get(input.note.marketId);
    if (!marketState) {
      return {
        blockers: [],
        buyPrice: null,
        defer: true,
        orderable: true,
        timedOut: result.timedOut,
      };
    }
    if (!marketState.fresh || result.timedOut) {
      return {
        blockers: ["live_price_stale"],
        buyPrice: null,
        defer: true,
        orderable: true,
        timedOut: result.timedOut,
      };
    }
    const sideState = getMarketPriceSideState(
      marketState.priceState,
      input.buySide,
    );
    const strictQuotes = (
      await loadClusterMarketNativeQuotes(input.db, [input.note.marketId])
    ).get(input.note.marketId);
    const strictTop =
      input.buySide === "YES" ? strictQuotes?.yes : strictQuotes?.no;
    const strictOffer = strictTop
      ? resolveStrictClusterNativeOffer({
          maxAgeMs: PRICE_GUARD_MAX_FRESH_AGE_MS,
          nativeOutcome: input.buySide,
          nowMs: Date.now(),
          top: strictTop,
        })
      : null;
    const blockers: MarketPriceBlocker[] = sideState.blockers.filter(
      (blocker) => blocker !== "missing_side_price",
    );
    if (!strictOffer) blockers.push("missing_side_price");
    else if (!strictOffer.fresh) blockers.push("live_price_stale");
    return {
      blockers: Array.from(new Set(blockers)),
      buyPrice: strictOffer?.fresh ? strictOffer.ask : null,
      defer: false,
      orderable: true,
      timedOut: false,
    };
  } catch (error) {
    console.warn("[signal-bot] price guard skipped", {
      error: error instanceof Error ? error.message : String(error),
      marketId: input.note.marketId,
    });
    return {
      blockers: [],
      buyPrice: null,
      defer: false,
      orderable: false,
      timedOut: false,
    };
  }
}

export type SignalBotDeliveryPreparationReason =
  | "identity_mismatch"
  | "missing_market_identity"
  | "missing_price_snapshot"
  | "missing_update_contract"
  | "non_directional"
  | "quote_refresh"
  | "stale_price_snapshot"
  | "unpublishable_copy";

export type SignalBotDeliveryPreparation =
  | {
      audit: Record<string, unknown>;
      blockers: MarketPriceBlocker[];
      buySide: "NO" | "YES";
      deliveryTarget: SignalBotCheaperAlternative | null;
      keyboard: TelegramInlineKeyboard | undefined;
      status: "ready";
      text: string;
    }
  | {
      audit: Record<string, unknown>;
      blockers: MarketPriceBlocker[];
      reason: SignalBotDeliveryPreparationReason;
      status: "deferred";
    }
  | {
      audit: Record<string, unknown>;
      blockers: MarketPriceBlocker[];
      reason: SignalBotDeliveryPreparationReason;
      status: "skipped";
    };

async function loadSignalBotSourceReadinessWithoutRedis(input: {
  buySide: "NO" | "YES";
  db: DbQuery;
  note: SignalBotNote;
}): Promise<SignalBotPriceGuardResult> {
  if (!input.note.marketId) {
    return {
      blockers: [],
      buyPrice: null,
      defer: false,
      orderable: false,
      timedOut: false,
    };
  }
  const market = await findTradeMarketById(input.db, input.note.marketId);
  return {
    blockers: [],
    buyPrice: input.note.signalPriceSnapshotV1?.[input.buySide].ask ?? null,
    defer: false,
    orderable: Boolean(market && isOrderable(market)),
    timedOut: false,
  };
}

export async function prepareSignalBotDelivery(input: {
  appBaseUrl: string;
  buyAmountUsd: number;
  chatType?: string | null;
  copyPolicy?: ResolvedSignalPostCopyPolicy;
  db: DbQuery;
  deliveryRef?: string | null;
  forceOpenMarket?: boolean;
  messageKind: "initial" | "research_update";
  note: SignalBotNote;
  now?: Date;
  redis?: SignalBotRedisLike;
  telegramMiniAppLinkBase?: string | null;
}): Promise<SignalBotDeliveryPreparation> {
  const now = input.now ?? new Date();
  const buySide = resolveSignalBotBuySide(input.note);
  const identity = input.note.telegramMarketIdentityV1;
  const priceSnapshot = input.note.signalPriceSnapshotV1;
  const baseAudit = {
    contractVersion: 1,
    messageKind: input.messageKind,
    noteId: input.note.id,
  };
  if (!buySide) {
    return {
      audit: baseAudit,
      blockers: [],
      reason: "non_directional",
      status: "skipped",
    };
  }
  if (!identity) {
    return {
      audit: baseAudit,
      blockers: [],
      reason: "missing_market_identity",
      status: "skipped",
    };
  }
  if (
    identity.selectedSide !== buySide ||
    identity.marketId !== input.note.marketId ||
    identity.venue !== input.note.marketVenue
  ) {
    return {
      audit: { ...baseAudit, identitySource: identity.source },
      blockers: [],
      reason: "identity_mismatch",
      status: "skipped",
    };
  }
  if (
    input.messageKind === "research_update" &&
    !input.note.holderResearchUpdateV1
  ) {
    return {
      audit: { ...baseAudit, identitySource: identity.source },
      blockers: [],
      reason: "missing_update_contract",
      status: "skipped",
    };
  }
  if (!priceSnapshot) {
    return {
      audit: { ...baseAudit, identitySource: identity.source },
      blockers: [],
      reason: "missing_price_snapshot",
      status: "skipped",
    };
  }
  const priceAsOfMs = Date.parse(priceSnapshot.asOf);
  if (
    priceSnapshot.displaySide !== buySide ||
    priceSnapshot.marketId !== input.note.marketId ||
    priceSnapshot.venue !== input.note.marketVenue
  ) {
    return {
      audit: {
        ...baseAudit,
        identitySource: identity.source,
        priceSnapshotAsOf: priceSnapshot.asOf,
      },
      blockers: [],
      reason: "identity_mismatch",
      status: "skipped",
    };
  }
  if (
    !Number.isFinite(priceAsOfMs) ||
    priceAsOfMs > now.getTime() ||
    now.getTime() - priceAsOfMs > SIGNAL_BOT_QUOTE_MAX_AGE_MS
  ) {
    return {
      audit: {
        ...baseAudit,
        identitySource: identity.source,
        priceSnapshotAsOf: priceSnapshot.asOf,
      },
      blockers: ["live_price_stale"],
      reason: "stale_price_snapshot",
      status: "skipped",
    };
  }

  const update = input.note.holderResearchUpdateV1;
  const requestedBuy =
    !input.forceOpenMarket &&
    (input.messageKind === "initial" || update?.ctaIntent === "buy");
  let allowBuyCta = false;
  let priceGuard: SignalBotPriceGuardResult = {
    blockers: [],
    buyPrice: null,
    defer: false,
    orderable: false,
    timedOut: false,
  };
  if (requestedBuy) {
    priceGuard = input.redis
      ? await loadSignalBotPriceGuardBlockers({
          buySide,
          db: input.db,
          note: input.note,
          redis: input.redis,
        })
      : await loadSignalBotSourceReadinessWithoutRedis({
          buySide,
          db: input.db,
          note: input.note,
        });
    if (priceGuard.defer) {
      return {
        audit: {
          ...baseAudit,
          identitySource: identity.source,
          priceSnapshotAsOf: priceSnapshot.asOf,
          updateFingerprint: update?.fingerprint ?? null,
        },
        blockers: priceGuard.blockers,
        reason: "quote_refresh",
        status: "deferred",
      };
    }
    allowBuyCta =
      priceGuard.orderable &&
      priceGuard.blockers.length === 0 &&
      priceSnapshot[buySide].ask != null;
  }
  const deliveryTarget =
    allowBuyCta && input.note.eventId && input.note.marketId
      ? {
          eventId: input.note.eventId,
          marketId: input.note.marketId,
          price: priceSnapshot[buySide].ask as number,
          side: buySide,
          venue: input.note.marketVenue ?? "unknown",
        }
      : null;
  const rendered = buildSignalBotMessage({
    allowBuyCta,
    appBaseUrl: input.appBaseUrl,
    buyAmountUsd: input.buyAmountUsd,
    chatType: input.chatType,
    deliveryRef: input.deliveryRef,
    deliveryTarget,
    messageKind: input.messageKind,
    note: input.note,
    copyPolicy: input.copyPolicy,
    telegramMiniAppLinkBase: input.telegramMiniAppLinkBase,
  });
  if (!rendered.publishable) {
    return {
      audit: {
        ...baseAudit,
        identitySource: identity.source,
        priceSnapshotAsOf: priceSnapshot.asOf,
        updateFingerprint: update?.fingerprint ?? null,
      },
      blockers: priceGuard.blockers,
      reason: "unpublishable_copy",
      status: "skipped",
    };
  }
  return {
    audit: {
      ...baseAudit,
      ctaIntent: allowBuyCta ? "buy" : "open_market",
      identitySource: identity.source,
      priceSnapshotAsOf: priceSnapshot.asOf,
      updateFingerprint: update?.fingerprint ?? null,
    },
    blockers: priceGuard.blockers,
    buySide,
    deliveryTarget,
    keyboard: rendered.keyboard,
    status: "ready",
    text: rendered.text,
  };
}

async function recordSignalBotPriceGuardDeferral(input: {
  chatId: string;
  noteId: string;
  redis: SignalBotRedisLike;
  ttlSec: number;
}): Promise<number> {
  const key = signalBotPriceGuardDeferKey(input.chatId, input.noteId);
  const current = Number(input.redis ? await input.redis.get(key) : null);
  const next = Number.isFinite(current) && current > 0 ? current + 1 : 1;
  await input.redis.set(key, String(next), {
    EX: Math.max(1, Math.trunc(input.ttlSec)),
  });
  return next;
}

function isStrictlyCheaperDisplayedPrice(params: {
  alternativePrice: number;
  primaryPrice: number;
}): boolean {
  const primaryCents = Math.round(params.primaryPrice * 100);
  const alternativeCents = Math.round(params.alternativePrice * 100);
  return (
    alternativeCents < primaryCents &&
    params.primaryPrice - params.alternativePrice >=
      MIN_CHEAPER_ALTERNATIVE_DELTA
  );
}

function pickCheaperSignalBotAlternative(input: {
  buySide: "NO" | "YES";
  note: SignalBotNote;
  primaryPrice?: number | null;
  response: {
    alternatives: ClusterMarketSummary[];
    status: string;
  };
}): SignalBotCheaperAlternative | null {
  if (input.response.status !== "matched") return null;
  const primaryPrice =
    normalizeProbability(input.primaryPrice) ??
    (input.buySide === "YES" ? normalizeProbability(input.note.bestAsk) : null);
  if (primaryPrice == null) return null;

  const candidates = input.response.alternatives
    .map((market): SignalBotCheaperAlternative | null => {
      if (!market.outcomeMapping) return null;
      const nativeSide = resolveNativeOutcomeForCanonicalSide(
        market.outcomeMapping.sourceYesTo,
        input.buySide,
      );
      const offer =
        input.buySide === "YES"
          ? market.executionOffers?.yes
          : market.executionOffers?.no;
      const price =
        offer?.fresh && offer.nativeOutcome === nativeSide
          ? normalizeProbability(offer.ask)
          : null;
      if (
        price == null ||
        !market.eventId ||
        !market.marketId ||
        market.marketId === input.note.marketId ||
        !isStrictlyCheaperDisplayedPrice({
          alternativePrice: price,
          primaryPrice,
        })
      ) {
        return null;
      }
      return {
        eventId: market.eventId,
        marketId: market.marketId,
        price,
        side: nativeSide,
        venue: market.venue,
      };
    })
    .filter(
      (candidate): candidate is SignalBotCheaperAlternative =>
        candidate != null,
    );

  return (
    candidates.sort((left, right) => {
      if (left.price !== right.price) return left.price - right.price;
      return left.marketId.localeCompare(right.marketId);
    })[0] ?? null
  );
}

export function resolveSignalBotCheaperAlternativeFromAggResponse(input: {
  buySide: "NO" | "YES";
  note: SignalBotNote;
  response: {
    alternatives: ClusterMarketSummary[];
    diagnostics?: AggMarketAlternativesDiagnostics;
    status: string;
  } | null;
}): SignalBotCheaperAlternativeResult {
  const diagnostics = createSignalBotCheaperAlternativeDiagnostics();
  if (!input.response) {
    diagnostics.aggNoResponse += 1;
    return { alternative: null, diagnostics };
  }
  if (input.response.diagnostics) {
    addAggAlternativesDiagnostics(diagnostics, input.response.diagnostics);
  }
  if (input.response.status === "not_found") {
    diagnostics.aggNotFound += 1;
    return { alternative: null, diagnostics };
  }
  if (input.response.status !== "matched") {
    diagnostics.aggNoResponse += 1;
    return { alternative: null, diagnostics };
  }

  diagnostics.aggMatched += 1;
  const alternative = pickCheaperSignalBotAlternative({
    buySide: input.buySide,
    note: input.note,
    response: input.response,
  });
  if (alternative) {
    diagnostics.aggCheaperFound += 1;
  } else {
    diagnostics.aggMatchedNotCheaper += 1;
  }
  return { alternative, diagnostics };
}

function isMissingSignalBotMessagesTable(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function parseFollowthroughSnapshotHours(payload: unknown): number | null {
  const raw = asObject(payload).snapshotHours;
  const hours = toNumber(raw);
  if (hours == null || hours <= 0) return null;
  return Math.trunc(hours);
}

function resolveSignalBotDefaultSnapshotHours(): number {
  const raw = process.env.WALLET_INTEL_SNAPSHOT_HOURS;
  const parsed = raw != null && raw.trim() ? Number(raw) : null;
  if (parsed == null || !Number.isFinite(parsed) || parsed <= 0) return 6;
  return Math.trunc(parsed);
}

function resolveFollowthroughSnapshotMaxAgeMs(snapshotHours: number): number {
  return Math.max(
    snapshotHours * 2 * 60 * 60 * 1_000,
    FOLLOWTHROUGH_MIN_LATEST_SNAPSHOT_FRESH_MS,
  );
}

export async function resolveSignalBotLatestSnapshotMaxAgeMs(
  db: DbQuery,
): Promise<number> {
  try {
    const { rows } = await db.query<{ payload: unknown }>(
      `
        select payload
        from runtime_policies
        where policy_key = 'wallet_intel_refresh'
          and effective_at <= now()
        order by effective_at desc, created_at desc
        limit 1
      `,
    );
    const snapshotHours =
      parseFollowthroughSnapshotHours(rows[0]?.payload) ??
      resolveSignalBotDefaultSnapshotHours();
    return resolveFollowthroughSnapshotMaxAgeMs(snapshotHours);
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) {
      return resolveFollowthroughSnapshotMaxAgeMs(
        resolveSignalBotDefaultSnapshotHours(),
      );
    }
    throw error;
  }
}

async function loadSignalBotThreadContext(input: {
  chatId: string;
  db: DbQuery;
  note: SignalBotNote;
}): Promise<SignalBotThreadContext> {
  const initial: SignalBotThreadContext = {
    baselineAt: new Date().toISOString(),
    messageKind: "initial",
    replyToMessageId: null,
    threadRootNoteId: input.note.id,
  };
  if (!input.note.marketId) return initial;
  try {
    const { rows } = await input.db.query<{
      baseline_at: Date | string | null;
      reply_to_message_id: string | number | null;
      thread_root_note_id: string | null;
    }>(
      `
        select
          coalesce(root.baseline_at, prior.baseline_at)::text as baseline_at,
          coalesce(root.telegram_message_id, prior.telegram_message_id)::text
            as reply_to_message_id,
          prior.thread_root_note_id::text as thread_root_note_id
        from signal_bot_messages prior
        join ai_notes prior_note on prior_note.id = prior.note_id
        join ai_notes current_note on current_note.id = $2::uuid
        left join lateral (
          select target.target_meta
          from ai_note_targets target
          where target.note_id = prior_note.id
            and target.target_kind = 'market'
          order by
            target.is_primary desc,
            target.target_rank asc,
            target.target_id asc
          limit 1
        ) prior_target on true
        left join lateral (
          select target.target_meta
          from ai_note_targets target
          where target.note_id = current_note.id
            and target.target_kind = 'market'
          order by
            target.is_primary desc,
            target.target_rank asc,
            target.target_id asc
          limit 1
        ) current_target on true
        left join signal_bot_messages root
          on root.chat_id = prior.chat_id
         and root.note_id = prior.thread_root_note_id
         and root.message_kind = 'initial'
        where prior.chat_id = $1
          and prior.note_id <> $2::uuid
          and prior.message_kind in ('initial', 'research_update')
          and coalesce(
            prior_note.lineage->>'thesis_key',
            'holder_research:v2:' || prior_note.source_id || ':' || upper(coalesce(
              nullif(prior_note.lineage->>'side', ''),
              nullif(prior_target.target_meta->>'side', ''),
              'MIXED'
            ))
          ) = coalesce(
            current_note.lineage->>'thesis_key',
            'holder_research:v2:' || current_note.source_id || ':' || upper(coalesce(
              nullif(current_note.lineage->>'side', ''),
              nullif(current_target.target_meta->>'side', ''),
              'MIXED'
            ))
          )
        order by prior.baseline_at asc, prior.sent_at asc
        limit 1
      `,
      [input.chatId, input.note.id],
    );
    const row = rows[0];
    if (!row?.thread_root_note_id) return initial;
    return {
      baselineAt:
        row.baseline_at instanceof Date
          ? row.baseline_at.toISOString()
          : row.baseline_at || initial.baselineAt,
      messageKind: "research_update",
      replyToMessageId: toInteger(row.reply_to_message_id),
      threadRootNoteId: row.thread_root_note_id,
    };
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return initial;
    throw error;
  }
}

async function recordSignalBotMessage(input: {
  baselineAt: string;
  chatId: string;
  db: DbQuery;
  insertId: string;
  messageId: number | null;
  messageKind: SignalBotMessageKind;
  metrics?: unknown;
  noteId: string;
  replyToMessageId: number | null;
  sentAt?: Date;
  threadRootNoteId: string;
}): Promise<boolean> {
  try {
    await input.db.query(
      `
        insert into signal_bot_messages (
          id,
          chat_id,
          note_id,
          thread_root_note_id,
          message_kind,
          telegram_message_id,
          reply_to_message_id,
          baseline_at,
          sent_at,
          metrics
        )
        values ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::jsonb)
        on conflict (chat_id, note_id, message_kind)
        do update set
          telegram_message_id = excluded.telegram_message_id,
          reply_to_message_id = excluded.reply_to_message_id,
          baseline_at = excluded.baseline_at,
          sent_at = excluded.sent_at,
          metrics = excluded.metrics
      `,
      [
        input.insertId,
        input.chatId,
        input.noteId,
        input.threadRootNoteId,
        input.messageKind,
        input.messageId,
        input.replyToMessageId,
        input.baselineAt,
        (input.sentAt ?? new Date()).toISOString(),
        JSON.stringify(input.metrics ?? {}),
      ],
    );
    return true;
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return false;
    console.warn("[signal-bot] failed to record message delivery", {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
      messageKind: input.messageKind,
      noteId: input.noteId,
    });
    return false;
  }
}

async function reserveSignalBotFollowthroughMessage(input: {
  baselineAt: string;
  chatId: string;
  db: DbQuery;
  messageKind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  noteId: string;
  replyToMessageId: number | null;
  sentAt: Date;
  threadRootNoteId: string;
}): Promise<string | null> {
  try {
    const result = await input.db.query<{ id: string }>(
      `
        insert into signal_bot_messages (
          chat_id,
          note_id,
          thread_root_note_id,
          message_kind,
          telegram_message_id,
          reply_to_message_id,
          baseline_at,
          sent_at,
          metrics
        )
        values ($1, $2::uuid, $3::uuid, $4, null, $5, $6::timestamptz, $7::timestamptz, $8::jsonb)
        on conflict (chat_id, note_id, message_kind)
        do update set
          telegram_message_id = null,
          reply_to_message_id = excluded.reply_to_message_id,
          baseline_at = excluded.baseline_at,
          sent_at = excluded.sent_at,
          metrics = excluded.metrics
        where coalesce(signal_bot_messages.metrics->>'status', 'sent') <> 'sent'
          and signal_bot_messages.sent_at <= $9::timestamptz
        returning id
      `,
      [
        input.chatId,
        input.noteId,
        input.threadRootNoteId,
        input.messageKind,
        input.replyToMessageId,
        input.baselineAt,
        input.sentAt.toISOString(),
        JSON.stringify({ status: "pending" }),
        new Date(
          input.sentAt.getTime() - FOLLOWTHROUGH_RETRY_COOLDOWN_MS,
        ).toISOString(),
      ],
    );
    return result.rows[0]?.id ?? null;
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return null;
    console.warn("[signal-bot] failed to reserve followthrough delivery", {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
      messageKind: input.messageKind,
      noteId: input.noteId,
    });
    return null;
  }
}

async function recordSignalBotFollowthroughSkipped(input: {
  baselineAt: string;
  chatId: string;
  db: DbQuery;
  metrics: unknown;
  noteId: string;
  replyToMessageId: number | null;
  sentAt: Date;
  threadRootNoteId: string;
}): Promise<void> {
  try {
    await input.db.query(
      `
        insert into signal_bot_messages (
          chat_id,
          note_id,
          thread_root_note_id,
          message_kind,
          telegram_message_id,
          reply_to_message_id,
          baseline_at,
          sent_at,
          metrics
        )
        values ($1, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::jsonb)
        on conflict (chat_id, note_id, message_kind)
        do update set
          telegram_message_id = null,
          reply_to_message_id = excluded.reply_to_message_id,
          thread_root_note_id = excluded.thread_root_note_id,
          baseline_at = excluded.baseline_at,
          sent_at = excluded.sent_at,
          metrics = excluded.metrics
        where coalesce(signal_bot_messages.metrics->>'status', 'sent') <> 'sent'
      `,
      [
        input.chatId,
        input.noteId,
        input.threadRootNoteId,
        "followthrough_stats",
        null,
        input.replyToMessageId,
        input.baselineAt,
        input.sentAt.toISOString(),
        JSON.stringify(input.metrics),
      ],
    );
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return;
    console.warn("[signal-bot] failed to record skipped followthrough", {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
      noteId: input.noteId,
    });
  }
}

async function sendSignalBotMessageWithReplyFallback(input: {
  message: TelegramSendMessageInput;
  replyToMessageId: number | null;
  telegram: SignalBotTelegramClient;
}): Promise<SignalBotDeliverySendResult> {
  if (input.replyToMessageId == null) {
    const result = await input.telegram.sendMessage(input.message);
    return result.ok
      ? {
          fallbackStandalone: false,
          messageId: result.messageId,
          ok: true,
          replyToMessageId: null,
        }
      : result;
  }
  const replyMessage: TelegramSendMessageInput = {
    ...input.message,
    reply_parameters: {
      message_id: input.replyToMessageId,
    },
  };
  const result = await input.telegram.sendMessage(replyMessage);
  if (result.ok) {
    return {
      fallbackStandalone: false,
      messageId: result.messageId,
      ok: true,
      replyToMessageId: input.replyToMessageId,
    };
  }
  if (result.error === "blocked_or_missing") return result;
  const fallback = await input.telegram.sendMessage(input.message);
  return fallback.ok
    ? {
        fallbackStandalone: true,
        messageId: fallback.messageId,
        ok: true,
        replyToMessageId: null,
      }
    : fallback;
}

export function createSignalBotTelegramTransport(
  telegram: SignalBotTelegramClient,
): SignalTransport {
  return createTelegramSignalTransport(async (payload) => {
    const chatId = payload.destinationId?.trim();
    if (!chatId || payload.telegram?.parseMode !== "MarkdownV2") {
      return {
        deliveryId: null,
        errorCode: "invalid_payload",
        message: "Telegram delivery payload is incomplete.",
        ok: false,
      };
    }
    const replyToMessageId = payload.replyToDeliveryId
      ? Number(payload.replyToDeliveryId)
      : null;
    if (
      replyToMessageId != null &&
      (!Number.isInteger(replyToMessageId) || replyToMessageId <= 0)
    ) {
      return {
        deliveryId: null,
        errorCode: "invalid_reply",
        message: "Telegram reply target is invalid.",
        ok: false,
      };
    }
    const result = await sendSignalBotMessageWithReplyFallback({
      message: {
        chat_id: chatId,
        disable_web_page_preview:
          payload.telegram.disableWebPagePreview === true,
        parse_mode: "MarkdownV2",
        reply_markup: payload.telegram.replyMarkup as
          | TelegramInlineKeyboard
          | undefined,
        text: payload.text,
      },
      replyToMessageId,
      telegram,
    });
    return result.ok
      ? {
          deliveryId:
            result.messageId == null ? null : String(result.messageId),
          metadata: {
            fallbackStandalone: result.fallbackStandalone,
            replyToDeliveryId:
              result.replyToMessageId == null
                ? null
                : String(result.replyToMessageId),
          },
          ok: true,
        }
      : {
          deliveryId: null,
          errorCode: result.error,
          message: result.message,
          ok: false,
          retryAfterSec: result.retryAfterSec,
        };
  });
}

async function sendSignalBotViaTransport(input: {
  payload: TransportPayload;
  transport: SignalTransport;
}): Promise<SignalBotDeliverySendResult> {
  const result = await input.transport.send(input.payload);
  if (!result.ok) {
    return {
      error:
        result.errorCode === "blocked_or_missing"
          ? "blocked_or_missing"
          : "other",
      message: result.message ?? "Telegram delivery failed",
      ok: false,
      retryAfterSec: result.retryAfterSec,
    };
  }
  const messageId = result.deliveryId ? Number(result.deliveryId) : null;
  const replyToDeliveryId = result.metadata?.replyToDeliveryId;
  const replyToMessageId =
    typeof replyToDeliveryId === "string" ? Number(replyToDeliveryId) : null;
  if (
    (messageId != null && !Number.isInteger(messageId)) ||
    (replyToMessageId != null && !Number.isInteger(replyToMessageId))
  ) {
    throw new Error("Telegram transport returned an invalid delivery ID");
  }
  return {
    fallbackStandalone: result.metadata?.fallbackStandalone === true,
    messageId,
    ok: true,
    replyToMessageId,
  };
}

function buildNeutralSignalDeliveryView(input: {
  appBaseUrl: string;
  buyAmountUsd: number;
  kind: "initial" | "research_update";
  note: SignalBotNote;
  sourceSide: "NO" | "YES" | null;
  target: SignalBotCheaperAlternative | null;
  copyPolicy?: ResolvedSignalPostCopyPolicy;
}): SignalDeliveryView {
  const notificationCopy = buildSignalBotInitialNotificationCopy({
    copyPolicy: input.copyPolicy,
    messageKind: input.kind,
    note: input.note,
    side: input.sourceSide,
  });
  const target =
    input.kind === "research_update"
      ? null
      : input.target
        ? {
            eventId: input.target.eventId,
            marketId: input.target.marketId,
            price: input.target.price,
            side: input.target.side,
            tradeUrl: buildSignalBotTradeUrl({
              amountUsd: input.buyAmountUsd,
              appBaseUrl: input.appBaseUrl,
              eventId: input.target.eventId,
              marketId: input.target.marketId,
              side: input.target.side,
            }),
            venue: input.target.venue,
          }
        : null;
  return {
    contextLines: input.note.rationale ? [input.note.rationale] : [],
    credentialLines: input.note.holderCredentialBullets,
    holder: input.note.holderAddress
      ? {
          address: input.note.holderAddress,
          displayName:
            input.note.holderDisplayName ??
            input.note.holderIdentityDisplayName ??
            null,
          positionUsd: input.note.holderPositionUsd,
          side: input.note.holderSide,
        }
      : null,
    kind: input.kind === "research_update" ? "research-update" : "initial",
    source: {
      eventId: input.note.eventId,
      marketId: input.note.marketId,
      side: input.sourceSide,
      venue: input.note.marketVenue,
    },
    summary: input.note.description,
    target,
    thread: {},
    title: notificationCopy.headline.text,
  };
}

export async function publishSignalBotTick(input: {
  config: SignalBotConfig;
  db: DbQuery;
  redis: SignalBotRedisLike;
  telegram: SignalBotTelegramClient;
  transports?: readonly SignalTransport[];
}): Promise<
  {
    blockedChats: number;
    chats: number;
    cheaperAlternatives: number;
    nonDirectionalNotes: number;
    publishNotesSeen: number;
    sent: number;
  } & SignalBotCheaperAlternativeDiagnostics &
    SignalBotPriceGuardDiagnostics
> {
  const chatIds = await input.redis.sMembers(CHAT_SET_KEY);
  const telegramTransport =
    input.transports?.find((transport) => transport.kind === "telegram") ??
    createSignalBotTelegramTransport(input.telegram);
  const lifecycle = await resolveSignalBotVenueLifecycle(input.db);
  const copyPolicy = await resolveSignalPostCopyPolicy(input.db);
  let sent = 0;
  let blockedChats = 0;
  const cheaperAlternatives = 0;
  let nonDirectionalNotes = 0;
  let publishNotesSeen = 0;
  const alternativeDiagnostics = createSignalBotCheaperAlternativeDiagnostics();
  const priceGuardDiagnostics = createSignalBotPriceGuardDiagnostics();
  for (const chatId of chatIds) {
    const state = await getSignalBotChatState(input.redis, chatId);
    if (!state) {
      await input.redis.sRem(CHAT_SET_KEY, chatId);
      continue;
    }
    const counts = await loadSignalBotEligibilityCounts(input.db, {
      afterCreatedAt: state.cursorCreatedAt,
      afterId: state.cursorId,
    });
    nonDirectionalNotes += counts.nonDirectional;
    publishNotesSeen += counts.publishNotesSeen;
    const notes = await loadSignalBotNotes(input.db, {
      afterCreatedAt: state.cursorCreatedAt,
      afterId: state.cursorId,
      limit: input.config.maxSignalsPerTick,
    });
    for (const note of notes) {
      const sourceVenue = normalizeHunchVenue(note.marketVenue);
      if (
        !sourceVenue ||
        !getVenuesWithLifecycleCapability(
          lifecycle.policy,
          "signalSource",
        ).includes(sourceVenue)
      ) {
        await updateSignalBotChatCursor({
          chatId,
          createdAt: note.createdAt,
          id: note.id,
          redis: input.redis,
        });
        continue;
      }
      const sendCooldown = await input.redis.get(
        signalBotSendCooldownKey(chatId, note.id),
      );
      if (sendCooldown) break;
      const thread = await loadSignalBotThreadContext({
        chatId,
        db: input.db,
        note,
      });
      const destinationPolicy: SignalDestinationPolicy =
        state.destinationPolicy ?? {
          fallback: "skip",
          selectionMode: "best-executable",
          targetVenues: getVenuesWithLifecycleCapability(
            lifecycle.policy,
            "signalDelivery",
          ),
        };
      const deliveryRef = createSignalDeliveryRef();
      const preparation = await prepareSignalBotDelivery({
        appBaseUrl: input.config.appBaseUrl,
        buyAmountUsd: input.config.buyAmountUsd,
        chatType: state.chatType,
        copyPolicy,
        db: input.db,
        deliveryRef,
        messageKind: thread.messageKind,
        note,
        redis: input.redis,
        telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
      });
      if (preparation.status === "deferred") {
        const deferCount = await recordSignalBotPriceGuardDeferral({
          chatId,
          noteId: note.id,
          redis: input.redis,
          ttlSec: input.config.priceGuardDeferTtlSec,
        });
        addSignalBotPriceGuardBlockers(
          priceGuardDiagnostics,
          preparation.blockers,
        );
        if (deferCount > input.config.priceGuardMaxDefers) {
          priceGuardDiagnostics.priceGuardStaleExpired += 1;
          await updateSignalBotChatCursor({
            chatId,
            createdAt: note.createdAt,
            id: note.id,
            redis: input.redis,
          });
          continue;
        }
        priceGuardDiagnostics.priceGuardDeferred += 1;
        break;
      }
      if (preparation.status === "skipped") {
        if (preparation.blockers.length > 0) {
          priceGuardDiagnostics.priceGuardSkipped += 1;
          addSignalBotPriceGuardBlockers(
            priceGuardDiagnostics,
            preparation.blockers,
          );
        }
        await updateSignalBotChatCursor({
          chatId,
          createdAt: note.createdAt,
          id: note.id,
          redis: input.redis,
        });
        continue;
      }
      if (preparation.blockers.length > 0) {
        addSignalBotPriceGuardBlockers(
          priceGuardDiagnostics,
          preparation.blockers,
        );
      }
      const { buySide, deliveryTarget, keyboard, text } = preparation;
      const deliveryView = buildNeutralSignalDeliveryView({
        appBaseUrl: input.config.appBaseUrl,
        buyAmountUsd: input.config.buyAmountUsd,
        kind: thread.messageKind,
        note,
        sourceSide: buySide,
        target: deliveryTarget,
        copyPolicy,
      });
      const transportPayload: TransportPayload = {
        ...telegramTransport.render(deliveryView),
        destinationId: chatId,
        replyToDeliveryId:
          thread.replyToMessageId == null
            ? undefined
            : String(thread.replyToMessageId),
        telegram: {
          disableWebPagePreview: false,
          parseMode: "MarkdownV2",
          replyMarkup: keyboard,
        },
        text,
      };
      const result = await sendSignalBotViaTransport({
        payload: transportPayload,
        transport: telegramTransport,
      });
      if (result.ok) {
        sent += 1;
        await recordSignalBotMessage({
          baselineAt: thread.baselineAt,
          chatId,
          db: input.db,
          insertId: deliveryRef,
          messageId: result.messageId,
          messageKind: thread.messageKind,
          metrics: {
            copy: buildSignalBotCopyAudit({
              buySide,
              messageKind: thread.messageKind,
              note,
              copyPolicy,
            }),
            delivery: {
              lifecycleRevision: lifecycle.revision,
              preparation: preparation.audit,
              policy: destinationPolicy,
              view: deliveryView,
            },
            fallbackStandalone: result.fallbackStandalone,
            noteKind: thread.messageKind,
          },
          noteId: note.id,
          replyToMessageId: result.replyToMessageId,
          threadRootNoteId: thread.threadRootNoteId,
        });
        await updateSignalBotChatCursor({
          chatId,
          createdAt: note.createdAt,
          id: note.id,
          redis: input.redis,
        });
        continue;
      }
      if (result.error === "blocked_or_missing") {
        blockedChats += 1;
        await disableSignalBotChat(input.redis, chatId);
        break;
      }
      await input.redis.set(
        signalBotSendCooldownKey(chatId, note.id),
        result.message,
        { EX: result.retryAfterSec ?? SEND_FAILURE_COOLDOWN_SEC },
      );
      break;
    }
  }
  return {
    ...alternativeDiagnostics,
    ...priceGuardDiagnostics,
    blockedChats,
    chats: chatIds.length,
    cheaperAlternatives,
    nonDirectionalNotes,
    publishNotesSeen,
    sent,
  };
}

export type SignalBotTestSignalOutcome = {
  reason: SignalBotDeliveryPreparationReason | "no_eligible_note" | null;
  sent: boolean;
};

export type SignalBotTestSignalSelector =
  | "initial"
  | "latest"
  | "update"
  | string;

export async function sendLatestSignalBotTestSignal(input: {
  chatId: string;
  config: SignalBotConfig;
  db: DbQuery;
  redis?: SignalBotRedisLike;
  selector?: SignalBotTestSignalSelector;
  telegram: SignalBotTelegramClient;
}): Promise<SignalBotTestSignalOutcome> {
  const selector = input.selector ?? "latest";
  const noteId = UUID_RE.test(selector) ? selector : null;
  const revisionKind =
    selector === "initial"
      ? "initial"
      : selector === "update"
        ? "research_update"
        : null;
  const chatState = input.redis
    ? await getSignalBotChatState(input.redis, input.chatId)
    : null;
  const notes = await loadSignalBotNotes(input.db, {
    afterCreatedAt: LATEST_CURSOR_CREATED_AT,
    afterId: LATEST_CURSOR_ID,
    descending: true,
    limit: 1,
    noteId,
    revisionKind,
  });
  const note = notes[0];
  if (!note) return { reason: "no_eligible_note", sent: false };
  const copyPolicy = await resolveSignalPostCopyPolicy(input.db);
  const preparation = await prepareSignalBotDelivery({
    appBaseUrl: input.config.appBaseUrl,
    buyAmountUsd: input.config.buyAmountUsd,
    chatType: chatState?.chatType,
    copyPolicy,
    db: input.db,
    deliveryRef: createSignalDeliveryRef(),
    messageKind: note.revisionKind,
    note,
    redis: input.redis,
    telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
  });
  if (preparation.status !== "ready") {
    return { reason: preparation.reason, sent: false };
  }
  const result = await input.telegram.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: false,
    parse_mode: "MarkdownV2",
    reply_markup: preparation.keyboard,
    text: preparation.text,
  });
  return {
    reason: result.ok ? null : "unpublishable_copy",
    sent: result.ok,
  };
}

function signalBotFollowthroughPolicyType(
  kind: SignalBotFollowthroughPreviewKind,
): SignalBotFollowthroughPolicy["types"][number] {
  return kind;
}

function signalBotFollowthroughMessageKindForPreview(
  kind: SignalBotFollowthroughPreviewKind,
): Extract<
  SignalBotMessageKind,
  "followthrough_stats" | "resolved_loss" | "resolved_win"
> {
  return kind === "stats" ? "followthrough_stats" : kind;
}

export async function sendSignalBotFollowthroughPreview(input: {
  chatId: string;
  config: SignalBotConfig;
  db: DbQuery;
  kind: SignalBotFollowthroughPreviewKind;
  now?: Date;
  redis?: SignalBotRedisLike;
  telegram: SignalBotTelegramClient;
}): Promise<boolean> {
  const effectivePolicy = await resolveSignalBotFollowthroughPolicy(
    input.db,
    input.config.followthrough,
  );
  const policy: SignalBotFollowthroughPolicy = {
    ...effectivePolicy,
    enabled: true,
    maxPerTick: Math.max(1, effectivePolicy.maxPerTick),
    types: [signalBotFollowthroughPolicyType(input.kind)],
  };
  const now = input.now ?? new Date();
  const expectedKind = signalBotFollowthroughMessageKindForPreview(input.kind);
  const candidates = await loadSignalBotFollowthroughCandidates({
    chatIds: [input.chatId],
    db: input.db,
    mode: "preview",
    now,
    policy,
  });
  const chatState = input.redis
    ? await getSignalBotChatState(input.redis, input.chatId)
    : null;
  const latestSnapshotMaxAgeMs = await resolveSignalBotLatestSnapshotMaxAgeMs(
    input.db,
  );
  for (const candidate of candidates) {
    const stats = await buildSignalBotFollowthroughStats({
      asOf: now,
      candidate,
      db: input.db,
      latestSnapshotMaxAgeMs,
    });
    const kind = resolveSignalBotFollowthroughKind({ policy, stats });
    if (kind !== expectedKind) continue;
    const text = `${escapeTelegramMarkdownV2(
      "Preview only - not recorded.",
    )}\n\n${buildSignalBotFollowthroughMessage({
      candidate,
      kind,
      stats,
      telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
    })}`;
    const target = resolveSignalBotFollowthroughDeliveryTarget(candidate);
    const buyPrice =
      input.redis != null
        ? await resolveSignalBotFollowthroughBuyCtaPrice({
            db: input.db,
            redis: input.redis,
            stats,
            target,
          })
        : null;
    const keyboard = buildSignalBotFollowthroughKeyboard({
      allowBuyCta: buyPrice != null,
      appBaseUrl: input.config.appBaseUrl,
      buyPrice,
      buyAmountUsd: input.config.buyAmountUsd,
      candidate,
      chatType: chatState?.chatType,
      kind,
      stats,
      target,
      telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
    });
    const result = await sendSignalBotMessageWithReplyFallback({
      message: {
        chat_id: input.chatId,
        disable_web_page_preview: true,
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
        text,
      },
      replyToMessageId: toInteger(candidate.reply_to_message_id),
      telegram: input.telegram,
    });
    return result.ok;
  }
  return false;
}

function sideFromSignalBotDirection(
  direction: "down" | "mixed" | "up" | null,
): "NO" | "YES" | null {
  if (direction === "up") return "YES";
  if (direction === "down") return "NO";
  return null;
}

function signalBotFollowthroughQualityRank(
  quality: SignalBotFollowthroughDataQuality,
): number {
  if (quality === "clean") return 2;
  if (quality === "usable") return 1;
  return 0;
}

function signalBotStatsSidePrice(
  yesPrice: number | null,
  side: "NO" | "YES" | null,
): number | null {
  if (yesPrice == null || !side) return null;
  return side === "YES" ? yesPrice : 1 - yesPrice;
}

function roundSignalBotUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function explicitFinalYesProbability(input: {
  best_ask: unknown;
  best_bid: unknown;
  last_price: unknown;
  resolved_outcome?: unknown;
  resolved_outcome_pct?: unknown;
}): ReturnType<typeof resolveHolderResearchFinalYesProbability> {
  const final = resolveHolderResearchFinalYesProbability(input);
  return final.source === "terminal_price"
    ? { finalYesProbability: null, source: "missing" }
    : final;
}

function readSignalBotEntryPrice(input: {
  direction: "down" | "mixed" | "up" | null;
  metrics: unknown;
  side: "NO" | "YES" | null;
  targetMeta: unknown;
}): number | null {
  const side = input.side ?? sideFromSignalBotDirection(input.direction);
  if (!side) return null;
  const metrics = asObject(input.metrics);
  const snapshot = asObject(metrics.signalSnapshot);
  const quote = asObject(snapshot.quote);
  const snapshotSide = String(snapshot.side ?? "").toUpperCase();
  const snapshotPrice = toNumber(quote.buyPrice);
  if (snapshotPrice != null && snapshotSide === side) return snapshotPrice;
  const market = asObject(metrics.market);
  const yesProbability = toNumber(market.yesProbability);
  return signalBotStatsSidePrice(yesProbability, side);
}

async function loadSignalBotFollowthroughCandidates(input: {
  chatIds: string[];
  db: DbQuery;
  mode: "preview" | "publish";
  policy: SignalBotFollowthroughPolicy;
  now: Date;
}): Promise<SignalBotFollowthroughCandidateRow[]> {
  if (!input.policy.enabled) return [];
  if (input.chatIds.length === 0) return [];
  const statsEnabled = input.policy.types.includes("stats");
  const resolvedEnabled =
    input.policy.terminalInitialCutoff != null &&
    (input.policy.types.includes("resolved_win") ||
      input.policy.types.includes("resolved_loss"));
  if (!statsEnabled && !resolvedEnabled) return [];
  const acceptingSql = buildWalletIntelAcceptingOrdersSql({
    eventAlias: "e",
    marketAlias: "m",
  });
  const statsCutoff = new Date(
    input.now.getTime() - input.policy.minAgeHours * 3_600_000,
  ).toISOString();
  try {
    const { rows } = await input.db.query<SignalBotFollowthroughCandidateRow>(
      `
        select
          root.chat_id,
          root.thread_root_note_id::text,
          root.telegram_message_id::text as reply_to_message_id,
          root.baseline_at::text as baseline_at,
          n.title,
          n.direction,
          n.metrics,
          root.metrics as root_metrics,
          pt.target_meta,
          m.id as market_id,
          m.event_id,
          m.title as market_title,
          m.slug as market_slug,
          m.description as market_description,
          e.title as event_title,
          e.description as event_description,
          m.outcomes,
          m.venue,
          m.best_bid,
          m.best_ask,
          m.last_price,
          m.resolved_outcome,
          m.resolved_outcome_pct::text as resolved_outcome_pct,
          nullif(
            coalesce(
              nullif(m.metadata->>'resolutionSource', ''),
              nullif(e.metadata->>'resolutionSource', '')
            ),
            ''
          ) as resolution_source,
          ${acceptingSql} as accepting_orders
        from signal_bot_messages root
        join ai_notes n on n.id = root.thread_root_note_id
        join ai_note_targets pt
          on pt.note_id = n.id
         and pt.target_kind = 'market'
         and pt.is_primary = true
        join unified_markets m on m.id = pt.target_id
        left join unified_events e on e.id = m.event_id
        where root.message_kind = 'initial'
          and root.telegram_message_id is not null
          and root.chat_id = any($5::text[])
          and (
            (
              $1::boolean
              and root.sent_at <= $3::timestamptz
              and ${acceptingSql}
              and (
                $7::boolean
                or not exists (
                  select 1
                  from signal_bot_messages sent
                  where sent.chat_id = root.chat_id
                    and sent.note_id = root.thread_root_note_id
                    and sent.message_kind = 'followthrough_stats'
                    and (
                      coalesce(sent.metrics->>'status', 'sent') = 'sent'
                      or sent.sent_at > $6::timestamptz
                    )
                )
              )
            )
            or (
              $2::boolean
              and root.sent_at >= $8::timestamptz
              and (
                $7::boolean
                or not exists (
                  select 1
                  from signal_bot_messages sent
                  where sent.chat_id = root.chat_id
                    and sent.note_id = root.thread_root_note_id
                    and sent.message_kind in ('resolved_win', 'resolved_loss')
                    and (
                      coalesce(sent.metrics->>'status', 'sent') = 'sent'
                      or sent.sent_at > $6::timestamptz
                    )
                )
              )
              and (
                m.resolved_outcome is not null
                or m.resolved_outcome_pct is not null
              )
            )
          )
        order by root.sent_at asc
        limit $4
      `,
      [
        statsEnabled,
        resolvedEnabled,
        statsCutoff,
        Math.max(1, input.policy.maxPerTick * 4),
        input.chatIds,
        new Date(
          input.now.getTime() - FOLLOWTHROUGH_RETRY_COOLDOWN_MS,
        ).toISOString(),
        input.mode === "preview",
        input.policy.terminalInitialCutoff,
      ],
    );
    return rows;
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return [];
    throw error;
  }
}

async function loadSignalBotFollowthroughFlows(input: {
  asOf: string;
  baselineAt: string;
  db: DbQuery;
  marketId: string;
  venue: string | null;
}): Promise<SignalBotFollowthroughFlowRow[]> {
  const venueFilter = input.venue?.trim() || null;
  const { rows } = await input.db.query<SignalBotFollowthroughFlowRow>(
    `
      with post_events as materialized (
        select
          wa.wallet_id,
          wa.market_id,
          wa.outcome_side,
          case when upper(coalesce(wa.action, 'BUY')) = 'SELL' then -1 else 1 end
            as action_sign,
          abs(
            coalesce(
              wa.size_usd,
              abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0),
              0
            )
          ) as abs_usd,
          abs(
            coalesce(
              wa.delta_shares,
              case
                when wa.price is not null and wa.price > 0 and wa.size_usd is not null
                  then wa.size_usd / wa.price
                else 0
              end
            )
          ) as abs_shares
        from wallet_activity_events wa
        where wa.market_id = $1
          and ($4::text is null or wa.venue = $4)
          and wa.outcome_side in ('YES', 'NO')
          and wa.activity_type in ('delta', 'trade')
          and wa.occurred_at > $2::timestamptz
          and wa.occurred_at <= $3::timestamptz
      ),
      wallet_sides as (
        select distinct wallet_id, market_id, outcome_side
        from post_events
      )
      select
        ws.wallet_id::text as wallet_id,
        ws.outcome_side as outcome_side,
        baseline.shares::text as baseline_shares,
        latest.shares::text as latest_shares,
        latest.snapshot_at::text as latest_snapshot_at,
        latest.size_usd::text as latest_size_usd,
        coalesce(sum(pe.abs_usd) filter (where pe.action_sign > 0), 0)::text
          as positive_usd,
        coalesce(sum(pe.abs_usd) filter (where pe.action_sign < 0), 0)::text
          as negative_usd,
        coalesce(sum(pe.action_sign * pe.abs_usd), 0)::text as net_usd,
        coalesce(sum(pe.action_sign * pe.abs_shares), 0)::text as net_shares,
        count(pe.*)::text as event_count
      from wallet_sides ws
      join post_events pe
        on pe.wallet_id = ws.wallet_id
       and pe.market_id = ws.market_id
       and pe.outcome_side = ws.outcome_side
      left join lateral (
        select s.shares
        from wallet_position_snapshots s
        where s.wallet_id = ws.wallet_id
          and s.market_id = ws.market_id
          and ($4::text is null or s.venue = $4)
          and s.outcome_side = ws.outcome_side
          and s.snapshot_at <= $2::timestamptz
        order by s.snapshot_at desc
        limit 1
      ) baseline on true
      left join lateral (
        select s.shares, s.size_usd, s.snapshot_at
        from wallet_position_snapshots s
        where s.wallet_id = ws.wallet_id
          and s.market_id = ws.market_id
          and ($4::text is null or s.venue = $4)
          and s.outcome_side = ws.outcome_side
          and s.snapshot_at <= $3::timestamptz
        order by s.snapshot_at desc
        limit 1
      ) latest on true
      group by
        ws.wallet_id,
        ws.outcome_side,
        baseline.shares,
        latest.shares,
        latest.snapshot_at,
        latest.size_usd
    `,
    [input.marketId, input.baselineAt, input.asOf, venueFilter],
  );
  return rows;
}

async function buildSignalBotFollowthroughStats(input: {
  asOf: Date;
  candidate: SignalBotFollowthroughCandidateRow;
  db: DbQuery;
  latestSnapshotMaxAgeMs: number;
}): Promise<SignalBotFollowthroughStats> {
  const sideRaw = String(
    asObject(input.candidate.target_meta).side ?? "",
  ).toUpperCase();
  const side = sideRaw === "YES" || sideRaw === "NO" ? sideRaw : null;
  const signalSide =
    side === "YES" || side === "NO"
      ? side
      : sideFromSignalBotDirection(input.candidate.direction);
  const final = explicitFinalYesProbability(input.candidate);
  const state =
    final.finalYesProbability != null
      ? "resolved"
      : input.candidate.accepting_orders === true
        ? "open"
        : "unknown";
  const quote = signalSide
    ? resolveHolderResearchSignalQuote(input.candidate, signalSide)
    : null;
  const entryPrice = readSignalBotEntryPrice({
    direction: input.candidate.direction,
    metrics: input.candidate.metrics,
    side: signalSide,
    targetMeta: input.candidate.target_meta,
  });
  const finalSidePrice =
    final.finalYesProbability != null
      ? signalBotStatsSidePrice(final.finalYesProbability, signalSide)
      : null;
  const markPrice = finalSidePrice ?? quote?.markPrice ?? null;
  const priceMoveCents =
    entryPrice != null && markPrice != null
      ? (markPrice - entryPrice) * 100
      : null;
  const baselineAt =
    input.candidate.baseline_at instanceof Date
      ? input.candidate.baseline_at.toISOString()
      : input.candidate.baseline_at;
  const asOf = input.asOf.toISOString();
  const flows = await loadSignalBotFollowthroughFlows({
    asOf,
    baselineAt,
    db: input.db,
    marketId: input.candidate.market_id,
    venue: input.candidate.venue,
  });
  let joinedWallets = 0;
  let addedWallets = 0;
  let trimmedWallets = 0;
  let exitedWallets = 0;
  let stillHoldingWallets = 0;
  let netSignalSideFlowUsd = 0;
  let netOppositeSideFlowUsd = 0;
  let openPnlShares = 0;
  let missingBaseline = 0;
  let missingLatest = 0;
  let staleLatest = 0;
  for (const row of flows) {
    const isSignalSide = row.outcome_side === signalSide;
    const baselineSharesRaw = toNumber(row.baseline_shares);
    const hasBaselineSnapshot = baselineSharesRaw != null;
    const baselineShares = baselineSharesRaw ?? 0;
    const latestShares = toNumber(row.latest_shares);
    const latestSnapshotAt =
      row.latest_snapshot_at instanceof Date
        ? row.latest_snapshot_at.getTime()
        : typeof row.latest_snapshot_at === "string" &&
            row.latest_snapshot_at.trim().length > 0
          ? Date.parse(row.latest_snapshot_at)
          : null;
    const latestSizeUsd = toNumber(row.latest_size_usd);
    const positiveUsd = toNumber(row.positive_usd) ?? 0;
    const negativeUsd = toNumber(row.negative_usd) ?? 0;
    const netUsd = toNumber(row.net_usd) ?? 0;
    const netShares = toNumber(row.net_shares) ?? 0;
    const hadBaseline = baselineShares > 1e-9;
    const hasLatestSnapshot = latestShares != null || latestSizeUsd != null;
    const hasFreshLatestSnapshot =
      hasLatestSnapshot &&
      latestSnapshotAt != null &&
      Number.isFinite(latestSnapshotAt) &&
      input.asOf.getTime() - latestSnapshotAt <= input.latestSnapshotMaxAgeMs;
    const hasLatestPosition =
      hasFreshLatestSnapshot &&
      ((latestShares ?? 0) > 1e-9 || (latestSizeUsd ?? 0) > 0);
    if (!hasBaselineSnapshot) missingBaseline += 1;
    if (latestShares == null) missingLatest += 1;
    if (hasLatestSnapshot && !hasFreshLatestSnapshot) staleLatest += 1;
    if (isSignalSide) {
      netSignalSideFlowUsd += netUsd;
      if (
        hasBaselineSnapshot &&
        !hadBaseline &&
        positiveUsd > 0 &&
        (netUsd > 0 || hasLatestPosition)
      ) {
        joinedWallets += 1;
      } else if (hadBaseline && positiveUsd > 0 && netUsd > 0) {
        addedWallets += 1;
      }
      if (negativeUsd > 0) trimmedWallets += 1;
      if (
        (hadBaseline || positiveUsd > 0) &&
        negativeUsd > 0 &&
        hasFreshLatestSnapshot &&
        !hasLatestPosition
      ) {
        exitedWallets += 1;
      }
      if (hasLatestPosition) {
        stillHoldingWallets += 1;
        openPnlShares += Math.max(0, netShares);
      }
    } else {
      netOppositeSideFlowUsd += netUsd;
    }
  }
  const dataQualityTags: string[] = [];
  if (flows.length === 0) dataQualityTags.push("no_wallet_flow");
  if (entryPrice == null) dataQualityTags.push("missing_entry_price");
  if (markPrice == null) dataQualityTags.push("missing_mark_price");
  if (missingBaseline > 0) dataQualityTags.push("missing_baseline_snapshots");
  if (missingLatest > 0) dataQualityTags.push("missing_latest_snapshots");
  if (staleLatest > 0) dataQualityTags.push("stale_latest_snapshots");
  let dataQuality: SignalBotFollowthroughDataQuality = "any";
  if (flows.length > 0) dataQuality = "usable";
  if (
    flows.length > 0 &&
    missingBaseline === 0 &&
    missingLatest === 0 &&
    staleLatest === 0 &&
    entryPrice != null &&
    markPrice != null
  ) {
    dataQuality = "clean";
  }
  const estimatedOpenPnlUsd =
    priceMoveCents != null && openPnlShares > 0
      ? roundSignalBotUsd((priceMoveCents / 100) * openPnlShares)
      : null;
  if (estimatedOpenPnlUsd != null) dataQualityTags.push("pnl_estimated");
  let outcome: SignalBotFollowthroughStats["outcome"] =
    state === "open" ? "open" : "unknown";
  if (state === "resolved" && signalSide && finalSidePrice != null) {
    if (entryPrice != null) {
      const move = finalSidePrice - entryPrice;
      outcome = move > 1e-9 ? "win" : move < -1e-9 ? "loss" : "unknown";
    } else if (finalSidePrice >= 0.999) {
      outcome = "win";
    } else if (finalSidePrice <= 0.001) {
      outcome = "loss";
    }
  }
  return {
    version: 1,
    evaluatedAt: new Date().toISOString(),
    threadRootNoteId: input.candidate.thread_root_note_id,
    finalProbabilitySource: final.source,
    marketId: input.candidate.market_id,
    signalSide,
    state,
    outcome,
    baselineAt,
    asOf,
    entryPrice,
    markPrice,
    priceMoveCents,
    joinedWallets,
    addedWallets,
    joinedOrAddedWallets: joinedWallets + addedWallets,
    trimmedWallets,
    exitedWallets,
    stillHoldingWallets,
    missingBaselineSnapshots: missingBaseline,
    netSignalSideFlowUsd,
    netOppositeSideFlowUsd,
    estimatedOpenPnlUsd,
    estimatedRealizedPnlUsd: null,
    dataQuality,
    dataQualityTags,
  };
}

function resolveSignalBotFollowthroughKind(input: {
  policy: SignalBotFollowthroughPolicy;
  stats: SignalBotFollowthroughStats;
}): Extract<
  SignalBotMessageKind,
  "followthrough_stats" | "resolved_loss" | "resolved_win"
> | null {
  const { policy, stats } = input;
  if (stats.outcome === "win" && policy.types.includes("resolved_win")) {
    return "resolved_win";
  }
  if (stats.outcome === "loss" && policy.types.includes("resolved_loss")) {
    return "resolved_loss";
  }
  if (stats.state !== "open" || !policy.types.includes("stats")) return null;
  if (
    signalBotFollowthroughQualityRank(stats.dataQuality) <
    signalBotFollowthroughQualityRank(policy.minDataQuality)
  ) {
    return null;
  }
  if (policy.requirePositiveFlowForStats && stats.netSignalSideFlowUsd <= 0) {
    return null;
  }
  const priceMovePass =
    stats.priceMoveCents != null &&
    Math.abs(stats.priceMoveCents) >= policy.minPriceMoveCents;
  const flowPass = Math.abs(stats.netSignalSideFlowUsd) >= policy.minNetFlowUsd;
  const cleanParticipationPass =
    stats.joinedOrAddedWallets >= policy.minJoinedOrAdded &&
    stats.joinedOrAddedWallets > stats.trimmedWallets &&
    stats.exitedWallets === 0 &&
    stats.netSignalSideFlowUsd > 0 &&
    (stats.priceMoveCents == null || stats.priceMoveCents >= 0);
  if (cleanParticipationPass || flowPass || priceMovePass) {
    return "followthrough_stats";
  }
  return null;
}

function formatSignedCentsMove(value: number | null): string {
  if (value == null) return "n/a";
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded}¢`;
}

function formatSignalBotFollowthroughRead(input: {
  hasWalletEvidence: boolean;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  sideCopy: MarketSideCopy | null;
  sideLabel: string;
  stats: SignalBotFollowthroughStats;
}): string {
  const priceMoveCents =
    input.stats.priceMoveCents != null &&
    Math.abs(input.stats.priceMoveCents) < 0.5
      ? 0
      : input.stats.priceMoveCents;
  const marketLabel =
    input.stats.markPrice == null
      ? input.sideLabel
      : `${input.sideLabel} at ${formatCents(input.stats.markPrice)}`;
  if (input.kind === "resolved_win") {
    return `${marketLabel} closed green. This is performance tracking, not a fresh entry.`;
  }
  if (input.kind === "resolved_loss") {
    return `${marketLabel} closed red. Treat this as performance tracking, not a fresh entry.`;
  }
  if (!input.hasWalletEvidence) {
    return `${marketLabel} moved with the read, but tracked wallet follow-through is thin so far.`;
  }
  if (priceMoveCents != null && priceMoveCents > 0) {
    if (
      input.stats.exitedWallets > 0 ||
      input.stats.trimmedWallets > input.stats.joinedOrAddedWallets
    ) {
      const read =
        input.stats.exitedWallets > 0 && input.stats.netSignalSideFlowUsd <= 0
          ? "is up, but tracked wallets are exiting and flow has turned negative."
          : priceMoveCents >= 5
            ? "moved sharply, but wallet follow-through is mixed."
            : input.stats.netSignalSideFlowUsd > 0
              ? "moved with the call; net flow stays positive, but more wallets trimmed than added."
              : "moved with the call, but more wallets trimmed than added.";
      return `${marketLabel} ${read}`;
    }
    if (
      input.stats.joinedOrAddedWallets > 0 &&
      input.stats.netSignalSideFlowUsd > 0
    ) {
      return `${marketLabel} moved with the call, backed by fresh wallet flow.`;
    }
    return `${marketLabel} moved with the call, while tracked positions remain open.`;
  }
  if (priceMoveCents != null && priceMoveCents < 0) {
    const move = `${Math.max(1, Math.round(Math.abs(priceMoveCents)))}¢`;
    if (input.stats.netSignalSideFlowUsd > 0) {
      const support =
        input.stats.exitedWallets > 0
          ? `Positive tracked flow has not offset ${input.stats.exitedWallets} ${
              input.stats.exitedWallets === 1 ? "exit" : "exits"
            }`
          : input.stats.trimmedWallets >= input.stats.joinedOrAddedWallets
            ? "Positive tracked flow has not offset mixed wallet behavior"
            : "Positive tracked flow has not lifted the market";
      return `${support}; ${marketLabel} is ${move} below the call.`;
    }
    return `${marketLabel} is ${move} below the call while tracked flow cools.`;
  }
  if (input.stats.netSignalSideFlowUsd > 0) {
    if (
      input.stats.trimmedWallets > input.stats.joinedOrAddedWallets ||
      input.stats.exitedWallets > 0
    ) {
      return `More money went into ${marketLabel}, but wallet support thinned and the price did not move.`;
    }
    return `${marketLabel} stayed flat even as more money came in.`;
  }
  if (input.stats.netSignalSideFlowUsd < 0) {
    return `${marketLabel} stayed flat while tracked wallet support cooled.`;
  }
  return `${marketLabel} has not drawn meaningful follow-through yet.`;
}

function formatSignalBotFollowthroughReadMarkdown(input: {
  hasWalletEvidence: boolean;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  marketUrl: string | null;
  sideCopy: MarketSideCopy | null;
  sideLabel: string;
  stats: SignalBotFollowthroughStats;
}): string {
  const marketLabel =
    input.stats.markPrice == null
      ? input.sideLabel
      : `${input.sideLabel} at ${formatCents(input.stats.markPrice)}`;
  const plain = formatSignalBotFollowthroughRead(input);
  const marketLabelIndex = plain.indexOf(marketLabel);
  if (marketLabelIndex < 0) return escapeTelegramMarkdownV2(plain);
  const linkedMarket = input.marketUrl
    ? formatTelegramLink(marketLabel, input.marketUrl)
    : escapeTelegramMarkdownV2(marketLabel);
  return `${escapeTelegramMarkdownV2(
    plain.slice(0, marketLabelIndex),
  )}${linkedMarket}${escapeTelegramMarkdownV2(
    plain.slice(marketLabelIndex + marketLabel.length),
  )}`;
}

function isSignalBotFollowthroughCooling(
  stats: SignalBotFollowthroughStats,
): boolean {
  return (
    (stats.trimmedWallets > stats.joinedOrAddedWallets &&
      stats.netSignalSideFlowUsd <= 0) ||
    (stats.exitedWallets > 0 && stats.joinedOrAddedWallets === 0)
  );
}

function formatSignalBotFollowthroughActivityLine(
  stats: SignalBotFollowthroughStats,
): string {
  const trimmedOnly = Math.max(0, stats.trimmedWallets - stats.exitedWallets);
  const parts: string[] = [];
  if (stats.joinedOrAddedWallets > 0) {
    parts.push(`${stats.joinedOrAddedWallets} wallets added`);
  }
  if (trimmedOnly > 0) parts.push(`${trimmedOnly} trimmed`);
  if (stats.exitedWallets > 0) parts.push(`${stats.exitedWallets} exited`);
  if (stats.stillHoldingWallets > 0) {
    parts.push(`${stats.stillHoldingWallets} still hold`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No major wallet change yet";
}

function formatSignalBotFollowthroughStatLines(input: {
  priceLine: string;
  stats: SignalBotFollowthroughStats;
}): string[] {
  const pnlLine =
    input.stats.estimatedOpenPnlUsd != null &&
    Math.abs(input.stats.estimatedOpenPnlUsd) >= 1
      ? `Est. open PnL: ${formatSignedCompactUsd(
          input.stats.estimatedOpenPnlUsd,
        )}`
      : null;
  return [
    `Net tracked flow: ${formatSignedCompactUsd(
      input.stats.netSignalSideFlowUsd,
    )}`,
    formatSignalBotFollowthroughActivityLine(input.stats),
    input.priceLine,
    ...(pnlLine ? [pnlLine] : []),
  ];
}

function formatSignalBotFollowthroughActivityMarkdownLines(
  stats: SignalBotFollowthroughStats,
): string[] {
  const trimmedOnly = Math.max(0, stats.trimmedWallets - stats.exitedWallets);
  const movement: string[] = [];
  if (stats.joinedOrAddedWallets > 0) {
    movement.push(
      `${formatTelegramBold(String(stats.joinedOrAddedWallets))} added`,
    );
  }
  if (trimmedOnly > 0) {
    movement.push(`${formatTelegramBold(String(trimmedOnly))} trimmed`);
  }
  if (stats.exitedWallets > 0) {
    movement.push(`${formatTelegramBold(String(stats.exitedWallets))} exited`);
  }
  const holding =
    stats.stillHoldingWallets > 0
      ? `${formatTelegramBold(String(stats.stillHoldingWallets))} holding`
      : null;
  const activity = [...movement, ...(holding ? [holding] : [])];
  return [
    `${escapeTelegramMarkdownV2("Wallets")}  ${
      activity.length > 0
        ? activity.join(" · ")
        : escapeTelegramMarkdownV2("No major change yet")
    }`,
  ];
}

function formatSignalBotFollowthroughStatBlock(input: {
  sideLabel: string;
  stats: SignalBotFollowthroughStats;
}): string {
  const displayedPriceMoveCents =
    input.stats.entryPrice != null && input.stats.markPrice != null
      ? Math.round(input.stats.markPrice * 100) -
        Math.round(input.stats.entryPrice * 100)
      : null;
  const priceLine =
    input.stats.entryPrice != null && input.stats.markPrice != null
      ? displayedPriceMoveCents === 0
        ? `${escapeTelegramMarkdownV2(
            `${input.sideLabel} price`,
          )}  ${formatTelegramBold(
            formatCents(input.stats.markPrice),
          )} ${escapeTelegramMarkdownV2("unchanged")}`
        : [
            escapeTelegramMarkdownV2(`${input.sideLabel} price`),
            `${formatCents(input.stats.entryPrice)} → ${formatCents(input.stats.markPrice)}`,
            formatTelegramBold(formatSignedCentsMove(displayedPriceMoveCents)),
          ].join("  ")
      : `${formatTelegramBold(input.sideLabel)} ${escapeTelegramMarkdownV2(
          "price move unavailable",
        )}`;
  const lines = [
    formatTelegramBold("Since the call"),
    "",
    `${escapeTelegramMarkdownV2("Net tracked flow")}  ${formatTelegramBold(
      formatSignedCompactUsd(input.stats.netSignalSideFlowUsd),
    )}`,
    ...formatSignalBotFollowthroughActivityMarkdownLines(input.stats),
    priceLine,
  ];
  if (
    input.stats.estimatedOpenPnlUsd != null &&
    Math.abs(input.stats.estimatedOpenPnlUsd) >= 1
  ) {
    lines.push(
      `${escapeTelegramMarkdownV2("Est. open PnL")}  ${formatTelegramBold(
        formatSignedCompactUsd(input.stats.estimatedOpenPnlUsd),
      )}`,
    );
  }
  return formatTelegramBlockquote(lines);
}

function formatSignalBotResolutionPrice(value: number | null): string {
  if (value == null) return "unavailable";
  if (value >= 0.999) return "$1.00";
  return formatCents(value);
}

function formatSignalBotResolutionBlock(input: {
  sideLabel: string;
  stats: SignalBotFollowthroughStats;
}): string {
  const lines = [formatTelegramBold("Result"), ""];
  if (input.stats.entryPrice != null) {
    lines.push(
      `${escapeTelegramMarkdownV2("Entry")}  ${formatTelegramBold(
        formatCents(input.stats.entryPrice),
      )}`,
    );
  }
  lines.push(
    `${escapeTelegramMarkdownV2("Resolution")}  ${formatTelegramBold(
      `${input.sideLabel} ${formatSignalBotResolutionPrice(input.stats.markPrice)}`,
    )}`,
  );
  if (input.stats.priceMoveCents != null) {
    lines.push(
      `${escapeTelegramMarkdownV2("Move")}  ${formatTelegramBold(
        formatSignedCentsMove(input.stats.priceMoveCents),
      )}`,
    );
  }
  return formatTelegramBlockquote(lines);
}

function buildSignalBotFollowthroughMessage(input: {
  candidate: SignalBotFollowthroughCandidateRow;
  deliveryRef?: string | null;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  stats: SignalBotFollowthroughStats;
  telegramMiniAppLinkBase?: string | null;
  copyPolicy?: ResolvedSignalPostCopyPolicy;
}): string {
  const stats = input.stats;
  const sideCopy = stats.signalSide
    ? buildSignalBotFollowthroughSideCopy(input.candidate, stats.signalSide)
    : null;
  const sideLabel = resolveSignalBotFollowthroughSideLabel(
    input.candidate,
    stats.signalSide,
    sideCopy,
  );
  const hasWalletEvidence =
    stats.joinedOrAddedWallets > 0 ||
    stats.netSignalSideFlowUsd !== 0 ||
    stats.trimmedWallets > 0 ||
    stats.exitedWallets > 0;
  const notificationCopy = buildSignalBotFollowthroughNotificationCopy(input);
  const header = formatSignalNotificationHeadlineMarkdown(
    notificationCopy.headline,
  );
  const marketStartParam = input.candidate.event_id
    ? buildSignalBotMarketStartParam({
        deliveryRef: input.deliveryRef,
        eventId: input.candidate.event_id,
        marketId: input.candidate.market_id,
        side: stats.signalSide,
      })
    : null;
  const marketMiniAppUrl = buildSignalBotMiniAppUrl({
    base: input.telegramMiniAppLinkBase,
    startParam: marketStartParam,
  });
  const footerLine = formatSignalBotFollowthroughReadMarkdown({
    hasWalletEvidence,
    kind: input.kind,
    marketUrl: marketMiniAppUrl,
    sideCopy,
    sideLabel,
    stats,
  });
  if (input.kind === "resolved_win" || input.kind === "resolved_loss") {
    return joinTelegramMessageBlocks([
      header,
      formatSignalBotResolutionBlock({ sideLabel, stats }),
    ]);
  }
  return joinTelegramMessageBlocks([
    header,
    formatSignalBotFollowthroughStatBlock({ sideLabel, stats }),
    `${formatTelegramBold("Read")}: ${footerLine}`,
    ...(!input.telegramMiniAppLinkBase
      ? [escapeTelegramMarkdownV2("Mini App temporarily unavailable.")]
      : []),
  ]);
}

function buildNeutralSignalFollowthroughView(input: {
  appBaseUrl: string;
  buyAmountUsd: number;
  candidate: SignalBotFollowthroughCandidateRow;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  replyToMessageId: number | null;
  stats: SignalBotFollowthroughStats;
  target: SignalBotCheaperAlternative | null;
  copyPolicy?: ResolvedSignalPostCopyPolicy;
}): SignalDeliveryView {
  const notificationCopy = buildSignalBotFollowthroughNotificationCopy(input);
  const target = input.target
    ? {
        eventId: input.target.eventId,
        marketId: input.target.marketId,
        price: input.target.price,
        side: input.target.side,
        tradeUrl: buildSignalBotTradeUrl({
          amountUsd: input.buyAmountUsd,
          appBaseUrl: input.appBaseUrl,
          eventId: input.target.eventId,
          marketId: input.target.marketId,
          side: input.target.side,
        }),
        venue: input.target.venue,
      }
    : null;
  const kind =
    input.kind === "resolved_win"
      ? "resolved-win"
      : input.kind === "resolved_loss"
        ? "resolved-loss"
        : "stats";
  return {
    contextLines: formatSignalBotFollowthroughStatLines({
      priceLine:
        input.stats.entryPrice != null && input.stats.markPrice != null
          ? `${formatCents(input.stats.entryPrice)} → ${formatCents(input.stats.markPrice)}`
          : "Price move unavailable",
      stats: input.stats,
    }),
    credentialLines: [],
    holder: null,
    kind,
    source: {
      eventId: input.candidate.event_id,
      marketId: input.candidate.market_id,
      side: input.stats.signalSide,
      venue: input.candidate.venue,
    },
    summary: formatSignalBotFollowthroughRead({
      hasWalletEvidence:
        input.stats.joinedOrAddedWallets > 0 ||
        input.stats.netSignalSideFlowUsd !== 0 ||
        input.stats.trimmedWallets > 0 ||
        input.stats.exitedWallets > 0,
      kind: input.kind,
      sideCopy: input.stats.signalSide
        ? buildSignalBotFollowthroughSideCopy(
            input.candidate,
            input.stats.signalSide,
          )
        : null,
      sideLabel:
        input.stats.signalSide == null
          ? "side"
          : buildSignalBotFollowthroughSideCopy(
              input.candidate,
              input.stats.signalSide,
            ).priceLabel,
      stats: input.stats,
    }),
    target,
    thread:
      input.replyToMessageId == null
        ? {}
        : { rootDeliveryId: String(input.replyToMessageId) },
    title: notificationCopy.headline.text,
  };
}

export async function publishSignalBotFollowthroughTick(input: {
  config: SignalBotConfig;
  db: DbQuery;
  now?: Date;
  redis: SignalBotRedisLike;
  telegram: SignalBotTelegramClient;
  transports?: readonly SignalTransport[];
}): Promise<{
  candidates: number;
  policyEnabled: boolean;
  sent: number;
  sentResolvedLoss: number;
  sentResolvedWin: number;
  sentStats: number;
  skipped: number;
}> {
  const policy = await resolveSignalBotFollowthroughPolicy(
    input.db,
    input.config.followthrough,
  );
  const copyPolicy = await resolveSignalPostCopyPolicy(input.db);
  if (!policy.enabled) {
    return {
      candidates: 0,
      policyEnabled: false,
      sent: 0,
      sentResolvedLoss: 0,
      sentResolvedWin: 0,
      sentStats: 0,
      skipped: 0,
    };
  }
  const telegramTransport =
    input.transports?.find((transport) => transport.kind === "telegram") ??
    createSignalBotTelegramTransport(input.telegram);
  const now = input.now ?? new Date();
  const chatIds = await input.redis.sMembers(CHAT_SET_KEY);
  const candidates = await loadSignalBotFollowthroughCandidates({
    chatIds,
    db: input.db,
    mode: "publish",
    now,
    policy,
  });
  const latestSnapshotMaxAgeMs = await resolveSignalBotLatestSnapshotMaxAgeMs(
    input.db,
  );
  let sent = 0;
  let sentResolvedLoss = 0;
  let sentResolvedWin = 0;
  let sentStats = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (sent >= policy.maxPerTick) break;
    const stats = await buildSignalBotFollowthroughStats({
      asOf: now,
      candidate,
      db: input.db,
      latestSnapshotMaxAgeMs,
    });
    const kind = resolveSignalBotFollowthroughKind({ policy, stats });
    const replyToMessageId = toInteger(candidate.reply_to_message_id);
    const baselineAt =
      candidate.baseline_at instanceof Date
        ? candidate.baseline_at.toISOString()
        : candidate.baseline_at;
    if (!kind) {
      if (stats.state === "open" && policy.types.includes("stats")) {
        await recordSignalBotFollowthroughSkipped({
          baselineAt,
          chatId: candidate.chat_id,
          db: input.db,
          metrics: {
            ...stats,
            nextEvaluateAt: new Date(
              now.getTime() + FOLLOWTHROUGH_RETRY_COOLDOWN_MS,
            ).toISOString(),
            status: "skipped",
          },
          noteId: candidate.thread_root_note_id,
          replyToMessageId,
          sentAt: now,
          threadRootNoteId: candidate.thread_root_note_id,
        });
      }
      skipped += 1;
      continue;
    }
    const reserved = await reserveSignalBotFollowthroughMessage({
      baselineAt,
      chatId: candidate.chat_id,
      db: input.db,
      messageKind: kind,
      noteId: candidate.thread_root_note_id,
      replyToMessageId,
      sentAt: now,
      threadRootNoteId: candidate.thread_root_note_id,
    });
    if (!reserved) {
      skipped += 1;
      continue;
    }
    const text = buildSignalBotFollowthroughMessage({
      candidate,
      deliveryRef: reserved,
      kind,
      stats,
      telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
      copyPolicy,
    });
    const copyAudit = buildSignalBotFollowthroughCopyAudit({
      candidate,
      kind,
      stats,
      copyPolicy,
    });
    const target = resolveSignalBotFollowthroughDeliveryTarget(candidate);
    const buyPrice = await resolveSignalBotFollowthroughBuyCtaPrice({
      db: input.db,
      redis: input.redis,
      stats,
      target,
    });
    const chatState = await getSignalBotChatState(
      input.redis,
      candidate.chat_id,
    );
    const keyboard = buildSignalBotFollowthroughKeyboard({
      allowBuyCta: buyPrice != null,
      appBaseUrl: input.config.appBaseUrl,
      buyPrice,
      buyAmountUsd: input.config.buyAmountUsd,
      candidate,
      chatType: chatState?.chatType,
      deliveryRef: reserved,
      kind,
      stats,
      target,
      telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
    });
    const deliveryView = buildNeutralSignalFollowthroughView({
      appBaseUrl: input.config.appBaseUrl,
      buyAmountUsd: input.config.buyAmountUsd,
      candidate,
      kind,
      replyToMessageId,
      stats,
      target,
      copyPolicy,
    });
    const result = await sendSignalBotViaTransport({
      payload: {
        ...telegramTransport.render(deliveryView),
        destinationId: candidate.chat_id,
        replyToDeliveryId:
          replyToMessageId == null ? undefined : String(replyToMessageId),
        telegram: {
          disableWebPagePreview: true,
          parseMode: "MarkdownV2",
          replyMarkup: keyboard,
        },
        text,
      },
      transport: telegramTransport,
    });
    if (!result.ok) {
      if (result.error === "blocked_or_missing") {
        await disableSignalBotChat(input.redis, candidate.chat_id);
      }
      await recordSignalBotMessage({
        baselineAt,
        chatId: candidate.chat_id,
        db: input.db,
        insertId: createSignalDeliveryRef(),
        messageId: null,
        messageKind: kind,
        metrics: {
          ...stats,
          copy: copyAudit,
          delivery: { view: deliveryView },
          error: result.error,
          status: "send_failed",
        },
        noteId: candidate.thread_root_note_id,
        replyToMessageId,
        threadRootNoteId: candidate.thread_root_note_id,
        sentAt: now,
      });
      skipped += 1;
      continue;
    }
    await recordSignalBotMessage({
      baselineAt,
      chatId: candidate.chat_id,
      db: input.db,
      insertId: createSignalDeliveryRef(),
      messageId: result.messageId,
      messageKind: kind,
      metrics: {
        ...stats,
        copy: copyAudit,
        delivery: { view: deliveryView },
        fallbackStandalone: result.fallbackStandalone,
        status: "sent",
      },
      noteId: candidate.thread_root_note_id,
      replyToMessageId: result.replyToMessageId,
      threadRootNoteId: candidate.thread_root_note_id,
      sentAt: now,
    });
    sent += 1;
    if (kind === "followthrough_stats") sentStats += 1;
    else if (kind === "resolved_win") sentResolvedWin += 1;
    else if (kind === "resolved_loss") sentResolvedLoss += 1;
  }
  return {
    candidates: candidates.length,
    policyEnabled: true,
    sent,
    sentResolvedLoss,
    sentResolvedWin,
    sentStats,
    skipped,
  };
}

export function buildSignalBotStatsReport(input: {
  buyAmountUsd: number;
  detail?: boolean;
  period: SignalBotStatsPeriod;
  result: HolderResearchPerformanceAuditResult;
}): string {
  const periodLabel = formatSignalBotStatsPeriodLabel(input.period);
  const overall = input.result.aggregates.overall;
  if (input.result.evaluated === 0 || overall.notes === 0) {
    return `No bot-eligible signals for ${periodLabel} yet.`;
  }

  const measuredSignals = overall.withEntry;
  const totalPnlUsd = overall.totalPnlPerDollar * input.buyAmountUsd;
  const totalStakeUsd = measuredSignals * input.buyAmountUsd;
  const roi = totalStakeUsd > 0 ? totalPnlUsd / totalStakeUsd : null;
  const knownResolved = overall.correct + overall.wrong;
  const resolvedLine =
    knownResolved > 0
      ? `🎯 Resolved: ${overall.correct}W / ${overall.wrong}L (${formatPercent(overall.correct / knownResolved)})`
      : "🎯 Resolved: not enough yet";
  const pnlLine =
    measuredSignals > 0
      ? `💰 $${input.buyAmountUsd} each: ${formatSignedUsd(totalPnlUsd)} (${formatSignedPercent(roi)})`
      : `💰 $${input.buyAmountUsd} each: waiting for price data`;
  const lines = [
    `📊 Hunch signals · ${periodLabel}`,
    "",
    pnlLine,
    resolvedLine,
    `📈 Marked up: ${overall.positive} · down: ${overall.negative}`,
    `⏳ Open: ${overall.open} · 🏁 Resolved: ${overall.resolved}`,
  ];

  if (input.detail) {
    const detailLines = buildSignalBotStatsDetailLines(input.result, {
      buyAmountUsd: input.buyAmountUsd,
    });
    if (detailLines.length > 0) {
      lines.push("", ...detailLines);
    }
  }

  lines.push("", "Open signals use current market marks.");
  return lines.join("\n");
}

function buildSignalBotStatsDetailLines(
  result: HolderResearchPerformanceAuditResult,
  input: { buyAmountUsd: number },
): string[] {
  const lines: string[] = ["Details"];
  const segmentLines = formatStatsAggregateGroup({
    amountUsd: input.buyAmountUsd,
    formatter: formatMarketSegmentLabel,
    group: result.aggregates.byMarketSegment,
    title: "By category",
  });
  if (segmentLines.length > 0) lines.push(...segmentLines);
  const typeLines = formatStatsAggregateGroup({
    amountUsd: input.buyAmountUsd,
    formatter: formatMarketTypeLabel,
    group: result.aggregates.byMarketType,
    title: "By market type",
  });
  if (typeLines.length > 0) lines.push(...typeLines);
  const bucketLines = formatStatsAggregateGroup({
    amountUsd: input.buyAmountUsd,
    formatter: formatStatsBucketLabel,
    group: result.aggregates.byBucket,
    title: "By setup",
  });
  if (bucketLines.length > 0) lines.push(...bucketLines);
  const actorLines = formatStatsAggregateGroup({
    amountUsd: input.buyAmountUsd,
    formatter: formatStatsActorLabel,
    group: result.aggregates.byActorMode,
    title: "By wallet read",
  });
  if (actorLines.length > 0) lines.push(...actorLines);
  return lines.length > 1 ? lines : [];
}

function formatStatsAggregateGroup(input: {
  amountUsd: number;
  formatter: (key: string) => string;
  group: Record<
    string,
    HolderResearchPerformanceAuditResult["aggregates"]["overall"]
  >;
  title: string;
}): string[] {
  const rows = Object.entries(input.group)
    .filter(([, aggregate]) => aggregate.notes > 0)
    .sort((left, right) => {
      const leftPnl = Math.abs(left[1].totalPnlPerDollar);
      const rightPnl = Math.abs(right[1].totalPnlPerDollar);
      if (leftPnl !== rightPnl) return rightPnl - leftPnl;
      return right[1].notes - left[1].notes;
    })
    .slice(0, 4);
  if (rows.length === 0) return [];
  return [
    input.title,
    ...rows.map(([key, aggregate]) => {
      const pnlUsd = aggregate.totalPnlPerDollar * input.amountUsd;
      const knownResolved = aggregate.correct + aggregate.wrong;
      const resolved =
        knownResolved > 0
          ? `${aggregate.correct}W / ${aggregate.wrong}L`
          : "open only";
      return `• ${input.formatter(key)}: ${formatSignedUsd(pnlUsd)} · ${resolved} · ${aggregate.notes} signals`;
    }),
  ];
}

function formatStatsBucketLabel(value: string): string {
  switch (value) {
    case "followup_existing":
      return "Follow-ups";
    case "sharp_side":
      return "Strong same-side wallets";
    case "sharp_minority":
      return "Minority wallet reads";
    case "sharp_split":
      return "Split strong wallets";
    case "clean_disagreement":
      return "Clean disagreement";
    case "recent_flow":
      return "Recent flow";
    case "event_bridge":
      return "Event bridge";
    case "concentration_risk":
      return "Concentration risk";
    case "unknown":
      return "Unknown setup";
    default:
      return value.replace(/_/g, " ");
  }
}

function formatStatsActorLabel(value: string): string {
  switch (value) {
    case "sharp_cluster":
      return "Wallet clusters";
    case "single_holder":
      return "Single wallets";
    case "none":
      return "No clear wallet";
    case "unknown":
      return "Unknown read";
    default:
      return value.replace(/_/g, " ");
  }
}

export async function sendSignalBotStatsReport(input: {
  chatId: string;
  config: SignalBotConfig;
  db: DbQuery;
  detail?: boolean;
  period: SignalBotStatsPeriod;
  telegram: SignalBotTelegramClient;
}): Promise<boolean> {
  const result = await auditHolderResearchSignalPerformance(input.db, {
    deliveredInitialOnly: true,
    activeOnly: false,
    approxEntryAfterHours: HOLDER_RESEARCH_PERFORMANCE_APPROX_ENTRY_AFTER_HOURS,
    approxEntryBeforeHours:
      HOLDER_RESEARCH_PERFORMANCE_APPROX_ENTRY_BEFORE_HOURS,
    directionalOnly: true,
    includeOpen: true,
    includeResolved: true,
    limit: SIGNAL_BOT_STATS_AUDIT_LIMIT,
    lookbackHours: signalBotStatsPeriodHours(input.period),
    persist: false,
  });
  const message = buildSignalBotStatsReport({
    buyAmountUsd: input.config.buyAmountUsd,
    detail: input.detail ?? false,
    period: input.period,
    result,
  });
  const sendResult = await input.telegram.sendMessage(
    buildPlainReply(input.chatId, message),
  );
  return sendResult.ok;
}

export async function loadSignalBotNotes(
  db: DbQuery,
  input: {
    afterCreatedAt: string;
    afterId: string;
    descending?: boolean;
    limit: number;
    noteId?: string | null;
    revisionKind?: "initial" | "research_update" | null;
  },
): Promise<SignalBotNote[]> {
  const order = input.descending ? "desc" : "asc";
  const comparison = input.descending ? "<" : ">";
  const { rows } = await db.query<SignalBotNoteRow>(
    `
      select
        n.id,
        n.note_key,
        n.title,
        n.description,
        n.rationale,
        n.producer_run_id,
        n.direction,
        n.confidence,
        n.model_meta,
        n.metrics,
        n.created_at::text as created_at,
        coalesce(nullif(n.lineage->>'revision_kind', ''), 'initial')
          as revision_kind,
        coalesce(
          nullif(n.lineage->>'thesis_key', ''),
          'holder_research:v2:' || n.source_id || ':' || upper(coalesce(
            nullif(n.lineage->>'side', ''),
            nullif(pt.target_meta->>'side', ''),
            'MIXED'
          ))
        ) as thesis_key,
        coalesce(nullif(n.lineage->>'thesis_root_note_id', ''), n.id::text)
          as thesis_root_note_id,
        pt.target_meta as primary_target_meta,
        m.id as market_id,
        m.event_id,
        m.venue as market_venue,
        m.title as market_title,
        m.slug as market_slug,
        m.description as market_description,
        m.metadata as market_metadata,
        e.title as event_title,
        e.description as event_description,
        m.category,
        e.category as event_category,
        e.series_key,
        e.series_title,
        m.close_time,
        m.expiration_time,
        m.outcomes,
        nullif(
          coalesce(
            nullif(m.metadata->>'resolutionSource', ''),
            nullif(e.metadata->>'resolutionSource', '')
          ),
          ''
        ) as resolution_source,
        coalesce(
          n.metrics #>> '{quality,marketSegment}',
          n.metrics #>> '{signalPerformance,marketSegment}',
          n.metrics #>> '{resolvedEvaluation,marketSegment}'
        ) as market_segment,
        m.best_bid,
        m.best_ask,
        m.last_price,
        holder.address as holder_address,
        holder.chain as holder_chain,
        holder.wallet_id as holder_wallet_id,
        holder.target_meta as holder_target_meta
      from ai_notes n
      join ai_note_targets pt
        on pt.note_id = n.id
       and pt.is_primary = true
       and pt.target_kind = 'market'
      join unified_markets m on m.id = pt.target_id
      left join unified_events e on e.id = m.event_id
      left join lateral (
        select
          t.target_id::text as wallet_id,
          w.address,
          w.chain,
          t.target_meta
        from ai_note_targets t
        join wallets w on w.id = t.target_id::uuid
        where t.note_id = n.id
          and t.target_kind = 'wallet'
        order by t.target_rank asc, t.target_id asc
        limit 1
      ) holder on true
      where n.note_type = 'signal'
        and n.status = 'active'
        and n.producer_type = 'holder_research'
        and n.direction in ('up', 'down')
        and ${HOLDER_RESEARCH_PUBLICATION_DECISION_SQL}
        and ($4::uuid is null or n.id = $4::uuid)
        and (
          $5::text is null
          or coalesce(nullif(n.lineage->>'revision_kind', ''), 'initial') = $5
        )
        and (
          n.created_at ${comparison} $1::timestamptz
          or (n.created_at = $1::timestamptz and n.id ${comparison} $2::uuid)
        )
      order by n.created_at ${order}, n.id ${order}
      limit $3
    `,
    [
      input.afterCreatedAt,
      input.afterId,
      input.limit,
      input.noteId ?? null,
      input.revisionKind ?? null,
    ],
  );
  return rows.map(rowToSignalBotNote);
}

async function loadSignalBotEligibilityCounts(
  db: DbQuery,
  input: {
    afterCreatedAt: string;
    afterId: string;
  },
): Promise<{
  nonDirectional: number;
  publishNotesSeen: number;
  total: number;
}> {
  const { rows } = await db.query<SignalBotEligibilityCountRow>(
    `
      select
        count(*) filter (
          where n.direction in ('up', 'down')
        )::int as publish_notes_seen,
        count(*) filter (
          where n.direction is null
             or n.direction not in ('up', 'down')
        )::int as non_directional,
        count(*)::int as total
      from ai_notes n
      join ai_note_targets pt
        on pt.note_id = n.id
       and pt.is_primary = true
       and pt.target_kind = 'market'
      where n.note_type = 'signal'
        and n.status = 'active'
        and n.producer_type = 'holder_research'
        and ${HOLDER_RESEARCH_PUBLICATION_DECISION_SQL}
        and (
          n.created_at > $1::timestamptz
          or (n.created_at = $1::timestamptz and n.id > $2::uuid)
        )
    `,
    [input.afterCreatedAt, input.afterId],
  );
  const row = rows[0];
  return {
    nonDirectional: Math.max(
      0,
      Math.trunc(toNumber(row?.non_directional) ?? 0),
    ),
    publishNotesSeen: Math.max(
      0,
      Math.trunc(toNumber(row?.publish_notes_seen) ?? 0),
    ),
    total: Math.max(0, Math.trunc(toNumber(row?.total) ?? 0)),
  };
}

export class TelegramBotApiClient implements SignalBotTelegramClient {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async callBooleanMethod(
    method: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(this.baseUrl + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as {
      description?: string;
      ok?: boolean;
      result?: boolean;
    } | null;
    if (!response.ok || !payload?.ok || payload.result !== true) {
      throw new Error(
        "Telegram " +
          method +
          " failed: " +
          response.status +
          " " +
          (payload?.description ?? ""),
      );
    }
  }

  async setMyCommands(input: {
    commands: TelegramBotCommandDefinition[];
    scope?: TelegramBotCommandScope;
  }): Promise<void> {
    await this.callBooleanMethod("setMyCommands", input);
  }

  async getMyCommands(
    input: {
      scope?: TelegramBotCommandScope;
    } = {},
  ): Promise<TelegramBotCommandDefinition[]> {
    const response = await fetch(this.baseUrl + "/getMyCommands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => null)) as {
      description?: string;
      ok?: boolean;
      result?: TelegramBotCommandDefinition[];
    } | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.result)) {
      throw new Error(
        "Telegram getMyCommands failed: " +
          response.status +
          " " +
          (payload?.description ?? ""),
      );
    }
    return payload.result;
  }

  async setChatMenuButton(input: {
    chat_id?: number | string;
    menu_button: TelegramBotMenuButton;
  }): Promise<void> {
    await this.callBooleanMethod("setChatMenuButton", input);
  }

  async getMe(): Promise<TelegramBotUser> {
    const response = await fetch(`${this.baseUrl}/getMe`);
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: TelegramBotUser;
      description?: string;
    } | null;
    if (!response.ok || !payload?.ok || !payload.result) {
      throw new Error(
        `Telegram getMe failed: ${response.status} ${payload?.description ?? ""}`.trim(),
      );
    }
    return payload.result;
  }

  async getUpdates(input: {
    offset: number | null;
    timeoutSec: number;
  }): Promise<TelegramBotUpdate[]> {
    const url = new URL(`${this.baseUrl}/getUpdates`);
    url.searchParams.set("timeout", String(input.timeoutSec));
    url.searchParams.set(
      "allowed_updates",
      JSON.stringify(["message", "callback_query"]),
    );
    if (input.offset != null)
      url.searchParams.set("offset", String(input.offset));
    const response = await fetch(url);
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: TelegramBotUpdate[];
      description?: string;
    } | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.result)) {
      throw new Error(
        `Telegram getUpdates failed: ${response.status} ${payload?.description ?? ""}`.trim(),
      );
    }
    return payload.result;
  }

  async answerCallbackQuery(input: {
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: input.callbackQueryId,
        show_alert: input.showAlert ?? false,
        text: input.text,
      }),
    });
    return response.json().catch(() => null);
  }

  async editMessageText(input: {
    chat_id: string;
    disable_web_page_preview: boolean;
    message_id: number;
    parse_mode: "MarkdownV2";
    reply_markup?: TelegramInlineKeyboard;
    text: string;
  }): Promise<TelegramSendResult> {
    const response = await fetch(`${this.baseUrl}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => null)) as {
      description?: string;
      ok?: boolean;
      result?: { message_id?: number };
    } | null;
    if (response.ok && payload?.ok) {
      const messageId = payload.result?.message_id;
      return {
        messageId: typeof messageId === "number" ? messageId : input.message_id,
        ok: true,
      };
    }
    return {
      error: "other",
      message: payload?.description ?? `HTTP ${response.status}`,
      ok: false,
    };
  }

  async sendPhoto(input: {
    caption?: string;
    chat_id: string;
    filename: string;
    parse_mode?: "MarkdownV2";
    photo: Uint8Array;
    reply_markup?: TelegramInlineKeyboard;
  }): Promise<TelegramSendResult> {
    return sendTelegramPhotoRequest({
      baseUrl: this.baseUrl,
      caption: input.caption,
      chatId: input.chat_id,
      filename: input.filename,
      parseMode: input.parse_mode,
      photo: input.photo,
      replyMarkup: input.reply_markup,
    });
  }

  async sendMessage(
    input: TelegramSendMessageInput,
  ): Promise<TelegramSendResult> {
    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => null)) as {
      description?: string;
      ok?: boolean;
      parameters?: { retry_after?: number };
      result?: { message_id?: number };
    } | null;
    if (response.ok && payload?.ok) {
      const messageId = payload.result?.message_id;
      return {
        messageId: typeof messageId === "number" ? messageId : null,
        ok: true,
      };
    }
    const message = payload?.description ?? `HTTP ${response.status}`;
    if (
      response.status === 403 ||
      /chat not found|bot was blocked|user is deactivated/i.test(message)
    ) {
      return { error: "blocked_or_missing", message, ok: false };
    }
    const retryAfterSec = payload?.parameters?.retry_after;
    return {
      error: "other",
      message,
      ok: false,
      retryAfterSec:
        typeof retryAfterSec === "number" && retryAfterSec > 0
          ? Math.trunc(retryAfterSec)
          : undefined,
    };
  }
}

export async function configureSignalBotTelegramUi(input: {
  config: SignalBotConfig;
  telegram: Pick<TelegramBotApiClient, "setChatMenuButton" | "setMyCommands">;
}): Promise<{
  configured: number;
  failures: Array<{ error: string; operation: string }>;
}> {
  const publicCommands: TelegramBotCommandDefinition[] = [
    { command: "start", description: "Open Hunch menu" },
    { command: "menu", description: "Open Hunch menu" },
    { command: "settings", description: "Notification settings" },
    { command: "help", description: "How Hunch works" },
  ];
  const adminCommands: TelegramBotCommandDefinition[] = [
    ...publicCommands,
    { command: "status", description: "Show signal delivery status" },
    { command: "stats", description: "Show signal performance" },
    { command: "enable_signals", description: "Enable signal delivery" },
    { command: "disable_signals", description: "Disable signal delivery" },
    { command: "signal_venues", description: "Set destination venues" },
    { command: "test_signal", description: "Preview latest signal" },
    { command: "test_followthrough", description: "Preview follow-through" },
    { command: "test_trade", description: "Preview a trade card" },
  ];
  const failures: Array<{ error: string; operation: string }> = [];
  let configured = 0;
  const attempt = async (
    operation: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    try {
      await action();
      configured += 1;
    } catch (error) {
      failures.push({
        error: error instanceof Error ? error.message : String(error),
        operation,
      });
    }
  };

  await attempt("commands:private", () =>
    input.telegram.setMyCommands({
      commands: publicCommands,
      scope: { type: "all_private_chats" },
    }),
  );
  for (const adminUserId of [...input.config.adminUserIds].sort(
    (a, b) => a - b,
  )) {
    await attempt(`commands:admin:${adminUserId}`, () =>
      input.telegram.setMyCommands({
        commands: adminCommands,
        scope: { chat_id: adminUserId, type: "chat" },
      }),
    );
  }
  const menuButton = buildHunchMiniAppWebButton({
    appBaseUrl: input.config.appBaseUrl,
    enabled: input.config.telegramMiniAppLinkBase != null,
    path: SIGNAL_BOT_TELEGRAM_WEB_APP_ENTRY_PATH,
    text: "Open Hunch",
  });
  await attempt("menu-button:default", () =>
    input.telegram.setChatMenuButton({
      menu_button:
        menuButton && "web_app" in menuButton
          ? {
              text: menuButton.text,
              type: "web_app",
              web_app: menuButton.web_app,
            }
          : { type: "commands" },
    }),
  );
  return { configured, failures };
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const asInt = Math.trunc(parsed);
  return asInt > 0 ? asInt : fallback;
}

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const asInt = Math.trunc(parsed);
  return asInt >= 0 ? asInt : fallback;
}

function parseIntegerList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry))
    .map((entry) => Math.trunc(entry));
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "https://app.hunch.trade";
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed == null) return null;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .slice(0, maxItems);
}

function resolveSignalBotResearchDelta(
  note: SignalBotNote,
  side: "NO" | "YES" | null,
): SignalBotResearchDelta | null {
  const contract = note.holderResearchUpdateV1;
  if (
    note.revisionKind !== "research_update" ||
    !side ||
    !contract ||
    contract.selectedSide !== side
  ) {
    return null;
  }
  const reason = contract.primaryReason;
  if (
    reason.kind === "price_moved_with_thesis" ||
    reason.kind === "price_moved_against_thesis"
  ) {
    return {
      currentPrice: reason.after,
      kind: "price_move",
      priceMoveCents: reason.delta * 100,
      supportsBuy: contract.ctaIntent === "buy",
    };
  }
  if (
    reason.kind === "position_increased" ||
    reason.kind === "position_reduced"
  ) {
    return {
      afterUsd: reason.after,
      beforeUsd: reason.before,
      kind: "position_change",
      positionChangeUsd: reason.delta,
      scope: reason.scope,
      supportsBuy: contract.ctaIntent === "buy",
      walletId: reason.walletId,
    };
  }
  if (reason.kind === "wallet_confluence_changed") {
    return {
      afterWallets: reason.after,
      beforeWallets: reason.before,
      kind: "wallet_count_change",
      supportsBuy: contract.ctaIntent === "buy",
      walletChange: reason.delta,
    };
  }
  return null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToSignalBotNote(row: SignalBotNoteRow): SignalBotNote {
  const holderMeta = asObject(row.holder_target_meta);
  const metrics = asObject(row.metrics);
  const holderSide = String(holderMeta.side ?? "").toUpperCase();
  const holderActorMode = String(holderMeta.actorMode ?? "");
  const marketSegment =
    row.market_segment ??
    classifyMarketSegment({
      category: row.category ?? row.event_category,
      closeTime: row.close_time,
      eventTitle: row.event_title,
      expirationTime: row.expiration_time,
      marketTitle: row.market_title,
      seriesKey: row.series_key,
      seriesTitle: row.series_title,
    });
  return {
    id: row.id,
    noteKey: row.note_key,
    title: row.title,
    description: row.description,
    rationale: row.rationale,
    producerRunId: row.producer_run_id,
    direction: row.direction,
    confidence: toNumber(row.confidence),
    modelMeta: asObject(row.model_meta),
    metrics,
    holderResearchUpdateV1: parseHolderResearchUpdateV1(
      metrics.holderResearchUpdateV1,
    ),
    signalPriceSnapshotV1: parseSignalPriceSnapshotV1(
      metrics.signalPriceSnapshotV1,
    ),
    telegramMarketIdentityV1: parseTelegramMarketIdentityV1(
      metrics.telegramMarketIdentityV1,
    ),
    createdAt: toIso(row.created_at),
    revisionKind:
      row.revision_kind === "research_update" ? "research_update" : "initial",
    meaningfulDeltaReasons: asStringArray(row.meaningful_delta_reasons, 20),
    decisionSnapshot: row.decision_snapshot,
    previousDecisionSnapshot: row.previous_decision_snapshot,
    thesisKey:
      row.thesis_key ?? `holder_research:v2:${row.market_id ?? row.id}:MIXED`,
    thesisRootNoteId: row.thesis_root_note_id ?? row.id,
    primaryTargetMeta: asObject(row.primary_target_meta),
    marketId: row.market_id,
    eventId: row.event_id,
    marketVenue: row.market_venue,
    marketTitle: row.market_title,
    marketSlug: row.market_slug,
    marketDescription: row.market_description,
    marketMetadata: row.market_metadata,
    eventTitle: row.event_title,
    eventDescription: row.event_description,
    outcomes: parseMarketOutcomes(row.outcomes),
    resolutionSource: row.resolution_source,
    marketSegment,
    closeTime: row.close_time ? toIso(row.close_time) : null,
    expirationTime: row.expiration_time ? toIso(row.expiration_time) : null,
    bestBid: toNumber(row.best_bid),
    bestAsk: toNumber(row.best_ask),
    lastPrice: toNumber(row.last_price),
    holderAddress: row.holder_address,
    holderChain: row.holder_chain,
    holderWalletId: row.holder_wallet_id,
    holderDisplayName: asTrimmedString(holderMeta.holderDescriptor),
    holderIdentityDisplayName: asTrimmedString(holderMeta.identityDisplayName),
    holderOpenPnlUsd: toNumber(holderMeta.openPnlUsd),
    holderPositionUsd: toNumber(holderMeta.positionUsd),
    holderSide: holderSide === "YES" || holderSide === "NO" ? holderSide : null,
    holderActorMode:
      holderActorMode === "single_holder" || holderActorMode === "sharp_cluster"
        ? holderActorMode
        : holderActorMode === "none"
          ? "none"
          : null,
    holderCredentialBullets: asStringArray(holderMeta.credentialBullets, 3),
    holderClusterPnl30dUsd: toNumber(holderMeta.clusterPnl30dUsd),
    holderClusterSharpHolders: toNumber(holderMeta.clusterSharpHolders),
    holderClusterSharpUsd: toNumber(holderMeta.clusterSharpUsd),
  };
}

function normalizeProbability(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function resolveSignalBotBuyPrice(
  note: Pick<
    SignalBotNote,
    "bestAsk" | "bestBid" | "lastPrice" | "signalPriceSnapshotV1"
  >,
  side: "NO" | "YES",
): number | null {
  const strict = note.signalPriceSnapshotV1;
  if (strict?.displaySide === side) return strict[side].ask;
  const bid = normalizeProbability(note.bestBid);
  const ask = normalizeProbability(note.bestAsk);
  const last = normalizeProbability(note.lastPrice);
  const midpoint = bid != null && ask != null ? (bid + ask) / 2 : last;
  return side === "YES"
    ? (ask ?? midpoint ?? bid)
    : bid != null
      ? 1 - bid
      : midpoint == null
        ? null
        : 1 - midpoint;
}

function resolveSignalBotDisplayPrice(
  note: Pick<
    SignalBotNote,
    "bestAsk" | "bestBid" | "lastPrice" | "signalPriceSnapshotV1"
  >,
  side: "NO" | "YES",
): number | null {
  const strict = note.signalPriceSnapshotV1;
  if (strict?.displaySide === side) return strict.displayPrice;
  const bid = normalizeProbability(note.bestBid);
  const ask = normalizeProbability(note.bestAsk);
  const last = normalizeProbability(note.lastPrice);
  const yesMark = bid != null && ask != null ? (bid + ask) / 2 : last;
  return side === "YES" ? yesMark : yesMark == null ? null : 1 - yesMark;
}

function formatCents(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}¢`;
}

type SignalBotMarketCopySource = {
  eventDescription?: string | null;
  eventTitle?: string | null;
  marketDescription?: string | null;
  marketSegment?: string | null;
  marketSlug?: string | null;
  marketTitle?: string | null;
  outcomes?: unknown;
  resolutionSource?: string | null;
};

function buildSignalBotSideCopy(
  note: SignalBotMarketCopySource,
  side: "NO" | "YES",
): MarketSideCopy {
  return buildMarketSideCopy({
    eventDescription: note.eventDescription,
    eventTitle: note.eventTitle,
    marketDescription: note.marketDescription,
    marketSegment: note.marketSegment,
    marketSlug: note.marketSlug,
    marketTitle: note.marketTitle,
    outcomes: note.outcomes,
    resolutionSource: note.resolutionSource,
    side,
  });
}

function resolveSignalBotCurrentSideLabel(input: {
  presentation: ReturnType<
    typeof resolvePersistedOrCurrentTelegramMarketPresentation
  >;
  side: "NO" | "YES";
  sideCopy: MarketSideCopy | null;
}): string {
  if (input.sideCopy?.copyKind === "team_yes_no") {
    const semantic = input.sideCopy.plainPosition
      .replace(/^backing\s+/i, "")
      .replace(/^fading\s+/i, "against ")
      .trim();
    if (semantic && !/^(?:against\s+)?[↑↓]/.test(semantic)) return semantic;
  }
  const canonical = cleanPublicMarketText(
    input.presentation.positions[input.side].canonicalLabel,
  );
  if (canonical && canonical.toUpperCase() !== input.side) return canonical;
  return input.sideCopy?.priceLabel ?? input.side;
}

function buildSignalBotFollowthroughSideCopy(
  candidate: SignalBotFollowthroughCandidateRow,
  side: "NO" | "YES",
): MarketSideCopy {
  return buildSignalBotSideCopy(
    {
      eventDescription: candidate.event_description,
      eventTitle: candidate.event_title,
      marketDescription: candidate.market_description,
      marketSlug: candidate.market_slug,
      marketTitle: candidate.market_title,
      outcomes: candidate.outcomes,
      resolutionSource: candidate.resolution_source,
    },
    side,
  );
}

function resolveSignalBotFollowthroughIdentity(
  candidate: SignalBotFollowthroughCandidateRow,
): TelegramMarketIdentityV1 | null {
  const rootMetrics = asObject(candidate.root_metrics);
  const rootCopy = asObject(rootMetrics.copy);
  return (
    parseTelegramMarketIdentityV1(rootCopy.marketIdentity) ??
    parseTelegramMarketIdentityV1(rootMetrics.telegramMarketIdentityV1)
  );
}

function resolveSignalBotFollowthroughSideLabel(
  candidate: SignalBotFollowthroughCandidateRow,
  side: "NO" | "YES" | null,
  sideCopy: MarketSideCopy | null,
): string {
  if (!side) return "side";
  const identity = resolveSignalBotFollowthroughIdentity(candidate);
  if (identity?.selectedSide === side) {
    const lineLabel = identity.marketGroupItemTitle?.trim() ?? "";
    if (
      lineLabel.length > 0 &&
      lineLabel.length <= 48 &&
      /(?:\([+-]?\d+(?:\.\d+)?\)|\b[+-]\d+(?:\.\d+)?\b)/i.test(lineLabel)
    ) {
      return cleanPublicMarketText(lineLabel) ?? lineLabel;
    }
    const selectedLabel = cleanPublicMarketText(identity.selectedSideLabel);
    if (selectedLabel && selectedLabel.toUpperCase() !== side) {
      return selectedLabel;
    }
  }
  return sideCopy?.priceLabel ?? side;
}

function fallbackSignalNotificationSubject(
  title: string,
): SignalNotificationSubject {
  return {
    preservedFields: ["predicate"],
    source: "safe_full_title",
    text: cleanPublicMarketText(title) ?? "This market",
    version: "signal_notification_subject_v3",
  };
}

function matchupOutcomeSubject(
  selectedLabel: string,
  context: string | null | undefined,
  marketTitle?: string | null,
): string | null {
  if (!context?.trim()) return null;
  const matchup = context.split(/\s+(?:vs\.?|v\.?)\s+/i);
  if (matchup.length === 2) {
    const normalizeParticipant = (value: string) =>
      value
        .replace(/^.*:\s*/, "")
        .replace(/\s+\([^)]*\).*$/, "")
        .replace(/\s+[—-]\s+.*$/, "")
        .trim();
    const [leftRaw, rightRaw] = matchup;
    const left = normalizeParticipant(leftRaw ?? "");
    const right = normalizeParticipant(rightRaw ?? "");
    const labelKey = selectedLabel.toLocaleLowerCase("en-US");
    const leftKey = left.toLocaleLowerCase("en-US");
    const rightKey = right.toLocaleLowerCase("en-US");
    const matchupLabel =
      leftKey === labelKey || leftKey.endsWith(` ${labelKey}`)
        ? right
          ? `${selectedLabel} over ${right}`
          : selectedLabel
        : rightKey === labelKey || rightKey.startsWith(`${labelKey} `)
          ? left
            ? `${selectedLabel} over ${left}`
            : selectedLabel
          : null;
    if (matchupLabel) {
      const child = marketTitle
        ?.trim()
        .replace(/\s+winner[?]?$/i, "")
        .trim();
      return child && /^(?:game|map|round|set)\b/i.test(child)
        ? `${matchupLabel} in ${child}`
        : matchupLabel;
    }
  }
  return null;
}

function persistedNamedOutcomeSubject(
  identity: TelegramMarketIdentityV1,
): string {
  const selectedLabel =
    cleanPublicMarketText(identity.selectedSideLabel) ??
    identity.selectedSideLabel.trim();
  const eventTitle = cleanPublicMarketText(identity.eventTitle);
  const subject = cleanPublicMarketText(identity.subject) ?? identity.subject;
  const predicate =
    cleanPublicMarketText(identity.predicate) ?? identity.predicate;
  const groupItemTitle = cleanPublicMarketText(identity.marketGroupItemTitle);
  const matchup = matchupOutcomeSubject(
    selectedLabel,
    eventTitle ?? subject,
    groupItemTitle,
  );
  if (matchup) return matchup;
  const subjectKey = subject.toLocaleLowerCase("en-US");
  const labelKey = selectedLabel.toLocaleLowerCase("en-US");
  if (subjectKey === labelKey && predicate !== subject) {
    return predicate;
  }
  return subjectKey.includes(labelKey)
    ? subject
    : `${selectedLabel} in ${subject}`;
}

function persistedSignalNotificationSubject(
  note: SignalBotNote,
  side: "NO" | "YES",
): SignalNotificationSubject | null {
  return signalNotificationSubjectFromIdentity(
    note.telegramMarketIdentityV1 ?? null,
    side,
  );
}

function signalNotificationSubjectFromIdentity(
  identity: TelegramMarketIdentityV1 | null,
  side: "NO" | "YES",
): SignalNotificationSubject | null {
  if (!identity || identity.selectedSide !== side) return null;
  const selectedLabel = identity.selectedSideLabel.trim();
  if (selectedLabel.toUpperCase() === side) return null;
  return {
    preservedFields: ["predicate", "outcome", "threshold", "deadline"],
    source: "canonical_market_presentation",
    text: persistedNamedOutcomeSubject(identity),
    version: "signal_notification_subject_v3",
  };
}

function buildSignalBotInitialNotificationCopy(input: {
  copyPolicy?: ResolvedSignalPostCopyPolicy;
  messageKind: "initial" | "research_update";
  note: SignalBotNote;
  side: "NO" | "YES" | null;
}): {
  headline: SignalNotificationHeadline;
  publishable: boolean;
  researchDelta: SignalBotResearchDelta | null;
  subject: SignalNotificationSubject;
} {
  const sideCopy = input.side
    ? buildSignalBotSideCopy(input.note, input.side)
    : null;
  const presentation = resolvePersistedOrCurrentTelegramMarketPresentation(
    input.note,
  );
  const subject =
    input.side && sideCopy
      ? (persistedSignalNotificationSubject(input.note, input.side) ??
        buildSignalNotificationSubject({
          eventTitle: input.note.eventTitle,
          marketTitle: input.note.marketTitle,
          side: input.side,
          sideCopy,
          presentation,
        }))
      : fallbackSignalNotificationSubject(
          input.note.marketTitle ?? input.note.eventTitle ?? "This market",
        );
  const researchDelta =
    input.messageKind === "research_update"
      ? resolveSignalBotResearchDelta(input.note, input.side)
      : null;
  const headlineTrackRecord = resolvePersistedSignalEvidence(input.note).find(
    (row) =>
      row.kind === "track_record" &&
      row.quality === "verified" &&
      row.measurement.kind === "scalar" &&
      row.measurement.unit === "usd" &&
      row.measurement.value > 0 &&
      row.horizonDays != null &&
      row.horizonDays > 0,
  );
  const headlineTrackRecordValue =
    headlineTrackRecord?.measurement.kind === "scalar"
      ? headlineTrackRecord.measurement.value
      : null;
  return {
    headline: buildSignalNotificationHeadline({
      actorPnlEvidenceId: headlineTrackRecord?.id ?? null,
      actorPnlHorizonDays: headlineTrackRecord?.horizonDays ?? null,
      actorPnlUsd: headlineTrackRecordValue,
      actorMode: input.note.holderActorMode,
      currentPrice: input.side
        ? resolveSignalBotDisplayPrice(input.note, input.side)
        : null,
      holderPositionUsd:
        input.note.holderActorMode === "sharp_cluster"
          ? input.note.holderClusterSharpUsd
          : input.note.holderPositionUsd,
      kind: input.messageKind,
      positionLabel:
        sideCopy?.copyKind === "named_outcome" &&
        !subject.text
          .toLocaleLowerCase("en-US")
          .includes(sideCopy.sideLabel.toLocaleLowerCase("en-US"))
          ? (matchupOutcomeSubject(
              sideCopy.sideLabel,
              input.note.eventTitle,
              input.note.marketTitle,
            ) ?? sideCopy.sideLabel)
          : subject.text,
      researchDelta,
      strongWallets: input.note.holderClusterSharpHolders,
      subject,
      policy: input.copyPolicy?.policy,
    }),
    publishable: input.messageKind === "initial" || researchDelta != null,
    researchDelta,
    subject,
  };
}

function buildSignalBotFollowthroughNotificationCopy(input: {
  candidate: SignalBotFollowthroughCandidateRow;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  stats: SignalBotFollowthroughStats;
  copyPolicy?: ResolvedSignalPostCopyPolicy;
}): {
  headline: SignalNotificationHeadline;
  subject: SignalNotificationSubject;
} {
  const sideCopy = input.stats.signalSide
    ? buildSignalBotFollowthroughSideCopy(
        input.candidate,
        input.stats.signalSide,
      )
    : null;
  const presentation = resolvePersistedOrCurrentTelegramMarketPresentation({
    eventDescription: input.candidate.event_description,
    eventTitle: input.candidate.event_title,
    marketDescription: input.candidate.market_description,
    marketSlug: input.candidate.market_slug,
    marketTitle: input.candidate.market_title,
    outcomes: input.candidate.outcomes,
    resolutionSource: input.candidate.resolution_source,
    metrics: asObject(input.candidate.root_metrics),
  });
  const persistedIdentity = resolveSignalBotFollowthroughIdentity(
    input.candidate,
  );
  const subject =
    input.stats.signalSide && sideCopy
      ? (signalNotificationSubjectFromIdentity(
          persistedIdentity,
          input.stats.signalSide,
        ) ??
        buildSignalNotificationSubject({
          eventTitle: input.candidate.event_title,
          marketTitle: input.candidate.market_title,
          side: input.stats.signalSide,
          sideCopy,
          presentation,
        }))
      : fallbackSignalNotificationSubject(
          input.candidate.market_title ??
            input.candidate.event_title ??
            "This market",
        );
  return {
    headline: buildSignalNotificationHeadline({
      cooling: isSignalBotFollowthroughCooling(input.stats),
      currentPrice: input.stats.markPrice,
      exitedWallets: input.stats.exitedWallets,
      joinedWallets: input.stats.joinedOrAddedWallets,
      kind: input.kind === "followthrough_stats" ? "stats" : input.kind,
      netCopyFlowUsd: input.stats.netSignalSideFlowUsd,
      priceMoveCents: input.stats.priceMoveCents,
      subject,
      trimmedWallets: input.stats.trimmedWallets,
      policy: input.copyPolicy?.policy,
    }),
    subject,
  };
}

function compactSignalBotCopyAudit(copy: MarketSideCopy | null) {
  if (!copy) return null;
  return {
    buttonLabel: copy.buttonLabel,
    copyKind: copy.copyKind,
    copyVersion: copy.copyVersion,
    marketLine: copy.marketLine,
    plainPosition: copy.plainPosition,
    priceLabel: copy.priceLabel,
    rawOutcomeLabel: copy.rawOutcomeLabel,
    side: copy.side,
    sideLabel: copy.sideLabel,
    winCondition: copy.winCondition,
  };
}

function buildSignalBotCopyAudit(input: {
  buySide: "NO" | "YES" | null;
  copyPolicy?: ResolvedSignalPostCopyPolicy;
  messageKind: "initial" | "research_update";
  note: SignalBotNote;
}) {
  const yesCopy = buildSignalBotSideCopy(input.note, "YES");
  const noCopy = buildSignalBotSideCopy(input.note, "NO");
  const activeCopy =
    input.buySide === "YES" ? yesCopy : input.buySide === "NO" ? noCopy : null;
  const notification = buildSignalBotInitialNotificationCopy({
    copyPolicy: input.copyPolicy,
    messageKind: input.messageKind,
    note: input.note,
    side: input.buySide,
  });
  return {
    activeSide: input.buySide,
    copyVersion: SIGNAL_BOT_COPY_VERSION,
    policyRevision: input.copyPolicy?.revision ?? null,
    presentation: resolvePersistedOrCurrentTelegramMarketPresentation(
      input.note,
    ),
    evidence: resolvePersistedSignalEvidence(input.note).map((row) => ({
      id: row.id,
      kind: row.kind,
      scope: row.scope,
    })),
    marketSegment: input.note.marketSegment,
    notification,
    priceSnapshot: input.note.signalPriceSnapshotV1 ?? {
      bestAsk: input.note.bestAsk,
      bestBid: input.note.bestBid,
      lastPrice: input.note.lastPrice,
    },
    marketIdentity: input.note.telegramMarketIdentityV1 ?? null,
    researchUpdate: input.note.holderResearchUpdateV1 ?? null,
    sideCopy: compactSignalBotCopyAudit(activeCopy),
    sides: {
      YES: compactSignalBotCopyAudit(yesCopy),
      NO: compactSignalBotCopyAudit(noCopy),
    },
  };
}

function buildSignalBotFollowthroughCopyAudit(input: {
  candidate: SignalBotFollowthroughCandidateRow;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  stats: SignalBotFollowthroughStats;
  copyPolicy?: ResolvedSignalPostCopyPolicy;
}) {
  const yesCopy = buildSignalBotFollowthroughSideCopy(input.candidate, "YES");
  const noCopy = buildSignalBotFollowthroughSideCopy(input.candidate, "NO");
  const activeCopy =
    input.stats.signalSide === "YES"
      ? yesCopy
      : input.stats.signalSide === "NO"
        ? noCopy
        : null;
  const notification = buildSignalBotFollowthroughNotificationCopy(input);
  return {
    activeSide: input.stats.signalSide,
    copyVersion: SIGNAL_BOT_COPY_VERSION,
    policyRevision: input.copyPolicy?.revision ?? null,
    notification,
    marketIdentity: resolveSignalBotFollowthroughIdentity(input.candidate),
    priceSnapshot: {
      bestAsk: toNumber(input.candidate.best_ask),
      bestBid: toNumber(input.candidate.best_bid),
      lastPrice: toNumber(input.candidate.last_price),
    },
    sideCopy: compactSignalBotCopyAudit(activeCopy),
    sides: {
      YES: compactSignalBotCopyAudit(yesCopy),
      NO: compactSignalBotCopyAudit(noCopy),
    },
  };
}

function formatVenueLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "polymarket":
      return "Poly";
    case "kalshi":
      return "Kalshi";
    case "limitless":
      return "Limitless";
    default:
      return value?.trim() || null;
  }
}

function formatSignalBotBuyButtonText(input: {
  price: number | null;
  side: "NO" | "YES";
  sideLabel: string;
  venue: string | null;
}): string {
  const marker = input.side === "YES" ? "🟠" : "⚪";
  const venue = formatVenueLabel(input.venue);
  const price = input.price == null ? null : formatCents(input.price);
  const marketLabel =
    venue && price ? `${venue} ${price}` : (venue ?? price ?? null);
  return `${marker} Buy ${input.sideLabel}${marketLabel ? ` · ${marketLabel}` : ""}`;
}

function formatSignalBotCheaperButtonText(input: {
  alternative: SignalBotCheaperAlternative;
  sideLabel: string;
}): string {
  const venue =
    formatVenueLabel(input.alternative.venue) ?? input.alternative.venue;
  return `💸 Cheaper: ${venue} ${input.sideLabel} ${formatCents(input.alternative.price)}`;
}

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`;
}

function formatSignedPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000)
    return `${sign}$${formatCompactAmount(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000)
    return `${sign}$${formatCompactAmount(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${formatCompactAmount(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function formatSignedCompactUsd(value: number): string {
  return value > 0 ? `+${formatCompactUsd(value)}` : formatCompactUsd(value);
}

function formatCompactAmount(value: number): string {
  const decimals = value >= 100 ? 0 : 1;
  return value.toFixed(decimals).replace(/\.0$/, "");
}

function sanitizeSignalBotInitialDescription(value: string): string | null {
  const normalized =
    cleanPublicMarketText(value.replace(/\b(\d{1,3}(?:\.\d+)?)c\b/gi, "$1¢")) ??
    "";
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => {
    const duplicatePosition =
      /\b(?:this|the)\s+wallet\s+(?:is|remains)\s+(?:still\s+)?(?:holding|backing)\b/i.test(
        sentence,
      );
    const genericRecommendation =
      /\b(?:worth\s+(?:a\s+)?(?:look|watch)|makes?\s+this\s+(?:worth|interesting)|one\s+to\s+watch)\b/i.test(
        sentence,
      );
    const genericEvidenceFallback =
      /holder activity is the primary evidence for this signal/i.test(sentence);
    const missingSummaryPlaceholder = /^no summary\.?$/i.test(sentence.trim());
    return (
      !duplicatePosition &&
      !genericRecommendation &&
      !genericEvidenceFallback &&
      !missingSummaryPlaceholder
    );
  });
  const sanitized = kept.join(" ").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(sanitized) ? sanitized : null;
}

function sanitizeSignalBotResearchDescription(
  value: string,
  note: SignalBotNote,
  side: "NO" | "YES" | null,
): string | null {
  let sanitized = (
    cleanPublicMarketText(value.replace(/\b(\d{1,3}(?:\.\d+)?)c\b/gi, "$1¢")) ??
    ""
  )
    .replace(/^no summary\.?$/i, "")
    .replace(
      /holder activity is the primary evidence for this signal\.?/gi,
      " ",
    )
    .replace(
      /^the\s+market\s+now\s+(?:gives|prices)\b[^.!?]*%[^.!?]*[.!?]?\s*/i,
      "",
    )
    .replace(
      /\s*(?:,?\s*(?:but|and)\s+)?(?:it|this)\s+(?:is|was)\s+(?:only\s+)?(?:a\s+)?repeat(?:ed)?\s+(?:read|thesis)\.?/gi,
      ".",
    )
    .replace(
      /(?:^|\s)(?:no\s+)?(?:cited\s+)?external\s+evidence\s+was\s+(?:not\s+)?available\.?/gi,
      " ",
    )
    .replace(/\s+after\s+the\s+(?:drop|jump|move|repricing)\b/gi, "")
    .replace(/\s+through\s+the\s+(?:drop|jump|move|repricing)\b/gi, "")
    .replace(
      /\s*,?\s*with\s+(?:a\s+)?strong\s+recent\b[^.!?]*(?:results|record)\b[^.!?]*[.!?]?/gi,
      ".",
    )
    .replace(
      /(?:^|\s)(?:this|the)\s+wallet\s+(?:has|had)\s+recently\s+(?:beaten|won)\b[^.!?]*[.!?]?/gi,
      " ",
    )
    .replace(
      /(?:^|\s)the\s+wallets?\s+with\s+(?:the\s+)?strongest\s+recent\s+(?:records|results)\b[^.!?]*[.!?]?/gi,
      " ",
    );
  if (side) {
    const holderSubjects = [
      note.holderIdentityDisplayName,
      note.holderDisplayName,
      "this wallet",
      "the wallet",
      "these wallets",
      "tracked wallets",
    ]
      .map((subject) => cleanSignalBotDisplayText(subject))
      .filter((subject): subject is string => Boolean(subject));
    for (const subject of new Set(holderSubjects)) {
      sanitized = sanitized.replace(
        new RegExp(
          `(?:,?\\s+(?:and|but)\\s+)?${escapeRegExpLiteral(
            subject,
          )}\\s+(?:is|are)\\s+(?:still\\s+)?(?:holding|backing)\\b[^.!?]*[.!?]?`,
          "gi",
        ),
        ".",
      );
    }
  }
  sanitized = sanitized
    .replace(/\s+\./g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(sanitized) ? sanitized : null;
}

function formatSignalBotDescriptionFallback(
  sideCopy: MarketSideCopy,
): string | null {
  if (sideCopy.copyKind !== "total" || !sideCopy.winCondition) return null;
  const condition = sideCopy.winCondition
    .replace(/\b0-(\d+)\b/g, "0–$1")
    .replace(/\btotal goals\b/gi, "goals")
    .replace(/\bfirst-half goals\b/gi, "goals");
  const period = /first-half/i.test(sideCopy.winCondition)
    ? "the first half"
    : /goals/i.test(sideCopy.winCondition)
      ? "the match"
      : "the market";
  return `${sideCopy.sideLabel} cashes if ${period} finishes with ${condition}.`;
}

function formatSignalBotResearchPosition(input: {
  note: SignalBotNote;
  price: number | null;
  researchDelta: SignalBotResearchDelta | null;
  side: "NO" | "YES";
  sideLabel: string;
}): { label: string; text: string } | null {
  const clusterScope =
    input.note.holderActorMode === "sharp_cluster" ||
    input.researchDelta?.kind === "wallet_count_change" ||
    (input.researchDelta?.kind === "position_change" &&
      input.researchDelta.scope === "selected_side_cluster");
  if (clusterScope) {
    const capital =
      input.researchDelta?.kind === "position_change" &&
      input.researchDelta.scope === "selected_side_cluster"
        ? input.researchDelta.afterUsd
        : input.note.holderClusterSharpUsd;
    if (capital == null || capital <= 0) return null;
    const strongWallets =
      input.researchDelta?.kind === "wallet_count_change"
        ? input.researchDelta.afterWallets
        : input.note.holderClusterSharpHolders;
    const details = [`${formatCompactUsd(capital)} on ${input.sideLabel}`];
    if (strongWallets != null && strongWallets > 0) {
      details.push(
        `${Math.trunc(strongWallets)} strong ${
          Math.trunc(strongWallets) === 1 ? "wallet" : "wallets"
        }`,
      );
    }
    if (input.price != null) details.push(`${formatCents(input.price)} now`);
    return {
      label: "Strong-wallet support",
      text: details.join(" · "),
    };
  }
  const position =
    input.researchDelta?.kind === "position_change" &&
    input.researchDelta.scope === "representative_wallet"
      ? input.researchDelta.afterUsd
      : input.note.holderPositionUsd;
  const openPnl = input.note.holderOpenPnlUsd;
  if ((position == null || position <= 0) && openPnl == null) return null;
  const details: string[] = [];
  if (position != null && position > 0) {
    details.push(`${formatCompactUsd(position)} on ${input.sideLabel}`);
  } else {
    details.push(input.sideLabel);
  }
  if (input.price != null) details.push(`${formatCents(input.price)} now`);
  if (openPnl != null && Math.abs(openPnl) >= 1) {
    details.push(`Est. open PnL ${formatSignedCompactUsd(openPnl)}`);
  }
  return { label: "Wallet position", text: details.join(" · ") };
}

function formatSignalBotEvidenceRow(row: SignalEvidenceMetricV1): string {
  const title =
    row.kind === "track_record"
      ? "PnL"
      : row.kind === "pricing_edge"
        ? "Recent results"
        : row.kind === "volume"
          ? "Traded"
          : row.kind === "conviction"
            ? "Wallets"
            : row.kind === "capital"
              ? "Tracked position"
              : "Outside odds";
  let value: string;
  if (row.measurement.kind === "range") {
    value = `${Math.round(row.measurement.min * 100)}–${Math.round(
      row.measurement.max * 100,
    )}%`;
  } else if (row.measurement.unit === "usd") {
    value =
      row.kind === "track_record"
        ? formatSignedCompactUsd(row.measurement.value)
        : formatCompactUsd(row.measurement.value);
  } else if (row.measurement.unit === "probability") {
    value = `${row.measurement.value >= 0 ? "+" : ""}${(
      row.measurement.value * 100
    )
      .toFixed(1)
      .replace(/\.0$/, "")} pts${
      row.kind === "pricing_edge" ? " vs market" : ""
    }`;
  } else if (row.measurement.unit === "wallets") {
    value = `${Math.trunc(row.measurement.value)} on the same side`;
  } else {
    value = String(row.measurement.value);
  }
  const qualifier =
    row.sampleSize != null && row.kind === "pricing_edge"
      ? ` · ${row.sampleSize} resolved bets`
      : row.horizonDays != null
        ? ` · ${row.horizonDays}d`
        : "";
  return `▸ ${escapeTelegramMarkdownV2(title)}  ${formatTelegramBold(
    value,
  )}${escapeTelegramMarkdownV2(qualifier)}`;
}

function formatSignalBotEvidenceBlock(rows: SignalEvidenceMetricV1[]): string {
  return formatTelegramBlockquote([
    formatTelegramBold("Why it matters"),
    "",
    ...rows.map(formatSignalBotEvidenceRow),
  ]);
}

function resolveChatTitle(chat: TelegramBotChat): string | null {
  const title =
    chat.title ??
    chat.username ??
    [chat.first_name, chat.last_name]
      .filter((value): value is string => Boolean(value))
      .join(" ");
  return title.trim().length > 0 ? title : null;
}

function parseChatState(
  value: Record<string, string>,
): SignalBotChatState | null {
  if (!value.chatId || !value.enabledBy || !value.enabledAt) return null;
  const targetVenues = (() => {
    if (!value.targetVenues) return undefined;
    try {
      const parsed = JSON.parse(value.targetVenues);
      if (!Array.isArray(parsed)) return null;
      const venues = parsed.map((venue) => normalizeHunchVenue(venue));
      if (venues.some((venue) => venue == null)) return null;
      const unique = [...new Set(venues as HunchVenue[])];
      return unique.length === parsed.length && unique.length > 0
        ? unique
        : null;
    } catch {
      return null;
    }
  })();
  return {
    chatId: value.chatId,
    chatTitle: value.chatTitle || null,
    chatType: value.chatType || null,
    cursorCreatedAt: value.cursorCreatedAt || "1970-01-01T00:00:00.000Z",
    cursorId: value.cursorId || DEFAULT_CURSOR_ID,
    enabledAt: value.enabledAt,
    enabledBy: value.enabledBy,
    destinationPolicy:
      targetVenues === undefined
        ? null
        : {
            fallback: "skip",
            selectionMode: "best-executable",
            targetVenues: targetVenues ?? [],
          },
  };
}

async function writeChatState(
  redis: SignalBotRedisLike,
  state: SignalBotChatState,
): Promise<void> {
  await redis.hSet(signalBotChatKey(state.chatId), {
    chatId: state.chatId,
    chatTitle: state.chatTitle ?? "",
    chatType: state.chatType ?? "",
    cursorCreatedAt: state.cursorCreatedAt,
    cursorId: state.cursorId,
    enabledAt: state.enabledAt,
    enabledBy: state.enabledBy,
    targetVenues: state.destinationPolicy
      ? JSON.stringify(state.destinationPolicy.targetVenues)
      : "",
  });
}

function buildPlainReply(
  chatId: string,
  text: string,
): TelegramSendMessageInput {
  return {
    chat_id: chatId,
    disable_web_page_preview: true,
    parse_mode: "MarkdownV2",
    text: escapeTelegramMarkdownV2(text),
  };
}

function publicHelpText(input: { miniAppEnabled: boolean }): string {
  return [
    "Hunch Signal Bot",
    "",
    "Follow Hunch market signals and open the app to explore markets and trading opportunities.",
    input.miniAppEnabled
      ? "Use Get Hunch to open the Hunch Mini App."
      : "The Hunch Mini App is temporarily unavailable.",
  ].join("\n");
}

function helpText(input: {
  isAdmin: boolean;
  miniAppEnabled: boolean;
}): string {
  if (!input.isAdmin) return publicHelpText(input);
  return [
    publicHelpText(input),
    "",
    "Admin controls",
    "/enable_signals - enable this chat",
    "/enable_signals <channel_id> - enable a channel",
    "/disable_signals - disable this chat",
    "/disable_signals <channel_id> - disable a channel",
    "/signal_venues <csv|all> [channel_id] - set destination venues",
    "/status [channel_id] - show signal status",
    "/stats [24h|7d|30d] [detail] - show signal performance",
    "/trade_status - show private trading readiness",
    "/market <market_id or URL> - open a private trading card",
    "/disable_trading - disable Telegram bot trading",
    "/test_followthrough [stats|win|loss] [channel_id] - preview a follow-up",
    "/test_signal [channel_id] [latest|initial|update|note_uuid] - exact delivery preview",
    "/test_trade <market_id or URL> - preview a private trade card",
  ].join("\n");
}
