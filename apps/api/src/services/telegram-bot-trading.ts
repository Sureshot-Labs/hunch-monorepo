import crypto from "node:crypto";

import type { DbQuery } from "../db.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import { isRecord } from "../lib/type-guards.js";
import {
  resolveSignalBotTradingPolicyFromDb,
  type SignalBotPolicy,
} from "./signal-bot-trading-policy.js";
import {
  parseTelegramBotTradingCallbackData,
  TELEGRAM_BOT_TRADING_CALLBACK_PREFIX,
} from "./telegram-bot-trading-client.js";
import type { ApiBotTradingExecutor } from "./api-trading-service.js";
import type {
  PersistedTrade,
  KalshiTradeEligibility,
  SubmitResult,
  TradeExecutionAuthorization,
  TradeEffectsResult,
  TradeIntent,
  TradeTarget,
  TradingReadiness,
} from "./trading-types.js";
import { outcomeLabelOrSide } from "./wallet-intel-helpers.js";

export type TelegramBotTradingVenue = "kalshi" | "limitless" | "polymarket";
export type TelegramBotTradingAction = "buy" | "sell";
export type TelegramBotTradingSide = "NO" | "YES";

export type TelegramBotTradingButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export type TelegramBotTradingReplyMarkup = {
  inline_keyboard: TelegramBotTradingButton[][];
};

export type TelegramBotTradingMessage = {
  parse_mode?: "MarkdownV2";
  reply_markup?: TelegramBotTradingReplyMarkup;
  text: string;
};

type TelegramBotTradingStatusRow = {
  id: string | null;
  user_id: string | null;
  privy_user_id: string | null;
  telegram_user_id: string | null;
  username: string | null;
  wallet_address: string | null;
  wallet_chain: "ethereum" | "solana" | null;
  privy_wallet_id: string | null;
  enabled: boolean | null;
  enabled_venues: string[] | null;
  limits: Record<string, unknown> | null;
  max_amount_usd: string | null;
  disabled_at: Date | null;
  last_verified_at: Date | null;
};

type TelegramBotTradingAuthorizationRow = {
  id: string;
  user_id: string;
  telegram_user_id: string;
  privy_user_id: string | null;
  wallet_address: string;
  wallet_chain: "ethereum" | "solana";
  privy_wallet_id: string | null;
  enabled: boolean;
  enabled_venues: string[];
  limits: Record<string, unknown> | null;
  max_amount_usd: string | null;
};

type TelegramBotMarketRow = {
  id: string;
  venue: TelegramBotTradingVenue;
  venue_market_id: string;
  event_id: string;
  event_title: string | null;
  title: string;
  status: string;
  outcomes: string | null;
  metadata: unknown;
  close_time: Date | null;
  expiration_time: Date | null;
  event_end_time: Date | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
};

type TelegramTradeIntentRow = {
  id: string;
  telegram_user_id: string;
  user_id: string | null;
  authorization_id: string | null;
  chat_id: string | null;
  telegram_message_id: string | null;
  action: TelegramBotTradingAction;
  venue: TelegramBotTradingVenue;
  market_id: string;
  event_id: string | null;
  side: TelegramBotTradingSide | null;
  amount_usd: string | null;
  status: string;
  quote_snapshot: Record<string, unknown>;
  policy_snapshot: Record<string, unknown>;
  expires_at: Date;
  market_title: string;
  market_status: string;
};

export type TelegramBotTradingStatus = {
  authorizationId: string | null;
  activeAuthorization: TelegramBotTradingAuthorizationStatus | null;
  authorizations: TelegramBotTradingAuthorizationStatus[];
  directExecutionReady: boolean;
  enabled: boolean;
  enabledVenues: TelegramBotTradingVenue[];
  linked: boolean;
  maxAmountUsd: number | null;
  privyUserId: string | null;
  privyWalletId: string | null;
  setupIssue: string | null;
  telegramUserId: string | null;
  username: string | null;
  userId: string | null;
  walletAddress: string | null;
  walletChain: "ethereum" | "solana" | null;
};

export type TelegramBotTradingAuthorizationStatus = {
  authorizationId: string;
  directExecutionReady: boolean;
  enabled: boolean;
  enabledVenues: TelegramBotTradingVenue[];
  maxAmountUsd: number | null;
  privyWalletId: string | null;
  setupIssue: string | null;
  walletAddress: string;
  walletChain: "ethereum" | "solana";
};

export type EnableTelegramBotTradingInput = {
  enabledVenues?: TelegramBotTradingVenue[];
  kalshiEligibility?: KalshiTradeEligibility | null;
  privyWalletId?: string | null;
  userId: string;
  walletAddress: string;
};

export type TelegramBotTradingCallbackInput = {
  answerCallbackQuery: (input: {
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }) => Promise<unknown>;
  appBaseUrl: string;
  callbackQuery: {
    data?: string;
    from?: { id?: number };
    id: string;
    message?: {
      chat?: { id: string | number };
      message_id?: number;
    };
  };
  db: DbQuery;
  expectedIntentId?: string | null;
  expectedType?: "buy" | "cancel" | "confirm" | null;
  sendMessage: (input: {
    chat_id: string;
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramBotTradingReplyMarkup;
    text: string;
  }) => Promise<unknown>;
  trading?: ApiBotTradingExecutor;
};

type CapturedTelegramBotTradingCallbackResult = {
  answers: Array<{
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }>;
  handled: boolean;
  messages: Array<{
    chat_id: string;
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramBotTradingReplyMarkup;
    text: string;
  }>;
};

const TERMINAL_INTENT_STATUSES = new Set([
  "cancelled",
  "expired",
  "failed",
  "filled",
  "reconcile_required",
  "submitted",
]);
const PENDING_INTENT_STATUSES = ["draft", "previewed", "confirming"];
const SAFE_VENUES: TelegramBotTradingVenue[] = [
  "polymarket",
  "limitless",
  "kalshi",
];
const EVM_TRADING_VENUES: TelegramBotTradingVenue[] = [
  "polymarket",
  "limitless",
];
const SOLANA_TRADING_VENUES: TelegramBotTradingVenue[] = ["kalshi"];

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function normalizeTelegramUserId(value: string | number): string {
  return String(value).trim();
}

function normalizeMarketRef(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const marketParam = url.searchParams.get("market")?.trim();
    if (marketParam) return marketParam;
    const pathParts = url.pathname.split("/").filter(Boolean);
    const marketIndex = pathParts.findIndex((part) => part === "markets");
    if (marketIndex >= 0 && pathParts[marketIndex + 1]) {
      return decodeURIComponent(pathParts[marketIndex + 1]);
    }
    return pathParts.at(-1) ? decodeURIComponent(pathParts.at(-1) ?? "") : null;
  } catch {
    return trimmed;
  }
}

function normalizeVenue(value: string): TelegramBotTradingVenue | null {
  const normalized = value.trim().toLowerCase();
  return SAFE_VENUES.includes(normalized as TelegramBotTradingVenue)
    ? (normalized as TelegramBotTradingVenue)
    : null;
}

function normalizeVenues(values: string[]): TelegramBotTradingVenue[] {
  const out: TelegramBotTradingVenue[] = [];
  for (const value of values) {
    const venue = normalizeVenue(value);
    if (venue && !out.includes(venue)) out.push(venue);
  }
  return out;
}

function venuesForWalletChain(
  walletChain: "ethereum" | "solana" | null | undefined,
): TelegramBotTradingVenue[] {
  return walletChain === "solana" ? SOLANA_TRADING_VENUES : EVM_TRADING_VENUES;
}

function filterVenuesForWalletChain(
  venues: readonly TelegramBotTradingVenue[],
  walletChain: "ethereum" | "solana" | null | undefined,
): TelegramBotTradingVenue[] {
  const allowed = venuesForWalletChain(walletChain);
  return venues.filter((venue) => allowed.includes(venue));
}

function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "$0";
  if (Math.abs(amount - Math.round(amount)) < 0.005) {
    return `$${Math.round(amount).toLocaleString("en-US")}`;
  }
  return `$${amount.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatPrice(value: string | null): string | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const cents = Math.round(parsed * 100);
  return `${cents}c`;
}

function parseNumber(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKalshiEligibility(
  limits: Record<string, unknown> | null | undefined,
): KalshiTradeEligibility | null {
  const value = limits?.kalshiEligibility;
  if (!isRecord(value)) return null;
  return {
    checkedAt:
      typeof value.checkedAt === "string" && value.checkedAt.trim()
        ? value.checkedAt
        : null,
    expiresAt:
      typeof value.expiresAt === "string" && value.expiresAt.trim()
        ? value.expiresAt
        : null,
    geoAllowed: typeof value.geoAllowed === "boolean" ? value.geoAllowed : null,
    proofVerified:
      typeof value.proofVerified === "boolean" ? value.proofVerified : null,
  };
}

function executionAuthorizationForAuthorization(
  authorization: TelegramBotTradingAuthorizationRow,
): TradeExecutionAuthorization {
  return {
    privyWalletId: authorization.privy_wallet_id,
    kalshiEligibility:
      authorization.wallet_chain === "solana"
        ? parseKalshiEligibility(authorization.limits)
        : null,
  };
}

function effectiveMaxTradeAmountUsd(
  policy: SignalBotPolicy,
  authorizationMaxAmountUsd?: string | number | null,
): number {
  const authorizationMax =
    typeof authorizationMaxAmountUsd === "number"
      ? authorizationMaxAmountUsd
      : typeof authorizationMaxAmountUsd === "string"
        ? Number(authorizationMaxAmountUsd)
        : null;
  if (!Number.isFinite(authorizationMax) || authorizationMax == null) {
    return policy.maxTradeAmountUsd;
  }
  return Math.min(policy.maxTradeAmountUsd, authorizationMax);
}

function isVenueAllowed(
  venue: TelegramBotTradingVenue,
  policy: SignalBotPolicy,
  enabledVenues: readonly TelegramBotTradingVenue[],
): boolean {
  return policy.tradingVenues.includes(venue) && enabledVenues.includes(venue);
}

function resolveSubmitIntentStatus(submitResult: SubmitResult): {
  callbackText: string;
  errorCode?: string;
  errorMessage?: string;
  intentStatus: "cancelled" | "failed" | "filled" | "submitted";
  messageTitle: string;
  shouldPersist: boolean;
} {
  switch (submitResult.status) {
    case "filled":
      return {
        callbackText: "Trade filled.",
        intentStatus: "filled",
        messageTitle: "Trade filled.",
        shouldPersist: true,
      };
    case "failed":
      return {
        callbackText: "Trade failed.",
        errorCode: "trade_failed",
        errorMessage: "Venue returned a failed trade result.",
        intentStatus: "failed",
        messageTitle: "Trade failed.",
        shouldPersist: false,
      };
    case "no_fill":
      return {
        callbackText: "No fill.",
        errorCode: "no_fill",
        errorMessage: "Venue returned no fill.",
        intentStatus: "failed",
        messageTitle: "No fill.",
        shouldPersist: Boolean(submitResult.venueOrderId),
      };
    case "cancelled":
      return {
        callbackText: "Trade cancelled.",
        errorCode: "venue_cancelled",
        errorMessage: "Venue returned cancelled.",
        intentStatus: "cancelled",
        messageTitle: "Trade cancelled.",
        shouldPersist: false,
      };
    case "open":
      return {
        callbackText: "Order is open.",
        intentStatus: "submitted",
        messageTitle: "Order is open.",
        shouldPersist: true,
      };
    case "submitted":
      return {
        callbackText: "Trade submitted.",
        intentStatus: "submitted",
        messageTitle: "Trade submitted.",
        shouldPersist: true,
      };
  }
}

function marketToTradeTarget(market: TelegramBotMarketRow): TradeTarget {
  return {
    venue: market.venue,
    marketId: market.id,
    venueMarketId: market.venue_market_id,
    eventId: market.event_id,
    tokenId: null,
    outcome: null,
    title: market.title,
    raw: {
      status: market.status,
      metadata: market.metadata,
      outcomes: market.outcomes,
    },
  };
}

async function resolveTelegramTradingReadiness(input: {
  authorization?: TelegramBotTradingAuthorizationRow | null;
  market?: TelegramBotMarketRow | null;
  status?: TelegramBotTradingStatus | null;
  trading?: ApiBotTradingExecutor;
  venue: TelegramBotTradingVenue;
}): Promise<TradingReadiness> {
  const trading = input.trading;
  if (!trading) {
    return {
      ready: false,
      executable: false,
      reasonCode: "internal_api_unavailable",
      message: "Direct bot trading is unavailable. Open Hunch to trade.",
      setupRequired: false,
      capabilities: {
        venue: input.venue,
        supportsBuy: false,
        supportsSell: false,
        supportsCancel: false,
        supportsOrderSync: false,
        supportsPositionSync: false,
        supportsExecutionSync: false,
        supportsSetup: false,
        authorizationModes: ["unsupported"],
      },
    };
  }
  const status = input.status;
  const authorization = input.authorization;
  return trading.getReadiness({
    actor: {
      kind: "telegram_bot",
      userId: authorization?.user_id ?? status?.userId ?? "",
      telegramUserId:
        authorization?.telegram_user_id ?? status?.telegramUserId ?? null,
      authorizationId: authorization?.id ?? status?.authorizationId ?? null,
    },
    action: "BUY",
    executionAuthorization: authorization
      ? executionAuthorizationForAuthorization(authorization)
      : {
          privyWalletId: status?.privyWalletId ?? null,
          kalshiEligibility: null,
        },
    privyWalletId:
      authorization?.privy_wallet_id ?? status?.privyWalletId ?? null,
    target: input.market ? marketToTradeTarget(input.market) : null,
    venue: input.venue,
    walletAddress:
      authorization?.wallet_address ?? status?.walletAddress ?? null,
    walletChain: authorization?.wallet_chain ?? status?.walletChain ?? null,
  });
}

function buildTelegramTradeIntent(input: {
  amountUsd: number;
  authorization: TelegramBotTradingAuthorizationRow;
  intentId: string;
  market: TelegramBotMarketRow;
  maxSlippageBps: number;
  side: TelegramBotTradingSide;
}): TradeIntent {
  return {
    id: input.intentId,
    actor: {
      kind: "telegram_bot",
      userId: input.authorization.user_id,
      telegramUserId: input.authorization.telegram_user_id,
      authorizationId: input.authorization.id,
      source: "signal_bot",
    },
    venue: input.market.venue,
    target: {
      ...marketToTradeTarget(input.market),
      outcome: input.side,
    },
    executionAuthorization: executionAuthorizationForAuthorization(
      input.authorization,
    ),
    walletAddress: input.authorization.wallet_address,
    walletChain: input.authorization.wallet_chain,
    action: "BUY",
    outcome: input.side,
    amount: { type: "usd", value: String(input.amountUsd) },
    orderType: "FOK",
    slippageBps: input.maxSlippageBps,
    idempotencyKey: `telegram-bot:${input.intentId}`,
    raw: {},
  };
}

function openMarketUrl(
  appBaseUrl: string,
  market: TelegramBotMarketRow,
): string {
  const url = new URL(
    `/events/${encodeURIComponent(market.event_id)}`,
    `${normalizeBaseUrl(appBaseUrl)}/`,
  );
  url.searchParams.set("market", market.id);
  url.searchParams.set("utm_source", "telegram_trade_bot");
  return url.toString();
}

function sideLabel(market: TelegramBotMarketRow, side: TelegramBotTradingSide) {
  return outcomeLabelOrSide(market.outcomes, side);
}

function isMarketOrderable(market: TelegramBotMarketRow): boolean {
  return computeAcceptingOrders({
    venue: market.venue,
    status: market.status,
    closeTime: market.close_time,
    expirationTime: market.expiration_time,
    eventEndTime: market.event_end_time,
    dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(market.metadata),
  });
}

function marketPriceLine(market: TelegramBotMarketRow): string {
  const last = formatPrice(market.last_price);
  const bid = formatPrice(market.best_bid);
  const ask = formatPrice(market.best_ask);
  if (last) return `Last: ${last}`;
  if (bid && ask) return `Bid/ask: ${bid} / ${ask}`;
  if (bid) return `Bid: ${bid}`;
  if (ask) return `Ask: ${ask}`;
  return "Live price unavailable";
}

function buildPolicySnapshot(policy: SignalBotPolicy): Record<string, unknown> {
  return {
    tradingEnabled: policy.tradingEnabled,
    tradingActions: policy.tradingActions,
    tradingVenues: policy.tradingVenues,
    maxTradeAmountUsd: policy.maxTradeAmountUsd,
    maxSlippageBps: policy.maxSlippageBps,
    intentTtlSec: policy.intentTtlSec,
    requireConfirmation: true,
  };
}

export async function resolveTelegramBotTradingPolicy(
  db: DbQuery,
): Promise<SignalBotPolicy> {
  return resolveSignalBotTradingPolicyFromDb(db);
}

export async function getTelegramBotTradingStatus(
  db: DbQuery,
  telegramUserId: string | number,
  trading?: ApiBotTradingExecutor,
): Promise<TelegramBotTradingStatus> {
  const normalizedTelegramUserId = normalizeTelegramUserId(telegramUserId);
  const result = await db.query<TelegramBotTradingStatusRow>(
    `SELECT
       a.id,
       uta.user_id,
       u.privy_user_id,
       uta.telegram_user_id,
       uta.username,
       a.wallet_address,
       a.wallet_chain,
       a.privy_wallet_id,
       a.enabled,
       a.enabled_venues,
       a.limits,
       a.max_amount_usd,
       a.disabled_at,
       a.last_verified_at
     FROM user_telegram_accounts uta
     JOIN users u ON u.id = uta.user_id
     LEFT JOIN telegram_bot_trading_authorizations a
       ON a.telegram_user_id = uta.telegram_user_id
     WHERE uta.telegram_user_id = $1
     ORDER BY
       a.enabled DESC NULLS LAST,
       CASE a.wallet_chain WHEN 'ethereum' THEN 0 WHEN 'solana' THEN 1 ELSE 2 END,
       a.updated_at DESC NULLS LAST`,
    [normalizedTelegramUserId],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      authorizationId: null,
      activeAuthorization: null,
      authorizations: [],
      directExecutionReady: false,
      enabled: false,
      enabledVenues: [],
      linked: false,
      maxAmountUsd: null,
      privyUserId: null,
      privyWalletId: null,
      setupIssue: "Telegram is not linked to a Hunch account.",
      telegramUserId: normalizedTelegramUserId,
      username: null,
      userId: null,
      walletAddress: null,
      walletChain: null,
    };
  }
  const authorizations: TelegramBotTradingAuthorizationStatus[] = [];
  for (const authRow of result.rows) {
    if (
      !authRow.id ||
      !authRow.user_id ||
      !authRow.telegram_user_id ||
      !authRow.wallet_address ||
      !authRow.wallet_chain
    ) {
      continue;
    }
    const authorizationRow: TelegramBotTradingAuthorizationRow = {
      id: authRow.id,
      user_id: authRow.user_id,
      telegram_user_id: authRow.telegram_user_id,
      privy_user_id: authRow.privy_user_id,
      wallet_address: authRow.wallet_address,
      wallet_chain: authRow.wallet_chain,
      privy_wallet_id: authRow.privy_wallet_id,
      enabled: Boolean(authRow.enabled),
      enabled_venues: authRow.enabled_venues ?? [],
      limits: authRow.limits,
      max_amount_usd: authRow.max_amount_usd,
    };
    const enabledVenues = filterVenuesForWalletChain(
      normalizeVenues(authorizationRow.enabled_venues),
      authorizationRow.wallet_chain,
    );
    const enabled = authorizationRow.enabled;
    const readinessResults =
      enabled && authorizationRow.privy_wallet_id && enabledVenues.length > 0
        ? await Promise.all(
            enabledVenues.map((venue) =>
              resolveTelegramTradingReadiness({
                authorization: authorizationRow,
                trading,
                venue,
              }),
            ),
          )
        : [];
    const directExecutionReady = readinessResults.some(
      (readiness) => readiness.executable,
    );
    const readinessIssue =
      readinessResults.find((readiness) => readiness.message)?.message ?? null;
    authorizations.push({
      authorizationId: authRow.id,
      directExecutionReady,
      enabled,
      enabledVenues,
      maxAmountUsd: parseNumber(authorizationRow.max_amount_usd),
      privyWalletId: authorizationRow.privy_wallet_id,
      setupIssue: !enabled
        ? "Bot trading is disabled for this wallet."
        : !authorizationRow.privy_wallet_id
          ? "Selected wallet is missing a Privy wallet id."
          : directExecutionReady
            ? null
            : (readinessIssue ??
              "Direct server-side venue execution is not enabled yet."),
      walletAddress: authorizationRow.wallet_address,
      walletChain: authorizationRow.wallet_chain,
    });
  }

  const activeAuthorization =
    authorizations.find((auth) => auth.enabled && auth.directExecutionReady) ??
    authorizations.find((auth) => auth.enabled) ??
    authorizations[0] ??
    null;
  const enabledVenues = Array.from(
    new Set(
      authorizations
        .filter((auth) => auth.enabled)
        .flatMap((auth) => auth.enabledVenues),
    ),
  );
  const directExecutionReady = authorizations.some(
    (auth) => auth.directExecutionReady,
  );
  const enabled = authorizations.some((auth) => auth.enabled);
  const setupIssue = !activeAuthorization
    ? "Bot trading is not enabled in Settings."
    : directExecutionReady
      ? null
      : (activeAuthorization.setupIssue ??
        "Direct server-side venue execution is not enabled yet.");

  return {
    authorizationId: activeAuthorization?.authorizationId ?? null,
    activeAuthorization,
    authorizations,
    directExecutionReady,
    enabled,
    enabledVenues,
    linked: true,
    maxAmountUsd: activeAuthorization?.maxAmountUsd ?? null,
    privyUserId: row.privy_user_id,
    privyWalletId: activeAuthorization?.privyWalletId ?? null,
    setupIssue,
    telegramUserId: row.telegram_user_id,
    username: row.username,
    userId: row.user_id,
    walletAddress: activeAuthorization?.walletAddress ?? null,
    walletChain: activeAuthorization?.walletChain ?? null,
  };
}

export async function enableTelegramBotTrading(
  db: DbQuery,
  input: EnableTelegramBotTradingInput,
  trading?: ApiBotTradingExecutor,
): Promise<TelegramBotTradingStatus> {
  const walletResult = await db.query<{
    privy_user_id: string | null;
    telegram_user_id: string | null;
    wallet_address: string;
    wallet_type: "ethereum" | "solana";
  }>(
    `SELECT
       u.privy_user_id,
       uta.telegram_user_id,
       uw.wallet_address,
       uw.wallet_type
     FROM user_wallets uw
     JOIN users u ON u.id = uw.user_id
     LEFT JOIN user_telegram_accounts uta ON uta.user_id = u.id
     WHERE uw.user_id = $1
       AND uw.is_verified = true
       AND (
         (uw.wallet_type = 'ethereum' AND lower(uw.wallet_address) = lower($2))
         OR (uw.wallet_type <> 'ethereum' AND uw.wallet_address = $2)
       )
     LIMIT 1`,
    [input.userId, input.walletAddress.trim()],
  );
  const wallet = walletResult.rows[0];
  if (!wallet?.telegram_user_id) {
    throw new Error("telegram_account_required");
  }
  if (!input.privyWalletId?.trim()) {
    throw new Error("privy_wallet_id_required");
  }

  const policy = await resolveTelegramBotTradingPolicy(db);
  const enabledVenueSource =
    input.enabledVenues === undefined
      ? policy.tradingVenues
      : input.enabledVenues.filter((venue) =>
          policy.tradingVenues.includes(venue),
        );
  const enabledVenues = filterVenuesForWalletChain(
    enabledVenueSource,
    wallet.wallet_type,
  );
  if (enabledVenues.length === 0) {
    throw new Error("no_compatible_venues_for_wallet");
  }

  await db.query(
    `INSERT INTO telegram_bot_trading_authorizations (
       user_id,
       telegram_user_id,
       privy_user_id,
       wallet_address,
       wallet_chain,
       privy_wallet_id,
       enabled,
       enabled_venues,
       max_amount_usd,
       limits,
       disabled_at,
       last_verified_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, true, $7::text[], $8, $9::jsonb, null, now(), now())
     ON CONFLICT (telegram_user_id, wallet_chain) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       privy_user_id = EXCLUDED.privy_user_id,
       wallet_address = EXCLUDED.wallet_address,
       wallet_chain = EXCLUDED.wallet_chain,
       privy_wallet_id = EXCLUDED.privy_wallet_id,
       enabled = true,
       enabled_venues = EXCLUDED.enabled_venues,
       max_amount_usd = EXCLUDED.max_amount_usd,
       limits = EXCLUDED.limits,
       disabled_at = null,
       last_verified_at = now(),
       updated_at = now()`,
    [
      input.userId,
      wallet.telegram_user_id,
      wallet.privy_user_id,
      wallet.wallet_address,
      wallet.wallet_type,
      input.privyWalletId?.trim() || null,
      enabledVenues,
      policy.maxTradeAmountUsd,
      JSON.stringify({
        maxSlippageBps: policy.maxSlippageBps,
        requireConfirmation: true,
        kalshiEligibility:
          wallet.wallet_type === "solana"
            ? (input.kalshiEligibility ?? null)
            : null,
      }),
    ],
  );

  return getTelegramBotTradingStatus(db, wallet.telegram_user_id, trading);
}

export async function disableTelegramBotTradingForUser(
  db: DbQuery,
  userId: string,
): Promise<void> {
  await db.query(
    `UPDATE telegram_bot_trading_authorizations
        SET enabled = false,
            disabled_at = now(),
            updated_at = now()
      WHERE user_id = $1`,
    [userId],
  );
}

export async function disableTelegramBotTradingForTelegramUser(
  db: DbQuery,
  telegramUserId: string | number,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE telegram_bot_trading_authorizations
        SET enabled = false,
            disabled_at = now(),
            updated_at = now()
      WHERE telegram_user_id = $1
        AND enabled = true`,
    [normalizeTelegramUserId(telegramUserId)],
  );
  return (result.rowCount ?? 0) > 0;
}

async function resolveMarketByRef(
  db: DbQuery,
  marketRef: string,
): Promise<TelegramBotMarketRow | null> {
  const normalized = normalizeMarketRef(marketRef);
  if (!normalized) return null;
  const result = await db.query<TelegramBotMarketRow>(
    `SELECT
       m.id,
       m.venue,
       m.venue_market_id,
       m.event_id,
       e.title AS event_title,
       m.title,
       m.status::text AS status,
       m.outcomes,
       m.metadata,
       m.close_time,
       m.expiration_time,
       e.end_date AS event_end_time,
       m.best_bid,
       m.best_ask,
       m.last_price
     FROM unified_markets m
     LEFT JOIN unified_events e ON e.id = m.event_id
     WHERE m.id = $1
        OR m.venue_market_id = $1
        OR m.slug = $1
     ORDER BY
       CASE WHEN m.id = $1 THEN 0 WHEN m.venue_market_id = $1 THEN 1 ELSE 2 END,
       m.updated_at_db DESC NULLS LAST
     LIMIT 1`,
    [normalized],
  );
  const row = result.rows[0];
  if (!row) return null;
  const venue = normalizeVenue(row.venue);
  return venue ? { ...row, venue } : null;
}

async function loadMarketById(
  db: DbQuery,
  marketId: string,
): Promise<TelegramBotMarketRow | null> {
  const result = await db.query<TelegramBotMarketRow>(
    `SELECT
       m.id,
       m.venue,
       m.venue_market_id,
       m.event_id,
       e.title AS event_title,
       m.title,
       m.status::text AS status,
       m.outcomes,
       m.metadata,
       m.close_time,
       m.expiration_time,
       e.end_date AS event_end_time,
       m.best_bid,
       m.best_ask,
       m.last_price
     FROM unified_markets m
     LEFT JOIN unified_events e ON e.id = m.event_id
     WHERE m.id = $1
     LIMIT 1`,
    [marketId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const venue = normalizeVenue(row.venue);
  return venue ? { ...row, venue } : null;
}

async function insertBuyIntent(input: {
  amountUsd: number;
  chatId: string;
  db: DbQuery;
  market: TelegramBotMarketRow;
  policy: SignalBotPolicy;
  side: TelegramBotTradingSide;
  telegramMessageId?: number | null;
  telegramUserId: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + input.policy.intentTtlSec * 1000);
  await input.db.query(
    `INSERT INTO telegram_trade_intents (
       id,
       telegram_user_id,
       chat_id,
       telegram_message_id,
       action,
       venue,
       market_id,
       event_id,
       side,
       amount_usd,
       status,
       quote_snapshot,
       policy_snapshot,
       expires_at,
       idempotency_key
     )
     VALUES ($1, $2, $3, $4, 'buy', $5, $6, $7, $8, $9, 'draft', $10::jsonb, $11::jsonb, $12, $13)`,
    [
      id,
      input.telegramUserId,
      input.chatId,
      input.telegramMessageId ?? null,
      input.market.venue,
      input.market.id,
      input.market.event_id,
      input.side,
      input.amountUsd,
      JSON.stringify({
        marketStatus: input.market.status,
        price: input.market.last_price,
        bestBid: input.market.best_bid,
        bestAsk: input.market.best_ask,
      }),
      JSON.stringify(buildPolicySnapshot(input.policy)),
      expiresAt,
      `telegram-bot:${id}`,
    ],
  );
  return id;
}

export async function buildTelegramBotTradingStatusMessage(
  db: DbQuery,
  telegramUserId: string | number,
  trading?: ApiBotTradingExecutor,
): Promise<TelegramBotTradingMessage> {
  const [policy, status] = await Promise.all([
    resolveTelegramBotTradingPolicy(db),
    getTelegramBotTradingStatus(db, telegramUserId, trading),
  ]);
  const lines = [
    "Telegram Trading Status",
    "",
    `Runtime policy: ${policy.tradingEnabled ? "enabled" : "disabled"}`,
    `Linked account: ${status.linked ? "yes" : "no"}`,
    `Bot trading: ${status.enabled ? "enabled" : "disabled"}`,
    `Wallet: ${
      status.authorizations.length > 1
        ? `${status.authorizations.length} wallets enabled`
        : (status.walletAddress ?? "not selected")
    }`,
    `Venues: ${
      status.enabledVenues.length > 0
        ? status.enabledVenues.join(", ")
        : policy.tradingVenues.join(", ")
    }`,
    `Max buy: ${formatUsd(status.maxAmountUsd ?? policy.maxTradeAmountUsd)}`,
    `Direct execution: ${status.directExecutionReady ? "ready" : "not ready"}`,
  ];
  if (status.setupIssue) lines.push("", status.setupIssue);
  return {
    parse_mode: "MarkdownV2",
    text: escapeMarkdown(lines.join("\n")),
  };
}

export async function buildTelegramBotTradingMarketMessage(input: {
  appBaseUrl: string;
  chatId: string | number;
  db: DbQuery;
  isAdminTest?: boolean;
  marketRef: string;
  telegramMessageId?: number | null;
  telegramUserId: string | number;
  trading?: ApiBotTradingExecutor;
}): Promise<TelegramBotTradingMessage> {
  const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
  const [policy, status, market] = await Promise.all([
    resolveTelegramBotTradingPolicy(input.db),
    getTelegramBotTradingStatus(input.db, telegramUserId, input.trading),
    resolveMarketByRef(input.db, input.marketRef),
  ]);

  if (!market) {
    return {
      parse_mode: "MarkdownV2",
      text: escapeMarkdown(
        "Market not found. Send /market <market_id or URL>.",
      ),
    };
  }

  const openUrl = openMarketUrl(input.appBaseUrl, market);
  const authorization = await loadEnabledAuthorization(
    input.db,
    telegramUserId,
    market.venue,
  );
  const marketOrderable = isMarketOrderable(market);
  const policyVenueAllowed = policy.tradingVenues.includes(market.venue);
  const authorizationVenues = filterVenuesForWalletChain(
    normalizeVenues(authorization?.enabled_venues ?? []),
    authorization?.wallet_chain,
  );
  const authorizationVenueAllowed =
    authorization != null && authorizationVenues.includes(market.venue);
  const maxAmountUsd = effectiveMaxTradeAmountUsd(
    policy,
    authorization?.max_amount_usd ?? status.maxAmountUsd,
  );
  const tradeReadiness = await resolveTelegramTradingReadiness({
    authorization,
    market,
    trading: input.trading,
    venue: market.venue,
  });
  const buyEnabled =
    !input.isAdminTest &&
    policy.tradingEnabled &&
    policy.tradingActions.includes("buy") &&
    policyVenueAllowed &&
    authorizationVenueAllowed &&
    marketOrderable &&
    authorization?.enabled === true &&
    Boolean(authorization.privy_wallet_id) &&
    tradeReadiness.executable;
  const lines = [
    input.isAdminTest ? "Trade Card Preview" : "Trade This Market",
    "",
    market.event_title ? market.event_title : market.title,
  ];
  if (market.event_title && market.event_title !== market.title) {
    lines.push(market.title);
  }
  lines.push("", `${market.venue} · ${market.status}`, marketPriceLine(market));
  if (input.isAdminTest) {
    lines.push("", "Preview only - trade buttons are not created.");
  }
  if (!policy.tradingEnabled) {
    lines.push("", "Trading is disabled by runtime policy.");
  } else if (!status.linked) {
    lines.push("", "Link Telegram to your Hunch account in Settings first.");
  } else if (!status.enabled) {
    lines.push("", "Enable Telegram bot trading in Settings first.");
  } else if (!policyVenueAllowed) {
    lines.push("", "This venue is disabled by runtime policy.");
  } else if (!authorizationVenueAllowed) {
    lines.push(
      "",
      "Enable a compatible wallet for this venue in Settings first.",
    );
  } else if (!marketOrderable) {
    lines.push("", "This market is not open for new bot trades.");
  } else if (!tradeReadiness.executable) {
    lines.push(
      "",
      tradeReadiness.message ??
        "Direct bot execution is not ready yet. Open Hunch to trade.",
    );
  }

  const keyboard: TelegramBotTradingButton[][] = [];
  if (buyEnabled) {
    for (const side of ["YES", "NO"] as const) {
      const row: TelegramBotTradingButton[] = [];
      for (const amountUsd of policy.buyAmountPresetsUsd) {
        if (amountUsd > maxAmountUsd) continue;
        const intentId = await insertBuyIntent({
          amountUsd,
          chatId: String(input.chatId),
          db: input.db,
          market,
          policy,
          side,
          telegramMessageId: input.telegramMessageId,
          telegramUserId: normalizeTelegramUserId(input.telegramUserId),
        });
        row.push({
          callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:buy:${intentId}`,
          text: `Buy ${sideLabel(market, side)} ${formatUsd(amountUsd)}`,
        });
      }
      if (row.length > 0) keyboard.push(row);
    }
  }
  keyboard.push([{ text: "Open in Hunch", url: openUrl }]);

  return {
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: keyboard },
    text: escapeMarkdown(lines.join("\n")),
  };
}

async function loadIntent(
  db: DbQuery,
  intentId: string,
): Promise<TelegramTradeIntentRow | null> {
  const result = await db.query<TelegramTradeIntentRow>(
    `SELECT
       i.id,
       i.telegram_user_id,
       i.user_id,
       i.authorization_id,
       i.chat_id,
       i.telegram_message_id::text AS telegram_message_id,
       i.action,
       i.venue,
       i.market_id,
       i.event_id,
       i.side,
       i.amount_usd,
       i.status,
       i.quote_snapshot,
       i.policy_snapshot,
       i.expires_at,
       m.title AS market_title,
       m.status::text AS market_status
     FROM telegram_trade_intents i
     JOIN unified_markets m ON m.id = i.market_id
     WHERE i.id = $1
     LIMIT 1`,
    [intentId],
  );
  return result.rows[0] ?? null;
}

async function updateIntentStatus(input: {
  allowedStatuses?: string[];
  db: DbQuery;
  errorCode?: string;
  errorMessage?: string;
  executionId?: string | null;
  intentId: string;
  orderId?: string | null;
  preparedSnapshot?: Record<string, unknown> | null;
  result?: Record<string, unknown>;
  markSubmitStarted?: boolean;
  status: string;
  txSignature?: string | null;
  venueOrderId?: string | null;
}): Promise<boolean> {
  const result = await input.db.query(
    `UPDATE telegram_trade_intents
        SET status = $2,
            error_code = $3,
            error_message = $4,
            result = coalesce($5::jsonb, result),
            order_id = coalesce($7::uuid, order_id),
            venue_order_id = coalesce($8::text, venue_order_id),
            execution_id = coalesce($9::uuid, execution_id),
            tx_signature = coalesce($10::text, tx_signature),
            prepared_snapshot = coalesce($11::jsonb, prepared_snapshot),
            confirmed_at = CASE WHEN $2 = 'executing' THEN now() ELSE confirmed_at END,
            submitted_at = CASE
              WHEN $12::boolean THEN coalesce(submitted_at, now())
              ELSE submitted_at
            END,
            submit_started_at = CASE
              WHEN $13::boolean THEN coalesce(submit_started_at, now())
              ELSE submit_started_at
            END,
            updated_at = now()
      WHERE id = $1
        AND ($6::text[] IS NULL OR status = ANY($6::text[]))
      RETURNING id`,
    [
      input.intentId,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.result ? JSON.stringify(input.result) : null,
      input.allowedStatuses ?? null,
      input.orderId ?? null,
      input.venueOrderId ?? null,
      input.executionId ?? null,
      input.txSignature ?? null,
      input.preparedSnapshot ? JSON.stringify(input.preparedSnapshot) : null,
      ["filled", "submitted"].includes(input.status),
      Boolean(input.markSubmitStarted),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function reconcileStaleTelegramTradeIntents(
  db: DbQuery,
  input: {
    executingGraceMs?: number;
    now?: Date;
  } = {},
): Promise<{
  expiredPending: number;
  failedPreSubmitExecuting: number;
  submittedReconcileRequired: number;
  unknownSubmitReconcileRequired: number;
}> {
  const now = input.now ?? new Date();
  const executingCutoff = new Date(
    now.getTime() - (input.executingGraceMs ?? 10 * 60 * 1000),
  );
  const expiredPending = await db.query(
    `UPDATE telegram_trade_intents
        SET status = 'expired',
            error_code = coalesce(error_code, 'intent_expired'),
            error_message = coalesce(error_message, 'Trade intent expired before confirmation.'),
            updated_at = now()
      WHERE status = ANY($1::text[])
        AND expires_at <= $2
      RETURNING id`,
    [PENDING_INTENT_STATUSES, now],
  );
  const failedPreSubmitExecuting = await db.query(
    `UPDATE telegram_trade_intents
        SET status = 'failed',
            error_code = coalesce(error_code, 'stale_pre_submit_execution'),
            error_message = coalesce(error_message, 'Trade intent became stale before venue submit.'),
            updated_at = now()
      WHERE status = 'executing'
        AND updated_at <= $1
        AND order_id IS NULL
        AND execution_id IS NULL
        AND venue_order_id IS NULL
        AND tx_signature IS NULL
        AND submit_started_at IS NULL
      RETURNING id`,
    [executingCutoff],
  );
  const unknownSubmitReconcileRequired = await db.query(
    `UPDATE telegram_trade_intents
        SET status = 'reconcile_required',
            error_code = 'submit_state_unknown',
            error_message = coalesce(error_message, 'Trade submit state is unknown; reconcile before retrying.'),
            updated_at = now(),
            submitted_at = coalesce(submitted_at, submit_started_at, now())
      WHERE status = 'executing'
        AND updated_at <= $1
        AND order_id IS NULL
        AND execution_id IS NULL
        AND venue_order_id IS NULL
        AND tx_signature IS NULL
        AND submit_started_at IS NOT NULL
      RETURNING id`,
    [executingCutoff],
  );
  const submittedReconcileRequired = await db.query(
    `UPDATE telegram_trade_intents
        SET status = 'submitted',
            error_code = 'reconcile_required',
            error_message = coalesce(error_message, 'Venue submit may have succeeded; reconcile before retrying.'),
            updated_at = now(),
            submitted_at = coalesce(submitted_at, now())
      WHERE status = 'executing'
        AND updated_at <= $1
        AND (
          order_id IS NOT NULL
          OR execution_id IS NOT NULL
          OR venue_order_id IS NOT NULL
          OR tx_signature IS NOT NULL
        )
      RETURNING id`,
    [executingCutoff],
  );
  return {
    expiredPending: expiredPending.rowCount ?? 0,
    failedPreSubmitExecuting: failedPreSubmitExecuting.rowCount ?? 0,
    submittedReconcileRequired: submittedReconcileRequired.rowCount ?? 0,
    unknownSubmitReconcileRequired:
      unknownSubmitReconcileRequired.rowCount ?? 0,
  };
}

function buildPreparedTradeSnapshot(
  prepared: Awaited<ReturnType<ApiBotTradingExecutor["prepareTrade"]>>,
): Record<string, unknown> {
  return {
    authorizationMode: prepared.authorizationMode,
    expiresAt: prepared.expiresAt?.toISOString() ?? null,
    preparedId: prepared.preparedId,
    venue: prepared.venue,
  };
}

async function attachAuthorizationToIntent(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  intentId: string;
}): Promise<void> {
  await input.db.query(
    `UPDATE telegram_trade_intents
        SET authorization_id = $2,
            user_id = $3,
            updated_at = now()
      WHERE id = $1`,
    [input.intentId, input.authorization.id, input.authorization.user_id],
  );
}

async function loadEnabledAuthorization(
  db: DbQuery,
  telegramUserId: string,
  venue: TelegramBotTradingVenue,
): Promise<TelegramBotTradingAuthorizationRow | null> {
  const walletChain = venue === "kalshi" ? "solana" : "ethereum";
  const result = await db.query<TelegramBotTradingAuthorizationRow>(
    `SELECT
       a.id,
       a.user_id,
       a.telegram_user_id,
       a.privy_user_id,
       a.wallet_address,
       a.wallet_chain,
       a.privy_wallet_id,
       a.enabled,
       a.enabled_venues,
       a.limits,
       a.max_amount_usd
     FROM telegram_bot_trading_authorizations a
     JOIN user_telegram_accounts uta
       ON uta.telegram_user_id = a.telegram_user_id
      AND uta.user_id = a.user_id
     JOIN user_wallets uw
       ON uw.user_id = a.user_id
      AND uw.wallet_type = a.wallet_chain
      AND uw.is_verified = true
      AND (
        (a.wallet_chain = 'ethereum' AND lower(uw.wallet_address) = lower(a.wallet_address))
        OR (a.wallet_chain <> 'ethereum' AND uw.wallet_address = a.wallet_address)
      )
     WHERE a.telegram_user_id = $1
       AND a.enabled = true
       AND a.wallet_chain = $2
       AND $3 = ANY(a.enabled_venues)
     LIMIT 1`,
    [telegramUserId, walletChain, venue],
  );
  return result.rows[0] ?? null;
}

function callbackChatId(input: TelegramBotTradingCallbackInput): string | null {
  const fromId = input.callbackQuery.from?.id;
  if (fromId != null) return String(fromId);
  const chatId = input.callbackQuery.message?.chat?.id;
  return chatId != null ? String(chatId) : null;
}

function isTerminalIntentStatus(status: string): boolean {
  return TERMINAL_INTENT_STATUSES.has(status);
}

async function answerIntentAlreadyProcessed(
  input: TelegramBotTradingCallbackInput,
  status: string,
): Promise<void> {
  await input.answerCallbackQuery({
    callbackQueryId: input.callbackQuery.id,
    showAlert: true,
    text:
      status === "executing"
        ? "Trade intent is already being processed."
        : status === "reconcile_required"
          ? "Trade status is unknown. Check Hunch before retrying."
        : "Trade intent was already processed. Send /market again.",
  });
}

export async function handleTelegramBotTradingCallback(
  input: TelegramBotTradingCallbackInput,
): Promise<boolean> {
  const parsed = parseTelegramBotTradingCallbackData(input.callbackQuery.data);
  if (!parsed) return false;
  if (
    (input.expectedIntentId && parsed.intentId !== input.expectedIntentId) ||
    (input.expectedType && parsed.type !== input.expectedType)
  ) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Trade action does not match this request.",
    });
    return true;
  }

  const chatId = callbackChatId(input);
  if (!chatId) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Open a private chat with the bot first.",
    });
    return true;
  }

  const intent = await loadIntent(input.db, parsed.intentId);
  if (!intent) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Trade intent was not found.",
    });
    return true;
  }
  if (intent.telegram_user_id !== normalizeTelegramUserId(chatId)) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "This trade button belongs to another Telegram user.",
    });
    return true;
  }
  if (isTerminalIntentStatus(intent.status) || intent.status === "executing") {
    await answerIntentAlreadyProcessed(input, intent.status);
    return true;
  }
  if (intent.expires_at.getTime() <= Date.now()) {
    const expired = await updateIntentStatus({
      allowedStatuses: PENDING_INTENT_STATUSES,
      db: input.db,
      errorCode: "intent_expired",
      errorMessage: "Trade intent expired.",
      intentId: intent.id,
      status: "expired",
    });
    if (!expired) {
      await answerIntentAlreadyProcessed(input, intent.status);
      return true;
    }
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Trade intent expired. Send /market again.",
    });
    return true;
  }

  if (parsed.type === "cancel") {
    const cancelled = await updateIntentStatus({
      allowedStatuses: PENDING_INTENT_STATUSES,
      db: input.db,
      intentId: intent.id,
      status: "cancelled",
    });
    if (!cancelled) {
      await answerIntentAlreadyProcessed(input, intent.status);
      return true;
    }
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      text: "Cancelled.",
    });
    await input.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      text: escapeMarkdown("Trade cancelled."),
    });
    return true;
  }

  const [policy, authorization, market] = await Promise.all([
    resolveTelegramBotTradingPolicy(input.db),
    loadEnabledAuthorization(input.db, intent.telegram_user_id, intent.venue),
    loadMarketById(input.db, intent.market_id),
  ]);
  const amountUsd = parseNumber(intent.amount_usd);
  const side = intent.side;
  if (market && market.venue !== intent.venue) {
    await updateIntentStatus({
      allowedStatuses: PENDING_INTENT_STATUSES,
      db: input.db,
      errorCode: "market_venue_mismatch",
      errorMessage:
        "Trade intent market venue no longer matches the intent venue.",
      intentId: intent.id,
      status: "failed",
    });
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Market venue changed. Send /market again.",
    });
    return true;
  }
  const authorizationVenues = filterVenuesForWalletChain(
    normalizeVenues(authorization?.enabled_venues ?? []),
    authorization?.wallet_chain,
  );
  const maxAmountUsd = effectiveMaxTradeAmountUsd(
    policy,
    authorization?.max_amount_usd ?? null,
  );
  const tradeReadiness =
    authorization && market
      ? await resolveTelegramTradingReadiness({
          authorization,
          market,
          trading: input.trading,
          venue: intent.venue,
        })
      : null;
  if (
    !policy.tradingEnabled ||
    !policy.tradingActions.includes("buy") ||
    !policy.tradingVenues.includes(intent.venue) ||
    !market ||
    !isMarketOrderable(market) ||
    !authorization ||
    !authorization.privy_wallet_id ||
    !isVenueAllowed(intent.venue, policy, authorizationVenues) ||
    !tradeReadiness?.executable ||
    !amountUsd ||
    amountUsd > maxAmountUsd ||
    !side
  ) {
    const markedFailed = await updateIntentStatus({
      allowedStatuses: PENDING_INTENT_STATUSES,
      db: input.db,
      errorCode: "not_ready",
      errorMessage:
        tradeReadiness?.message ??
        "Telegram bot trading is not ready for this user or market.",
      intentId: intent.id,
      status: "failed",
    });
    if (!markedFailed) {
      await answerIntentAlreadyProcessed(input, intent.status);
      return true;
    }
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Bot trading is not ready. Check /trade_status.",
    });
    if (market) {
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Open in Hunch",
                url: openMarketUrl(input.appBaseUrl, market),
              },
            ],
          ],
        },
        text: escapeMarkdown(
          tradeReadiness?.message ??
            "Direct bot trading is not ready for this market. Open Hunch to trade.",
        ),
      });
    }
    return true;
  }
  if (parsed.type === "buy") {
    const confirming = await updateIntentStatus({
      allowedStatuses: ["draft", "previewed"],
      db: input.db,
      intentId: intent.id,
      status: "confirming",
    });
    if (!confirming) {
      await answerIntentAlreadyProcessed(input, intent.status);
      return true;
    }
    await attachAuthorizationToIntent({
      authorization,
      db: input.db,
      intentId: intent.id,
    });
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      text: "Confirm in the next message.",
    });
    await input.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            {
              callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:confirm:${intent.id}`,
              text: "Confirm buy",
            },
            {
              callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:cancel:${intent.id}`,
              text: "Cancel",
            },
          ],
        ],
      },
      text: escapeMarkdown(
        [
          `Confirm buy ${formatUsd(amountUsd)} ${side} on ${intent.market_title}.`,
          "",
          "This is a real trade. Confirm only if you want the bot to submit it now.",
        ].join("\n"),
      ),
    });
    return true;
  }

  await attachAuthorizationToIntent({
    authorization,
    db: input.db,
    intentId: intent.id,
  });
  const executing = await updateIntentStatus({
    allowedStatuses: ["confirming"],
    db: input.db,
    intentId: intent.id,
    status: "executing",
  });
  if (!executing) {
    await answerIntentAlreadyProcessed(input, intent.status);
    return true;
  }
  const trading = input.trading;
  if (!trading) {
    await updateIntentStatus({
      allowedStatuses: ["executing"],
      db: input.db,
      errorCode: "internal_api_unavailable",
      errorMessage: "Direct bot trading is unavailable. Open Hunch to trade.",
      intentId: intent.id,
      status: "failed",
    });
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Open Hunch to place this trade.",
    });
    return true;
  }
  const sharedIntent = buildTelegramTradeIntent({
    amountUsd,
    authorization,
    intentId: intent.id,
    market,
    maxSlippageBps: policy.maxSlippageBps,
    side,
  });
  let submittedRefs: {
    submitResult: SubmitResult;
    venueOrderId: string | null;
  } | null = null;
  try {
    const quote = await trading.quote({ intent: sharedIntent });
    const prepared = await trading.prepareTrade({
      intent: sharedIntent,
      quote,
    });
    const preparedSnapshot = buildPreparedTradeSnapshot(prepared);
    await updateIntentStatus({
      allowedStatuses: ["executing"],
      db: input.db,
      intentId: intent.id,
      markSubmitStarted: true,
      preparedSnapshot,
      result: { quote },
      status: "executing",
    });
    const submitResult = await trading.submitPreparedTrade({ prepared });
    const submitVenueOrderId =
      submitResult.venueOrderId ?? submitResult.txSignature;
    submittedRefs = {
      submitResult,
      venueOrderId: submitVenueOrderId,
    };
    await updateIntentStatus({
      allowedStatuses: ["executing"],
      db: input.db,
      intentId: intent.id,
      result: { quote, submitResult },
      status: "executing",
      txSignature: submitResult.txSignature,
      venueOrderId: submitVenueOrderId,
    });
    const resolution = resolveSubmitIntentStatus(submitResult);
    let persisted: PersistedTrade | null = null;
    let effects: TradeEffectsResult | null = null;
    let postSubmitError: {
      code: string;
      message: string;
      statusCode: number;
    } | null = null;
    if (resolution.shouldPersist) {
      try {
        persisted = await trading.persistTrade({
          intent: sharedIntent,
          prepared,
          submitResult,
        });
        effects = await trading.applyTradeEffects({
          intent: sharedIntent,
          persisted,
          submitResult,
        });
      } catch (error) {
        const normalized = trading.normalizeError(intent.venue, error);
        postSubmitError = {
          code: normalized.code,
          message: normalized.message,
          statusCode: normalized.statusCode,
        };
      }
    }
    const venueOrderId = persisted?.venueOrderId ?? submitVenueOrderId;
    await updateIntentStatus({
      allowedStatuses: ["executing"],
      db: input.db,
      errorCode: postSubmitError?.code ?? resolution.errorCode,
      errorMessage: postSubmitError?.message ?? resolution.errorMessage,
      executionId: persisted?.executionId ?? null,
      intentId: intent.id,
      orderId: persisted?.orderId ?? null,
      preparedSnapshot,
      result: {
        effects,
        persisted,
        quote,
        postSubmitError,
        submitResult,
      },
      status: postSubmitError ? "submitted" : resolution.intentStatus,
      txSignature: submitResult.txSignature,
      venueOrderId,
    });
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: Boolean(postSubmitError),
      text: postSubmitError
        ? `${resolution.callbackText} Recording needs review.`
        : resolution.callbackText,
    });
    await input.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      text: escapeMarkdown(
        [
          resolution.messageTitle,
          `${intent.venue} · ${intent.market_title}`,
          `${side} · ${formatUsd(amountUsd)}`,
          venueOrderId ? `Order: ${venueOrderId}` : null,
          postSubmitError
            ? "Venue accepted the submit, but Hunch could not finish local recording. Check the app before retrying."
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      ),
    });
  } catch (error) {
    const normalized = trading.normalizeError(intent.venue, error);
    if (submittedRefs) {
      await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        errorCode: "reconcile_required",
        errorMessage: normalized.message,
        intentId: intent.id,
        result: {
          error: normalized,
          submitResult: submittedRefs.submitResult,
          venue: intent.venue,
        },
        status: "submitted",
        txSignature: submittedRefs.submitResult.txSignature,
        venueOrderId: submittedRefs.venueOrderId,
      });
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "Trade submitted. Recording needs review.",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          [
            "Trade submitted.",
            `${intent.venue} · ${intent.market_title}`,
            `${side} · ${formatUsd(amountUsd)}`,
            submittedRefs.venueOrderId
              ? `Order: ${submittedRefs.venueOrderId}`
              : null,
            "Hunch could not finish local recording. Check the app before retrying.",
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
        ),
      });
      return true;
    }
    await updateIntentStatus({
      allowedStatuses: ["executing"],
      db: input.db,
      errorCode: normalized.code,
      errorMessage: normalized.message,
      intentId: intent.id,
      result: {
        error: normalized,
        venue: intent.venue,
      },
      status: "failed",
    });
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text:
        normalized.code === "unsupported_capability"
          ? "Open Hunch to place this trade."
          : "Trade failed. Check the bot message.",
    });
    const url = new URL(
      `/events/${encodeURIComponent(intent.event_id ?? "")}`,
      `${normalizeBaseUrl(input.appBaseUrl)}/`,
    );
    url.searchParams.set("market", intent.market_id);
    await input.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [[{ text: "Open in Hunch", url: url.toString() }]],
      },
      text: escapeMarkdown(
        normalized.code === "unsupported_capability"
          ? "This venue is not executable from the bot yet. Open Hunch to trade."
          : normalized.message,
      ),
    });
  }
  return true;
}

export async function captureTelegramBotTradingCallback(input: {
  appBaseUrl: string;
  callbackQuery: TelegramBotTradingCallbackInput["callbackQuery"];
  db: DbQuery;
  expectedIntentId?: string | null;
  expectedType?: "buy" | "cancel" | "confirm" | null;
  trading?: ApiBotTradingExecutor;
}): Promise<CapturedTelegramBotTradingCallbackResult> {
  const answers: CapturedTelegramBotTradingCallbackResult["answers"] = [];
  const messages: CapturedTelegramBotTradingCallbackResult["messages"] = [];
  const handled = await handleTelegramBotTradingCallback({
    answerCallbackQuery: async (answer) => {
      answers.push(answer);
      return undefined;
    },
    appBaseUrl: input.appBaseUrl,
    callbackQuery: input.callbackQuery,
    db: input.db,
    expectedIntentId: input.expectedIntentId,
    expectedType: input.expectedType,
    sendMessage: async (message) => {
      messages.push(message);
      return undefined;
    },
    trading: input.trading,
  });
  return { answers, handled, messages };
}
