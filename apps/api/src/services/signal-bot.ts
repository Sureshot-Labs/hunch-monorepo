import { requestFreshMarketPrices, type PriceRefreshRedis } from "@hunch/infra";
import {
  getMarketPriceSideState,
  type MarketPriceBlocker,
} from "@hunch/shared";

import type { DbQuery } from "../db.js";
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
  defaultSignalBotFollowthroughPolicy,
  resolveSignalBotFollowthroughPolicy,
  type SignalBotFollowthroughDataQuality,
  type SignalBotFollowthroughPolicy,
} from "./signal-bot-followthrough-policy.js";
import {
  buildSignalBotMiniAppEventUrl,
  buildSignalBotMiniAppHolderUrl,
  buildSignalBotMiniAppTradeUrl,
  normalizeTelegramMiniAppLinkBase,
} from "./signal-bot-mini-app-links.js";
import { buildWalletIntelAcceptingOrdersSql } from "./wallet-intel-market-eligibility.js";
import {
  outcomeLabelOrSide,
  parseMarketOutcomes,
} from "./wallet-intel-helpers.js";

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
};

export type SignalBotCommand =
  | "disable_signals"
  | "enable_signals"
  | "help"
  | "start"
  | "stats"
  | "status"
  | "test_followthrough"
  | "test_signal";

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

export type TelegramBotUpdate = {
  update_id: number;
  message?: TelegramBotMessage;
};

export type TelegramBotUser = {
  id: number;
  is_bot: boolean;
  username?: string;
};

export type TelegramInlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
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
  getUpdates(input: {
    offset: number | null;
    timeoutSec: number;
  }): Promise<TelegramBotUpdate[]>;
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
  eventTitle: string | null;
  outcomes: string[] | null;
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
  event_title: string | null;
  category: string | null;
  event_category: string | null;
  series_key: string | null;
  series_title: string | null;
  close_time: Date | string | null;
  expiration_time: Date | string | null;
  outcomes: string | null;
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
  target_meta: unknown;
  market_id: string;
  event_id: string | null;
  market_title: string | null;
  event_title: string | null;
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
const OUTCOME_LABEL_MAX_CHARS = 3;
const OUTCOME_LABEL_FULL_MAX_CHARS = 14;
const DEFAULT_CURSOR_ID = "00000000-0000-0000-0000-000000000000";
const LATEST_CURSOR_CREATED_AT = "9999-12-31T23:59:59.999Z";
const LATEST_CURSOR_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const SEND_FAILURE_COOLDOWN_SEC = 300;
const FOLLOWTHROUGH_RETRY_COOLDOWN_MS = 15 * 60_000;
const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const OUTCOME_LABEL_VOWELS = /[AEIOUY]/g;
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
    case "start":
      return "start";
    case "stats":
      return "stats";
    case "status":
      return "status";
    case "test_followthrough":
      return "test_followthrough";
    case "test_signal":
      return "test_signal";
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

export function escapeTelegramMarkdownV2(value: string): string {
  return value.replace(MARKDOWN_V2_SPECIAL_CHARS, (char) => `\\${char}`);
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
    if (!holderUrl || didLinkHolder || candidates.length === 0) {
      return escapeTelegramMarkdownV2(value);
    }
    const match = findSignalBotHolderLinkMatch(value, candidates);
    if (!match) return escapeTelegramMarkdownV2(value);
    didLinkHolder = true;
    return renderSignalBotHolderLinkedText(value, match, holderUrl);
  };
}

function buildSignalBotHolderLinkCandidates(note: SignalBotNote): string[] {
  const collisionLabels = buildSignalBotHolderLinkCollisionLabels(note);
  const candidates: string[] = [];
  for (const raw of [note.holderIdentityDisplayName, note.holderDisplayName]) {
    const label = normalizeSignalBotHolderLinkLabel(raw);
    if (!label) continue;
    candidates.push(label);
    const stripped = normalizeSignalBotHolderLinkLabel(
      label.replace(/^@+/, ""),
    );
    if (stripped && stripped !== label) candidates.push(stripped);
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

export function buildSignalBotMessage(input: {
  appBaseUrl: string;
  buyAmountUsd: number;
  cheaperAlternative?: SignalBotCheaperAlternative | null;
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
  const credentialLines = formatSignalCredentialLines(note);
  const marketTitleLine = formatMarketTitleLine(note);
  const priceLine = formatPriceLine(note);
  const timeLeftLine = formatTimeLeftLine(note);
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
  const holderButtonUrl = holderUrl
    ? buildSignalBotMiniAppHolderUrl({
        address: note.holderAddress,
        chain: note.holderChain,
        eventId: note.eventId,
        marketId: note.marketId,
        miniAppLinkBase: input.telegramMiniAppLinkBase,
        noteId: note.id,
        side: note.holderSide,
      }) ?? holderUrl
    : null;
  const marketButtonUrl =
    buildSignalBotMiniAppEventUrl({
      eventId: note.eventId,
      marketId: note.marketId,
      miniAppLinkBase: input.telegramMiniAppLinkBase,
      side: buySide,
    }) ?? marketUrl;
  const titleMarkdown = marketUrl
    ? `*[${title}](${escapeTelegramMarkdownV2Url(marketUrl)})*`
    : `*${title}*`;
  const renderBodyText = createSignalBotBodyTextRenderer(note, holderUrl);
  const summary = renderBodyText(note.description);
  const categoryEmoji = formatSignalBotMarketEmoji(note);
  const titleLine = categoryEmoji
    ? `${categoryEmoji} ${titleMarkdown}`
    : titleMarkdown;
  const metaLine = [formatSignalBotSignalLabel(note), priceLine, timeLeftLine]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const lines = [
    titleLine,
    escapeTelegramMarkdownV2(metaLine),
    ...(marketTitleLine
      ? [escapeTelegramMarkdownV2(`📍 ${marketTitleLine}`)]
      : []),
    "",
    summary,
    ...(credentialLines.length > 0
      ? ["", ...credentialLines.map(escapeTelegramMarkdownV2)]
      : []),
    ...(contextLine ? ["", renderBodyText(contextLine)] : []),
  ];

  const keyboardRows: TelegramInlineKeyboard["inline_keyboard"] = [];
  if (note.eventId && note.marketId && buySide) {
    const baseTradeUrl = buildSignalBotTradeUrl({
      amountUsd: input.buyAmountUsd,
      appBaseUrl: input.appBaseUrl,
      eventId: note.eventId,
      marketId: note.marketId,
      side: buySide,
    });
    const primaryTradeUrl =
      buildSignalBotMiniAppTradeUrl({
        amountUsd: input.buyAmountUsd,
        eventId: note.eventId,
        marketId: note.marketId,
        miniAppLinkBase: input.telegramMiniAppLinkBase,
        side: buySide,
      }) ?? baseTradeUrl;
    keyboardRows.push([
      {
        text: formatSignalBotBuyButtonText({
          price,
          side: buySide,
          sideLabel: formatSignalBotOutcomeDisplayLabel(
            note,
            buySide,
            "button",
          ),
          venue: note.marketVenue,
        }),
        url: primaryTradeUrl,
      },
    ]);
    if (input.cheaperAlternative && input.cheaperAlternative.side === buySide) {
      const cheaperTradeWebUrl = buildSignalBotTradeUrl({
        amountUsd: input.buyAmountUsd,
        appBaseUrl: input.appBaseUrl,
        eventId: input.cheaperAlternative.eventId,
        marketId: input.cheaperAlternative.marketId,
        side: input.cheaperAlternative.side,
      });
      keyboardRows.push([
        {
          text: formatSignalBotCheaperButtonText({
            alternative: input.cheaperAlternative,
            sideLabel: formatSignalBotOutcomeDisplayLabel(
              note,
              buySide,
              "button",
            ),
          }),
          url:
            buildSignalBotMiniAppTradeUrl({
              amountUsd: input.buyAmountUsd,
              eventId: input.cheaperAlternative.eventId,
              marketId: input.cheaperAlternative.marketId,
              miniAppLinkBase: input.telegramMiniAppLinkBase,
              side: input.cheaperAlternative.side,
            }) ?? cheaperTradeWebUrl,
        },
      ]);
    }
    keyboardRows.push(
      buildSignalBotLinkRow({
        holderActorMode: note.holderActorMode,
        holderSide: note.holderSide,
        holderOpenPnlUsd: note.holderOpenPnlUsd,
        holderPositionUsd: note.holderPositionUsd,
        holderUrl: holderButtonUrl,
        holderSideLabel: note.holderSide
          ? formatSignalBotOutcomeDisplayLabel(note, note.holderSide, "button")
          : null,
        marketUrl: marketButtonUrl ?? baseTradeUrl,
      }),
    );
  } else if (note.eventId) {
    keyboardRows.push(
      buildSignalBotLinkRow({
        holderActorMode: note.holderActorMode,
        holderSide: note.holderSide,
        holderOpenPnlUsd: note.holderOpenPnlUsd,
        holderPositionUsd: note.holderPositionUsd,
        holderUrl: holderButtonUrl,
        holderSideLabel: note.holderSide
          ? formatSignalBotOutcomeDisplayLabel(note, note.holderSide, "button")
          : null,
        marketUrl:
          marketButtonUrl ??
          buildSignalBotOpenMarketUrl({
            appBaseUrl: input.appBaseUrl,
            eventId: note.eventId,
            marketId: note.marketId,
            side: buySide,
          }),
      }),
    );
  } else if (holderButtonUrl) {
    keyboardRows.push(
      buildSignalBotLinkRow({
        holderActorMode: note.holderActorMode,
        holderSide: note.holderSide,
        holderOpenPnlUsd: note.holderOpenPnlUsd,
        holderPositionUsd: note.holderPositionUsd,
        holderSideLabel: note.holderSide
          ? formatSignalBotOutcomeDisplayLabel(note, note.holderSide, "button")
          : null,
        holderUrl: holderButtonUrl,
        marketUrl: null,
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
  holderActorMode: "none" | "sharp_cluster" | "single_holder" | null;
  holderOpenPnlUsd: number | null;
  holderPositionUsd: number | null;
  holderSide: "NO" | "YES" | null;
  holderSideLabel: string | null;
  holderUrl: string | null;
  marketUrl: string | null;
}): TelegramInlineKeyboard["inline_keyboard"][number] {
  const row: TelegramInlineKeyboard["inline_keyboard"][number] = [];
  if (input.holderUrl) {
    row.push({
      text: formatHolderButtonText(input),
      url: input.holderUrl,
    });
  }
  if (input.marketUrl) {
    row.push({
      text: "↗️ Open market",
      url: input.marketUrl,
    });
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
  buyAmountUsd: number;
  candidate: SignalBotFollowthroughCandidateRow;
  kind: Extract<
    SignalBotMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  stats: SignalBotFollowthroughStats;
  telegramMiniAppLinkBase?: string | null;
}): TelegramInlineKeyboard | undefined {
  if (
    input.kind !== "followthrough_stats" ||
    input.stats.state !== "open" ||
    !input.candidate.event_id
  ) {
    return undefined;
  }

  const eventId = input.candidate.event_id;
  const marketId = input.candidate.market_id;
  const side = input.stats.signalSide;
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [];

  if (side) {
    const buyPrice = resolveSignalBotFollowthroughBuyPrice({
      candidate: input.candidate,
      side,
    });
    if (
      input.candidate.accepting_orders === true &&
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
        {
          text: formatSignalBotBuyButtonText({
            price: buyPrice,
            side,
            sideLabel: formatSignalBotOutcomeDisplayLabel(
              {
                eventTitle: input.candidate.event_title,
                marketTitle: input.candidate.market_title,
                outcomes: null,
              },
              side,
              "button",
            ),
            venue: input.candidate.venue,
          }),
          url:
            buildSignalBotMiniAppTradeUrl({
              amountUsd: input.buyAmountUsd,
              eventId,
              marketId,
              miniAppLinkBase: input.telegramMiniAppLinkBase,
              side,
            }) ?? webTradeUrl,
        },
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
    {
      text: "↗️ Open market",
      url:
        buildSignalBotMiniAppEventUrl({
          eventId,
          marketId,
          miniAppLinkBase: input.telegramMiniAppLinkBase,
          side,
        }) ?? webMarketUrl,
    },
  ]);

  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

async function shouldAllowSignalBotFollowthroughBuyCta(input: {
  candidate: SignalBotFollowthroughCandidateRow;
  db: DbQuery;
  redis: SignalBotRedisLike;
  stats: SignalBotFollowthroughStats;
}): Promise<boolean> {
  const side = input.stats.signalSide;
  if (
    !side ||
    input.stats.state !== "open" ||
    input.candidate.accepting_orders !== true
  ) {
    return false;
  }
  const buyPrice = resolveSignalBotFollowthroughBuyPrice({
    candidate: input.candidate,
    side,
  });
  if (
    !isSignalBotFollowthroughBuyCtaEligible({
      allowBuyCta: true,
      buyPrice,
      stats: input.stats,
    })
  ) {
    return false;
  }
  const priceGuard = await loadSignalBotPriceGuardBlockers({
    buySide: side,
    db: input.db,
    note: { marketId: input.candidate.market_id },
    redis: input.redis,
  });
  return !priceGuard.defer && priceGuard.blockers.length === 0;
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
}): Promise<boolean> {
  const command = parseSignalBotCommand(input.message.text, input.botUsername);
  if (!command) return false;
  const chatId = String(input.message.chat.id);
  const targetChatId = parseSignalBotCommandTargetChatId(input.message.text);
  const isAdmin = isSignalBotAdmin(input.config, input.message.from?.id);

  if (
    !isAdmin &&
    (command === "disable_signals" ||
      command === "enable_signals" ||
      command === "stats" ||
      command === "test_followthrough" ||
      command === "test_signal")
  ) {
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
          : "No eligible follow-through preview found.",
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
  return true;
}

export async function pollSignalBotCommands(input: {
  botUsername?: string | null;
  config: SignalBotConfig;
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
  telegram: SignalBotTelegramClient;
}): Promise<number> {
  const offset = await readSignalBotUpdateOffset(input.redis);
  const updates = await input.telegram.getUpdates({
    offset,
    timeoutSec: input.config.pollTimeoutSec,
  });
  let handled = 0;
  for (const update of updates) {
    if (update.message) {
      const didHandle = await handleSignalBotCommand({
        botUsername: input.botUsername,
        config: input.config,
        message: update.message,
        redis: input.redis,
        sendMessage: (message) => input.telegram.sendMessage(message),
        sendStatsReport: input.sendStatsReport,
        sendTestFollowthrough: input.sendTestFollowthrough,
        sendTestSignal: input.sendTestSignal,
      });
      if (didHandle) handled += 1;
    }
    await writeSignalBotUpdateOffset(input.redis, update.update_id + 1);
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
  defer: boolean;
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
    return { blockers: [], defer: false, timedOut: false };
  }
  try {
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
      return { blockers: [], defer: true, timedOut: result.timedOut };
    }
    if (!marketState.fresh || result.timedOut) {
      return {
        blockers: ["live_price_stale"],
        defer: true,
        timedOut: result.timedOut,
      };
    }
    return {
      blockers: getMarketPriceSideState(marketState.priceState, input.buySide)
        .blockers,
      defer: false,
      timedOut: false,
    };
  } catch (error) {
    console.warn("[signal-bot] price guard skipped", {
      error: error instanceof Error ? error.message : String(error),
      marketId: input.note.marketId,
    });
    return { blockers: [], defer: false, timedOut: false };
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

function isMissingSignalBotMessagesTable(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "42P01"
  );
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

export async function publishSignalBotTick(input: {
  config: SignalBotConfig;
  db: DbQuery;
  resolveCheaperAlternative?: SignalBotCheaperAlternativeResolver;
  redis: SignalBotRedisLike;
  telegram: SignalBotTelegramClient;
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
      const sendCooldown = await input.redis.get(
        signalBotSendCooldownKey(chatId, note.id),
      );
      if (sendCooldown) break;
      const buySide = resolveSignalBotBuySide(note);
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
      }
      let cheaperAlternative: SignalBotCheaperAlternative | null = null;
      if (buySide) {
        if (input.resolveCheaperAlternative) {
          cheaperAlternative = await input.resolveCheaperAlternative({
            buySide,
            note,
          });
        } else {
          const resolved = await resolveDefaultSignalBotCheaperAlternative({
            buySide,
            db: input.db,
            note,
            redis: input.redis,
          });
          cheaperAlternative = resolved.alternative;
          addSignalBotCheaperAlternativeDiagnostics(
            alternativeDiagnostics,
            resolved.diagnostics,
          );
        }
      }
      if (cheaperAlternative) cheaperAlternatives += 1;
      const { keyboard, text } = buildSignalBotMessage({
        appBaseUrl: input.config.appBaseUrl,
        buyAmountUsd: input.config.buyAmountUsd,
        cheaperAlternative,
        note,
        telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
      });
      const thread = await loadSignalBotThreadContext({
        chatId,
        db: input.db,
        note,
      });
      const result = await sendSignalBotMessageWithReplyFallback({
        message: {
          chat_id: chatId,
          disable_web_page_preview: false,
          parse_mode: "MarkdownV2",
          reply_markup: keyboard,
          text,
        },
        replyToMessageId: thread.replyToMessageId,
        telegram: input.telegram,
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
    now,
    policy,
  });
  for (const candidate of candidates) {
    const stats = await buildSignalBotFollowthroughStats({
      asOf: now,
      candidate,
      db: input.db,
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
    const allowBuyCta =
      input.redis != null
        ? await shouldAllowSignalBotFollowthroughBuyCta({
            candidate,
            db: input.db,
            redis: input.redis,
            stats,
          })
        : false;
    const keyboard = buildSignalBotFollowthroughKeyboard({
      allowBuyCta,
      appBaseUrl: input.config.appBaseUrl,
      buyAmountUsd: input.config.buyAmountUsd,
      candidate,
      kind,
      stats,
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
          pt.target_meta,
          m.id as market_id,
          m.event_id,
          m.title as market_title,
          e.title as event_title,
          m.venue,
          m.best_bid,
          m.best_ask,
          m.last_price,
          m.resolved_outcome,
          m.resolved_outcome_pct::text as resolved_outcome_pct,
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
              and not exists (
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
            or (
              $2::boolean
              and not exists (
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
        select s.shares, s.size_usd
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
  for (const row of flows) {
    const isSignalSide = row.outcome_side === signalSide;
    const baselineSharesRaw = toNumber(row.baseline_shares);
    const hasBaselineSnapshot = baselineSharesRaw != null;
    const baselineShares = baselineSharesRaw ?? 0;
    const latestShares = toNumber(row.latest_shares);
    const latestSizeUsd = toNumber(row.latest_size_usd);
    const positiveUsd = toNumber(row.positive_usd) ?? 0;
    const negativeUsd = toNumber(row.negative_usd) ?? 0;
    const netUsd = toNumber(row.net_usd) ?? 0;
    const netShares = toNumber(row.net_shares) ?? 0;
    const hadBaseline = baselineShares > 1e-9;
    const hasLatestSnapshot = latestShares != null || latestSizeUsd != null;
    const hasLatestPosition =
      (latestShares ?? 0) > 1e-9 || (latestSizeUsd ?? 0) > 0;
    if (!hasBaselineSnapshot) missingBaseline += 1;
    if (latestShares == null) missingLatest += 1;
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
        hasLatestSnapshot &&
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
  let dataQuality: SignalBotFollowthroughDataQuality = "any";
  if (flows.length > 0) dataQuality = "usable";
  if (
    flows.length > 0 &&
    missingBaseline === 0 &&
    missingLatest === 0 &&
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
  if (
    policy.requirePositiveFlowForStats &&
    stats.netSignalSideFlowUsd <= 0
  ) {
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
  const title =
    input.candidate.event_title && input.candidate.market_title
      ? `${input.candidate.event_title} · ${input.candidate.market_title}`
      : input.candidate.market_title || input.candidate.title;
  const priceLine =
    stats.entryPrice != null && stats.markPrice != null
      ? `${side}: ${formatCents(stats.entryPrice)} → ${formatCents(
          stats.markPrice,
        )} (${formatSignedCentsMove(stats.priceMoveCents)})`
      : `${side}: price move unavailable`;
  const flowLine = `${formatSignedCompactUsd(
    stats.netSignalSideFlowUsd,
  )} net tracked ${side} flow`;
  const activityLine = `${stats.joinedOrAddedWallets} joined/added · ${
    stats.trimmedWallets
  } trimmed · ${stats.stillHoldingWallets} still hold`;
  const pnlLine =
    stats.estimatedOpenPnlUsd != null
      ? `Est. open PnL: ${formatSignedCompactUsd(stats.estimatedOpenPnlUsd)}`
      : null;
  const hasWalletEvidence =
    stats.joinedOrAddedWallets > 0 || stats.netSignalSideFlowUsd > 0;
  const header =
    input.kind === "resolved_win"
      ? "🏁 Closed green"
      : input.kind === "resolved_loss"
        ? "🏁 Closed red"
        : hasWalletEvidence
          ? "🔥 Wallets followed the read"
          : "📈 Market moved after the read";
  const resultLine =
    input.kind === "resolved_win"
      ? "Signal side won."
      : input.kind === "resolved_loss"
        ? "Signal side lost."
        : "Since this signal:";
  const footerLine =
    input.kind === "followthrough_stats" && !hasWalletEvidence
      ? "Price moved after the signal; tracked wallet flow is not confirmed."
      : "Tracked wallets after the signal.";
  return [
    header,
    "",
    title,
    resultLine,
    flowLine,
    activityLine,
    priceLine,
    ...(pnlLine ? [pnlLine] : []),
    "",
    footerLine,
  ]
    .map(escapeTelegramMarkdownV2)
    .join("\n");
}

export async function publishSignalBotFollowthroughTick(input: {
  config: SignalBotConfig;
  db: DbQuery;
  now?: Date;
  redis: SignalBotRedisLike;
  telegram: SignalBotTelegramClient;
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
  const now = input.now ?? new Date();
  const chatIds = await input.redis.sMembers(CHAT_SET_KEY);
  const candidates = await loadSignalBotFollowthroughCandidates({
    chatIds,
    db: input.db,
    now,
    policy,
  });
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
    const allowBuyCta = await shouldAllowSignalBotFollowthroughBuyCta({
      candidate,
      db: input.db,
      redis: input.redis,
      stats,
    });
    const keyboard = buildSignalBotFollowthroughKeyboard({
      allowBuyCta,
      appBaseUrl: input.config.appBaseUrl,
      buyAmountUsd: input.config.buyAmountUsd,
      candidate,
      kind,
      stats,
      telegramMiniAppLinkBase: input.config.telegramMiniAppLinkBase,
    });
    const result = await sendSignalBotMessageWithReplyFallback({
      message: {
        chat_id: candidate.chat_id,
        disable_web_page_preview: true,
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
        text,
      },
      replyToMessageId,
      telegram: input.telegram,
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
        e.title as event_title,
        m.category,
        e.category as event_category,
        e.series_key,
        e.series_title,
        m.close_time,
        m.expiration_time,
        m.outcomes,
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
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
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
    eventTitle: row.event_title,
    outcomes: parseMarketOutcomes(row.outcomes),
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

function resolveSidePrice(
  note: SignalBotNote,
  side: "NO" | "YES",
): number | null {
  const yesPrice =
    note.bestBid != null && note.bestAsk != null
      ? (note.bestBid + note.bestAsk) / 2
      : note.lastPrice;
  if (yesPrice == null) return null;
  return side === "YES" ? yesPrice : 1 - yesPrice;
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

function normalizeAlnumUpper(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "").toUpperCase();
}

function abbreviateOutcomeLabel(
  label: string,
  maxLength = OUTCOME_LABEL_MAX_CHARS,
): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;

  const words = trimmed
    .split(/[\s/_-]+/g)
    .map(normalizeAlnumUpper)
    .filter(Boolean);
  if (words.length > 1) {
    const initials = words.map((word) => word[0]).join("");
    if (initials.length >= maxLength) return initials.slice(0, maxLength);
    const consonantTail = words
      .map((word) => word.slice(1).replace(OUTCOME_LABEL_VOWELS, ""))
      .join("");
    const fallbackTail = words.map((word) => word.slice(1)).join("");
    return `${initials}${consonantTail}${fallbackTail}`.slice(0, maxLength);
  }

  const normalized = words[0] ?? normalizeAlnumUpper(trimmed);
  if (!normalized) return trimmed.toUpperCase().slice(0, maxLength);
  const consonants = normalized.replace(OUTCOME_LABEL_VOWELS, "");
  if (consonants.length >= maxLength) return consonants.slice(0, maxLength);
  if (normalized.length >= maxLength) return normalized.slice(0, maxLength);
  return normalized;
}

type SignalBotOutcomeLabelMode = "button" | "price";

function formatReadableOutcomeLabel(label: string): string {
  const trimmed = label.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= OUTCOME_LABEL_FULL_MAX_CHARS) return trimmed;
  return abbreviateOutcomeLabel(trimmed);
}

function formatShortSignalBotMarketLabel(
  value: string | null | undefined,
): string | null {
  const label = value?.trim().replace(/\s+/g, " ");
  if (!label || label.length > OUTCOME_LABEL_FULL_MAX_CHARS) return null;
  const upper = label.toUpperCase();
  if (upper === "YES" || upper === "NO") return null;
  return label;
}

function formatSignalBotGenericOutcomeButtonLabel(
  note: Pick<SignalBotNote, "marketTitle">,
  side: "NO" | "YES",
): string | null {
  const base = formatShortSignalBotMarketLabel(note.marketTitle);
  if (!base) return null;
  const label = side === "YES" ? base : `NO ${base}`;
  return label.length <= OUTCOME_LABEL_FULL_MAX_CHARS ? label : null;
}

function formatSignalBotOutcomeDisplayLabel(
  note: Pick<SignalBotNote, "eventTitle" | "marketTitle" | "outcomes">,
  side: "NO" | "YES",
  mode: SignalBotOutcomeLabelMode,
): string {
  const label = outcomeLabelOrSide(note.outcomes, side);
  const upper = label.trim().toUpperCase();
  if (upper === "YES" || upper === "NO") {
    if (mode === "button") {
      return formatSignalBotGenericOutcomeButtonLabel(note, side) ?? side;
    }
    return side;
  }
  return formatReadableOutcomeLabel(label);
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

function formatPriceLine(note: SignalBotNote): string | null {
  const yes = resolveSidePrice(note, "YES");
  if (yes == null) return null;
  const yesLabel = formatSignalBotOutcomeDisplayLabel(note, "YES", "price");
  const noLabel = formatSignalBotOutcomeDisplayLabel(note, "NO", "price");
  return `${yesLabel} ${formatCents(yes)} / ${noLabel} ${formatCents(1 - yes)}`;
}

function formatTimeLeftLine(
  note: Pick<SignalBotNote, "closeTime" | "createdAt" | "expirationTime">,
): string | null {
  const raw = note.closeTime ?? note.expirationTime;
  if (!raw) return null;
  const endMs = new Date(raw).getTime();
  const startMs = new Date(note.createdAt).getTime();
  if (
    !Number.isFinite(endMs) ||
    !Number.isFinite(startMs) ||
    endMs <= startMs
  ) {
    return null;
  }

  const minutes = Math.max(1, Math.round((endMs - startMs) / 60_000));
  if (minutes < 60) return `⏳ ${minutes}m left`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `⏳ ${hours}h left`;

  const days = Math.round(hours / 24);
  if (days < 14) return `⏳ ${days}d left`;

  return `⏳ ${Math.round(days / 7)}w left`;
}

function formatSignalCredentialLines(note: SignalBotNote): string[] {
  const bullets = note.holderCredentialBullets.slice(0, 2);
  if (bullets.length === 0) return [];
  const header =
    note.holderActorMode === "sharp_cluster"
      ? "Why this cluster matters:"
      : "Why this wallet matters:";
  return [header, ...bullets.map((bullet) => `• ${bullet}`)];
}

function isHighConvictionSignal(
  note: Pick<SignalBotNote, "modelMeta">,
): boolean {
  return (
    note.modelMeta.execution_priority === "high_conviction" ||
    note.modelMeta.executionPriority === "high_conviction"
  );
}

function formatSignalBotSignalLabel(note: SignalBotNote): string {
  let label: string;
  if (note.holderActorMode === "sharp_cluster") label = "⚡ Strong wallets";
  else {
    const bucket = String(note.primaryTargetMeta.bucket ?? "").toLowerCase();
    switch (bucket) {
      case "sharp_minority":
      case "sharp_side":
        label = "⚡ Strong holder";
        break;
      case "sharp_split":
      case "clean_disagreement":
        label = "⚖️ Split holders";
        break;
      case "recent_flow":
        label = "🌊 Recent flow";
        break;
      case "event_bridge":
        label = "🔗 Cross-market";
        break;
      case "concentration_risk":
        label = "⚠️ Concentrated holder";
        break;
      case "followup_existing":
        label = "🔄 Signal update";
        break;
      default:
        label = "🔎 Holder signal";
        break;
    }
  }
  return isHighConvictionSignal(note) ? label.replace(/^\S+/, "🔥") : label;
}

function formatMarketTitleLine(note: SignalBotNote): string | null {
  const unique: string[] = [];
  for (const raw of [note.eventTitle, note.marketTitle]) {
    const title = raw?.trim().replace(/\s+/g, " ");
    if (!title) continue;
    if (
      unique.some((existing) => existing.toLowerCase() === title.toLowerCase())
    ) {
      continue;
    }
    unique.push(title);
  }
  return unique.join(" · ") || null;
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
  return {
    chatId: value.chatId,
    chatTitle: value.chatTitle || null,
    chatType: value.chatType || null,
    cursorCreatedAt: value.cursorCreatedAt || "1970-01-01T00:00:00.000Z",
    cursorId: value.cursorId || DEFAULT_CURSOR_ID,
    enabledAt: value.enabledAt,
    enabledBy: value.enabledBy,
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
    "Public help",
    "Signal messages include buttons to open markets, wallet profiles, and trade tickets in Hunch.",
    input.miniAppEnabled
      ? "In Telegram, supported buttons open the Hunch Mini App."
      : "Buttons open Hunch web links.",
    "",
    "Commands",
    "/start - show this intro",
    "/help - show help",
    "/status - show signal status for this chat",
  ].join("\n");
}

function helpText(input: { isAdmin: boolean; miniAppEnabled: boolean }): string {
  if (!input.isAdmin) return publicHelpText(input);
  return [
    publicHelpText(input),
    "",
    "Admin controls",
    "/enable_signals - enable this chat",
    "/enable_signals <channel_id> - enable a channel",
    "/disable_signals - disable this chat",
    "/disable_signals <channel_id> - disable a channel",
    "/status [channel_id] - show signal status",
    "/stats [24h|7d|30d] [detail] - show signal performance",
    "/test_followthrough [stats|win|loss] [channel_id] - preview a follow-up",
    "/test_signal [channel_id] - send latest eligible signal",
  ].join("\n");
}
