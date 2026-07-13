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
import { createAggMarketClient } from "./agg-market-client.js";
import {
  getAggMarketAlternativesResponseCachedWithMetadata,
  type AggMarketAlternativesCacheClient,
} from "./agg-market-clusters.js";
import type { ClusterMarketSummary } from "./clusters.js";
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
  type MarketSideCopy,
} from "./market-side-copy.js";
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
} from "./signal-bot-mini-app-links.js";
import { parseTelegramBotTradingCallbackData } from "./telegram-bot-trading-client.js";
import { buildWalletIntelAcceptingOrdersSql } from "./wallet-intel-market-eligibility.js";
import { parseMarketOutcomes } from "./wallet-intel-helpers.js";
import {
  resolveSignalDeliveryTarget,
  type SignalDeliveryCandidate,
  type SignalDestinationPolicy,
} from "./signal-delivery-target.js";
import { resolveSignalBotVenueLifecycle } from "./signal-bot-venue-lifecycle.js";
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
  minConfidence: number;
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

export type SignalBotCheaperAlternativeResolver = (input: {
  buySide: "NO" | "YES";
  note: SignalBotNote;
}) => Promise<SignalBotCheaperAlternative | null>;

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

export type TelegramInlineKeyboardButton =
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
  createdAt: string;
  primaryTargetMeta: Record<string, unknown>;
  marketId: string | null;
  eventId: string | null;
  marketVenue: string | null;
  marketTitle: string | null;
  marketSlug: string | null;
  marketDescription: string | null;
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
  created_at: Date | string;
  primary_target_meta: unknown;
  market_id: string | null;
  event_id: string | null;
  market_venue: string | null;
  market_title: string | null;
  market_slug: string | null;
  market_description: string | null;
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
  holder_target_meta: unknown;
};

type SignalBotEligibilityCountRow = {
  below_min_confidence: string | number | null;
  eligible: string | number | null;
  non_directional: string | number | null;
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
const PRICE_GUARD_MAX_FRESH_AGE_MS = 15 * 60 * 1_000;
const LOCK_TTL_MS = 120_000;
const SIGNAL_CONTEXT_MAX_CHARS = 260;
const DEFAULT_CURSOR_ID = "00000000-0000-0000-0000-000000000000";
const LATEST_CURSOR_CREATED_AT = "9999-12-31T23:59:59.999Z";
const LATEST_CURSOR_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const SEND_FAILURE_COOLDOWN_SEC = 300;
const FOLLOWTHROUGH_RETRY_COOLDOWN_MS = 15 * 60_000;
const FOLLOWTHROUGH_MIN_LATEST_SNAPSHOT_FRESH_MS = 24 * 60 * 60 * 1_000;
const SIGNAL_BOT_COPY_FLOW_HEADLINES = [
  "🔥 Copy flow is building before price moves",
  "👀 People are quietly joining this side",
  "🔥 This call is starting to get copied",
  "👀 Wallets are still leaning into this",
  "🔥 More wallets are moving into this trade",
  "👀 Price is flat. Flow is not.",
  "🔥 This call is starting to get traction",
] as const;
const SIGNAL_BOT_COPY_VERSION = "signal_bot_copy_v2";
const TELEGRAM_WEB_APP_ENTRY_PATH = "/tg";
const TELEGRAM_WEB_APP_START_PARAM_QUERY = "tgWebAppStartParam";
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
  return {
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
    minConfidence: parseRatio(env.HUNCH_SIGNAL_BOT_MIN_CONFIDENCE, 0.7),
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

function createSignalBotBodyTextRenderer(
  note: SignalBotNote,
  holderUrl: string | null,
): (value: string) => string {
  const candidates = holderUrl ? buildSignalBotHolderLinkCandidates(note) : [];
  let didLinkHolder = false;
  return (value: string) => {
    const sanitizedValue = sanitizeSignalBotPublicHolderMentions(value, note);
    if (!holderUrl || didLinkHolder || candidates.length === 0) {
      return escapeTelegramMarkdownV2(sanitizedValue);
    }
    const match = findSignalBotHolderLinkMatch(sanitizedValue, candidates);
    if (!match) return escapeTelegramMarkdownV2(sanitizedValue);
    didLinkHolder = true;
    return renderSignalBotHolderLinkedText(sanitizedValue, match, holderUrl);
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

function renderSignalBotHolderLinkedText(
  value: string,
  match: SignalBotHolderLinkMatch,
  holderUrl: string,
): string {
  const before = value.slice(0, match.index);
  const label = value.slice(match.index, match.index + match.label.length);
  const after = value.slice(match.index + match.label.length);
  return [
    escapeTelegramMarkdownV2(before),
    `[${escapeTelegramMarkdownV2(label)}](${escapeTelegramMarkdownV2Url(holderUrl)})`,
    escapeTelegramMarkdownV2(after),
  ].join("");
}

function isSignalBotPrivateChat(chatType: string | null | undefined): boolean {
  return chatType === "private";
}

function buildSignalBotTelegramWebAppUrl(input: {
  appBaseUrl: string;
  startParam: string | null | undefined;
}): string | null {
  if (!input.startParam) return null;
  try {
    const url = new URL(TELEGRAM_WEB_APP_ENTRY_PATH, input.appBaseUrl);
    url.searchParams.set(TELEGRAM_WEB_APP_START_PARAM_QUERY, input.startParam);
    return url.toString();
  } catch {
    return null;
  }
}

function buildSignalBotTelegramButton(input: {
  appBaseUrl: string;
  chatType?: string | null;
  miniAppLinkBase?: string | null;
  startParam: string | null | undefined;
  text: string;
  webUrl: string;
}): TelegramInlineKeyboardButton {
  const miniAppUrl =
    buildSignalBotMiniAppUrl({
      base: input.miniAppLinkBase,
      startParam: input.startParam ?? null,
    }) ?? input.webUrl;
  const webAppUrl = buildSignalBotTelegramWebAppUrl({
    appBaseUrl: input.appBaseUrl,
    startParam: input.startParam,
  });
  if (
    input.miniAppLinkBase &&
    isSignalBotPrivateChat(input.chatType) &&
    webAppUrl
  ) {
    return {
      text: input.text,
      web_app: { url: webAppUrl },
    };
  }
  return {
    text: input.text,
    url: miniAppUrl,
  };
}

export function buildSignalBotMessage(input: {
  appBaseUrl: string;
  buyAmountUsd: number;
  chatType?: string | null;
  cheaperAlternative?: SignalBotCheaperAlternative | null;
  deliveryTarget?: SignalBotCheaperAlternative | null;
  note: SignalBotNote;
  telegramMiniAppLinkBase?: string | null;
}): {
  keyboard: TelegramInlineKeyboard | undefined;
  text: string;
} {
  const note = input.note;
  const buySide = resolveSignalBotBuySide(note);
  const price = buySide ? resolveSignalBotBuyPrice(note, buySide) : null;
  const title = escapeTelegramMarkdownV2(note.title);
  const contextLine = formatSignalContextLine(note);
  const credentialLines = formatSignalBotWhyItMattersLines(note);
  const buySideCopy = buySide ? buildSignalBotSideCopy(note, buySide) : null;
  const winConditionLine = buySideCopy?.winCondition
    ? `This wins if there are ${buySideCopy.winCondition}.`
    : null;
  const whyInterestingLine = formatSignalBotWhyInterestingLine({
    buySide,
    note,
    price,
  });
  const marketUrl = note.eventId
    ? buildSignalBotOpenMarketUrl({
        appBaseUrl: input.appBaseUrl,
        eventId: note.eventId,
        marketId: note.marketId,
        side: buySide,
      })
    : null;
  const rawHolderUrl = buildSignalBotHolderUrl({
    address: note.holderAddress,
    appBaseUrl: input.appBaseUrl,
    chain: note.holderChain,
    eventId: note.eventId,
    marketId: note.marketId,
    noteId: note.id,
    side: note.holderSide,
  });
  const holderUrl =
    rawHolderUrl &&
    (!buySide || !note.holderSide || note.holderSide === buySide)
      ? rawHolderUrl
      : null;
  const holderStartParam = holderUrl
    ? buildSignalBotHolderStartParam({
        address: note.holderAddress,
        chain: note.holderChain,
        eventId: note.eventId,
        marketId: note.marketId,
        noteId: note.id,
        side: note.holderSide,
      })
    : null;
  const marketStartParam = note.eventId
    ? buildSignalBotMarketStartParam({
        eventId: note.eventId,
        marketId: note.marketId,
        side: buySide,
      })
    : null;
  const titleMarkdown = marketUrl
    ? `*[${title}](${escapeTelegramMarkdownV2Url(marketUrl)})*`
    : `*${title}*`;
  const renderBodyText = createSignalBotBodyTextRenderer(note, holderUrl);
  const summary = renderBodyText(note.description);
  const categoryEmoji = formatSignalBotMarketEmoji(note);
  const titleLine = categoryEmoji
    ? `${categoryEmoji} ${titleMarkdown}`
    : titleMarkdown;
  const lines = [
    titleLine,
    "",
    summary,
    ...(whyInterestingLine ? ["", renderBodyText(whyInterestingLine)] : []),
    ...(winConditionLine
      ? ["", escapeTelegramMarkdownV2(winConditionLine)]
      : []),
    ...(credentialLines.length > 0
      ? ["", ...credentialLines.map(escapeTelegramMarkdownV2)]
      : []),
    ...(contextLine ? ["", renderBodyText(contextLine)] : []),
  ];

  const keyboardRows: TelegramInlineKeyboard["inline_keyboard"] = [];
  if (note.eventId && note.marketId && buySide) {
    const tradeTarget = input.deliveryTarget ?? {
      eventId: note.eventId,
      marketId: note.marketId,
      price: price ?? 0,
      side: buySide,
      venue: note.marketVenue ?? "unknown",
    };
    const tradeSideLabel =
      tradeTarget.side === buySide
        ? formatSignalBotOutcomeDisplayLabel(note, buySide, "button")
        : tradeTarget.side;
    const baseTradeUrl = buildSignalBotTradeUrl({
      amountUsd: input.buyAmountUsd,
      appBaseUrl: input.appBaseUrl,
      eventId: tradeTarget.eventId,
      marketId: tradeTarget.marketId,
      side: tradeTarget.side,
    });
    keyboardRows.push([
      buildSignalBotTelegramButton({
        appBaseUrl: input.appBaseUrl,
        chatType: input.chatType,
        miniAppLinkBase: input.telegramMiniAppLinkBase,
        startParam: buildSignalBotBuyStartParam({
          amountUsd: input.buyAmountUsd,
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
        webUrl: baseTradeUrl,
      }),
    ]);
    if (
      !input.deliveryTarget &&
      input.cheaperAlternative &&
      input.cheaperAlternative.side === buySide
    ) {
      const cheaperTradeWebUrl = buildSignalBotTradeUrl({
        amountUsd: input.buyAmountUsd,
        appBaseUrl: input.appBaseUrl,
        eventId: input.cheaperAlternative.eventId,
        marketId: input.cheaperAlternative.marketId,
        side: input.cheaperAlternative.side,
      });
      keyboardRows.push([
        buildSignalBotTelegramButton({
          appBaseUrl: input.appBaseUrl,
          chatType: input.chatType,
          miniAppLinkBase: input.telegramMiniAppLinkBase,
          startParam: buildSignalBotBuyStartParam({
            amountUsd: input.buyAmountUsd,
            eventId: input.cheaperAlternative.eventId,
            marketId: input.cheaperAlternative.marketId,
            side: input.cheaperAlternative.side,
          }),
          text: formatSignalBotCheaperButtonText({
            alternative: input.cheaperAlternative,
            sideLabel: formatSignalBotOutcomeDisplayLabel(
              note,
              buySide,
              "button",
            ),
          }),
          webUrl: cheaperTradeWebUrl,
        }),
      ]);
    }
    keyboardRows.push(
      buildSignalBotLinkRow({
        appBaseUrl: input.appBaseUrl,
        chatType: input.chatType,
        holderActorMode: note.holderActorMode,
        holderSide: note.holderSide,
        holderOpenPnlUsd: note.holderOpenPnlUsd,
        holderPositionUsd: note.holderPositionUsd,
        holderLink: holderUrl
          ? {
              startParam: holderStartParam,
              webUrl: holderUrl,
            }
          : null,
        holderSideLabel: note.holderSide
          ? formatSignalBotOutcomeDisplayLabel(note, note.holderSide, "button")
          : null,
        marketLink: {
          startParam: marketStartParam,
          webUrl: marketUrl ?? baseTradeUrl,
        },
        telegramMiniAppLinkBase: input.telegramMiniAppLinkBase,
      }),
    );
  } else if (note.eventId) {
    keyboardRows.push(
      buildSignalBotLinkRow({
        appBaseUrl: input.appBaseUrl,
        chatType: input.chatType,
        holderActorMode: note.holderActorMode,
        holderSide: note.holderSide,
        holderOpenPnlUsd: note.holderOpenPnlUsd,
        holderPositionUsd: note.holderPositionUsd,
        holderLink: holderUrl
          ? {
              startParam: holderStartParam,
              webUrl: holderUrl,
            }
          : null,
        holderSideLabel: note.holderSide
          ? formatSignalBotOutcomeDisplayLabel(note, note.holderSide, "button")
          : null,
        marketLink: {
          startParam: marketStartParam,
          webUrl:
            marketUrl ??
            buildSignalBotOpenMarketUrl({
              appBaseUrl: input.appBaseUrl,
              eventId: note.eventId,
              marketId: note.marketId,
              side: buySide,
            }),
        },
        telegramMiniAppLinkBase: input.telegramMiniAppLinkBase,
      }),
    );
  } else if (holderUrl) {
    keyboardRows.push(
      buildSignalBotLinkRow({
        appBaseUrl: input.appBaseUrl,
        chatType: input.chatType,
        holderActorMode: note.holderActorMode,
        holderSide: note.holderSide,
        holderOpenPnlUsd: note.holderOpenPnlUsd,
        holderPositionUsd: note.holderPositionUsd,
        holderSideLabel: note.holderSide
          ? formatSignalBotOutcomeDisplayLabel(note, note.holderSide, "button")
          : null,
        holderLink: {
          startParam: holderStartParam,
          webUrl: holderUrl,
        },
        marketLink: null,
        telegramMiniAppLinkBase: input.telegramMiniAppLinkBase,
      }),
    );
  }

  return {
    keyboard:
      keyboardRows.length > 0 ? { inline_keyboard: keyboardRows } : undefined,
    text: lines.join("\n"),
  };
}

function buildSignalBotLinkRow(input: {
  appBaseUrl: string;
  chatType?: string | null;
  holderActorMode: "none" | "sharp_cluster" | "single_holder" | null;
  holderLink: { startParam: string | null; webUrl: string } | null;
  holderOpenPnlUsd: number | null;
  holderPositionUsd: number | null;
  holderSide: "NO" | "YES" | null;
  holderSideLabel: string | null;
  marketLink: { startParam: string | null; webUrl: string } | null;
  telegramMiniAppLinkBase?: string | null;
}): TelegramInlineKeyboard["inline_keyboard"][number] {
  const row: TelegramInlineKeyboard["inline_keyboard"][number] = [];
  if (input.holderLink) {
    row.push(
      buildSignalBotTelegramButton({
        appBaseUrl: input.appBaseUrl,
        chatType: input.chatType,
        miniAppLinkBase: input.telegramMiniAppLinkBase,
        startParam: input.holderLink.startParam,
        text: formatHolderButtonText(input),
        webUrl: input.holderLink.webUrl,
      }),
    );
  }
  if (input.marketLink) {
    row.push(
      buildSignalBotTelegramButton({
        appBaseUrl: input.appBaseUrl,
        chatType: input.chatType,
        miniAppLinkBase: input.telegramMiniAppLinkBase,
        startParam: input.marketLink.startParam,
        text: "↗️ Open market",
        webUrl: input.marketLink.webUrl,
      }),
    );
  }
  return row;
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

  if (side) {
    const buyPrice = input.buyPrice;
    if (
      isSignalBotFollowthroughBuyCtaEligible({
        allowBuyCta: input.allowBuyCta,
        buyPrice,
        stats: input.stats,
      })
    ) {
      const webTradeUrl = buildSignalBotTradeUrl({
        amountUsd: input.buyAmountUsd,
        appBaseUrl: input.appBaseUrl,
        eventId,
        marketId,
        side,
      });
      rows.push([
        buildSignalBotTelegramButton({
          appBaseUrl: input.appBaseUrl,
          chatType: input.chatType,
          miniAppLinkBase: input.telegramMiniAppLinkBase,
          startParam: buildSignalBotBuyStartParam({
            amountUsd: input.buyAmountUsd,
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
          webUrl: webTradeUrl,
        }),
      ]);
    }
  }

  const webMarketUrl = buildSignalBotOpenMarketUrl({
    appBaseUrl: input.appBaseUrl,
    eventId,
    marketId,
    side,
  });
  rows.push([
    buildSignalBotTelegramButton({
      appBaseUrl: input.appBaseUrl,
      chatType: input.chatType,
      miniAppLinkBase: input.telegramMiniAppLinkBase,
      startParam: buildSignalBotMarketStartParam({
        eventId,
        marketId,
        side,
      }),
      text: "↗️ Open market",
      webUrl: webMarketUrl,
    }),
  ]);

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

function formatHolderButtonText(input: {
  holderActorMode: "none" | "sharp_cluster" | "single_holder" | null;
  holderOpenPnlUsd: number | null;
  holderPositionUsd: number | null;
  holderSide: "NO" | "YES" | null;
  holderSideLabel: string | null;
}): string {
  const prefix =
    input.holderActorMode === "sharp_cluster" ? "👥 Top wallet" : "👤 Wallet";
  const sideLabel = input.holderSideLabel ?? input.holderSide;
  const parts = [sideLabel ? `${prefix} · ${sideLabel}` : prefix];
  if (input.holderPositionUsd != null) {
    parts.push(formatCompactUsd(input.holderPositionUsd));
  }
  const label = parts.join(" ");
  if (input.holderOpenPnlUsd == null) return label;
  return `${label} (${formatSignedCompactUsd(input.holderOpenPnlUsd)} PnL)`;
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
  sendTestSignal: (chatId: string) => Promise<boolean>;
  sendTradeMarket?: (input: {
    chatId: string;
    isAdminTest?: boolean;
    marketRef: string;
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

  if (!isAdmin && command !== "start" && command !== "help") {
    await input.sendMessage(buildPlainReply(chatId, "Not authorized."));
    return true;
  }

  if (command === "start") {
    await input.sendMessage(
      buildPlainReply(
        chatId,
        publicHelpText({
          miniAppEnabled: input.config.telegramMiniAppLinkBase != null,
        }),
      ),
    );
    return true;
  }
  if (command === "help") {
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
          `Min confidence: ${formatPercent(input.config.minConfidence)}.`,
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
    await input.sendMessage({
      ...reply,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Revoke access in Hunch",
              url: new URL(
                "/settings/telegram-trading",
                input.config.appBaseUrl,
              ).toString(),
            },
          ],
        ],
      },
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
    const sent = await (input.sendTradeMarket?.({
      chatId,
      marketRef,
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
    const sent = await input.sendTestSignal(targetChatId ?? chatId);
    await input.sendMessage(
      buildPlainReply(
        chatId,
        sent ? "Sent latest eligible signal." : "No eligible signal found.",
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

export async function pollSignalBotCommands(input: {
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
  sendTestSignal: (chatId: string) => Promise<boolean>;
  sendTradeMarket?: (input: {
    chatId: string;
    isAdminTest?: boolean;
    marketRef: string;
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
}): Promise<number> {
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
        } catch {
          didHandle = true;
          await input.telegram
            .sendMessage(
              buildPlainReply(
                String(update.message.chat.id),
                "Command failed. Try again.",
              ),
            )
            .catch(() => undefined);
        }
        if (didHandle) handled += 1;
      }
      if (update.callback_query) {
        const callbackQuery = update.callback_query;
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

const SIGNAL_BOT_ALTERNATIVES_QUERY = { limit: 8, sourceLimit: 50 };
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
    deliveryAmbiguousMapping: 0,
    deliveryDestinationDisabled: 0,
    deliveryNoExecutableTarget: 0,
    deliveryStalePrice: 0,
  };
}

function addSignalBotCheaperAlternativeDiagnostics(
  target: SignalBotCheaperAlternativeDiagnostics,
  source: SignalBotCheaperAlternativeDiagnostics,
): void {
  target.aggCheaperFound += source.aggCheaperFound;
  target.aggDisabled += source.aggDisabled;
  target.aggErrors += source.aggErrors;
  target.aggMatched += source.aggMatched;
  target.aggMatchedNotCheaper += source.aggMatchedNotCheaper;
  target.aggNoResponse += source.aggNoResponse;
  target.aggNotFound += source.aggNotFound;
  target.deliveryAmbiguousMapping += source.deliveryAmbiguousMapping;
  target.deliveryDestinationDisabled += source.deliveryDestinationDisabled;
  target.deliveryNoExecutableTarget += source.deliveryNoExecutableTarget;
  target.deliveryStalePrice += source.deliveryStalePrice;
}

function addSignalDeliveryFailureDiagnostic(
  diagnostics: SignalBotCheaperAlternativeDiagnostics,
  reason: ReturnType<typeof resolveSignalDeliveryTarget>["reason"],
): void {
  switch (reason) {
    case "ambiguous_mapping":
      diagnostics.deliveryAmbiguousMapping += 1;
      break;
    case "destination_disabled":
      diagnostics.deliveryDestinationDisabled += 1;
      break;
    case "no_executable_target":
      diagnostics.deliveryNoExecutableTarget += 1;
      break;
    case "stale_price":
      diagnostics.deliveryStalePrice += 1;
      break;
    case null:
      break;
  }
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
    return {
      blockers: sideState.blockers,
      buyPrice: sideState.buyPrice,
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
  response: {
    alternatives: ClusterMarketSummary[];
    status: string;
  };
}): SignalBotCheaperAlternative | null {
  if (input.response.status !== "matched") return null;
  const primaryPrice = resolveSignalBotBuyPrice(input.note, input.buySide);
  if (primaryPrice == null) return null;

  const candidates = input.response.alternatives
    .map((market): SignalBotCheaperAlternative | null => {
      const price = resolveMarketBuyPrice(market, input.buySide);
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
        side: input.buySide,
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
    status: string;
  } | null;
}): SignalBotCheaperAlternativeResult {
  const diagnostics = createSignalBotCheaperAlternativeDiagnostics();
  if (!input.response) {
    diagnostics.aggNoResponse += 1;
    return { alternative: null, diagnostics };
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

async function resolveDefaultSignalBotCheaperAlternative(input: {
  buySide: "NO" | "YES";
  db: DbQuery;
  note: SignalBotNote;
  redis: SignalBotRedisLike;
}): Promise<SignalBotCheaperAlternativeResult> {
  const diagnostics = createSignalBotCheaperAlternativeDiagnostics();
  const aggConfig = parseSignalBotAggMarketConfig();
  if (!aggConfig) {
    diagnostics.aggDisabled += 1;
    return { alternative: null, diagnostics };
  }
  if (!input.note.marketId) {
    diagnostics.aggNoResponse += 1;
    return { alternative: null, diagnostics };
  }
  try {
    const client = createAggMarketClient({
      apiKey: aggConfig.apiKey,
      appId: aggConfig.appId,
      baseUrl: aggConfig.baseUrl,
      timeoutMs: aggConfig.timeoutMs,
    });
    const { response } =
      await getAggMarketAlternativesResponseCachedWithMetadata({
        cacheClient: input.redis as AggMarketAlternativesCacheClient,
        client,
        db: input.db,
        marketId: input.note.marketId,
        matchedTtlSec: aggConfig.matchedTtlSec,
        notFoundTtlSec: aggConfig.notFoundTtlSec,
        query: SIGNAL_BOT_ALTERNATIVES_QUERY,
      });
    return resolveSignalBotCheaperAlternativeFromAggResponse({
      buySide: input.buySide,
      note: input.note,
      response,
    });
  } catch {
    diagnostics.aggErrors += 1;
    return { alternative: null, diagnostics };
  }
}

function signalDeliveryCandidateFromSource(input: {
  buySide: "NO" | "YES";
  executablePrice: number | null;
  note: SignalBotNote;
  priceAsOf: string;
}): SignalDeliveryCandidate | null {
  const venue = normalizeHunchVenue(input.note.marketVenue);
  if (
    !venue ||
    !input.note.eventId ||
    !input.note.marketId ||
    input.executablePrice == null
  ) {
    return null;
  }
  return {
    active: true,
    eventId: input.note.eventId,
    executablePrice: input.executablePrice,
    matchMethod: "source_identity",
    marketId: input.note.marketId,
    mappedSide: input.buySide,
    mappingConfidence: 1,
    mappingMethod: "source_identity",
    orderable: true,
    priceAsOf: input.priceAsOf,
    sourceSide: input.buySide,
    venue,
  };
}

function signalDeliveryCandidateFromAgg(input: {
  buySide: "NO" | "YES";
  executablePrice: number | null;
  market: ClusterMarketSummary;
  priceAsOf: string;
}): SignalDeliveryCandidate | null {
  const mapping = input.market.outcomeMapping;
  const mappedSide =
    input.buySide === "YES"
      ? mapping?.sourceYesTo
      : mapping?.sourceYesTo === "YES"
        ? "NO"
        : mapping?.sourceYesTo === "NO"
          ? "YES"
          : null;
  if (
    !mapping ||
    !mappedSide ||
    input.executablePrice == null ||
    !input.market.eventId ||
    !input.market.marketId ||
    !input.market.matchMethod
  ) {
    return null;
  }
  return {
    active: input.market.active === true,
    eventId: input.market.eventId,
    executablePrice: input.executablePrice,
    matchMethod: input.market.matchMethod,
    marketId: input.market.marketId,
    mappedSide,
    mappingConfidence: mapping.confidence,
    mappingMethod: mapping.method,
    orderable: input.market.orderable === true,
    priceAsOf: input.priceAsOf,
    sourceSide: input.buySide,
    venue: input.market.venue,
  };
}

async function resolveDefaultSignalBotDeliveryTarget(input: {
  buySide: "NO" | "YES";
  db: DbQuery;
  destinationPolicy: SignalDestinationPolicy;
  lifecycle: Awaited<
    ReturnType<typeof resolveSignalBotVenueLifecycle>
  >["policy"];
  note: SignalBotNote;
  now: Date;
  redis: SignalBotRedisLike;
  sourceBuyPrice: number | null;
}): Promise<{
  diagnostics: SignalBotCheaperAlternativeDiagnostics;
  resolution: ReturnType<typeof resolveSignalDeliveryTarget>;
}> {
  const diagnostics = createSignalBotCheaperAlternativeDiagnostics();
  const candidates: SignalDeliveryCandidate[] = [];
  const source = signalDeliveryCandidateFromSource({
    buySide: input.buySide,
    executablePrice: input.sourceBuyPrice,
    note: input.note,
    priceAsOf: input.now.toISOString(),
  });
  if (source) candidates.push(source);

  const aggConfig = parseSignalBotAggMarketConfig();
  if (!aggConfig || !input.note.marketId) {
    diagnostics.aggDisabled += 1;
  } else {
    try {
      const sourceVenue = normalizeHunchVenue(input.note.marketVenue);
      const queryVenues = [
        ...new Set([
          ...input.destinationPolicy.targetVenues,
          ...(sourceVenue ? [sourceVenue] : []),
        ]),
      ];
      const client = createAggMarketClient({
        apiKey: aggConfig.apiKey,
        appId: aggConfig.appId,
        baseUrl: aggConfig.baseUrl,
        timeoutMs: aggConfig.timeoutMs,
      });
      const { response } =
        await getAggMarketAlternativesResponseCachedWithMetadata({
          cacheClient: input.redis as AggMarketAlternativesCacheClient,
          client,
          db: input.db,
          marketId: input.note.marketId,
          matchedTtlSec: aggConfig.matchedTtlSec,
          notFoundTtlSec: aggConfig.notFoundTtlSec,
          query: {
            ...SIGNAL_BOT_ALTERNATIVES_QUERY,
            venues: queryVenues.join(","),
          },
        });
      if (!response) {
        diagnostics.aggNoResponse += 1;
      } else if (response.status === "matched") {
        diagnostics.aggMatched += 1;
        for (const market of response.markets) {
          const mapping = market.outcomeMapping;
          const mappedSide =
            input.buySide === "YES"
              ? mapping?.sourceYesTo
              : mapping?.sourceYesTo === "YES"
                ? "NO"
                : mapping?.sourceYesTo === "NO"
                  ? "YES"
                  : null;
          if (!mappedSide) continue;
          const priceGuard = await loadSignalBotPriceGuardBlockers({
            buySide: mappedSide,
            db: input.db,
            note: { marketId: market.marketId },
            redis: input.redis,
          });
          if (
            priceGuard.defer ||
            !priceGuard.orderable ||
            priceGuard.blockers.length > 0 ||
            priceGuard.buyPrice == null
          ) {
            continue;
          }
          const candidate = signalDeliveryCandidateFromAgg({
            buySide: input.buySide,
            executablePrice: priceGuard.buyPrice,
            market,
            priceAsOf: input.now.toISOString(),
          });
          if (candidate) candidates.push(candidate);
        }
      } else {
        diagnostics.aggNotFound += 1;
      }
    } catch {
      diagnostics.aggErrors += 1;
    }
  }

  const resolution = resolveSignalDeliveryTarget({
    candidates,
    destinationPolicy: input.destinationPolicy,
    lifecycle: input.lifecycle,
    nowMs: input.now.getTime(),
    sourceSide: input.buySide,
  });
  addSignalDeliveryFailureDiagnostic(diagnostics, resolution.reason);
  if (resolution.target && resolution.target.marketId !== input.note.marketId) {
    diagnostics.aggCheaperFound += 1;
  } else if (diagnostics.aggMatched > 0) {
    diagnostics.aggMatchedNotCheaper += 1;
  }
  return { diagnostics, resolution };
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
        join ai_note_targets prior_market
          on prior_market.note_id = prior.note_id
         and prior_market.target_kind = 'market'
         and prior_market.is_primary = true
        left join signal_bot_messages root
          on root.chat_id = prior.chat_id
         and root.note_id = prior.thread_root_note_id
         and root.message_kind = 'initial'
        where prior.chat_id = $1
          and prior.note_id <> $2::uuid
          and prior.message_kind in ('initial', 'research_update')
          and prior_market.target_id = $3
        order by prior.baseline_at asc, prior.sent_at asc
        limit 1
      `,
      [input.chatId, input.note.id, input.note.marketId],
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
          telegram_message_id = excluded.telegram_message_id,
          reply_to_message_id = excluded.reply_to_message_id,
          baseline_at = excluded.baseline_at,
          sent_at = excluded.sent_at,
          metrics = excluded.metrics
      `,
      [
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
}): Promise<boolean> {
  try {
    const result = await input.db.query(
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
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return false;
    console.warn("[signal-bot] failed to reserve followthrough delivery", {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
      messageKind: input.messageKind,
      noteId: input.noteId,
    });
    return false;
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
}): SignalDeliveryView {
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
    title: input.note.title,
  };
}

export async function publishSignalBotTick(input: {
  config: SignalBotConfig;
  db: DbQuery;
  resolveCheaperAlternative?: SignalBotCheaperAlternativeResolver;
  redis: SignalBotRedisLike;
  telegram: SignalBotTelegramClient;
  transports?: readonly SignalTransport[];
}): Promise<
  {
    belowConfidenceNotes: number;
    blockedChats: number;
    chats: number;
    cheaperAlternatives: number;
    eligibleNotes: number;
    nonDirectionalNotes: number;
    sent: number;
  } & SignalBotCheaperAlternativeDiagnostics &
    SignalBotPriceGuardDiagnostics
> {
  const chatIds = await input.redis.sMembers(CHAT_SET_KEY);
  const telegramTransport =
    input.transports?.find((transport) => transport.kind === "telegram") ??
    createSignalBotTelegramTransport(input.telegram);
  const lifecycle = await resolveSignalBotVenueLifecycle(input.db);
  let sent = 0;
  let blockedChats = 0;
  let belowConfidenceNotes = 0;
  let cheaperAlternatives = 0;
  let eligibleNotes = 0;
  let nonDirectionalNotes = 0;
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
      minConfidence: input.config.minConfidence,
    });
    belowConfidenceNotes += counts.belowConfidence;
    eligibleNotes += counts.eligible;
    nonDirectionalNotes += counts.nonDirectional;
    const notes = await loadSignalBotNotes(input.db, {
      afterCreatedAt: state.cursorCreatedAt,
      afterId: state.cursorId,
      limit: input.config.maxSignalsPerTick,
      minConfidence: input.config.minConfidence,
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
      const buySide = resolveSignalBotBuySide(note);
      let verifiedSourceBuyPrice: number | null = null;
      if (buySide) {
        const priceGuard = await loadSignalBotPriceGuardBlockers({
          buySide,
          db: input.db,
          note,
          redis: input.redis,
        });
        if (priceGuard.defer) {
          const deferCount = await recordSignalBotPriceGuardDeferral({
            chatId,
            noteId: note.id,
            redis: input.redis,
            ttlSec: input.config.priceGuardDeferTtlSec,
          });
          addSignalBotPriceGuardBlockers(
            priceGuardDiagnostics,
            priceGuard.blockers,
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
        if (!priceGuard.orderable) {
          priceGuardDiagnostics.priceGuardSkipped += 1;
          await updateSignalBotChatCursor({
            chatId,
            createdAt: note.createdAt,
            id: note.id,
            redis: input.redis,
          });
          continue;
        }
        const priceBlockers = priceGuard.blockers;
        if (priceBlockers.length > 0) {
          priceGuardDiagnostics.priceGuardSkipped += 1;
          addSignalBotPriceGuardBlockers(priceGuardDiagnostics, priceBlockers);
          await updateSignalBotChatCursor({
            chatId,
            createdAt: note.createdAt,
            id: note.id,
            redis: input.redis,
          });
          continue;
        }
        verifiedSourceBuyPrice = priceGuard.buyPrice;
      }
      let cheaperAlternative: SignalBotCheaperAlternative | null = null;
      let deliveryTarget: SignalBotCheaperAlternative | null = null;
      const destinationPolicy: SignalDestinationPolicy =
        state.destinationPolicy ?? {
          fallback: "skip",
          selectionMode: "best-executable",
          targetVenues: getVenuesWithLifecycleCapability(
            lifecycle.policy,
            "signalDelivery",
          ),
        };
      if (buySide) {
        if (input.resolveCheaperAlternative) {
          cheaperAlternative = await input.resolveCheaperAlternative({
            buySide,
            note,
          });
          const nowIso = new Date().toISOString();
          const candidates = [
            signalDeliveryCandidateFromSource({
              buySide,
              executablePrice: verifiedSourceBuyPrice,
              note,
              priceAsOf: nowIso,
            }),
            cheaperAlternative
              ? {
                  active: true,
                  eventId: cheaperAlternative.eventId,
                  executablePrice: cheaperAlternative.price,
                  matchMethod: "injected_resolver",
                  marketId: cheaperAlternative.marketId,
                  mappedSide: cheaperAlternative.side,
                  mappingConfidence: 1,
                  mappingMethod: "injected_resolver",
                  orderable: true,
                  priceAsOf: nowIso,
                  sourceSide: buySide,
                  venue: cheaperAlternative.venue,
                }
              : null,
          ].filter(
            (candidate): candidate is SignalDeliveryCandidate =>
              candidate != null,
          );
          const resolution = resolveSignalDeliveryTarget({
            candidates,
            destinationPolicy,
            lifecycle: lifecycle.policy,
            sourceSide: buySide,
          });
          addSignalDeliveryFailureDiagnostic(
            alternativeDiagnostics,
            resolution.reason,
          );
          if (resolution.target) {
            deliveryTarget = {
              eventId: resolution.target.eventId,
              marketId: resolution.target.marketId,
              price: resolution.target.executablePrice,
              side: resolution.target.mappedSide,
              venue: resolution.target.venue,
            };
          }
        } else {
          const resolved = await resolveDefaultSignalBotDeliveryTarget({
            buySide,
            db: input.db,
            destinationPolicy,
            lifecycle: lifecycle.policy,
            note,
            now: new Date(),
            redis: input.redis,
            sourceBuyPrice: verifiedSourceBuyPrice,
          });
          addSignalBotCheaperAlternativeDiagnostics(
            alternativeDiagnostics,
            resolved.diagnostics,
          );
          if (resolved.resolution.target) {
            deliveryTarget = {
              eventId: resolved.resolution.target.eventId,
              marketId: resolved.resolution.target.marketId,
              price: resolved.resolution.target.executablePrice,
              side: resolved.resolution.target.mappedSide,
              venue: resolved.resolution.target.venue,
            };
          }
        }
        if (!deliveryTarget) {
          await updateSignalBotChatCursor({
            chatId,
            createdAt: note.createdAt,
            id: note.id,
            redis: input.redis,
          });
          continue;
        }
      }
      if (deliveryTarget && deliveryTarget.marketId !== note.marketId) {
        cheaperAlternatives += 1;
      }
      const { keyboard, text } = buildSignalBotMessage({
        appBaseUrl: input.config.appBaseUrl,
        buyAmountUsd: input.config.buyAmountUsd,
        chatType: state.chatType,
        cheaperAlternative,
        deliveryTarget,
        note,
        telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
      });
      const thread = await loadSignalBotThreadContext({
        chatId,
        db: input.db,
        note,
      });
      const deliveryView = buildNeutralSignalDeliveryView({
        appBaseUrl: input.config.appBaseUrl,
        buyAmountUsd: input.config.buyAmountUsd,
        kind: thread.messageKind,
        note,
        sourceSide: buySide,
        target: deliveryTarget,
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
          messageId: result.messageId,
          messageKind: thread.messageKind,
          metrics: {
            copy: buildSignalBotCopyAudit({ buySide, note }),
            delivery: {
              lifecycleRevision: lifecycle.revision,
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
    belowConfidenceNotes,
    blockedChats,
    chats: chatIds.length,
    cheaperAlternatives,
    eligibleNotes,
    nonDirectionalNotes,
    sent,
  };
}

export async function sendLatestSignalBotTestSignal(input: {
  chatId: string;
  config: SignalBotConfig;
  db: DbQuery;
  redis?: SignalBotRedisLike;
  resolveCheaperAlternative?: SignalBotCheaperAlternativeResolver;
  telegram: SignalBotTelegramClient;
}): Promise<boolean> {
  const chatState = input.redis
    ? await getSignalBotChatState(input.redis, input.chatId)
    : null;
  const notes = await loadSignalBotNotes(input.db, {
    afterCreatedAt: LATEST_CURSOR_CREATED_AT,
    afterId: LATEST_CURSOR_ID,
    descending: true,
    limit: 1,
    minConfidence: input.config.minConfidence,
  });
  const note = notes[0];
  if (!note) return false;
  const buySide = resolveSignalBotBuySide(note);
  const cheaperAlternative = buySide
    ? await (
        input.resolveCheaperAlternative ??
        (input.redis
          ? async (resolverInput) =>
              (
                await resolveDefaultSignalBotCheaperAlternative({
                  buySide: resolverInput.buySide,
                  db: input.db,
                  note: resolverInput.note,
                  redis: input.redis as SignalBotRedisLike,
                })
              ).alternative
          : async () => null)
      )({ buySide, note })
    : null;
  const { keyboard, text } = buildSignalBotMessage({
    appBaseUrl: input.config.appBaseUrl,
    buyAmountUsd: input.config.buyAmountUsd,
    chatType: chatState?.chatType,
    cheaperAlternative,
    note,
    telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
  });
  const result = await input.telegram.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: false,
    parse_mode: "MarkdownV2",
    reply_markup: keyboard,
    text,
  });
  return result.ok;
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
    input.policy.types.includes("resolved_win") ||
    input.policy.types.includes("resolved_loss");
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
  if (
    stats.outcome === "win" &&
    policy.types.includes("resolved_win") &&
    signalBotFollowthroughQualityRank(stats.dataQuality) >=
      signalBotFollowthroughQualityRank(policy.minDataQuality)
  ) {
    return "resolved_win";
  }
  if (
    stats.outcome === "loss" &&
    policy.types.includes("resolved_loss") &&
    signalBotFollowthroughQualityRank(stats.dataQuality) >=
      signalBotFollowthroughQualityRank(policy.minDataQuality)
  ) {
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
    stats.priceMoveCents >= policy.minPriceMoveCents;
  if (
    stats.joinedOrAddedWallets >= policy.minJoinedOrAdded ||
    stats.netSignalSideFlowUsd >= policy.minNetFlowUsd ||
    priceMovePass
  ) {
    return "followthrough_stats";
  }
  return null;
}

function formatSignedCentsMove(value: number | null): string {
  if (value == null) return "n/a";
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded}¢`;
}

function formatFollowthroughMarketLine(
  candidate: SignalBotFollowthroughCandidateRow,
): string {
  if (candidate.event_title && candidate.market_title) {
    return `${candidate.event_title} · ${candidate.market_title}`;
  }
  return candidate.market_title || candidate.title;
}

function formatSignalBotFollowthroughRead(input: {
  hasWalletEvidence: boolean;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  sideCopy: MarketSideCopy | null;
  stats: SignalBotFollowthroughStats;
}): string {
  const side = input.sideCopy?.plainPosition ?? "the call side";
  if (input.kind === "resolved_win") {
    return `${side} closed green. This is performance tracking, not a fresh entry.`;
  }
  if (input.kind === "resolved_loss") {
    return `${side} closed red. Treat this as performance tracking, not a fresh entry.`;
  }
  if (!input.hasWalletEvidence) {
    return "The market moved with the read, but tracked wallet follow-through is thin so far.";
  }
  if (input.stats.priceMoveCents != null && input.stats.priceMoveCents > 0) {
    return "The market moved with the call and tracked wallets have not fully faded it yet.";
  }
  if (input.stats.priceMoveCents != null && input.stats.priceMoveCents < 0) {
    return "Copy flow is still leaning with the call, but price has moved against the entry.";
  }
  return "Price has not moved much yet, but copy flow is still leaning with the call.";
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

function selectSignalBotCopyFlowHeadline(input: {
  candidate: SignalBotFollowthroughCandidateRow;
  stats: SignalBotFollowthroughStats;
}): string {
  if (isSignalBotFollowthroughCooling(input.stats)) {
    return "⚠️ Copy flow is cooling off";
  }
  if (
    input.stats.priceMoveCents != null &&
    Math.abs(input.stats.priceMoveCents) < 0.5
  ) {
    return "👀 Price is flat. Flow is not.";
  }
  const seed = [
    input.candidate.thread_root_note_id,
    input.candidate.market_id,
    input.stats.signalSide,
    input.stats.joinedOrAddedWallets,
    Math.round(input.stats.netSignalSideFlowUsd),
  ].join(":");
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return SIGNAL_BOT_COPY_FLOW_HEADLINES[
    hash % SIGNAL_BOT_COPY_FLOW_HEADLINES.length
  ];
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
    input.stats.estimatedOpenPnlUsd != null
      ? `Est. open PnL: ${formatSignedCompactUsd(
          input.stats.estimatedOpenPnlUsd,
        )}`
      : null;
  return [
    `${formatSignedCompactUsd(input.stats.netSignalSideFlowUsd)} net copy flow`,
    formatSignalBotFollowthroughActivityLine(input.stats),
    input.priceLine,
    ...(pnlLine ? [pnlLine] : []),
  ];
}

function buildSignalBotFollowthroughMessage(input: {
  candidate: SignalBotFollowthroughCandidateRow;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  stats: SignalBotFollowthroughStats;
}): string {
  const stats = input.stats;
  const side = stats.signalSide ?? "side";
  const sideCopy = stats.signalSide
    ? buildSignalBotFollowthroughSideCopy(input.candidate, stats.signalSide)
    : null;
  const sideLabel = sideCopy?.priceLabel ?? side;
  const title =
    sideCopy && shouldUseSignalBotCopyMarketLine(sideCopy)
      ? (sideCopy.marketLine ?? formatFollowthroughMarketLine(input.candidate))
      : formatFollowthroughMarketLine(input.candidate);
  const priceLine =
    stats.entryPrice != null && stats.markPrice != null
      ? `${sideLabel}: ${formatCents(stats.entryPrice)} → ${formatCents(
          stats.markPrice,
        )} (${formatSignedCentsMove(stats.priceMoveCents)})`
      : `${sideLabel}: price move unavailable`;
  const hasWalletEvidence =
    stats.joinedOrAddedWallets > 0 ||
    stats.netSignalSideFlowUsd > 0 ||
    stats.trimmedWallets > 0 ||
    stats.exitedWallets > 0;
  const header =
    input.kind === "resolved_win"
      ? "🏁 Call side won"
      : input.kind === "resolved_loss"
        ? "🏁 Call side lost"
        : hasWalletEvidence
          ? selectSignalBotCopyFlowHeadline({
              candidate: input.candidate,
              stats,
            })
          : stats.priceMoveCents != null && stats.priceMoveCents > 0
            ? "📈 Market moved with the read"
            : "⚠️ Copy flow is thin here";
  const resultLine = "Since the call:";
  const footerLine = formatSignalBotFollowthroughRead({
    hasWalletEvidence,
    kind: input.kind,
    sideCopy,
    stats,
  });
  return [
    header,
    "",
    `📍 ${title}`,
    resultLine,
    ...formatSignalBotFollowthroughStatLines({ priceLine, stats }),
    "",
    footerLine,
  ]
    .map(escapeTelegramMarkdownV2)
    .join("\n");
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
}): SignalDeliveryView {
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
        input.stats.netSignalSideFlowUsd > 0 ||
        input.stats.trimmedWallets > 0 ||
        input.stats.exitedWallets > 0,
      kind: input.kind,
      sideCopy: input.stats.signalSide
        ? buildSignalBotFollowthroughSideCopy(
            input.candidate,
            input.stats.signalSide,
          )
        : null,
      stats: input.stats,
    }),
    target,
    thread:
      input.replyToMessageId == null
        ? {}
        : { rootDeliveryId: String(input.replyToMessageId) },
    title: formatFollowthroughMarketLine(input.candidate),
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
      kind,
      stats,
    });
    const copyAudit = buildSignalBotFollowthroughCopyAudit({
      candidate,
      stats,
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
  const highConviction =
    input.result.aggregates.byExecutionPriority?.high_conviction;
  const highConvictionLine =
    highConviction?.notes && highConviction.averageRoi != null
      ? `🔥 High conviction: ${formatSignedPercent(highConviction.averageRoi)} avg vs all ${formatSignedPercent(overall.averageRoi)}`
      : null;

  const lines = [
    `📊 Hunch signals · ${periodLabel}`,
    "",
    pnlLine,
    ...(highConvictionLine ? [highConvictionLine] : []),
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
  const convictionLines = formatStatsAggregateGroup({
    amountUsd: input.buyAmountUsd,
    formatter: formatStatsExecutionPriorityLabel,
    group: result.aggregates.byExecutionPriority ?? {},
    title: "By conviction",
  });
  if (convictionLines.length > 0) lines.push(...convictionLines);
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

function formatStatsExecutionPriorityLabel(value: string): string {
  switch (value) {
    case "high_conviction":
      return "🔥 High conviction";
    case "normal":
      return "Normal";
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
    activeOnly: true,
    approxEntryAfterHours: HOLDER_RESEARCH_PERFORMANCE_APPROX_ENTRY_AFTER_HOURS,
    approxEntryBeforeHours:
      HOLDER_RESEARCH_PERFORMANCE_APPROX_ENTRY_BEFORE_HOURS,
    directionalOnly: true,
    includeOpen: true,
    includeResolved: true,
    limit: SIGNAL_BOT_STATS_AUDIT_LIMIT,
    lookbackHours: signalBotStatsPeriodHours(input.period),
    minConfidence: input.config.minConfidence,
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
    minConfidence: number;
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
        n.created_at::text as created_at,
        pt.target_meta as primary_target_meta,
        m.id as market_id,
        m.event_id,
        m.venue as market_venue,
        m.title as market_title,
        m.slug as market_slug,
        m.description as market_description,
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
        and coalesce(n.confidence, 0) >= $1
        and ${buildWalletIntelAcceptingOrdersSql({
          eventAlias: "e",
          marketAlias: "m",
        })}
        and (
          n.created_at ${comparison} $2::timestamptz
          or (n.created_at = $2::timestamptz and n.id ${comparison} $3::uuid)
        )
      order by n.created_at ${order}, n.id ${order}
      limit $4
    `,
    [input.minConfidence, input.afterCreatedAt, input.afterId, input.limit],
  );
  return rows.map(rowToSignalBotNote);
}

async function loadSignalBotEligibilityCounts(
  db: DbQuery,
  input: {
    afterCreatedAt: string;
    afterId: string;
    minConfidence: number;
  },
): Promise<{
  belowConfidence: number;
  eligible: number;
  nonDirectional: number;
  total: number;
}> {
  const { rows } = await db.query<SignalBotEligibilityCountRow>(
    `
      select
        count(*) filter (
          where n.direction in ('up', 'down')
            and coalesce(n.confidence, 0) >= $1
        )::int as eligible,
        count(*) filter (
          where n.direction in ('up', 'down')
            and coalesce(n.confidence, 0) < $1
        )::int as below_min_confidence,
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
      join unified_markets m on m.id = pt.target_id
      left join unified_events e on e.id = m.event_id
      where n.note_type = 'signal'
        and n.status = 'active'
        and n.producer_type = 'holder_research'
        and ${buildWalletIntelAcceptingOrdersSql({
          eventAlias: "e",
          marketAlias: "m",
        })}
        and (
          n.created_at > $2::timestamptz
          or (n.created_at = $2::timestamptz and n.id > $3::uuid)
        )
    `,
    [input.minConfidence, input.afterCreatedAt, input.afterId],
  );
  const row = rows[0];
  return {
    belowConfidence: Math.max(
      0,
      Math.trunc(toNumber(row?.below_min_confidence) ?? 0),
    ),
    eligible: Math.max(0, Math.trunc(toNumber(row?.eligible) ?? 0)),
    nonDirectional: Math.max(
      0,
      Math.trunc(toNumber(row?.non_directional) ?? 0),
    ),
    total: Math.max(0, Math.trunc(toNumber(row?.total) ?? 0)),
  };
}

export class TelegramBotApiClient implements SignalBotTelegramClient {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
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

function parseRatio(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
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

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToSignalBotNote(row: SignalBotNoteRow): SignalBotNote {
  const holderMeta = asObject(row.holder_target_meta);
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
    createdAt: toIso(row.created_at),
    primaryTargetMeta: asObject(row.primary_target_meta),
    marketId: row.market_id,
    eventId: row.event_id,
    marketVenue: row.market_venue,
    marketTitle: row.market_title,
    marketSlug: row.market_slug,
    marketDescription: row.market_description,
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
  note: Pick<SignalBotNote, "bestAsk" | "bestBid" | "lastPrice">,
  side: "NO" | "YES",
): number | null {
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

function resolveMarketBuyPrice(
  market: Pick<ClusterMarketSummary, "noMid" | "yesAsk" | "yesBid" | "yesMid">,
  side: "NO" | "YES",
): number | null {
  const bid = normalizeProbability(market.yesBid);
  const ask = normalizeProbability(market.yesAsk);
  const yesMid = normalizeProbability(market.yesMid);
  const noMid = normalizeProbability(market.noMid);
  return side === "YES"
    ? (ask ?? yesMid ?? bid)
    : bid != null
      ? 1 - bid
      : noMid;
}

function formatCents(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}¢`;
}

type SignalBotOutcomeLabelMode = "button" | "price";

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

function formatSignalBotOutcomeDisplayLabel(
  note: SignalBotMarketCopySource,
  side: "NO" | "YES",
  mode: SignalBotOutcomeLabelMode,
): string {
  const copy = buildSignalBotSideCopy(note, side);
  return mode === "button" ? copy.buttonLabel : copy.priceLabel;
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

function shouldUseSignalBotCopyMarketLine(copy: MarketSideCopy): boolean {
  return copy.copyKind !== "generic" || copy.sideLabel !== copy.side;
}

function buildSignalBotCopyAudit(input: {
  buySide: "NO" | "YES" | null;
  note: SignalBotNote;
}) {
  const yesCopy = buildSignalBotSideCopy(input.note, "YES");
  const noCopy = buildSignalBotSideCopy(input.note, "NO");
  const activeCopy =
    input.buySide === "YES" ? yesCopy : input.buySide === "NO" ? noCopy : null;
  return {
    activeSide: input.buySide,
    copyVersion: SIGNAL_BOT_COPY_VERSION,
    marketSegment: input.note.marketSegment,
    priceSnapshot: {
      bestAsk: input.note.bestAsk,
      bestBid: input.note.bestBid,
      lastPrice: input.note.lastPrice,
    },
    sideCopy: compactSignalBotCopyAudit(activeCopy),
    sides: {
      YES: compactSignalBotCopyAudit(yesCopy),
      NO: compactSignalBotCopyAudit(noCopy),
    },
  };
}

function buildSignalBotFollowthroughCopyAudit(input: {
  candidate: SignalBotFollowthroughCandidateRow;
  stats: SignalBotFollowthroughStats;
}) {
  const yesCopy = buildSignalBotFollowthroughSideCopy(input.candidate, "YES");
  const noCopy = buildSignalBotFollowthroughSideCopy(input.candidate, "NO");
  const activeCopy =
    input.stats.signalSide === "YES"
      ? yesCopy
      : input.stats.signalSide === "NO"
        ? noCopy
        : null;
  return {
    activeSide: input.stats.signalSide,
    copyVersion: SIGNAL_BOT_COPY_VERSION,
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

function formatSignalBotMarketEmoji(
  note: Pick<SignalBotNote, "marketSegment">,
): string | null {
  switch (note.marketSegment) {
    case "sports_soccer_game":
      return "⚽";
    case "sports_tennis_game":
      return "🎾";
    case "sports_baseball_game":
      return "⚾";
    case "sports_basketball_game":
      return "🏀";
    case "sports_cricket_game":
      return "🏏";
    case "sports_esports_game":
      return "🎮";
    case "sports_outright":
      return "🏆";
    case "sports_other_game":
      return "🏟️";
    case "crypto_btc":
      return "₿";
    case "crypto_eth":
    case "crypto_alt":
      return "🪙";
    case "macro_rates":
      return "🏦";
    case "macro_commodities":
      return "🛢️";
    case "macro_equities":
      return "📈";
    case "politics_geo":
      return "🌐";
    case "tech_ai":
      return "🤖";
    case "mentions":
      return "📣";
    case "entertainment":
      return "🎬";
    case "weather":
      return "🌦️";
    case "health":
      return "🏥";
    default:
      return null;
  }
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

function shouldMentionSignalBotPriceInBody(price: number | null): boolean {
  return price != null && (price <= 0.15 || price >= 0.85);
}

function formatSignalBotActorLabel(note: SignalBotNote): string {
  if (note.holderActorMode === "sharp_cluster") return "these wallets";
  return (
    normalizeSignalBotPublicHolderLabel(note.holderIdentityDisplayName) ||
    normalizeSignalBotPublicHolderLabel(note.holderDisplayName) ||
    "this wallet"
  );
}

function formatSignalBotPositionContext(note: SignalBotNote): string {
  const details: string[] = [];
  if (note.holderPositionUsd != null && note.holderPositionUsd > 0) {
    details.push(`${formatCompactUsd(note.holderPositionUsd)} still on`);
  }
  if (note.holderOpenPnlUsd != null) {
    details.push(`${formatSignedCompactUsd(note.holderOpenPnlUsd)} open PnL`);
  }
  return details.length > 0 ? `, with ${details.join(" and ")}` : "";
}

function formatSignalBotWhyInterestingLine(input: {
  buySide: "NO" | "YES" | null;
  note: SignalBotNote;
  price: number | null;
}): string | null {
  const holderSide = input.note.holderSide;
  if (holderSide && input.buySide && holderSide !== input.buySide) return null;
  const side = holderSide ?? input.buySide;
  if (!side) return null;
  const sideCopy = buildSignalBotSideCopy(input.note, side);
  const sideLabel = sideCopy.plainPosition ?? side;
  const marketTitle = input.note.marketTitle?.trim();
  const priceSubject =
    sideCopy.copyKind === "team_yes_no" && side === "YES" && marketTitle
      ? marketTitle
      : sideCopy.sideLabel || sideCopy.priceLabel || side;
  const actor = formatSignalBotActorLabel(input.note);
  const positionContext = formatSignalBotPositionContext(input.note);
  const priceIsUseful = shouldMentionSignalBotPriceInBody(input.price);
  if (input.note.holderActorMode === "sharp_cluster") {
    if (priceIsUseful && input.price != null) {
      return `The interesting part is that ${priceSubject} is still around ${formatCents(
        input.price,
      )}, while these wallets are still leaning that way${positionContext}.`;
    }
    return `The interesting part is that these wallets are still leaning ${sideLabel}${positionContext}.`;
  }
  if (priceIsUseful && input.price != null) {
    return `${priceSubject} is still around ${formatCents(
      input.price,
    )}, but ${actor} has not backed off${positionContext}.`;
  }
  return `${actor} is still holding ${sideLabel}${positionContext}.`;
}

function formatSignalBotWhyItMattersLines(note: SignalBotNote): string[] {
  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const rawBullet of note.holderCredentialBullets) {
    const bullet = rawBullet.trim();
    if (!bullet || seen.has(bullet)) continue;
    seen.add(bullet);
    bullets.push(bullet);
    if (bullets.length >= 3) break;
  }
  if (bullets.length === 0) return [];
  return ["Why it matters:", ...bullets.map((bullet) => `• ${bullet}`)];
}

function formatSignalContextLine(note: SignalBotNote): string | null {
  const external = asObject(note.modelMeta.external_research);
  const summary =
    typeof external.summary === "string"
      ? stripMarkdownAndSources(external.summary)
      : "";
  const timingMatch = summary.match(
    /public (?:info|information|context|news) ([^.]{0,80})\./i,
  );
  if (timingMatch?.[0]) {
    return `📰 ${truncateAtBoundary(timingMatch[0], SIGNAL_CONTEXT_MAX_CHARS)}`;
  }
  if (summary)
    return `📰 ${truncateAtBoundary(summary, SIGNAL_CONTEXT_MAX_CHARS)}`;
  const caveats = Array.isArray(note.modelMeta.caveats)
    ? note.modelMeta.caveats.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const caveat = caveats[0]?.trim();
  if (caveat)
    return `⚠️ ${truncateAtBoundary(caveat, SIGNAL_CONTEXT_MAX_CHARS)}`;
  if (note.rationale)
    return `💡 ${truncateAtBoundary(note.rationale, SIGNAL_CONTEXT_MAX_CHARS)}`;
  return null;
}

function stripMarkdownAndSources(value: string): string {
  return value
    .replace(/\[\[?\d+\]?\]\([^)]*$/g, "")
    .replace(/\[[^\]]+\]\(https?:\/\/[^)\s]*$/gi, "")
    .replace(/\[\[?\d+\]?\]\([^)]+\)/g, "")
    .replace(/\[(\d+)\]\(https?:\/\/[^)]+\)/gi, "")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[\[?\d+\]?\]?/g, "")
    .replace(/[*_`~>#]/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max);
  const boundary = Math.max(
    clipped.lastIndexOf(". "),
    clipped.lastIndexOf("; "),
  );
  if (boundary >= Math.floor(max * 0.5)) return clipped.slice(0, boundary + 1);
  const space = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, space > 0 ? space : max - 3).trimEnd()}...`;
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
      : "Signal buttons open Hunch web links.",
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
    "/test_signal [channel_id] - send latest eligible signal",
    "/test_trade <market_id or URL> - preview a private trade card",
  ].join("\n");
}
