import crypto from "node:crypto";
import { ethers } from "ethers";

import { AuthService } from "../auth.js";
import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  findTradeMarketById,
  findTradeMarketByRef,
  isOrderable,
  type ApiTradeMarket,
} from "./api-trading-market-repo.js";
import {
  resolveSignalBotTradingPolicyFromDb,
  type SignalBotPolicy,
} from "./signal-bot-trading-policy.js";
import {
  parseTelegramBotTradingCallbackData,
  TELEGRAM_BOT_TRADING_CALLBACK_PREFIX,
} from "./telegram-bot-trading-client.js";
import { normalizeKalshiTradeEligibility } from "./kalshi-trade-eligibility.js";
import {
  inspectServerEvmWalletAuthorization,
  assertServerEvmWalletAuthorization,
  createServerWalletClient,
  hasConfiguredPrivyBotPolicyForActions,
  signPolymarketRedemptionBatch,
  type PrivyServerSignerGrant,
  type PrivyServerSignerStatus,
} from "./api-trading-wallet-signing.js";
import { fetchEmbeddedEthereumTransactionReceipt } from "./embedded-ethereum.js";
import { buildPolymarketRedemptionPlan } from "./polymarket-redemption-plan.js";
import {
  buildDepositWalletBatchTypedData,
  buildDepositWalletSubmitBody,
  fetchPolymarketRelayerNonce,
  POLYMARKET_RELAYER_FAILED_STATES,
  POLYMARKET_RELAYER_SUCCESS_STATES,
  submitPolymarketDepositWalletBatch,
  sumTokenTransfersTo,
  waitForPolymarketRelayerTransaction,
} from "./polymarket-deposit-wallet-relayer.js";
import type { ApiBotTradingExecutor } from "./api-trading-service.js";
import type {
  KalshiTradeEligibility,
  SubmitResult,
  TradeExecutionAuthorization,
  TradeIntent,
  TradeQuote,
  TradeTarget,
  TradingReadiness,
  TradingReadinessInput,
  TradingReadinessRepairSideEffect,
} from "./trading-types.js";

import { isDefinitiveSubmitRejection } from "./telegram-bot-trading-submit-error.js";
import {
  escapeTelegramMarkdownV2 as escapeMarkdown,
  formatTelegramLivePrice as formatLivePrice,
  formatTelegramQuotePrice,
  formatTelegramQuoteTtl as formatQuoteTtl,
  formatTelegramTtl as formatTtl,
} from "./telegram-bot-trading-presentation.js";
import { outcomeLabelOrSide } from "./wallet-intel-helpers.js";
import { resolvePolymarketAvailablePositionRaw } from "./polymarket-trading-execution-service.js";
import {
  buildRedemptionNotification,
  createNotificationSafe,
} from "./notifications.js";
import { venueLifecycleAllows } from "./venue-lifecycle.js";

export type TelegramBotTradingVenue = "kalshi" | "limitless" | "polymarket";
export type TelegramBotTradingAction = "buy" | "sell" | "redeem";
export type TelegramBotTradingSide = "NO" | "YES";
export type TelegramBotTradingWalletChain = "ethereum" | "solana";

const EXISTING_TRADE_RESOLVING_MESSAGE =
  "Existing trade is still resolving. The bot is checking the venue automatically; no action is needed. Check /trade_status before retrying.";
const UNKNOWN_TRADE_RESOLVING_MESSAGE =
  "Trade status is unknown. The bot is checking the venue automatically; no action is needed. Check /trade_status before retrying.";

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

type TelegramBotMarketRow = ApiTradeMarket;

type SubmittedTradeRefs = {
  submitResult: SubmitResult;
  venueOrderId: string | null;
};

type TelegramReadinessRepairAudit = {
  attempted: true;
  changed: boolean;
  finalReasonCode: string | null;
  sideEffects: TradingReadinessRepairSideEffect[];
};

type TelegramSetupTransactionAudit = {
  kind: "approval" | "funding_router" | "redemption_adapter";
  referenceId?: string | null;
  transactionId?: string | null;
  txHash: string | null;
};

type TelegramTradeQuotePreview = {
  availableShares: number | null;
  currentPrice: number | null;
  estimatedNotionalUsd: number | null;
  estimatedShares: number | null;
  expiresAt: string | null;
  maxSpendUsd: number | null;
  minimumReceiveUsd: number | null;
  minReceiveShares: number | null;
  minimumOrderSizeShares: number | null;
  meetsVenueMinimum: boolean | null;
  price: number | null;
};

type DbTransactionClient = DbQuery & { release: () => void };
type TransactionalDbQuery = DbQuery & {
  connect?: () => Promise<DbTransactionClient>;
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
  sell_percent: string | null;
  shares_raw: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  submit_started_at: Date | null;
  quote_snapshot: Record<string, unknown>;
  policy_snapshot: Record<string, unknown>;
  expires_at: Date;
  market_title: string;
  market_status: string;
};

type UnresolvedTelegramTradeIntentRow = {
  id: string;
  error_code: string | null;
  side: TelegramBotTradingSide | null;
  status: string;
};

export type TelegramBotTradingStatus = {
  actionStatuses: Record<
    TelegramBotTradingAction,
    TelegramBotTradingActionStatus
  >;
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
  signerStatus: PrivyServerSignerStatus | null;
  setupIssue: string | null;
  signerWallets: TelegramBotTradingSignerWalletStatus[];
  telegramUserId: string | null;
  username: string | null;
  userId: string | null;
  venueStatuses: TelegramBotTradingVenueStatus[];
  walletAddress: string | null;
  walletChain: "ethereum" | "solana" | null;
  walletSetupIssues: TelegramBotTradingWalletSetupIssue[];
};

export type TelegramBotTradingActionStatus = {
  enabled: boolean;
  ready: boolean;
  reasonCode: string | null;
  message: string | null;
};

export function buildTelegramBotTradingActionStatuses(input: {
  actions: readonly TelegramBotTradingAction[];
  directExecutionReady: boolean;
  readiness?: Partial<Record<TelegramBotTradingAction, boolean>>;
  sellConfigured?: boolean;
  redeemConfigured?: boolean;
}): Record<TelegramBotTradingAction, TelegramBotTradingActionStatus> {
  const enabled = new Set(input.actions);
  const configured = {
    buy: true,
    sell: input.sellConfigured ?? false,
    redeem: input.redeemConfigured ?? false,
  } as const;
  return Object.fromEntries(
    (["buy", "sell", "redeem"] as const).map((action) => {
      const actionEnabled = enabled.has(action);
      const actionConfigured = configured[action];
      const executionReady =
        input.readiness?.[action] ?? input.directExecutionReady;
      const ready = actionEnabled && actionConfigured && executionReady;
      return [
        action,
        {
          enabled: actionEnabled,
          ready,
          reasonCode: !actionEnabled
            ? "runtime_action_disabled"
            : !actionConfigured
              ? "action_configuration_missing"
              : executionReady
                ? null
                : "direct_execution_not_ready",
          message: !actionEnabled
            ? "This action is disabled by runtime policy."
            : !actionConfigured
              ? "This action is not configured yet."
              : executionReady
                ? null
                : "Direct execution is not ready.",
        },
      ];
    }),
  ) as Record<TelegramBotTradingAction, TelegramBotTradingActionStatus>;
}

export type TelegramBotTradingSignerWalletStatus = {
  privyWalletId: string;
  signerStatus: PrivyServerSignerStatus;
  walletAddress: string;
  walletChain: "ethereum";
};

export type TelegramBotTradingAuthorizationStatus = {
  authorizationId: string;
  directExecutionReady: boolean;
  enabled: boolean;
  enabledVenues: TelegramBotTradingVenue[];
  maxAmountUsd: number | null;
  privyWalletId: string | null;
  signerStatus: PrivyServerSignerStatus | null;
  setupIssue: string | null;
  venueStatuses: TelegramBotTradingVenueStatus[];
  walletAddress: string;
  walletChain: "ethereum" | "solana";
};

export type TelegramBotTradingVenueStatus = {
  canAttempt: boolean;
  enabled: boolean;
  executable: boolean;
  maxExecutableBuyUsd: number | null;
  message: string | null;
  eligibilityExpiresAt: string | null;
  geoAllowed: boolean | null;
  proofVerified: boolean | null;
  reasonCode: string | null;
  repairKind: "app_required" | "auto" | null;
  state:
    | "app_setup"
    | "auto_setup"
    | "disabled"
    | "ready"
    | "unavailable"
    | "unfunded";
  venue: TelegramBotTradingVenue;
  walletAddress: string;
  walletChain: "ethereum" | "solana";
};

export type TelegramBotTradingWalletSetupIssue = {
  code: "internal_wallet_missing";
  message: string;
  venue: TelegramBotTradingVenue;
  walletChain: "ethereum" | "solana";
};

export class TelegramBotTradingEnableError extends Error {
  readonly code: string;
  readonly grants: PrivyServerSignerGrant[];
  readonly statusCode: number;
  readonly walletSetupIssues: TelegramBotTradingWalletSetupIssue[];

  constructor(input: {
    code: string;
    grants?: PrivyServerSignerGrant[];
    message: string;
    statusCode?: number;
    walletSetupIssues?: TelegramBotTradingWalletSetupIssue[];
  }) {
    super(input.message);
    this.name = "TelegramBotTradingEnableError";
    this.code = input.code;
    this.grants = input.grants ?? [];
    this.statusCode = input.statusCode ?? 400;
    this.walletSetupIssues = input.walletSetupIssues ?? [];
  }
}

export type TelegramBotTradingInternalWalletCandidate = {
  privyWalletId: string;
  walletAddress: string;
  walletChain: TelegramBotTradingWalletChain;
};

export type TelegramBotTradingKalshiEligibilityBuilder = (
  walletAddress: string,
) => Promise<KalshiTradeEligibility | null>;

export type EnableTelegramBotTradingInput = {
  buildKalshiEligibilityForWallet?: TelegramBotTradingKalshiEligibilityBuilder;
  enabledVenues?: TelegramBotTradingVenue[];
  internalWallets?: TelegramBotTradingInternalWalletCandidate[];
  kalshiEligibility?: KalshiTradeEligibility | null;
  maxAmountUsd?: number | null;
  preferredWalletAddress?: string | null;
  privyWalletId?: string | null;
  signerInspector?: TelegramBotTradingSignerInspector;
  userId: string;
  walletAddress?: string | null;
};

export type TelegramBotTradingSignerInspector = (
  input: Parameters<typeof inspectServerEvmWalletAuthorization>[0],
) => Promise<PrivyServerSignerStatus>;

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
      chat?: { id: string | number; type?: string };
      message_id?: number;
    };
  };
  db: DbQuery;
  expectedIntentId?: string | null;
  expectedType?: "buy" | "sell" | "redeem" | "cancel" | "confirm" | null;
  log?: {
    debug?: (payload: unknown, message?: string) => void;
    info?: (payload: unknown, message?: string) => void;
    warn?: (payload: unknown, message?: string) => void;
  };
  sendMessage: (input: {
    chat_id: string;
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramBotTradingReplyMarkup;
    text: string;
  }) => Promise<unknown>;
  signerInspector?: TelegramBotTradingSignerInspector;
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

type VerifiedTelegramBotTradingWalletRow = {
  wallet_address: string;
  wallet_type: TelegramBotTradingWalletChain;
  is_primary: boolean | null;
  created_at: Date | null;
};

type SelectedTelegramBotTradingInternalWallet = {
  privyWalletId: string;
  walletAddress: string;
  walletChain: TelegramBotTradingWalletChain;
};

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
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

function walletChainForVenue(
  venue: TelegramBotTradingVenue,
): TelegramBotTradingWalletChain {
  return venue === "kalshi" ? "solana" : "ethereum";
}

function requestedChainsForVenues(
  venues: readonly TelegramBotTradingVenue[],
): TelegramBotTradingWalletChain[] {
  const chains: TelegramBotTradingWalletChain[] = [];
  if (filterVenuesForWalletChain(venues, "ethereum").length > 0) {
    chains.push("ethereum");
  }
  if (filterVenuesForWalletChain(venues, "solana").length > 0) {
    chains.push("solana");
  }
  return chains;
}

function normalizeWalletAddressForChain(
  address: string | null | undefined,
  walletChain: TelegramBotTradingWalletChain,
): string {
  const trimmed = address?.trim() ?? "";
  return walletChain === "ethereum" ? trimmed.toLowerCase() : trimmed;
}

function internalWalletMissingMessage(
  walletChain: TelegramBotTradingWalletChain,
): string {
  return walletChain === "ethereum"
    ? "Telegram bot trading needs an internal Hunch EVM Trading Wallet."
    : "Telegram bot trading needs an internal Hunch Solana Trading Wallet.";
}

function buildTelegramBotTradingWalletSetupIssues(input: {
  selectedWalletChains: readonly TelegramBotTradingWalletChain[];
  requestedVenues: readonly TelegramBotTradingVenue[];
}): TelegramBotTradingWalletSetupIssue[] {
  const selectedChains = new Set(input.selectedWalletChains);
  const missingChains = new Set<TelegramBotTradingWalletChain>();
  const issues: TelegramBotTradingWalletSetupIssue[] = [];
  for (const venue of input.requestedVenues) {
    const walletChain = walletChainForVenue(venue);
    if (selectedChains.has(walletChain)) continue;
    if (missingChains.has(walletChain)) continue;
    missingChains.add(walletChain);
    issues.push({
      code: "internal_wallet_missing",
      message: internalWalletMissingMessage(walletChain),
      venue,
      walletChain,
    });
  }
  return issues;
}

function buildInternalWalletCandidateLookup(
  candidates: readonly TelegramBotTradingInternalWalletCandidate[],
): {
  byAddress: Map<string, TelegramBotTradingInternalWalletCandidate>;
  byId: Map<string, TelegramBotTradingInternalWalletCandidate>;
} {
  const byAddress = new Map<
    string,
    TelegramBotTradingInternalWalletCandidate
  >();
  const byId = new Map<string, TelegramBotTradingInternalWalletCandidate>();
  for (const candidate of candidates) {
    const walletId = candidate.privyWalletId.trim();
    const address = normalizeWalletAddressForChain(
      candidate.walletAddress,
      candidate.walletChain,
    );
    if (!walletId || !address) continue;
    const normalized = {
      ...candidate,
      privyWalletId: walletId,
    };
    byAddress.set(`${candidate.walletChain}:${address}`, normalized);
    byId.set(`${candidate.walletChain}:${walletId}`, normalized);
  }
  return { byAddress, byId };
}

function selectInternalWalletForChain(input: {
  internalWallets: ReturnType<typeof buildInternalWalletCandidateLookup>;
  preferredPrivyWalletId?: string | null;
  preferredWalletAddress?: string | null;
  verifiedWallets: readonly VerifiedTelegramBotTradingWalletRow[];
  walletChain: TelegramBotTradingWalletChain;
}): SelectedTelegramBotTradingInternalWallet | null {
  const eligible = input.verifiedWallets
    .filter((wallet) => wallet.wallet_type === input.walletChain)
    .map((wallet) => {
      const normalizedAddress = normalizeWalletAddressForChain(
        wallet.wallet_address,
        input.walletChain,
      );
      const internal = input.internalWallets.byAddress.get(
        `${input.walletChain}:${normalizedAddress}`,
      );
      return internal
        ? {
            internal,
            isPrimary: Boolean(wallet.is_primary),
            createdAtMs:
              wallet.created_at?.getTime() ?? Number.MAX_SAFE_INTEGER,
            normalizedAddress,
            walletAddress: wallet.wallet_address,
          }
        : null;
    })
    .filter((wallet): wallet is NonNullable<typeof wallet> => wallet != null)
    .sort((left, right) => {
      const primaryDiff = Number(right.isPrimary) - Number(left.isPrimary);
      if (primaryDiff !== 0) return primaryDiff;
      if (left.createdAtMs !== right.createdAtMs) {
        return left.createdAtMs - right.createdAtMs;
      }
      return left.normalizedAddress.localeCompare(right.normalizedAddress);
    });
  if (eligible.length === 0) return null;

  const preferredPrivyWalletId = input.preferredPrivyWalletId?.trim();
  if (preferredPrivyWalletId) {
    const preferredInternal = input.internalWallets.byId.get(
      `${input.walletChain}:${preferredPrivyWalletId}`,
    );
    if (preferredInternal) {
      const selectedById = eligible.find(
        (wallet) => wallet.internal.privyWalletId === preferredPrivyWalletId,
      );
      return selectedById
        ? {
            privyWalletId: selectedById.internal.privyWalletId,
            walletAddress: selectedById.walletAddress,
            walletChain: input.walletChain,
          }
        : null;
    }
  }

  const preferredAddress = normalizeWalletAddressForChain(
    input.preferredWalletAddress,
    input.walletChain,
  );
  const selected =
    (preferredAddress
      ? eligible.find((wallet) => wallet.normalizedAddress === preferredAddress)
      : null) ?? eligible[0];
  if (!selected) return null;
  return {
    privyWalletId: selected.internal.privyWalletId,
    walletAddress: selected.walletAddress,
    walletChain: input.walletChain,
  };
}

function buildTelegramBotTradingWalletSelection(input: {
  internalWallets: readonly TelegramBotTradingInternalWalletCandidate[];
  preferredPrivyWalletId?: string | null;
  preferredWalletAddress?: string | null;
  requestedVenues: readonly TelegramBotTradingVenue[];
  verifiedWallets: readonly VerifiedTelegramBotTradingWalletRow[];
}): {
  requestedChains: TelegramBotTradingWalletChain[];
  selectedByChain: Map<
    TelegramBotTradingWalletChain,
    SelectedTelegramBotTradingInternalWallet
  >;
  walletSetupIssues: TelegramBotTradingWalletSetupIssue[];
} {
  const internalWallets = buildInternalWalletCandidateLookup(
    input.internalWallets,
  );
  const requestedChains = requestedChainsForVenues(input.requestedVenues);
  const selectedByChain = new Map<
    TelegramBotTradingWalletChain,
    SelectedTelegramBotTradingInternalWallet
  >();
  for (const walletChain of requestedChains) {
    const selected = selectInternalWalletForChain({
      internalWallets,
      preferredPrivyWalletId: input.preferredPrivyWalletId,
      preferredWalletAddress: input.preferredWalletAddress,
      verifiedWallets: input.verifiedWallets,
      walletChain,
    });
    if (selected) selectedByChain.set(walletChain, selected);
  }
  return {
    requestedChains,
    selectedByChain,
    walletSetupIssues: buildTelegramBotTradingWalletSetupIssues({
      requestedVenues: input.requestedVenues,
      selectedWalletChains: Array.from(selectedByChain.keys()),
    }),
  };
}

async function loadVerifiedTelegramBotTradingWallets(
  db: DbQuery,
  userId: string,
): Promise<VerifiedTelegramBotTradingWalletRow[]> {
  const walletsResult = await db.query<VerifiedTelegramBotTradingWalletRow>(
    `SELECT
       uw.wallet_address,
       uw.wallet_type,
       uw.is_primary,
       uw.created_at
     FROM user_wallets uw
     WHERE uw.user_id = $1
       AND uw.is_verified = true
       AND uw.wallet_type = ANY($2::text[])
     ORDER BY
       uw.is_primary DESC NULLS LAST,
       uw.created_at ASC NULLS LAST,
       lower(uw.wallet_address) ASC`,
    [userId, ["ethereum", "solana"]],
  );
  return walletsResult.rows;
}

export async function resolveTelegramBotTradingWalletSetupIssues(
  db: DbQuery,
  input: {
    internalWallets: readonly TelegramBotTradingInternalWalletCandidate[];
    preferredWalletAddress?: string | null;
    requestedVenues: readonly TelegramBotTradingVenue[];
    userId: string;
  },
): Promise<TelegramBotTradingWalletSetupIssue[]> {
  const verifiedWallets = await loadVerifiedTelegramBotTradingWallets(
    db,
    input.userId,
  );
  return buildTelegramBotTradingWalletSelection({
    internalWallets: input.internalWallets,
    preferredWalletAddress: input.preferredWalletAddress,
    requestedVenues: input.requestedVenues,
    verifiedWallets,
  }).walletSetupIssues;
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

function buildTelegramTradeQuotePreview(
  quote: TradeQuote,
): TelegramTradeQuotePreview {
  return {
    currentPrice: quote.currentPrice ?? null,
    availableShares: quote.availableShares ?? null,
    estimatedNotionalUsd: quote.estimatedNotionalUsd,
    estimatedShares: quote.estimatedShares,
    expiresAt: quote.expiresAt?.toISOString() ?? null,
    maxSpendUsd: quote.maxSpendUsd,
    minimumReceiveUsd: quote.minimumReceiveUsd ?? null,
    minReceiveShares: quote.minReceiveShares,
    minimumOrderSizeShares: quote.minimumOrderSizeShares ?? null,
    meetsVenueMinimum: quote.meetsVenueMinimum ?? null,
    price: quote.price,
  };
}

function readTelegramTradeQuotePreview(
  value: Record<string, unknown> | null | undefined,
): TelegramTradeQuotePreview | null {
  if (!value) return null;
  const readNullableNumber = (key: keyof TelegramTradeQuotePreview) => {
    const candidate = value[key];
    if (candidate == null) return null;
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const expiresAt =
    typeof value.expiresAt === "string" ? value.expiresAt : null;
  const preview = {
    currentPrice: readNullableNumber("currentPrice"),
    availableShares: readNullableNumber("availableShares"),
    estimatedNotionalUsd: readNullableNumber("estimatedNotionalUsd"),
    estimatedShares: readNullableNumber("estimatedShares"),
    expiresAt,
    maxSpendUsd: readNullableNumber("maxSpendUsd"),
    minimumReceiveUsd: readNullableNumber("minimumReceiveUsd"),
    minReceiveShares: readNullableNumber("minReceiveShares"),
    minimumOrderSizeShares: readNullableNumber("minimumOrderSizeShares"),
    meetsVenueMinimum:
      typeof value.meetsVenueMinimum === "boolean"
        ? value.meetsVenueMinimum
        : null,
    price: readNullableNumber("price"),
  };
  return Object.values(preview).some((candidate) => candidate != null)
    ? preview
    : null;
}

function quoteMovedBeyondTelegramTolerance(input: {
  current: TradeQuote;
  maxSlippageBps: number;
  preview: TelegramTradeQuotePreview | null;
}): boolean {
  if (!input.preview) return false;
  if (input.current.action === "SELL") {
    return Boolean(
      (input.preview.price != null &&
        input.current.price != null &&
        input.current.price < input.preview.price) ||
      (input.preview.minimumReceiveUsd != null &&
        input.current.minimumReceiveUsd != null &&
        input.current.minimumReceiveUsd < input.preview.minimumReceiveUsd),
    );
  }
  const tolerance = input.maxSlippageBps / 10_000;
  if (
    input.preview.price != null &&
    input.current.price != null &&
    input.current.price > input.preview.price * (1 + tolerance)
  ) {
    return true;
  }
  if (
    input.preview.estimatedShares != null &&
    input.current.estimatedShares != null &&
    input.current.estimatedShares <
      input.preview.estimatedShares * (1 - tolerance)
  ) {
    return true;
  }
  return Boolean(
    input.preview.maxSpendUsd != null &&
    input.current.maxSpendUsd != null &&
    input.current.maxSpendUsd > input.preview.maxSpendUsd * (1 + tolerance),
  );
}

function executionAuthorizationForAuthorization(
  authorization: TelegramBotTradingAuthorizationRow,
): TradeExecutionAuthorization {
  return {
    privyUserId: authorization.privy_user_id,
    privyWalletId: authorization.privy_wallet_id,
    kalshiEligibility:
      authorization.wallet_chain === "solana"
        ? normalizeKalshiTradeEligibility(authorization.limits)
        : null,
  };
}

function isAutoRepairableReadiness(
  readiness: TradingReadiness | null | undefined,
): boolean {
  return readiness?.repair?.kind === "auto";
}

function canOfferTradeForReadiness(
  readiness: TradingReadiness | null | undefined,
): boolean {
  return Boolean(readiness?.executable || isAutoRepairableReadiness(readiness));
}

function venueStatusFromReadiness(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  enabled: boolean;
  readiness?: TradingReadiness | null;
  venue: TelegramBotTradingVenue;
}): TelegramBotTradingVenueStatus {
  const readiness = input.readiness ?? null;
  const repairKind = readiness?.repair?.kind ?? null;
  const reasonCode = readiness?.reasonCode ?? null;
  const normalizedReasonCode = reasonCode?.toLowerCase() ?? "";
  const isUnfunded =
    normalizedReasonCode.includes("no_executable_funds") ||
    normalizedReasonCode.includes("insufficient_funds") ||
    normalizedReasonCode.includes("sol_funding") ||
    normalizedReasonCode.includes("sol_balance");
  const state: TelegramBotTradingVenueStatus["state"] = !input.enabled
    ? "disabled"
    : readiness?.executable
      ? "ready"
      : repairKind === "auto"
        ? "auto_setup"
        : isUnfunded
          ? "unfunded"
          : repairKind === "app_required"
            ? "app_setup"
            : "unavailable";
  const kalshiEligibility =
    input.venue === "kalshi"
      ? normalizeKalshiTradeEligibility(input.authorization.limits)
      : null;
  return {
    canAttempt: Boolean(
      input.enabled &&
      (readiness?.executable || readiness?.repair?.kind === "auto"),
    ),
    enabled: input.enabled,
    eligibilityExpiresAt: kalshiEligibility?.expiresAt ?? null,
    executable: Boolean(input.enabled && readiness?.executable),
    geoAllowed: kalshiEligibility?.geoAllowed ?? null,
    maxExecutableBuyUsd:
      readiness?.maxExecutableBuyUsd == null
        ? null
        : readiness.maxExecutableBuyUsd,
    message: readiness?.executable
      ? null
      : (readiness?.message ??
        (input.enabled
          ? "Venue readiness is unavailable."
          : "Venue is disabled.")),
    reasonCode,
    repairKind,
    proofVerified: kalshiEligibility?.proofVerified ?? null,
    state,
    venue: input.venue,
    walletAddress: input.authorization.wallet_address,
    walletChain: input.authorization.wallet_chain,
  };
}

export const telegramBotTradingTestHooks = {
  buildTelegramSellTradeIntent,
  isDefinitiveSubmitRejection,
  isTelegramVenueMinimumBlocking,
  marketForCallbackReadiness,
  resolveTelegramExecutableBuyOption,
  venueStatusFromReadiness,
};

export function isTelegramVenueMinimumBlocking(input: {
  action: string;
  meetsVenueMinimum: boolean | null | undefined;
  orderType: string | null | undefined;
  venue: string;
}): boolean {
  if (input.meetsVenueMinimum !== false) return false;
  return !(
    input.venue.toLowerCase() === "polymarket" &&
    input.action.toUpperCase() === "BUY" &&
    input.orderType?.toUpperCase() === "FOK"
  );
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

function unavailableTelegramTradingReadiness(input: {
  message: string;
  venue: TelegramBotTradingVenue;
}): TradingReadiness {
  return {
    ready: false,
    executable: false,
    reasonCode: "internal_api_unavailable",
    message: input.message,
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

async function resolveTelegramTradingReadiness(input: {
  action?: "BUY" | "SELL";
  authorization?: TelegramBotTradingAuthorizationRow | null;
  market?: TelegramBotMarketRow | null;
  status?: TelegramBotTradingStatus | null;
  trading?: ApiBotTradingExecutor;
  venue: TelegramBotTradingVenue;
}): Promise<TradingReadiness> {
  const trading = input.trading;
  if (!trading) {
    return unavailableTelegramTradingReadiness({
      message: "Direct bot trading is unavailable. Open Hunch to trade.",
      venue: input.venue,
    });
  }
  try {
    return await trading.getReadiness(
      buildTelegramTradingReadinessInput(input),
    );
  } catch {
    return unavailableTelegramTradingReadiness({
      message: "Trading venue readiness is temporarily unavailable.",
      venue: input.venue,
    });
  }
}

function buildTelegramTradingReadinessInput(input: {
  action?: "BUY" | "SELL";
  authorization?: TelegramBotTradingAuthorizationRow | null;
  market?: TelegramBotMarketRow | null;
  status?: TelegramBotTradingStatus | null;
  venue: TelegramBotTradingVenue;
}): TradingReadinessInput {
  const status = input.status;
  const authorization = input.authorization;
  return {
    actor: {
      kind: "telegram_bot",
      userId: authorization?.user_id ?? status?.userId ?? "",
      telegramUserId:
        authorization?.telegram_user_id ?? status?.telegramUserId ?? null,
      authorizationId: authorization?.id ?? status?.authorizationId ?? null,
    },
    action: input.action ?? "BUY",
    executionAuthorization: authorization
      ? executionAuthorizationForAuthorization(authorization)
      : {
          privyUserId: status?.privyUserId ?? null,
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
  };
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

function buildTelegramSellTradeIntent(input: {
  availableSharesRaw?: bigint;
  authorization: TelegramBotTradingAuthorizationRow;
  intentId: string;
  market: TelegramBotMarketRow;
  maxSlippageBps: number;
  sharesRaw: bigint;
  side: TelegramBotTradingSide;
}): TradeIntent {
  return {
    ...buildTelegramTradeIntent({
      amountUsd: 1,
      authorization: input.authorization,
      intentId: input.intentId,
      market: input.market,
      maxSlippageBps: input.maxSlippageBps,
      side: input.side,
    }),
    action: "SELL",
    amount: {
      type: "shares",
      value: ethers.formatUnits(input.sharesRaw, 6),
    },
    raw: {
      sharesRaw: input.sharesRaw.toString(),
      availableSharesRaw: (
        input.availableSharesRaw ?? input.sharesRaw
      ).toString(),
    },
  };
}

function marketForCallbackReadiness(
  action: "BUY" | "SELL",
  market: TelegramBotMarketRow,
): TelegramBotMarketRow | null {
  // SELL quantity is fixed when the button is created. Preview and execution
  // reuse that snapshot; prepareTrade performs the single fresh balance,
  // live-lock and approval check immediately before signing.
  return action === "SELL" ? null : market;
}

type TelegramExecutableBuyOption = {
  amountUsd: number;
  currentPrice: number;
  maxSpendUsd: number;
  quote: TradeQuote;
  side: TelegramBotTradingSide;
};

type TelegramExecutableSellOption = {
  currentPrice: number;
  minimumReceiveUsd: number;
  quote: TradeQuote;
  sellPercent: 50 | 100;
  sharesRaw: bigint;
  side: TelegramBotTradingSide;
};

async function resolveTelegramExecutableSellOptions(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  market: TelegramBotMarketRow;
  maxSlippageBps: number;
  side: TelegramBotTradingSide;
  trading: ApiBotTradingExecutor;
}): Promise<TelegramExecutableSellOption[]> {
  if (input.market.venue !== "polymarket") return [];
  const tokenId =
    input.side === "YES" ? input.market.token_yes : input.market.token_no;
  if (!tokenId) return [];
  let availability: Awaited<
    ReturnType<typeof resolvePolymarketAvailablePositionRaw>
  >;
  try {
    availability = await resolvePolymarketAvailablePositionRaw({
      pool: input.db,
      signer: input.authorization.wallet_address,
      tokenId,
      userId: input.authorization.user_id,
    });
  } catch {
    return [];
  }
  const options: TelegramExecutableSellOption[] = [];
  for (const sellPercent of [50, 100] as const) {
    const requestedRaw =
      (availability.availableRaw * BigInt(sellPercent)) / 100n;
    if (requestedRaw <= 0n) continue;
    try {
      const quote = await input.trading.quote({
        intent: buildTelegramSellTradeIntent({
          availableSharesRaw: availability.availableRaw,
          authorization: input.authorization,
          intentId: crypto.randomUUID(),
          market: input.market,
          maxSlippageBps: input.maxSlippageBps,
          sharesRaw: requestedRaw,
          side: input.side,
        }),
      });
      const raw = isRecord(quote.raw) ? quote.raw : null;
      const quotedSharesRaw = raw?.makerAmount;
      const sharesRaw =
        typeof quotedSharesRaw === "string" && /^\d+$/.test(quotedSharesRaw)
          ? BigInt(quotedSharesRaw)
          : requestedRaw;
      const currentPrice = quote.currentPrice;
      const minimumReceiveUsd = quote.minimumReceiveUsd;
      if (
        quote.meetsVenueMinimum === false ||
        sharesRaw <= 0n ||
        currentPrice == null ||
        currentPrice <= 0 ||
        minimumReceiveUsd == null ||
        minimumReceiveUsd <= 0
      ) {
        continue;
      }
      options.push({
        currentPrice,
        minimumReceiveUsd,
        quote,
        sellPercent,
        sharesRaw,
        side: input.side,
      });
    } catch {
      continue;
    }
  }
  return options;
}

async function resolveTelegramExecutableBuyOption(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  market: TelegramBotMarketRow;
  maxAmountUsd: number;
  maxExecutableBuyUsd: number | null;
  maxSlippageBps: number;
  nominalAmountUsd: number;
  side: TelegramBotTradingSide;
  trading: ApiBotTradingExecutor;
}): Promise<TelegramExecutableBuyOption | null> {
  const amountUsd = input.nominalAmountUsd;
  const intent = buildTelegramTradeIntent({
    amountUsd,
    authorization: input.authorization,
    intentId: crypto.randomUUID(),
    market: input.market,
    maxSlippageBps: input.maxSlippageBps,
    side: input.side,
  });
  let quote: TradeQuote;
  try {
    quote = await input.trading.quote({ intent });
  } catch {
    return null;
  }
  if (
    isTelegramVenueMinimumBlocking({
      action: intent.action,
      meetsVenueMinimum: quote.meetsVenueMinimum,
      orderType: intent.orderType,
      venue: intent.venue,
    })
  ) {
    return null;
  }
  const currentPrice = quote.currentPrice;
  const maxSpendUsd = quote.maxSpendUsd ?? amountUsd;
  if (
    currentPrice == null ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0 ||
    maxSpendUsd > input.maxAmountUsd ||
    (input.maxExecutableBuyUsd != null &&
      maxSpendUsd > input.maxExecutableBuyUsd)
  ) {
    return null;
  }
  return { amountUsd, currentPrice, maxSpendUsd, quote, side: input.side };
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
  return isOrderable(market);
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

export function buildUnlinkedTelegramBotTradingStatus(input: {
  privyUserId?: string | null;
  setupIssue?: string;
  telegramUserId?: string | null;
  userId?: string | null;
}): TelegramBotTradingStatus {
  return {
    actionStatuses: buildTelegramBotTradingActionStatuses({
      actions: ["buy"],
      directExecutionReady: false,
    }),
    authorizationId: null,
    activeAuthorization: null,
    authorizations: [],
    directExecutionReady: false,
    enabled: false,
    enabledVenues: [],
    linked: false,
    maxAmountUsd: null,
    privyUserId: input.privyUserId ?? null,
    privyWalletId: null,
    signerStatus: null,
    setupIssue:
      input.setupIssue ?? "Telegram is not linked to a Hunch account.",
    signerWallets: [],
    telegramUserId: input.telegramUserId ?? null,
    username: null,
    userId: input.userId ?? null,
    venueStatuses: [],
    walletAddress: null,
    walletChain: null,
    walletSetupIssues: [],
  };
}

export async function getTelegramBotTradingStatus(
  db: DbQuery,
  telegramUserId: string | number,
  trading?: ApiBotTradingExecutor,
  signerInspector: TelegramBotTradingSignerInspector = inspectServerEvmWalletAuthorization,
): Promise<TelegramBotTradingStatus> {
  const normalizedTelegramUserId = normalizeTelegramUserId(telegramUserId);
  const runtimePolicy = await resolveTelegramBotTradingPolicy(db);
  const requiredActions = runtimePolicy.tradingActions.map((action) =>
    action === "redeem" ? "REDEEM" : (action.toUpperCase() as "BUY" | "SELL"),
  );
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
    return buildUnlinkedTelegramBotTradingStatus({
      telegramUserId: normalizedTelegramUserId,
    });
  }
  const authorizations: TelegramBotTradingAuthorizationStatus[] = [];
  const authorizationActionReadiness = new Map<
    string,
    Record<TelegramBotTradingAction, boolean>
  >();
  let safetyDisableApplied = false;
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
    let enabled = authorizationRow.enabled && !safetyDisableApplied;
    let signerStatus =
      authorizationRow.wallet_chain === "ethereum" &&
      authorizationRow.privy_wallet_id
        ? await signerInspector({
            authorizationEnabled:
              enabled && enabledVenues.every((venue) => venue === "polymarket"),
            requiredActions,
            privyUserId: authorizationRow.privy_user_id,
            signer: authorizationRow.wallet_address,
            walletId: authorizationRow.privy_wallet_id,
          })
        : null;
    const botPolicySafe =
      enabledVenues.length > 0 &&
      enabledVenues.every((venue) => venue === "polymarket") &&
      authorizationRow.wallet_chain === "ethereum" &&
      signerStatus?.state === "ready";
    if (enabled && !botPolicySafe) {
      await disableTelegramBotTradingLocal(db, {
        telegramUserId: normalizedTelegramUserId,
      });
      safetyDisableApplied = true;
      enabled = false;
      if (signerStatus?.attached && signerStatus.state === "ready") {
        signerStatus = {
          ...signerStatus,
          message: "Bot access is still attached and must be revoked.",
          state: "revoke_required",
        };
      }
    }
    const actionReadinessResults = new Map<
      TelegramBotTradingAction,
      TradingReadiness[]
    >();
    if (
      enabled &&
      authorizationRow.privy_wallet_id &&
      enabledVenues.length > 0
    ) {
      for (const action of runtimePolicy.tradingActions) {
        if (action === "redeem") continue;
        actionReadinessResults.set(
          action,
          await Promise.all(
            enabledVenues.map((venue) =>
              resolveTelegramTradingReadiness({
                action: action === "sell" ? "SELL" : "BUY",
                authorization: authorizationRow,
                trading,
                venue,
              }),
            ),
          ),
        );
      }
    }
    const primaryAction = runtimePolicy.tradingActions.includes("buy")
      ? "buy"
      : runtimePolicy.tradingActions.includes("sell")
        ? "sell"
        : null;
    const readinessResults = primaryAction
      ? (actionReadinessResults.get(primaryAction) ?? [])
      : [];
    const venueStatuses = enabledVenues.map((venue, index) => {
      const venueStatus = venueStatusFromReadiness({
        authorization: authorizationRow,
        enabled,
        readiness: readinessResults[index],
        venue,
      });
      if (venue === "limitless") {
        return {
          ...venueStatus,
          canAttempt: false,
          executable: false,
          message:
            "Telegram bot signing policy is not available for Limitless yet.",
          reasonCode: "privy_policy_unsupported_for_venue",
          repairKind: "app_required" as const,
          state: "app_setup" as const,
        };
      }
      if (venue === "kalshi") {
        return {
          ...venueStatus,
          canAttempt: false,
          executable: false,
          message:
            "Telegram bot signing policy is not configured for Kalshi yet.",
          reasonCode: "privy_policy_not_configured",
          repairKind: "app_required" as const,
          state: "app_setup" as const,
        };
      }
      if (signerStatus?.state !== "ready") {
        return {
          ...venueStatus,
          canAttempt: false,
          executable: false,
          message:
            signerStatus?.message ??
            "Privy server signer is not ready for this Trading Wallet.",
          reasonCode: `privy_server_signer_${signerStatus?.state ?? "not_configured"}`,
          repairKind: "app_required" as const,
          state: "app_setup" as const,
        };
      }
      return venueStatus;
    });
    const actionReadiness: Record<TelegramBotTradingAction, boolean> = {
      buy: Boolean(
        enabled &&
        actionReadinessResults
          .get("buy")
          ?.every((readiness) => readiness.executable),
      ),
      sell: Boolean(
        enabled &&
        actionReadinessResults
          .get("sell")
          ?.every((readiness) => readiness.executable),
      ),
      redeem: Boolean(
        enabled &&
        signerStatus?.state === "ready" &&
        enabledVenues.includes("polymarket") &&
        env.privyPolymarketBotRedeemPolicyId &&
        env.polymarketBuilderApiKey &&
        env.polymarketBuilderApiSecret &&
        env.polymarketBuilderApiPassphrase,
      ),
    };
    authorizationActionReadiness.set(authRow.id, actionReadiness);
    const directExecutionReady =
      enabled &&
      runtimePolicy.tradingActions.length > 0 &&
      runtimePolicy.tradingActions.every((action) => actionReadiness[action]);
    const readinessIssue =
      readinessResults.find((readiness) => readiness.message)?.message ?? null;
    authorizations.push({
      authorizationId: authRow.id,
      directExecutionReady,
      enabled,
      enabledVenues,
      maxAmountUsd: parseNumber(authorizationRow.max_amount_usd),
      privyWalletId: authorizationRow.privy_wallet_id,
      signerStatus,
      setupIssue: !enabled
        ? (signerStatus?.message ?? "Bot trading is disabled for this wallet.")
        : !authorizationRow.privy_wallet_id
          ? "Selected wallet is missing a Privy wallet id."
          : directExecutionReady
            ? null
            : (readinessIssue ??
              signerStatus?.message ??
              "Direct server-side venue execution is not enabled yet."),
      venueStatuses,
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
  const enabled = authorizations.some((auth) => auth.enabled);
  const venueStatuses = authorizations
    .filter((authorization) => authorization.enabled)
    .flatMap((authorization) => authorization.venueStatuses);
  const actionReadiness: Record<TelegramBotTradingAction, boolean> = {
    buy: authorizations.some(
      (authorization) =>
        authorization.enabled &&
        authorizationActionReadiness.get(authorization.authorizationId)?.buy,
    ),
    sell: authorizations.some(
      (authorization) =>
        authorization.enabled &&
        authorizationActionReadiness.get(authorization.authorizationId)?.sell,
    ),
    redeem: authorizations.some(
      (authorization) =>
        authorization.enabled &&
        authorizationActionReadiness.get(authorization.authorizationId)?.redeem,
    ),
  };
  const directExecutionReady =
    enabled &&
    runtimePolicy.tradingActions.length > 0 &&
    runtimePolicy.tradingActions.every((action) => actionReadiness[action]);
  const setupIssue = !activeAuthorization
    ? "Bot trading is not enabled in Settings."
    : directExecutionReady
      ? null
      : (activeAuthorization.setupIssue ??
        "Direct server-side venue execution is not enabled yet.");

  return {
    actionStatuses: buildTelegramBotTradingActionStatuses({
      actions: runtimePolicy.tradingActions,
      directExecutionReady,
      readiness: actionReadiness,
      sellConfigured:
        runtimePolicy.tradingActions.includes("sell") &&
        hasConfiguredPrivyBotPolicyForActions(requiredActions),
      redeemConfigured: Boolean(
        env.privyPolymarketBotRedeemPolicyId &&
        env.polymarketBuilderApiKey &&
        env.polymarketBuilderApiSecret &&
        env.polymarketBuilderApiPassphrase,
      ),
    }),
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
    signerStatus: activeAuthorization?.signerStatus ?? null,
    setupIssue,
    signerWallets: authorizations.flatMap((authorization) =>
      authorization.walletChain === "ethereum" &&
      authorization.privyWalletId &&
      authorization.signerStatus
        ? [
            {
              privyWalletId: authorization.privyWalletId,
              signerStatus: authorization.signerStatus,
              walletAddress: authorization.walletAddress,
              walletChain: "ethereum" as const,
            },
          ]
        : [],
    ),
    telegramUserId: row.telegram_user_id,
    username: row.username,
    userId: row.user_id,
    venueStatuses,
    walletAddress: activeAuthorization?.walletAddress ?? null,
    walletChain: activeAuthorization?.walletChain ?? null,
    walletSetupIssues: [],
  };
}

export async function enableTelegramBotTrading(
  db: DbQuery,
  input: EnableTelegramBotTradingInput,
  trading?: ApiBotTradingExecutor,
): Promise<TelegramBotTradingStatus> {
  const accountResult = await db.query<{
    privy_user_id: string | null;
    telegram_user_id: string | null;
  }>(
    `SELECT
       u.privy_user_id,
       uta.telegram_user_id
     FROM users u
     LEFT JOIN user_telegram_accounts uta ON uta.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [input.userId],
  );
  const account = accountResult.rows[0];
  if (!account?.telegram_user_id) {
    throw new Error("telegram_account_required");
  }
  const telegramUserId = account.telegram_user_id;

  const policy = await resolveTelegramBotTradingPolicy(db);
  const explicitlyRequestedVenues =
    input.enabledVenues === undefined
      ? null
      : normalizeVenues(input.enabledVenues);
  if (explicitlyRequestedVenues?.length === 0) {
    await disableTelegramBotTradingLocal(db, { telegramUserId });
    return getTelegramBotTradingStatus(
      db,
      telegramUserId,
      trading,
      input.signerInspector,
    );
  }
  if (!policy.tradingEnabled) {
    throw new TelegramBotTradingEnableError({
      code: "trading_disabled_by_policy",
      message: "Telegram bot trading is disabled by runtime policy.",
      statusCode: 409,
    });
  }
  const requestedVenueSource =
    input.enabledVenues === undefined
      ? policy.tradingVenues.filter((venue) => venue === "polymarket")
      : (explicitlyRequestedVenues ?? []);
  const unsupportedBotVenues = requestedVenueSource.filter(
    (venue) => venue !== "polymarket",
  );
  if (unsupportedBotVenues.length > 0) {
    throw new TelegramBotTradingEnableError({
      code: "privy_policy_unsupported_for_venue",
      message: `Telegram bot trading is currently available only for Polymarket; unsupported: ${unsupportedBotVenues.join(", ")}.`,
      statusCode: 409,
    });
  }
  const enabledVenueSource = requestedVenueSource.filter((venue) =>
    policy.tradingVenues.includes(venue),
  );
  if (enabledVenueSource.length === 0) {
    throw new Error("no_compatible_venues_for_wallet");
  }

  const requestedEvmVenues = filterVenuesForWalletChain(
    enabledVenueSource,
    "ethereum",
  );
  const requestedSolanaVenues = filterVenuesForWalletChain(
    enabledVenueSource,
    "solana",
  );
  const preferredWalletAddress =
    input.preferredWalletAddress ?? input.walletAddress ?? null;
  const walletSelection = buildTelegramBotTradingWalletSelection({
    internalWallets: input.internalWallets ?? [],
    preferredPrivyWalletId: input.privyWalletId,
    preferredWalletAddress,
    requestedVenues: enabledVenueSource,
    verifiedWallets: await loadVerifiedTelegramBotTradingWallets(
      db,
      input.userId,
    ),
  });
  const selectedByChain = walletSelection.selectedByChain;
  const missingRequestedChains = walletSelection.requestedChains.filter(
    (walletChain) => !selectedByChain.has(walletChain),
  );
  const authorizationUpdates: Array<{
    enabledVenues: TelegramBotTradingVenue[];
    limits: string;
    selected: SelectedTelegramBotTradingInternalWallet;
  }> = [];
  const requestedMaxAmountUsd =
    input.maxAmountUsd == null ? policy.maxTradeAmountUsd : input.maxAmountUsd;
  if (
    !Number.isFinite(requestedMaxAmountUsd) ||
    !Number.isInteger(requestedMaxAmountUsd) ||
    requestedMaxAmountUsd <= 0 ||
    requestedMaxAmountUsd > policy.maxTradeAmountUsd
  ) {
    throw new TelegramBotTradingEnableError({
      code: "invalid_max_amount_usd",
      message: `Max buy must be between $1 and $${policy.maxTradeAmountUsd}.`,
    });
  }
  if (missingRequestedChains.length > 0) {
    throw new TelegramBotTradingEnableError({
      code: "internal_trading_wallet_required",
      message:
        "Create every required internal Hunch Trading Wallet before enabling Telegram bot trading.",
      statusCode: 409,
      walletSetupIssues: walletSelection.walletSetupIssues,
    });
  }
  for (const [walletChain, selected] of selectedByChain) {
    const enabledVenues =
      walletChain === "solana" ? requestedSolanaVenues : requestedEvmVenues;
    if (enabledVenues.length === 0) continue;
    const kalshiEligibility =
      selected.walletChain === "solana"
        ? normalizeKalshiTradeEligibility(
            input.buildKalshiEligibilityForWallet
              ? await input.buildKalshiEligibilityForWallet(
                  selected.walletAddress,
                )
              : input.kalshiEligibility,
          )
        : null;
    authorizationUpdates.push({
      enabledVenues,
      limits: JSON.stringify({
        maxSlippageBps: policy.maxSlippageBps,
        requireConfirmation: true,
        kalshiEligibility,
      }),
      selected,
    });
  }

  if (selectedByChain.size === 0) {
    throw new TelegramBotTradingEnableError({
      code: "internal_trading_wallet_required",
      message:
        "Create an internal Hunch Trading Wallet before enabling Telegram bot trading.",
      statusCode: 409,
      walletSetupIssues: walletSelection.walletSetupIssues,
    });
  }

  const signerInspector =
    input.signerInspector ?? inspectServerEvmWalletAuthorization;
  for (const update of authorizationUpdates) {
    if (update.selected.walletChain !== "ethereum") continue;
    const signerStatus = await signerInspector({
      authorizationEnabled: true,
      requiredActions: policy.tradingActions.map((action) =>
        action === "redeem"
          ? "REDEEM"
          : (action.toUpperCase() as "BUY" | "SELL"),
      ),
      privyUserId: account.privy_user_id,
      signer: update.selected.walletAddress,
      walletId: update.selected.privyWalletId,
    });
    if (signerStatus.state === "grant_required" && signerStatus.grant) {
      throw new TelegramBotTradingEnableError({
        code: signerStatus.grant.replaceExistingSigner
          ? "privy_server_signer_replacement_required"
          : "privy_server_signer_grant_required",
        grants: [signerStatus.grant],
        message: signerStatus.message ?? "Grant bot access in Hunch Settings.",
        statusCode: 409,
      });
    }
    if (signerStatus.state !== "ready") {
      throw new TelegramBotTradingEnableError({
        code: `privy_server_signer_${signerStatus.state}`,
        message: signerStatus.message ?? "Privy server signer is not ready.",
        statusCode: 409,
      });
    }
    if (
      policy.tradingActions.includes("buy") &&
      (signerStatus.policyMaxBuyUsd == null ||
        requestedMaxAmountUsd > signerStatus.policyMaxBuyUsd)
    ) {
      throw new TelegramBotTradingEnableError({
        code: "privy_policy_max_buy_exceeded",
        message:
          "Telegram max buy cannot exceed the Privy Polymarket policy cap.",
        statusCode: 409,
      });
    }
  }

  await withOptionalTransaction(db, async (client) => {
    await disableTelegramBotTradingLocal(client, { telegramUserId });
    for (const update of authorizationUpdates) {
      await client.query(
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
          telegramUserId,
          account.privy_user_id,
          update.selected.walletAddress,
          update.selected.walletChain,
          update.selected.privyWalletId,
          update.enabledVenues,
          requestedMaxAmountUsd,
          update.limits,
        ],
      );
    }
  });

  const status = await getTelegramBotTradingStatus(
    db,
    telegramUserId,
    trading,
    signerInspector,
  );
  return {
    ...status,
    walletSetupIssues: walletSelection.walletSetupIssues,
  };
}

export async function disableTelegramBotTradingForUser(
  db: DbQuery,
  userId: string,
): Promise<number> {
  return disableTelegramBotTradingLocal(db, { userId });
}

export async function disableTelegramBotTradingForTelegramUser(
  db: DbQuery,
  telegramUserId: string | number,
): Promise<boolean> {
  return (
    (await disableTelegramBotTradingLocal(db, {
      telegramUserId: normalizeTelegramUserId(telegramUserId),
    })) > 0
  );
}

async function disableTelegramBotTradingLocal(
  db: DbQuery,
  selector: { telegramUserId: string } | { userId: string },
): Promise<number> {
  return withOptionalTransaction(db, async (client) => {
    const byUser = "userId" in selector;
    const value = byUser ? selector.userId : selector.telegramUserId;
    const intentSelector = byUser
      ? `(user_id = $1 OR telegram_user_id IN (
           SELECT telegram_user_id
             FROM user_telegram_accounts
            WHERE user_id = $1
         ))`
      : "telegram_user_id = $1";
    const authorizationResult = await client.query(
      `UPDATE telegram_bot_trading_authorizations
          SET enabled = false,
              disabled_at = COALESCE(disabled_at, now()),
              updated_at = now()
        WHERE ${byUser ? "user_id" : "telegram_user_id"} = $1`,
      [value],
    );
    await client.query(
      `UPDATE telegram_trade_intents
          SET status = 'cancelled',
              error_code = 'authorization_disabled',
              error_message = 'Telegram bot trading was disabled before submission.',
              updated_at = now()
        WHERE ${intentSelector}
          AND status = ANY($2::text[])`,
      [value, PENDING_INTENT_STATUSES],
    );
    return authorizationResult.rowCount ?? 0;
  });
}

async function resolveMarketByRef(
  db: DbQuery,
  marketRef: string,
): Promise<TelegramBotMarketRow | null> {
  const normalized = normalizeMarketRef(marketRef);
  if (!normalized) return null;
  const row = await findTradeMarketByRef(db, normalized);
  if (!row) return null;
  const venue = normalizeVenue(row.venue);
  return venue ? { ...row, venue } : null;
}

async function loadMarketById(
  db: DbQuery,
  marketId: string,
): Promise<TelegramBotMarketRow | null> {
  const row = await findTradeMarketById(db, marketId);
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

async function insertSellIntent(input: {
  chatId: string;
  db: DbQuery;
  market: TelegramBotMarketRow;
  policy: SignalBotPolicy;
  quote: TradeQuote;
  sellPercent: 50 | 100;
  sharesRaw: bigint;
  side: TelegramBotTradingSide;
  telegramMessageId?: number | null;
  telegramUserId: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + input.policy.intentTtlSec * 1000);
  await input.db.query(
    `INSERT INTO telegram_trade_intents (
       id, telegram_user_id, chat_id, telegram_message_id, action, venue,
       market_id, event_id, side, sell_percent, shares_raw, status,
       quote_snapshot, policy_snapshot, expires_at, idempotency_key
     )
     VALUES ($1, $2, $3, $4, 'sell', $5, $6, $7, $8, $9, $10, 'draft', $11::jsonb, $12::jsonb, $13, $14)`,
    [
      id,
      input.telegramUserId,
      input.chatId,
      input.telegramMessageId ?? null,
      input.market.venue,
      input.market.id,
      input.market.event_id,
      input.side,
      input.sellPercent,
      input.sharesRaw.toString(),
      JSON.stringify(buildTelegramTradeQuotePreview(input.quote)),
      JSON.stringify(buildPolicySnapshot(input.policy)),
      expiresAt,
      `telegram-bot:${id}`,
    ],
  );
  return id;
}

async function insertRedeemIntent(input: {
  chatId: string;
  db: DbQuery;
  market: TelegramBotMarketRow;
  plan: Awaited<ReturnType<typeof buildPolymarketRedemptionPlan>>;
  policy: SignalBotPolicy;
  telegramMessageId?: number | null;
  telegramUserId: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + input.policy.intentTtlSec * 1000);
  await input.db.query(
    `INSERT INTO telegram_trade_intents (
       id, telegram_user_id, chat_id, telegram_message_id, action, venue,
       market_id, event_id, status, quote_snapshot, policy_snapshot,
       expires_at, idempotency_key
     )
     VALUES ($1, $2, $3, $4, 'redeem', $5, $6, $7, 'draft', $8::jsonb, $9::jsonb, $10, $11)`,
    [
      id,
      input.telegramUserId,
      input.chatId,
      input.telegramMessageId ?? null,
      input.market.venue,
      input.market.id,
      input.market.event_id,
      JSON.stringify(input.plan),
      JSON.stringify(buildPolicySnapshot(input.policy)),
      expiresAt,
      `telegram-bot:${id}`,
    ],
  );
  return id;
}

function marketMetadataString(
  market: TelegramBotMarketRow,
  ...keys: string[]
): string | null {
  if (!isRecord(market.metadata)) return null;
  for (const key of keys) {
    const value = market.metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function marketMetadataBoolean(
  market: TelegramBotMarketRow,
  ...keys: string[]
): boolean {
  if (!isRecord(market.metadata)) return false;
  const metadata = market.metadata;
  return keys.some((key) => metadata[key] === true);
}

async function resolveTelegramPolymarketRedemptionPlan(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  market: TelegramBotMarketRow;
}) {
  if (input.market.venue !== "polymarket") {
    return null;
  }
  const credentials = await AuthService.getVenueCredentialsInfo(
    input.authorization.user_id,
    "polymarket",
    input.authorization.wallet_address,
  );
  const funder = credentials?.funderAddress;
  if (!funder) return null;
  const conditionId =
    input.market.condition_id ??
    marketMetadataString(input.market, "conditionId", "condition_id");
  const plan = await buildPolymarketRedemptionPlan({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    funder,
    conditionalTokensAddress: env.polymarketConditionalTokensAddress,
    collateralTokenAddress: env.polymarketUsdcAddress,
    legacyCollateralTokenAddress: env.polymarketUsdceAddress,
    negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress ?? null,
    ctfCollateralAdapterAddress:
      env.polymarketCtfCollateralAdapterAddress ?? null,
    negRiskCollateralAdapterAddress:
      env.polymarketNegRiskCollateralAdapterAddress ?? null,
    executionKind: "external_adapter",
    outcome: "YES",
    positionTokenId: input.market.token_yes ?? input.market.token_no ?? "",
    conditionId,
    questionId:
      input.market.question_id ??
      marketMetadataString(input.market, "questionId", "question_id"),
    negRiskParentConditionId:
      input.market.neg_risk_parent_condition_id ??
      marketMetadataString(
        input.market,
        "negRiskParentConditionId",
        "neg_risk_parent_condition_id",
      ),
    negRiskRequestId:
      input.market.neg_risk_request_id ??
      marketMetadataString(
        input.market,
        "negRiskRequestId",
        "neg_risk_request_id",
      ),
    isNegRisk:
      input.market.neg_risk === true ||
      marketMetadataBoolean(input.market, "negRisk", "neg_risk"),
  });
  return plan.redeemable ? plan : null;
}

function isTransactionalDb(db: DbQuery): db is TransactionalDbQuery {
  return typeof (db as TransactionalDbQuery).connect === "function";
}

async function loadUnresolvedTelegramTradeIntent(
  db: DbQuery,
  input: {
    excludeIntentId?: string | null;
    marketId: string;
    side?: TelegramBotTradingSide | null;
    telegramUserId: string;
  },
): Promise<UnresolvedTelegramTradeIntentRow | null> {
  const result = await db.query<UnresolvedTelegramTradeIntentRow>(
    `SELECT id, side, status, error_code
       FROM telegram_trade_intents tti
	     WHERE telegram_user_id = $1
	        AND market_id = $2
	        AND ($3::text IS NULL OR side = $3)
	        AND ($4::uuid IS NULL OR id <> $4::uuid)
	        AND (
	          (status = 'confirming' AND expires_at > now())
	          OR status = ANY($5::text[])
	        )
      ORDER BY updated_at DESC
      LIMIT 1`,
    [
      input.telegramUserId,
      input.marketId,
      input.side ?? null,
      input.excludeIntentId ?? null,
      ["executing", "reconcile_required", "submitted"],
    ],
  );
  return result.rows[0] ?? null;
}

async function countUnresolvedTelegramTradeIntents(
  db: DbQuery,
  telegramUserId: string,
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM telegram_trade_intents tti
	     WHERE telegram_user_id = $1
	        AND (
	          (status = 'confirming' AND expires_at > now())
	          OR status = ANY($2::text[])
	        )`,
    [telegramUserId, ["executing", "reconcile_required", "submitted"]],
  );
  const parsed = Number(result.rows[0]?.count ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function listResolvingTelegramTradeIntents(
  db: DbQuery,
  telegramUserId: string,
): Promise<
  Array<{
    action: TelegramBotTradingAction;
    ageMinutes: number;
    marketTitle: string;
  }>
> {
  const result = await db.query<{
    action: TelegramBotTradingAction;
    age_minutes: string;
    market_title: string;
  }>(
    `SELECT
       tti.action,
       greatest(0, floor(extract(epoch FROM (now() - tti.created_at)) / 60))::text AS age_minutes,
       coalesce(m.title, tti.market_id) AS market_title
     FROM telegram_trade_intents tti
     LEFT JOIN unified_markets m ON m.id = tti.market_id
     WHERE tti.telegram_user_id = $1
       AND (
         (tti.status = 'confirming' AND tti.expires_at > now())
         OR tti.status = ANY($2::text[])
       )
     ORDER BY tti.created_at DESC
     LIMIT 5`,
    [telegramUserId, ["executing", "reconcile_required", "submitted"]],
  );
  return result.rows.map((row) => ({
    action: row.action,
    ageMinutes: Math.max(0, Number(row.age_minutes) || 0),
    marketTitle: row.market_title,
  }));
}

async function withOptionalTransaction<T>(
  db: DbQuery,
  callback: (client: DbQuery) => Promise<T>,
): Promise<T> {
  if (!isTransactionalDb(db) || !db.connect) {
    return callback(db);
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Pass only the query capability into nested helpers. pg.PoolClient also
    // exposes connect(), but calling it again throws "already been connected".
    const transactionDb: DbQuery = {
      query: client.query.bind(client),
    };
    const result = await callback(transactionDb);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockTelegramIntentMarket(
  db: DbQuery,
  input: {
    marketId: string;
    telegramUserId: string;
  },
): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    ["telegram-bot-trade", input.telegramUserId, input.marketId].join(":"),
  ]);
}

async function transitionIntentToConfirming(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  intent: TelegramTradeIntentRow;
}): Promise<"blocked" | "confirmed" | "overtaken"> {
  return withOptionalTransaction(input.db, async (client) => {
    await lockTelegramIntentMarket(client, {
      marketId: input.intent.market_id,
      telegramUserId: input.intent.telegram_user_id,
    });
    const unresolved = await loadUnresolvedTelegramTradeIntent(client, {
      excludeIntentId: input.intent.id,
      marketId: input.intent.market_id,
      telegramUserId: input.intent.telegram_user_id,
    });
    if (unresolved) return "blocked";
    const confirming = await updateIntentStatus({
      allowedStatuses: ["draft", "previewed"],
      db: client,
      intentId: input.intent.id,
      status: "confirming",
    });
    if (!confirming) return "overtaken";
    await attachAuthorizationToIntent({
      authorization: input.authorization,
      db: client,
      intentId: input.intent.id,
    });
    await client.query(
      `UPDATE telegram_trade_intents
          SET status = 'cancelled',
              error_code = coalesce(error_code, 'superseded_by_intent'),
              error_message = coalesce(error_message, 'Another trade intent for this market was selected.'),
              updated_at = now()
        WHERE telegram_user_id = $1
          AND market_id = $2
          AND id <> $3::uuid
          AND status = ANY($4::text[])`,
      [
        input.intent.telegram_user_id,
        input.intent.market_id,
        input.intent.id,
        ["draft", "previewed"],
      ],
    );
    return "confirmed";
  });
}

export async function buildTelegramBotTradingStatusMessage(
  db: DbQuery,
  telegramUserId: string | number,
  trading?: ApiBotTradingExecutor,
  options: { reconcileLocal?: boolean } = {},
): Promise<TelegramBotTradingMessage> {
  const normalizedTelegramUserId = normalizeTelegramUserId(telegramUserId);
  if (options.reconcileLocal !== false) {
    await reconcileStaleTelegramTradeIntents(db, {
      telegramUserId: normalizedTelegramUserId,
    }).catch(() => undefined);
  }
  const [policy, status] = await Promise.all([
    resolveTelegramBotTradingPolicy(db),
    getTelegramBotTradingStatus(db, normalizedTelegramUserId, trading),
  ]);
  const [unresolvedIntentCount, resolvingIntents] = await Promise.all([
    countUnresolvedTelegramTradeIntents(db, normalizedTelegramUserId),
    listResolvingTelegramTradeIntents(db, normalizedTelegramUserId),
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
    `Actions: ${
      (["buy", "sell", "redeem"] as const)
        .filter((action) => status.actionStatuses[action].enabled)
        .map(
          (action) =>
            `${action.toUpperCase()} ${status.actionStatuses[action].ready ? "ready" : "not ready"}`,
        )
        .join(" · ") || "none enabled"
    }`,
  ];
  if (unresolvedIntentCount > 0) {
    lines.push(
      "",
      `Resolving trades: ${unresolvedIntentCount}`,
      ...resolvingIntents.map(
        (intent) =>
          `• ${intent.action.toUpperCase()} · ${intent.marketTitle} · ${intent.ageMinutes}m`,
      ),
      "User action required: no. The bot is checking automatically.",
    );
  }
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
  signerInspector?: TelegramBotTradingSignerInspector;
  telegramMessageId?: number | null;
  telegramUserId: string | number;
  trading?: ApiBotTradingExecutor;
}): Promise<TelegramBotTradingMessage> {
  const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
  const [policy, status, market] = await Promise.all([
    resolveTelegramBotTradingPolicy(input.db),
    getTelegramBotTradingStatus(
      input.db,
      telegramUserId,
      input.trading,
      input.signerInspector,
    ),
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
  const [automationAllowed, buyAllowed, redeemAllowed, sellAllowed] =
    await Promise.all([
      venueLifecycleAllows(input.db, market.venue, "automation"),
      venueLifecycleAllows(input.db, market.venue, "increaseExposure"),
      venueLifecycleAllows(input.db, market.venue, "redeem"),
      venueLifecycleAllows(input.db, market.venue, "reduceExposure"),
    ]);
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
  const nominalPresetAmountUsd = policy.buyAmountPresetsUsd
    .filter((amountUsd) => amountUsd > 0)
    .sort((left, right) => left - right)[0];
  const unresolvedIntent = await loadUnresolvedTelegramTradeIntent(input.db, {
    marketId: market.id,
    telegramUserId,
  });
  const canBuildBuyOptions =
    !input.isAdminTest &&
    !unresolvedIntent &&
    automationAllowed &&
    buyAllowed &&
    policy.tradingEnabled &&
    policy.tradingActions.includes("buy") &&
    policyVenueAllowed &&
    authorizationVenueAllowed &&
    marketOrderable &&
    authorization?.enabled === true &&
    Boolean(authorization.privy_wallet_id) &&
    canOfferTradeForReadiness(tradeReadiness) &&
    nominalPresetAmountUsd != null &&
    Boolean(input.trading);
  const buyOptions =
    canBuildBuyOptions &&
    authorization &&
    input.trading &&
    nominalPresetAmountUsd != null
      ? (
          await Promise.all(
            (["YES", "NO"] as const).map((side) =>
              resolveTelegramExecutableBuyOption({
                authorization,
                market,
                maxAmountUsd,
                maxExecutableBuyUsd: tradeReadiness.maxExecutableBuyUsd ?? null,
                maxSlippageBps: policy.maxSlippageBps,
                nominalAmountUsd: nominalPresetAmountUsd,
                side,
                trading: input.trading as ApiBotTradingExecutor,
              }),
            ),
          )
        ).filter(
          (option): option is TelegramExecutableBuyOption => option != null,
        )
      : [];
  const canBuildSellOptions =
    !input.isAdminTest &&
    !unresolvedIntent &&
    automationAllowed &&
    sellAllowed &&
    market.venue === "polymarket" &&
    policy.tradingEnabled &&
    policy.tradingActions.includes("sell") &&
    policyVenueAllowed &&
    authorizationVenueAllowed &&
    marketOrderable &&
    authorization?.enabled === true &&
    Boolean(authorization.privy_wallet_id) &&
    Boolean(input.trading);
  const sellOptions =
    canBuildSellOptions && authorization && input.trading
      ? (
          await Promise.all(
            (["YES", "NO"] as const).map((side) =>
              resolveTelegramExecutableSellOptions({
                authorization,
                db: input.db,
                market,
                maxSlippageBps: policy.maxSlippageBps,
                side,
                trading: input.trading as ApiBotTradingExecutor,
              }),
            ),
          )
        ).flat()
      : [];
  const redeemPlan =
    !input.isAdminTest &&
    !unresolvedIntent &&
    automationAllowed &&
    redeemAllowed &&
    market.venue === "polymarket" &&
    policy.tradingEnabled &&
    policy.tradingActions.includes("redeem") &&
    policyVenueAllowed &&
    authorizationVenueAllowed &&
    authorization?.enabled === true &&
    authorization.privy_wallet_id
      ? await resolveTelegramPolymarketRedemptionPlan({
          authorization,
          market,
        }).catch(() => null)
      : null;
  const lines = [
    input.isAdminTest ? "Trade Card Preview" : "Trade This Market",
    "",
    market.event_title ? market.event_title : market.title,
  ];
  if (market.event_title && market.event_title !== market.title) {
    lines.push(market.title);
  }
  lines.push("", `${market.venue} · ${market.status}`, marketPriceLine(market));
  const buyPriceSummary = buyOptions
    .map(
      (option) =>
        `${sideLabel(market, option.side)} ask ${formatLivePrice(option.currentPrice) ?? "unavailable"}`,
    )
    .join(" · ");
  const sellPriceSummary = sellOptions
    .filter((option) => option.sellPercent === 100)
    .map(
      (option) =>
        `${sideLabel(market, option.side)} bid ${formatLivePrice(option.currentPrice) ?? "unavailable"}`,
    )
    .join(" · ");
  if (buyPriceSummary) lines.push(`Buy: ${buyPriceSummary}`);
  if (sellPriceSummary) lines.push(`Sell: ${sellPriceSummary}`);
  if (input.isAdminTest) {
    lines.push("", "Preview only - trade buttons are not created.");
  } else if (unresolvedIntent) {
    lines.push("", EXISTING_TRADE_RESOLVING_MESSAGE);
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
  } else if (!marketOrderable && !redeemPlan) {
    lines.push("", "This market is not open for new bot trades.");
  } else if (
    policy.tradingActions.includes("buy") &&
    buyOptions.length === 0 &&
    sellOptions.length === 0 &&
    !redeemPlan &&
    !canOfferTradeForReadiness(tradeReadiness)
  ) {
    lines.push(
      "",
      tradeReadiness.message ??
        "Direct bot execution is not ready yet. Open Hunch to trade.",
    );
  } else if (
    policy.tradingActions.includes("buy") &&
    policy.buyAmountPresetsUsd.length === 0 &&
    sellOptions.length === 0 &&
    !redeemPlan
  ) {
    lines.push("", "No bot buy presets are configured.");
  } else if (canBuildBuyOptions && buyOptions.length === 0) {
    lines.push(
      "",
      `No executable buy fits your ${formatUsd(maxAmountUsd)} maximum total spend.`,
    );
  }
  if (buyOptions.length > 0 || sellOptions.length > 0 || redeemPlan) {
    lines.push("", `Buttons valid for ${formatTtl(policy.intentTtlSec)}.`);
  }

  const keyboard: TelegramBotTradingButton[][] = [];
  for (const option of buyOptions) {
    const intentId = await insertBuyIntent({
      amountUsd: option.amountUsd,
      chatId: String(input.chatId),
      db: input.db,
      market,
      policy,
      side: option.side,
      telegramMessageId: input.telegramMessageId,
      telegramUserId: normalizeTelegramUserId(input.telegramUserId),
    });
    keyboard.push([
      {
        callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:buy:${intentId}`,
        text: `Buy ${sideLabel(market, option.side)} · ${formatLivePrice(option.currentPrice) ?? "live"} · Spend ${formatUsd(option.amountUsd)}`,
      },
    ]);
  }
  for (const option of sellOptions) {
    const intentId = await insertSellIntent({
      chatId: String(input.chatId),
      db: input.db,
      market,
      policy,
      quote: option.quote,
      sellPercent: option.sellPercent,
      sharesRaw: option.sharesRaw,
      side: option.side,
      telegramMessageId: input.telegramMessageId,
      telegramUserId,
    });
    keyboard.push([
      {
        callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:sell:${intentId}`,
        text: `Sell ${option.sellPercent}% ${sideLabel(market, option.side)} · ${formatLivePrice(option.currentPrice) ?? "live"} · Receive ≥ ${formatUsd(option.minimumReceiveUsd)}`,
      },
    ]);
  }
  if (redeemPlan) {
    const intentId = await insertRedeemIntent({
      chatId: String(input.chatId),
      db: input.db,
      market,
      plan: redeemPlan,
      policy,
      telegramMessageId: input.telegramMessageId,
      telegramUserId,
    });
    const payoutRaw = BigInt(redeemPlan.expectedPayoutRaw ?? "0");
    keyboard.push([
      {
        callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:redeem:${intentId}`,
        text: `Redeem · receive ≈ ${formatUsd(Number(payoutRaw) / 1_000_000)} pUSD`,
      },
    ]);
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
       i.sell_percent,
       i.shares_raw,
       i.status,
       i.error_code,
       i.error_message,
       i.submit_started_at,
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
  allowRecoverableFinalization?: boolean;
  db: DbQuery;
  errorCode?: string;
  errorMessage?: string;
  executionId?: string | null;
  intentId: string;
  orderId?: string | null;
  preparedSnapshot?: Record<string, unknown> | null;
  quoteSnapshot?: Record<string, unknown> | null;
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
            quote_snapshot = coalesce($15::jsonb, quote_snapshot),
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
        AND (
          $6::text[] IS NULL
          OR status = ANY($6::text[])
          OR (
            $14::boolean
            AND (
              (status = 'reconcile_required' AND error_code = 'submit_state_unknown')
              OR (status = 'submitted' AND error_code = 'reconcile_required')
            )
          )
        )
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
      Boolean(input.allowRecoverableFinalization),
      input.quoteSnapshot ? JSON.stringify(input.quoteSnapshot) : null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function finalizeSubmittedIntent(input: {
  db: DbQuery;
  errorCode?: string | null;
  errorMessage?: string | null;
  executionId?: string | null;
  intentId: string;
  orderId?: string | null;
  preparedSnapshot?: Record<string, unknown> | null;
  result: Record<string, unknown>;
  status: string;
  txSignature?: string | null;
  venueOrderId?: string | null;
}): Promise<boolean> {
  const hasDurableRefs = Boolean(
    input.orderId ??
    input.executionId ??
    input.venueOrderId ??
    input.txSignature,
  );
  return updateIntentStatus({
    allowedStatuses: ["executing"],
    allowRecoverableFinalization: hasDurableRefs,
    db: input.db,
    errorCode: input.errorCode ?? undefined,
    errorMessage: input.errorMessage ?? undefined,
    executionId: input.executionId ?? null,
    intentId: input.intentId,
    orderId: input.orderId ?? null,
    preparedSnapshot: input.preparedSnapshot ?? null,
    result: input.result,
    status: input.status,
    txSignature: input.txSignature ?? null,
    venueOrderId: input.venueOrderId ?? null,
  });
}

export async function reconcileStaleTelegramTradeIntents(
  db: DbQuery,
  input: {
    executingGraceMs?: number;
    now?: Date;
    telegramUserId?: string | number | null;
  } = {},
): Promise<{
  backfilledExecutionRefs: number;
  backfilledOrderRefs: number;
  expiredPending: number;
  failedPreSubmitExecuting: number;
  submittedReconcileRequired: number;
  unknownSubmitReconcileRequired: number;
}> {
  const now = input.now ?? new Date();
  const executingCutoff = new Date(
    now.getTime() - (input.executingGraceMs ?? 10 * 60 * 1000),
  );
  const telegramUserId =
    input.telegramUserId == null
      ? null
      : normalizeTelegramUserId(input.telegramUserId);
  const expiredPending = await db.query(
    `UPDATE telegram_trade_intents
        SET status = 'expired',
            error_code = coalesce(error_code, 'intent_expired'),
            error_message = coalesce(error_message, 'Trade intent expired before confirmation.'),
            updated_at = now()
      WHERE status = ANY($1::text[])
        AND expires_at <= $2
        AND ($3::text IS NULL OR telegram_user_id = $3)
      RETURNING id`,
    [PENDING_INTENT_STATUSES, now, telegramUserId],
  );
  const backfilledOrderRefs = await db.query(
    `UPDATE telegram_trade_intents ti
        SET status = CASE
              WHEN lower(o.status) IN ('filled', 'matched') THEN 'filled'
              ELSE 'submitted'
            END,
            error_code = NULL,
            error_message = NULL,
            order_id = coalesce(ti.order_id, o.id),
            venue_order_id = coalesce(ti.venue_order_id, o.venue_order_id),
            submitted_at = coalesce(ti.submitted_at, ti.submit_started_at, now()),
            updated_at = now()
       FROM orders o
      WHERE ti.status = ANY($1::text[])
        AND ($2::text IS NULL OR ti.telegram_user_id = $2)
        AND ti.order_id IS NULL
        AND o.user_id = ti.user_id
        AND o.venue = ti.venue
        AND o.order_payload IS NOT NULL
        AND jsonb_typeof(o.order_payload) = 'object'
        AND (
          o.order_payload->>'telegramIntentId' = ti.id::text
          OR o.order_payload->'submitted'->>'telegramIntentId' = ti.id::text
          OR o.order_payload->'history'->>'telegramIntentId' = ti.id::text
          OR o.order_payload->'payload'->>'telegramIntentId' = ti.id::text
          OR o.order_payload->'submitted'->'payload'->>'telegramIntentId' = ti.id::text
          OR o.order_payload->'reconcileKeys'->>'intentId' = ti.id::text
          OR o.order_payload->'reconcileKeys'->>'telegramIntentId' = ti.id::text
          OR o.order_payload->'submitted'->'reconcileKeys'->>'intentId' = ti.id::text
          OR o.order_payload->'history'->'reconcileKeys'->>'intentId' = ti.id::text
          OR o.order_payload->'payload'->'reconcileKeys'->>'intentId' = ti.id::text
          OR o.order_payload->'submitted'->'payload'->'reconcileKeys'->>'intentId' = ti.id::text
          OR (ti.venue_order_id IS NOT NULL AND o.venue_order_id = ti.venue_order_id)
          OR (ti.tx_signature IS NOT NULL AND o.order_hash = ti.tx_signature)
          OR (
            ti.prepared_snapshot->'reconcileKeys'->>'venueOrderId' IS NOT NULL
            AND o.venue_order_id = ti.prepared_snapshot->'reconcileKeys'->>'venueOrderId'
          )
          OR (
            ti.prepared_snapshot->'reconcileKeys'->>'orderHash' IS NOT NULL
            AND o.order_hash = ti.prepared_snapshot->'reconcileKeys'->>'orderHash'
          )
          OR (
            ti.prepared_snapshot->'reconcileKeys'->>'txSignature' IS NOT NULL
            AND o.order_hash = ti.prepared_snapshot->'reconcileKeys'->>'txSignature'
          )
          OR (
            ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId' IS NOT NULL
            AND (
              o.order_payload->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR o.order_payload->'submitted'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR o.order_payload->'history'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR o.order_payload->'payload'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR o.order_payload->'submitted'->'payload'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR o.order_payload->'reconcileKeys'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR o.order_payload->'submitted'->'reconcileKeys'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR o.order_payload->'payload'->'reconcileKeys'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR o.order_payload->'submitted'->'payload'->'reconcileKeys'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
            )
          )
        )
      RETURNING ti.id`,
    [["executing", "reconcile_required", "submitted"], telegramUserId],
  );
  const backfilledExecutionRefs = await db.query(
    `UPDATE telegram_trade_intents ti
        SET status = CASE
              WHEN lower(e.status) IN ('fulfilled', 'filled') THEN 'filled'
              ELSE 'submitted'
            END,
            error_code = NULL,
            error_message = NULL,
            execution_id = coalesce(ti.execution_id, e.id),
            venue_order_id = coalesce(ti.venue_order_id, e.venue_order_id),
            tx_signature = coalesce(ti.tx_signature, e.tx_signature),
            submitted_at = coalesce(ti.submitted_at, ti.submit_started_at, now()),
            updated_at = now()
       FROM executions e
      WHERE ti.status = ANY($1::text[])
        AND ($2::text IS NULL OR ti.telegram_user_id = $2)
        AND ti.execution_id IS NULL
        AND e.user_id = ti.user_id
        AND e.venue = ti.venue
        AND e.raw IS NOT NULL
        AND jsonb_typeof(e.raw) = 'object'
        AND (
          e.raw->>'telegramIntentId' = ti.id::text
          OR e.raw->'submitted'->>'telegramIntentId' = ti.id::text
          OR e.raw->'history'->>'telegramIntentId' = ti.id::text
          OR e.raw->'payload'->>'telegramIntentId' = ti.id::text
          OR e.raw->'submitted'->'payload'->>'telegramIntentId' = ti.id::text
          OR e.raw->'reconcileKeys'->>'intentId' = ti.id::text
          OR e.raw->'reconcileKeys'->>'telegramIntentId' = ti.id::text
          OR e.raw->'submitted'->'reconcileKeys'->>'intentId' = ti.id::text
          OR e.raw->'history'->'reconcileKeys'->>'intentId' = ti.id::text
          OR e.raw->'payload'->'reconcileKeys'->>'intentId' = ti.id::text
          OR e.raw->'submitted'->'payload'->'reconcileKeys'->>'intentId' = ti.id::text
          OR (ti.venue_order_id IS NOT NULL AND e.venue_order_id = ti.venue_order_id)
          OR (ti.tx_signature IS NOT NULL AND e.tx_signature = ti.tx_signature)
          OR (
            ti.prepared_snapshot->'reconcileKeys'->>'venueOrderId' IS NOT NULL
            AND e.venue_order_id = ti.prepared_snapshot->'reconcileKeys'->>'venueOrderId'
          )
          OR (
            ti.prepared_snapshot->'reconcileKeys'->>'txSignature' IS NOT NULL
            AND e.tx_signature = ti.prepared_snapshot->'reconcileKeys'->>'txSignature'
          )
          OR (
            ti.prepared_snapshot->'reconcileKeys'->>'orderHash' IS NOT NULL
            AND e.tx_signature = ti.prepared_snapshot->'reconcileKeys'->>'orderHash'
          )
          OR (
            ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId' IS NOT NULL
            AND (
              e.raw->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR e.raw->'submitted'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR e.raw->'history'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR e.raw->'payload'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR e.raw->'submitted'->'payload'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR e.raw->'reconcileKeys'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR e.raw->'submitted'->'reconcileKeys'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR e.raw->'payload'->'reconcileKeys'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
              OR e.raw->'submitted'->'payload'->'reconcileKeys'->>'clientOrderId' = ti.prepared_snapshot->'reconcileKeys'->>'clientOrderId'
            )
          )
        )
      RETURNING ti.id`,
    [["executing", "reconcile_required", "submitted"], telegramUserId],
  );
  const failedPreSubmitExecuting = await db.query(
    `UPDATE telegram_trade_intents
        SET status = 'failed',
            error_code = coalesce(error_code, 'stale_pre_submit_execution'),
            error_message = coalesce(error_message, 'Trade intent became stale before venue submit.'),
            updated_at = now()
      WHERE status = 'executing'
        AND updated_at <= $1
        AND ($2::text IS NULL OR telegram_user_id = $2)
        AND order_id IS NULL
        AND execution_id IS NULL
        AND venue_order_id IS NULL
        AND tx_signature IS NULL
        AND submit_started_at IS NULL
      RETURNING id`,
    [executingCutoff, telegramUserId],
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
        AND ($2::text IS NULL OR telegram_user_id = $2)
        AND order_id IS NULL
        AND execution_id IS NULL
        AND venue_order_id IS NULL
        AND tx_signature IS NULL
        AND submit_started_at IS NOT NULL
      RETURNING id`,
    [executingCutoff, telegramUserId],
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
        AND ($2::text IS NULL OR telegram_user_id = $2)
        AND (
          order_id IS NOT NULL
          OR execution_id IS NOT NULL
          OR venue_order_id IS NOT NULL
          OR tx_signature IS NOT NULL
        )
      RETURNING id`,
    [executingCutoff, telegramUserId],
  );
  return {
    backfilledExecutionRefs: backfilledExecutionRefs.rowCount ?? 0,
    backfilledOrderRefs: backfilledOrderRefs.rowCount ?? 0,
    expiredPending: expiredPending.rowCount ?? 0,
    failedPreSubmitExecuting: failedPreSubmitExecuting.rowCount ?? 0,
    submittedReconcileRequired: submittedReconcileRequired.rowCount ?? 0,
    unknownSubmitReconcileRequired:
      unknownSubmitReconcileRequired.rowCount ?? 0,
  };
}

export function buildPreparedTradeSnapshot(
  prepared: Awaited<ReturnType<ApiBotTradingExecutor["prepareTrade"]>>,
): Record<string, unknown> {
  const payload = isRecord(prepared.venuePayload)
    ? prepared.venuePayload
    : null;
  const recoveryPayload = (() => {
    if (!payload) return null;
    if (prepared.venue === "polymarket") {
      return {
        exchangeAddress: payload.exchangeAddress ?? null,
        feePolicySnapshot: payload.feePolicySnapshot ?? null,
        kind: "polymarket",
        orderHash: payload.orderHash ?? null,
        orderPayload: { recovered: true },
        orderType: "FOK",
        positionWalletAddress: payload.positionWalletAddress ?? null,
        price: payload.price ?? null,
        size: payload.size ?? null,
        tokenId: payload.tokenId ?? null,
      };
    }
    if (prepared.venue === "limitless" && payload.tradeType === "amm") {
      return {
        amountUsd: payload.amountUsd ?? null,
        kind: "limitless",
        price: payload.price ?? null,
        size: payload.size ?? null,
        tokenId: payload.tokenId ?? null,
        tradeType: "amm",
      };
    }
    if (prepared.venue === "kalshi") {
      return {
        amountInRaw: payload.amountInRaw ?? null,
        amountOutRaw: payload.amountOutRaw ?? null,
        inputMint: payload.inputMint ?? null,
        kind: "kalshi",
        outputMint: payload.outputMint ?? null,
        quoteId: payload.quoteId ?? null,
      };
    }
    return null;
  })();
  return {
    authorizationMode: prepared.authorizationMode,
    expiresAt: prepared.expiresAt?.toISOString() ?? null,
    preparedId: prepared.preparedId,
    reconcileKeys: prepared.reconcileKeys,
    recoveryPayload,
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

async function isTelegramBotTradingAuthorizationEnabled(
  db: DbQuery,
  authorization: TelegramBotTradingAuthorizationRow,
  venue: TelegramBotTradingVenue,
): Promise<boolean> {
  const current = await loadEnabledAuthorization(
    db,
    authorization.telegram_user_id,
    venue,
  );
  return current?.id === authorization.id;
}

function callbackSenderId(
  input: TelegramBotTradingCallbackInput,
): string | null {
  const fromId = input.callbackQuery.from?.id;
  return fromId != null ? String(fromId) : null;
}

function callbackMessageChat(input: TelegramBotTradingCallbackInput): {
  id: string;
  type: string | null;
} | null {
  const chatId = input.callbackQuery.message?.chat?.id;
  if (chatId == null) return null;
  return {
    id: String(chatId),
    type: input.callbackQuery.message?.chat?.type ?? null,
  };
}

function isTerminalIntentStatus(status: string): boolean {
  return TERMINAL_INTENT_STATUSES.has(status);
}

async function answerIntentAlreadyProcessed(
  input: TelegramBotTradingCallbackInput,
  intent: TelegramTradeIntentRow,
): Promise<void> {
  const status = intent.status;
  input.log?.info?.(
    {
      callbackQueryId: input.callbackQuery.id,
      status,
    },
    "Telegram trade callback suppressed because the intent is already active or terminal",
  );
  await input.answerCallbackQuery({
    callbackQueryId: input.callbackQuery.id,
    showAlert: true,
    text: (() => {
      switch (status) {
        case "executing":
          return "Trade is already being processed.";
        case "reconcile_required":
          return UNKNOWN_TRADE_RESOLVING_MESSAGE;
        case "expired":
          return "These buttons expired. Send /market again.";
        case "failed":
          return intent.submit_started_at
            ? "The submitted trade did not fill. Check /trade_status."
            : "Trade failed before submission. Nothing was sent. Send /market again.";
        case "cancelled":
          return intent.error_message?.trim()
            ? `Trade cancelled: ${intent.error_message.trim()}`
            : "Trade was cancelled. Nothing was submitted.";
        case "submitted":
          return "Trade was submitted. Check /trade_status for the result.";
        case "filled":
          return "Trade already filled. Check /trade_status for details.";
        default:
          return "This trade action is no longer active. Send /market again.";
      }
    })(),
  });
}

async function handleTelegramRedeemCallback(input: {
  authorization: TelegramBotTradingAuthorizationRow | null;
  callback: TelegramBotTradingCallbackInput;
  chatId: string;
  intent: TelegramTradeIntentRow;
  market: TelegramBotMarketRow | null;
  parsedType: "redeem" | "confirm";
  policy: SignalBotPolicy;
}): Promise<boolean> {
  const { authorization, callback, chatId, intent, market, policy } = input;
  const lifecycleReady =
    market != null &&
    (await venueLifecycleAllows(callback.db, market.venue, "automation")) &&
    (await venueLifecycleAllows(callback.db, market.venue, "redeem"));
  if (
    !lifecycleReady ||
    !policy.tradingEnabled ||
    !policy.tradingActions.includes("redeem") ||
    !authorization?.enabled ||
    !authorization.privy_wallet_id ||
    !market ||
    market.venue !== "polymarket" ||
    !authorization.enabled_venues.includes("polymarket")
  ) {
    await updateIntentStatus({
      allowedStatuses: PENDING_INTENT_STATUSES,
      db: callback.db,
      errorCode: "redeem_not_ready",
      errorMessage: "Telegram redemption is not ready.",
      intentId: intent.id,
      status: "failed",
    });
    await callback.answerCallbackQuery({
      callbackQueryId: callback.callbackQuery.id,
      showAlert: true,
      text: "Redemption is not ready. Open Hunch Settings.",
    });
    return true;
  }
  const plan = await resolveTelegramPolymarketRedemptionPlan({
    authorization,
    market,
  });
  if (!plan?.targetAddress || !plan.data || !plan.expectedPayoutRaw) {
    await updateIntentStatus({
      allowedStatuses: PENDING_INTENT_STATUSES,
      db: callback.db,
      errorCode: "redeem_quote_changed",
      errorMessage: "The position is no longer redeemable.",
      intentId: intent.id,
      status: "failed",
    });
    await callback.answerCallbackQuery({
      callbackQueryId: callback.callbackQuery.id,
      showAlert: true,
      text: "Position is no longer redeemable.",
    });
    return true;
  }
  if (input.parsedType === "redeem") {
    const confirming = await transitionIntentToConfirming({
      authorization,
      db: callback.db,
      intent,
    });
    if (confirming !== "confirmed") {
      await callback.answerCallbackQuery({
        callbackQueryId: callback.callbackQuery.id,
        showAlert: true,
        text:
          confirming === "blocked"
            ? EXISTING_TRADE_RESOLVING_MESSAGE
            : "Redemption state changed. Send /market again.",
      });
      return true;
    }
    await updateIntentStatus({
      allowedStatuses: ["confirming"],
      db: callback.db,
      intentId: intent.id,
      quoteSnapshot: plan as Record<string, unknown>,
      status: "confirming",
    });
    const credentials = await AuthService.getVenueCredentialsInfo(
      authorization.user_id,
      "polymarket",
      authorization.wallet_address,
    );
    await callback.answerCallbackQuery({
      callbackQueryId: callback.callbackQuery.id,
      text: "Review redemption…",
    });
    await callback.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            {
              callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:confirm:${intent.id}`,
              text: "Confirm redeem",
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
          "Confirm real redemption",
          "",
          `Market: ${market.title}`,
          `YES balance: ${ethers.formatUnits(plan.yesBalanceRaw ?? "0", 6)} shares`,
          `NO balance: ${ethers.formatUnits(plan.noBalanceRaw ?? "0", 6)} shares`,
          `Expected payout: ${formatUsd(Number(plan.expectedPayoutRaw) / 1_000_000)} pUSD`,
          `Canonical deposit wallet: ${credentials?.funderAddress ?? "unavailable"}`,
          "",
          "This is a real on-chain redemption. Confirm only if you want the bot to submit it now.",
        ].join("\n"),
      ),
    });
    return true;
  }

  await attachAuthorizationToIntent({
    authorization,
    db: callback.db,
    intentId: intent.id,
  });
  const executing = await updateIntentStatus({
    allowedStatuses: ["confirming"],
    db: callback.db,
    intentId: intent.id,
    status: "executing",
  });
  if (!executing) {
    await answerIntentAlreadyProcessed(callback, intent);
    return true;
  }
  let accepted = false;
  let definitiveFailure = false;
  let transactionId: string | null = null;
  let txHash: string | null = null;
  let depositWallet: string | null = null;
  try {
    if (plan.executionKind !== "external_adapter") {
      throw new Error("Polymarket redemption adapter plan is not canonical.");
    }
    if (
      !env.polymarketBuilderApiKey ||
      !env.polymarketBuilderApiSecret ||
      !env.polymarketBuilderApiPassphrase
    ) {
      throw new Error("Polymarket relayer signing is not configured.");
    }
    await assertServerEvmWalletAuthorization({
      requiredActions: ["REDEEM"],
      privyUserId: authorization.privy_user_id,
      signer: authorization.wallet_address,
      venue: "polymarket",
      walletId: authorization.privy_wallet_id,
    });
    const credentials = await AuthService.getVenueCredentialsInfo(
      authorization.user_id,
      "polymarket",
      authorization.wallet_address,
    );
    depositWallet = credentials?.funderAddress ?? null;
    if (!depositWallet) {
      throw new Error("Canonical Polymarket DepositWallet is unavailable.");
    }
    const nonce = await fetchPolymarketRelayerNonce(
      authorization.wallet_address,
    );
    const deadline = String(Math.floor(Date.now() / 1_000) + 15 * 60);
    const calls = [{ target: plan.targetAddress, value: "0", data: plan.data }];
    const typedData = buildDepositWalletBatchTypedData({
      depositWalletAddress: depositWallet,
      nonce,
      deadline,
      calls,
    });
    const walletClient = createServerWalletClient();
    const signature = await signPolymarketRedemptionBatch({
      adapterAddress: plan.targetAddress,
      calldata: plan.data,
      depositWalletAddress: depositWallet,
      signer: authorization.wallet_address,
      walletId: authorization.privy_wallet_id,
      typedData,
      walletClient,
    });
    const submitBody = buildDepositWalletSubmitBody({
      ownerAddress: authorization.wallet_address,
      depositWalletAddress: depositWallet,
      nonce,
      deadline,
      calls,
      signature,
    });
    const submitted = await submitPolymarketDepositWalletBatch({
      body: submitBody,
      credentials: {
        key: env.polymarketBuilderApiKey,
        secret: env.polymarketBuilderApiSecret,
        passphrase: env.polymarketBuilderApiPassphrase,
      },
    });
    transactionId = submitted.transactionID ?? null;
    if (!transactionId) {
      throw new Error("Polymarket relayer did not return a transaction ID.");
    }
    accepted = true;
    txHash = submitted.transactionHash ?? null;
    await updateIntentStatus({
      allowedStatuses: ["executing"],
      db: callback.db,
      intentId: intent.id,
      result: {
        plan,
        setupTransaction: {
          kind: "redemption_adapter",
          depositWallet,
          transactionId,
          txHash,
        },
      },
      status: "executing",
      txSignature: txHash,
    });
    const latest = await waitForPolymarketRelayerTransaction({
      transactionId,
    });
    if (POLYMARKET_RELAYER_FAILED_STATES.has(latest?.state ?? "")) {
      definitiveFailure = true;
      throw new Error(
        `Polymarket relayer rejected redemption: ${latest?.state}`,
      );
    }
    if (!POLYMARKET_RELAYER_SUCCESS_STATES.has(latest?.state ?? "")) {
      throw new Error("Polymarket redemption is still pending at the relayer.");
    }
    txHash = latest?.transactionHash ?? txHash;
    if (!txHash) {
      throw new Error(
        "Confirmed Polymarket redemption is missing its tx hash.",
      );
    }
    const receipt = await fetchEmbeddedEthereumTransactionReceipt({
      chainId: 137,
      txHash,
    });
    if (!receipt?.succeeded) {
      definitiveFailure = receipt != null;
      throw new Error("Polymarket redemption transaction reverted.");
    }
    const actualPayoutRaw = sumTokenTransfersTo({
      logs: receipt.logs,
      recipient: depositWallet,
      tokenAddress: env.polymarketPusdAddress,
    });
    if (actualPayoutRaw < BigInt(plan.expectedPayoutRaw)) {
      throw new Error(
        "Confirmed redemption is missing its expected pUSD payout.",
      );
    }
    await updateIntentStatus({
      allowedStatuses: ["executing"],
      db: callback.db,
      intentId: intent.id,
      result: {
        actualPayoutRaw: actualPayoutRaw.toString(),
        plan,
        transactionId,
      },
      status: "filled",
      txSignature: txHash,
    });
    await createNotificationSafe(
      callback.db,
      buildRedemptionNotification({
        amountUsd: Number(actualPayoutRaw) / 1_000_000,
        marketId: market.id,
        txHash,
        userId: authorization.user_id,
        venue: "polymarket",
        walletAddress: depositWallet,
      }),
      callback.log?.warn ? { warn: callback.log.warn } : undefined,
    );
    await callback.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      text: escapeMarkdown(
        [
          "Redemption confirmed.",
          `polymarket · ${market.title}`,
          `Received: ${formatUsd(Number(actualPayoutRaw) / 1_000_000)} pUSD`,
          txHash ? `Transaction: ${txHash}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      ),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Redemption failed.";
    await updateIntentStatus({
      allowedStatuses: ["executing"],
      db: callback.db,
      errorCode:
        accepted && !definitiveFailure
          ? "redeem_state_unknown"
          : "redeem_failed",
      errorMessage: message,
      intentId: intent.id,
      result: {
        plan,
        setupTransaction: {
          kind: "redemption_adapter",
          depositWallet,
          transactionId,
          txHash,
        },
      },
      status: accepted && !definitiveFailure ? "reconcile_required" : "failed",
      txSignature: txHash,
    });
    await callback.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      text: escapeMarkdown(
        accepted && !definitiveFailure
          ? "Redemption is still resolving. The bot is checking automatically; do not retry this market."
          : "Redemption failed before submission. Nothing was sent.",
      ),
    });
  }
  return true;
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

  const senderId = callbackSenderId(input);
  if (!senderId) {
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
  if (intent.telegram_user_id !== normalizeTelegramUserId(senderId)) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "This trade button belongs to another Telegram user.",
    });
    return true;
  }
  if (
    (parsed.type === "buy" && intent.action !== "buy") ||
    (parsed.type === "sell" && intent.action !== "sell")
  ) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Trade action does not match this button.",
    });
    return true;
  }
  const messageChat = callbackMessageChat(input);
  if (
    !messageChat ||
    messageChat.type !== "private" ||
    !intent.chat_id ||
    messageChat.id !== intent.chat_id
  ) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "Open the original private bot chat to use this trade button.",
    });
    return true;
  }
  const chatId = messageChat.id;
  if (input.callbackQuery.message?.message_id != null) {
    await input.db.query(
      `UPDATE telegram_trade_intents
          SET telegram_message_id = $2,
              callback_query_id = $3,
              updated_at = now()
        WHERE id = $1`,
      [
        intent.id,
        input.callbackQuery.message.message_id,
        input.callbackQuery.id,
      ],
    );
  }
  if (isTerminalIntentStatus(intent.status) || intent.status === "executing") {
    await answerIntentAlreadyProcessed(input, intent);
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
      await answerIntentAlreadyProcessed(input, intent);
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
      await answerIntentAlreadyProcessed(input, intent);
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
  const sharesRaw =
    intent.shares_raw && /^\d+$/.test(intent.shares_raw)
      ? BigInt(intent.shares_raw)
      : null;
  const sellPercent = Number(intent.sell_percent);
  const action: "BUY" | "SELL" = intent.action === "sell" ? "SELL" : "BUY";
  const side = intent.side;
  const tradeAmountLabel =
    action === "SELL" && sharesRaw != null
      ? `${ethers.formatUnits(sharesRaw, 6)} shares`
      : formatUsd(amountUsd ?? 0);
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
  if (intent.action === "redeem") {
    if (parsed.type !== "redeem" && parsed.type !== "confirm") {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "Redemption action does not match this button.",
      });
      return true;
    }
    return handleTelegramRedeemCallback({
      authorization,
      callback: input,
      chatId,
      intent,
      market,
      parsedType: parsed.type,
      policy,
    });
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
          action: action === "SELL" ? "SELL" : "BUY",
          authorization,
          market: marketForCallbackReadiness(action, market),
          trading: input.trading,
          venue: intent.venue,
        })
      : null;
  input.log?.debug?.(
    {
      executable: tradeReadiness?.executable ?? false,
      maxExecutableBuyUsd: tradeReadiness?.maxExecutableBuyUsd ?? null,
      reasonCode: tradeReadiness?.reasonCode ?? null,
      repairKind: tradeReadiness?.repair?.kind ?? null,
      venue: intent.venue,
    },
    "Telegram trade venue readiness evaluated",
  );
  if (
    !policy.tradingEnabled ||
    !policy.tradingActions.includes(intent.action) ||
    !policy.tradingVenues.includes(intent.venue) ||
    !market ||
    !isMarketOrderable(market) ||
    !authorization ||
    !authorization.privy_wallet_id ||
    !isVenueAllowed(intent.venue, policy, authorizationVenues) ||
    !canOfferTradeForReadiness(tradeReadiness) ||
    (action === "BUY" &&
      (!amountUsd ||
        amountUsd > maxAmountUsd ||
        (tradeReadiness?.maxExecutableBuyUsd != null &&
          amountUsd > tradeReadiness.maxExecutableBuyUsd))) ||
    (action === "SELL" &&
      (!sharesRaw || sharesRaw <= 0n || ![50, 100].includes(sellPercent))) ||
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
      await answerIntentAlreadyProcessed(input, intent);
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
  if (parsed.type === "buy" || parsed.type === "sell") {
    const unresolvedIntent = await loadUnresolvedTelegramTradeIntent(input.db, {
      excludeIntentId: intent.id,
      marketId: intent.market_id,
      telegramUserId: intent.telegram_user_id,
    });
    if (unresolvedIntent) {
      const text = EXISTING_TRADE_RESOLVING_MESSAGE;
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text,
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(text),
      });
      return true;
    }
    const trading = input.trading;
    if (!trading) {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "Open Hunch to place this trade.",
      });
      return true;
    }
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      text: "Building a fresh quote…",
    });
    const previewIntent =
      action === "SELL" && sharesRaw != null
        ? buildTelegramSellTradeIntent({
            authorization,
            intentId: intent.id,
            market,
            maxSlippageBps: policy.maxSlippageBps,
            sharesRaw,
            side,
          })
        : buildTelegramTradeIntent({
            amountUsd: amountUsd as number,
            authorization,
            intentId: intent.id,
            market,
            maxSlippageBps: policy.maxSlippageBps,
            side,
          });
    let previewQuote: TradeQuote;
    try {
      previewQuote = await trading.quote({ intent: previewIntent });
    } catch (error) {
      const normalized = trading.normalizeError(intent.venue, error);
      await updateIntentStatus({
        allowedStatuses: ["draft", "previewed"],
        db: input.db,
        errorCode: normalized.code,
        errorMessage: normalized.message,
        intentId: intent.id,
        result: { error: normalized, stage: "preview_quote" },
        status: "failed",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          "Unable to build a safe current quote. Nothing was submitted. Send /market again.",
        ),
      });
      return true;
    }
    const previewMaxSpendUsd =
      action === "BUY" ? (previewQuote.maxSpendUsd ?? amountUsd) : null;
    if (
      isTelegramVenueMinimumBlocking({
        action: previewIntent.action,
        meetsVenueMinimum: previewQuote.meetsVenueMinimum,
        orderType: previewIntent.orderType,
        venue: previewIntent.venue,
      })
    ) {
      await updateIntentStatus({
        allowedStatuses: ["draft", "previewed"],
        db: input.db,
        errorCode: "quote_changed",
        errorMessage:
          "Price moved and the order no longer meets venue minimum.",
        intentId: intent.id,
        quoteSnapshot: buildTelegramTradeQuotePreview(previewQuote),
        result: { previewQuote },
        status: "failed",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          "Price moved. Nothing was submitted. Send /market again.",
        ),
      });
      return true;
    }
    if (
      (action === "BUY" &&
        previewMaxSpendUsd != null &&
        previewMaxSpendUsd > maxAmountUsd) ||
      (tradeReadiness?.maxExecutableBuyUsd != null &&
        action === "BUY" &&
        previewMaxSpendUsd != null &&
        previewMaxSpendUsd > tradeReadiness.maxExecutableBuyUsd)
    ) {
      await updateIntentStatus({
        allowedStatuses: ["draft", "previewed"],
        db: input.db,
        errorCode: "max_spend_exceeded",
        errorMessage: "Preview quote exceeds the Telegram bot max buy.",
        intentId: intent.id,
        quoteSnapshot: buildTelegramTradeQuotePreview(previewQuote),
        result: { maxAmountUsd, previewQuote },
        status: "failed",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          action === "BUY"
            ? `Maximum total spend ${formatUsd(previewMaxSpendUsd)} is no longer executable within your ${formatUsd(maxAmountUsd)} limit.`
            : "The confirmed sell quote is no longer executable.",
        ),
      });
      return true;
    }
    const previewRecorded = await updateIntentStatus({
      allowedStatuses: ["draft", "previewed"],
      db: input.db,
      intentId: intent.id,
      quoteSnapshot: buildTelegramTradeQuotePreview(previewQuote),
      result: { previewQuote },
      status: "previewed",
    });
    if (!previewRecorded) {
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          "This trade intent changed while the quote was loading. Send /market again.",
        ),
      });
      return true;
    }
    const confirming = await transitionIntentToConfirming({
      authorization,
      db: input.db,
      intent,
    });
    if (confirming === "blocked") {
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(EXISTING_TRADE_RESOLVING_MESSAGE),
      });
      return true;
    }
    if (confirming !== "confirmed") {
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          "Trade state changed while confirmation was opening. Check /trade_status before trying again.",
        ),
      });
      return true;
    }
    await input.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            {
              callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:confirm:${intent.id}`,
              text: action === "BUY" ? "Confirm buy" : "Confirm sell",
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
          action === "BUY" ? "Confirm real buy" : "Confirm real sell",
          "",
          `Venue: ${intent.venue}`,
          `Market: ${intent.market_title}`,
          `Side: ${side}`,
          `Internal wallet: ${authorization.wallet_address}`,
          `${action === "BUY" ? "Current ask" : "Current bid"}: ${formatTelegramQuotePrice(previewQuote.currentPrice ?? null)}`,
          action === "BUY"
            ? `Maximum execution price: ${formatTelegramQuotePrice(previewQuote.price)}`
            : null,
          action === "BUY"
            ? `Nominal order: ${formatUsd(amountUsd ?? 0)}`
            : `Exact quantity: ${tradeAmountLabel} (${sellPercent}%)`,
          action === "SELL"
            ? `Minimum pUSD receive: ${formatUsd(previewQuote.minimumReceiveUsd ?? 0)}`
            : previewQuote.minReceiveShares == null
              ? null
              : `Minimum estimated shares: ${previewQuote.minReceiveShares.toFixed(2)}`,
          action === "BUY"
            ? `Maximum total spend: ${formatUsd(previewMaxSpendUsd ?? 0)}`
            : `Minimum execution price: ${formatTelegramQuotePrice(previewQuote.price)}`,
          `Price tolerance: ${policy.maxSlippageBps / 100}%`,
          tradeReadiness?.repair?.kind === "auto"
            ? `Possible setup: ${tradeReadiness.repair.message}`
            : "Possible setup: none",
          formatQuoteTtl(previewQuote.expiresAt)
            ? `Quote valid for about ${formatQuoteTtl(previewQuote.expiresAt)}.`
            : null,
          "",
          "This is a real trade. Confirm only if you want the bot to submit it now.",
        ]
          .filter((line): line is string => line != null)
          .join("\n"),
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
    await answerIntentAlreadyProcessed(input, intent);
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
  const sharedIntent =
    action === "SELL" && sharesRaw != null
      ? buildTelegramSellTradeIntent({
          authorization,
          intentId: intent.id,
          market,
          maxSlippageBps: policy.maxSlippageBps,
          sharesRaw,
          side,
        })
      : buildTelegramTradeIntent({
          amountUsd: amountUsd as number,
          authorization,
          intentId: intent.id,
          market,
          maxSlippageBps: policy.maxSlippageBps,
          side,
        });
  let submittedRefs: SubmittedTradeRefs | null = null;
  let submitStarted = false;
  const confirmStartedAtMs = Date.now();
  let broadcastStartedAtMs: number | null = null;
  let readinessRepair: TelegramReadinessRepairAudit | null = null;
  const setupTransactions: TelegramSetupTransactionAudit[] = [];
  const withReadinessRepair = (
    result: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...result,
    ...(readinessRepair ? { readinessRepair } : {}),
    ...(setupTransactions.length > 0
      ? { setupTransactions: [...setupTransactions] }
      : {}),
  });
  try {
    if (
      tradeReadiness &&
      !tradeReadiness.executable &&
      isAutoRepairableReadiness(tradeReadiness)
    ) {
      readinessRepair = {
        attempted: true,
        changed: false,
        finalReasonCode: tradeReadiness.reasonCode,
        sideEffects: [],
      };
      const repaired = await trading.ensureReadiness({
        ...buildTelegramTradingReadinessInput({
          action: action === "SELL" ? "SELL" : "BUY",
          authorization,
          market,
          venue: intent.venue,
        }),
        existingReadiness: tradeReadiness,
      });
      readinessRepair = {
        attempted: true,
        changed: repaired.changed,
        finalReasonCode: repaired.readiness.reasonCode,
        sideEffects: repaired.sideEffects,
      };
      if (!repaired.readiness.executable) {
        const message =
          repaired.readiness.message ??
          "Trading setup could not be completed automatically.";
        await updateIntentStatus({
          allowedStatuses: ["executing"],
          db: input.db,
          errorCode: "not_ready",
          errorMessage: message,
          intentId: intent.id,
          result: withReadinessRepair({}),
          status: "failed",
        });
        await input.answerCallbackQuery({
          callbackQueryId: input.callbackQuery.id,
          showAlert: true,
          text: "Trading setup needs attention. Open Hunch to continue.",
        });
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
          text: escapeMarkdown(message),
        });
        return true;
      }
    }
    if (
      !(await isTelegramBotTradingAuthorizationEnabled(
        input.db,
        authorization,
        intent.venue,
      ))
    ) {
      await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        errorCode: "authorization_disabled",
        errorMessage: "Telegram bot trading was disabled before signing.",
        intentId: intent.id,
        status: "cancelled",
      });
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "Trading was disabled. Nothing was submitted.",
      });
      return true;
    }
    if (intent.venue === "polymarket") {
      const signerStatus = await (
        input.signerInspector ?? inspectServerEvmWalletAuthorization
      )({
        action,
        authorizationEnabled: true,
        privyUserId: authorization.privy_user_id,
        signer: authorization.wallet_address,
        walletId: authorization.privy_wallet_id,
      });
      if (signerStatus.state !== "ready") {
        await updateIntentStatus({
          allowedStatuses: ["executing"],
          db: input.db,
          errorCode: `privy_server_signer_${signerStatus.state}`,
          errorMessage:
            signerStatus.message ?? "Privy server signer is not ready.",
          intentId: intent.id,
          status: "failed",
        });
        await input.answerCallbackQuery({
          callbackQueryId: input.callbackQuery.id,
          showAlert: true,
          text: "Bot access is not ready. Open Hunch Settings.",
        });
        return true;
      }
    }
    const quote = await trading.quote({ intent: sharedIntent });
    const quoteMaxSpendUsd =
      action === "BUY" ? (quote.maxSpendUsd ?? amountUsd) : null;
    const venueMinimumBlocking = isTelegramVenueMinimumBlocking({
      action: sharedIntent.action,
      meetsVenueMinimum: quote.meetsVenueMinimum,
      orderType: sharedIntent.orderType,
      venue: sharedIntent.venue,
    });
    if (
      venueMinimumBlocking ||
      (action === "BUY" &&
        quoteMaxSpendUsd != null &&
        quoteMaxSpendUsd > maxAmountUsd) ||
      (tradeReadiness?.maxExecutableBuyUsd != null &&
        action === "BUY" &&
        quoteMaxSpendUsd != null &&
        quoteMaxSpendUsd > tradeReadiness.maxExecutableBuyUsd)
    ) {
      await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        errorCode: venueMinimumBlocking
          ? "quote_changed"
          : "max_spend_exceeded",
        errorMessage: venueMinimumBlocking
          ? "Price moved and the order no longer meets venue minimum."
          : "Quote max spend exceeds the Telegram bot max buy.",
        intentId: intent.id,
        result: withReadinessRepair({
          maxAmountUsd,
          quote,
          quoteMaxSpendUsd,
        }),
        status: "failed",
      });
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "Price moved. Send /market again.",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          [
            "Trade not submitted.",
            `${intent.venue} · ${intent.market_title}`,
            `${action} ${side} · ${tradeAmountLabel}`,
            action === "BUY"
              ? `Maximum total spend is ${formatUsd(quoteMaxSpendUsd ?? 0)}; the order is no longer executable within your ${formatUsd(maxAmountUsd)} limit.`
              : "The sell is no longer executable at the confirmed minimum price.",
          ].join("\n"),
        ),
      });
      return true;
    }
    if (
      quoteMovedBeyondTelegramTolerance({
        current: quote,
        maxSlippageBps: policy.maxSlippageBps,
        preview: readTelegramTradeQuotePreview(intent.quote_snapshot),
      })
    ) {
      await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        errorCode: "quote_changed",
        errorMessage: "Quote moved beyond the confirmed price tolerance.",
        intentId: intent.id,
        quoteSnapshot: buildTelegramTradeQuotePreview(quote),
        result: withReadinessRepair({
          confirmedQuote: intent.quote_snapshot,
          currentQuote: quote,
        }),
        status: "failed",
      });
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "Price moved. Review a new quote before trading.",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          "The quote moved beyond your confirmed tolerance. Nothing was submitted. Send /market again for a new preview.",
        ),
      });
      return true;
    }
    const recordSetupTransaction = async (
      setupTransaction: TelegramSetupTransactionAudit,
    ) => {
      const existingIndex = setupTransactions.findIndex(
        (entry) =>
          (setupTransaction.referenceId &&
            entry.referenceId === setupTransaction.referenceId) ||
          (setupTransaction.transactionId &&
            entry.transactionId === setupTransaction.transactionId) ||
          (setupTransaction.txHash && entry.txHash === setupTransaction.txHash),
      );
      if (existingIndex >= 0) {
        setupTransactions[existingIndex] = {
          ...setupTransactions[existingIndex],
          ...setupTransaction,
        };
      } else {
        setupTransactions.push(setupTransaction);
      }
      input.log?.info?.(
        {
          intentId: intent.id,
          setupKind: setupTransaction.kind,
          txHash: setupTransaction.txHash,
          venue: intent.venue,
        },
        "Telegram trade setup transaction submitted",
      );
      await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        intentId: intent.id,
        result: withReadinessRepair({ quote }),
        status: "executing",
      });
    };
    const prepared = await trading.prepareTrade({
      intent: sharedIntent,
      quote,
      onSetupTransactionSubmitted: recordSetupTransaction,
    });
    const preparedSnapshot = buildPreparedTradeSnapshot(prepared);
    const preparedRecorded = await updateIntentStatus({
      allowedStatuses: ["executing"],
      db: input.db,
      intentId: intent.id,
      preparedSnapshot,
      result: withReadinessRepair({ quote }),
      status: "executing",
    });
    if (!preparedRecorded) {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "Trade intent is no longer active. Send /market again.",
      });
      return true;
    }
    const recordSubmittedReference = async (submitResult: SubmitResult) => {
      const submitVenueOrderId =
        submitResult.venueOrderId ?? submitResult.txSignature;
      if (
        submittedRefs?.venueOrderId === submitVenueOrderId &&
        submittedRefs.submitResult.txSignature === submitResult.txSignature
      ) {
        input.log?.debug?.(
          {
            intentId: intent.id,
            txSignature: submitResult.txSignature,
            venue: intent.venue,
            venueOrderId: submitVenueOrderId,
          },
          "Duplicate Telegram trade submitted reference suppressed",
        );
        submittedRefs = { submitResult, venueOrderId: submitVenueOrderId };
        return;
      }
      submittedRefs = {
        submitResult,
        venueOrderId: submitVenueOrderId,
      };
      await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        intentId: intent.id,
        result: withReadinessRepair({ quote, submitResult }),
        status: "executing",
        txSignature: submitResult.txSignature,
        venueOrderId: submitVenueOrderId,
      });
    };
    const executed = await trading.executePreparedTrade({
      prepared,
      onBroadcastSubmitted: recordSubmittedReference,
      onBeforeBroadcast: async () => {
        if (
          !(await isTelegramBotTradingAuthorizationEnabled(
            input.db,
            authorization,
            intent.venue,
          ))
        ) {
          throw new Error(
            "Telegram bot trading authorization was disabled before submit.",
          );
        }
        const submitMarked = await updateIntentStatus({
          allowedStatuses: ["executing"],
          db: input.db,
          intentId: intent.id,
          markSubmitStarted: true,
          result: withReadinessRepair({ quote }),
          status: "executing",
        });
        if (!submitMarked) {
          throw new Error("Trade intent is no longer active before submit.");
        }
        submitStarted = true;
        broadcastStartedAtMs = Date.now();
        input.log?.info?.(
          {
            confirmToBroadcastMs: broadcastStartedAtMs - confirmStartedAtMs,
            intentId: intent.id,
            venue: intent.venue,
          },
          "Telegram trade reached irreversible submit boundary",
        );
      },
      onSetupTransactionSubmitted: recordSetupTransaction,
      onSubmitted: recordSubmittedReference,
    });
    const { effects, persisted, postSubmitError, submitResult } = executed;
    const resolution = resolveSubmitIntentStatus(submitResult);
    const venueOrderId =
      persisted?.venueOrderId ??
      submitResult.venueOrderId ??
      submitResult.txSignature;
    const finalized = await finalizeSubmittedIntent({
      db: input.db,
      errorCode: postSubmitError?.code ?? resolution.errorCode,
      errorMessage: postSubmitError?.message ?? resolution.errorMessage,
      executionId: persisted?.executionId ?? null,
      intentId: intent.id,
      orderId: persisted?.orderId ?? null,
      preparedSnapshot,
      result: withReadinessRepair({
        effects,
        persisted,
        quote,
        postSubmitError,
        submitResult,
      }),
      status: postSubmitError ? "submitted" : resolution.intentStatus,
      txSignature: submitResult.txSignature,
      venueOrderId,
    });
    if (!finalized) {
      const currentIntent = await loadIntent(input.db, intent.id);
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "Trade status changed while recording. Check /trade_status before retrying.",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          [
            "Trade status changed while recording.",
            `${intent.venue} · ${intent.market_title}`,
            currentIntent?.status
              ? `Current bot status: ${currentIntent.status}`
              : null,
            "Check /trade_status before retrying.",
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
        ),
      });
      return true;
    }
    input.log?.info?.(
      {
        broadcastToResolvedMs:
          broadcastStartedAtMs == null
            ? null
            : Date.now() - broadcastStartedAtMs,
        intentId: intent.id,
        status: postSubmitError ? "submitted" : resolution.intentStatus,
        txSignature: submitResult.txSignature,
        venue: intent.venue,
        venueOrderId,
      },
      "Telegram trade execution recorded",
    );
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
          `${action} ${side} · ${tradeAmountLabel}`,
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
    const submitted = submittedRefs as SubmittedTradeRefs | null;
    const definitiveSubmitRejection =
      submitStarted && isDefinitiveSubmitRejection(normalized);
    if (submitted) {
      input.log?.warn?.(
        {
          errorCode: normalized.code,
          intentId: intent.id,
          txSignature: submitted.submitResult.txSignature,
          venue: intent.venue,
          venueOrderId: submitted.venueOrderId,
        },
        "Telegram trade requires reconciliation after venue submit",
      );
      await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        errorCode: "reconcile_required",
        errorMessage: normalized.message,
        intentId: intent.id,
        result: withReadinessRepair({
          error: normalized,
          submitResult: submitted.submitResult,
          venue: intent.venue,
        }),
        status: "submitted",
        txSignature: submitted.submitResult.txSignature,
        venueOrderId: submitted.venueOrderId,
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
            `${action} ${side} · ${tradeAmountLabel}`,
            submitted.venueOrderId ? `Order: ${submitted.venueOrderId}` : null,
            "Hunch could not finish local recording. Check the app before retrying.",
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
        ),
      });
      return true;
    }
    if (submitStarted && !definitiveSubmitRejection) {
      input.log?.warn?.(
        {
          errorCode: normalized.code,
          intentId: intent.id,
          missingVenueReference: true,
          venue: intent.venue,
        },
        "Telegram trade submit state is unknown and has no venue reference",
      );
      const unknownMessage = UNKNOWN_TRADE_RESOLVING_MESSAGE;
      await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        errorCode: "submit_state_unknown",
        errorMessage: unknownMessage,
        intentId: intent.id,
        result: withReadinessRepair({
          error: normalized,
          venue: intent.venue,
        }),
        status: "reconcile_required",
      });
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: unknownMessage,
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          [
            "Trade status is unknown.",
            `${intent.venue} · ${intent.market_title}`,
            `${action} ${side} · ${tradeAmountLabel}`,
            "The bot is checking the venue automatically; no action is needed. Check /trade_status before retrying.",
          ].join("\n"),
        ),
      });
      return true;
    }
    if (
      setupTransactions.some(
        (transaction) => transaction.kind === "funding_router",
      )
    ) {
      const unknownMessage =
        "Funding was submitted and is being checked automatically. Do not retry yet.";
      await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        errorCode: "funding_state_unknown",
        errorMessage: unknownMessage,
        intentId: intent.id,
        result: withReadinessRepair({ error: normalized, venue: intent.venue }),
        status: "reconcile_required",
      });
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: unknownMessage,
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: escapeMarkdown(
          "Funding status is being checked automatically. /trade_status will clear this trade after confirmation or revert; do not retry yet.",
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
      result: withReadinessRepair({
        error: normalized,
        venue: intent.venue,
      }),
      status: "failed",
    });
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: definitiveSubmitRejection
        ? "Trade rejected. Nothing was submitted."
        : normalized.code === "unsupported_capability"
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
        definitiveSubmitRejection
          ? `${intent.venue} rejected the order. Nothing was submitted. Refresh the market card before trying again.`
          : normalized.code === "unsupported_capability"
            ? "This venue is not executable from the bot yet. Open Hunch to trade."
            : "Trade failed before a confirmed venue submission. Nothing is being retried automatically.",
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
  expectedType?: "buy" | "sell" | "redeem" | "cancel" | "confirm" | null;
  log?: TelegramBotTradingCallbackInput["log"];
  signerInspector?: TelegramBotTradingSignerInspector;
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
    log: input.log,
    signerInspector: input.signerInspector,
    sendMessage: async (message) => {
      messages.push(message);
      return undefined;
    },
    trading: input.trading,
  });
  return { answers, handled, messages };
}
