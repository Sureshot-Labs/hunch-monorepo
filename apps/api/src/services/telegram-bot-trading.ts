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
  resolveSignalBotTradingPolicyStateFromDb,
  type SignalBotPolicy,
} from "./signal-bot-trading-policy.js";
import {
  assertTelegramBotTradingSetupClaim,
  blockTelegramBotTradingLinkGeneration,
  completeTelegramBotTradingSetupClaim,
  ensureTelegramBotTradingPreferenceForLink,
  resolveTelegramBotTradingEffectiveMaxAmountUsd,
  resolveTelegramBotTradingManagedTarget,
  setTelegramBotTradingDesiredEnabled,
  TELEGRAM_BOT_TRADING_CAPABILITIES,
  type TelegramBotTradingManagedTarget,
  type TelegramBotTradingPreference,
} from "./telegram-bot-trading-preferences.js";
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
  formatTelegramBlockquoteMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramCalloutMarkdownV2,
  formatTelegramCodeMarkdownV2,
  formatTelegramFieldMarkdownV2,
  formatTelegramFieldWithMarkdownV2,
  formatTelegramItalicMarkdownV2,
  formatTelegramRichCallout,
  formatTelegramRichTitle,
  formatTelegramTextWithCommandsMarkdownV2,
  joinTelegramMarkdownV2Lines,
  formatTelegramLivePrice as formatLivePrice,
  formatTelegramQuotePrice,
  formatTelegramQuoteTtl as formatQuoteTtl,
  formatTelegramTtl as formatTtl,
} from "./telegram-bot-trading-presentation.js";
import {
  buildTelegramDepositAddressPresentation,
  resolveCanonicalPolymarketDeposit,
} from "./telegram-bot-deposit.js";
import { buildHunchMiniAppWebButton } from "./telegram-mini-app-buttons.js";
import {
  recordTelegramDepositResolutionAnalytics,
  recordTelegramLifecycleAnalytics,
  resolveTelegramLifecycleChain,
} from "./telegram-lifecycle-analytics.js";
import {
  buildTelegramMarketIdentity,
  formatTelegramVenueButtonIcon,
  formatTelegramVenueLabel,
  formatTelegramVenueLabelMarkdownV2,
} from "./telegram-market-identity.js";
import {
  telegramCustomEmojiId,
  telegramCustomEmojiMarkdownV2,
  telegramCustomEmojiMarkdownV2ForNetwork,
  telegramCustomEmojiMarkdownV2ForVenue,
  telegramCustomEmojiRichText,
  telegramCustomEmojiRichTextForVenue,
} from "./telegram-custom-emoji.js";
import {
  telegramRichBold,
  telegramRichCode,
  telegramRichDetails,
  telegramRichFooter,
  telegramRichMarked,
  telegramRichMetricsTable,
  telegramRichParagraph,
  telegramRichTable,
  telegramRichTableCell,
  telegramRichText,
  type TelegramInputRichMessage,
  type TelegramRichText,
} from "./telegram-rich-message.js";
import {
  buildSignalBotBuyStartParam,
  buildSignalBotMarketStartParam,
} from "./signal-bot-mini-app-links.js";
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

function formatTelegramVenueFieldMarkdownV2(venue: string): string {
  const emoji = telegramCustomEmojiMarkdownV2ForVenue(venue);
  return `${emoji ?? "🌐"} ${formatTelegramFieldMarkdownV2(
    "Venue",
    formatTelegramVenueLabel(venue),
  )}`;
}

function formatTelegramVenueRichText(venue: string): TelegramRichText {
  return telegramRichText(
    telegramCustomEmojiRichTextForVenue(venue) ?? "🌐",
    " ",
    formatTelegramVenueLabel(venue),
  );
}

function formatTelegramVenueListRichText(
  venues: readonly string[],
): TelegramRichText {
  return telegramRichText(
    ...venues.flatMap((venue, index) => [
      ...(index > 0 ? ([" · "] as TelegramRichText[]) : []),
      formatTelegramVenueRichText(venue),
    ]),
  );
}

function formatTelegramUsdcLineMarkdownV2(value: string): string {
  const field = value.match(/^([^:\n]{1,48}):\s+(.+)$/);
  return `${telegramCustomEmojiMarkdownV2("usdc")} ${
    field
      ? formatTelegramFieldMarkdownV2(field[1] ?? "Amount", field[2] ?? "")
      : escapeMarkdown(value)
  }`;
}

function formatTelegramKnownNetworksInTextMarkdownV2(value: string): string {
  const matches = Array.from(value.matchAll(/\b(Base|Polygon|Solana)\b/g));
  if (matches.length === 0)
    return formatTelegramTextWithCommandsMarkdownV2(value);
  const rendered: string[] = [];
  let offset = 0;
  for (const match of matches) {
    const label = match[0] ?? "";
    const index = match.index ?? 0;
    const emoji = telegramCustomEmojiMarkdownV2ForNetwork(label);
    rendered.push(
      formatTelegramTextWithCommandsMarkdownV2(value.slice(offset, index)),
    );
    rendered.push(
      emoji ? `${emoji} ${escapeMarkdown(label)}` : escapeMarkdown(label),
    );
    offset = index + label.length;
  }
  rendered.push(formatTelegramTextWithCommandsMarkdownV2(value.slice(offset)));
  return rendered.join("");
}

const TELEGRAM_MARKET_FIELD_ICONS: Readonly<Record<string, string>> = {
  "Add at least": telegramCustomEmojiMarkdownV2("usdc"),
  Ask: "📈",
  Available: telegramCustomEmojiMarkdownV2("usdc"),
  "Bid/ask": "📊",
  Bid: "📉",
  Buy: "🟢",
  "Current buy odds": "📊",
  "Last traded": "📊",
  "Live bid": "📉",
  "Maximum spend": telegramCustomEmojiMarkdownV2("usdc"),
  Order: "🛒",
  PnL: "📈",
  Position: "📦",
  "Ready now": telegramCustomEmojiMarkdownV2("usdc"),
  Sell: "🔴",
  "Trade amount in Hunch": telegramCustomEmojiMarkdownV2("usdc"),
  Wallet: "👛",
};

function formatTelegramMarketCardLineMarkdownV2(value: string): string {
  if (!value) return "";
  const field = value.match(/^([^:\n]{1,40}):\s+(.+)$/);
  if (field) {
    const label = field[1] ?? "Details";
    const rawValue = field[2] ?? "";
    const icon =
      TELEGRAM_MARKET_FIELD_ICONS[label] ??
      (label.endsWith(" balance")
        ? telegramCustomEmojiMarkdownV2("usdc")
        : "ℹ️");
    return `${icon} ${formatTelegramFieldWithMarkdownV2(
      label,
      formatTelegramKnownNetworksInTextMarkdownV2(rawValue),
    )}`;
  }
  if (value === EXISTING_TRADE_RESOLVING_MESSAGE) {
    return formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2: formatTelegramTextWithCommandsMarkdownV2(value),
      icon: "⏳",
      title: "Trade still resolving",
    });
  }
  const icon =
    /unavailable|not open|not enabled|not ready|disabled|too low|no executable|no bot buy|must be|failed/i.test(
      value,
    )
      ? "⚠️"
      : /valid for|preview only|open hunch|link telegram|enable telegram|trade in hunch/i.test(
            value,
          )
        ? "ℹ️"
        : null;
  const rendered = formatTelegramKnownNetworksInTextMarkdownV2(value);
  return icon
    ? formatTelegramBlockquoteMarkdownV2([`${icon} ${rendered}`])
    : rendered;
}

function buildTelegramMarketCardRichMessage(input: {
  identityLines: string[];
  lines: string[];
  status: string;
  titleIcon: string;
  venue: string;
  venueLineIndex: number;
}): TelegramInputRichMessage {
  const blocks: TelegramInputRichMessage["blocks"] = [
    formatTelegramRichTitle(input.titleIcon, input.lines[0] ?? "Market"),
    telegramRichParagraph(
      telegramRichText(
        ...input.identityLines.flatMap((line, index) => [
          ...(index > 0 ? (["\n"] as TelegramRichText[]) : []),
          input.identityLines.length > 1 && index === 0 ? "🏆 " : "🎯 ",
          index === input.identityLines.length - 1
            ? telegramRichBold(line)
            : line,
        ]),
      ),
    ),
  ];
  const startIndex = 2 + input.identityLines.length;
  const sections: Array<Array<{ index: number; line: string }>> = [];
  let current: Array<{ index: number; line: string }> = [];
  for (let index = startIndex; index < input.lines.length; index += 1) {
    const line = input.lines[index] ?? "";
    if (!line.trim()) {
      if (current.length > 0) sections.push(current);
      current = [];
      continue;
    }
    current.push({ index, line });
  }
  if (current.length > 0) sections.push(current);

  for (const section of sections) {
    const rows: Array<{ label: TelegramRichText; value: TelegramRichText }> =
      [];
    const notes: string[] = [];
    let caption = "Details";
    for (const entry of section) {
      if (entry.index === input.venueLineIndex) {
        caption = "Market data";
        rows.push(
          { label: "Venue", value: formatTelegramVenueRichText(input.venue) },
          { label: "Status", value: telegramRichBold(input.status) },
        );
        continue;
      }
      const field = entry.line.match(/^([^:\n]{1,48}):\s+(.+)$/);
      if (!field) {
        notes.push(entry.line);
        continue;
      }
      const label = field[1] ?? "Details";
      const value = field[2] ?? "";
      if (/^(Position|Live bid|Wallet)$/i.test(label)) {
        caption = "Your position";
      }
      const valueText: TelegramRichText = /venue/i.test(label)
        ? formatTelegramVenueRichText(value)
        : /wallet|address/i.test(label)
          ? telegramRichCode(value)
          : /amount|available|balance|spend|receive/i.test(label)
            ? telegramRichText(
                telegramCustomEmojiRichText("usdc"),
                " ",
                telegramRichBold(value),
              )
            : telegramRichBold(value);
      rows.push({ label, value: valueText });
    }
    if (rows.length > 0) {
      blocks.push(
        telegramRichMetricsTable({
          caption: telegramRichBold(caption),
          rows,
          valueAlign: /Market data|Your position/.test(caption)
            ? "left"
            : "right",
        }),
      );
    }
    for (const note of notes) {
      const important =
        /deposit (?:at least|before buying)|balance is too low|do not retry|nothing was submitted|real trade/i.test(
          note,
        );
      blocks.push(
        telegramRichParagraph(
          important ? telegramRichMarked(telegramRichText("⚠️ ", note)) : note,
        ),
      );
    }
  }
  return { blocks };
}

function formatTelegramTradeLifecycleMessageMarkdownV2(input: {
  heading: string;
  lines?: Array<string | null>;
  marketTitle: string;
  venue: string;
}): string {
  const normalizedHeading = input.heading.replace(/[.!]+$/g, "");
  const headingIcon = /filled|completed|submitted|ready|success/i.test(
    normalizedHeading,
  )
    ? "✅"
    : /processing|resolving|checking|loading|building/i.test(normalizedHeading)
      ? "⏳"
      : /failed|not |unavailable|expired|cancel|changed|attention|unknown/i.test(
            normalizedHeading,
          )
        ? "⚠️"
        : "ℹ️";
  const detailLines = (input.lines ?? [])
    .filter((line): line is string => line != null)
    .map((line) => {
      const order = line.match(/^(BUY|SELL)\s+(.+)$/);
      if (order) {
        return `🛒 ${formatTelegramFieldMarkdownV2(
          "Order",
          `${order[1]} ${order[2]}`,
        )}`;
      }
      const field = line.match(/^([^:\n]{1,48}):\s+(.+)$/);
      if (!field) return formatTelegramTextWithCommandsMarkdownV2(line);
      const label = field[1] ?? "Details";
      const value = field[2] ?? "";
      const copyable = /^(Order|Transaction|Tx|Signature)$/i.test(label);
      return `${copyable ? "🔗" : "ℹ️"} ${
        copyable
          ? formatTelegramFieldWithMarkdownV2(
              label,
              formatTelegramCodeMarkdownV2(value),
            )
          : formatTelegramFieldMarkdownV2(label, value)
      }`;
    });
  return [
    `${headingIcon} ${formatTelegramBoldMarkdownV2(normalizedHeading)}`,
    "",
    formatTelegramVenueFieldMarkdownV2(input.venue),
    `🎯 ${formatTelegramFieldMarkdownV2("Market", input.marketTitle)}`,
    ...(detailLines.length > 0 ? ["", ...detailLines] : []),
  ].join("\n");
}

export type TelegramBotTradingButton = (
  | { text: string; callback_data: string }
  | { text: string; copy_text: { text: string } }
  | { text: string; web_app: { url: string } }
  | { text: string; url: string }
) & { icon_custom_emoji_id?: string };

export type TelegramBotTradingReplyMarkup = {
  inline_keyboard: TelegramBotTradingButton[][];
};

export type TelegramBotTradingMessage = {
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: TelegramBotTradingReplyMarkup;
  richMessage?: TelegramInputRichMessage;
  text: string;
};

export type TelegramMarketCardContext = {
  focusPositionId?: string;
  focusPositionWalletAddress?: string | null;
  focusSide?: TelegramBotTradingSide;
  observedNoAsk?: number | null;
  observedYesAsk?: number | null;
  origin: "direct" | "position" | "search";
  positionLines?: string[];
  positionRedemptionStatus?: string | null;
  returnCallbackData?: string;
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
  preference_applied_policy_revision?: string | null;
  preference_blocked_telegram_account_id?: string | null;
  preference_claim_decision_version?: string | number | null;
  preference_claim_expires_at?: Date | string | null;
  preference_claim_id?: string | null;
  preference_claim_policy_revision?: string | null;
  preference_claim_telegram_account_id?: string | null;
  preference_decision_source?:
    | TelegramBotTradingPreference["decisionSource"]
    | null;
  preference_decision_version?: string | number | null;
  preference_desired_enabled?: boolean | null;
  preference_last_setup_error_code?: string | null;
  preference_manual_disabled_at?: Date | string | null;
  preference_retry_after?: Date | string | null;
  preference_retry_attempt_count?: number | null;
  preference_setup_blocked?: boolean | null;
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
  preference: TelegramBotTradingPreference | null;
  managedSetup: TelegramBotTradingManagedSetupStatus;
  targetConfig: TelegramBotTradingManagedTarget;
  actualConfig: {
    maxAmountUsd: number | null;
    venues: TelegramBotTradingVenue[];
  };
};

export type TelegramBotTradingManagedSetupStatus = {
  state: "blocked" | "complete" | "in_progress" | "pending" | "retry_wait";
  reason: string | null;
  leaseExpiresAt: string | null;
  retryAfter: string | null;
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
  setupClaimId?: string | null;
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
    richMessage?: TelegramInputRichMessage;
    text: string;
  }) => Promise<unknown>;
  signerInspector?: TelegramBotTradingSignerInspector;
  telegramMiniAppEnabled?: boolean;
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
    richMessage?: TelegramInputRichMessage;
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
  return `${cents}¢`;
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

function canPreviewBuyForReadiness(
  readiness: TradingReadiness | null | undefined,
): boolean {
  if (canOfferTradeForReadiness(readiness)) return true;
  const reason = readiness?.reasonCode?.toLowerCase() ?? "";
  return (
    reason.includes("no_executable_funds") ||
    reason.includes("insufficient_funds")
  );
}

function readPolymarketControlledFundsUsd(
  readiness: TradingReadiness | null | undefined,
): number | null {
  if (!isRecord(readiness?.raw)) return null;
  if (readiness.raw.kind !== "polymarket_funds_v1") return null;
  const raw = readiness.raw.controlledFundsRaw;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const amount = Number(raw) / 1_000_000;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function resolveTelegramBuyFundingState(input: {
  controlledFundsUsd: number | null;
  executableFundsUsd: number;
  requiredUsd: number;
}): "convert" | "deposit" | "ready" {
  if (input.requiredUsd <= input.executableFundsUsd + 0.000_001) {
    return "ready";
  }
  if (
    input.controlledFundsUsd != null &&
    input.requiredUsd <= input.controlledFundsUsd + 0.000_001
  ) {
    return "convert";
  }
  return "deposit";
}

export function resolveTelegramBuyFundingPreview(input: {
  controlledFundsUsd: number | null;
  executableFundsUsd: number;
  requiredUsd: number;
}): {
  availableUsd: number;
  shortfallUsd: number;
  state: "convert" | "deposit" | "ready";
} {
  const availableUsd = Math.max(
    0,
    input.controlledFundsUsd ?? input.executableFundsUsd,
  );
  return {
    availableUsd,
    shortfallUsd: Math.max(0, input.requiredUsd - availableUsd),
    state: resolveTelegramBuyFundingState(input),
  };
}

function hasInsufficientFundsReason(
  readiness: TradingReadiness | null | undefined,
): boolean {
  const reason = readiness?.reasonCode?.toLowerCase() ?? "";
  return (
    reason.includes("no_executable_funds") ||
    reason.includes("insufficient_funds")
  );
}

function observedAsk(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : null;
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
  formatTelegramTradeLifecycleMessageMarkdownV2,
  formatTelegramUsdcLineMarkdownV2,
  isDefinitiveSubmitRejection,
  isTelegramVenueMinimumBlocking,
  marketForCallbackReadiness,
  resolveTelegramBuyFundingState,
  resolveTelegramBuyFundingPreview,
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
  signerPolicyMaxAmountUsd = env.privyPolymarketBotBuyPolicyMaxUsd,
): number {
  return resolveTelegramBotTradingEffectiveMaxAmountUsd({
    authorizationMaxAmountUsd,
    policy,
    signerPolicyMaxAmountUsd,
  });
}

function isVenueAllowed(
  venue: TelegramBotTradingVenue,
  policy: SignalBotPolicy,
  enabledVenues: readonly TelegramBotTradingVenue[],
): boolean {
  return (
    TELEGRAM_BOT_TRADING_CAPABILITIES.includes(venue) &&
    policy.tradingVenues.includes(venue) &&
    enabledVenues.includes(venue)
  );
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

const MAX_TELEGRAM_BUY_PRESET_AMOUNTS = 3;

function resolveTelegramBuyPresetAmountsUsd(
  configuredAmountsUsd: readonly number[],
  maxAmountUsd: number,
): number[] {
  if (!Number.isFinite(maxAmountUsd) || maxAmountUsd <= 0) return [];
  return Array.from(
    new Set(
      configuredAmountsUsd
        .filter((amountUsd) => Number.isFinite(amountUsd) && amountUsd > 0)
        .map((amountUsd) => Math.min(amountUsd, maxAmountUsd)),
    ),
  )
    .sort((left, right) => left - right)
    .slice(0, MAX_TELEGRAM_BUY_PRESET_AMOUNTS);
}

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
    maxSpendUsd > input.maxAmountUsd
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

function buildTelegramTradingMiniAppButton(input: {
  appBaseUrl: string;
  path: string;
  telegramMiniAppEnabled?: boolean;
  text: string;
}): TelegramBotTradingButton | null {
  return buildHunchMiniAppWebButton({
    appBaseUrl: input.appBaseUrl,
    enabled: input.telegramMiniAppEnabled === true,
    path: input.path,
    text: input.text,
  });
}

function telegramTradingButtonRows(
  button: TelegramBotTradingButton | null,
): TelegramBotTradingButton[][] {
  return button ? [[button]] : [];
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
  if (last) return `Last traded: ${last}`;
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

function buildTelegramBotTradingManagedSetupStatus(input: {
  actualMaxAmountUsd: number | null;
  actualVenues: TelegramBotTradingVenue[];
  linked: boolean;
  policy: SignalBotPolicy;
  preference: TelegramBotTradingPreference | null;
  target: TelegramBotTradingManagedTarget;
}): TelegramBotTradingManagedSetupStatus {
  const { preference } = input;
  if (!preference) {
    return {
      state: "blocked",
      reason: "preference_missing",
      leaseExpiresAt: null,
      retryAfter: null,
    };
  }
  if (!preference.desiredEnabled) {
    return {
      state: "complete",
      reason: "user_opted_out",
      leaseExpiresAt: null,
      retryAfter: null,
    };
  }
  if (!input.linked) {
    return {
      state: "blocked",
      reason: "telegram_not_linked",
      leaseExpiresAt: null,
      retryAfter: preference.retryAfter,
    };
  }
  if (!input.policy.autoEnableOnTelegramLink || !input.policy.tradingEnabled) {
    return {
      state: "blocked",
      reason: "auto_setup_disabled_by_policy",
      leaseExpiresAt: null,
      retryAfter: preference.retryAfter,
    };
  }
  const unsupportedVenue = input.policy.autoManagedVenues.find(
    (venue) => !TELEGRAM_BOT_TRADING_CAPABILITIES.includes(venue),
  );
  if (unsupportedVenue) {
    return {
      state: "blocked",
      reason: `unsupported_managed_venue:${unsupportedVenue}`,
      leaseExpiresAt: null,
      retryAfter: preference.retryAfter,
    };
  }
  if (input.target.venues.length === 0) {
    return {
      state: "blocked",
      reason: "no_managed_venues_available",
      leaseExpiresAt: null,
      retryAfter: preference.retryAfter,
    };
  }
  if (preference.setupBlocked) {
    return {
      state: "blocked",
      reason: preference.lastSetupErrorCode ?? "setup_blocked",
      leaseExpiresAt: null,
      retryAfter: preference.retryAfter,
    };
  }
  if (
    preference.claimId &&
    preference.claimExpiresAt &&
    new Date(preference.claimExpiresAt).getTime() > Date.now()
  ) {
    return {
      state: "in_progress",
      reason: null,
      leaseExpiresAt: preference.claimExpiresAt,
      retryAfter: preference.retryAfter,
    };
  }
  if (
    preference.retryAfter &&
    new Date(preference.retryAfter).getTime() > Date.now()
  ) {
    return {
      state: "retry_wait",
      reason: preference.lastSetupErrorCode,
      leaseExpiresAt: null,
      retryAfter: preference.retryAfter,
    };
  }
  const actualVenues = [...input.actualVenues].sort();
  const targetVenues = [...input.target.venues].sort();
  const complete =
    preference.appliedPolicyRevision === input.target.policyRevision &&
    actualVenues.join(",") === targetVenues.join(",") &&
    input.actualMaxAmountUsd === input.target.maxAmountUsd;
  return {
    state: complete ? "complete" : "pending",
    reason: complete ? null : preference.lastSetupErrorCode,
    leaseExpiresAt: null,
    retryAfter: preference.retryAfter,
  };
}

function preferenceDateIso(value: Date | string | null | undefined) {
  return value == null ? null : new Date(value).toISOString();
}

function preferenceFromStatusRow(
  row: TelegramBotTradingStatusRow,
): TelegramBotTradingPreference | null {
  // Unit fakes written before preferences omit the selected columns entirely.
  // Real Postgres rows return null for a missing LEFT JOIN, which remains
  // fail-closed.
  if (row.preference_desired_enabled === undefined) {
    return {
      appliedPolicyRevision: null,
      blockedTelegramAccountId: null,
      claimDecisionVersion: null,
      claimExpiresAt: null,
      claimId: null,
      claimPolicyRevision: null,
      claimTelegramAccountId: null,
      decisionSource: "legacy_enabled",
      decisionVersion: 1,
      desiredEnabled: row.enabled === true,
      lastSetupErrorCode: null,
      manualDisabledAt: null,
      retryAfter: null,
      retryAttemptCount: 0,
      setupBlocked: false,
      userId: row.user_id ?? "",
    };
  }
  if (row.preference_desired_enabled === null || !row.user_id) return null;
  return {
    appliedPolicyRevision: row.preference_applied_policy_revision ?? null,
    blockedTelegramAccountId:
      row.preference_blocked_telegram_account_id ?? null,
    claimDecisionVersion:
      row.preference_claim_decision_version == null
        ? null
        : Number(row.preference_claim_decision_version),
    claimExpiresAt: preferenceDateIso(row.preference_claim_expires_at),
    claimId: row.preference_claim_id ?? null,
    claimPolicyRevision: row.preference_claim_policy_revision ?? null,
    claimTelegramAccountId: row.preference_claim_telegram_account_id ?? null,
    decisionSource: row.preference_decision_source ?? "legacy_preserved",
    decisionVersion: Number(row.preference_decision_version ?? 1),
    desiredEnabled: row.preference_desired_enabled,
    lastSetupErrorCode: row.preference_last_setup_error_code ?? null,
    manualDisabledAt: preferenceDateIso(row.preference_manual_disabled_at),
    retryAfter: preferenceDateIso(row.preference_retry_after),
    retryAttemptCount: row.preference_retry_attempt_count ?? 0,
    setupBlocked: row.preference_setup_blocked ?? false,
    userId: row.user_id,
  };
}

export function buildUnlinkedTelegramBotTradingStatus(input: {
  privyUserId?: string | null;
  policy?: SignalBotPolicy;
  preference?: TelegramBotTradingPreference | null;
  setupIssue?: string;
  targetConfig?: TelegramBotTradingManagedTarget;
  telegramUserId?: string | null;
  userId?: string | null;
}): TelegramBotTradingStatus {
  const targetConfig = input.targetConfig ?? {
    maxAmountUsd: 1,
    policyRevision: "signal-bot-default-v2",
    venues: ["polymarket"],
  };
  const preference = input.preference ?? null;
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
    preference,
    targetConfig,
    actualConfig: { maxAmountUsd: null, venues: [] },
    managedSetup: buildTelegramBotTradingManagedSetupStatus({
      actualMaxAmountUsd: null,
      actualVenues: [],
      linked: false,
      policy:
        input.policy ??
        ({
          autoEnableOnTelegramLink: false,
          autoManagedMaxAmountUsd: 1,
          autoManagedVenues: ["polymarket"],
          tradingEnabled: false,
          tradingActions: ["buy"],
          tradingVenues: ["polymarket"],
          buyAmountPresetsUsd: [1],
          maxTradeAmountUsd: 1,
          maxSlippageBps: 500,
          intentTtlSec: 120,
          requireConfirmation: true,
        } satisfies SignalBotPolicy),
      preference,
      target: targetConfig,
    }),
  };
}

export async function getTelegramBotTradingStatus(
  db: DbQuery,
  telegramUserId: string | number,
  trading?: ApiBotTradingExecutor,
  signerInspector: TelegramBotTradingSignerInspector = inspectServerEvmWalletAuthorization,
): Promise<TelegramBotTradingStatus> {
  const normalizedTelegramUserId = normalizeTelegramUserId(telegramUserId);
  const policyState = await resolveSignalBotTradingPolicyStateFromDb(db);
  const runtimePolicy = policyState.policy;
  const targetConfig = resolveTelegramBotTradingManagedTarget(policyState);
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
       a.last_verified_at,
       p.applied_policy_revision AS preference_applied_policy_revision,
       p.blocked_telegram_account_id AS preference_blocked_telegram_account_id,
       p.claim_decision_version AS preference_claim_decision_version,
       p.claim_expires_at AS preference_claim_expires_at,
       p.claim_id AS preference_claim_id,
       p.claim_policy_revision AS preference_claim_policy_revision,
       p.claim_telegram_account_id AS preference_claim_telegram_account_id,
       p.decision_source AS preference_decision_source,
       p.decision_version AS preference_decision_version,
       p.desired_enabled AS preference_desired_enabled,
       p.last_setup_error_code AS preference_last_setup_error_code,
       p.manual_disabled_at AS preference_manual_disabled_at,
       p.retry_after AS preference_retry_after,
       p.retry_attempt_count AS preference_retry_attempt_count,
       p.setup_blocked AS preference_setup_blocked
     FROM user_telegram_accounts uta
     JOIN users u ON u.id = uta.user_id
     LEFT JOIN telegram_bot_trading_preferences p ON p.user_id = uta.user_id
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
      policy: runtimePolicy,
      targetConfig,
      telegramUserId: normalizedTelegramUserId,
    });
  }
  const preference = preferenceFromStatusRow(row);
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
    const effectiveAuthorizationMaxAmountUsd = effectiveMaxTradeAmountUsd(
      runtimePolicy,
      authorizationRow.max_amount_usd,
    );
    const enabledVenues = filterVenuesForWalletChain(
      normalizeVenues(authorizationRow.enabled_venues),
      authorizationRow.wallet_chain,
    );
    let enabled =
      authorizationRow.enabled &&
      preference?.desiredEnabled === true &&
      !safetyDisableApplied;
    let signerStatus =
      authorizationRow.wallet_chain === "ethereum" &&
      authorizationRow.privy_wallet_id
        ? await signerInspector({
            authorizationEnabled:
              preference?.desiredEnabled === true &&
              enabledVenues.every((venue) => venue === "polymarket"),
            requiredActions,
            privyUserId: authorizationRow.privy_user_id,
            signer: authorizationRow.wallet_address,
            walletId: authorizationRow.privy_wallet_id,
          })
        : null;
    const botPolicySafe =
      runtimePolicy.tradingEnabled &&
      enabledVenues.length > 0 &&
      enabledVenues.every(
        (venue) =>
          venue === "polymarket" && runtimePolicy.tradingVenues.includes(venue),
      ) &&
      authorizationRow.wallet_chain === "ethereum" &&
      signerStatus?.state === "ready";
    if (
      authorizationRow.enabled &&
      (!botPolicySafe || !preference?.desiredEnabled)
    ) {
      await disableTelegramBotTradingLocal(
        db,
        {
          telegramUserId: normalizedTelegramUserId,
        },
        { recordLifecycle: true, updatePreference: false },
      );
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
      maxAmountUsd: effectiveAuthorizationMaxAmountUsd,
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
    preference,
    targetConfig,
    actualConfig: {
      maxAmountUsd: activeAuthorization?.maxAmountUsd ?? null,
      venues: enabledVenues,
    },
    managedSetup: buildTelegramBotTradingManagedSetupStatus({
      actualMaxAmountUsd: activeAuthorization?.maxAmountUsd ?? null,
      actualVenues: enabledVenues,
      linked: true,
      policy: runtimePolicy,
      preference,
      target: targetConfig,
    }),
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

  const policyState = await resolveSignalBotTradingPolicyStateFromDb(db);
  const policy = policyState.policy;
  const managedTarget = resolveTelegramBotTradingManagedTarget(policyState);
  const unsupportedManagedVenue = policy.autoManagedVenues.find(
    (venue) => !TELEGRAM_BOT_TRADING_CAPABILITIES.includes(venue),
  );
  if (unsupportedManagedVenue) {
    throw new TelegramBotTradingEnableError({
      code: `unsupported_managed_venue:${unsupportedManagedVenue}`,
      message: `Telegram bot trading setup is not available for ${unsupportedManagedVenue}.`,
      statusCode: 409,
    });
  }
  const explicitlyRequestedVenues =
    input.enabledVenues === undefined
      ? null
      : normalizeVenues(input.enabledVenues);
  if (!policy.tradingEnabled) {
    throw new TelegramBotTradingEnableError({
      code: "trading_disabled_by_policy",
      message: "Telegram bot trading is disabled by runtime policy.",
      statusCode: 409,
    });
  }
  const targetVenueKey = [...managedTarget.venues].sort().join(",");
  if (
    explicitlyRequestedVenues &&
    [...explicitlyRequestedVenues].sort().join(",") !== targetVenueKey
  ) {
    throw new TelegramBotTradingEnableError({
      code: "managed_configuration_mismatch",
      message: "Telegram trading settings are managed by Hunch policy.",
      statusCode: 409,
    });
  }
  if (
    input.maxAmountUsd != null &&
    input.maxAmountUsd !== managedTarget.maxAmountUsd
  ) {
    throw new TelegramBotTradingEnableError({
      code: "managed_configuration_mismatch",
      message: "Telegram trading max amount is managed by Hunch policy.",
      statusCode: 409,
    });
  }
  const requestedVenueSource = managedTarget.venues;
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
  if (!input.setupClaimId) {
    await setTelegramBotTradingDesiredEnabled(db, {
      desiredEnabled: true,
      source: "manual_enable",
      userId: input.userId,
    });
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
  const requestedMaxAmountUsd = managedTarget.maxAmountUsd;
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

  const enabledAuthorizations = await withOptionalTransaction(
    db,
    async (client) => {
      const currentPolicyState =
        await resolveSignalBotTradingPolicyStateFromDb(client);
      if (currentPolicyState.policyRevision !== managedTarget.policyRevision) {
        throw new Error(
          input.setupClaimId
            ? "telegram_bot_trading_claim_stale"
            : "telegram_bot_trading_policy_changed",
        );
      }
      if (input.setupClaimId) {
        await assertTelegramBotTradingSetupClaim(client, {
          claimId: input.setupClaimId,
          policyRevision: managedTarget.policyRevision,
          userId: input.userId,
        });
      } else {
        const preference = await client.query<{ desired_enabled: boolean }>(
          `SELECT desired_enabled
             FROM telegram_bot_trading_preferences
            WHERE user_id = $1
            FOR UPDATE`,
          [input.userId],
        );
        if (preference.rows[0]?.desired_enabled !== true) {
          throw new Error("telegram_bot_trading_opted_out");
        }
      }
      const recorded: Array<{
        enabled_venues: TelegramBotTradingVenue[];
        id: string;
        updated_at: Date | string;
        wallet_chain: TelegramBotTradingWalletChain;
      }> = [];
      for (const update of authorizationUpdates) {
        const result = await client.query<{
          enabled_venues: TelegramBotTradingVenue[];
          id: string;
          updated_at: Date | string;
          wallet_chain: TelegramBotTradingWalletChain;
        }>(
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
         updated_at = now()
       RETURNING id, wallet_chain, enabled_venues, updated_at`,
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
        recorded.push(...result.rows);
      }
      const recordedIds = recorded.map((authorization) => authorization.id);
      await client.query(
        `UPDATE telegram_bot_trading_authorizations
            SET enabled = false,
                disabled_at = coalesce(disabled_at, now()),
                updated_at = now()
          WHERE telegram_user_id = $1
            AND enabled = true
            AND NOT (id = ANY($2::uuid[]))`,
        [telegramUserId, recordedIds],
      );
      if (input.setupClaimId) {
        await completeTelegramBotTradingSetupClaim(client, {
          claimId: input.setupClaimId,
          policyRevision: managedTarget.policyRevision,
          userId: input.userId,
        });
      } else {
        await client.query(
          `UPDATE telegram_bot_trading_preferences
              SET applied_policy_revision = $2,
                  retry_attempt_count = 0,
                  retry_after = NULL,
                  last_setup_error_code = NULL,
                  setup_blocked = false,
                  updated_at = now()
            WHERE user_id = $1
              AND desired_enabled = true`,
          [input.userId, managedTarget.policyRevision],
        );
      }
      return recorded;
    },
  );

  await Promise.allSettled(
    enabledAuthorizations.flatMap((authorization) =>
      authorization.enabled_venues.map((venue) =>
        recordTelegramLifecycleAnalytics({
          chain: resolveTelegramLifecycleChain(
            venue,
            authorization.wallet_chain,
          ),
          db,
          dedupeKey: `telegram-trading:${authorization.id}:enabled:${venue}:${new Date(authorization.updated_at).toISOString()}`,
          event: "hf_telegram_trading_lifecycle",
          source: "telegram_trading_settings",
          status: "enabled",
          userId: input.userId,
          venue,
        }),
      ),
    ),
  );

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
  return disableTelegramBotTradingLocal(
    db,
    { userId },
    { updatePreference: true },
  );
}

export async function disableTelegramBotTradingForTelegramUser(
  db: DbQuery,
  telegramUserId: string | number,
): Promise<boolean> {
  return (
    (await disableTelegramBotTradingLocal(
      db,
      {
        telegramUserId: normalizeTelegramUserId(telegramUserId),
      },
      { updatePreference: true },
    )) > 0
  );
}

export async function cleanupTelegramBotTradingForUnlink(
  db: DbQuery,
  userId: string,
): Promise<number> {
  return disableTelegramBotTradingLocal(
    db,
    { userId },
    { blockLinkGeneration: true, updatePreference: false },
  );
}

async function disableTelegramBotTradingLocal(
  db: DbQuery,
  selector: { telegramUserId: string } | { userId: string },
  options: {
    blockLinkGeneration?: boolean;
    recordLifecycle?: boolean;
    updatePreference?: boolean;
  } = {},
): Promise<number> {
  const disabled = await withOptionalTransaction(db, async (client) => {
    const byUser = "userId" in selector;
    const value = byUser ? selector.userId : selector.telegramUserId;
    const needsUserId =
      options.updatePreference === true || options.blockLinkGeneration === true;
    const userId = byUser
      ? selector.userId
      : needsUserId
        ? (
            await client.query<{ user_id: string }>(
              `SELECT user_id
               FROM user_telegram_accounts
              WHERE telegram_user_id = $1
              LIMIT 1`,
              [selector.telegramUserId],
            )
          ).rows[0]?.user_id
        : undefined;
    if (userId && options.updatePreference) {
      await setTelegramBotTradingDesiredEnabled(client, {
        desiredEnabled: false,
        source: "manual_disable",
        userId,
      });
    }
    if (userId && options.blockLinkGeneration) {
      await ensureTelegramBotTradingPreferenceForLink(client, {
        isNewLink: false,
        userId,
      });
      await blockTelegramBotTradingLinkGeneration(client, userId);
    }
    const intentSelector = byUser
      ? `(user_id = $1 OR telegram_user_id IN (
           SELECT telegram_user_id
             FROM user_telegram_accounts
            WHERE user_id = $1
         ))`
      : "telegram_user_id = $1";
    const authorizationResult = await client.query<{
      enabled_venues: TelegramBotTradingVenue[];
      id: string;
      updated_at: Date | string;
      user_id: string;
      wallet_chain: TelegramBotTradingWalletChain;
    }>(
      `UPDATE telegram_bot_trading_authorizations
          SET enabled = false,
              disabled_at = COALESCE(disabled_at, now()),
              updated_at = now()
        WHERE ${byUser ? "user_id" : "telegram_user_id"} = $1
          AND enabled = true
      RETURNING id, user_id, wallet_chain, enabled_venues, updated_at`,
      [value],
    );
    await client.query(
      `UPDATE telegram_trade_intents
          SET status = 'cancelled',
              error_code = 'authorization_disabled',
              error_message = 'Telegram bot trading was disabled before submission.',
              updated_at = now()
        WHERE ${intentSelector}
          AND (
            status = ANY($2::text[])
            OR (status = 'executing' AND submit_started_at IS NULL)
          )`,
      [value, PENDING_INTENT_STATUSES],
    );
    return {
      count: authorizationResult.rowCount ?? 0,
      rows: authorizationResult.rows,
    };
  });
  if (options.recordLifecycle !== false) {
    await Promise.allSettled(
      disabled.rows.flatMap((authorization) =>
        authorization.enabled_venues.map((venue) =>
          recordTelegramLifecycleAnalytics({
            chain: resolveTelegramLifecycleChain(
              venue,
              authorization.wallet_chain,
            ),
            db,
            dedupeKey: `telegram-trading:${authorization.id}:disabled:${venue}:${new Date(authorization.updated_at).toISOString()}`,
            event: "hf_telegram_trading_lifecycle",
            source: "telegram_trading_settings",
            status: "disabled",
            userId: authorization.user_id,
            venue,
          }),
        ),
      ),
    );
  }
  return disabled.count;
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
  const enabledVenues =
    status.enabledVenues.length > 0
      ? status.enabledVenues
      : policy.tradingVenues;
  const actions = (["buy", "sell", "redeem"] as const)
    .filter((action) => status.actionStatuses[action].enabled)
    .map(
      (action) =>
        `${action.toUpperCase()} ${status.actionStatuses[action].ready ? "ready" : "not ready"}`,
    )
    .join(" · ");
  const walletValue =
    status.authorizations.length > 1
      ? escapeMarkdown(`${status.authorizations.length} wallets enabled`)
      : status.walletAddress
        ? formatTelegramCodeMarkdownV2(status.walletAddress)
        : escapeMarkdown("not selected");
  const venuesValue =
    enabledVenues.length > 0
      ? enabledVenues
          .map((venue) => formatTelegramVenueLabelMarkdownV2(venue))
          .join(escapeMarkdown(" · "))
      : escapeMarkdown("none enabled");
  const lines = [
    `🤖 ${formatTelegramBoldMarkdownV2("Telegram Trading Status")}`,
    "",
    `⚙️ ${formatTelegramFieldMarkdownV2(
      "Runtime policy",
      policy.tradingEnabled ? "Enabled" : "Disabled",
    )}`,
    `🔗 ${formatTelegramFieldMarkdownV2(
      "Linked account",
      status.linked ? "Yes" : "No",
    )}`,
    `🤖 ${formatTelegramFieldMarkdownV2(
      "Bot trading",
      status.enabled ? "Enabled" : "Disabled",
    )}`,
    `👛 ${formatTelegramFieldWithMarkdownV2("Wallet", walletValue)}`,
    `🌐 ${formatTelegramFieldWithMarkdownV2("Venues", venuesValue)}`,
    "",
    `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramFieldMarkdownV2(
      "Max buy",
      formatUsd(status.maxAmountUsd ?? policy.maxTradeAmountUsd),
    )}`,
    `⚡ ${formatTelegramFieldMarkdownV2(
      "Direct execution",
      status.directExecutionReady ? "Ready" : "Not ready",
    )}`,
    `🧰 ${formatTelegramFieldMarkdownV2("Actions", actions || "None enabled")}`,
  ];
  if (unresolvedIntentCount > 0) {
    lines.push(
      "",
      `⏳ ${formatTelegramFieldMarkdownV2(
        "Resolving trades",
        String(unresolvedIntentCount),
      )}`,
      ...resolvingIntents.map(
        (intent) =>
          `• ${escapeMarkdown(
            `${intent.action.toUpperCase()} · ${intent.marketTitle} · ${intent.ageMinutes}m`,
          )}`,
      ),
      "",
      `🤖 ${formatTelegramFieldMarkdownV2("User action required", "No")}`,
      formatTelegramItalicMarkdownV2(
        "The bot is checking these trades automatically.",
      ),
    );
  }
  if (status.setupIssue) {
    lines.push(
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: formatTelegramKnownNetworksInTextMarkdownV2(
          status.setupIssue,
        ),
        icon: "⚠️",
        title: "Setup needs attention",
      }),
    );
  }
  const richWalletValue: TelegramRichText =
    status.authorizations.length > 1
      ? telegramRichBold(`${status.authorizations.length} wallets enabled`)
      : status.walletAddress
        ? telegramRichCode(status.walletAddress)
        : "not selected";
  const richVenuesValue =
    enabledVenues.length > 0
      ? formatTelegramVenueListRichText(enabledVenues)
      : "none enabled";
  const richBlocks: TelegramInputRichMessage["blocks"] = [
    formatTelegramRichTitle("🤖", "Telegram Trading Status"),
    telegramRichMetricsTable({
      caption: telegramRichBold("Account & access"),
      rows: [
        {
          label: "Runtime policy",
          value: telegramRichBold(
            policy.tradingEnabled ? "Enabled" : "Disabled",
          ),
        },
        {
          label: "Linked account",
          value: telegramRichBold(status.linked ? "Yes" : "No"),
        },
        {
          label: "Bot trading",
          value: telegramRichBold(status.enabled ? "Enabled" : "Disabled"),
        },
        { label: "Wallet", value: richWalletValue },
        { label: "Venues", value: richVenuesValue },
        {
          label: "Max buy",
          value: telegramRichText(
            telegramCustomEmojiRichText("usdc"),
            " ",
            telegramRichBold(
              formatUsd(status.maxAmountUsd ?? policy.maxTradeAmountUsd),
            ),
          ),
        },
      ],
    }),
    telegramRichMetricsTable({
      caption: telegramRichBold("Execution"),
      rows: [
        {
          label: "Direct execution",
          value: telegramRichBold(
            status.directExecutionReady ? "Ready" : "Not ready",
          ),
        },
        ...(["buy", "sell", "redeem"] as const)
          .filter((action) => status.actionStatuses[action].enabled)
          .map((action) => ({
            label: action.toUpperCase(),
            value: telegramRichBold(
              status.actionStatuses[action].ready ? "Ready" : "Not ready",
            ),
          })),
        ...((["buy", "sell", "redeem"] as const).some(
          (action) => status.actionStatuses[action].enabled,
        )
          ? []
          : [
              {
                label: "Actions",
                value: telegramRichBold("None enabled"),
              },
            ]),
      ],
    }),
  ];
  if (status.authorizations.length > 1) {
    richBlocks.push(
      telegramRichDetails({
        blocks: [
          telegramRichMetricsTable({
            rows: status.authorizations.map((authorization) => ({
              label: telegramRichCode(authorization.walletAddress),
              value: telegramRichText(
                authorization.walletChain === "ethereum" ? "EVM" : "Solana",
                authorization.enabledVenues.length > 0 ? " · " : "",
                authorization.enabledVenues.length > 0
                  ? formatTelegramVenueListRichText(authorization.enabledVenues)
                  : null,
                " · ",
                telegramRichBold(
                  authorization.directExecutionReady
                    ? "Ready"
                    : authorization.enabled
                      ? "Not ready"
                      : "Disabled",
                ),
              ),
            })),
          }),
        ],
        summary: telegramRichBold(
          `${status.authorizations.length} trading wallets`,
        ),
      }),
    );
  }
  if (unresolvedIntentCount > 0) {
    richBlocks.push(
      telegramRichTable({
        caption: telegramRichText(
          "⏳ ",
          telegramRichBold(`Resolving trades (${unresolvedIntentCount})`),
        ),
        cells: [
          [
            telegramRichTableCell("Trade", { header: true }),
            telegramRichTableCell("Age", {
              align: "right",
              header: true,
            }),
          ],
          ...resolvingIntents.map((intent) => [
            telegramRichTableCell(
              telegramRichText(
                telegramRichBold(intent.action.toUpperCase()),
                " · ",
                intent.marketTitle,
              ),
            ),
            telegramRichTableCell(`${intent.ageMinutes}m`, {
              align: "right",
            }),
          ]),
        ],
      }),
      telegramRichFooter(
        telegramRichText(
          telegramRichBold("No action needed."),
          " The bot is checking these trades automatically.",
        ),
      ),
    );
  }
  if (status.setupIssue) {
    richBlocks.push(
      formatTelegramRichCallout({
        body: status.setupIssue,
        icon: "⚠️",
        title: "Setup needs attention",
      }),
    );
  }
  return {
    parse_mode: "MarkdownV2",
    richMessage: { blocks: richBlocks },
    text: joinTelegramMarkdownV2Lines(lines),
  };
}

export async function buildTelegramBotTradingMarketMessage(input: {
  appBaseUrl: string;
  chatId: string | number;
  context?: TelegramMarketCardContext;
  db: DbQuery;
  isAdminTest?: boolean;
  marketRef: string;
  publicBrowseOnly?: boolean;
  signerInspector?: TelegramBotTradingSignerInspector;
  telegramMessageId?: number | null;
  telegramMiniAppEnabled?: boolean;
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
      marketFound: false,
      parse_mode: "MarkdownV2",
      text: escapeMarkdown(
        "Market not found. Send /market <market_id or URL>.",
      ),
    };
  }

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
    status,
    trading: input.trading,
    venue: market.venue,
  });
  const focusedSide = input.context?.focusSide ?? null;
  const focusedPositionControlled = await (async () => {
    const wallet = input.context?.focusPositionWalletAddress?.trim();
    if (!wallet || !authorization || market.venue !== "polymarket") {
      return false;
    }
    const credentials = await AuthService.getVenueCredentialsInfo(
      authorization.user_id,
      "polymarket",
      authorization.wallet_address,
    ).catch(() => null);
    return credentials?.funderAddress?.toLowerCase() === wallet.toLowerCase();
  })();
  const nominalPresetAmountsUsd = resolveTelegramBuyPresetAmountsUsd(
    policy.buyAmountPresetsUsd,
    maxAmountUsd,
  );
  const minimumPresetAmountUsd = nominalPresetAmountsUsd[0] ?? null;
  const unresolvedIntent = await loadUnresolvedTelegramTradeIntent(input.db, {
    marketId: market.id,
    telegramUserId,
  });
  const canBuildBuyOptions =
    !input.isAdminTest &&
    !input.publicBrowseOnly &&
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
    canPreviewBuyForReadiness(tradeReadiness) &&
    nominalPresetAmountsUsd.length > 0 &&
    Boolean(input.trading);
  const buyOptions =
    canBuildBuyOptions &&
    authorization &&
    input.trading &&
    nominalPresetAmountsUsd.length > 0
      ? (
          await Promise.all(
            nominalPresetAmountsUsd.flatMap((nominalAmountUsd) =>
              (["YES", "NO"] as const)
                .filter((side) => !focusedSide || side === focusedSide)
                .map((side) =>
                  resolveTelegramExecutableBuyOption({
                    authorization,
                    market,
                    maxAmountUsd,
                    maxSlippageBps: policy.maxSlippageBps,
                    nominalAmountUsd,
                    side,
                    trading: input.trading as ApiBotTradingExecutor,
                  }),
                ),
            ),
          )
        ).filter(
          (option): option is TelegramExecutableBuyOption => option != null,
        )
      : [];
  const canBuildSellOptions =
    !input.isAdminTest &&
    !input.publicBrowseOnly &&
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
    (!input.context?.focusPositionId || focusedPositionControlled) &&
    Boolean(input.trading);
  const sellOptions =
    canBuildSellOptions && authorization && input.trading
      ? (
          await Promise.all(
            (["YES", "NO"] as const)
              .filter((side) => !focusedSide || side === focusedSide)
              .map((side) =>
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
    !input.publicBrowseOnly &&
    !unresolvedIntent &&
    automationAllowed &&
    redeemAllowed &&
    market.venue === "polymarket" &&
    policy.tradingEnabled &&
    policy.tradingActions.includes("redeem") &&
    policyVenueAllowed &&
    authorizationVenueAllowed &&
    authorization?.enabled === true &&
    authorization.privy_wallet_id &&
    (!input.context?.focusPositionId || focusedPositionControlled)
      ? await resolveTelegramPolymarketRedemptionPlan({
          authorization,
          market,
        }).catch(() => null)
      : null;
  const observedYesAsk = observedAsk(input.context?.observedYesAsk);
  const observedNoAsk = observedAsk(input.context?.observedNoAsk);
  const hasBotAction =
    buyOptions.length > 0 || sellOptions.length > 0 || Boolean(redeemPlan);
  const canTradeInHunch = marketOrderable && buyAllowed;
  const knownExecutableFundsUsd =
    tradeReadiness.maxExecutableBuyUsd != null &&
    Number.isFinite(tradeReadiness.maxExecutableBuyUsd) &&
    tradeReadiness.maxExecutableBuyUsd >= 0
      ? tradeReadiness.maxExecutableBuyUsd
      : hasInsufficientFundsReason(tradeReadiness)
        ? 0
        : null;
  const depositNeeded =
    !input.publicBrowseOnly &&
    status.linked &&
    marketOrderable &&
    (market.venue === "polymarket" || market.venue === "limitless") &&
    minimumPresetAmountUsd != null &&
    (hasInsufficientFundsReason(tradeReadiness) ||
      (knownExecutableFundsUsd != null &&
        knownExecutableFundsUsd + 0.000_001 < minimumPresetAmountUsd));
  const depositShortfallUsd =
    depositNeeded &&
    knownExecutableFundsUsd != null &&
    minimumPresetAmountUsd != null
      ? Math.max(0, minimumPresetAmountUsd - knownExecutableFundsUsd)
      : null;
  const marketIdentity = buildTelegramMarketIdentity({
    eventTitle: market.event_title,
    marketTitle: market.title,
  });
  const lines = [
    input.isAdminTest ? "Trade Card Preview" : "Trade This Market",
    "",
    ...marketIdentity.lines,
  ];
  if (input.context?.positionLines?.length) {
    lines.push("", ...input.context.positionLines);
  }
  lines.push("");
  const venueLineIndex = lines.length;
  lines.push(
    `${formatTelegramVenueLabel(market.venue)} · ${market.status}`,
    marketPriceLine(market),
  );
  const observedOdds = [
    observedYesAsk != null ? `YES ${formatLivePrice(observedYesAsk)}` : null,
    observedNoAsk != null ? `NO ${formatLivePrice(observedNoAsk)}` : null,
  ].filter((value): value is string => value != null);
  if (observedOdds.length > 0) {
    lines.push(`Current buy odds: ${observedOdds.join(" · ")}`);
  }
  const buyPriceSummary = (["YES", "NO"] as const)
    .map((side) => buyOptions.find((option) => option.side === side))
    .filter((option): option is TelegramExecutableBuyOption => option != null)
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
  if (buyOptions.length > 0) {
    lines.push("Choose side and amount to spend:");
  }
  if (input.isAdminTest) {
    lines.push("", "Preview only - trade buttons are not created.");
  } else if (unresolvedIntent) {
    lines.push("", EXISTING_TRADE_RESOLVING_MESSAGE);
  }
  const hunchFallbackCopy = canTradeInHunch
    ? "You can still trade in Hunch."
    : "Open the market in Hunch.";
  if (input.publicBrowseOnly) {
    lines.push(
      "",
      "Open Hunch to create an account or sign in. Enable Telegram Trading there if you want to trade from Telegram.",
    );
  } else if (!policy.tradingEnabled) {
    lines.push("", `Direct bot trading is unavailable. ${hunchFallbackCopy}`);
  } else if (!status.linked) {
    lines.push(
      "",
      `Link Telegram in Settings for direct bot trading. ${hunchFallbackCopy}`,
    );
  } else if (!marketOrderable && !redeemPlan) {
    lines.push("", "This market is not open for new bot trades.");
  } else if (!status.enabled) {
    lines.push(
      "",
      policy.tradingEnabled && policyVenueAllowed
        ? "Trade in Hunch now, or enable Telegram Trading for direct trades here."
        : policy.tradingEnabled
          ? "Trade this market in Hunch. You can also enable Telegram Trading for supported venues."
          : `Direct bot trading is disabled. ${hunchFallbackCopy}`,
    );
  } else if (!policyVenueAllowed) {
    lines.push(
      "",
      `Direct bot trading is not enabled for ${formatTelegramVenueLabel(market.venue)}. ${hunchFallbackCopy}`,
    );
  } else if (!authorizationVenueAllowed) {
    lines.push(
      "",
      policy.tradingEnabled && policyVenueAllowed
        ? "Trade in Hunch now, or enable this venue in Telegram Trading."
        : `This Trading Wallet is not enabled for direct bot trading on this venue. ${hunchFallbackCopy}`,
    );
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
  if (depositNeeded) {
    const venueLabel = formatTelegramVenueLabel(market.venue);
    lines.push(
      "",
      knownExecutableFundsUsd != null
        ? `${venueLabel} balance: ${formatUsd(knownExecutableFundsUsd)} available. ${
            depositShortfallUsd != null && depositShortfallUsd > 0
              ? `Deposit at least ${formatUsd(depositShortfallUsd)} before buying.`
              : "Deposit before buying."
          }`
        : `${venueLabel} balance is too low. Deposit before buying.`,
    );
  }
  if (buyOptions.length > 0 || sellOptions.length > 0 || redeemPlan) {
    lines.push("", `Buttons valid for ${formatTtl(policy.intentTtlSec)}.`);
  }
  if (input.telegramMiniAppEnabled !== true) {
    lines.push("", "Mini App temporarily unavailable.");
  }

  const keyboard: TelegramBotTradingButton[][] = [];
  for (const side of ["YES", "NO"] as const) {
    const row: TelegramBotTradingButton[] = [];
    for (const option of buyOptions.filter(
      (candidate) => candidate.side === side,
    )) {
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
      row.push({
        callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:buy:${intentId}`,
        text: `${formatUsd(option.amountUsd)} · ${sideLabel(market, option.side)}`,
      });
    }
    if (row.length > 0) keyboard.push(row);
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
        icon_custom_emoji_id: formatTelegramVenueButtonIcon(market.venue),
        text:
          input.context?.origin === "position"
            ? `Sell ${option.sellPercent}% · Receive ≥ ${formatUsd(option.minimumReceiveUsd)}`
            : `Sell ${option.sellPercent}% ${sideLabel(market, option.side)} · ${formatLivePrice(option.currentPrice) ?? "live"} · Receive ≥ ${formatUsd(option.minimumReceiveUsd)}`,
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
        icon_custom_emoji_id: telegramCustomEmojiId("usdc"),
        text: `Redeem · ≈ ${formatUsd(Number(payoutRaw) / 1_000_000)} pUSD`,
      },
    ]);
  }
  const miniAppMarketPath = openMarketUrl(input.appBaseUrl, market);
  const buildMiniAppButton = (buttonInput: {
    startParam: string | null;
    text: string;
  }): TelegramBotTradingButton | null =>
    buildHunchMiniAppWebButton({
      appBaseUrl: input.appBaseUrl,
      enabled: input.telegramMiniAppEnabled === true,
      path: miniAppMarketPath,
      startParam: buttonInput.startParam,
      text: buttonInput.text,
    });
  const pushMiniAppButton = (buttonInput: {
    startParam: string | null;
    text: string;
  }) => {
    const button = buildMiniAppButton(buttonInput);
    if (button) keyboard.push([button]);
  };
  const marketStartParam = market.event_id
    ? buildSignalBotMarketStartParam({
        eventId: market.event_id,
        marketId: market.id,
        side: focusedSide,
      })
    : null;
  const canOfferMiniAppBuy =
    !input.isAdminTest &&
    !input.publicBrowseOnly &&
    !unresolvedIntent &&
    !hasBotAction &&
    input.telegramMiniAppEnabled === true &&
    canTradeInHunch &&
    market.event_id != null;
  if (canOfferMiniAppBuy && market.event_id) {
    if (nominalPresetAmountsUsd.length > 0) {
      lines.push(
        "",
        nominalPresetAmountsUsd.length === 1
          ? `Trade amount in Hunch: ${formatUsd(nominalPresetAmountsUsd[0])}`
          : `Trade amounts in Hunch: ${nominalPresetAmountsUsd.map(formatUsd).join(" · ")}`,
      );
    }
    for (const side of (["YES", "NO"] as const).filter(
      (candidate) => !focusedSide || focusedSide === candidate,
    )) {
      const row: TelegramBotTradingButton[] = [];
      for (const amountUsd of nominalPresetAmountsUsd) {
        const startParam = buildSignalBotBuyStartParam({
          amountUsd,
          eventId: market.event_id,
          marketId: market.id,
          side,
        });
        if (!startParam) continue;
        const price = side === "YES" ? observedYesAsk : observedNoAsk;
        const button = buildMiniAppButton({
          startParam,
          text:
            nominalPresetAmountsUsd.length > 1
              ? `${formatUsd(amountUsd)} · ${side}`
              : `Buy ${side}${price != null ? ` · ${formatLivePrice(price)}` : ""}`,
        });
        if (button) row.push(button);
      }
      if (row.length > 0) keyboard.push(row);
    }
  }
  if (depositNeeded) {
    keyboard.push([
      {
        callback_data: `hm:v1:deposit:${market.venue}`,
        icon_custom_emoji_id: telegramCustomEmojiId("usdc"),
        text: `Deposit to ${formatTelegramVenueLabel(market.venue)}`,
      },
    ]);
  }
  const canOfferTelegramTradingSetup =
    !input.isAdminTest &&
    !input.publicBrowseOnly &&
    input.telegramMiniAppEnabled === true &&
    status.linked &&
    policy.tradingEnabled &&
    (!status.enabled || (policyVenueAllowed && !authorizationVenueAllowed));
  if (canOfferTelegramTradingSetup) {
    const enableTradingButton = buildHunchMiniAppWebButton({
      appBaseUrl: input.appBaseUrl,
      enabled: true,
      path: "/settings/telegram-trading",
      text: "Enable Telegram Trading",
    });
    if (enableTradingButton) keyboard.push([enableTradingButton]);
  }
  if (input.context?.origin === "position") {
    if (sellOptions.length === 0 && marketOrderable) {
      pushMiniAppButton({ startParam: marketStartParam, text: "Sell" });
    }
    if (
      !redeemPlan &&
      input.context.positionRedemptionStatus === "redeemable"
    ) {
      pushMiniAppButton({ startParam: marketStartParam, text: "Redeem" });
    }
  }
  pushMiniAppButton({
    startParam: marketStartParam,
    text: input.publicBrowseOnly
      ? "Open Hunch · Create or sign in"
      : !hasBotAction && canTradeInHunch
        ? "Trade in Hunch"
        : "Open market",
  });
  if (input.context?.returnCallbackData) {
    keyboard.push([
      { callback_data: input.context.returnCallbackData, text: "⬅️ Back" },
    ]);
  }

  const marketIdentityStartIndex = 2;
  const renderedLines = lines.map((line, index) => {
    if (index === 0) {
      return `${input.isAdminTest ? "🧪" : "🎯"} ${formatTelegramBoldMarkdownV2(
        line,
      )}`;
    }
    if (
      index >= marketIdentityStartIndex &&
      index < marketIdentityStartIndex + marketIdentity.lines.length
    ) {
      const label =
        marketIdentity.lines.length > 1 && index === marketIdentityStartIndex
          ? "Event"
          : "Market";
      return `${label === "Event" ? "🏆" : "🎯"} ${formatTelegramFieldMarkdownV2(
        label,
        line,
      )}`;
    }
    return formatTelegramMarketCardLineMarkdownV2(line);
  });
  renderedLines[venueLineIndex] =
    `${formatTelegramVenueFieldMarkdownV2(market.venue)} ${escapeMarkdown(
      "·",
    )} ${formatTelegramFieldMarkdownV2("Status", market.status)}`;

  return {
    marketFound: true,
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: keyboard },
    richMessage: buildTelegramMarketCardRichMessage({
      identityLines: marketIdentity.lines,
      lines,
      status: market.status,
      titleIcon: input.isAdminTest ? "🧪" : "🎯",
      venue: market.venue,
      venueLineIndex,
    }),
    text: joinTelegramMarkdownV2Lines(renderedLines),
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
     JOIN telegram_bot_trading_preferences p
       ON p.user_id = a.user_id
      AND p.desired_enabled = true
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
          return "⏳ Trade is already being processed.";
        case "reconcile_required":
          return `⏳ ${UNKNOWN_TRADE_RESOLVING_MESSAGE}`;
        case "expired":
          return "⚠️ These buttons expired. Send /market again.";
        case "failed":
          return intent.submit_started_at
            ? "⚠️ The submitted trade did not fill. Check /trade_status."
            : "⚠️ Trade failed before submission. Nothing was sent. Send /market again.";
        case "cancelled":
          return intent.error_message?.trim()
            ? `⚠️ Trade cancelled: ${intent.error_message.trim()}`
            : "✅ Trade was cancelled. Nothing was submitted.";
        case "submitted":
          return "✅ Trade was submitted. Check /trade_status for the result.";
        case "filled":
          return "✅ Trade already filled. Check /trade_status for details.";
        default:
          return "⚠️ This trade action is no longer active. Send /market again.";
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
      text: "⚠️ Redemption is not ready. Open Hunch Settings.",
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
      text: "⚠️ Position is no longer redeemable.",
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
      text: "👀 Review redemption…",
    });
    await callback.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            {
              callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:confirm:${intent.id}`,
              icon_custom_emoji_id: telegramCustomEmojiId("usdc"),
              text: "Confirm redeem",
            },
            {
              callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:cancel:${intent.id}`,
              text: "❌ Cancel",
            },
          ],
        ],
      },
      richMessage: {
        blocks: [
          formatTelegramRichTitle("♻️", "Confirm redemption"),
          telegramRichMetricsTable({
            caption: telegramRichBold("Redemption"),
            valueAlign: "right",
            rows: [
              {
                label: "Venue",
                value: formatTelegramVenueRichText("polymarket"),
              },
              { label: "Market", value: telegramRichBold(market.title) },
              {
                label: "YES balance",
                value: telegramRichBold(
                  `${ethers.formatUnits(plan.yesBalanceRaw ?? "0", 6)} shares`,
                ),
              },
              {
                label: "NO balance",
                value: telegramRichBold(
                  `${ethers.formatUnits(plan.noBalanceRaw ?? "0", 6)} shares`,
                ),
              },
              {
                label: "Expected payout",
                value: telegramRichText(
                  telegramCustomEmojiRichText("usdc"),
                  " ",
                  telegramRichBold(
                    `${formatUsd(
                      Number(plan.expectedPayoutRaw) / 1_000_000,
                    )} pUSD`,
                  ),
                ),
              },
            ],
          }),
          telegramRichParagraph(
            telegramRichText(
              "📍 ",
              telegramRichBold("Canonical deposit wallet"),
              "\n",
              credentials?.funderAddress
                ? telegramRichCode(credentials.funderAddress)
                : "Unavailable",
            ),
          ),
          formatTelegramRichCallout({
            body: "This is a real on-chain redemption. Confirm only if you want the bot to submit it now.",
            icon: "⚠️",
            title: "Real on-chain action",
          }),
        ],
      },
      text: joinTelegramMarkdownV2Lines([
        `♻️ ${formatTelegramBoldMarkdownV2("Confirm redemption")}`,
        "",
        formatTelegramVenueFieldMarkdownV2("polymarket"),
        `🎯 ${formatTelegramFieldMarkdownV2("Market", market.title)}`,
        `📈 ${formatTelegramFieldMarkdownV2(
          "YES balance",
          `${ethers.formatUnits(plan.yesBalanceRaw ?? "0", 6)} shares`,
        )}`,
        `📉 ${formatTelegramFieldMarkdownV2(
          "NO balance",
          `${ethers.formatUnits(plan.noBalanceRaw ?? "0", 6)} shares`,
        )}`,
        formatTelegramUsdcLineMarkdownV2(
          `Expected payout: ${formatUsd(Number(plan.expectedPayoutRaw) / 1_000_000)} pUSD`,
        ),
        "",
        `📍 ${formatTelegramBoldMarkdownV2("Canonical deposit wallet")}`,
        credentials?.funderAddress
          ? formatTelegramCodeMarkdownV2(credentials.funderAddress)
          : escapeMarkdown("Unavailable"),
        "",
        formatTelegramCalloutMarkdownV2({
          bodyMarkdownV2: escapeMarkdown(
            "This is a real on-chain redemption. Confirm only if you want the bot to submit it now.",
          ),
          icon: "⚠️",
          title: "Real on-chain action",
        }),
      ]),
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
    if (
      !(await isTelegramBotTradingAuthorizationEnabled(
        callback.db,
        authorization,
        "polymarket",
      ))
    ) {
      throw new Error(
        "Telegram bot trading was disabled before redemption signing.",
      );
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
    if (
      !(await isTelegramBotTradingAuthorizationEnabled(
        callback.db,
        authorization,
        "polymarket",
      ))
    ) {
      throw new Error(
        "Telegram bot trading was disabled before redemption submit.",
      );
    }
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
      text: [
        `✅ ${formatTelegramBoldMarkdownV2("Redemption confirmed")}`,
        "",
        formatTelegramVenueFieldMarkdownV2("polymarket"),
        `🎯 ${formatTelegramFieldMarkdownV2("Market", market.title)}`,
        formatTelegramUsdcLineMarkdownV2(
          `Received: ${formatUsd(Number(actualPayoutRaw) / 1_000_000)} pUSD`,
        ),
        txHash
          ? `🔗 ${formatTelegramFieldWithMarkdownV2(
              "Transaction",
              formatTelegramCodeMarkdownV2(txHash),
            )}`
          : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
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
      text: formatTelegramTradeLifecycleMessageMarkdownV2({
        heading:
          accepted && !definitiveFailure
            ? "Redemption is still resolving."
            : "Redemption failed before submission.",
        lines: [
          accepted && !definitiveFailure
            ? "The bot is checking automatically; do not retry this market."
            : "Nothing was sent.",
        ],
        marketTitle: market.title,
        venue: intent.venue,
      }),
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
      text: "⚠️ Trade action does not match this request.",
    });
    return true;
  }

  const senderId = callbackSenderId(input);
  if (!senderId) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "⚠️ Open a private chat with the bot first.",
    });
    return true;
  }

  const intent = await loadIntent(input.db, parsed.intentId);
  if (!intent) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "⚠️ Trade intent was not found.",
    });
    return true;
  }
  if (intent.telegram_user_id !== normalizeTelegramUserId(senderId)) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "⚠️ This trade button belongs to another Telegram user.",
    });
    return true;
  }
  if (
    ((parsed.type === "buy" || parsed.type === "retry_buy") &&
      intent.action !== "buy") ||
    (parsed.type === "sell" && intent.action !== "sell")
  ) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "⚠️ Trade action does not match this button.",
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
      text: "⚠️ Open the original private bot chat to use this trade button.",
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
      text: "⚠️ Trade intent expired. Send /market again.",
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
      text: "✅ Cancelled.",
    });
    await input.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      text: formatTelegramTradeLifecycleMessageMarkdownV2({
        heading: "Trade cancelled.",
        marketTitle: intent.market_title,
        venue: intent.venue,
      }),
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
      text: "⚠️ Market venue changed. Send /market again.",
    });
    return true;
  }
  if (intent.action === "redeem") {
    if (parsed.type !== "redeem" && parsed.type !== "confirm") {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "⚠️ Redemption action does not match this button.",
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
    (action === "BUY"
      ? !canPreviewBuyForReadiness(tradeReadiness)
      : !canOfferTradeForReadiness(tradeReadiness)) ||
    (action === "BUY" && (!amountUsd || amountUsd > maxAmountUsd)) ||
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
      text: "⚠️ Bot trading is not ready. Check /trade_status.",
    });
    if (market) {
      const openButton = buildTelegramTradingMiniAppButton({
        appBaseUrl: input.appBaseUrl,
        path: openMarketUrl(input.appBaseUrl, market),
        telegramMiniAppEnabled: input.telegramMiniAppEnabled,
        text: "Open in Hunch",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        ...(openButton
          ? { reply_markup: { inline_keyboard: [[openButton]] } }
          : {}),
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Direct bot trading is not ready.",
          lines: [
            tradeReadiness?.message ?? "Open Hunch to trade this market.",
          ],
          marketTitle: market.title,
          venue: intent.venue,
        }),
      });
    }
    return true;
  }
  if (
    parsed.type === "buy" ||
    parsed.type === "retry_buy" ||
    parsed.type === "sell"
  ) {
    const unresolvedIntent = await loadUnresolvedTelegramTradeIntent(input.db, {
      excludeIntentId: intent.id,
      marketId: intent.market_id,
      telegramUserId: intent.telegram_user_id,
    });
    if (unresolvedIntent) {
      const text = `⏳ ${EXISTING_TRADE_RESOLVING_MESSAGE}`;
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text,
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade is still resolving.",
          lines: [
            "The bot is checking the venue automatically; no action is needed. Check /trade_status before retrying.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
      });
      return true;
    }
    const trading = input.trading;
    if (!trading) {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "⚠️ Open Hunch to place this trade.",
      });
      return true;
    }
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      text: "⏳ Building a fresh quote…",
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
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Unable to build a safe current quote.",
          lines: ["Nothing was submitted. Send /market again."],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
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
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Price moved.",
          lines: ["Nothing was submitted. Send /market again."],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
      });
      return true;
    }
    if (
      action === "BUY" &&
      previewMaxSpendUsd != null &&
      previewMaxSpendUsd > maxAmountUsd
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
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade not submitted.",
          lines: [
            action === "BUY"
              ? `Maximum total spend ${formatUsd(previewMaxSpendUsd)} is no longer executable within your ${formatUsd(maxAmountUsd)} limit.`
              : "The confirmed sell quote is no longer executable.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
      });
      return true;
    }
    if (action === "BUY" && previewMaxSpendUsd != null) {
      const executableFundsUsd = Math.max(
        0,
        tradeReadiness?.maxExecutableBuyUsd ?? 0,
      );
      const controlledFundsUsd =
        readPolymarketControlledFundsUsd(tradeReadiness);
      const fundingPreview = resolveTelegramBuyFundingPreview({
        controlledFundsUsd,
        executableFundsUsd,
        requiredUsd: previewMaxSpendUsd,
      });
      const fundingState = fundingPreview.state;
      if (fundingState !== "ready") {
        await updateIntentStatus({
          allowedStatuses: ["draft", "previewed"],
          db: input.db,
          intentId: intent.id,
          quoteSnapshot: buildTelegramTradeQuotePreview(previewQuote),
          result: {
            fundingState,
            previewQuote,
            stage: "funding_preview",
          },
          status: "previewed",
        });
        if (intent.venue !== "polymarket") {
          const openButton = buildTelegramTradingMiniAppButton({
            appBaseUrl: input.appBaseUrl,
            path: openMarketUrl(input.appBaseUrl, market),
            telegramMiniAppEnabled: input.telegramMiniAppEnabled,
            text: "Open Hunch",
          });
          await input.sendMessage({
            chat_id: chatId,
            parse_mode: "MarkdownV2",
            ...(openButton
              ? { reply_markup: { inline_keyboard: [[openButton]] } }
              : {}),
            text: formatTelegramTradeLifecycleMessageMarkdownV2({
              heading: "More spendable funds required.",
              lines: ["Open Hunch to continue."],
              marketTitle: market.title,
              venue: intent.venue,
            }),
          });
          return true;
        }
        const depositResolution = await resolveCanonicalPolymarketDeposit({
          db: input.db,
          telegramUserId: intent.telegram_user_id,
        }).catch(() => ({
          address: null,
          reason: "rpc_unavailable" as const,
          status: "temporarily_unavailable" as const,
        }));
        await recordTelegramDepositResolutionAnalytics({
          db: input.db,
          reason: depositResolution.reason,
          source: "funding_preview",
          status: depositResolution.status,
          telegramUserId: intent.telegram_user_id,
          venue: "polymarket",
        }).catch(() => undefined);
        const depositPresentation =
          depositResolution.status === "ready"
            ? buildTelegramDepositAddressPresentation({
                address: depositResolution.address,
                venue: "polymarket",
              })
            : null;
        const depositUnavailableLine =
          depositResolution.status === "setup_required"
            ? "A Polymarket Trading Wallet must be set up in Hunch before this deposit can continue."
            : depositResolution.status === "temporarily_unavailable"
              ? "Deposit verification is temporarily unavailable. Try again shortly."
              : "The saved Polymarket deposit wallet could not be verified. Open Hunch to review Trading Wallet setup.";
        const marketUrl = openMarketUrl(input.appBaseUrl, market);
        const openMarketButton = buildTelegramTradingMiniAppButton({
          appBaseUrl: input.appBaseUrl,
          path: marketUrl,
          telegramMiniAppEnabled: input.telegramMiniAppEnabled,
          text: "Open market",
        });
        if (fundingState === "convert") {
          const convertUrl = new URL(marketUrl);
          convertUrl.searchParams.set("deposit", "convert");
          const convertButton = buildTelegramTradingMiniAppButton({
            appBaseUrl: input.appBaseUrl,
            path: convertUrl.toString(),
            telegramMiniAppEnabled: input.telegramMiniAppEnabled,
            text: "Convert",
          });
          await input.sendMessage({
            chat_id: chatId,
            parse_mode: "MarkdownV2",
            reply_markup: {
              inline_keyboard: [
                ...telegramTradingButtonRows(convertButton),
                ...(depositPresentation?.buttonRows ?? []),
                [
                  {
                    callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:retry_buy:${intent.id}`,
                    text: "🔄 Check balance & continue",
                  },
                ],
                ...telegramTradingButtonRows(openMarketButton),
              ],
            },
            richMessage: {
              blocks: [
                formatTelegramRichTitle("🔄", "Convert to continue"),
                telegramRichMetricsTable({
                  caption: telegramRichBold("Order"),
                  valueAlign: "right",
                  rows: [
                    {
                      label: "Venue",
                      value: formatTelegramVenueRichText(intent.venue),
                    },
                    {
                      label: "Market",
                      value: telegramRichBold(
                        `${market.title} · ${sideLabel(market, side)}`,
                      ),
                    },
                    {
                      label: "Maximum spend",
                      value: telegramRichText(
                        telegramCustomEmojiRichText("usdc"),
                        " ",
                        telegramRichBold(formatUsd(previewMaxSpendUsd)),
                      ),
                    },
                    {
                      label: "Ready now",
                      value: telegramRichText(
                        telegramCustomEmojiRichText("usdc"),
                        " ",
                        telegramRichBold(formatUsd(executableFundsUsd)),
                      ),
                    },
                  ],
                }),
                formatTelegramRichCallout({
                  body: telegramRichText(
                    "You have supported funds, but they need ",
                    telegramRichBold("conversion in Hunch"),
                    " before this order can be confirmed.",
                  ),
                  icon: "ℹ️",
                  marked: false,
                  title: "Why conversion is needed",
                }),
                ...(depositPresentation
                  ? [
                      telegramRichParagraph(
                        telegramRichText(
                          "📥 ",
                          telegramRichBold("Deposit instead"),
                        ),
                      ),
                      ...depositPresentation.richBlocks,
                    ]
                  : []),
              ],
            },
            text: joinTelegramMarkdownV2Lines([
              `🔄 ${formatTelegramBoldMarkdownV2("Convert to continue")}`,
              "",
              formatTelegramVenueFieldMarkdownV2(intent.venue),
              `🎯 ${formatTelegramFieldMarkdownV2(
                "Market",
                `${market.title} · ${sideLabel(market, side)}`,
              )}`,
              formatTelegramUsdcLineMarkdownV2(
                `Maximum spend: ${formatUsd(previewMaxSpendUsd)}`,
              ),
              formatTelegramUsdcLineMarkdownV2(
                `Ready now: ${formatUsd(executableFundsUsd)}`,
              ),
              "",
              formatTelegramCalloutMarkdownV2({
                bodyMarkdownV2: `${escapeMarkdown(
                  "You have supported funds, but they need ",
                )}${formatTelegramBoldMarkdownV2(
                  "conversion in Hunch",
                )}${escapeMarkdown(" before this order can be confirmed.")}`,
                icon: "ℹ️",
                title: "Why conversion is needed",
              }),
              ...(depositPresentation
                ? [
                    "",
                    `📥 ${formatTelegramBoldMarkdownV2("Deposit instead")}`,
                    ...depositPresentation.markdownV2Lines,
                  ]
                : []),
            ]),
          });
          return true;
        }
        await input.sendMessage({
          chat_id: chatId,
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [
              ...(depositPresentation?.buttonRows ?? []),
              [
                {
                  callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:retry_buy:${intent.id}`,
                  text: "🔄 Check balance & continue",
                },
              ],
              ...telegramTradingButtonRows(openMarketButton),
            ],
          },
          richMessage: {
            blocks: [
              formatTelegramRichTitle(
                telegramCustomEmojiRichText("usdc"),
                "Deposit to continue",
              ),
              telegramRichMetricsTable({
                caption: telegramRichBold("Order"),
                valueAlign: "right",
                rows: [
                  {
                    label: "Venue",
                    value: formatTelegramVenueRichText(intent.venue),
                  },
                  {
                    label: "Market",
                    value: telegramRichBold(
                      `${market.title} · ${sideLabel(market, side)}`,
                    ),
                  },
                  {
                    label: "Order",
                    value: telegramRichBold(formatUsd(amountUsd ?? 0)),
                  },
                  {
                    label: "Maximum spend",
                    value: telegramRichBold(formatUsd(previewMaxSpendUsd)),
                  },
                ],
              }),
              telegramRichMetricsTable({
                caption: telegramRichBold("Funding required"),
                valueAlign: "right",
                rows: [
                  {
                    label: "Available",
                    value: telegramRichBold(
                      formatUsd(fundingPreview.availableUsd),
                    ),
                  },
                  {
                    label: "Add at least",
                    value: telegramRichMarked(
                      telegramRichText(
                        telegramCustomEmojiRichText("usdc"),
                        " ",
                        telegramRichBold(
                          formatUsd(fundingPreview.shortfallUsd),
                        ),
                      ),
                    ),
                  },
                ],
              }),
              ...(depositPresentation?.richBlocks ?? [
                formatTelegramRichCallout({
                  body: depositUnavailableLine,
                  icon: "⚠️",
                  title: "Deposit address unavailable",
                }),
              ]),
            ],
          },
          text: joinTelegramMarkdownV2Lines([
            `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramBoldMarkdownV2(
              "Deposit to continue",
            )}`,
            "",
            formatTelegramVenueFieldMarkdownV2(intent.venue),
            `🎯 ${formatTelegramFieldMarkdownV2(
              "Market",
              `${market.title} · ${sideLabel(market, side)}`,
            )}`,
            formatTelegramUsdcLineMarkdownV2(
              `Order: ${formatUsd(amountUsd ?? 0)}`,
            ),
            formatTelegramUsdcLineMarkdownV2(
              `Maximum spend: ${formatUsd(previewMaxSpendUsd)}`,
            ),
            "",
            `💰 ${formatTelegramBoldMarkdownV2("Funding required")}`,
            formatTelegramUsdcLineMarkdownV2(
              `Available: ${formatUsd(fundingPreview.availableUsd)}`,
            ),
            formatTelegramUsdcLineMarkdownV2(
              `Add at least: ${formatUsd(fundingPreview.shortfallUsd)}`,
            ),
            "",
            ...(depositPresentation?.markdownV2Lines ?? [
              formatTelegramCalloutMarkdownV2({
                bodyMarkdownV2: escapeMarkdown(depositUnavailableLine),
                icon: "⚠️",
                title: "Deposit address unavailable",
              }),
            ]),
          ]),
        });
        return true;
      }
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
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade state changed while loading the quote.",
          lines: ["Send /market again."],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
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
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade is still resolving.",
          lines: [
            "The bot is checking the venue automatically; no action is needed. Check /trade_status before retrying.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
      });
      return true;
    }
    if (confirming !== "confirmed") {
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade state changed while opening confirmation.",
          lines: ["Check /trade_status before trying again."],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
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
              icon_custom_emoji_id: formatTelegramVenueButtonIcon(intent.venue),
              text: action === "BUY" ? "Confirm buy" : "Confirm sell",
            },
            {
              callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:cancel:${intent.id}`,
              text: "❌ Cancel",
            },
          ],
        ],
      },
      richMessage: {
        blocks: [
          formatTelegramRichTitle(
            action === "BUY" ? "🟢" : "🔴",
            action === "BUY" ? "Confirm buy" : "Confirm sell",
          ),
          telegramRichParagraph(
            telegramRichText(
              "👛 ",
              telegramRichBold("Internal wallet"),
              "\n",
              telegramRichCode(authorization.wallet_address),
            ),
          ),
          telegramRichMetricsTable({
            caption: telegramRichBold("Order details"),
            valueAlign: "right",
            rows: [
              {
                label: "Venue",
                value: formatTelegramVenueRichText(intent.venue),
              },
              {
                label: "Market",
                value: telegramRichBold(intent.market_title),
              },
              { label: "Side", value: telegramRichBold(side) },
              {
                label: action === "BUY" ? "Current ask" : "Current bid",
                value: telegramRichBold(
                  formatTelegramQuotePrice(previewQuote.currentPrice ?? null),
                ),
              },
              ...(action === "BUY"
                ? [
                    {
                      label: "Maximum execution price",
                      value: telegramRichBold(
                        formatTelegramQuotePrice(previewQuote.price),
                      ),
                    },
                    {
                      label: "Nominal order",
                      value: telegramRichText(
                        telegramCustomEmojiRichText("usdc"),
                        " ",
                        telegramRichBold(formatUsd(amountUsd ?? 0)),
                      ),
                    },
                  ]
                : [
                    {
                      label: "Exact quantity",
                      value: telegramRichBold(
                        `${tradeAmountLabel} (${sellPercent}%)`,
                      ),
                    },
                  ]),
              ...(action === "SELL"
                ? [
                    {
                      label: "Minimum pUSD receive",
                      value: telegramRichText(
                        telegramCustomEmojiRichText("usdc"),
                        " ",
                        telegramRichBold(
                          formatUsd(previewQuote.minimumReceiveUsd ?? 0),
                        ),
                      ),
                    },
                    {
                      label: "Minimum execution price",
                      value: telegramRichBold(
                        formatTelegramQuotePrice(previewQuote.price),
                      ),
                    },
                  ]
                : previewQuote.minReceiveShares == null
                  ? []
                  : [
                      {
                        label: "Minimum estimated shares",
                        value: telegramRichBold(
                          previewQuote.minReceiveShares.toFixed(2),
                        ),
                      },
                    ]),
              ...(action === "BUY"
                ? [
                    {
                      label: "Maximum total spend",
                      value: telegramRichText(
                        telegramCustomEmojiRichText("usdc"),
                        " ",
                        telegramRichBold(formatUsd(previewMaxSpendUsd ?? 0)),
                      ),
                    },
                  ]
                : []),
              {
                label: "Price tolerance",
                value: telegramRichBold(`${policy.maxSlippageBps / 100}%`),
              },
              {
                label: "Possible setup",
                value: telegramRichBold(
                  tradeReadiness?.repair?.kind === "auto"
                    ? tradeReadiness.repair.message
                    : "None",
                ),
              },
              ...(formatQuoteTtl(previewQuote.expiresAt)
                ? [
                    {
                      label: "Quote validity",
                      value: telegramRichBold(
                        `About ${formatQuoteTtl(previewQuote.expiresAt)}`,
                      ),
                    },
                  ]
                : []),
            ],
          }),
          formatTelegramRichCallout({
            body: "This is a real trade. Confirm only if you want the bot to submit it now.",
            icon: "⚠️",
            title: "Real trade",
          }),
        ],
      },
      text: joinTelegramMarkdownV2Lines(
        [
          `${action === "BUY" ? "🟢" : "🔴"} ${formatTelegramBoldMarkdownV2(
            action === "BUY" ? "Confirm buy" : "Confirm sell",
          )}`,
          "",
          formatTelegramVenueFieldMarkdownV2(intent.venue),
          `🎯 ${formatTelegramFieldMarkdownV2("Market", intent.market_title)}`,
          `↔️ ${formatTelegramFieldMarkdownV2("Side", side)}`,
          "",
          `👛 ${formatTelegramBoldMarkdownV2("Internal wallet")}`,
          formatTelegramCodeMarkdownV2(authorization.wallet_address),
          "",
          `📊 ${formatTelegramFieldMarkdownV2(
            action === "BUY" ? "Current ask" : "Current bid",
            formatTelegramQuotePrice(previewQuote.currentPrice ?? null),
          )}`,
          action === "BUY"
            ? `📈 ${formatTelegramFieldMarkdownV2(
                "Maximum execution price",
                formatTelegramQuotePrice(previewQuote.price),
              )}`
            : null,
          action === "BUY"
            ? formatTelegramUsdcLineMarkdownV2(
                `Nominal order: ${formatUsd(amountUsd ?? 0)}`,
              )
            : `📦 ${formatTelegramFieldMarkdownV2(
                "Exact quantity",
                `${tradeAmountLabel} (${sellPercent}%)`,
              )}`,
          action === "SELL"
            ? formatTelegramUsdcLineMarkdownV2(
                `Minimum pUSD receive: ${formatUsd(previewQuote.minimumReceiveUsd ?? 0)}`,
              )
            : previewQuote.minReceiveShares == null
              ? null
              : `📦 ${formatTelegramFieldMarkdownV2(
                  "Minimum estimated shares",
                  previewQuote.minReceiveShares.toFixed(2),
                )}`,
          action === "BUY"
            ? formatTelegramUsdcLineMarkdownV2(
                `Maximum total spend: ${formatUsd(previewMaxSpendUsd ?? 0)}`,
              )
            : `📉 ${formatTelegramFieldMarkdownV2(
                "Minimum execution price",
                formatTelegramQuotePrice(previewQuote.price),
              )}`,
          `🎚️ ${formatTelegramFieldMarkdownV2(
            "Price tolerance",
            `${policy.maxSlippageBps / 100}%`,
          )}`,
          `⚙️ ${formatTelegramFieldMarkdownV2(
            "Possible setup",
            tradeReadiness?.repair?.kind === "auto"
              ? tradeReadiness.repair.message
              : "None",
          )}`,
          formatQuoteTtl(previewQuote.expiresAt)
            ? `⏱️ ${formatTelegramFieldMarkdownV2(
                "Quote validity",
                `About ${formatQuoteTtl(previewQuote.expiresAt)}`,
              )}`
            : null,
          "",
          formatTelegramCalloutMarkdownV2({
            bodyMarkdownV2: escapeMarkdown(
              "This is a real trade. Confirm only if you want the bot to submit it now.",
            ),
            icon: "⚠️",
            title: "Real trade",
          }),
        ].filter((line): line is string => line != null),
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
      text: "⚠️ Open Hunch to place this trade.",
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
          text: "⚠️ Trading setup needs attention. Open Hunch to continue.",
        });
        const openButton = buildTelegramTradingMiniAppButton({
          appBaseUrl: input.appBaseUrl,
          path: openMarketUrl(input.appBaseUrl, market),
          telegramMiniAppEnabled: input.telegramMiniAppEnabled,
          text: "Open in Hunch",
        });
        await input.sendMessage({
          chat_id: chatId,
          parse_mode: "MarkdownV2",
          ...(openButton
            ? { reply_markup: { inline_keyboard: [[openButton]] } }
            : {}),
          text: formatTelegramTradeLifecycleMessageMarkdownV2({
            heading: "Trading setup needs attention.",
            lines: [message],
            marketTitle: intent.market_title,
            venue: intent.venue,
          }),
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
        text: "⚠️ Trading was disabled. Nothing was submitted.",
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
          text: "⚠️ Bot access is not ready. Open Hunch Settings.",
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
        text: "⚠️ Price moved. Send /market again.",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade not submitted.",
          lines: [
            `${action} ${side} · ${tradeAmountLabel}`,
            action === "BUY"
              ? `Maximum total spend is ${formatUsd(quoteMaxSpendUsd ?? 0)}; the order is no longer executable within your ${formatUsd(maxAmountUsd)} limit.`
              : "The sell is no longer executable at the confirmed minimum price.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
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
        text: "⚠️ Price moved. Review a new quote before trading.",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade not submitted.",
          lines: [
            "The quote moved beyond your confirmed tolerance.",
            "Nothing was submitted. Send /market again for a new preview.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
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
        text: "⚠️ Trade intent is no longer active. Send /market again.",
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
        text: "⚠️ Trade status changed while recording. Check /trade_status before retrying.",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade status changed while recording.",
          lines: [
            currentIntent?.status
              ? `Current bot status: ${currentIntent.status}`
              : null,
            "Check /trade_status before retrying.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
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
        ? `⚠️ ${resolution.callbackText} Recording needs review.`
        : `${
            resolution.intentStatus === "filled"
              ? "✅"
              : resolution.intentStatus === "submitted"
                ? "⏳"
                : "⚠️"
          } ${resolution.callbackText}`,
    });
    await input.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      text: formatTelegramTradeLifecycleMessageMarkdownV2({
        heading: resolution.messageTitle,
        lines: [
          `${action} ${side} · ${tradeAmountLabel}`,
          venueOrderId ? `Order: ${venueOrderId}` : null,
          postSubmitError
            ? "Venue accepted the submit, but Hunch could not finish local recording. Check the app before retrying."
            : null,
        ],
        marketTitle: intent.market_title,
        venue: intent.venue,
      }),
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
        text: "⚠️ Trade submitted. Recording needs review.",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade submitted.",
          lines: [
            `${action} ${side} · ${tradeAmountLabel}`,
            submitted.venueOrderId ? `Order: ${submitted.venueOrderId}` : null,
            "Hunch could not finish local recording. Check the app before retrying.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
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
        text: `⏳ ${unknownMessage}`,
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade status is unknown.",
          lines: [
            `${action} ${side} · ${tradeAmountLabel}`,
            "The bot is checking the venue automatically; no action is needed. Check /trade_status before retrying.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
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
        text: `⏳ ${unknownMessage}`,
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Funding status is still resolving.",
          lines: [
            "The bot is checking automatically. /trade_status will clear this trade after confirmation or revert; do not retry yet.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
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
        ? "⚠️ Trade rejected. Nothing was submitted."
        : normalized.code === "unsupported_capability"
          ? "⚠️ Open Hunch to place this trade."
          : "⚠️ Trade failed. Check the bot message.",
    });
    const url = new URL(
      `/events/${encodeURIComponent(intent.event_id ?? "")}`,
      `${normalizeBaseUrl(input.appBaseUrl)}/`,
    );
    url.searchParams.set("market", intent.market_id);
    const openButton = buildTelegramTradingMiniAppButton({
      appBaseUrl: input.appBaseUrl,
      path: url.toString(),
      telegramMiniAppEnabled: input.telegramMiniAppEnabled,
      text: "Open in Hunch",
    });
    await input.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      ...(openButton
        ? { reply_markup: { inline_keyboard: [[openButton]] } }
        : {}),
      text: formatTelegramTradeLifecycleMessageMarkdownV2({
        heading: definitiveSubmitRejection
          ? "Trade rejected."
          : "Trade failed.",
        lines: [
          definitiveSubmitRejection
            ? "Nothing was submitted. Refresh the market card before trying again."
            : normalized.code === "unsupported_capability"
              ? "This venue is not executable from the bot yet. Open Hunch to trade."
              : "Trade failed before a confirmed venue submission. Nothing is being retried automatically.",
        ],
        marketTitle: intent.market_title,
        venue: intent.venue,
      }),
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
  telegramMiniAppEnabled?: boolean;
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
    telegramMiniAppEnabled: input.telegramMiniAppEnabled,
    trading: input.trading,
  });
  return { answers, handled, messages };
}
