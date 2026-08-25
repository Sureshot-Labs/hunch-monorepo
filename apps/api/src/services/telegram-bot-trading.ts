import crypto from "node:crypto";
import { ethers } from "ethers";

import { AuthService } from "../auth.js";
import type { Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import {
  isKnownNativeSolAsset,
  resolveKnownAccountAssetSymbol,
} from "../account-value/known-asset-catalog.js";
import {
  compareUnsignedDecimals,
  unitPriceFromRawEstimate,
} from "../account-value/decimal.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { sameAccountAddress } from "../funding/domain/asset-identity.js";
import { SOLANA_NATIVE_ASSET } from "../funding/domain/network-fees.js";
import { isRawAmount } from "../funding/domain/raw-amount.js";
import {
  isTelegramPolymarketRouterContinuationPending,
  telegramPolymarketRootRequiresRouterContinuationSql,
} from "../funding/reconciliation/telegram-router-continuation-state.js";
import { lockTelegramFundingLinkLifecycle } from "../funding/execution/telegram-funding-link-lifecycle-lock.js";
import { isTelegramFundingManagedSolanaWalletCurrent } from "../funding/execution/telegram-funding-managed-wallet.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { canonicalWalletIdentity } from "../lib/wallet-address.js";
import {
  findTradeMarketById,
  findTradeMarketByRef,
  isOrderable,
  type ApiTradeMarket,
  venueLocalMarketContextId,
} from "./api-trading-market-repo.js";
import {
  resolveSignalBotTradingPolicyFromDb,
  resolveSignalBotTradingPolicyStateFromDb,
  type TelegramMiniAppHandoffMode,
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
  type TelegramBotTradingClientReplyMarkup,
} from "./telegram-bot-trading-client.js";
import {
  fenceTelegramTradeLifecycleNavigation,
  isTelegramTradeLifecycleDeliveryEligible,
} from "./telegram-trade-delivery-contract.js";
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
  waitForPolymarketRelayerTransaction,
} from "./polymarket-deposit-wallet-relayer.js";
import { sumErc20TransfersTo } from "../funding/execution/evm-erc20-receipt.js";
import type { JsonObject } from "../funding/domain/types.js";
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
import type {
  TelegramTradeShortfallIdentity,
  TelegramTradeShortfallInspection,
  TelegramTradeShortfallProposal,
  TelegramTradeMiniAppFundingInspection,
} from "./telegram-trade-shortfall-funding.js";
import { TelegramTradeShortfallCommitError } from "./telegram-trade-shortfall-funding.js";
import {
  buildTelegramAppHandoffV2DirectTradePlan,
  isTelegramAppHandoffV2Plan,
  type TelegramAppHandoffV2Plan,
} from "./telegram-app-handoff-v2.js";

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
  formatTelegramTextWithCommandsMarkdownV2,
  joinTelegramMarkdownV2Lines,
  formatTelegramLivePrice as formatLivePrice,
  formatTelegramQuotePrice,
  formatTelegramQuoteTtl as formatQuoteTtl,
  formatTelegramTtl as formatTtl,
} from "./telegram-bot-trading-presentation.js";
import {
  buildHunchMiniAppDeepLinkButton,
  buildHunchMiniAppWebButton,
} from "./telegram-mini-app-buttons.js";
import {
  buildTelegramAppHandoffStartParamForIntent,
  claimTelegramAppHandoff,
  expireStaleTelegramAppHandoffs,
  issueTelegramAppHandoff,
  TelegramAppHandoffError,
} from "./telegram-app-handoff.js";
import {
  recordTelegramLifecycleAnalytics,
  resolveTelegramLifecycleChain,
} from "./telegram-lifecycle-analytics.js";
import {
  buildTelegramMarketIdentity,
  formatTelegramVenueButtonIcon,
  formatTelegramVenueLabel,
  formatTelegramVenueLabelMarkdownV2,
} from "./telegram-market-identity.js";
import { formatTelegramAccountValueUsd } from "./telegram-account-value.js";
import {
  telegramCustomEmojiId,
  telegramCustomEmojiMarkdownV2,
  telegramCustomEmojiMarkdownV2ForNetwork,
  telegramCustomEmojiMarkdownV2ForVenue,
} from "./telegram-custom-emoji.js";
import {
  buildSignalBotBuyStartParam,
  buildSignalBotMarketStartParam,
} from "./signal-bot-mini-app-links.js";
import { outcomeLabelOrSide } from "./wallet-intel-helpers.js";
import { resolvePolymarketAvailablePositionRaw } from "./polymarket-trading-execution-service.js";
import { resolveLimitlessAvailablePositionRaw } from "./limitless-trading-execution-service.js";
import {
  buildRedemptionNotification,
  createNotificationSafe,
} from "./notifications.js";
import { venueLifecycleAllows } from "./venue-lifecycle.js";
import {
  parseTelegramBotTradeAuthorityBinding,
  telegramBotTradeAuthorityFingerprint,
  type TelegramBotTradeAuthorityBinding,
  type TelegramBotTradeInputContext,
} from "./telegram-bot-trade-input-context.js";
import {
  buildTelegramFundingChangeBuyAmountButton,
  buildTelegramFundingReviewBuyButton,
  fetchActiveTelegramFundingBuyReturn,
  fetchTelegramFundingBuyContinuationForUpdate,
  hasReadyTelegramFundingDestinationReceipt,
  hashTelegramFundingBuyContinuationToken,
  issueTelegramFundingBuyContinuation,
  resolveTelegramFundingBuyContinuationAdapter,
} from "./telegram-funding-buy-continuation.js";
import {
  canContinueTelegramFundingBuyReturn,
  type TelegramFundingProgressDecorator,
} from "./telegram-funding.js";
import { isTelegramFundingReadyTerminalProjection } from "./telegram-funding-progress.js";
import { isTelegramSolanaRetainedFundingRouteKey } from "./telegram-funding-route.js";
import {
  isTelegramAppHandoffV2EnabledForVenue,
  isTelegramAppHandoffV2DirectTradeVenue,
  isTelegramAppHandoffV2TradeVenue,
  type TelegramAppHandoffV2TradeVenue,
} from "./telegram-app-handoff-v2-contract.js";

export type TelegramBotTradingVenue = "kalshi" | "limitless" | "polymarket";
export type TelegramBotTradingAction = "buy" | "sell" | "redeem";
export type TelegramBotTradingSide = "NO" | "YES";
export type TelegramBotTradingWalletChain = "ethereum" | "solana";
/**
 * How a Telegram Buy intent is delivered after its exact plan is known.
 *
 * `app_handoff` is the sealed Telegram → Mini App trade handoff. It is not
 * the funding-domain `external_handoff` action, which asks a client wallet to
 * perform one funding action. `direct_deposit_only` is a receive-address flow,
 * not an executable trade plan.
 */
export type TelegramBuyDeliveryMode =
  /** A sealed, one-time Mini App handoff will continue this exact intent. */
  | "app_handoff"
  /** The bot's delegated server executor may submit this exact Buy itself. */
  | "bot_submit"
  /** No exact executor is available; offer a normal Deposit instead. */
  | "direct_deposit_only";

/**
 * Consent to a sealed Mini App handoff and an executor's ability to finish it
 * are separate facts. Polymarket supports both execution surfaces; Limitless
 * currently supports only the sealed EVM handoff.
 */
export type TelegramBuyExecutionCapability = Readonly<{
  /** The v2 Mini App destination consumer supports this venue and chain. */
  sealedAppHandoffExact: boolean;
  /** The Telegram server has a narrowly authorized exact Buy executor. */
  serverBotExact: boolean;
}>;

/**
 * One resolver owns delivery selection for both actions.  The legacy Buy
 * export below remains as a compatibility wrapper for existing callers and
 * snapshots; `direct_deposit_only` means "open Hunch" for Sell because a
 * Sell never has an external-deposit fallback.
 */
export type TelegramTradeExecutionCapability = TelegramBuyExecutionCapability;

export function resolveTelegramTradeExecutionCapability(
  input: Readonly<{
    action: "buy" | "sell";
    venue: TelegramBotTradingVenue;
    walletChain: TelegramBotTradingWalletChain | null;
  }>,
): TelegramTradeExecutionCapability {
  if (input.walletChain !== "ethereum") {
    return { sealedAppHandoffExact: false, serverBotExact: false };
  }
  if (input.venue === "polymarket") {
    return { sealedAppHandoffExact: true, serverBotExact: true };
  }
  if (input.venue === "limitless") {
    return { sealedAppHandoffExact: true, serverBotExact: false };
  }
  return { sealedAppHandoffExact: false, serverBotExact: false };
}

export function resolveTelegramBuyExecutionCapability(
  input: Readonly<{
    venue: TelegramBotTradingVenue;
    walletChain: TelegramBotTradingWalletChain | null;
  }>,
): TelegramBuyExecutionCapability {
  return resolveTelegramTradeExecutionCapability({ ...input, action: "buy" });
}

export function isTelegramSealedAppHandoffVenue(
  venue: TelegramBotTradingVenue,
): boolean {
  return resolveTelegramBuyExecutionCapability({
    venue,
    walletChain: "ethereum",
  }).sealedAppHandoffExact;
}

/**
 * v2's trade destination contract is broader than the legacy v1 callback
 * replay. Funding sources may be EVM, composite, or Solana; this predicate is
 * intentionally about the destination consumer only. A concrete v2 plan is
 * still admitted solely after generic funding planning validates its sources,
 * controller binding, and supported action surface.
 */
export { isTelegramAppHandoffV2TradeVenue };

export function resolveTelegramBuyDeliveryMode(
  input: Readonly<{
    capability: TelegramBuyExecutionCapability;
    commonBuySurfaceReady: boolean;
    handoffContractAvailable: boolean;
    miniAppHandoffMode: TelegramMiniAppHandoffMode;
    telegramMiniAppEnabled: boolean;
    venueAllowedForBotSubmit: boolean;
  }>,
): TelegramBuyDeliveryMode {
  return resolveTelegramTradeDeliveryMode({
    ...input,
    action: "buy",
    commonTradeSurfaceReady: input.commonBuySurfaceReady,
  });
}

export function resolveTelegramTradeDeliveryMode(
  input: Readonly<{
    action: "buy" | "sell";
    capability: TelegramTradeExecutionCapability;
    commonTradeSurfaceReady: boolean;
    handoffContractAvailable: boolean;
    miniAppHandoffMode: TelegramMiniAppHandoffMode;
    telegramMiniAppEnabled: boolean;
    venueAllowedForBotSubmit: boolean;
  }>,
): TelegramBuyDeliveryMode {
  if (!input.commonTradeSurfaceReady) return "direct_deposit_only";
  const canHandoff =
    input.telegramMiniAppEnabled &&
    input.handoffContractAvailable &&
    input.miniAppHandoffMode !== "off" &&
    input.capability.sealedAppHandoffExact;
  const canBotSubmit =
    input.capability.serverBotExact && input.venueAllowedForBotSubmit;
  if (input.miniAppHandoffMode === "always") {
    return canHandoff
      ? "app_handoff"
      : canBotSubmit
        ? "bot_submit"
        : "direct_deposit_only";
  }
  if (canBotSubmit) return "bot_submit";
  if (input.miniAppHandoffMode === "fallback" && canHandoff) {
    return "app_handoff";
  }
  return "direct_deposit_only";
}
type StoredTelegramBuyDeliveryMode = Exclude<
  TelegramBuyDeliveryMode,
  "direct_deposit_only"
>;

/**
 * A sealed v2 plan is produced by the initial app-handoff preview itself.
 * Requiring it on a new draft would therefore reject every fresh handoff
 * before the quote and plan can be recorded. Any later app-handoff state must
 * already carry the plan it asks the Mini App to execute.
 */
export function isInitialTelegramAppHandoffProposal(
  input: Readonly<{
    deliveryMode: TelegramBuyDeliveryMode;
    status: string;
  }>,
): boolean {
  return input.deliveryMode === "app_handoff" && input.status === "draft";
}

/**
 * A transient funding inspection may record a Review-shaped snapshot before
 * it can seal a v2 plan. Retrying that exact pre-submit state must rebuild the
 * plan; treating every non-draft handoff without a plan as corrupt instead
 * routes the retry through unrelated server-executor readiness.
 */
function isRetryableTelegramAppHandoffFundingInspection(
  intent: TelegramTradeIntentRow,
): boolean {
  return (
    intent.delivery_mode === "app_handoff" &&
    intent.action === "buy" &&
    intent.status === "previewed" &&
    intent.submit_started_at == null &&
    intent.funding_operation_id == null &&
    !isRecord(intent.result.appHandoffV2) &&
    intent.result.stage === "funding_preview" &&
    isRetryableTelegramAppHandoffFundingState(intent.result.fundingState)
  );
}

/**
 * These are planner previews, not financial boundaries: no operation, client
 * action, or submit attempt exists yet. A later balance/route observation may
 * therefore replace any of them with the exact sealed Mini App plan.
 *
 * The same code-owned list is passed to the guarded SQL update below so the
 * in-memory classifier and its transactional compare-and-set cannot drift.
 */
const RETRYABLE_TELEGRAM_APP_HANDOFF_FUNDING_STATES = [
  "checking_internal_balance",
  "convert",
  "deposit",
] as const;

function isRetryableTelegramAppHandoffFundingState(value: unknown): boolean {
  return RETRYABLE_TELEGRAM_APP_HANDOFF_FUNDING_STATES.some(
    (state) => state === value,
  );
}

const EXISTING_TRADE_RESOLVING_MESSAGE =
  "Existing trade is still resolving. The bot is checking it automatically. Use the current card to check status or continue.";
const UNKNOWN_TRADE_RESOLVING_MESSAGE =
  "Trade status is unknown. The bot is checking it automatically. Use Check status on the current card.";

function buildTelegramTradeShortfallUnavailableReplyMarkup(
  intentId: string,
  venue: TelegramBotTradingVenue,
): TelegramBotTradingClientReplyMarkup {
  return {
    inline_keyboard: [
      [
        {
          callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:retry_buy:${intentId}`,
          text: "🔄 Retry balance check",
        },
      ],
      [
        {
          callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:cancel:${intentId}`,
          text: "⬅️ Back to market",
        },
        {
          callback_data: `hm:v1:deposit:${venue}`,
          text: "Deposit",
        },
      ],
      [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
    ],
  };
}

function formatTelegramVenueFieldMarkdownV2(venue: string): string {
  const emoji = telegramCustomEmojiMarkdownV2ForVenue(venue);
  return `${emoji ?? "🌐"} ${formatTelegramFieldMarkdownV2(
    "Venue",
    formatTelegramVenueLabel(venue),
  )}`;
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

type TelegramTradeLifecycleTone = "info" | "ok" | "warn" | "working";

function formatTelegramTradeLifecycleMessageMarkdownV2(input: {
  heading: string;
  lines?: Array<string | null>;
  marketTitle: string;
  tone: TelegramTradeLifecycleTone;
  venue: string;
}): string {
  const normalizedHeading = input.heading.replace(/[.!]+$/g, "");
  const headingIcon =
    input.tone === "ok"
      ? "✅"
      : input.tone === "working"
        ? "⏳"
        : input.tone === "warn"
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
  durableFundingDeliveryRequired?: boolean;
  fundingContextId?: string;
  marketFound?: boolean;
  parse_mode?: "MarkdownV2";
  reply_markup?: TelegramBotTradingReplyMarkup;
  text: string;
};

function telegramSentMessageId(value: unknown): number | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, "messageId")
  ) {
    return null;
  }
  const messageId = (value as { messageId?: unknown }).messageId;
  return typeof messageId === "number" &&
    Number.isSafeInteger(messageId) &&
    messageId > 0
    ? messageId
    : null;
}

export type TelegramFundingBuyReturnOpener = (
  input: Readonly<{
    authorizationId: string;
    chatId: string;
    continuationMode: StoredTelegramBuyDeliveryMode;
    eventId: string | null;
    idempotencyKey: string;
    marketId: string;
    minimumFundingUsd?: string;
    requestedSpendUsd: string;
    side: TelegramBotTradingSide;
    sourceIntentId: string;
    telegramMessageId: number | null;
    telegramUserId: string;
    venue: "limitless" | "polymarket";
  }>,
) => Promise<TelegramBotTradingMessage | null>;

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
  telegram_account_link_id: string;
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
  telegram_account_link_id: string;
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
  recordedAt?: string | null;
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
  /**
   * Limitless CLOB FOK has no provider-enforced proceeds floor. It can seal
   * the exact shares and prevent a resting order, but its displayed proceeds
   * are an estimate rather than a guaranteed lower bound.
   */
  sellProceedsKind?: "estimated" | "minimum" | null;
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
  delivery_mode: StoredTelegramBuyDeliveryMode;
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
  funding_operation_id: string | null;
  funding_reservation_id: string | null;
  quote_snapshot: Record<string, unknown>;
  policy_snapshot: Record<string, unknown>;
  result: Record<string, unknown>;
  idempotency_key: string;
  expires_at: Date;
  market_title: string;
  market_status: string;
};

type UnresolvedTelegramTradeIntentRow = {
  action: TelegramBotTradingAction;
  app_handoff_state: "claimed" | "committed" | "issued" | null;
  can_resume_app_handoff: boolean;
  delivery_mode: StoredTelegramBuyDeliveryMode;
  id: string;
  error_code: string | null;
  side: TelegramBotTradingSide | null;
  status: string;
  user_id: string | null;
};

function canContinueTelegramAppHandoffFromMarket(
  intent: Pick<
    UnresolvedTelegramTradeIntentRow,
    "app_handoff_state" | "can_resume_app_handoff" | "delivery_mode"
  >,
): boolean {
  return (
    intent.delivery_mode === "app_handoff" &&
    intent.can_resume_app_handoff &&
    (intent.app_handoff_state === "claimed" ||
      intent.app_handoff_state === "committed")
  );
}

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
  expectedType?:
    | "buy"
    | "sell"
    | "redeem"
    | "open_market"
    | "cancel"
    | "change_amount"
    | "confirm"
    | null;
  log?: {
    debug?: (payload: unknown, message?: string) => void;
    info?: (payload: unknown, message?: string) => void;
    warn?: (payload: unknown, message?: string) => void;
  };
  openFundingBuyReturn?: TelegramFundingBuyReturnOpener;
  inspectTradeShortfall?: (
    input: TelegramTradeShortfallIdentity,
  ) => Promise<TelegramTradeShortfallInspection>;
  inspectMiniAppFunding?: (
    input: TelegramTradeShortfallIdentity,
    trade: JsonObject,
  ) => Promise<TelegramTradeMiniAppFundingInspection>;
  /** Optional API-owned display valuation; never used for execution bounds. */
  estimateRetainedSolUsd?: (raw: string) => Promise<string | null>;
  commitTradeShortfall?: (
    input: TelegramTradeShortfallIdentity & {
      proposal: TelegramTradeShortfallProposal;
    },
  ) => Promise<Readonly<{ operationId: string }>>;
  cancelFundingOperation?: (
    input: Readonly<{
      operationId: string;
      userId: string;
    }>,
  ) => Promise<void>;
  sendMessage: (input: {
    chat_id: string;
    parse_mode?: "MarkdownV2";
    reply_markup?: TelegramBotTradingReplyMarkup;
    text: string;
  }) => Promise<unknown>;
  signerInspector?: TelegramBotTradingSignerInspector;
  telegramMiniAppEnabled?: boolean;
  trading?: ApiBotTradingExecutor;
  writeTradeInputContext?: (
    input: TelegramBotTradeInputContext,
  ) => Promise<boolean>;
};

type CapturedTelegramBotTradingCallbackResult = {
  answers: Array<{
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }>;
  handled: boolean;
  intentStatus: string | null;
  lifecycleOwnsTerminalDelivery: boolean;
  messages: Array<TelegramBotTradingMessage & { chat_id: string }>;
};

const TERMINAL_INTENT_STATUSES = new Set([
  "cancelled",
  "expired",
  "failed",
  "filled",
  "reconcile_required",
  "submitted",
  "external_handoff",
]);
const PENDING_INTENT_STATUSES = ["draft", "previewed", "confirming"];
const RESOLVING_NON_FUNDING_INTENT_STATUSES = [
  "external_handoff",
  "executing",
  "reconcile_required",
  "submitted",
];
// A live issued Review must block duplicate intents and rebuild its exact
// Confirm link. An old callback-confirmed `external_handoff` already crossed
// consent, so it may also outlive that quote TTL. Claimed consent stays
// resumable until commit or the handoff's own terminal lifecycle.
const RESUMABLE_TELEGRAM_APP_HANDOFF_V2_STATE_SQL = `(
  select resumable_handoff.state
    from telegram_app_handoffs resumable_handoff
   where resumable_handoff.trade_intent_id = tti.id
     and resumable_handoff.user_id = tti.user_id
     and (
       resumable_handoff.state in ('claimed', 'committed')
       or (
         resumable_handoff.state = 'issued'
         and (
           tti.status = 'external_handoff'
           or tti.expires_at > now()
         )
       )
     )
     and resumable_handoff.plan_snapshot ->> 'version' = '2'
   limit 1
)`;
const RESUMABLE_TELEGRAM_APP_HANDOFF_V2_SQL = `${RESUMABLE_TELEGRAM_APP_HANDOFF_V2_STATE_SQL} is not null`;
const TERMINAL_FUNDING_OPERATION_STATUSES = [
  "completed",
  "refunded",
  "failed",
  "cancelled",
];
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
  if (SAFE_VENUES.some((venue) => trimmed.startsWith(`${venue}:`))) {
    return trimmed;
  }
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
  return address ? canonicalWalletIdentity(walletChain, address) : "";
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

function readTelegramTradeIntentAmount(intent: TelegramTradeIntentRow): {
  action: "BUY" | "SELL";
  amountUsd: number | null;
  sharesRaw: bigint | null;
} {
  return {
    action: intent.action === "sell" ? "SELL" : "BUY",
    amountUsd: parseNumber(intent.amount_usd),
    sharesRaw:
      intent.shares_raw && /^\d+$/u.test(intent.shares_raw)
        ? BigInt(intent.shares_raw)
        : null,
  };
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
    sellProceedsKind: isTelegramEstimatedSellProceeds(quote)
      ? "estimated"
      : quote.minimumReceiveUsd == null
        ? null
        : "minimum",
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
  const sellProceedsKind: TelegramTradeQuotePreview["sellProceedsKind"] =
    value.sellProceedsKind === "estimated"
      ? "estimated"
      : value.sellProceedsKind === "minimum"
        ? "minimum"
        : null;
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
    sellProceedsKind,
  };
  return Object.values(preview).some((candidate) => candidate != null)
    ? preview
    : null;
}

function isTelegramEstimatedSellProceeds(
  quote: TradeQuote | TelegramTradeQuotePreview,
): boolean {
  return (
    ("venue" in quote &&
      quote.venue === "limitless" &&
      isRecord(quote.raw) &&
      quote.raw.kind === "limitless_clob") ||
    ("sellProceedsKind" in quote && quote.sellProceedsKind === "estimated")
  );
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

function canPreviewBuyForDelivery(input: {
  deliveryMode: StoredTelegramBuyDeliveryMode;
  readiness: TradingReadiness | null | undefined;
}): boolean {
  return (
    input.deliveryMode === "app_handoff" ||
    canPreviewBuyForReadiness(input.readiness)
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

export function resolveTelegramMinimumFundingUsd(shortfallUsd: number): string {
  const cents = Math.max(
    1,
    Math.ceil((Math.max(0, shortfallUsd) - Number.EPSILON) * 100),
  );
  return (cents / 100).toFixed(2);
}

function telegramTradeMarketContextId(
  market: TelegramBotMarketRow,
  side: TelegramBotTradingSide,
): string | null {
  const outcomeTokenId = side === "YES" ? market.token_yes : market.token_no;
  return outcomeTokenId
    ? venueLocalMarketContextId(market.venue, outcomeTokenId)
    : null;
}

function telegramShortfallVenue(
  venue: TelegramBotTradingVenue,
): "limitless" | "polymarket" | null {
  return venue === "limitless" || venue === "polymarket" ? venue : null;
}

function telegramTradeFundingIdentity(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  intent: TelegramTradeIntentRow;
  market: TelegramBotMarketRow;
  maximumSpendUsd: number;
  additionalFundingUsd?: string;
  policy: SignalBotPolicy;
  quoteExpiresAt: Date | string | null | undefined;
  side: TelegramBotTradingSide;
}): TelegramTradeShortfallIdentity | null {
  const venue = telegramShortfallVenue(input.intent.venue);
  const marketContextId = telegramTradeMarketContextId(
    input.market,
    input.side,
  );
  if (!venue || !marketContextId || !Number.isFinite(input.maximumSpendUsd)) {
    return null;
  }
  const quoteDeadline =
    input.quoteExpiresAt instanceof Date
      ? input.quoteExpiresAt
      : typeof input.quoteExpiresAt === "string"
        ? new Date(input.quoteExpiresAt)
        : null;
  const deadline =
    quoteDeadline && quoteDeadline.getTime() > Date.now()
      ? quoteDeadline
      : new Date(Date.now() + 30_000);
  return {
    authorizationId: input.authorization.id,
    telegramAccountId: input.authorization.telegram_account_link_id,
    telegramUserId: input.authorization.telegram_user_id,
    tradeIntentId: input.intent.id,
    userId: input.authorization.user_id,
    venue,
    marketId: input.intent.market_id,
    marketContextId,
    side: input.side,
    maximumSpendUsd: String(input.maximumSpendUsd),
    ...(input.additionalFundingUsd
      ? { additionalFundingUsd: input.additionalFundingUsd }
      : {}),
    maxFeeUsd: String(Math.max(0.01, input.maximumSpendUsd)),
    maxSlippageBps: input.policy.maxSlippageBps,
    deadline: deadline.toISOString(),
  };
}

function readTelegramTradeShortfallProposal(
  result: Record<string, unknown>,
): TelegramTradeShortfallProposal | null {
  const value = result.fundingProposal;
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    value.kind !== "internal_stable_route" ||
    typeof value.liquidityProjectionId !== "string" ||
    typeof value.selectedSourceOptionId !== "string" ||
    typeof value.serverExecutionProfileId !== "string" ||
    typeof value.destinationOptionId !== "string" ||
    typeof value.venueBindingOptionId !== "string" ||
    typeof value.proposalFingerprint !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Array.isArray(value.sourceAmounts) ||
    !Array.isArray(value.fees) ||
    !isRecord(value.expectedDestination) ||
    !isRecord(value.minimumDestination) ||
    !isRecord(value.requestedDestinationAmount)
  ) {
    return null;
  }
  return value as TelegramTradeShortfallProposal;
}

function telegramFundingSourceLabel(
  source: TelegramTradeShortfallProposal["sourceAmounts"][number],
): string {
  const network =
    source.amount.asset.networkId === "evm:8453"
      ? "Base"
      : source.amount.asset.networkId === "evm:137"
        ? "Polygon"
        : source.amount.asset.networkId === "solana:mainnet"
          ? "Solana"
          : null;
  const symbol = resolveKnownAccountAssetSymbol(source.amount.asset);
  // Never expose opaque CAIP/network identifiers on a Telegram trade card.
  // An unrecognised source is deliberately presented generically instead of
  // guessing an asset from its raw address or internal planner label.
  return network && symbol ? `${network} ${symbol}` : "Hunch wallet balance";
}

function telegramFundingNetworkLabel(networkId: string): string {
  if (networkId === "evm:8453") return "Base";
  if (networkId === "evm:137") return "Polygon";
  if (networkId === "solana:mainnet") return "Solana";
  return "supported network";
}

function telegramFundingMoneyLabel(amount: {
  asset: { assetId: string; decimals: number; networkId: string };
  raw: string;
}): string {
  const symbol = resolveKnownAccountAssetSymbol(amount.asset) ?? "asset";
  return `${ethers.formatUnits(amount.raw, amount.asset.decimals)} ${symbol} on ${telegramFundingNetworkLabel(amount.asset.networkId)}`;
}

async function buildTelegramAppHandoffFundingReviewLines(input: {
  estimateRetainedSolUsd?: (raw: string) => Promise<string | null>;
  plan: TelegramAppHandoffV2Plan | null;
}): Promise<string[]> {
  if (input.plan?.kind !== "funding") return [];
  const sourceLabels = await Promise.all(
    input.plan.funding.sourceDebits.map(async (source) => {
      const exact = telegramFundingMoneyLabel({
        asset: source.asset,
        raw: source.maximumRaw,
      });
      if (
        !isKnownNativeSolAsset(source.asset) ||
        source.maximumRaw === "0" ||
        !input.estimateRetainedSolUsd
      ) {
        return exact;
      }
      try {
        const estimatedUsd = await input.estimateRetainedSolUsd(
          source.maximumRaw,
        );
        if (!estimatedUsd || compareUnsignedDecimals(estimatedUsd, "0") <= 0) {
          return exact;
        }
        const unitPriceUsd = unitPriceFromRawEstimate({
          decimals: source.asset.decimals,
          estimatedValue: estimatedUsd,
          raw: source.maximumRaw,
        });
        if (compareUnsignedDecimals(unitPriceUsd, "0") <= 0) return exact;
        return `${exact} (≈ ${formatTelegramAccountValueUsd(estimatedUsd)} at ≈ ${formatTelegramAccountValueUsd(unitPriceUsd)}/SOL)`;
      } catch {
        // Valuation is presentation-only. Exact sealed source/debit bounds are
        // still useful when Pyth is unavailable or its estimate is unusable.
        return exact;
      }
    }),
  );
  const request = input.plan.funding.discoveryRequest;
  const destinationAmount =
    request.serverAdditionalDestinationAmount ??
    request.requestedDestinationAmount;
  const feeCap = request.maxFeeUsd;
  return [
    `🔄 ${formatTelegramFieldMarkdownV2(
      "Mini App may use up to",
      sourceLabels.join(" + "),
    )}`,
    destinationAmount
      ? `🎯 ${formatTelegramFieldMarkdownV2(
          "Funding target",
          `at least ${telegramFundingMoneyLabel(destinationAmount)} for ${formatTelegramVenueLabel(input.plan.funding.destination.venueId)}`,
        )}`
      : "",
    feeCap && feeCap !== "0"
      ? formatTelegramUsdcLineMarkdownV2(
          `Maximum funding fees: ${formatTelegramAccountValueUsd(feeCap)}`,
        )
      : "",
    `✍️ ${formatTelegramFieldMarkdownV2(
      "In Hunch",
      "review and sign the bounded funding actions; the Buy continues automatically",
    )}`,
  ].filter(Boolean);
}

export function resolveTelegramFundingBuyDepositRequirement(input: {
  executableFundsUsd: number;
  maximumSpendUsd: number;
}): Readonly<{
  availableUsd: number;
  sendAtLeastPusd: number;
  state: "deposit" | "ready";
}> {
  const preview = resolveTelegramBuyFundingPreview({
    controlledFundsUsd: null,
    executableFundsUsd: input.executableFundsUsd,
    requiredUsd: input.maximumSpendUsd,
  });
  if (preview.state === "ready") {
    return {
      availableUsd: preview.availableUsd,
      sendAtLeastPusd: 0,
      state: "ready",
    };
  }
  return {
    availableUsd: preview.availableUsd,
    sendAtLeastPusd: Math.max(
      0.01,
      Math.ceil((preview.shortfallUsd - Number.EPSILON) * 100) / 100,
    ),
    state: "deposit",
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
  buildTelegramAppHandoffFundingReviewLines,
  buildTelegramTradeConfirmButton,
  buildTelegramTradeShortfallUnavailableReplyMarkup,
  buildTelegramTradeAuthorityBinding,
  buildTelegramSellTradeIntent,
  loadUnresolvedTelegramTradeIntent,
  canAttemptSellSurface,
  canContinueTelegramAppHandoffFromMarket,
  formatTelegramTradeLifecycleMessageMarkdownV2,
  formatTelegramUsdcLineMarkdownV2,
  isDefinitiveSubmitRejection,
  isTelegramEstimatedSellProceeds,
  isTelegramSellProceedsDisplayable,
  isTelegramVenueMinimumBlocking,
  loadEnabledAuthorization,
  marketForCallbackReadiness,
  buildTelegramTradingMiniAppButton,
  openMarketUrl,
  resolveTelegramBuyFundingState,
  resolveTelegramBuyFundingPreview,
  resolveTelegramMinimumFundingUsd,
  resolveTelegramFundingBuyDepositRequirement,
  resolveExecutableTelegramSellSharesRaw,
  resolveExecutablePolymarketSellSharesRaw,
  resolveFundingReturnPreviewAllowedStatuses,
  resolveTelegramExecutableBuyOption,
  resolveTelegramCallbackMessageId,
  sameTelegramTradeAuthorityBinding,
  shouldOpenTelegramFundingBuyReturn,
  lockTelegramFundingReturnBeforeMarket,
  parseTelegramCustomBuyAmount,
  parseTelegramCustomSellAmount,
  decorateRetainedSolReceiptEstimate,
  telegramTradeInputFingerprint,
  venueStatusFromReadiness,
};

function resolveFundingReturnPreviewAllowedStatuses(input: {
  deliveryMode: StoredTelegramBuyDeliveryMode;
  replacingRetryableFundingInspection: boolean;
}): string[] {
  if (input.deliveryMode !== "app_handoff") return ["draft", "previewed"];
  return input.replacingRetryableFundingInspection ? ["previewed"] : ["draft"];
}

function shouldOpenTelegramFundingBuyReturn(input: {
  amountUsd: number | null;
  buyContinuationEnabled: boolean;
  fundingState: "convert" | "deposit";
  hasOpener: boolean;
}): boolean {
  return (
    input.fundingState === "deposit" &&
    input.buyContinuationEnabled &&
    input.hasOpener &&
    input.amountUsd != null
  );
}

function decimalToRaw(value: string, decimals: number): bigint | null {
  const match = value.match(/^(\d+)(?:\.(\d+))?$/u);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  return (
    BigInt(match[1] ?? "0") * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

export function parseTelegramCustomBuyAmount(
  raw: string,
): Readonly<{ amountUsd: number; normalized: string }> | null {
  const value = raw.trim();
  if (!/^\$?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value)) return null;
  const normalizedInput = value.startsWith("$") ? value.slice(1) : value;
  const cents = decimalToRaw(normalizedInput, 2);
  if (cents == null || cents <= 0n) return null;
  const amountUsd = Number(cents) / 100;
  return Number.isFinite(amountUsd)
    ? { amountUsd, normalized: amountUsd.toFixed(2) }
    : null;
}

function parseTelegramSellPercentage(raw: string): Readonly<{
  normalized: string;
  scaled: bigint;
  value: number;
}> | null {
  const match = raw.match(
    /^(100(?:\.0{1,6})?|(?:0|[1-9]\d?)(?:\.\d{1,6})?)%$/u,
  );
  if (!match) return null;
  const scaled = decimalToRaw(match[1] ?? "", 6);
  if (scaled == null || scaled <= 0n || scaled > 100_000_000n) return null;
  const value = Number(scaled) / 1_000_000;
  return { normalized: `${value}%`, scaled, value };
}

export function parseTelegramCustomSellAmount(
  raw: string,
  availableRaw: bigint,
): Readonly<{
  inputMode: "all" | "percent" | "shares";
  normalized: string;
  sellPercent: number | null;
  sharesRaw: bigint;
}> | null {
  if (availableRaw <= 0n) return null;
  const value = raw.trim();
  if (/^all$/iu.test(value)) {
    return {
      inputMode: "all",
      normalized: "all",
      sellPercent: 100,
      sharesRaw: availableRaw,
    };
  }
  const percent = parseTelegramSellPercentage(value);
  if (percent) {
    const sharesRaw = (availableRaw * percent.scaled) / 100_000_000n;
    if (sharesRaw <= 0n) return null;
    return {
      inputMode: "percent",
      normalized: percent.normalized,
      sellPercent: percent.value,
      sharesRaw,
    };
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)) return null;
  const sharesRaw = decimalToRaw(value, 6);
  if (sharesRaw == null || sharesRaw <= 0n || sharesRaw > availableRaw) {
    return null;
  }
  return {
    inputMode: "shares",
    normalized: ethers.formatUnits(sharesRaw, 6),
    sellPercent: null,
    sharesRaw,
  };
}

export function isTelegramVenueMinimumBlocking(input: {
  action: string;
  meetsVenueMinimum: boolean | null | undefined;
  orderType: string | null | undefined;
  venue: string;
}): boolean {
  if (input.meetsVenueMinimum !== false) return false;
  return !(
    input.venue.toLowerCase() === "polymarket" &&
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

/**
 * A sealed v2 handoff is authorised by the exact user-confirmed snapshot and
 * its later Mini App consumer, rather than by the unattended server signer.
 * It may therefore exceed the server-bot/Privy envelope, but never Hunch's
 * own runtime trade ceiling.
 *
 * Keep this distinction at the boundary where an intent is validated. Using
 * `effectiveMaxTradeAmountUsd` for both modes would silently make a web-owned
 * handoff inherit a server-only policy cap; using the runtime cap everywhere
 * would incorrectly widen unattended bot execution.
 */
export function resolveTelegramBuyIntentMaximumAmountUsd(
  input: Readonly<{
    authorizationMaxAmountUsd?: string | number | null;
    deliveryMode: StoredTelegramBuyDeliveryMode;
    policy: SignalBotPolicy;
    venue: TelegramBotTradingVenue;
  }>,
): number {
  if (
    input.deliveryMode === "app_handoff" &&
    input.policy.miniAppHandoffContractVersion >= 2 &&
    isTelegramAppHandoffV2TradeVenue(input.venue)
  ) {
    return input.policy.maxTradeAmountUsd;
  }
  return effectiveMaxTradeAmountUsd(
    input.policy,
    input.authorizationMaxAmountUsd,
  );
}

/**
 * `fallback` is decided per requested amount, not per market card. A direct
 * bot envelope and a sealed Mini App envelope have different caps, so a card
 * may legitimately contain both kinds of button without granting either path
 * authority over the other's amount range.
 */
type TelegramBuyPresetDelivery = Readonly<{
  amountUsd: number;
  deliveryMode: StoredTelegramBuyDeliveryMode;
}>;

export function resolveTelegramBuyPresetDeliveryModes(
  input: Readonly<{
    directMaximumAmountUsd: number;
    handoffAvailable: boolean;
    handoffContractVersion: 1 | 2;
    handoffMode: TelegramMiniAppHandoffMode;
    initialDeliveryMode: TelegramBuyDeliveryMode;
    presetAmountsUsd: readonly number[];
  }>,
): readonly TelegramBuyPresetDelivery[] {
  const uniqueAmounts = [...new Set(input.presetAmountsUsd)].filter(
    (amountUsd) => Number.isFinite(amountUsd) && amountUsd > 0,
  );
  const v2Fallback =
    input.handoffAvailable &&
    input.handoffContractVersion >= 2 &&
    input.handoffMode === "fallback";
  return uniqueAmounts.flatMap<TelegramBuyPresetDelivery>((amountUsd) => {
    if (input.initialDeliveryMode === "app_handoff") {
      return [{ amountUsd, deliveryMode: "app_handoff" as const }];
    }
    if (
      input.initialDeliveryMode === "bot_submit" &&
      amountUsd <= input.directMaximumAmountUsd
    ) {
      return [{ amountUsd, deliveryMode: "bot_submit" as const }];
    }
    if (v2Fallback && amountUsd > input.directMaximumAmountUsd) {
      return [{ amountUsd, deliveryMode: "app_handoff" as const }];
    }
    return [];
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
  fundingReservation?: TradeIntent["fundingReservation"];
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
    fundingReservation: input.fundingReservation,
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

function buildTelegramStoredTradeIntent(input: {
  amountUsd: number | null;
  authorization: TelegramBotTradingAuthorizationRow;
  intent: TelegramTradeIntentRow;
  market: TelegramBotMarketRow;
  policy: SignalBotPolicy;
  sharesRaw: bigint | null;
  side: TelegramBotTradingSide;
}): TradeIntent {
  if (input.intent.action === "sell" && input.sharesRaw != null) {
    return buildTelegramSellTradeIntent({
      authorization: input.authorization,
      intentId: input.intent.id,
      market: input.market,
      maxSlippageBps: input.policy.maxSlippageBps,
      sharesRaw: input.sharesRaw,
      side: input.side,
    });
  }
  return buildTelegramTradeIntent({
    amountUsd: input.amountUsd as number,
    authorization: input.authorization,
    intentId: input.intent.id,
    market: input.market,
    maxSlippageBps: input.policy.maxSlippageBps,
    side: input.side,
    fundingReservation:
      input.intent.funding_operation_id && input.intent.funding_reservation_id
        ? {
            operationId: input.intent.funding_operation_id,
            reservationId: input.intent.funding_reservation_id,
          }
        : null,
  });
}

function resolveTelegramTradeQuoteLimits(input: {
  amountUsd: number | null;
  intent: TradeIntent;
  quote: TradeQuote;
}): Readonly<{
  maxSpendUsd: number | null;
  venueMinimumBlocking: boolean;
}> {
  return {
    maxSpendUsd:
      input.intent.action === "BUY"
        ? (input.quote.maxSpendUsd ?? input.amountUsd)
        : null,
    venueMinimumBlocking: isTelegramVenueMinimumBlocking({
      action: input.intent.action,
      meetsVenueMinimum: input.quote.meetsVenueMinimum,
      orderType: input.intent.orderType,
      venue: input.intent.venue,
    }),
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

function canAttemptSellSurface(input: {
  authorizationEnabled: boolean;
  authorizationHasPrivyWallet: boolean;
  authorizationVenueAllowed: boolean;
  authorityBound: boolean;
  automationAllowed: boolean;
  focusedPositionControlled: boolean;
  hasFocusedPosition: boolean;
  isAdminTest: boolean;
  marketOrderable: boolean;
  policyTradingEnabled: boolean;
  policyVenueAllowed: boolean;
  publicBrowseOnly: boolean;
  sellActionAllowed: boolean;
  sellLifecycleAllowed: boolean;
  tradingAvailable: boolean;
  unresolvedIntent: boolean;
  sealedAppHandoffAvailable?: boolean;
  venue: string;
}): boolean {
  const common =
    !input.isAdminTest &&
    !input.publicBrowseOnly &&
    !input.unresolvedIntent &&
    input.sellLifecycleAllowed &&
    input.policyTradingEnabled &&
    input.sellActionAllowed &&
    input.marketOrderable &&
    input.authorityBound &&
    (!input.hasFocusedPosition || input.focusedPositionControlled) &&
    input.tradingAvailable;
  if (!common) return false;
  if (input.sealedAppHandoffAvailable === true) return true;
  return (
    input.automationAllowed &&
    input.venue === "polymarket" &&
    input.policyVenueAllowed &&
    input.authorizationVenueAllowed &&
    input.authorizationEnabled &&
    input.authorizationHasPrivyWallet
  );
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

type TelegramExecutableSellResolution = {
  availableRaw: bigint;
  options: TelegramExecutableSellOption[];
  side: TelegramBotTradingSide;
};

const MIN_TELEGRAM_SELL_PROCEEDS_USD = 0.01;

function isTelegramSellProceedsDisplayable(
  value: number | null | undefined,
): value is number {
  return (
    value != null &&
    Number.isFinite(value) &&
    value >= MIN_TELEGRAM_SELL_PROCEEDS_USD
  );
}

export function resolveTelegramCustomSellSides(
  resolutions: readonly Pick<
    TelegramExecutableSellResolution,
    "options" | "side"
  >[],
): readonly TelegramBotTradingSide[] {
  // A dust ERC-1155 balance is not by itself a sellable position. Only offer
  // custom sell after the same live quote path produced at least one
  // executable sell amount for that exact outcome.
  return resolutions
    .filter((resolution) => resolution.options.length > 0)
    .map((resolution) => resolution.side);
}

export function resolveExecutablePolymarketSellSharesRaw(input: {
  availableRaw: bigint;
  quote: TradeQuote;
  requestedRaw: bigint;
}): bigint | null {
  if (
    input.availableRaw <= 0n ||
    input.requestedRaw <= 0n ||
    input.requestedRaw > input.availableRaw ||
    input.quote.venue !== "polymarket" ||
    input.quote.action !== "SELL"
  ) {
    return null;
  }
  const raw = isRecord(input.quote.raw) ? input.quote.raw : null;
  const makerAmount = raw?.makerAmount;
  if (typeof makerAmount !== "string" || !/^\d+$/u.test(makerAmount)) {
    return null;
  }
  const executableRaw = BigInt(makerAmount);
  return executableRaw > 0n &&
    executableRaw <= input.requestedRaw &&
    executableRaw <= input.availableRaw
    ? executableRaw
    : null;
}

function resolveExecutableTelegramSellSharesRaw(input: {
  availableRaw: bigint;
  quote: TradeQuote;
  requestedRaw: bigint;
}): bigint | null {
  if (
    input.availableRaw <= 0n ||
    input.requestedRaw <= 0n ||
    input.requestedRaw > input.availableRaw ||
    input.quote.action !== "SELL"
  ) {
    return null;
  }
  if (input.quote.venue === "polymarket") {
    return resolveExecutablePolymarketSellSharesRaw(input);
  }
  // Limitless AMM and CLOB quotes are built from this exact share amount.
  // A ready quote therefore proves that the entire requested source amount,
  // not a partial fill, is executable at this point in time.
  return input.quote.venue === "limitless" ? input.requestedRaw : null;
}

/**
 * Both preset and custom Sell must use the same live, lock-adjusted balance
 * reader.  The venue owns how its position is represented; callers only need
 * the exact outcome token they are about to sell.
 */
async function resolveTelegramAvailablePositionRaw(input: {
  pool: DbQuery;
  signer: string;
  tokenId: string;
  userId: string;
  venue: string;
}): Promise<Readonly<{ availableRaw: bigint }> | null> {
  if (input.venue === "polymarket") {
    return resolvePolymarketAvailablePositionRaw({
      pool: input.pool,
      signer: input.signer,
      tokenId: input.tokenId,
      userId: input.userId,
    });
  }
  if (input.venue === "limitless") {
    return resolveLimitlessAvailablePositionRaw({
      pool: input.pool,
      signer: input.signer,
      tokenId: input.tokenId,
      userId: input.userId,
    });
  }
  return null;
}

async function resolveTelegramExecutableSellOptions(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  market: TelegramBotMarketRow;
  maxSlippageBps: number;
  side: TelegramBotTradingSide;
  trading: ApiBotTradingExecutor;
}): Promise<TelegramExecutableSellResolution> {
  const empty = { availableRaw: 0n, options: [], side: input.side };
  if (
    input.market.venue !== "polymarket" &&
    input.market.venue !== "limitless"
  ) {
    return empty;
  }
  const tokenId =
    input.side === "YES" ? input.market.token_yes : input.market.token_no;
  if (!tokenId) return empty;
  let availability: Readonly<{ availableRaw: bigint }> | null;
  try {
    availability = await resolveTelegramAvailablePositionRaw({
      pool: input.db,
      signer: input.authorization.wallet_address,
      tokenId,
      userId: input.authorization.user_id,
      venue: input.market.venue,
    });
  } catch {
    return empty;
  }
  if (!availability) return empty;
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
      const sharesRaw = resolveExecutableTelegramSellSharesRaw({
        availableRaw: availability.availableRaw,
        quote,
        requestedRaw,
      });
      const currentPrice = quote.currentPrice;
      const minimumReceiveUsd = quote.minimumReceiveUsd;
      if (
        isTelegramVenueMinimumBlocking({
          action: "SELL",
          meetsVenueMinimum: quote.meetsVenueMinimum,
          orderType: "FOK",
          venue: input.market.venue,
        }) ||
        sharesRaw == null ||
        sharesRaw <= 0n ||
        currentPrice == null ||
        currentPrice <= 0 ||
        !isTelegramSellProceedsDisplayable(minimumReceiveUsd)
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
  return {
    availableRaw: availability.availableRaw,
    options,
    side: input.side,
  };
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

function buildTelegramTradeConfirmButton(input: {
  action: "BUY" | "SELL";
  intentId: string;
  override?: TelegramBotTradingButton;
  venue: TelegramBotTradingVenue;
}): TelegramBotTradingButton {
  return (
    input.override ?? {
      callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:confirm:${input.intentId}`,
      icon_custom_emoji_id: formatTelegramVenueButtonIcon(input.venue),
      text: input.action === "BUY" ? "Confirm buy" : "Confirm sell",
    }
  );
}

function buildTelegramTradeConfirmationMessage(input: {
  appHandoffFundingReviewLines?: readonly string[];
  authorization: TelegramBotTradingAuthorizationRow;
  confirmButton?: TelegramBotTradingButton;
  intent: TelegramTradeIntentRow;
  market: TelegramBotMarketRow;
  policy: SignalBotPolicy;
  quote: TradeQuote | TelegramTradeQuotePreview;
  readiness: TradingReadiness | null;
}): TelegramBotTradingMessage {
  const { action, amountUsd, sharesRaw } = readTelegramTradeIntentAmount(
    input.intent,
  );
  const sellPercent = parseNumber(input.intent.sell_percent);
  const inputMode = readTelegramInputMode(input.intent);
  const requestedSharesRaw = readTelegramInputSharesRaw(
    input.intent,
    "requestedSharesRaw",
  );
  const side = input.intent.side ?? "YES";
  const exactQuantity =
    sharesRaw == null
      ? "unavailable"
      : `${ethers.formatUnits(sharesRaw, 6)} shares`;
  const quantityLabel =
    sellPercent == null
      ? exactQuantity
      : `${exactQuantity} (${sellPercent}% snapshot)`;
  const roundingRemainderRaw =
    sharesRaw != null &&
    requestedSharesRaw != null &&
    requestedSharesRaw > sharesRaw
      ? requestedSharesRaw - sharesRaw
      : null;
  const requestedQuantityLabel =
    requestedSharesRaw == null
      ? null
      : inputMode === "all"
        ? `all available at input (${ethers.formatUnits(requestedSharesRaw, 6)} shares)`
        : inputMode === "percent" && sellPercent != null
          ? `${sellPercent}% snapshot (${ethers.formatUnits(requestedSharesRaw, 6)} shares)`
          : `${ethers.formatUnits(requestedSharesRaw, 6)} shares`;
  const previewMaxSpendUsd =
    action === "BUY" ? (input.quote.maxSpendUsd ?? amountUsd) : null;
  const fundingProposal = readTelegramTradeShortfallProposal(
    input.intent.result,
  );
  const appHandoffV2Plan = readTelegramAppHandoffV2Plan(input.intent);
  const fundingSourceLabel = fundingProposal?.sourceAmounts
    .map(telegramFundingSourceLabel)
    .join(" + ");
  const quoteExpiresAt =
    input.quote.expiresAt instanceof Date
      ? input.quote.expiresAt
      : typeof input.quote.expiresAt === "string"
        ? new Date(input.quote.expiresAt)
        : null;
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          buildTelegramTradeConfirmButton({
            action,
            intentId: input.intent.id,
            override: input.confirmButton,
            venue: input.intent.venue,
          }),
          {
            callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:cancel:${input.intent.id}`,
            text: "❌ Cancel",
          },
        ],
        ...(action === "BUY"
          ? [
              [
                {
                  callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:change_amount:${input.intent.id}`,
                  text: "Change amount",
                },
              ],
            ]
          : []),
        [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
      ],
    },
    text: joinTelegramMarkdownV2Lines(
      [
        `${action === "BUY" ? "🟢" : "🔴"} ${formatTelegramBoldMarkdownV2(
          action === "BUY" ? "Confirm buy" : "Confirm sell",
        )}`,
        "",
        formatTelegramVenueFieldMarkdownV2(input.intent.venue),
        `🎯 ${formatTelegramFieldMarkdownV2("Market", input.intent.market_title)}`,
        `↔️ ${formatTelegramFieldMarkdownV2("Side", sideLabel(input.market, side))}`,
        "",
        `📊 ${formatTelegramFieldMarkdownV2(
          action === "BUY" ? "Current ask" : "Current bid",
          formatTelegramQuotePrice(input.quote.currentPrice ?? null),
        )}`,
        action === "BUY"
          ? `📈 ${formatTelegramFieldMarkdownV2(
              "Maximum execution price",
              formatTelegramQuotePrice(input.quote.price),
            )}`
          : null,
        action === "BUY"
          ? formatTelegramUsdcLineMarkdownV2(
              `Nominal order: ${formatUsd(amountUsd ?? 0)}`,
            )
          : `📦 ${formatTelegramFieldMarkdownV2(
              "Exact quantity",
              quantityLabel,
            )}`,
        action === "SELL"
          ? formatTelegramUsdcLineMarkdownV2(
              `${
                isTelegramEstimatedSellProceeds(input.quote)
                  ? "Estimated pUSD proceeds"
                  : "Minimum pUSD receive"
              }: ${formatUsd(input.quote.minimumReceiveUsd ?? 0)}`,
            )
          : input.quote.minReceiveShares == null
            ? null
            : `📦 ${formatTelegramFieldMarkdownV2(
                "Minimum estimated shares",
                input.quote.minReceiveShares.toFixed(2),
              )}`,
        action === "SELL" && roundingRemainderRaw != null
          ? `📐 ${formatTelegramFieldMarkdownV2(
              "Requested",
              requestedQuantityLabel ?? "unavailable",
            )}`
          : null,
        action === "SELL" && roundingRemainderRaw != null
          ? `🧹 ${formatTelegramFieldMarkdownV2(
              "Venue rounding remainder",
              `${ethers.formatUnits(roundingRemainderRaw, 6)} shares may remain`,
            )}`
          : null,
        action === "BUY"
          ? formatTelegramUsdcLineMarkdownV2(
              `Maximum total spend: ${formatUsd(previewMaxSpendUsd ?? 0)}`,
            )
          : `📉 ${formatTelegramFieldMarkdownV2(
              "Minimum execution price",
              formatTelegramQuotePrice(input.quote.price),
            )}`,
        fundingProposal
          ? `🔄 ${formatTelegramFieldMarkdownV2(
              "Use existing Hunch balance",
              fundingSourceLabel || "Internal stable balance",
            )}`
          : null,
        fundingProposal
          ? formatTelegramUsdcLineMarkdownV2(
              `Minimum prepared: ${ethers.formatUnits(
                fundingProposal.minimumDestination.raw,
                fundingProposal.minimumDestination.asset.decimals,
              )}`,
            )
          : appHandoffV2Plan &&
              action === "BUY" &&
              !input.appHandoffFundingReviewLines?.length
            ? `🔄 ${formatTelegramFieldMarkdownV2(
                "Funding",
                "Hunch will prepare only the sealed eligible balances in the Mini App",
              )}`
            : null,
        ...(input.appHandoffFundingReviewLines ?? []),
        `🎚️ ${formatTelegramFieldMarkdownV2(
          "Price tolerance",
          `${input.policy.maxSlippageBps / 100}%`,
        )}`,
        `⚙️ ${formatTelegramFieldMarkdownV2(
          "Possible setup",
          input.readiness?.repair?.kind === "auto"
            ? input.readiness.repair.message
            : "None",
        )}`,
        formatQuoteTtl(quoteExpiresAt)
          ? `⏱️ ${formatTelegramFieldMarkdownV2(
              "Quote validity",
              `About ${formatQuoteTtl(quoteExpiresAt)}`,
            )}`
          : null,
        "",
        formatTelegramCalloutMarkdownV2({
          bodyMarkdownV2: escapeMarkdown(
            fundingProposal
              ? "Confirm authorizes the shown internal funding route and this Buy within the displayed limits. No external Deposit is required."
              : appHandoffV2Plan
                ? action === "SELL"
                  ? "Confirm authorizes this exact Sell within the displayed limits. Hunch will not sell more than the sealed quantity."
                  : "Confirm authorizes the sealed eligible funding scope and this Buy within the displayed limits. Hunch will not use a new wallet, network, asset, or amount outside that scope."
                : input.intent.delivery_mode === "app_handoff"
                  ? "Confirm authorizes this Buy within the displayed limits. Hunch will open only as a protected processing window; no second Buy click is required."
                  : "This is a real trade. Confirm only if you want the bot to submit it now.",
          ),
          icon: "⚠️",
          title: "Real trade",
        }),
      ].filter((line): line is string => line != null),
    ),
  };
}

function buildTelegramTradeAppHandoffMessage(input: {
  intent: TelegramTradeIntentRow;
  market: TelegramBotMarketRow;
  policy: SignalBotPolicy;
  quote: TradeQuote | TelegramTradeQuotePreview;
  startParam: string;
  telegramMiniAppLinkBase?: string | null;
}): TelegramBotTradingMessage {
  const { action, amountUsd, sharesRaw } = readTelegramTradeIntentAmount(
    input.intent,
  );
  const side = input.intent.side ?? "YES";
  const v2Plan = readTelegramAppHandoffV2Plan(input.intent);
  const continueButton = buildHunchMiniAppDeepLinkButton({
    miniAppLinkBase:
      input.telegramMiniAppLinkBase ?? env.telegramMiniAppLinkBase,
    startParam: input.startParam,
    text: v2Plan
      ? `Continue ${action === "SELL" ? "Sell" : "Buy"} in Hunch`
      : `Track confirmed ${action === "SELL" ? "sell" : "buy"}`,
  });
  if (!continueButton) {
    throw new TelegramAppHandoffError("not_committable");
  }
  const quoteExpiresAt =
    input.quote.expiresAt instanceof Date
      ? input.quote.expiresAt
      : typeof input.quote.expiresAt === "string"
        ? new Date(input.quote.expiresAt)
        : null;
  return {
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: [[continueButton]] },
    text: joinTelegramMarkdownV2Lines(
      [
        `${action === "SELL" ? "🔴" : "🟢"} ${formatTelegramBoldMarkdownV2(
          action === "SELL" ? "Sell confirmed" : "Buy confirmed",
        )}`,
        "",
        formatTelegramVenueFieldMarkdownV2(input.intent.venue),
        `🎯 ${formatTelegramFieldMarkdownV2("Market", input.intent.market_title)}`,
        `↔️ ${formatTelegramFieldMarkdownV2("Side", sideLabel(input.market, side))}`,
        "",
        `📊 ${formatTelegramFieldMarkdownV2(
          action === "SELL" ? "Current bid" : "Current ask",
          formatTelegramQuotePrice(input.quote.currentPrice ?? null),
        )}`,
        action === "SELL"
          ? `📦 ${formatTelegramFieldMarkdownV2(
              "Exact quantity",
              sharesRaw == null
                ? "unavailable"
                : `${ethers.formatUnits(sharesRaw, 6)} shares`,
            )}`
          : `📈 ${formatTelegramFieldMarkdownV2(
              "Maximum execution price",
              formatTelegramQuotePrice(input.quote.price),
            )}`,
        action === "SELL"
          ? formatTelegramUsdcLineMarkdownV2(
              `${
                isTelegramEstimatedSellProceeds(input.quote)
                  ? "Estimated proceeds"
                  : "Minimum receive"
              }: ${formatUsd(input.quote.minimumReceiveUsd ?? 0)}`,
            )
          : formatTelegramUsdcLineMarkdownV2(
              `Nominal order: ${formatUsd(amountUsd ?? 0)}`,
            ),
        action === "SELL" || input.quote.minReceiveShares == null
          ? null
          : `📦 ${formatTelegramFieldMarkdownV2(
              "Minimum estimated shares",
              input.quote.minReceiveShares.toFixed(2),
            )}`,
        action === "SELL"
          ? null
          : formatTelegramUsdcLineMarkdownV2(
              `Maximum total spend: ${formatUsd(
                input.quote.maxSpendUsd ?? amountUsd ?? 0,
              )}`,
            ),
        `🎚️ ${formatTelegramFieldMarkdownV2(
          "Price tolerance",
          `${input.policy.maxSlippageBps / 100}%`,
        )}`,
        formatQuoteTtl(quoteExpiresAt)
          ? `⏱️ ${formatTelegramFieldMarkdownV2(
              "Quote validity",
              `About ${formatQuoteTtl(quoteExpiresAt)}`,
            )}`
          : null,
        "",
        formatTelegramCalloutMarkdownV2({
          bodyMarkdownV2: escapeMarkdown(
            action === "SELL"
              ? isTelegramEstimatedSellProceeds(input.quote)
                ? "Your exact Sell is confirmed. Open Hunch to sign and submit only the sealed quantity. The displayed proceeds are an estimate for this FOK market order."
                : "Your exact Sell is confirmed. Open Hunch to sign and submit only the sealed quantity within the displayed proceeds bound."
              : v2Plan
                ? "Your Buy and bounded funding scope are confirmed. Open Hunch to execute only the sealed funding actions and continue the Buy automatically within those limits."
                : "Your Buy is confirmed. Open Hunch to watch the protected funding and order operation; no second Buy click is required.",
          ),
          icon: "ℹ️",
          title:
            action === "SELL"
              ? "Continue protected Sell"
              : v2Plan
                ? "Continue protected funding"
                : "Open processing window",
        }),
      ].filter((line): line is string => line != null),
    ),
  };
}

function asTelegramTradeQuotePreview(
  quote: TradeQuote | TelegramTradeQuotePreview,
): TelegramTradeQuotePreview {
  return "venue" in quote ? buildTelegramTradeQuotePreview(quote) : quote;
}

/**
 * The sealed handoff owns these economic bounds. The Mini App may re-quote a
 * funding route inside its source scope, but it never receives an unbounded
 * market/side/amount instruction from Telegram.
 */
function buildTelegramAppHandoffV2TradeSnapshot(input: {
  /** Verified controller which must sign the eventual Mini App trade. */
  controllerWalletAddress: string;
  intent: TelegramTradeIntentRow;
  market: TelegramBotMarketRow;
  policy: SignalBotPolicy;
  quote: TradeQuote | TelegramTradeQuotePreview;
}): JsonObject {
  const { amountUsd } = readTelegramTradeIntentAmount(input.intent);
  const quote = asTelegramTradeQuotePreview(input.quote);
  const controllerWalletAddress = input.controllerWalletAddress.trim();
  if (!/^0x[0-9a-f]{40}$/iu.test(controllerWalletAddress)) {
    throw new Error("Mini App handoff controller is malformed");
  }
  const common = {
    controllerWalletAddress: controllerWalletAddress.toLowerCase(),
    eventId: input.intent.event_id,
    eventTitle: input.market.event_title,
    marketId: input.intent.market_id,
    marketTitle: input.intent.market_title,
    maxSlippageBps: input.policy.maxSlippageBps,
    // The ordinary web order endpoint validates the sealed exact outcome, not
    // merely a market plus a human-readable YES/NO label.
    outcomeTokenId:
      input.intent.side === "NO"
        ? input.market.token_no
        : input.market.token_yes,
    outcome: sideLabel(input.market, input.intent.side ?? "YES"),
    side: input.intent.side,
    venue: input.intent.venue,
  };
  if (input.intent.action === "sell") {
    const sharesRaw = input.intent.shares_raw;
    const minimumReceiveUsd = quote.minimumReceiveUsd;
    if (
      !sharesRaw ||
      !/^\d+$/u.test(sharesRaw) ||
      BigInt(sharesRaw) <= 0n ||
      minimumReceiveUsd == null ||
      !Number.isFinite(minimumReceiveUsd) ||
      minimumReceiveUsd <= 0
    ) {
      throw new Error("Mini App handoff Sell bounds are unavailable");
    }
    // Quote values are JS numbers. Rounding down to the destination's six
    // decimals preserves the lower bound without rejecting a valid fill
    // because a binary float rounded one micro-unit upward.
    const minimumReceiveRaw = BigInt(Math.floor(minimumReceiveUsd * 1_000_000));
    if (minimumReceiveRaw <= 0n) {
      throw new Error("Mini App handoff Sell minimum receive is unavailable");
    }
    return {
      ...common,
      action: "sell",
      minimumReceiveRaw: minimumReceiveRaw.toString(),
      sharesRaw,
    };
  }
  return {
    ...common,
    action: "buy",
    amountUsd,
    maxSpendUsd: quote.maxSpendUsd ?? amountUsd,
    minReceiveShares: quote.minReceiveShares,
  };
}

function readTelegramAppHandoffV2Plan(
  intent: TelegramTradeIntentRow,
): TelegramAppHandoffV2Plan | null {
  const candidate =
    isRecord(intent.result) && isRecord(intent.result.appHandoffV2)
      ? intent.result.appHandoffV2.plan
      : null;
  return candidate &&
    isRecord(candidate) &&
    isTelegramAppHandoffV2Plan(candidate as JsonObject)
    ? (candidate as TelegramAppHandoffV2Plan)
    : null;
}

function canUseTelegramAppHandoffV2(input: {
  intent: TelegramTradeIntentRow;
  policy: SignalBotPolicy;
  telegramMiniAppEnabled?: boolean;
}): boolean {
  return (
    input.telegramMiniAppEnabled === true &&
    input.policy.miniAppHandoffMode !== "off" &&
    input.policy.miniAppHandoffContractVersion >= 2 &&
    (input.intent.action === "buy" || input.intent.action === "sell") &&
    isTelegramAppHandoffV2TradeVenue(input.intent.venue)
  );
}

/**
 * Direct v2 plans select one of the ordinary web consumers which takes a
 * durable claim before its provider/chain boundary.
 */
function hasTelegramAppHandoffV2DirectMarketConsumer(
  venue: TelegramBotTradingVenue,
): boolean {
  return isTelegramAppHandoffV2DirectTradeVenue(venue);
}

function canUseTelegramAppHandoffV2DirectTrade(input: {
  intent: TelegramTradeIntentRow;
  policy: SignalBotPolicy;
  telegramMiniAppEnabled?: boolean;
}): boolean {
  return (
    canUseTelegramAppHandoffV2(input) &&
    // Direct plans cross an ordinary venue-order boundary. Each supported
    // consumer takes its deterministic durable claim before it calls the
    // provider: Polymarket uses its signed order hash, Limitless CLOB uses a
    // client order id, and Limitless AMM uses the signed transaction hash.
    hasTelegramAppHandoffV2DirectMarketConsumer(input.intent.venue)
  );
}

async function issueTelegramTradeAppHandoff(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  intent: TelegramTradeIntentRow;
  quote: TradeQuote | TelegramTradeQuotePreview;
  /**
   * New handoffs have exactly one product contract: generic v2. The legacy
   * commit/execute API remains readable for rows already persisted before
   * this contract, but no current Telegram flow is allowed to mint v1.
   */
  v2Plan: TelegramAppHandoffV2Plan;
}) {
  const handoffVenue = input.intent.venue;
  if (!isTelegramAppHandoffV2TradeVenue(handoffVenue)) {
    throw new TelegramAppHandoffError("venue_unsupported");
  }
  const scope = await resolveTelegramAppHandoffCurrentScope({
    action: input.intent.action === "sell" ? "sell" : "buy",
    db: input.db,
    telegramUserId: input.intent.telegram_user_id,
    venue: handoffVenue,
    executionContractVersion: 2,
  });
  const authority = buildTelegramTradeAuthorityBinding(input.authorization);
  if (
    !scope ||
    !authority ||
    scope.authorityFingerprint !==
      telegramBotTradeAuthorityFingerprint(authority)
  ) {
    throw new TelegramAppHandoffError("policy_changed");
  }
  const quoteSnapshot = asTelegramTradeQuotePreview(input.quote);
  return issueTelegramAppHandoff({
    assertCurrentIntent: (client) =>
      matchesTelegramAppHandoffV2CurrentScope({
        // The handoff service already owns this transaction. Pass only its
        // query capability so the live fence cannot try to nest BEGIN.
        db: { query: client.query.bind(client) },
        sealed: {
          action: input.intent.action === "sell" ? "sell" : "buy",
          authorityFingerprint: scope.authorityFingerprint,
          policyRevision: scope.policyRevision,
          telegramUserId: input.intent.telegram_user_id,
          tradeIntentId: input.intent.id,
          venue: handoffVenue,
        },
      }),
    authorityFingerprint: scope.authorityFingerprint,
    db: input.db,
    // A committed token is deterministic and remains the same durable
    // operation handle. The short Telegram quote TTL bounds the economics,
    // not the time needed to open Hunch, sign funding, or resume a client
    // action. The Mini App re-quotes inside the sealed bounds before Buy.
    expiresAt:
      input.intent.expires_at.getTime() > Date.now() + 30 * 60 * 1_000
        ? input.intent.expires_at
        : new Date(Date.now() + 30 * 60 * 1_000),
    planSnapshot: input.v2Plan,
    policyRevision: scope.policyRevision,
    quoteSnapshot,
    telegramUserId: input.intent.telegram_user_id,
    tokenSecret: env.telegramBotToken || undefined,
    tradeIntentId: input.intent.id,
    userId: input.authorization.user_id,
  });
}

async function issueTelegramTradeAppHandoffMessage(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  intent: TelegramTradeIntentRow;
  market: TelegramBotMarketRow;
  policy: SignalBotPolicy;
  quote: TradeQuote | TelegramTradeQuotePreview;
  telegramMiniAppLinkBase?: string | null;
  v2Plan: TelegramAppHandoffV2Plan;
}): Promise<TelegramBotTradingMessage> {
  const issued = await issueTelegramTradeAppHandoff(input);
  return buildTelegramTradeAppHandoffMessage({
    intent: input.intent,
    market: input.market,
    policy: input.policy,
    quote: input.quote,
    startParam: issued.startParam,
    telegramMiniAppLinkBase: input.telegramMiniAppLinkBase,
  });
}

/**
 * App-handoff Review uses opening the sealed Mini App as its consent action.
 * Server execution keeps the ordinary callback Confirm boundary.
 */
async function buildTelegramTradeReviewMessage(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  intent: TelegramTradeIntentRow;
  market: TelegramBotMarketRow;
  policy: SignalBotPolicy;
  preissuedHandoff?: Awaited<ReturnType<typeof issueTelegramTradeAppHandoff>>;
  quote: TradeQuote | TelegramTradeQuotePreview;
  readiness: TradingReadiness | null;
  estimateRetainedSolUsd?: (raw: string) => Promise<string | null>;
}): Promise<TelegramBotTradingMessage> {
  if (input.intent.delivery_mode !== "app_handoff") {
    return buildTelegramTradeConfirmationMessage(input);
  }
  const v2Plan = readTelegramAppHandoffV2Plan(input.intent);
  if (!v2Plan) {
    throw new TelegramAppHandoffError("unauthorized");
  }
  const issued =
    input.preissuedHandoff ??
    (await issueTelegramTradeAppHandoff({ ...input, v2Plan }));
  const { action } = readTelegramTradeIntentAmount(input.intent);
  const confirmButton = buildHunchMiniAppDeepLinkButton({
    miniAppLinkBase: env.telegramMiniAppLinkBase,
    startParam: issued.startParam,
    text: action === "SELL" ? "Confirm sell" : "Confirm buy",
  });
  if (!confirmButton) {
    throw new TelegramAppHandoffError("unauthorized");
  }
  const appHandoffFundingReviewLines =
    await buildTelegramAppHandoffFundingReviewLines({
      estimateRetainedSolUsd: input.estimateRetainedSolUsd,
      plan: v2Plan,
    });
  return buildTelegramTradeConfirmationMessage({
    ...input,
    appHandoffFundingReviewLines,
    confirmButton,
  });
}

async function sealConfirmedTelegramAppHandoff(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  intent: TelegramTradeIntentRow;
  market: TelegramBotMarketRow;
  policy: SignalBotPolicy;
  preissuedHandoff?: Awaited<ReturnType<typeof issueTelegramTradeAppHandoff>>;
  quote: TradeQuote | TelegramTradeQuotePreview;
}): Promise<TelegramBotTradingMessage | null> {
  const v2Plan = readTelegramAppHandoffV2Plan(input.intent);
  if (!v2Plan) {
    // Compatibility rows can still be resolved through the legacy API, but
    // the bot must not mint a new v1 link for an unversioned/old intent.
    return null;
  }
  const issued =
    input.preissuedHandoff ??
    (await issueTelegramTradeAppHandoff({ ...input, v2Plan }));
  if (issued.handoff.state === "issued") {
    // Compatibility for callback Confirm buttons already delivered before
    // one-click handoff: that callback is the consent boundary, so claim the
    // same sealed token before showing the old Continue card. New Reviews
    // never enter this branch because their Confirm button is the token link.
    await claimTelegramAppHandoff({
      db: input.db as Pool,
      telegramUserId: input.intent.telegram_user_id,
      token: issued.token,
      userId: input.authorization.user_id,
    });
  } else if (
    issued.handoff.state !== "claimed" &&
    issued.handoff.state !== "committed"
  ) {
    throw new TelegramAppHandoffError("not_claimable");
  }
  return buildTelegramTradeAppHandoffMessage({
    intent: input.intent,
    market: input.market,
    policy: input.policy,
    quote: input.quote,
    startParam: issued.startParam,
  });
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
    buyContinuationEnabled: policy.buyContinuationEnabled,
    customTradeInputEnabled: policy.customTradeInputEnabled,
    fundingReceiveEnabled: policy.fundingReceiveEnabled,
    miniAppHandoffContractVersion: policy.miniAppHandoffContractVersion,
    miniAppHandoffMode: policy.miniAppHandoffMode,
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
          buyContinuationEnabled: false,
          customTradeInputEnabled: false,
          fundingReceiveEnabled: false,
          miniAppHandoffContractVersion: 1,
          miniAppHandoffMode: "off",
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
  options: { resolveActionReadiness?: boolean } = {},
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
       uta.id::text AS telegram_account_link_id,
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
      telegram_account_link_id: authRow.telegram_account_link_id,
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
      options.resolveActionReadiness !== false &&
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
      await lockTelegramFundingLinkLifecycle(client, input.userId);
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
      for (const update of authorizationUpdates) {
        const currentWallet = await client.query<{ ready: boolean }>(
          `select exists (
             select 1
               from users app_user
               join user_telegram_accounts telegram_account
                 on telegram_account.user_id = app_user.id
                and telegram_account.telegram_user_id = $2
               join user_wallets wallet
                 on wallet.user_id = app_user.id
                and wallet.wallet_type = $3
                and wallet.is_verified = true
                and wallet.is_internal_wallet = true
                and wallet.privy_wallet_id = $4
                and funding_account_identifier_equal(
                      $3,
                      wallet.wallet_address,
                      $5
                    )
              where app_user.id = $1
                and coalesce(app_user.is_active, true) = true
           ) as ready`,
          [
            input.userId,
            telegramUserId,
            update.selected.walletChain,
            update.selected.privyWalletId,
            update.selected.walletAddress,
          ],
        );
        if (currentWallet.rows[0]?.ready !== true) {
          throw new TelegramBotTradingEnableError({
            code: "internal_trading_wallet_required",
            message:
              "The selected internal Trading Wallet is no longer current.",
            statusCode: 409,
          });
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
      await client.query(
        `UPDATE telegram_funding_authorizations funding_authorization
            SET revoked_at = greatest(funding_authorization.granted_at, now()),
                updated_at = greatest(funding_authorization.granted_at, now())
          WHERE funding_authorization.user_id = $1
            AND funding_authorization.revoked_at IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM telegram_bot_trading_authorizations trading_authorization
                JOIN user_wallets wallet
                  ON wallet.id = funding_authorization.user_wallet_id
                 AND wallet.user_id = funding_authorization.user_id
                 AND wallet.is_verified = true
                 AND wallet.is_internal_wallet = true
                 AND wallet.privy_wallet_id = funding_authorization.privy_wallet_id
                 AND funding_account_identifier_equal(
                       'ethereum',
                       wallet.wallet_address,
                       funding_authorization.wallet_address
                     )
               WHERE trading_authorization.user_id = funding_authorization.user_id
                 AND trading_authorization.telegram_user_id = funding_authorization.telegram_user_id
                 AND trading_authorization.wallet_chain = 'ethereum'
                 AND trading_authorization.privy_wallet_id = funding_authorization.privy_wallet_id
                 AND funding_account_identifier_equal(
                       'ethereum',
                       trading_authorization.wallet_address,
                       funding_authorization.wallet_address
                     )
                 AND trading_authorization.enabled = true
                 AND 'polymarket' = any(trading_authorization.enabled_venues)
            )`,
        [input.userId],
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
    const userId = byUser
      ? selector.userId
      : (
          await client.query<{ user_id: string }>(
            `SELECT user_id
             FROM user_telegram_accounts
            WHERE telegram_user_id = $1
            LIMIT 1`,
            [selector.telegramUserId],
          )
        ).rows[0]?.user_id;
    if (userId) {
      await lockTelegramFundingLinkLifecycle(client, userId);
    }
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
    if (userId && options.blockLinkGeneration) {
      await client.query(
        `UPDATE telegram_funding_authorizations
            SET revoked_at = greatest(granted_at, now()),
                updated_at = greatest(granted_at, now())
          WHERE user_id = $1
            AND revoked_at IS NULL`,
        [userId],
      );
    }
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
  authority: TelegramBotTradeAuthorityBinding;
  chatId: string;
  db: DbQuery;
  deliveryMode: StoredTelegramBuyDeliveryMode;
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
       user_id,
       authorization_id,
       chat_id,
       telegram_message_id,
       delivery_mode,
       action,
       venue,
       market_id,
       event_id,
       side,
       amount_usd,
       status,
       quote_snapshot,
       policy_snapshot,
       result,
       expires_at,
       idempotency_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'buy', $8, $9, $10, $11, $12,
       'draft', $13::jsonb, $14::jsonb, $15::jsonb, $16, $17)`,
    [
      id,
      input.telegramUserId,
      input.authority.userId,
      input.authority.authorizationId,
      input.chatId,
      input.telegramMessageId ?? null,
      input.deliveryMode,
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
      JSON.stringify(buildIntentAuthorityResult(input.authority)),
      expiresAt,
      `telegram-bot:${id}`,
    ],
  );
  return id;
}

async function insertSellIntent(input: {
  authority: TelegramBotTradeAuthorityBinding;
  chatId: string;
  db: DbQuery;
  deliveryMode: StoredTelegramBuyDeliveryMode;
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
       id, telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, delivery_mode, action, venue,
       market_id, event_id, side, sell_percent, shares_raw, status,
       quote_snapshot, policy_snapshot, result, expires_at, idempotency_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'sell', $8, $9, $10, $11, $12,
       $13, 'draft', $14::jsonb, $15::jsonb, $16::jsonb, $17, $18)`,
    [
      id,
      input.telegramUserId,
      input.authority.userId,
      input.authority.authorizationId,
      input.chatId,
      input.telegramMessageId ?? null,
      input.deliveryMode,
      input.market.venue,
      input.market.id,
      input.market.event_id,
      input.side,
      input.sellPercent,
      input.sharesRaw.toString(),
      JSON.stringify(buildTelegramTradeQuotePreview(input.quote)),
      JSON.stringify(buildPolicySnapshot(input.policy)),
      JSON.stringify(buildIntentAuthorityResult(input.authority)),
      expiresAt,
      `telegram-bot:${id}`,
    ],
  );
  return id;
}

async function insertRedeemIntent(input: {
  authority: TelegramBotTradeAuthorityBinding;
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
       id, telegram_user_id, user_id, authorization_id, chat_id,
       telegram_message_id, action, venue,
       market_id, event_id, status, quote_snapshot, policy_snapshot,
       result, expires_at, idempotency_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'redeem', $7, $8, $9, 'draft',
       $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)`,
    [
      id,
      input.telegramUserId,
      input.authority.userId,
      input.authority.authorizationId,
      input.chatId,
      input.telegramMessageId ?? null,
      input.market.venue,
      input.market.id,
      input.market.event_id,
      JSON.stringify(input.plan),
      JSON.stringify(buildPolicySnapshot(input.policy)),
      JSON.stringify(buildIntentAuthorityResult(input.authority)),
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
    `SELECT
       tti.action,
       ${RESUMABLE_TELEGRAM_APP_HANDOFF_V2_STATE_SQL} as app_handoff_state,
       ${RESUMABLE_TELEGRAM_APP_HANDOFF_V2_SQL} as can_resume_app_handoff,
       tti.delivery_mode,
       tti.id,
       tti.side,
       tti.status,
       tti.error_code,
       tti.user_id::text
       FROM telegram_trade_intents tti
	     WHERE telegram_user_id = $1
	        AND market_id = $2
	        AND ($3::text IS NULL OR side = $3)
	        AND ($4::uuid IS NULL OR id <> $4::uuid)
	        AND (
	          (status = 'confirming' AND expires_at > now())
	          OR (
	            status in ('previewed', 'confirming', 'external_handoff')
	            AND ${RESUMABLE_TELEGRAM_APP_HANDOFF_V2_SQL}
	          )
	          OR status = ANY($5::text[])
	          OR (
	            status = 'funding'
	            AND funding_operation_id IS NOT NULL
	            AND EXISTS (
	              SELECT 1
	                FROM funding_operations funding_operation
	               WHERE funding_operation.id = tti.funding_operation_id
	                 AND funding_operation.user_id = tti.user_id
	                 AND funding_operation.status <> ALL($6::text[])
	            )
	          )
	        )
      ORDER BY updated_at DESC
      LIMIT 1`,
    [
      input.telegramUserId,
      input.marketId,
      input.side ?? null,
      input.excludeIntentId ?? null,
      RESOLVING_NON_FUNDING_INTENT_STATUSES,
      TERMINAL_FUNDING_OPERATION_STATUSES,
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
	          OR (
	            status in ('previewed', 'confirming', 'external_handoff')
	            AND ${RESUMABLE_TELEGRAM_APP_HANDOFF_V2_SQL}
	          )
	          OR status = ANY($2::text[])
	          OR (
	            status = 'funding'
	            AND funding_operation_id IS NOT NULL
	            AND EXISTS (
	              SELECT 1
	                FROM funding_operations funding_operation
	               WHERE funding_operation.id = tti.funding_operation_id
	                 AND funding_operation.user_id = tti.user_id
	                 AND funding_operation.status <> ALL($3::text[])
	            )
	          )
	        )`,
    [
      telegramUserId,
      RESOLVING_NON_FUNDING_INTENT_STATUSES,
      TERMINAL_FUNDING_OPERATION_STATUSES,
    ],
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
    fundingOperationStatus: string | null;
    fundingProgressStage: string | null;
    intentId: string;
    marketTitle: string;
    status: string;
  }>
> {
  const result = await db.query<{
    action: TelegramBotTradingAction;
    age_minutes: string;
    funding_operation_status: string | null;
    funding_progress_stage: string | null;
    intent_id: string;
    market_title: string;
    status: string;
  }>(
    `SELECT
       tti.action,
       greatest(0, floor(extract(epoch FROM (now() - tti.created_at)) / 60))::text AS age_minutes,
       funding_operation.status AS funding_operation_status,
       funding_operation.progress_stage AS funding_progress_stage,
       tti.id::text AS intent_id,
       coalesce(m.title, tti.market_id) AS market_title,
       tti.status
     FROM telegram_trade_intents tti
     LEFT JOIN unified_markets m ON m.id = tti.market_id
     LEFT JOIN funding_operations funding_operation
       ON funding_operation.id = tti.funding_operation_id
     WHERE tti.telegram_user_id = $1
       AND (
         (tti.status = 'confirming' AND tti.expires_at > now())
         OR (
           tti.status in ('previewed', 'confirming', 'external_handoff')
           AND ${RESUMABLE_TELEGRAM_APP_HANDOFF_V2_SQL}
         )
         OR tti.status = ANY($2::text[])
         OR (
           tti.status = 'funding'
           AND funding_operation.id IS NOT NULL
           AND funding_operation.status <> ALL($3::text[])
         )
       )
     ORDER BY tti.created_at DESC
     LIMIT 5`,
    [
      telegramUserId,
      RESOLVING_NON_FUNDING_INTENT_STATUSES,
      TERMINAL_FUNDING_OPERATION_STATUSES,
    ],
  );
  return result.rows.map((row) => ({
    action: row.action,
    ageMinutes: Math.max(0, Number(row.age_minutes) || 0),
    fundingOperationStatus: row.funding_operation_status,
    fundingProgressStage: row.funding_progress_stage,
    intentId: row.intent_id,
    marketTitle: row.market_title,
    status: row.status,
  }));
}

function telegramFundingProgressLabel(
  stage: string | null,
  operationStatus?: string | null,
): string {
  if (
    operationStatus === "cancelled" ||
    operationStatus === "failed" ||
    operationStatus === "refunded"
  ) {
    return "Stopped — open to retry";
  }
  switch (stage) {
    case "committed":
      return "Queued";
    case "source_action":
    case "source_observed":
      return "Moving source funds";
    case "routing":
    case "intermediate_observed":
      return "Routing";
    case "destination_observed":
    case "venue_preparation":
      return "Finalizing";
    case "ready_for_consumer":
      return "Ready";
    default:
      return "Checking";
  }
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

async function lockTelegramFundingReturnContext(
  db: DbQuery,
  fundingContextId: string,
  telegramMessageId?: number,
): Promise<boolean> {
  const context = await db.query<{ receive_session_id: string }>(
    `select receive_session_id
       from telegram_funding_sessions
      where id = $1::uuid
      limit 1`,
    [fundingContextId],
  );
  const receiveSessionId = context.rows[0]?.receive_session_id;
  if (!receiveSessionId) return false;
  const receive = await db.query(
    `select id
       from funding_receive_sessions
      where id = $1::uuid
      for update`,
    [receiveSessionId],
  );
  if ((receive.rowCount ?? 0) !== 1) return false;
  const lockedContext = await db.query(
    `select id
       from telegram_funding_sessions
      where id = $1::uuid
        and receive_session_id = $2::uuid
        and ($3::bigint is null or telegram_message_id = $3::bigint)
      for update`,
    [fundingContextId, receiveSessionId, telegramMessageId ?? null],
  );
  return (lockedContext.rowCount ?? 0) === 1;
}

async function lockTelegramFundingReturnBeforeMarket(
  db: DbQuery,
  input: Readonly<{
    fundingContextId: string;
    marketId: string;
    telegramMessageId?: number;
    telegramUserId: string;
  }>,
): Promise<boolean> {
  const fundingLocked = await lockTelegramFundingReturnContext(
    db,
    input.fundingContextId,
    input.telegramMessageId,
  );
  await lockTelegramIntentMarket(db, input);
  return fundingLocked;
}

async function loadCurrentTelegramIntentAuthorityLocked(input: {
  db: DbQuery;
  expectedAuthorization: TelegramBotTradingAuthorizationRow;
  intent: TelegramTradeIntentRow;
  validateFundingReturn?: boolean;
}): Promise<TelegramBotTradingAuthorizationRow | null> {
  const currentAuthorization =
    input.intent.delivery_mode === "app_handoff"
      ? await loadEnabledEvmAuthorization(
          input.db,
          input.intent.telegram_user_id,
          {
            // A sealed v2 handoff is user-executed in the Mini App. It must
            // keep the verified wallet binding, but is intentionally allowed
            // to exist while unattended bot trading is off.
            allowInactiveForV2:
              readTelegramAppHandoffV2Plan(input.intent) != null,
            lock: true,
          },
        )
      : await loadEnabledAuthorization(
          input.db,
          input.intent.telegram_user_id,
          input.intent.venue,
          { lock: true },
        );
  if (
    currentAuthorization?.id !== input.expectedAuthorization.id ||
    !intentMatchesTelegramTradeAuthority({
      authorization: currentAuthorization,
      intent: input.intent,
    })
  ) {
    return null;
  }
  if (
    input.validateFundingReturn &&
    readTelegramFundingIntentContextMarker(input.intent) &&
    !(await isTelegramFundingIntentSourceCurrent(
      input.db,
      input.intent,
      currentAuthorization,
      { lockGeneration: true },
    ))
  ) {
    return null;
  }
  return currentAuthorization;
}

async function withLockedTelegramIntentAuthority<T>(input: {
  callback: (
    db: DbQuery,
    authorization: TelegramBotTradingAuthorizationRow | null,
  ) => Promise<T>;
  db: DbQuery;
  expectedAuthorization: TelegramBotTradingAuthorizationRow;
  intent: TelegramTradeIntentRow;
  validateFundingReturn?: boolean;
}): Promise<T> {
  return withOptionalTransaction(input.db, async (client) => {
    const fundingMarker = readTelegramFundingIntentContextMarker(input.intent);
    let fundingLocked = true;
    if (fundingMarker) {
      fundingLocked = await lockTelegramFundingReturnBeforeMarket(client, {
        fundingContextId: fundingMarker.fundingContextId,
        marketId: input.intent.market_id,
        telegramUserId: input.intent.telegram_user_id,
      });
    } else {
      await lockTelegramIntentMarket(client, {
        marketId: input.intent.market_id,
        telegramUserId: input.intent.telegram_user_id,
      });
    }
    if (!fundingLocked) {
      return input.callback(client, null);
    }
    const authorization = await loadCurrentTelegramIntentAuthorityLocked({
      db: client,
      expectedAuthorization: input.expectedAuthorization,
      intent: input.intent,
      validateFundingReturn: input.validateFundingReturn,
    });
    return input.callback(client, authorization);
  });
}

async function transitionIntentToConfirming(input: {
  allowAppHandoffFunding?: boolean;
  authorization: TelegramBotTradingAuthorizationRow;
  beforeConfirmLocked?: (
    db: DbQuery,
    currentAuthorization: TelegramBotTradingAuthorizationRow,
  ) => Promise<boolean>;
  db: DbQuery;
  intent: TelegramTradeIntentRow;
  onDirectAppHandoffReviewSelected?: (
    db: DbQuery,
    currentAuthorization: TelegramBotTradingAuthorizationRow,
  ) => Promise<void>;
}): Promise<"authority_changed" | "blocked" | "confirmed" | "overtaken"> {
  if (
    input.intent.delivery_mode !== "bot_submit" &&
    !(
      input.allowAppHandoffFunding === true &&
      input.intent.delivery_mode === "app_handoff" &&
      input.intent.action === "buy"
    ) &&
    !(
      input.onDirectAppHandoffReviewSelected &&
      input.intent.delivery_mode === "app_handoff"
    )
  ) {
    return "overtaken";
  }
  return withLockedTelegramIntentAuthority({
    callback: async (client, currentAuthorization) => {
      if (!currentAuthorization) {
        await updateIntentStatus({
          allowedStatuses: ["draft", "previewed"],
          db: client,
          errorCode: "authority_changed",
          errorMessage: "Telegram trade authority changed before confirmation.",
          intentId: input.intent.id,
          status: "failed",
        });
        return "authority_changed";
      }
      if (
        input.beforeConfirmLocked &&
        !(await input.beforeConfirmLocked(client, currentAuthorization))
      ) {
        await updateIntentStatus({
          allowedStatuses: ["draft", "previewed"],
          db: client,
          errorCode: "funding_continuation_stale",
          errorMessage: "Funding continuation changed before confirmation.",
          intentId: input.intent.id,
          status: "failed",
        });
        return "overtaken";
      }
      const unresolved = await loadUnresolvedTelegramTradeIntent(client, {
        excludeIntentId: input.intent.id,
        marketId: input.intent.market_id,
        telegramUserId: input.intent.telegram_user_id,
      });
      if (unresolved) return "blocked";
      const cancelSupersededPendingIntents = () =>
        client.query(
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
      if (input.onDirectAppHandoffReviewSelected) {
        // Direct v2 must remain `previewed` until commit attaches the
        // constraint-valid execution marker. Issue its deterministic token
        // while this same market/authority lock is held so two concurrent
        // intents cannot both publish executable Reviews.
        await input.onDirectAppHandoffReviewSelected(
          client,
          currentAuthorization,
        );
        await cancelSupersededPendingIntents();
        return "confirmed";
      }
      const confirming = await updateIntentStatus({
        allowedStatuses: ["draft", "previewed"],
        db: client,
        intentId: input.intent.id,
        status: "confirming",
      });
      if (!confirming) return "overtaken";
      await cancelSupersededPendingIntents();
      return "confirmed";
    },
    db: input.db,
    expectedAuthorization: input.authorization,
    intent: input.intent,
  });
}

async function transitionIntentToExecuting(input: {
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  intent: TelegramTradeIntentRow;
}): Promise<"authority_changed" | "executing" | "overtaken"> {
  const committedAppHandoff =
    input.intent.delivery_mode === "app_handoff" &&
    readTelegramAppHandoffExecutionMarker(input.intent) != null;
  if (input.intent.delivery_mode !== "bot_submit" && !committedAppHandoff) {
    return "overtaken";
  }
  return withLockedTelegramIntentAuthority({
    callback: async (client, currentAuthorization) => {
      if (!currentAuthorization) {
        return "authority_changed";
      }
      return (await updateIntentStatus({
        allowedStatuses: ["confirming"],
        db: client,
        intentId: input.intent.id,
        status: "executing",
      }))
        ? "executing"
        : "overtaken";
    },
    db: input.db,
    expectedAuthorization: input.authorization,
    intent: input.intent,
    validateFundingReturn: true,
  });
}

async function markTelegramIntentSubmitBoundary(input: {
  allowPreviouslyStarted?: boolean;
  authorization: TelegramBotTradingAuthorizationRow;
  db: DbQuery;
  intent: TelegramTradeIntentRow;
  result: Record<string, unknown>;
}): Promise<boolean> {
  const committedAppHandoff =
    input.intent.delivery_mode === "app_handoff" &&
    readTelegramAppHandoffExecutionMarker(input.intent) != null;
  if (input.intent.delivery_mode !== "bot_submit" && !committedAppHandoff) {
    return false;
  }
  return withLockedTelegramIntentAuthority({
    callback: async (client, currentAuthorization) => {
      if (!currentAuthorization) return false;
      const currentIntent = await loadIntent(client, input.intent.id, {
        lock: true,
      });
      if (
        !currentIntent ||
        (currentIntent.delivery_mode !== "bot_submit" &&
          readTelegramAppHandoffExecutionMarker(currentIntent) == null) ||
        currentIntent.status !== "executing" ||
        !intentMatchesTelegramTradeAuthority({
          authorization: currentAuthorization,
          intent: currentIntent,
        }) ||
        JSON.stringify(
          readTelegramFundingIntentContextMarker(currentIntent),
        ) !==
          JSON.stringify(readTelegramFundingIntentContextMarker(input.intent))
      ) {
        return false;
      }
      if (currentIntent.submit_started_at != null) {
        return input.allowPreviouslyStarted === true;
      }
      return updateIntentStatus({
        allowedStatuses: ["executing"],
        db: client,
        intentId: currentIntent.id,
        markSubmitStarted: true,
        result: input.result,
        status: "executing",
      });
    },
    db: input.db,
    expectedAuthorization: input.authorization,
    intent: input.intent,
    validateFundingReturn: true,
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
    status.authorizations.length > 0
      ? escapeMarkdown(
          `${status.authorizations.length} managed wallet${status.authorizations.length === 1 ? "" : "s"} enabled`,
        )
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
    const terminalFundingIntent = resolvingIntents.some(
      (intent) =>
        intent.status === "funding" &&
        ["cancelled", "failed", "refunded"].includes(
          intent.fundingOperationStatus ?? "",
        ),
    );
    lines.push(
      "",
      `⏳ ${formatTelegramFieldMarkdownV2(
        "Resolving trades",
        String(unresolvedIntentCount),
      )}`,
      ...resolvingIntents.map(
        (intent) =>
          `• ${escapeMarkdown(
            `${intent.action.toUpperCase()} · ${intent.marketTitle} · ${telegramFundingProgressLabel(intent.fundingProgressStage, intent.fundingOperationStatus)} · ${intent.ageMinutes}m`,
          )}`,
      ),
      "",
      `🤖 ${formatTelegramFieldMarkdownV2(
        "User action required",
        terminalFundingIntent ? "Yes" : "No",
      )}`,
      formatTelegramItalicMarkdownV2(
        terminalFundingIntent
          ? "Open the stopped funding item below to return to the market safely."
          : "The bot is checking these trades automatically.",
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
  return {
    parse_mode: "MarkdownV2",
    ...(resolvingIntents.some(
      (intent) => intent.action === "buy" && intent.status === "funding",
    )
      ? {
          reply_markup: {
            inline_keyboard: resolvingIntents
              .filter(
                (intent) =>
                  intent.action === "buy" && intent.status === "funding",
              )
              .map((intent) => [
                {
                  callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:retry_buy:${intent.intentId}`,
                  text: `↩️ Open funding · ${intent.marketTitle.slice(0, 24)}`,
                },
              ]),
          },
        }
      : {}),
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
  writeTradeInputContext?: (
    input: TelegramBotTradeInputContext,
  ) => Promise<boolean>;
}): Promise<TelegramBotTradingMessage> {
  const telegramUserId = normalizeTelegramUserId(input.telegramUserId);
  const [policy, status, market] = await Promise.all([
    resolveTelegramBotTradingPolicy(input.db),
    getTelegramBotTradingStatus(
      input.db,
      telegramUserId,
      input.trading,
      input.signerInspector,
      { resolveActionReadiness: false },
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
  const v2MiniAppHandoffEnabled =
    input.telegramMiniAppEnabled === true &&
    isTelegramAppHandoffV2EnabledForVenue({
      contractVersion: policy.miniAppHandoffContractVersion,
      mode: policy.miniAppHandoffMode,
      venue: market.venue,
    });
  // Buy can create or consume funding. Sell is direct client execution and
  // must not inherit either Buy-only policy switch.
  const v2BuyHandoffPolicyEnabled =
    v2MiniAppHandoffEnabled &&
    policy.fundingReceiveEnabled &&
    policy.buyContinuationEnabled;
  // A v2 handoff is confirmed and signed by the user in the Mini App. Unlike
  // unattended bot submission, it needs a linked, verified EVM wallet but not
  // an active server-signer grant. V1 keeps its stricter enabled authority.
  const handoffAuthorization = v2MiniAppHandoffEnabled
    ? await loadEnabledEvmAuthorization(input.db, telegramUserId, {
        allowInactiveForV2: true,
      })
    : market.venue === "limitless"
      ? await loadEnabledEvmAuthorization(input.db, telegramUserId)
      : null;
  const buyAuthorization = authorization;
  const authorityBinding = authorization
    ? buildTelegramTradeAuthorityBinding(authorization)
    : null;
  // V1 Polymarket used the enabled trading authority for its sealed handoff.
  // V2 may instead use the same verified wallet while server trading is off.
  // Keep that compatibility explicit: direct execution always uses
  // `authorization`, whereas a sealed handoff uses this broader authority.
  const handoffAuthority = handoffAuthorization ?? authorization;
  const handoffAuthorityBinding = handoffAuthority
    ? buildTelegramTradeAuthorityBinding(handoffAuthority)
    : null;
  const marketOrderable = isMarketOrderable(market);
  const policyVenueAllowed = policy.tradingVenues.includes(market.venue);
  const authorizationVenues = filterVenuesForWalletChain(
    normalizeVenues(authorization?.enabled_venues ?? []),
    authorization?.wallet_chain,
  );
  const authorizationVenueAllowed =
    authorization != null && authorizationVenues.includes(market.venue);
  const buyExecutionCapability = resolveTelegramBuyExecutionCapability({
    venue: market.venue,
    walletChain:
      handoffAuthority?.wallet_chain ?? authorization?.wallet_chain ?? null,
  });
  const sellExecutionCapability = resolveTelegramTradeExecutionCapability({
    action: "sell",
    venue: market.venue,
    walletChain:
      handoffAuthority?.wallet_chain ?? authorization?.wallet_chain ?? null,
  });
  const sealedAppHandoffAvailable =
    v2BuyHandoffPolicyEnabled &&
    buyExecutionCapability.sealedAppHandoffExact &&
    handoffAuthorityBinding != null &&
    hasTelegramAppHandoffV2DirectMarketConsumer(market.venue);
  const sealedAppHandoffSellAvailable =
    v2MiniAppHandoffEnabled &&
    sellExecutionCapability.sealedAppHandoffExact &&
    handoffAuthorityBinding != null &&
    hasTelegramAppHandoffV2DirectMarketConsumer(market.venue);
  const [automationAllowed, buyAllowed, redeemAllowed, sellAllowed] =
    await Promise.all([
      venueLifecycleAllows(input.db, market.venue, "automation"),
      venueLifecycleAllows(input.db, market.venue, "increaseExposure"),
      venueLifecycleAllows(input.db, market.venue, "redeem"),
      venueLifecycleAllows(input.db, market.venue, "reduceExposure"),
    ]);
  const maxAmountUsd = effectiveMaxTradeAmountUsd(
    policy,
    buyAuthorization?.max_amount_usd ?? status.maxAmountUsd,
  );
  const focusedSide = input.context?.focusSide ?? null;
  const focusedPositionControlled = await (async () => {
    const wallet = input.context?.focusPositionWalletAddress?.trim();
    if (!wallet) return false;
    if (market.venue === "polymarket") {
      const controllerAuthorization = handoffAuthority ?? authorization;
      if (!controllerAuthorization) return false;
      const credentials = await AuthService.getVenueCredentialsInfo(
        controllerAuthorization.user_id,
        "polymarket",
        controllerAuthorization.wallet_address,
      ).catch(() => null);
      return Boolean(
        credentials?.funderAddress &&
        sameAccountAddress("evm:137", credentials.funderAddress, wallet),
      );
    }
    if (market.venue !== "limitless") return false;
    const controller =
      handoffAuthority?.wallet_address ?? authorization?.wallet_address;
    return Boolean(
      controller && sameAccountAddress("evm:8453", controller, wallet),
    );
  })();
  const unresolvedIntent = await loadUnresolvedTelegramTradeIntent(input.db, {
    marketId: market.id,
    telegramUserId,
  });
  const canAttemptSell = canAttemptSellSurface({
    authorizationEnabled: authorization?.enabled === true,
    authorizationHasPrivyWallet: Boolean(authorization?.privy_wallet_id),
    authorizationVenueAllowed,
    authorityBound: Boolean(
      sealedAppHandoffSellAvailable
        ? handoffAuthorityBinding
        : authorityBinding,
    ),
    automationAllowed,
    focusedPositionControlled,
    hasFocusedPosition: Boolean(input.context?.focusPositionId),
    isAdminTest: input.isAdminTest === true,
    marketOrderable,
    policyTradingEnabled: policy.tradingEnabled,
    policyVenueAllowed,
    publicBrowseOnly: input.publicBrowseOnly === true,
    sellActionAllowed: policy.tradingActions.includes("sell"),
    sellLifecycleAllowed: sellAllowed,
    tradingAvailable: Boolean(input.trading),
    unresolvedIntent: Boolean(unresolvedIntent),
    sealedAppHandoffAvailable: sealedAppHandoffSellAvailable,
    venue: market.venue,
  });
  const sellQuoteAuthorization = sealedAppHandoffSellAvailable
    ? (handoffAuthority ?? authorization)
    : authorization;
  const [buyReadiness, sellReadiness] = await Promise.all([
    resolveTelegramTradingReadiness({
      action: "BUY",
      authorization: buyAuthorization,
      market,
      status,
      trading: input.trading,
      venue: market.venue,
    }),
    canAttemptSell && sellQuoteAuthorization
      ? resolveTelegramTradingReadiness({
          action: "SELL",
          authorization: sellQuoteAuthorization,
          market: marketForCallbackReadiness("SELL", market),
          status,
          trading: input.trading,
          venue: market.venue,
        })
      : Promise.resolve(null),
  ]);
  const nominalPresetAmountsUsd = resolveTelegramBuyPresetAmountsUsd(
    policy.buyAmountPresetsUsd,
    sealedAppHandoffAvailable && policy.miniAppHandoffContractVersion >= 2
      ? policy.maxTradeAmountUsd
      : maxAmountUsd,
  );
  const minimumPresetAmountUsd = nominalPresetAmountsUsd[0] ?? null;
  const commonBuySurfaceReady =
    !input.isAdminTest &&
    !input.publicBrowseOnly &&
    !unresolvedIntent &&
    automationAllowed &&
    buyAllowed &&
    policy.tradingEnabled &&
    policy.tradingActions.includes("buy") &&
    (policyVenueAllowed || sealedAppHandoffAvailable) &&
    marketOrderable &&
    (authorization?.enabled === true || sealedAppHandoffAvailable) &&
    Boolean(
      authorization?.privy_wallet_id ?? handoffAuthority?.privy_wallet_id,
    ) &&
    Boolean(authorityBinding ?? handoffAuthorityBinding) &&
    (canPreviewBuyForReadiness(buyReadiness) || sealedAppHandoffAvailable) &&
    Boolean(input.trading);
  const buyDeliveryMode = resolveTelegramBuyDeliveryMode({
    capability: buyExecutionCapability,
    commonBuySurfaceReady,
    // A policy can allow v2 generally while a particular market still has no
    // exact web consumer (for example an AMM without its pre-broadcast
    // handoff boundary).  Delivery must use the same market-scoped fact as
    // the buttons and custom-input path; otherwise `always` advertises an
    // operation that cannot be completed safely.
    handoffContractAvailable: sealedAppHandoffAvailable,
    miniAppHandoffMode: policy.miniAppHandoffMode,
    telegramMiniAppEnabled: input.telegramMiniAppEnabled === true,
    venueAllowedForBotSubmit: authorizationVenueAllowed,
  });
  const sellDeliveryMode = resolveTelegramTradeDeliveryMode({
    action: "sell",
    capability: sellExecutionCapability,
    commonTradeSurfaceReady: canAttemptSell,
    handoffContractAvailable: sealedAppHandoffSellAvailable,
    miniAppHandoffMode: policy.miniAppHandoffMode,
    telegramMiniAppEnabled: input.telegramMiniAppEnabled === true,
    venueAllowedForBotSubmit: authorizationVenueAllowed,
  });
  const presetDeliveryModes = resolveTelegramBuyPresetDeliveryModes({
    directMaximumAmountUsd: maxAmountUsd,
    handoffAvailable: sealedAppHandoffAvailable,
    handoffContractVersion: policy.miniAppHandoffContractVersion,
    handoffMode: policy.miniAppHandoffMode,
    initialDeliveryMode: buyDeliveryMode,
    presetAmountsUsd: nominalPresetAmountsUsd,
  });
  const botPresetAmountsUsd = presetDeliveryModes
    .filter((preset) => preset.deliveryMode === "bot_submit")
    .map((preset) => preset.amountUsd);
  const handoffPresetAmountsUsd = presetDeliveryModes
    .filter((preset) => preset.deliveryMode === "app_handoff")
    .map((preset) => preset.amountUsd);
  const canBuildBotBuyOptions =
    buyDeliveryMode === "bot_submit" &&
    authorityBinding != null &&
    botPresetAmountsUsd.length > 0;
  const customBuyDeliveryMode: StoredTelegramBuyDeliveryMode | null =
    // A custom amount is unknown while its short-lived input context is
    // created. In v2, bind it to the sealed Mini App scope instead of trying
    // to guess whether it will fit the server-only envelope later.
    sealedAppHandoffAvailable && policy.miniAppHandoffContractVersion >= 2
      ? "app_handoff"
      : buyDeliveryMode === "bot_submit"
        ? "bot_submit"
        : null;
  const customBuyAuthority =
    customBuyDeliveryMode === "app_handoff"
      ? handoffAuthorityBinding
      : authorityBinding;
  const canBuildCustomBuy =
    !unresolvedIntent &&
    customBuyAuthority != null &&
    customBuyDeliveryMode != null &&
    policy.customTradeInputEnabled;
  const buyOptions =
    canBuildBotBuyOptions &&
    buyAuthorization &&
    input.trading &&
    botPresetAmountsUsd.length > 0
      ? (
          await Promise.all(
            botPresetAmountsUsd.flatMap((nominalAmountUsd) =>
              (["YES", "NO"] as const)
                .filter((side) => !focusedSide || side === focusedSide)
                .map((side) =>
                  resolveTelegramExecutableBuyOption({
                    authorization: buyAuthorization,
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
  type BuyButtonOption = Readonly<{
    amountUsd: number;
    authority: TelegramBotTradeAuthorityBinding;
    deliveryMode: StoredTelegramBuyDeliveryMode;
    side: TelegramBotTradingSide;
  }>;
  const buyButtonOptions: readonly BuyButtonOption[] = unresolvedIntent
    ? []
    : [
        ...buyOptions.map((option) => ({
          amountUsd: option.amountUsd,
          authority: authorityBinding as TelegramBotTradeAuthorityBinding,
          deliveryMode: "bot_submit" as const,
          side: option.side,
        })),
        ...(handoffAuthorityBinding
          ? handoffPresetAmountsUsd.flatMap((amountUsd) =>
              (["YES", "NO"] as const)
                .filter((side) => !focusedSide || side === focusedSide)
                .map((side) => ({
                  amountUsd,
                  authority: handoffAuthorityBinding,
                  deliveryMode: "app_handoff" as const,
                  side,
                })),
            )
          : []),
      ];
  const sellIntentAuthority =
    sellDeliveryMode === "app_handoff"
      ? handoffAuthorityBinding
      : authorityBinding;
  const canBuildSellOptions =
    !unresolvedIntent &&
    canAttemptSell &&
    sellIntentAuthority != null &&
    (sellDeliveryMode === "app_handoff" ||
      canOfferTradeForReadiness(sellReadiness));
  const sellResolutions =
    canBuildSellOptions && sellQuoteAuthorization && input.trading
      ? await Promise.all(
          (["YES", "NO"] as const)
            .filter((side) => !focusedSide || side === focusedSide)
            .map((side) =>
              resolveTelegramExecutableSellOptions({
                authorization: sellQuoteAuthorization,
                db: input.db,
                market,
                maxSlippageBps: policy.maxSlippageBps,
                side,
                trading: input.trading as ApiBotTradingExecutor,
              }),
            ),
        )
      : [];
  const sellOptions = sellResolutions.flatMap(
    (resolution) => resolution.options,
  );
  const customSellSides = resolveTelegramCustomSellSides(sellResolutions);
  const canBuildCustomSell =
    canBuildSellOptions &&
    policy.customTradeInputEnabled &&
    customSellSides.length > 0;
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
    authorityBinding &&
    (!input.context?.focusPositionId || focusedPositionControlled)
      ? await resolveTelegramPolymarketRedemptionPlan({
          authorization,
          market,
        }).catch(() => null)
      : null;
  const observedYesAsk = observedAsk(input.context?.observedYesAsk);
  const observedNoAsk = observedAsk(input.context?.observedNoAsk);
  const hasBotAction =
    buyButtonOptions.length > 0 ||
    sellOptions.length > 0 ||
    canBuildCustomBuy ||
    canBuildCustomSell ||
    Boolean(redeemPlan);
  const buyOperationPermitted =
    automationAllowed && buyAllowed && policy.tradingActions.includes("buy");
  const sellOperationPermitted =
    sellAllowed && policy.tradingActions.includes("sell") && canAttemptSell;
  const hasReadyPermittedTradeOperation =
    (buyOperationPermitted && canPreviewBuyForReadiness(buyReadiness)) ||
    (sellOperationPermitted && canOfferTradeForReadiness(sellReadiness));
  const canTradeInHunch = marketOrderable && buyAllowed;
  const knownExecutableFundsUsd =
    buyReadiness.maxExecutableBuyUsd != null &&
    Number.isFinite(buyReadiness.maxExecutableBuyUsd) &&
    buyReadiness.maxExecutableBuyUsd >= 0
      ? buyReadiness.maxExecutableBuyUsd
      : hasInsufficientFundsReason(buyReadiness)
        ? 0
        : null;
  const depositNeeded =
    !input.publicBrowseOnly &&
    status.linked &&
    marketOrderable &&
    market.venue === "polymarket" &&
    minimumPresetAmountUsd != null &&
    (hasInsufficientFundsReason(buyReadiness) ||
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
  if (buyButtonOptions.length > 0) {
    lines.push("Choose side and amount to spend:");
  }
  if (input.isAdminTest) {
    lines.push("", "Preview only - trade buttons are not created.");
  } else if (unresolvedIntent) {
    lines.push(
      "",
      unresolvedIntent.app_handoff_state === "issued"
        ? "Your exact trade Review is still waiting. Restore it below to inspect the same amount, side, and limits before confirming."
        : unresolvedIntent.status === "funding"
          ? "An existing Buy is still preparing funds. Continue, check its status, or cancel the Buy below."
          : unresolvedIntent.status === "external_handoff"
            ? "A confirmed trade is waiting in Hunch. Continue it or cancel it below."
            : EXISTING_TRADE_RESOLVING_MESSAGE,
    );
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
  } else if (
    !status.enabled &&
    !sealedAppHandoffAvailable &&
    !sealedAppHandoffSellAvailable
  ) {
    lines.push(
      "",
      policy.tradingEnabled && policyVenueAllowed
        ? "Trade in Hunch now, or enable Telegram Trading for direct trades here."
        : policy.tradingEnabled
          ? "Trade this market in Hunch. You can also enable Telegram Trading for supported venues."
          : `Direct bot trading is disabled. ${hunchFallbackCopy}`,
    );
  } else if (
    !policyVenueAllowed &&
    buyDeliveryMode !== "app_handoff" &&
    !sealedAppHandoffSellAvailable
  ) {
    lines.push(
      "",
      `Direct bot trading is not enabled for ${formatTelegramVenueLabel(market.venue)}. ${hunchFallbackCopy}`,
    );
  } else if (
    buyDeliveryMode === "app_handoff" ||
    handoffPresetAmountsUsd.length > 0
  ) {
    lines.push(
      "",
      "Build the quote and fund the shortfall here. The final Buy opens in Hunch with this market, side, and amount selected.",
    );
  } else if (!authorizationVenueAllowed && !sealedAppHandoffSellAvailable) {
    lines.push(
      "",
      policy.tradingEnabled && policyVenueAllowed
        ? "Trade in Hunch now, or enable this venue in Telegram Trading."
        : `This Trading Wallet is not enabled for direct bot trading on this venue. ${hunchFallbackCopy}`,
    );
  } else if (sealedAppHandoffSellAvailable && !sealedAppHandoffAvailable) {
    lines.push("Open Hunch to continue a protected Sell.");
  } else if (
    (buyOperationPermitted || sellOperationPermitted) &&
    buyOptions.length === 0 &&
    sellOptions.length === 0 &&
    !canBuildCustomBuy &&
    !canBuildCustomSell &&
    !redeemPlan &&
    !hasReadyPermittedTradeOperation
  ) {
    lines.push(
      "",
      (buyOperationPermitted ? buyReadiness.message : null) ??
        (sellOperationPermitted ? sellReadiness?.message : null) ??
        "Direct bot execution is not ready yet. Open Hunch to trade.",
    );
  } else if (
    policy.tradingActions.includes("buy") &&
    policy.buyAmountPresetsUsd.length === 0 &&
    sellOptions.length === 0 &&
    !canBuildCustomBuy &&
    !canBuildCustomSell &&
    !redeemPlan
  ) {
    lines.push("", "No bot buy presets are configured.");
  } else if (canBuildBotBuyOptions && buyOptions.length === 0) {
    lines.push(
      "",
      `No executable buy fits your ${formatUsd(maxAmountUsd)} maximum total spend.`,
    );
  }
  if (depositNeeded && market.venue === "polymarket") {
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
  if (
    buyButtonOptions.length > 0 ||
    sellOptions.length > 0 ||
    canBuildCustomBuy ||
    canBuildCustomSell ||
    redeemPlan
  ) {
    lines.push("", `Buttons valid for ${formatTtl(policy.intentTtlSec)}.`);
  }
  if (input.telegramMiniAppEnabled !== true) {
    lines.push("", "Mini App temporarily unavailable.");
  }

  const keyboard: TelegramBotTradingButton[][] = [];
  const createCustomInputButton = async (
    action: "buy" | "sell",
    side: TelegramBotTradingSide,
  ): Promise<TelegramBotTradingButton | null> => {
    const contextVenue = telegramShortfallVenue(market.venue);
    if (
      !input.writeTradeInputContext ||
      !contextVenue ||
      !(action === "buy" ? customBuyAuthority : sellIntentAuthority)
    ) {
      return null;
    }
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() + policy.intentTtlSec * 1_000,
    );
    const written = await input
      .writeTradeInputContext({
        action,
        authority:
          action === "buy"
            ? (customBuyAuthority as TelegramBotTradeAuthorityBinding)
            : (sellIntentAuthority as TelegramBotTradeAuthorityBinding),
        chatId: String(input.chatId),
        controlledPositionId: input.context?.focusPositionId ?? null,
        createdAt: createdAt.toISOString(),
        eventId: market.event_id,
        expiresAt: expiresAt.toISOString(),
        funderAddress:
          input.context?.focusPositionWalletAddress ??
          (action === "buy"
            ? customBuyDeliveryMode === "app_handoff"
              ? handoffAuthority?.wallet_address
              : buyAuthorization?.wallet_address
            : sellQuoteAuthorization?.wallet_address) ??
          null,
        id,
        marketId: market.id,
        messageScope:
          input.telegramMessageId == null
            ? { kind: "new_message_unbound" }
            : {
                kind: "exact_message",
                messageId: input.telegramMessageId,
              },
        side,
        telegramUserId,
        deliveryMode:
          action === "buy"
            ? (customBuyDeliveryMode as StoredTelegramBuyDeliveryMode)
            : sellDeliveryMode === "app_handoff"
              ? "app_handoff"
              : "bot_submit",
        venue: contextVenue,
        version: 2,
      })
      .catch(() => false);
    if (!written) return null;
    const callbackAction = action === "buy" ? "buy_input" : "sell_input";
    const callbackData = `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:${callbackAction}:${id}`;
    if (Buffer.byteLength(callbackData, "utf8") > 64) return null;
    return {
      callback_data: callbackData,
      icon_custom_emoji_id: formatTelegramVenueButtonIcon(market.venue),
      text:
        input.context?.origin === "position"
          ? `${action === "buy" ? "Buy" : "Sell"} · Custom amount`
          : `${action === "buy" ? "Custom buy" : "Custom sell"} · ${sideLabel(market, side)}`,
    };
  };
  const customBuyRow: TelegramBotTradingButton[] = [];
  for (const side of ["YES", "NO"] as const) {
    const row: TelegramBotTradingButton[] = [];
    for (const option of buyButtonOptions.filter(
      (candidate) => candidate.side === side,
    )) {
      const intentId = await insertBuyIntent({
        amountUsd: option.amountUsd,
        authority: option.authority,
        chatId: String(input.chatId),
        db: input.db,
        deliveryMode: option.deliveryMode,
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
    if (canBuildCustomBuy && (!focusedSide || side === focusedSide)) {
      const customButton = await createCustomInputButton("buy", side);
      if (customButton) customBuyRow.push(customButton);
    }
  }
  if (customBuyRow.length > 0) keyboard.push(customBuyRow);
  const customSellRow: TelegramBotTradingButton[] = [];
  for (const side of ["YES", "NO"] as const) {
    for (const option of sellOptions.filter(
      (candidate) => candidate.side === side,
    )) {
      const intentId = await insertSellIntent({
        authority: sellIntentAuthority as TelegramBotTradeAuthorityBinding,
        chatId: String(input.chatId),
        db: input.db,
        deliveryMode:
          sellDeliveryMode === "app_handoff" ? "app_handoff" : "bot_submit",
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
          text: (() => {
            const proceeds = isTelegramEstimatedSellProceeds(option.quote)
              ? `Estimated ≈ ${formatUsd(option.minimumReceiveUsd)}`
              : `Receive ≥ ${formatUsd(option.minimumReceiveUsd)}`;
            return input.context?.origin === "position"
              ? `Sell ${option.sellPercent}% · ${proceeds}`
              : `Sell ${option.sellPercent}% ${sideLabel(market, option.side)} · ${formatLivePrice(option.currentPrice) ?? "live"} · ${proceeds}`;
          })(),
        },
      ]);
    }
    if (canBuildCustomSell && customSellSides.includes(side)) {
      const customButton = await createCustomInputButton("sell", side);
      if (customButton) customSellRow.push(customButton);
    }
  }
  if (customSellRow.length > 0) keyboard.push(customSellRow);
  if (redeemPlan) {
    const intentId = await insertRedeemIntent({
      authority: authorityBinding as TelegramBotTradeAuthorityBinding,
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
  if (!input.isAdminTest && unresolvedIntent) {
    if (
      canContinueTelegramAppHandoffFromMarket(unresolvedIntent) &&
      unresolvedIntent.user_id &&
      env.telegramBotToken
    ) {
      const startParam = buildTelegramAppHandoffStartParamForIntent({
        telegramUserId,
        tokenSecret: env.telegramBotToken,
        tradeIntentId: unresolvedIntent.id,
        userId: unresolvedIntent.user_id,
      });
      const continueButton = buildMiniAppButton({
        startParam,
        text: `Continue ${unresolvedIntent.action === "sell" ? "Sell" : "Buy"} in Hunch`,
      });
      if (continueButton) keyboard.push([continueButton]);
    }
    keyboard.push([
      {
        callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:retry_buy:${unresolvedIntent.id}`,
        text:
          unresolvedIntent.app_handoff_state === "issued"
            ? "🔄 Restore Review"
            : "🔄 Check status",
      },
    ]);
    if (
      unresolvedIntent.status === "funding" ||
      unresolvedIntent.status === "external_handoff"
    ) {
      keyboard.push([
        {
          callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:cancel:${unresolvedIntent.id}`,
          text: `❌ Cancel ${unresolvedIntent.action === "sell" ? "Sell" : "Buy"}`,
        },
      ]);
    }
  }
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
    if (sellOptions.length === 0 && !canBuildCustomSell && marketOrderable) {
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
  if (!input.isAdminTest && !input.publicBrowseOnly) {
    if (input.context?.returnCallbackData) {
      keyboard.push([
        { callback_data: input.context.returnCallbackData, text: "⬅️ Back" },
      ]);
    } else {
      keyboard.push([{ callback_data: "hm:v1:home", text: "🏠 Home" }]);
    }
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
    text: joinTelegramMarkdownV2Lines(renderedLines),
  };
}

async function loadIntentBy(
  db: DbQuery,
  selector: "id" | "idempotency_key",
  value: string,
  options: { lock?: boolean } = {},
): Promise<TelegramTradeIntentRow | null> {
  const result = await db.query<TelegramTradeIntentRow>(
    `SELECT
       i.id,
       i.telegram_user_id,
       i.user_id,
       i.authorization_id,
       i.chat_id,
       i.delivery_mode,
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
       i.funding_operation_id,
       i.funding_reservation_id,
       i.quote_snapshot,
       i.policy_snapshot,
       i.result,
       i.idempotency_key,
       i.expires_at,
       m.title AS market_title,
       m.status::text AS market_status
     FROM telegram_trade_intents i
     JOIN unified_markets m ON m.id = i.market_id
     WHERE i.${selector} = $1
     LIMIT 1
     ${options.lock ? "FOR UPDATE OF i" : ""}`,
    [value],
  );
  const row = result.rows[0];
  return row
    ? {
        ...row,
        delivery_mode:
          row.delivery_mode === "app_handoff" ? "app_handoff" : "bot_submit",
      }
    : null;
}

async function loadIntent(
  db: DbQuery,
  intentId: string,
  options: { lock?: boolean } = {},
): Promise<TelegramTradeIntentRow | null> {
  return loadIntentBy(db, "id", intentId, options);
}

async function loadIntentByIdempotencyKey(
  db: DbQuery,
  idempotencyKey: string,
): Promise<TelegramTradeIntentRow | null> {
  return loadIntentBy(db, "idempotency_key", idempotencyKey);
}

async function updateIntentStatus(input: {
  allowedStatuses?: string[];
  allowRecoverableFinalization?: boolean;
  authorizationId?: string;
  db: DbQuery;
  deliveryMode?: StoredTelegramBuyDeliveryMode;
  errorCode?: string;
  errorMessage?: string;
  requireRetryableAppHandoffFundingInspection?: boolean;
  executionId?: string | null;
  intentId: string;
  orderId?: string | null;
  preparedSnapshot?: Record<string, unknown> | null;
  preserveClaimedAppHandoff?: boolean;
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
            delivery_mode = coalesce($16::text, delivery_mode),
            authorization_id = coalesce($17::uuid, authorization_id),
            error_code = $3,
            error_message = $4,
            result = CASE
              WHEN $5::jsonb IS NULL THEN result
              ELSE coalesce(result, '{}'::jsonb) || $5::jsonb
            END,
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
          NOT $19::boolean
          OR NOT (
            delivery_mode = 'app_handoff'
            AND (
              coalesce(
                result #>> '{appHandoffConsent,version}' = '2',
                false
              )
              OR coalesce(
                result #>> '{appHandoffExecution,version}' = '2',
                false
              )
            )
          )
        )
        AND (
          NOT $18::boolean
          OR (
            delivery_mode = 'app_handoff'
            AND status = 'previewed'
            AND submit_started_at IS NULL
            AND funding_operation_id IS NULL
            AND result ->> 'stage' = 'funding_preview'
            AND result ->> 'fundingState' = ANY($20::text[])
            AND NOT (result ? 'appHandoffV2')
          )
        )
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
      input.deliveryMode ?? null,
      input.authorizationId ?? null,
      Boolean(input.requireRetryableAppHandoffFundingInspection),
      Boolean(input.preserveClaimedAppHandoff),
      [...RETRYABLE_TELEGRAM_APP_HANDOFF_FUNDING_STATES],
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
  failedInactiveFunding: number;
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
  const failedInactiveFunding = await db.query(
    `UPDATE telegram_trade_intents funding_intent
        SET status = 'failed',
            error_code = coalesce(error_code, 'funding_no_longer_active'),
            error_message = coalesce(
              error_message,
              'Funding stopped before the Buy could continue. No trade was submitted.'
            ),
            updated_at = now()
      WHERE funding_intent.status = 'funding'
        AND funding_intent.submit_started_at IS NULL
        AND ($1::text IS NULL OR funding_intent.telegram_user_id = $1)
        AND NOT EXISTS (
          SELECT 1
            FROM funding_operations funding_operation
           WHERE funding_operation.id = funding_intent.funding_operation_id
             AND funding_operation.user_id = funding_intent.user_id
             AND funding_operation.status <> ALL($2::text[])
        )
      RETURNING funding_intent.id`,
    [telegramUserId, TERMINAL_FUNDING_OPERATION_STATUSES],
  );
  const expiredPending = await db.query(
    `UPDATE telegram_trade_intents pending_intent
        SET status = 'expired',
            error_code = coalesce(error_code, 'intent_expired'),
            error_message = coalesce(error_message, 'Trade intent expired before confirmation.'),
            updated_at = now()
      WHERE pending_intent.status = ANY($1::text[])
        AND pending_intent.expires_at <= $2
        AND ($3::text IS NULL OR pending_intent.telegram_user_id = $3)
        AND (
          pending_intent.delivery_mode <> 'app_handoff'
          OR (
            pending_intent.submit_started_at IS NULL
            AND pending_intent.submitted_at IS NULL
            AND pending_intent.funding_operation_id IS NULL
            AND pending_intent.funding_reservation_id IS NULL
            AND pending_intent.order_id IS NULL
            AND pending_intent.execution_id IS NULL
            AND pending_intent.venue_order_id IS NULL
            AND pending_intent.tx_signature IS NULL
            AND jsonb_typeof(
              pending_intent.result -> 'appHandoffExecution'
            ) IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM telegram_app_handoffs active_handoff
               WHERE active_handoff.trade_intent_id = pending_intent.id
                 -- Claim is the one-click consent boundary. From this point
                 -- the handoff's own TTL, not the short Review quote TTL,
                 -- bounds client resume and commit.
                 AND active_handoff.state in ('claimed', 'committed')
            )
          )
        )
      RETURNING id`,
    [PENDING_INTENT_STATUSES, now, telegramUserId],
  );
  // Handoff tokens are passive DB rows and never need the one-second funding
  // worker cadence. The global job calls this stale-intent reconcile every 60
  // seconds; user-scoped calls clean only that Telegram account on demand.
  await expireStaleTelegramAppHandoffs(db, {
    limit: telegramUserId == null ? 100 : 25,
    now,
    telegramUserId,
  });
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
    failedInactiveFunding: failedInactiveFunding.rowCount ?? 0,
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

function normalizeTelegramTradeAuthorityWalletAddress(input: {
  walletAddress: string;
  walletChain: TelegramBotTradingWalletChain;
}): string {
  return canonicalWalletIdentity(input.walletChain, input.walletAddress);
}

function buildTelegramTradeAuthorityBinding(
  authorization: TelegramBotTradingAuthorizationRow,
): TelegramBotTradeAuthorityBinding | null {
  if (
    !authorization.id ||
    !authorization.privy_wallet_id ||
    !authorization.telegram_account_link_id ||
    !authorization.user_id ||
    !authorization.wallet_address
  ) {
    return null;
  }
  return {
    authorizationId: authorization.id,
    privyWalletId: authorization.privy_wallet_id,
    telegramAccountLinkId: authorization.telegram_account_link_id,
    userId: authorization.user_id,
    walletAddress: normalizeTelegramTradeAuthorityWalletAddress({
      walletAddress: authorization.wallet_address,
      walletChain: authorization.wallet_chain,
    }),
    walletChain: authorization.wallet_chain,
  };
}

/**
 * Returns the policy and EVM authority scope that a sealed Mini App handoff
 * must still match when its web consumer claims or executes it. It deliberately
 * does not require the unattended venue allowlist: the exact bot-confirmed
 * handoff is a separate, narrowly scoped authority boundary.
 */
export async function resolveTelegramAppHandoffCurrentScope(input: {
  action?: "buy" | "sell";
  db: DbQuery;
  telegramUserId: string;
  venue: TelegramBotTradingVenue;
  executionContractVersion?: 1 | 2;
}): Promise<{ authorityFingerprint: string; policyRevision: string } | null> {
  const supported =
    input.executionContractVersion === 2
      ? isTelegramAppHandoffV2TradeVenue(input.venue)
      : isTelegramSealedAppHandoffVenue(input.venue);
  if (!supported) return null;
  const [policyState, authorization] = await Promise.all([
    resolveSignalBotTradingPolicyStateFromDb(input.db),
    loadEnabledEvmAuthorization(input.db, input.telegramUserId, {
      // V2 is user-executed after Telegram confirmation. Keep V1 tied to the
      // direct bot grant, but let V2 use the verified linked controller even
      // when its unattended signer is intentionally disabled.
      allowInactiveForV2: input.executionContractVersion === 2,
    }),
  ]);
  const authority = authorization
    ? buildTelegramTradeAuthorityBinding(authorization)
    : null;
  const action = input.action ?? "buy";
  if (
    !telegramAppHandoffPolicyAllows({
      action,
      executionContractVersion: input.executionContractVersion ?? 1,
      policy: policyState.policy,
    }) ||
    !authority
  ) {
    return null;
  }
  return {
    authorityFingerprint: telegramBotTradeAuthorityFingerprint(authority),
    policyRevision: policyState.policyRevision,
  };
}

function telegramAppHandoffPolicyAllows(input: {
  action: "buy" | "sell";
  executionContractVersion: 1 | 2;
  policy: SignalBotPolicy;
}): boolean {
  if (
    input.policy.miniAppHandoffMode === "off" ||
    input.policy.miniAppHandoffContractVersion < input.executionContractVersion
  ) {
    return false;
  }
  // A sealed Sell has no funding route and is client-signed. Do not make its
  // exact handoff depend on Buy-only receive/continuation switches.
  return input.action === "buy"
    ? input.policy.buyContinuationEnabled && input.policy.fundingReceiveEnabled
    : input.policy.tradingEnabled &&
        input.policy.tradingActions.includes("sell");
}

/** Shared live-scope fence for ordinary web venue consumers of a v2 handoff. */
export async function matchesTelegramAppHandoffV2CurrentScope(input: {
  db: DbQuery;
  sealed: Readonly<{
    action: "buy" | "sell";
    authorityFingerprint: string;
    policyRevision: string;
    telegramUserId: string;
    tradeIntentId: string;
    venue: TelegramAppHandoffV2TradeVenue;
  }>;
}): Promise<boolean> {
  const intent = await loadIntent(input.db, input.sealed.tradeIntentId);
  const plan = intent ? readTelegramAppHandoffV2Plan(intent) : null;
  const trade = plan && isRecord(plan.trade) ? plan.trade : null;
  if (
    !intent ||
    !plan ||
    !trade ||
    intent.delivery_mode !== "app_handoff" ||
    intent.telegram_user_id !== input.sealed.telegramUserId ||
    intent.action !== input.sealed.action ||
    intent.venue !== input.sealed.venue ||
    trade.action !== input.sealed.action ||
    trade.venue !== input.sealed.venue ||
    trade.marketId !== intent.market_id
  ) {
    return false;
  }
  const expectedAuthorization = await loadEnabledEvmAuthorization(
    input.db,
    input.sealed.telegramUserId,
    { allowInactiveForV2: true },
  );
  const expectedAuthority = expectedAuthorization
    ? buildTelegramTradeAuthorityBinding(expectedAuthorization)
    : null;
  if (
    !expectedAuthorization ||
    !expectedAuthority ||
    telegramBotTradeAuthorityFingerprint(expectedAuthority) !==
      input.sealed.authorityFingerprint ||
    !intentMatchesTelegramTradeAuthority({
      authorization: expectedAuthorization,
      intent,
    })
  ) {
    return false;
  }
  return withLockedTelegramIntentAuthority({
    callback: async (client, currentAuthorization) => {
      if (!currentAuthorization) return false;
      const currentIntent = await loadIntent(client, intent.id, { lock: true });
      if (
        !currentIntent ||
        currentIntent.delivery_mode !== "app_handoff" ||
        currentIntent.action !== input.sealed.action ||
        currentIntent.venue !== input.sealed.venue ||
        currentIntent.telegram_user_id !== input.sealed.telegramUserId ||
        JSON.stringify(
          readTelegramFundingIntentContextMarker(currentIntent),
        ) !== JSON.stringify(readTelegramFundingIntentContextMarker(intent))
      ) {
        return false;
      }
      const policyState =
        await resolveSignalBotTradingPolicyStateFromDb(client);
      const currentAuthority =
        buildTelegramTradeAuthorityBinding(currentAuthorization);
      return Boolean(
        currentAuthority &&
        telegramAppHandoffPolicyAllows({
          action: input.sealed.action,
          executionContractVersion: 2,
          policy: policyState.policy,
        }) &&
        policyState.policyRevision === input.sealed.policyRevision &&
        telegramBotTradeAuthorityFingerprint(currentAuthority) ===
          input.sealed.authorityFingerprint,
      );
    },
    db: input.db,
    expectedAuthorization,
    intent,
    validateFundingReturn: true,
  });
}

export function telegramVenueFromSealedHandoffSnapshot(
  snapshot: Record<string, unknown>,
): TelegramBotTradingVenue | null {
  // V1 stores trade fields at the snapshot root. V2 seals the same fields
  // beneath `trade` with the funding scope, so read the immutable venue from
  // its versioned location rather than treating a valid v2 handoff as broken.
  const venue =
    snapshot.version === 2 && isRecord(snapshot.trade)
      ? snapshot.trade.venue
      : snapshot.venue;
  return venue === "polymarket" || venue === "limitless" || venue === "kalshi"
    ? venue
    : null;
}

function sameTelegramTradeAuthorityBinding(
  binding: TelegramBotTradeAuthorityBinding,
  authorization: TelegramBotTradingAuthorizationRow | null,
): boolean {
  const current = authorization
    ? buildTelegramTradeAuthorityBinding(authorization)
    : null;
  return Boolean(
    current &&
    current.authorizationId === binding.authorizationId &&
    current.privyWalletId === binding.privyWalletId &&
    current.telegramAccountLinkId === binding.telegramAccountLinkId &&
    current.userId === binding.userId &&
    current.walletAddress === binding.walletAddress &&
    current.walletChain === binding.walletChain,
  );
}

function readIntentAuthorityBinding(
  intent: TelegramTradeIntentRow,
): TelegramBotTradeAuthorityBinding | null {
  const raw =
    isRecord(intent.result) && isRecord(intent.result.telegramAuthority)
      ? intent.result.telegramAuthority
      : null;
  if (!raw || raw.version !== 1) return null;
  return parseTelegramBotTradeAuthorityBinding(raw);
}

function buildIntentAuthorityResult(
  binding: TelegramBotTradeAuthorityBinding,
): Record<string, unknown> {
  return { telegramAuthority: { ...binding, version: 1 } };
}

/**
 * A v2 handoff may use the verified controller after the user's Telegram
 * confirmation, without granting the bot an unattended signer. Keep the
 * binding comparison in one place so direct and funding handoffs cannot
 * accidentally seal different wallets.
 */
async function resolveTelegramAppHandoffV2Authorization(input: {
  db: DbQuery;
  originalAuthorization: TelegramBotTradingAuthorizationRow;
  telegramUserId: string;
}): Promise<Readonly<{
  authorization: TelegramBotTradingAuthorizationRow;
  binding: TelegramBotTradeAuthorityBinding;
}> | null> {
  const authorization = await loadEnabledEvmAuthorization(
    input.db,
    input.telegramUserId,
    { allowInactiveForV2: true },
  );
  const binding = authorization
    ? buildTelegramTradeAuthorityBinding(authorization)
    : null;
  const original = buildTelegramTradeAuthorityBinding(
    input.originalAuthorization,
  );
  if (
    !authorization ||
    !binding ||
    !original ||
    binding.userId !== original.userId ||
    binding.privyWalletId !== original.privyWalletId ||
    binding.telegramAccountLinkId !== original.telegramAccountLinkId ||
    binding.walletChain !== original.walletChain ||
    binding.walletAddress !== original.walletAddress
  ) {
    return null;
  }
  return { authorization, binding };
}

function readTelegramAppHandoffExecutionMarker(
  intent: TelegramTradeIntentRow,
): { committedAt: string; handoffId: string; version: 1 | 2 } | null {
  const marker = isRecord(intent.result.appHandoffExecution)
    ? intent.result.appHandoffExecution
    : null;
  if (
    !marker ||
    (marker.version !== 1 && marker.version !== 2) ||
    typeof marker.committedAt !== "string" ||
    !marker.committedAt.trim() ||
    typeof marker.handoffId !== "string" ||
    !marker.handoffId.trim()
  ) {
    return null;
  }
  return {
    committedAt: marker.committedAt,
    handoffId: marker.handoffId,
    version: marker.version,
  };
}

function intentMatchesTelegramTradeAuthority(input: {
  authorization: TelegramBotTradingAuthorizationRow | null;
  intent: TelegramTradeIntentRow;
}): boolean {
  const binding = readIntentAuthorityBinding(input.intent);
  return Boolean(
    binding &&
    input.intent.user_id === binding.userId &&
    input.intent.authorization_id === binding.authorizationId &&
    sameTelegramTradeAuthorityBinding(binding, input.authorization),
  );
}

async function loadEnabledAuthorization(
  db: DbQuery,
  telegramUserId: string,
  venue: TelegramBotTradingVenue,
  options: { lock?: boolean } = {},
): Promise<TelegramBotTradingAuthorizationRow | null> {
  const walletChain = venue === "kalshi" ? "solana" : "ethereum";
  const result = await db.query<TelegramBotTradingAuthorizationRow>(
    `SELECT
       a.id,
       uta.id::text AS telegram_account_link_id,
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
     JOIN users app_user
       ON app_user.id = a.user_id
      AND coalesce(app_user.is_active, true) = true
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
      AND funding_account_identifier_equal(
            a.wallet_chain,
            uw.wallet_address,
            a.wallet_address
          )
     WHERE a.telegram_user_id = $1
       AND a.enabled = true
       AND a.wallet_chain = $2
       AND $3 = ANY(a.enabled_venues)
     LIMIT 1
     ${options.lock ? "FOR UPDATE OF a, app_user, p, uta, uw" : ""}`,
    [telegramUserId, walletChain, venue],
  );
  return result.rows[0] ?? null;
}

async function loadEnabledEvmAuthorization(
  db: DbQuery,
  telegramUserId: string,
  options: { allowInactiveForV2?: boolean; lock?: boolean } = {},
): Promise<TelegramBotTradingAuthorizationRow | null> {
  // The legacy name is intentionally retained because its default remains the
  // v1/server-safe query. `allowInactiveForV2` is a narrow exception for an
  // already user-confirmed v2 handoff: it preserves the same verified-wallet
  // identity checks while omitting only unattended-server enablement.
  const allowInactiveForV2 = options.allowInactiveForV2 === true;
  const result = await db.query<TelegramBotTradingAuthorizationRow>(
    `SELECT
       funding_auth.id,
       telegram_account.id::text AS telegram_account_link_id,
       funding_auth.user_id,
       funding_auth.telegram_user_id,
       funding_auth.privy_user_id,
       funding_auth.wallet_address,
       funding_auth.wallet_chain,
       funding_auth.privy_wallet_id,
       funding_auth.enabled,
       funding_auth.enabled_venues,
       funding_auth.limits,
       funding_auth.max_amount_usd
     FROM telegram_bot_trading_authorizations funding_auth
     JOIN users app_user
       ON app_user.id = funding_auth.user_id
      AND coalesce(app_user.is_active, true) = true
     JOIN telegram_bot_trading_preferences trading_preference
       ON trading_preference.user_id = funding_auth.user_id
      AND ($2::boolean OR trading_preference.desired_enabled = true)
     JOIN user_telegram_accounts telegram_account
       ON telegram_account.telegram_user_id = funding_auth.telegram_user_id
      AND telegram_account.user_id = funding_auth.user_id
     JOIN user_wallets verified_wallet
       ON verified_wallet.user_id = funding_auth.user_id
      AND verified_wallet.wallet_type = funding_auth.wallet_chain
      AND verified_wallet.is_verified = true
      AND funding_account_identifier_equal(
            funding_auth.wallet_chain,
            verified_wallet.wallet_address,
            funding_auth.wallet_address
          )
     WHERE funding_auth.telegram_user_id = $1
       AND ($2::boolean OR funding_auth.enabled = true)
       AND funding_auth.wallet_chain = 'ethereum'
     ORDER BY funding_auth.updated_at DESC, funding_auth.id
     LIMIT 1
     ${
       options.lock
         ? "FOR UPDATE OF funding_auth, app_user, trading_preference, telegram_account, verified_wallet"
         : ""
     }`,
    [telegramUserId, allowInactiveForV2],
  );
  return result.rows[0] ?? null;
}

type TelegramFundingProgressPresentation =
  Parameters<TelegramFundingProgressDecorator>[0];

function isRetainedSolFundingProgress(
  progress: TelegramFundingProgressPresentation["progress"],
): boolean {
  const routeKey = progress?.presentation?.routeKey;
  return (
    typeof routeKey === "string" &&
    isTelegramSolanaRetainedFundingRouteKey(routeKey)
  );
}

async function decorateRetainedSolReceiptEstimate(input: {
  estimateRetainedSolUsd?: (raw: string) => Promise<string | null>;
  invalidateAccountValue?: (userId: string) => void;
  presentation: TelegramFundingProgressPresentation;
}): Promise<TelegramFundingProgressPresentation["message"]> {
  const progress = input.presentation.progress;
  if (
    !progress ||
    !["funds_received", "ready"].includes(progress.state) ||
    !isRetainedSolFundingProgress(progress) ||
    !progress.rawAmount ||
    !isRawAmount(progress.rawAmount) ||
    progress.rawAmount === "0" ||
    !input.estimateRetainedSolUsd
  ) {
    return input.presentation.message;
  }
  try {
    input.invalidateAccountValue?.(input.presentation.context.userId);
    const estimatedUsd = await input.estimateRetainedSolUsd(progress.rawAmount);
    return estimatedUsd
      ? {
          ...input.presentation.message,
          text: joinTelegramMarkdownV2Lines([
            input.presentation.message.text,
            "",
            formatTelegramFieldMarkdownV2(
              "Approximate value",
              `≈ ${formatTelegramAccountValueUsd(estimatedUsd)}`,
            ),
          ]),
        }
      : input.presentation.message;
  } catch {
    // The canonical receipt is authoritative. Optional valuation must never
    // hide it or delay the retained-source continuation.
    return input.presentation.message;
  }
}

export function createTelegramFundingBuyContinuationDecorator(input: {
  appBaseUrl?: string;
  estimateRetainedSolUsd?: (raw: string) => Promise<string | null>;
  inspectMiniAppFunding?: TelegramBotTradingCallbackInput["inspectMiniAppFunding"];
  invalidateAccountValue?: (userId: string) => void;
  pool: Pool;
  trading: ApiBotTradingExecutor;
}): TelegramFundingProgressDecorator {
  return async (presentation) => {
    const fundingSurfaceMessage = await decorateRetainedSolReceiptEstimate({
      estimateRetainedSolUsd: input.estimateRetainedSolUsd,
      invalidateAccountValue: input.invalidateAccountValue,
      presentation,
    });
    // Late direct receipts remain visible and owned after cancellation or
    // expiry, but a closed receive context must never create a new Buy plan.
    if (!canContinueTelegramFundingBuyReturn(presentation)) {
      return fundingSurfaceMessage;
    }
    const buyReturn = await fetchActiveTelegramFundingBuyReturn(
      input.pool,
      presentation.context.id,
    );
    const continuationVenue =
      buyReturn?.venueId === "polymarket" || buyReturn?.venueId === "limitless"
        ? buyReturn.venueId
        : null;
    const continuationAdapter = buyReturn
      ? resolveTelegramFundingBuyContinuationAdapter({
          destinationAsset: presentation.session.destinationAsset,
          venueId: presentation.session.venueId,
        })
      : null;
    if (
      !buyReturn ||
      !continuationVenue ||
      presentation.session.venueId !== continuationVenue ||
      buyReturn.destinationOptionId !==
        presentation.session.destinationOptionId ||
      buyReturn.venueBindingOptionId !==
        presentation.session.venueBindingOptionId ||
      !continuationAdapter ||
      continuationAdapter.tradingVenue !== continuationVenue ||
      !presentation.context.telegramAccountId ||
      buyReturn.telegramAccountIdSnapshot !==
        presentation.context.telegramAccountId
    ) {
      return fundingSurfaceMessage;
    }
    if (
      presentation.progress?.state === "cancelled" ||
      presentation.progress?.state === "expired" ||
      presentation.progress?.state === "unavailable" ||
      presentation.progress?.state === "needs_attention"
    ) {
      return fundingSurfaceMessage;
    }
    const [policyState, authorization, market] = await Promise.all([
      resolveSignalBotTradingPolicyStateFromDb(input.pool),
      buyReturn.continuationMode === "app_handoff"
        ? loadEnabledEvmAuthorization(
            input.pool,
            presentation.context.telegramUserId,
            {
              // The user signs a sealed v2 plan in the Mini App. Keep the
              // exact linked controller binding, but do not hide that plan
              // merely because unattended bot execution is disabled.
              allowInactiveForV2: true,
            },
          )
        : loadEnabledAuthorization(
            input.pool,
            presentation.context.telegramUserId,
            continuationVenue,
          ),
      loadMarketById(input.pool, buyReturn.marketId),
    ]);
    const policy = policyState.policy;
    const authority = authorization
      ? buildTelegramTradeAuthorityBinding(authorization)
      : null;
    if (
      !policy.buyContinuationEnabled ||
      !policy.fundingReceiveEnabled ||
      !policy.tradingEnabled ||
      !policy.tradingActions.includes("buy") ||
      (buyReturn.continuationMode === "bot_submit" &&
        !policy.tradingVenues.includes(continuationVenue)) ||
      !authorization ||
      !authority ||
      telegramBotTradeAuthorityFingerprint(authority) !==
        buyReturn.sourceAuthorityFingerprint ||
      authorization.telegram_account_link_id !==
        presentation.context.telegramAccountId ||
      !authorization.privy_wallet_id ||
      !market ||
      market.venue !== continuationVenue ||
      !isMarketOrderable(market) ||
      (buyReturn.continuationMode === "bot_submit" &&
        !isVenueAllowed(
          continuationVenue,
          policy,
          filterVenuesForWalletChain(
            normalizeVenues(authorization.enabled_venues),
            authorization.wallet_chain,
          ),
        )) ||
      (buyReturn.continuationMode === "app_handoff" &&
        !isTelegramSealedAppHandoffVenue(continuationVenue))
    ) {
      return fundingSurfaceMessage;
    }
    const maxAmountUsd = resolveTelegramBuyIntentMaximumAmountUsd({
      authorizationMaxAmountUsd: authorization.max_amount_usd,
      deliveryMode: buyReturn.continuationMode,
      policy,
      venue: continuationVenue,
    });
    const requestedSpendUsd = Number(buyReturn.requestedSpendUsd);
    if (
      !Number.isFinite(requestedSpendUsd) ||
      requestedSpendUsd <= 0 ||
      requestedSpendUsd > maxAmountUsd
    ) {
      return fundingSurfaceMessage;
    }
    const quoteIntent = buildTelegramTradeIntent({
      amountUsd: requestedSpendUsd,
      authorization,
      intentId: crypto.randomUUID(),
      market,
      maxSlippageBps: policy.maxSlippageBps,
      side: buyReturn.side,
    });
    let quote: TradeQuote | null = null;
    let readiness: TradingReadiness | null = null;
    try {
      [quote, readiness] = await Promise.all([
        input.trading.quote({ intent: quoteIntent }),
        resolveTelegramTradingReadiness({
          action: "BUY",
          authorization,
          market,
          trading: input.trading,
          venue: continuationVenue,
        }),
      ]);
    } catch {
      quote = null;
      readiness = null;
    }
    const quoteLimits = quote
      ? resolveTelegramTradeQuoteLimits({
          amountUsd: requestedSpendUsd,
          intent: quoteIntent,
          quote,
        })
      : null;
    const quoteExpiresAt = quote?.expiresAt
      ? new Date(quote.expiresAt).getTime()
      : Number.NaN;
    const progressState = presentation.progress?.state ?? null;
    const retainedSolSourceReady =
      progressState === "funds_received" &&
      isRetainedSolFundingProgress(presentation.progress);
    const destinationSymbol =
      continuationVenue === "polymarket" ? "pUSD" : "USDC";
    const continuationVenueLabel = formatTelegramVenueLabel(continuationVenue);
    const withFundingCallout = (callout: {
      bodyMarkdownV2: string | string[];
      icon: string;
      title: string;
    }) => ({
      ...fundingSurfaceMessage,
      text: joinTelegramMarkdownV2Lines([
        formatTelegramCalloutMarkdownV2(callout),
        "",
        fundingSurfaceMessage.text,
      ]),
    });
    const liveQuoteUsable = Boolean(
      !readiness || !quoteLimits
        ? false
        : Number.isFinite(quoteExpiresAt) &&
            quoteExpiresAt > presentation.now.getTime() &&
            !quoteLimits.venueMinimumBlocking &&
            quoteLimits.maxSpendUsd != null &&
            Number.isFinite(quoteLimits.maxSpendUsd) &&
            quoteLimits.maxSpendUsd > 0 &&
            quoteLimits.maxSpendUsd + 0.000_001 >= requestedSpendUsd &&
            quoteLimits.maxSpendUsd <= maxAmountUsd &&
            readiness.maxExecutableBuyUsd != null &&
            Number.isFinite(readiness.maxExecutableBuyUsd) &&
            readiness.maxExecutableBuyUsd >= 0 &&
            canPreviewBuyForDelivery({
              deliveryMode: buyReturn.continuationMode,
              readiness,
            }),
    );
    if (
      !liveQuoteUsable &&
      progressState !== "ready" &&
      !retainedSolSourceReady
    ) {
      return withFundingCallout({
        bodyMarkdownV2: [
          formatTelegramUsdcLineMarkdownV2(
            `Order: ${formatUsd(requestedSpendUsd)}`,
          ),
          escapeMarkdown(
            "The current required deposit could not be calculated safely. Tap Refresh before sending.",
          ),
        ],
        icon: "⚠️",
        title: "Amount temporarily unavailable",
      });
    }
    const requiredUsd = liveQuoteUsable
      ? (quoteLimits?.maxSpendUsd ?? null)
      : null;
    const fundingRequirement =
      liveQuoteUsable &&
      readiness?.maxExecutableBuyUsd != null &&
      requiredUsd != null
        ? resolveTelegramFundingBuyDepositRequirement({
            executableFundsUsd: readiness.maxExecutableBuyUsd,
            maximumSpendUsd: requiredUsd,
          })
        : null;
    if (
      fundingRequirement?.state === "deposit" &&
      progressState !== "ready" &&
      !retainedSolSourceReady
    ) {
      return withFundingCallout({
        bodyMarkdownV2: [
          formatTelegramUsdcLineMarkdownV2(
            `Order: ${formatUsd(requestedSpendUsd)}`,
          ),
          formatTelegramUsdcLineMarkdownV2(
            `Maximum spend now: ${formatUsd(requiredUsd ?? requestedSpendUsd)}`,
          ),
          formatTelegramUsdcLineMarkdownV2(
            `Available at ${continuationVenueLabel}: ${formatUsd(fundingRequirement.availableUsd)}`,
          ),
          formatTelegramUsdcLineMarkdownV2(
            `Send at least: ${fundingRequirement.sendAtLeastPusd.toLocaleString(
              "en-US",
              {
                maximumFractionDigits: 2,
                minimumFractionDigits: 2,
              },
            )} ${destinationSymbol}`,
          ),
          escapeMarkdown(
            buyReturn.continuationMode === "bot_submit"
              ? "Then tap Refresh. The Buy still requires Review and Confirm."
              : "Then tap Refresh. The final Buy opens in Hunch for review.",
          ),
        ],
        icon: "💰",
        title: "Funding for this Buy",
      });
    }
    if (
      progressState !== "ready" &&
      fundingRequirement?.state === "ready" &&
      !retainedSolSourceReady
    ) {
      return withFundingCallout({
        bodyMarkdownV2: [
          formatTelegramUsdcLineMarkdownV2(
            `Order: ${formatUsd(requestedSpendUsd)}`,
          ),
          ...(requiredUsd == null
            ? []
            : [
                formatTelegramUsdcLineMarkdownV2(
                  `Maximum spend now: ${formatUsd(requiredUsd)}`,
                ),
              ]),
          formatTelegramUsdcLineMarkdownV2(
            `Available at ${continuationVenueLabel}: ${formatUsd(fundingRequirement.availableUsd)}`,
          ),
          escapeMarkdown(
            buyReturn.continuationMode === "bot_submit"
              ? `No additional ${destinationSymbol} is required now. Tap Refresh to continue. The Buy still requires Review and Confirm.`
              : `No additional ${destinationSymbol} is required now. Tap Refresh to continue in Hunch.`,
          ),
        ],
        icon: "💰",
        title: "Funding for this Buy",
      });
    }
    if (
      !retainedSolSourceReady &&
      !(await hasReadyTelegramFundingDestinationReceipt(
        input.pool,
        presentation.context.id,
      ))
    ) {
      return fundingSurfaceMessage;
    }
    if (buyReturn.continuationMode === "app_handoff") {
      if (
        !quote ||
        !readiness ||
        !liveQuoteUsable ||
        (!retainedSolSourceReady && fundingRequirement?.state !== "ready")
      ) {
        return withFundingCallout({
          bodyMarkdownV2: escapeMarkdown(
            `Funding is ready, but the ${continuationVenueLabel} balance or quote is still syncing. Tap Refresh shortly.`,
          ),
          icon: "⏳",
          title: "Preparing app review",
        });
      }
      const handoffIdempotencyKey = [
        "telegram-funding-handoff",
        presentation.context.id,
        buyReturn.revision,
      ].join(":");
      const handoffIntentId = crypto.randomUUID();
      await input.pool.query(
        `insert into telegram_trade_intents (
           id,
           telegram_user_id,
           user_id,
           authorization_id,
           chat_id,
           telegram_message_id,
           delivery_mode,
           action,
           venue,
           market_id,
           event_id,
           side,
           amount_usd,
           status,
           quote_snapshot,
           policy_snapshot,
           result,
           expires_at,
           idempotency_key
         ) values (
           $1, $2, $3, $4, $5, $6, 'app_handoff', 'buy', $7, $8, $9, $10,
           $11::numeric, 'draft', '{}'::jsonb, $12::jsonb, $13::jsonb, $14, $15
         )
         on conflict (idempotency_key) do nothing`,
        [
          handoffIntentId,
          presentation.context.telegramUserId,
          authorization.user_id,
          authorization.id,
          presentation.context.chatId,
          presentation.context.telegramMessageId,
          continuationVenue,
          buyReturn.marketId,
          buyReturn.eventId,
          buyReturn.side,
          buyReturn.requestedSpendUsd,
          JSON.stringify(buildPolicySnapshot(policy)),
          JSON.stringify({
            ...buildIntentAuthorityResult(authority),
            telegramFundingHandoff: {
              fundingContextId: presentation.context.id,
              policyRevision: policyState.policyRevision,
              returnRevision: buyReturn.revision,
              version: 1,
            },
          }),
          new Date(presentation.now.getTime() + policy.intentTtlSec * 1_000),
          handoffIdempotencyKey,
        ],
      );
      const handoffIntent = await loadIntentByIdempotencyKey(
        input.pool,
        handoffIdempotencyKey,
      );
      if (!handoffIntent) return fundingSurfaceMessage;
      let handoffMessage: TelegramBotTradingMessage | null = null;
      if (handoffIntent.status === "external_handoff") {
        const storedQuote = readTelegramTradeQuotePreview(
          handoffIntent.quote_snapshot,
        );
        const v2Plan = readTelegramAppHandoffV2Plan(handoffIntent);
        if (storedQuote && v2Plan) {
          handoffMessage = await issueTelegramTradeAppHandoffMessage({
            authorization,
            db: input.pool,
            intent: handoffIntent,
            market,
            policy,
            quote: storedQuote,
            v2Plan,
          });
        }
      } else if (
        ["draft", "previewed", "confirming"].includes(handoffIntent.status)
      ) {
        const messages: TelegramBotTradingMessage[] = [];
        await previewTelegramTradeIntent({
          appBaseUrl: normalizeBaseUrl(
            input.appBaseUrl ?? "https://app.hunch.trade",
          ),
          authorization,
          beforeConfirmLocked: (client, currentAuthorization) =>
            isTelegramFundingHandoffIntentCurrent(
              client,
              handoffIntent,
              currentAuthorization,
            ),
          chatId: presentation.context.chatId,
          db: input.pool,
          estimateRetainedSolUsd: input.estimateRetainedSolUsd,
          fundingReturnResume: !retainedSolSourceReady,
          inspectMiniAppFunding: retainedSolSourceReady
            ? input.inspectMiniAppFunding
            : undefined,
          intent: handoffIntent,
          market,
          maxAmountUsd,
          policy,
          quoteOverride: quote,
          readiness,
          sendMessage: async (message) => {
            messages.push(message);
            return undefined;
          },
          telegramMiniAppEnabled: true,
          trading: input.trading,
        });
        const refreshedIntent = retainedSolSourceReady
          ? await loadIntentByIdempotencyKey(input.pool, handoffIdempotencyKey)
          : null;
        const refreshedPlan = refreshedIntent
          ? readTelegramAppHandoffV2Plan(refreshedIntent)
          : null;
        const sealedFundingHandoffReady =
          refreshedPlan?.kind === "funding" &&
          (refreshedIntent?.status === "confirming" ||
            refreshedIntent?.status === "external_handoff");
        const sealedDirectHandoffReady =
          refreshedPlan?.kind === "direct_trade" &&
          refreshedIntent?.status === "previewed";
        const safePlannerOutcome =
          refreshedIntent?.status === "previewed" &&
          refreshedIntent.submit_started_at == null &&
          refreshedIntent.result.stage === "funding_preview" &&
          isRetryableTelegramAppHandoffFundingState(
            refreshedIntent.result.fundingState,
          ) &&
          !isRecord(refreshedIntent.result.appHandoffV2);
        // A retained source receipt is not sufficient by itself. Only expose
        // Continue in Hunch after the normal generic planner has durably
        // sealed a v2 plan for this exact intent. Insufficient and retryable
        // planner outcomes are also authoritative copy for this same card;
        // hiding them behind stale "preparing" text would be misleading.
        handoffMessage =
          !retainedSolSourceReady ||
          sealedFundingHandoffReady ||
          sealedDirectHandoffReady ||
          safePlannerOutcome
            ? (messages.at(-1) ?? null)
            : null;
      }
      if (!handoffMessage) return presentation.message;
      return {
        ...handoffMessage,
        text: joinTelegramMarkdownV2Lines([
          presentation.message.text,
          "",
          handoffMessage.text,
        ]),
      };
    }
    let issued: Awaited<ReturnType<typeof issueTelegramFundingBuyContinuation>>;
    try {
      issued = await issueTelegramFundingBuyContinuation({
        pool: input.pool,
        contextId: presentation.context.id,
        returnRevision: buyReturn.revision,
        progressRevision: presentation.context.progressRevision,
        receiveVersion: presentation.session.version,
        telegramAccountId: presentation.context.telegramAccountId,
        telegramUserId: presentation.context.telegramUserId,
        chatId: presentation.context.chatId,
        policyRevision: policyState.policyRevision,
        validateBeforeIssue: async (client) => {
          const current =
            await resolveSignalBotTradingPolicyStateFromDb(client);
          return (
            current.policyRevision === policyState.policyRevision &&
            current.policy.buyContinuationEnabled &&
            current.policy.tradingEnabled &&
            current.policy.tradingActions.includes("buy") &&
            current.policy.tradingVenues.includes(continuationVenue)
          );
        },
        now: presentation.now,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "telegram_funding_buy_continuation_stale"
      ) {
        return presentation.message;
      }
      throw error;
    }
    const reviewButton = buildTelegramFundingReviewBuyButton({
      continuationToken: issued.token,
    });
    const changeAmountButton = buildTelegramFundingChangeBuyAmountButton({
      continuationToken: issued.token,
    });
    return {
      ...presentation.message,
      reply_markup: {
        inline_keyboard: [
          [reviewButton],
          [changeAmountButton],
          ...(presentation.message.reply_markup?.inline_keyboard ?? []),
        ],
      },
      text: joinTelegramMarkdownV2Lines([
        presentation.message.text,
        "",
        `🎯 ${formatTelegramFieldMarkdownV2(
          "Buy",
          `${market.title} · ${sideLabel(market, buyReturn.side)}`,
        )}`,
        formatTelegramUsdcLineMarkdownV2(
          `Order: ${formatUsd(requestedSpendUsd)}`,
        ),
        ...(requiredUsd == null
          ? []
          : [
              formatTelegramUsdcLineMarkdownV2(
                `Maximum spend now: ${formatUsd(requiredUsd)}`,
              ),
            ]),
        "",
        formatTelegramCalloutMarkdownV2({
          bodyMarkdownV2: escapeMarkdown(
            fundingRequirement?.state === "ready"
              ? "A fresh quote will be built after Review Buy. The order is not submitted until you press Confirm."
              : "The deposit is confirmed. Polymarket balance may still be syncing; Review Buy safely rechecks it and never submits before Confirm.",
          ),
          icon: "ℹ️",
          title:
            fundingRequirement?.state === "ready"
              ? "Funds are ready"
              : "Funds received",
        }),
      ]),
    };
  };
}

export async function changeTelegramFundingBuyContinuationAmount(input: {
  appBaseUrl: string;
  chatId: string;
  db: DbQuery;
  telegramMessageId: number;
  telegramMiniAppEnabled?: boolean;
  telegramUserId: string;
  token: string;
  signerInspector?: TelegramBotTradingSignerInspector;
  trading: ApiBotTradingExecutor;
  writeTradeInputContext?: (
    input: TelegramBotTradeInputContext,
  ) => Promise<boolean>;
}): Promise<TelegramBotTradingMessage> {
  const unavailable = () =>
    buildTelegramTradeInputNotice({
      body: "Open the market again to choose a new amount.",
      title: "Amount selection unavailable",
    });
  if (input.chatId !== input.telegramUserId) return unavailable();
  const { rows } = await input.db.query<{
    funding_context_id: string;
    latest_terminal_projection: unknown;
    market_id: string;
    side: TelegramBotTradingSide;
  }>(
    `
      select
        context.id as funding_context_id,
        context.latest_terminal_projection,
        buy_return.market_id,
        buy_return.side
      from telegram_funding_buy_continuations continuation
      join telegram_funding_sessions context
        on context.id = continuation.telegram_funding_session_id
       and context.active_buy_return_revision = continuation.buy_return_revision
       and context.progress_revision = continuation.ready_progress_revision
       and context.telegram_account_id = continuation.telegram_account_id
      join telegram_funding_buy_return_revisions buy_return
        on buy_return.telegram_funding_session_id = continuation.telegram_funding_session_id
       and buy_return.revision = continuation.buy_return_revision
       and buy_return.venue_id = 'polymarket'
      join funding_receive_sessions receive
        on receive.id = context.receive_session_id
       and receive.user_id = context.user_id
       and receive.owner_channel = context.receive_owner_channel
       and receive.version >= continuation.ready_receive_version
      where continuation.token_hash = $1
        and continuation.telegram_user_id = $2
        and continuation.chat_id = $3
        and context.telegram_user_id = $2
        and context.chat_id = $3
        and context.telegram_message_id = $4::bigint
        and continuation.expires_at > now()
        and context.cancelled_at is null
        and context.expires_at > now()
        and context.latest_progress_projection->>'state' = 'ready'
        and context.latest_terminal_projection = context.latest_progress_projection
      limit 1
    `,
    [
      hashTelegramFundingBuyContinuationToken(input.token),
      input.telegramUserId,
      input.chatId,
      input.telegramMessageId,
    ],
  );
  const current = rows[0];
  if (
    !current ||
    !isTelegramFundingReadyTerminalProjection(
      current.latest_terminal_projection,
      current.funding_context_id,
    ) ||
    !(await hasReadyTelegramFundingDestinationReceipt(
      input.db,
      current.funding_context_id,
    ))
  ) {
    return unavailable();
  }
  return buildTelegramBotTradingMarketMessage({
    appBaseUrl: input.appBaseUrl,
    chatId: input.chatId,
    context: {
      focusSide: current.side,
      origin: "direct",
    },
    db: input.db,
    marketRef: current.market_id,
    signerInspector: input.signerInspector,
    telegramMessageId: input.telegramMessageId,
    telegramMiniAppEnabled: input.telegramMiniAppEnabled,
    telegramUserId: input.telegramUserId,
    trading: input.trading,
    writeTradeInputContext: input.writeTradeInputContext,
  });
}

export async function resumeTelegramFundingBuyContinuation(input: {
  appBaseUrl: string;
  chatId: string;
  db: DbQuery;
  estimateRetainedSolUsd?: (raw: string) => Promise<string | null>;
  idempotencyKey: string;
  telegramMessageId: number;
  telegramMiniAppEnabled?: boolean;
  telegramUserId: string;
  token: string;
  trading: ApiBotTradingExecutor;
}): Promise<TelegramBotTradingMessage> {
  const unavailable = (body: string, title = "Review unavailable") =>
    buildTelegramTradeInputNotice({ body, title });
  if (input.chatId !== input.telegramUserId) {
    return unavailable("Open the original private bot chat.");
  }
  const tokenHash = hashTelegramFundingBuyContinuationToken(input.token);
  const lookup = await input.db.query<{
    destination_option_id: string;
    market_id: string;
    telegram_funding_session_id: string;
    user_id: string;
    venue_binding_option_id: string;
  }>(
    `
      select
        continuation.telegram_funding_session_id,
        buy_return.market_id,
        context.user_id,
        receive.destination_option_id,
        receive.venue_binding_option_id
      from telegram_funding_buy_continuations continuation
      join telegram_funding_sessions context
        on context.id = continuation.telegram_funding_session_id
      join telegram_funding_buy_return_revisions buy_return
        on buy_return.telegram_funding_session_id = continuation.telegram_funding_session_id
       and buy_return.revision = continuation.buy_return_revision
      join funding_receive_sessions receive
        on receive.id = context.receive_session_id
       and receive.user_id = context.user_id
      where continuation.token_hash = $1
      limit 1
    `,
    [tokenHash],
  );
  const scoped = lookup.rows[0];
  if (!scoped)
    return unavailable("This Review Buy button is invalid or expired.");
  const requestFingerprint = canonicalJsonHash({
    action: "resume_buy",
    chatId: input.chatId,
    contextId: scoped.telegram_funding_session_id,
    telegramMessageId: input.telegramMessageId,
    telegramUserId: input.telegramUserId,
    tokenHash,
  });

  let intentId: string;
  try {
    intentId = await withOptionalTransaction(input.db, async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          [
            "funding-receive-session",
            scoped.user_id,
            scoped.destination_option_id,
            scoped.venue_binding_option_id,
          ].join(":"),
        ],
      );
      const fundingLocked = await lockTelegramFundingReturnBeforeMarket(
        client,
        {
          fundingContextId: scoped.telegram_funding_session_id,
          marketId: scoped.market_id,
          telegramMessageId: input.telegramMessageId,
          telegramUserId: input.telegramUserId,
        },
      );
      if (!fundingLocked) {
        throw new Error("telegram_funding_buy_continuation_invalid");
      }
      const replay = await client.query<{
        action: string;
        request_fingerprint: string;
        resume_intent_id: string | null;
      }>(
        `
          select action, request_fingerprint, resume_intent_id
          from telegram_funding_mutations
          where idempotency_key = $1
          limit 1
        `,
        [input.idempotencyKey],
      );
      const replayed = replay.rows[0];
      if (replayed) {
        if (
          replayed.action !== "resume_buy" ||
          replayed.request_fingerprint !== requestFingerprint ||
          !replayed.resume_intent_id
        ) {
          throw new Error("telegram_funding_idempotency_conflict");
        }
        return replayed.resume_intent_id;
      }

      const continuation = await fetchTelegramFundingBuyContinuationForUpdate(
        client,
        input.token,
      );
      if (!continuation) {
        throw new Error("telegram_funding_buy_continuation_invalid");
      }
      const current = await client.query<{
        active_buy_return_revision: number | null;
        cancelled_at: Date | null;
        chat_id: string;
        destination_asset: Record<string, unknown>;
        destination_option_id: string;
        expires_at: Date;
        latest_progress_projection: Record<string, unknown> | null;
        latest_terminal_projection: unknown;
        progress_revision: number;
        receive_session_id: string;
        receive_version: string | number;
        resume_generation: number;
        resume_intent_id: string | null;
        telegram_account_id: string | null;
        telegram_user_id: string;
        user_id: string;
        venue_binding_option_id: string;
        venue_id: string;
      }>(
        `
          select
            context.active_buy_return_revision,
            context.cancelled_at,
            context.chat_id,
            context.expires_at,
            context.latest_progress_projection,
            context.latest_terminal_projection,
            context.progress_revision,
            context.receive_session_id,
            context.resume_generation,
            context.resume_intent_id,
            context.telegram_account_id,
            context.telegram_user_id,
            context.user_id,
            receive.destination_asset,
            receive.destination_option_id,
            receive.venue_binding_option_id,
            receive.venue_id,
            receive.version as receive_version
          from telegram_funding_sessions context
          join funding_receive_sessions receive
            on receive.id = context.receive_session_id
           and receive.user_id = context.user_id
           and receive.owner_channel = context.receive_owner_channel
          where context.id = $1
            and context.latest_progress_projection ->> 'state' = 'ready'
            and context.latest_terminal_projection =
                context.latest_progress_projection
          for update of context, receive
        `,
        [continuation.fundingContextId],
      );
      const context = current.rows[0];
      const now = new Date();
      if (
        !context ||
        context.user_id !== scoped.user_id ||
        context.telegram_user_id !== input.telegramUserId ||
        context.chat_id !== input.chatId ||
        context.telegram_account_id == null ||
        context.telegram_account_id !== continuation.telegramAccountId ||
        context.active_buy_return_revision !== continuation.buyReturnRevision ||
        context.progress_revision !== continuation.readyProgressRevision ||
        Number(context.receive_version) < continuation.readyReceiveVersion ||
        context.cancelled_at != null ||
        context.expires_at.getTime() <= now.getTime() ||
        continuation.expiresAt <= now.toISOString() ||
        context.venue_id !== "polymarket" ||
        context.destination_option_id !== scoped.destination_option_id ||
        context.venue_binding_option_id !== scoped.venue_binding_option_id ||
        context.latest_progress_projection?.state !== "ready" ||
        !isTelegramFundingReadyTerminalProjection(
          context.latest_terminal_projection,
          continuation.fundingContextId,
        )
      ) {
        throw new Error("telegram_funding_buy_continuation_stale");
      }
      const destinationAsset = context.destination_asset;
      if (
        !isRecord(destinationAsset) ||
        typeof destinationAsset.networkId !== "string" ||
        typeof destinationAsset.assetId !== "string" ||
        typeof destinationAsset.decimals !== "number" ||
        !resolveTelegramFundingBuyContinuationAdapter({
          destinationAsset: {
            assetId: destinationAsset.assetId,
            decimals: destinationAsset.decimals,
            networkId: destinationAsset.networkId,
          },
          venueId: context.venue_id,
        })
      ) {
        throw new Error("telegram_funding_buy_continuation_unsupported");
      }
      const buyReturn = await client.query<BuyReturnRowForResume>(
        `
          select
            telegram_account_id_snapshot,
            market_id,
            event_id,
            side,
            requested_spend_usd::text,
            source_authority_fingerprint,
            venue_id,
            destination_option_id,
            venue_binding_option_id
          from telegram_funding_buy_return_revisions
          where telegram_funding_session_id = $1
            and revision = $2
          limit 1
        `,
        [continuation.fundingContextId, continuation.buyReturnRevision],
      );
      const returnRevision = buyReturn.rows[0];
      if (
        !returnRevision ||
        returnRevision.telegram_account_id_snapshot !==
          context.telegram_account_id ||
        returnRevision.market_id !== scoped.market_id ||
        returnRevision.venue_id !== "polymarket" ||
        returnRevision.destination_option_id !==
          context.destination_option_id ||
        returnRevision.venue_binding_option_id !==
          context.venue_binding_option_id
      ) {
        throw new Error("telegram_funding_buy_continuation_stale");
      }
      if (
        !(await hasReadyTelegramFundingDestinationReceipt(
          client,
          continuation.fundingContextId,
        ))
      ) {
        throw new Error("telegram_funding_buy_destination_not_ready");
      }
      const policyState =
        await resolveSignalBotTradingPolicyStateFromDb(client);
      const authorization = await loadEnabledAuthorization(
        client,
        input.telegramUserId,
        "polymarket",
        { lock: true },
      );
      const market = await loadMarketById(client, returnRevision.market_id);
      const policy = policyState.policy;
      const authority = authorization
        ? buildTelegramTradeAuthorityBinding(authorization)
        : null;
      const amountUsd = Number(returnRevision.requested_spend_usd);
      if (
        policyState.policyRevision !== continuation.policyRevision ||
        !policy.buyContinuationEnabled ||
        !policy.tradingEnabled ||
        !policy.tradingActions.includes("buy") ||
        !policy.tradingVenues.includes("polymarket") ||
        !authorization ||
        !authority ||
        telegramBotTradeAuthorityFingerprint(authority) !==
          returnRevision.source_authority_fingerprint ||
        authorization.telegram_account_link_id !==
          context.telegram_account_id ||
        authorization.user_id !== context.user_id ||
        !authorization.privy_wallet_id ||
        !market ||
        market.venue !== "polymarket" ||
        !isMarketOrderable(market) ||
        !Number.isFinite(amountUsd) ||
        amountUsd <= 0 ||
        amountUsd >
          effectiveMaxTradeAmountUsd(policy, authorization.max_amount_usd)
      ) {
        throw new Error("telegram_funding_buy_continuation_disabled");
      }

      let generation: number | null = null;
      let existingIntentId: string | null = null;
      if (context.resume_intent_id) {
        const existing = await client.query<{
          execution_id: string | null;
          generation_policy_revision: string;
          generation_ready_progress_revision: number;
          generation_ready_receive_version: string | number;
          generation_telegram_account_id_snapshot: string;
          has_setup_transactions: boolean;
          id: string;
          order_id: string | null;
          status: string;
          submit_started_at: Date | null;
          tx_signature: string | null;
          venue_order_id: string | null;
        }>(
          `
            select
              intent.id,
              intent.status,
              intent.submit_started_at,
              intent.order_id,
              intent.execution_id,
              intent.venue_order_id,
              intent.tx_signature,
              generation.ready_progress_revision as generation_ready_progress_revision,
              generation.telegram_account_id_snapshot as generation_telegram_account_id_snapshot,
              generation_continuation.policy_revision as generation_policy_revision,
              generation_continuation.ready_receive_version as generation_ready_receive_version,
              coalesce(intent.result->'setupTransactions', '[]'::jsonb) <> '[]'::jsonb
                as has_setup_transactions
            from telegram_trade_intents intent
            join telegram_funding_buy_resume_generations generation
              on generation.trade_intent_id = intent.id
             and generation.telegram_funding_session_id = $2::uuid
             and generation.generation = $3
             and generation.buy_return_revision = $4
            join telegram_funding_buy_continuations generation_continuation
              on generation_continuation.id = generation.continuation_id
             and generation_continuation.telegram_funding_session_id = generation.telegram_funding_session_id
             and generation_continuation.buy_return_revision = generation.buy_return_revision
             and generation_continuation.ready_progress_revision = generation.ready_progress_revision
            where intent.id = $1::uuid
            for update
          `,
          [
            context.resume_intent_id,
            continuation.fundingContextId,
            context.resume_generation,
            continuation.buyReturnRevision,
          ],
        );
        const currentIntent = existing.rows[0];
        if (!currentIntent) {
          throw new Error("telegram_funding_buy_resume_invalid");
        }
        const sameReadyGeneration =
          currentIntent.generation_ready_progress_revision ===
            continuation.readyProgressRevision &&
          Number(currentIntent.generation_ready_receive_version) ===
            continuation.readyReceiveVersion &&
          currentIntent.generation_policy_revision ===
            continuation.policyRevision &&
          currentIntent.generation_telegram_account_id_snapshot ===
            continuation.telegramAccountId;
        if (
          sameReadyGeneration &&
          ["draft", "previewed", "confirming"].includes(currentIntent.status)
        ) {
          existingIntentId = currentIntent.id;
          generation = context.resume_generation;
        } else {
          const retryablePreSubmit =
            [
              "cancelled",
              "draft",
              "expired",
              "failed",
              "previewed",
              "confirming",
            ].includes(currentIntent.status) &&
            currentIntent.submit_started_at == null &&
            currentIntent.order_id == null &&
            currentIntent.execution_id == null &&
            currentIntent.venue_order_id == null &&
            currentIntent.tx_signature == null &&
            !currentIntent.has_setup_transactions;
          if (!retryablePreSubmit) {
            throw new Error("telegram_trade_intent_unresolved");
          }
          if (
            !sameReadyGeneration &&
            ["draft", "previewed", "confirming"].includes(currentIntent.status)
          ) {
            const retired = await client.query(
              `update telegram_trade_intents
                  set status = 'failed',
                      error_code = 'funding_continuation_stale',
                      error_message = 'A newer funding Review replaced this pending Buy.',
                      updated_at = now()
                where id = $1::uuid
                  and status = any($2::text[])
                  and submit_started_at is null
                  and order_id is null
                  and execution_id is null
                  and venue_order_id is null
                  and tx_signature is null
                  and coalesce(result->'setupTransactions', '[]'::jsonb) = '[]'::jsonb`,
              [currentIntent.id, ["draft", "previewed", "confirming"]],
            );
            if ((retired.rowCount ?? 0) !== 1) {
              throw new Error("telegram_trade_intent_unresolved");
            }
          }
        }
      }
      if (!existingIntentId) {
        const unresolved = await client.query<{ id: string }>(
          `
            select id
            from telegram_trade_intents
            where telegram_user_id = $1
              and market_id = $2
              and status in (
                'confirming',
                'funding',
                'executing',
                'submitted',
                'reconcile_required'
              )
            limit 1
            for update
          `,
          [input.telegramUserId, returnRevision.market_id],
        );
        if (unresolved.rows[0]) {
          throw new Error("telegram_trade_intent_unresolved");
        }
        generation = context.resume_generation + 1;
        existingIntentId = crypto.randomUUID();
        const intentIdempotencyKey = [
          "telegram-funding-resume",
          continuation.fundingContextId,
          continuation.buyReturnRevision,
          generation,
        ].join(":");
        await client.query(
          `
            insert into telegram_trade_intents (
              id,
              telegram_user_id,
              user_id,
              authorization_id,
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
              result,
              expires_at,
              idempotency_key
            ) values (
              $1, $2, $3, $4, $5, $6, 'buy', 'polymarket', $7, $8, $9,
              $10::numeric, 'draft', '{}'::jsonb, $11::jsonb, $12::jsonb,
              $13, $14
            )
          `,
          [
            existingIntentId,
            input.telegramUserId,
            authorization.user_id,
            authorization.id,
            input.chatId,
            input.telegramMessageId,
            returnRevision.market_id,
            returnRevision.event_id,
            returnRevision.side,
            returnRevision.requested_spend_usd,
            JSON.stringify(buildPolicySnapshot(policy)),
            JSON.stringify({
              ...buildIntentAuthorityResult(authority),
              telegramFundingReturn: {
                continuationId: continuation.id,
                fundingContextId: continuation.fundingContextId,
                generation,
                policyRevision: continuation.policyRevision,
                returnRevision: continuation.buyReturnRevision,
                version: 1,
              },
            }),
            new Date(Date.now() + policy.intentTtlSec * 1000),
            intentIdempotencyKey,
          ],
        );
        await client.query(
          `
            insert into telegram_funding_buy_resume_generations (
              telegram_funding_session_id,
              generation,
              parent_generation,
              buy_return_revision,
              continuation_id,
              ready_progress_revision,
              telegram_account_id_snapshot,
              trade_intent_id,
              idempotency_key,
              request_fingerprint,
              created_at
            ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
          `,
          [
            continuation.fundingContextId,
            generation,
            generation === 1 ? null : generation - 1,
            continuation.buyReturnRevision,
            continuation.id,
            continuation.readyProgressRevision,
            context.telegram_account_id,
            existingIntentId,
            intentIdempotencyKey,
            requestFingerprint,
          ],
        );
        const bound = await client.query(
          `
            update telegram_funding_sessions
            set resume_generation = $2,
                resume_intent_id = $3,
                resumed_at = now(),
                updated_at = now()
            where id = $1
              and active_buy_return_revision = $4
              and resume_generation = $5
          `,
          [
            continuation.fundingContextId,
            generation,
            existingIntentId,
            continuation.buyReturnRevision,
            generation - 1,
          ],
        );
        if ((bound.rowCount ?? 0) !== 1) {
          throw new Error("telegram_funding_buy_continuation_stale");
        }
      }
      if (generation == null || !existingIntentId) {
        throw new Error("telegram_funding_buy_resume_failed");
      }
      await client.query(
        `
          insert into telegram_funding_mutations (
            funding_context_id,
            action,
            idempotency_key,
            request_fingerprint,
            response_payload,
            consent_revision,
            buy_return_revision,
            resume_generation,
            resume_intent_id,
            continuation_id,
            created_at
          ) values (
            $1, 'resume_buy', $2, $3, $4::jsonb, null, $5, $6, $7, $8, now()
          )
        `,
        [
          continuation.fundingContextId,
          input.idempotencyKey,
          requestFingerprint,
          JSON.stringify({ intentId: existingIntentId }),
          continuation.buyReturnRevision,
          generation,
          existingIntentId,
          continuation.id,
        ],
      );
      return existingIntentId;
    });
  } catch (error) {
    const errorCode =
      error instanceof Error && error.message.startsWith("telegram_")
        ? error.message
        : "unexpected_error";
    console.warn("[telegram-funding] Review Buy rejected", {
      errorCode,
      fundingContextId: scoped.telegram_funding_session_id,
    });
    return unavailable(
      "This Review Buy is no longer current. Refresh funding or open the market again.",
    );
  }

  const [intent, policy, authorization] = await Promise.all([
    loadIntent(input.db, intentId),
    resolveTelegramBotTradingPolicy(input.db),
    loadEnabledAuthorization(input.db, input.telegramUserId, "polymarket"),
  ]);
  const market = intent
    ? await loadMarketById(input.db, intent.market_id)
    : null;
  if (intent && !["draft", "previewed", "confirming"].includes(intent.status)) {
    return unavailable(
      "This Review Buy was already processed. Use /trade_status or open the market again.",
    );
  }
  if (
    !intent ||
    !authorization ||
    !market ||
    !policy.buyContinuationEnabled ||
    !intentMatchesTelegramTradeAuthority({ authorization, intent }) ||
    !(await isTelegramFundingReturnIntentCurrent(
      input.db,
      intent,
      authorization,
    ))
  ) {
    if (intent) {
      await updateIntentStatus({
        allowedStatuses: ["draft", "previewed"],
        db: input.db,
        errorCode: "funding_continuation_stale",
        errorMessage: "Funding continuation changed before preview.",
        intentId: intent.id,
        status: "failed",
      });
    }
    return unavailable("Trading authority or policy changed before preview.");
  }
  const readiness = await resolveTelegramTradingReadiness({
    action: "BUY",
    authorization,
    market,
    trading: input.trading,
    venue: "polymarket",
  });
  if (!canPreviewBuyForReadiness(readiness)) {
    await updateIntentStatus({
      allowedStatuses: ["draft", "previewed"],
      db: input.db,
      errorCode: "not_ready",
      errorMessage: readiness.message ?? "Buy is not ready.",
      intentId: intent.id,
      status: "failed",
    });
    return unavailable(
      "The deposit is confirmed, but the Polymarket trading balance is still syncing. Tap Review Buy again shortly.",
      "Funds are syncing",
    );
  }
  const messages: TelegramBotTradingMessage[] = [];
  await previewTelegramTradeIntent({
    appBaseUrl: input.appBaseUrl,
    authorization,
    beforeConfirmLocked: (client, currentAuthorization) =>
      isTelegramFundingReturnIntentCurrent(
        client,
        intent,
        currentAuthorization,
        { lockGeneration: true },
      ),
    chatId: input.chatId,
    db: input.db,
    estimateRetainedSolUsd: input.estimateRetainedSolUsd,
    fundingReturnResume: true,
    intent,
    market,
    maxAmountUsd: effectiveMaxTradeAmountUsd(
      policy,
      authorization.max_amount_usd,
    ),
    policy,
    readiness,
    sendMessage: async (message) => {
      messages.push(message);
      return undefined;
    },
    telegramMiniAppEnabled: input.telegramMiniAppEnabled,
    trading: input.trading,
  });
  return (
    messages.at(-1) ??
    unavailable("Trade state changed. Check /trade_status before retrying.")
  );
}

type BuyReturnRowForResume = Readonly<{
  telegram_account_id_snapshot: string;
  market_id: string;
  event_id: string | null;
  side: TelegramBotTradingSide;
  requested_spend_usd: string;
  source_authority_fingerprint: string;
  venue_id: string;
  destination_option_id: string;
  venue_binding_option_id: string;
}>;

export async function isTelegramBotTradeInputContextAuthorityCurrent(input: {
  context: TelegramBotTradeInputContext;
  db: DbQuery;
  telegramUserId: string;
}): Promise<boolean> {
  const authorization =
    input.context.deliveryMode === "app_handoff"
      ? await loadEnabledEvmAuthorization(input.db, input.telegramUserId, {
          // Contexts are short-lived and only contain a sealed user authority.
          // The later versioned handoff scope still rejects V1 if bot trading
          // is disabled; this keeps V2 custom input usable without a signer.
          allowInactiveForV2: true,
        })
      : await loadEnabledAuthorization(
          input.db,
          input.telegramUserId,
          input.context.venue,
        );
  return sameTelegramTradeAuthorityBinding(
    input.context.authority,
    authorization,
  );
}

async function isTelegramBotTradingAuthorizationEnabled(
  db: DbQuery,
  authorization: TelegramBotTradingAuthorizationRow,
  venue: TelegramBotTradingVenue,
  intent?: TelegramTradeIntentRow,
): Promise<boolean> {
  const current = await loadEnabledAuthorization(
    db,
    authorization.telegram_user_id,
    venue,
  );
  return Boolean(
    current?.id === authorization.id &&
    (!intent ||
      intentMatchesTelegramTradeAuthority({ authorization: current, intent })),
  );
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

function resolveTelegramCallbackMessageId(
  storedMessageId: string | null,
  callbackMessageId: number | null | undefined,
): number | null {
  if (callbackMessageId != null && Number.isSafeInteger(callbackMessageId)) {
    return callbackMessageId;
  }
  if (storedMessageId == null) return null;
  const parsed = Number(storedMessageId);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isTerminalIntentStatus(status: string): boolean {
  return TERMINAL_INTENT_STATUSES.has(status);
}

function isCustomTelegramTradeIntent(intent: TelegramTradeIntentRow): boolean {
  const marker =
    isRecord(intent.result) && isRecord(intent.result.telegramInput)
      ? intent.result.telegramInput
      : null;
  return marker?.version === 1;
}

type TelegramFundingReturnIntentMarker = Readonly<{
  continuationId: string;
  fundingContextId: string;
  generation: number;
  policyRevision: string;
  returnRevision: number;
}>;

type TelegramFundingHandoffIntentMarker = Readonly<{
  fundingContextId: string;
  policyRevision: string;
  returnRevision: number;
}>;

function readTelegramFundingReturnIntentMarker(
  intent: TelegramTradeIntentRow,
): TelegramFundingReturnIntentMarker | null {
  const marker =
    isRecord(intent.result) && isRecord(intent.result.telegramFundingReturn)
      ? intent.result.telegramFundingReturn
      : null;
  if (
    marker?.version !== 1 ||
    typeof marker.continuationId !== "string" ||
    typeof marker.fundingContextId !== "string" ||
    typeof marker.generation !== "number" ||
    !Number.isInteger(marker.generation) ||
    marker.generation <= 0 ||
    typeof marker.policyRevision !== "string" ||
    marker.policyRevision.trim().length === 0 ||
    typeof marker.returnRevision !== "number" ||
    !Number.isInteger(marker.returnRevision) ||
    marker.returnRevision <= 0
  ) {
    return null;
  }
  return {
    continuationId: marker.continuationId,
    fundingContextId: marker.fundingContextId,
    generation: marker.generation,
    policyRevision: marker.policyRevision,
    returnRevision: marker.returnRevision,
  };
}

function readTelegramFundingHandoffIntentMarker(
  intent: TelegramTradeIntentRow,
): TelegramFundingHandoffIntentMarker | null {
  const marker =
    isRecord(intent.result) && isRecord(intent.result.telegramFundingHandoff)
      ? intent.result.telegramFundingHandoff
      : null;
  if (
    marker?.version !== 1 ||
    typeof marker.fundingContextId !== "string" ||
    marker.fundingContextId.trim().length === 0 ||
    typeof marker.policyRevision !== "string" ||
    marker.policyRevision.trim().length === 0 ||
    typeof marker.returnRevision !== "number" ||
    !Number.isInteger(marker.returnRevision) ||
    marker.returnRevision <= 0
  ) {
    return null;
  }
  return {
    fundingContextId: marker.fundingContextId,
    policyRevision: marker.policyRevision,
    returnRevision: marker.returnRevision,
  };
}

function readTelegramFundingIntentContextMarker(
  intent: TelegramTradeIntentRow,
): Readonly<{ fundingContextId: string }> | null {
  return (
    readTelegramFundingReturnIntentMarker(intent) ??
    readTelegramFundingHandoffIntentMarker(intent)
  );
}

async function isTelegramFundingReturnIntentCurrent(
  db: DbQuery,
  intent: TelegramTradeIntentRow,
  authorization: TelegramBotTradingAuthorizationRow,
  options: Readonly<{ lockGeneration?: boolean }> = {},
): Promise<boolean> {
  const marker = readTelegramFundingReturnIntentMarker(intent);
  const currentAuthority = buildTelegramTradeAuthorityBinding(authorization);
  if (
    !marker ||
    !currentAuthority ||
    !intentMatchesTelegramTradeAuthority({ authorization, intent })
  ) {
    return false;
  }
  const { rows } = await db.query<{
    current: boolean;
    continuation_policy_revision: string;
    destination_asset: Record<string, unknown>;
    market_id: string;
    requested_spend_usd: string;
    side: string;
    source_authority_fingerprint: string;
    venue_id: string;
  }>(
    `
      select
        true as current,
        continuation.policy_revision as continuation_policy_revision,
        receive.destination_asset,
        buy_return.market_id,
        buy_return.requested_spend_usd::text,
        buy_return.side,
        buy_return.source_authority_fingerprint,
        buy_return.venue_id
      from telegram_funding_buy_resume_generations generation
      join telegram_funding_sessions context
        on context.id = generation.telegram_funding_session_id
      join telegram_funding_buy_continuations continuation
        on continuation.id = generation.continuation_id
       and continuation.telegram_funding_session_id = generation.telegram_funding_session_id
       and continuation.buy_return_revision = generation.buy_return_revision
       and continuation.ready_progress_revision = generation.ready_progress_revision
      join telegram_funding_buy_return_revisions buy_return
        on buy_return.telegram_funding_session_id = generation.telegram_funding_session_id
       and buy_return.revision = generation.buy_return_revision
      join funding_receive_sessions receive
        on receive.id = context.receive_session_id
       and receive.user_id = context.user_id
       and receive.owner_channel = context.receive_owner_channel
      where generation.telegram_funding_session_id = $1::uuid
        and generation.generation = $2
        and generation.buy_return_revision = $3
        and generation.continuation_id = $4::uuid
        and generation.trade_intent_id = $5::uuid
        and context.active_buy_return_revision = generation.buy_return_revision
        and context.resume_generation = generation.generation
        and context.resume_intent_id = generation.trade_intent_id
        and context.cancelled_at is null
        and context.expires_at > now()
        and context.telegram_account_id = generation.telegram_account_id_snapshot
        and context.progress_revision = generation.ready_progress_revision
        and context.latest_progress_projection->>'state' = 'ready'
        and receive.version >= continuation.ready_receive_version
        and receive.venue_id = buy_return.venue_id
        and receive.destination_option_id = buy_return.destination_option_id
        and receive.venue_binding_option_id = buy_return.venue_binding_option_id
        and exists (
          select 1
          from telegram_funding_mutations mutation
          where mutation.funding_context_id = generation.telegram_funding_session_id
            and mutation.resume_generation = generation.generation
            and mutation.buy_return_revision = generation.buy_return_revision
            and mutation.resume_intent_id = generation.trade_intent_id
            and mutation.action = 'resume_buy'
        )
      ${options.lockGeneration ? "for update of generation" : ""}
      limit 1
    `,
    [
      marker.fundingContextId,
      marker.generation,
      marker.returnRevision,
      marker.continuationId,
      intent.id,
    ],
  );
  const current = rows[0];
  if (
    current?.current !== true ||
    current.continuation_policy_revision !== marker.policyRevision ||
    !(await hasReadyTelegramFundingDestinationReceipt(
      db,
      marker.fundingContextId,
    )) ||
    current.market_id !== intent.market_id ||
    current.side !== intent.side ||
    current.venue_id !== intent.venue ||
    telegramBotTradeAuthorityFingerprint(currentAuthority) !==
      current.source_authority_fingerprint ||
    Number(current.requested_spend_usd) !== Number(intent.amount_usd) ||
    !isRecord(current.destination_asset) ||
    typeof current.destination_asset.networkId !== "string" ||
    typeof current.destination_asset.assetId !== "string" ||
    typeof current.destination_asset.decimals !== "number" ||
    !resolveTelegramFundingBuyContinuationAdapter({
      destinationAsset: {
        assetId: current.destination_asset.assetId,
        decimals: current.destination_asset.decimals,
        networkId: current.destination_asset.networkId,
      },
      venueId: current.venue_id,
    })
  ) {
    return false;
  }
  await db.query("select id from unified_markets where id = $1 for share", [
    intent.market_id,
  ]);
  const policyState = await resolveSignalBotTradingPolicyStateFromDb(db);
  const policy = policyState.policy;
  const market = await loadMarketById(db, intent.market_id);
  const automationAllowed = await venueLifecycleAllows(
    db,
    intent.venue,
    "automation",
  );
  const increaseExposureAllowed = await venueLifecycleAllows(
    db,
    intent.venue,
    "increaseExposure",
  );
  const requestedSpendUsd = Number(intent.amount_usd);
  return Boolean(
    policyState.policyRevision === marker.policyRevision &&
    policy.buyContinuationEnabled &&
    policy.tradingEnabled &&
    policy.tradingActions.includes("buy") &&
    policy.tradingVenues.includes(intent.venue) &&
    isVenueAllowed(
      intent.venue,
      policy,
      filterVenuesForWalletChain(
        normalizeVenues(authorization.enabled_venues),
        authorization.wallet_chain,
      ),
    ) &&
    Number.isFinite(requestedSpendUsd) &&
    requestedSpendUsd > 0 &&
    requestedSpendUsd <=
      effectiveMaxTradeAmountUsd(policy, authorization.max_amount_usd) &&
    market &&
    market.venue === intent.venue &&
    isMarketOrderable(market) &&
    automationAllowed &&
    increaseExposureAllowed,
  );
}

async function isTelegramFundingHandoffIntentCurrent(
  db: DbQuery,
  intent: TelegramTradeIntentRow,
  authorization: TelegramBotTradingAuthorizationRow,
): Promise<boolean> {
  const marker = readTelegramFundingHandoffIntentMarker(intent);
  const currentAuthority = buildTelegramTradeAuthorityBinding(authorization);
  const userId = intent.user_id;
  const chatId = intent.chat_id;
  if (
    !marker ||
    !currentAuthority ||
    !userId ||
    !chatId ||
    intent.action !== "buy" ||
    intent.delivery_mode !== "app_handoff" ||
    !intentMatchesTelegramTradeAuthority({ authorization, intent })
  ) {
    return false;
  }
  const { rows } = await db.query<{
    destination_asset: Record<string, unknown>;
    market_id: string;
    requested_spend_usd: string;
    side: string;
    source_authority_fingerprint: string;
    source_wallet_address: string;
    telegram_account_id: string;
    venue_id: string;
  }>(
    `
      select
        receive_session.destination_asset,
        buy_return.market_id,
        buy_return.requested_spend_usd::text,
        buy_return.side,
        buy_return.source_authority_fingerprint,
        retained_receipt.destination_address as source_wallet_address,
        funding_context.telegram_account_id,
        buy_return.venue_id
      from telegram_funding_sessions funding_context
      join telegram_funding_buy_return_revisions buy_return
        on buy_return.telegram_funding_session_id = funding_context.id
       and buy_return.revision = funding_context.active_buy_return_revision
      join funding_receive_sessions receive_session
        on receive_session.id = funding_context.receive_session_id
       and receive_session.user_id = funding_context.user_id
       and receive_session.owner_channel = funding_context.receive_owner_channel
      join telegram_funding_consents funding_consent
        on funding_consent.telegram_funding_session_id = funding_context.id
       and funding_consent.revision = funding_context.active_consent_revision
      join lateral (
        select receive_receipt.destination_address
        from funding_receive_receipts receive_receipt
        where receive_receipt.receive_session_id = receive_session.id
          and receive_receipt.user_id = funding_context.user_id
          and receive_receipt.variant_id = any(funding_consent.consented_variant_ids)
          and receive_receipt.status = 'ready'
          and receive_receipt.handling = 'direct'
          and receive_receipt.network_id = $8
          and receive_receipt.asset_id = $9
          and receive_receipt.asset_decimals = $10
          and receive_receipt.raw_amount <> '0'
          and exists (
            select 1
            from jsonb_array_elements(receive_session.observation_variants) frozen_variant
            where frozen_variant ->> 'variantId' = receive_receipt.variant_id
              and frozen_variant #>> '{completion,kind}' = 'retained_owned_source_credit'
              and frozen_variant ->> 'networkId' = receive_receipt.network_id
              and frozen_variant #>> '{asset,networkId}' = receive_receipt.network_id
              and frozen_variant #>> '{asset,assetId}' = receive_receipt.asset_id
              and (frozen_variant #>> '{asset,decimals}')::int = receive_receipt.asset_decimals
              and funding_account_identifier_equal(
                    receive_receipt.network_id,
                    frozen_variant ->> 'destinationAddress',
                    receive_receipt.destination_address
                  )
          )
        order by receive_receipt.observed_at desc, receive_receipt.id desc
        limit 1
      ) retained_receipt on true
      where funding_context.id = $1::uuid
        and funding_context.active_buy_return_revision = $2
        and funding_context.user_id = $3::uuid
        and funding_context.telegram_user_id = $4
        and funding_context.chat_id = $5
        and funding_context.telegram_message_id is not distinct from $6::bigint
        and funding_context.telegram_account_id = $7::uuid
        and funding_context.cancelled_at is null
        and funding_context.expires_at > now()
        and receive_session.status in ('open', 'processing', 'review_required', 'completed')
        and receive_session.selected_receive_target_id = funding_consent.selected_receive_target_id
        and buy_return.continuation_mode = 'app_handoff'
        and funding_consent.automation_enabled = false
        and funding_consent.selected_asset_network_id = $8
        and funding_consent.selected_asset_id = $9
        and funding_consent.selected_asset_decimals = $10
      limit 1
    `,
    [
      marker.fundingContextId,
      marker.returnRevision,
      userId,
      intent.telegram_user_id,
      chatId,
      intent.telegram_message_id,
      authorization.telegram_account_link_id,
      SOLANA_NATIVE_ASSET.networkId,
      SOLANA_NATIVE_ASSET.assetId,
      SOLANA_NATIVE_ASSET.decimals,
    ],
  );
  const current = rows[0];
  if (
    !current ||
    current.telegram_account_id !== authorization.telegram_account_link_id ||
    current.market_id !== intent.market_id ||
    current.side !== intent.side ||
    current.venue_id !== intent.venue ||
    Number(current.requested_spend_usd) !== Number(intent.amount_usd) ||
    telegramBotTradeAuthorityFingerprint(currentAuthority) !==
      current.source_authority_fingerprint ||
    !(await isTelegramFundingManagedSolanaWalletCurrent(db, {
      lock: true,
      telegramAccountId: current.telegram_account_id,
      telegramUserId: intent.telegram_user_id,
      userId,
      walletAddress: current.source_wallet_address,
    })) ||
    !isRecord(current.destination_asset) ||
    typeof current.destination_asset.networkId !== "string" ||
    typeof current.destination_asset.assetId !== "string" ||
    typeof current.destination_asset.decimals !== "number" ||
    !resolveTelegramFundingBuyContinuationAdapter({
      destinationAsset: {
        assetId: current.destination_asset.assetId,
        decimals: current.destination_asset.decimals,
        networkId: current.destination_asset.networkId,
      },
      venueId: current.venue_id,
    })
  ) {
    return false;
  }
  await db.query("select id from unified_markets where id = $1 for share", [
    intent.market_id,
  ]);
  const policyState = await resolveSignalBotTradingPolicyStateFromDb(db);
  const policy = policyState.policy;
  const market = await loadMarketById(db, intent.market_id);
  const requestedSpendUsd = Number(intent.amount_usd);
  return Boolean(
    policyState.policyRevision === marker.policyRevision &&
    policy.buyContinuationEnabled &&
    policy.fundingReceiveEnabled &&
    policy.tradingEnabled &&
    policy.tradingActions.includes("buy") &&
    isTelegramAppHandoffV2EnabledForVenue({
      contractVersion: policy.miniAppHandoffContractVersion,
      mode: policy.miniAppHandoffMode,
      venue: intent.venue,
    }) &&
    Number.isFinite(requestedSpendUsd) &&
    requestedSpendUsd > 0 &&
    requestedSpendUsd <=
      resolveTelegramBuyIntentMaximumAmountUsd({
        authorizationMaxAmountUsd: authorization.max_amount_usd,
        deliveryMode: "app_handoff",
        policy,
        venue: intent.venue,
      }) &&
    market &&
    market.venue === intent.venue &&
    isMarketOrderable(market),
  );
}

async function isTelegramFundingIntentSourceCurrent(
  db: DbQuery,
  intent: TelegramTradeIntentRow,
  authorization: TelegramBotTradingAuthorizationRow,
  options: Readonly<{ lockGeneration?: boolean }> = {},
): Promise<boolean> {
  if (readTelegramFundingReturnIntentMarker(intent)) {
    return isTelegramFundingReturnIntentCurrent(
      db,
      intent,
      authorization,
      options,
    );
  }
  if (readTelegramFundingHandoffIntentMarker(intent)) {
    return isTelegramFundingHandoffIntentCurrent(db, intent, authorization);
  }
  return true;
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
          return "⚠️ These buttons expired. Use Open market on the latest card.";
        case "failed":
          return intent.submit_started_at
            ? "⚠️ The submitted trade did not fill. Use Open market to try again."
            : "⚠️ Trade failed before submission. Nothing was sent. Use Open market to try again.";
        case "cancelled":
          return intent.error_message?.trim()
            ? `⚠️ Trade cancelled: ${intent.error_message.trim()}`
            : "✅ Trade was cancelled. Nothing was submitted.";
        case "submitted":
          return "✅ Trade was submitted. Use Check status on the current card for the result.";
        case "filled":
          return "✅ Trade already filled. Open My positions for details.";
        default:
          return "⚠️ This trade action is no longer active. Use Open market on the latest card.";
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

  const executing = await transitionIntentToExecuting({
    authorization,
    db: callback.db,
    intent,
  });
  if (executing !== "executing") {
    if (executing === "authority_changed") {
      await updateIntentStatus({
        allowedStatuses: ["confirming"],
        db: callback.db,
        errorCode: "authority_changed",
        errorMessage: "Telegram trade authority changed before confirmation.",
        intentId: intent.id,
        status: "failed",
      });
      await callback.answerCallbackQuery({
        callbackQueryId: callback.callbackQuery.id,
        showAlert: true,
        text: "⚠️ Account or Trading Wallet changed. Open the position again.",
      });
      return true;
    }
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
        intent,
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
        intent,
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
    const actualPayoutRaw = sumErc20TransfersTo({
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
        tone: accepted && !definitiveFailure ? "working" : "warn",
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

async function previewTelegramTradeIntent(input: {
  appBaseUrl: string;
  authorization: TelegramBotTradingAuthorizationRow;
  beforeConfirmLocked?: (
    db: DbQuery,
    currentAuthorization: TelegramBotTradingAuthorizationRow,
  ) => Promise<boolean>;
  chatId: string;
  db: DbQuery;
  estimateRetainedSolUsd?: (raw: string) => Promise<string | null>;
  intent: TelegramTradeIntentRow;
  log?: TelegramBotTradingCallbackInput["log"];
  market: TelegramBotMarketRow;
  maxAmountUsd: number;
  fundingReturnResume?: boolean;
  openFundingBuyReturn?: TelegramFundingBuyReturnOpener;
  inspectMiniAppFunding?: TelegramBotTradingCallbackInput["inspectMiniAppFunding"];
  inspectTradeShortfall?: TelegramBotTradingCallbackInput["inspectTradeShortfall"];
  policy: SignalBotPolicy;
  quoteOverride?: TradeQuote;
  readiness: TradingReadiness | null;
  sendMessage: TelegramBotTradingCallbackInput["sendMessage"];
  telegramMiniAppEnabled?: boolean;
  trading: ApiBotTradingExecutor;
}): Promise<void> {
  const replacingRetryableFundingInspection =
    isRetryableTelegramAppHandoffFundingInspection(input.intent);
  const fundingReturnPreviewAllowedStatuses =
    resolveFundingReturnPreviewAllowedStatuses({
      deliveryMode: input.intent.delivery_mode,
      replacingRetryableFundingInspection,
    });
  const updatePreviewIntentStatus = (
    update: Omit<
      Parameters<typeof updateIntentStatus>[0],
      "db" | "intentId" | "requireRetryableAppHandoffFundingInspection"
    >,
  ): Promise<boolean> =>
    updateIntentStatus({
      ...update,
      db: input.db,
      intentId: input.intent.id,
      requireRetryableAppHandoffFundingInspection:
        replacingRetryableFundingInspection,
    });
  const sendCurrentConfirmation = async (
    reviewAuthorization = input.authorization,
  ): Promise<boolean> => {
    let current = await loadIntent(input.db, input.intent.id);
    let stored = current
      ? readTelegramTradeQuotePreview(current.quote_snapshot)
      : null;
    if (current?.status === "previewed" && stored) {
      const appHandoffPlan = readTelegramAppHandoffV2Plan(current);
      if (
        current.delivery_mode !== "app_handoff" ||
        appHandoffPlan?.kind === "funding"
      ) {
        await transitionIntentToConfirming({
          allowAppHandoffFunding: appHandoffPlan?.kind === "funding",
          authorization: reviewAuthorization,
          beforeConfirmLocked: input.beforeConfirmLocked,
          db: input.db,
          intent: current,
        });
      }
      current = await loadIntent(input.db, input.intent.id);
      stored = current
        ? readTelegramTradeQuotePreview(current.quote_snapshot)
        : null;
    }
    const currentHandoffPlan = current
      ? readTelegramAppHandoffV2Plan(current)
      : null;
    const reviewable =
      current?.status === "confirming" ||
      (current?.status === "previewed" &&
        current.delivery_mode === "app_handoff" &&
        currentHandoffPlan?.kind === "direct_trade");
    if (!reviewable || !current || !stored) return false;
    let selectedAuthorization = reviewAuthorization;
    if (current.status === "confirming" && input.beforeConfirmLocked) {
      const validatedAuthorization = await withLockedTelegramIntentAuthority({
        callback: async (client, currentAuthorization) => {
          const fundingCurrent =
            currentAuthorization &&
            (await input.beforeConfirmLocked?.(client, currentAuthorization));
          if (!fundingCurrent) {
            await updateIntentStatus({
              allowedStatuses: ["confirming"],
              db: client,
              errorCode: currentAuthorization
                ? "funding_continuation_stale"
                : "authority_changed",
              errorMessage: currentAuthorization
                ? "Funding continuation changed before confirmation."
                : "Telegram trade authority changed before confirmation.",
              intentId: current.id,
              status: "failed",
            });
            return null;
          }
          return currentAuthorization;
        },
        db: input.db,
        expectedAuthorization: reviewAuthorization,
        intent: current,
      });
      if (!validatedAuthorization) return false;
      selectedAuthorization = validatedAuthorization;
    }
    let preissuedHandoff:
      | Awaited<ReturnType<typeof issueTelegramTradeAppHandoff>>
      | undefined;
    if (
      current.status === "previewed" &&
      current.delivery_mode === "app_handoff" &&
      currentHandoffPlan?.kind === "direct_trade"
    ) {
      const selected = await transitionIntentToConfirming({
        authorization: reviewAuthorization,
        beforeConfirmLocked: input.beforeConfirmLocked,
        db: input.db,
        intent: current,
        onDirectAppHandoffReviewSelected: async (
          client,
          currentAuthorization,
        ) => {
          selectedAuthorization = currentAuthorization;
          preissuedHandoff = await issueTelegramTradeAppHandoff({
            authorization: currentAuthorization,
            db: client,
            intent: current,
            quote: stored,
            v2Plan: currentHandoffPlan,
          });
        },
      });
      if (selected !== "confirmed" || !preissuedHandoff) return false;
    }
    await input.sendMessage({
      chat_id: input.chatId,
      ...(await buildTelegramTradeReviewMessage({
        authorization: selectedAuthorization,
        db: input.db,
        estimateRetainedSolUsd: input.estimateRetainedSolUsd,
        intent: current,
        market: input.market,
        policy: input.policy,
        preissuedHandoff,
        quote: stored,
        readiness: input.readiness,
      })),
    });
    return true;
  };
  const { action, amountUsd, sharesRaw } = readTelegramTradeIntentAmount(
    input.intent,
  );
  const side = input.intent.side;
  if (!side || (action === "BUY" ? !amountUsd : !sharesRaw)) {
    await updatePreviewIntentStatus({
      allowedStatuses: PENDING_INTENT_STATUSES,
      errorCode: "invalid_trade_request",
      errorMessage: "Trade amount is invalid.",
      status: "failed",
    });
    return;
  }
  if (
    input.intent.status === "confirming" ||
    (input.intent.status === "previewed" &&
      input.intent.delivery_mode === "app_handoff" &&
      readTelegramAppHandoffV2Plan(input.intent) != null)
  ) {
    await sendCurrentConfirmation();
    return;
  }
  const unresolvedIntent = await loadUnresolvedTelegramTradeIntent(input.db, {
    excludeIntentId: input.intent.id,
    marketId: input.intent.market_id,
    telegramUserId: input.intent.telegram_user_id,
  });
  if (unresolvedIntent) {
    await input.sendMessage({
      chat_id: input.chatId,
      parse_mode: "MarkdownV2",
      text: formatTelegramTradeLifecycleMessageMarkdownV2({
        heading: "Trade is still resolving.",
        tone: "working",
        lines: [
          "The bot is checking the venue automatically; no action is needed. Check /trade_status before retrying.",
        ],
        marketTitle: input.intent.market_title,
        venue: input.intent.venue,
      }),
    });
    return;
  }
  const previewIntent = buildTelegramStoredTradeIntent({
    amountUsd,
    authorization: input.authorization,
    intent: input.intent,
    market: input.market,
    policy: input.policy,
    sharesRaw,
    side,
  });
  let quote: TradeQuote;
  try {
    quote =
      input.quoteOverride ??
      (await input.trading.quote({ intent: previewIntent }));
  } catch (error) {
    const normalized = input.trading.normalizeError(input.intent.venue, error);
    const failed = await updatePreviewIntentStatus({
      allowedStatuses: ["draft", "previewed"],
      errorCode: normalized.code,
      errorMessage: normalized.message,
      result: { error: normalized, stage: "preview_quote" },
      status: "failed",
    });
    if (
      !failed &&
      !replacingRetryableFundingInspection &&
      (await sendCurrentConfirmation())
    )
      return;
    if (!failed) {
      if (replacingRetryableFundingInspection) return;
      const current = await loadIntent(input.db, input.intent.id);
      if (current?.status !== "failed") {
        await input.sendMessage({
          chat_id: input.chatId,
          parse_mode: "MarkdownV2",
          text: formatTelegramTradeLifecycleMessageMarkdownV2({
            heading: "A newer trade state is already available.",
            tone: "warn",
            lines: ["Use the latest confirmation or check /trade_status."],
            marketTitle: input.intent.market_title,
            venue: input.intent.venue,
          }),
        });
        return;
      }
    }
    await input.sendMessage({
      chat_id: input.chatId,
      parse_mode: "MarkdownV2",
      text: formatTelegramTradeLifecycleMessageMarkdownV2({
        heading: "Unable to build a safe current quote.",
        tone: "warn",
        lines: ["Nothing was submitted. Send /market again."],
        marketTitle: input.intent.market_title,
        venue: input.intent.venue,
      }),
    });
    return;
  }
  const { maxSpendUsd, venueMinimumBlocking: minimumBlocking } =
    resolveTelegramTradeQuoteLimits({
      amountUsd,
      intent: previewIntent,
      quote,
    });
  const sellProceedsBlocking =
    action === "SELL" &&
    !isTelegramSellProceedsDisplayable(quote.minimumReceiveUsd);
  if (
    minimumBlocking ||
    sellProceedsBlocking ||
    (action === "BUY" &&
      (amountUsd == null ||
        amountUsd > input.maxAmountUsd ||
        maxSpendUsd == null ||
        maxSpendUsd > input.maxAmountUsd))
  ) {
    const failed = await updatePreviewIntentStatus({
      allowedStatuses: ["draft", "previewed"],
      errorCode:
        minimumBlocking || sellProceedsBlocking
          ? "quote_changed"
          : "max_spend_exceeded",
      errorMessage: minimumBlocking
        ? "Price moved and the order no longer meets venue minimum."
        : sellProceedsBlocking
          ? "The current Sell proceeds are below the minimum displayable amount."
          : "Preview quote exceeds the Telegram bot max buy.",
      quoteSnapshot: buildTelegramTradeQuotePreview(quote),
      result: { maxAmountUsd: input.maxAmountUsd, previewQuote: quote },
      status: "failed",
    });
    if (!failed) {
      if (!replacingRetryableFundingInspection) {
        await sendCurrentConfirmation();
      }
      return;
    }
    await input.sendMessage({
      chat_id: input.chatId,
      parse_mode: "MarkdownV2",
      text: formatTelegramTradeLifecycleMessageMarkdownV2({
        heading: "Trade not submitted.",
        tone: "warn",
        lines: [
          minimumBlocking
            ? "The current quote does not meet venue requirements."
            : sellProceedsBlocking
              ? "The current Sell would return less than $0.01."
              : `Maximum total spend is outside your ${formatUsd(input.maxAmountUsd)} limit.`,
          "Nothing was submitted.",
        ],
        marketTitle: input.intent.market_title,
        venue: input.intent.venue,
      }),
    });
    return;
  }
  if (action === "BUY" && maxSpendUsd != null) {
    const executableFundsUsd = Math.max(
      0,
      input.readiness?.maxExecutableBuyUsd ?? 0,
    );
    const fundingPreview = resolveTelegramBuyFundingPreview({
      controlledFundsUsd: readPolymarketControlledFundsUsd(input.readiness),
      executableFundsUsd,
      requiredUsd: maxSpendUsd,
    });
    if (fundingPreview.state !== "ready") {
      if (input.fundingReturnResume) {
        const previewRecorded = await updatePreviewIntentStatus({
          allowedStatuses: fundingReturnPreviewAllowedStatuses,
          errorCode: "funding_continuation_shortfall_changed",
          errorMessage:
            "Available destination funds no longer cover the fresh quote.",
          quoteSnapshot: buildTelegramTradeQuotePreview(quote),
          result: {
            fundingState: fundingPreview.state,
            previewQuote: quote,
            stage: "funding_continuation_preview",
          },
          status: "previewed",
        });
        if (!previewRecorded) return;
        await input.sendMessage({
          chat_id: input.chatId,
          parse_mode: "MarkdownV2",
          text: formatTelegramTradeLifecycleMessageMarkdownV2({
            heading: "Fresh funding amount needed.",
            tone: "warn",
            lines: [
              `The fresh quote now needs ${formatUsd(maxSpendUsd)}, but only ${formatUsd(
                fundingPreview.availableUsd,
              )} is executable.`,
              "Nothing was submitted. Add the difference, then check funding again.",
            ],
            marketTitle: input.intent.market_title,
            venue: input.intent.venue,
          }),
        });
        return;
      }
      const fundingIdentity =
        (input.inspectTradeShortfall || input.inspectMiniAppFunding) && side
          ? telegramTradeFundingIdentity({
              authorization: input.authorization,
              intent: input.intent,
              market: input.market,
              maximumSpendUsd: maxSpendUsd,
              policy: input.policy,
              quoteExpiresAt: quote.expiresAt,
              side,
            })
          : null;
      let internalFunding: TelegramTradeShortfallInspection | null = null;
      const v2HandoffEligible = canUseTelegramAppHandoffV2({
        intent: input.intent,
        policy: input.policy,
        telegramMiniAppEnabled: input.telegramMiniAppEnabled,
      });
      const preferWebFunding =
        v2HandoffEligible && input.policy.miniAppHandoffMode === "always";
      let miniAppFunding: TelegramTradeMiniAppFundingInspection | null = null;
      const inspectMiniAppFunding = async () => {
        if (!fundingIdentity || !input.inspectMiniAppFunding) return null;
        try {
          return await input.inspectMiniAppFunding(
            fundingIdentity,
            buildTelegramAppHandoffV2TradeSnapshot({
              controllerWalletAddress: input.authorization.wallet_address,
              intent: input.intent,
              market: input.market,
              policy: input.policy,
              quote,
            }),
          );
        } catch (error) {
          input.log?.warn?.(
            {
              error: error instanceof Error ? error.message : "unknown_error",
              event: "telegram_mini_app_funding_inspection_failed",
              intentId: input.intent.id,
            },
            "Telegram Mini App funding inspection failed closed",
          );
          return {
            kind: "temporarily_unavailable" as const,
            reasonCodes: ["funding_planner_unavailable"],
          };
        }
      };
      if (preferWebFunding) {
        miniAppFunding = await inspectMiniAppFunding();
      }
      if (
        fundingIdentity &&
        input.inspectTradeShortfall &&
        // `always` prefers the generic web plan, but it does not turn a
        // transient generic planner failure into a dead end. The exact bot
        // envelope remains the next safe delivery choice, followed only then
        // by interactive Deposit.
        miniAppFunding?.kind !== "web_funding_plan"
      ) {
        try {
          internalFunding = await input.inspectTradeShortfall(fundingIdentity);
        } catch (error) {
          input.log?.warn?.(
            {
              error: error instanceof Error ? error.message : "unknown_error",
              event: "telegram_trade_shortfall_inspection_failed",
              intentId: input.intent.id,
            },
            "Telegram trade shortfall inspection failed closed",
          );
          internalFunding = {
            kind: "temporarily_unavailable",
            reasonCodes: ["funding_planner_unavailable"],
          };
        }
      }
      if (
        v2HandoffEligible &&
        !miniAppFunding &&
        (internalFunding?.kind !== "internal_route" ||
          !input.inspectTradeShortfall)
      ) {
        miniAppFunding = await inspectMiniAppFunding();
      }
      if (miniAppFunding?.kind === "web_funding_plan") {
        // A fallback Buy can begin under a venue-specific bot authorization
        // and then discover that only the user's generic Mini App route is
        // executable. Rebind the still-unsubmitted intent to that same
        // verified controller before publishing its Review.
        const handoffAuthority = await resolveTelegramAppHandoffV2Authorization(
          {
            db: input.db,
            originalAuthorization: input.authorization,
            telegramUserId: input.intent.telegram_user_id,
          },
        );
        if (!handoffAuthority) {
          const previewRecorded = await updatePreviewIntentStatus({
            allowedStatuses: ["draft", "previewed"],
            errorCode: "handoff_authority_unavailable",
            errorMessage:
              "The Mini App wallet authority is unavailable for this funding route.",
            quoteSnapshot: buildTelegramTradeQuotePreview(quote),
            result: {
              fundingState: "checking_internal_balance",
              previewQuote: quote,
              stage: "funding_preview",
            },
            status: "previewed",
          });
          if (!previewRecorded) return;
          await input.sendMessage({
            chat_id: input.chatId,
            parse_mode: "MarkdownV2",
            text: formatTelegramTradeLifecycleMessageMarkdownV2({
              heading: "Mini App funding is temporarily unavailable.",
              tone: "warn",
              lines: ["No Deposit was opened and nothing was submitted."],
              marketTitle: input.intent.market_title,
              venue: input.intent.venue,
            }),
          });
          return;
        }
        await updatePreviewIntentStatus({
          allowedStatuses: replacingRetryableFundingInspection
            ? ["previewed"]
            : ["draft"],
          authorizationId: handoffAuthority.authorization.id,
          deliveryMode: "app_handoff",
          quoteSnapshot: buildTelegramTradeQuotePreview(quote),
          result: {
            appHandoffV2: { plan: miniAppFunding.plan, version: 2 },
            ...buildIntentAuthorityResult(handoffAuthority.binding),
            fundingState: "web_funding_plan",
            previewQuote: quote,
            stage: "funding_preview",
          },
          status: "previewed",
        });
        await sendCurrentConfirmation(handoffAuthority.authorization);
        return;
      }
      if (miniAppFunding?.kind === "destination_ready") {
        if (
          input.intent.delivery_mode === "app_handoff" &&
          !canUseTelegramAppHandoffV2DirectTrade({
            intent: input.intent,
            policy: input.policy,
            telegramMiniAppEnabled: input.telegramMiniAppEnabled,
          })
        ) {
          await input.sendMessage({
            chat_id: input.chatId,
            parse_mode: "MarkdownV2",
            text: formatTelegramTradeLifecycleMessageMarkdownV2({
              heading: "Mini App direct Buy is unavailable.",
              tone: "warn",
              lines: [
                "This market does not yet have a protected direct Mini App Buy boundary. Nothing was submitted.",
              ],
              marketTitle: input.intent.market_title,
              venue: input.intent.venue,
            }),
          });
          return;
        }
        const handoffAuthority =
          input.intent.delivery_mode === "app_handoff"
            ? await resolveTelegramAppHandoffV2Authorization({
                db: input.db,
                originalAuthorization: input.authorization,
                telegramUserId: input.intent.telegram_user_id,
              })
            : null;
        if (input.intent.delivery_mode === "app_handoff" && !handoffAuthority) {
          await input.sendMessage({
            chat_id: input.chatId,
            parse_mode: "MarkdownV2",
            text: formatTelegramTradeLifecycleMessageMarkdownV2({
              heading: "Mini App handoff is temporarily unavailable.",
              tone: "warn",
              lines: [
                "The verified wallet authority could not be checked. Nothing was submitted. Try again shortly.",
              ],
              marketTitle: input.intent.market_title,
              venue: input.intent.venue,
            }),
          });
          return;
        }
        const previewRecorded = await updatePreviewIntentStatus({
          allowedStatuses: fundingReturnPreviewAllowedStatuses,
          authorizationId: handoffAuthority?.authorization.id,
          quoteSnapshot: buildTelegramTradeQuotePreview(quote),
          result: {
            ...(handoffAuthority
              ? {
                  appHandoffV2: {
                    plan: buildTelegramAppHandoffV2DirectTradePlan({
                      controllerWalletAddress:
                        handoffAuthority.authorization.wallet_address,
                      trade: buildTelegramAppHandoffV2TradeSnapshot({
                        controllerWalletAddress:
                          handoffAuthority.authorization.wallet_address,
                        intent: input.intent,
                        market: input.market,
                        policy: input.policy,
                        quote,
                      }),
                    }),
                    version: 2,
                  },
                  ...buildIntentAuthorityResult(handoffAuthority.binding),
                }
              : {}),
            fundingState: "destination_ready",
            previewQuote: quote,
            stage: "funding_preview",
          },
          status: "previewed",
        });
        if (!previewRecorded) {
          await sendCurrentConfirmation(
            handoffAuthority?.authorization ?? input.authorization,
          );
          return;
        }
        const current = await loadIntent(input.db, input.intent.id);
        if (!current) return;
        if (current.delivery_mode === "app_handoff") {
          if (!handoffAuthority) {
            throw new Error(
              "v2 destination-ready handoff is missing authority",
            );
          }
          await sendCurrentConfirmation(handoffAuthority.authorization);
          return;
        }
        const confirming = await transitionIntentToConfirming({
          authorization: input.authorization,
          beforeConfirmLocked: input.beforeConfirmLocked,
          db: input.db,
          intent: current,
        });
        if (confirming !== "confirmed") return;
        await input.sendMessage({
          chat_id: input.chatId,
          ...buildTelegramTradeConfirmationMessage({
            authorization: input.authorization,
            intent: current,
            market: input.market,
            policy: input.policy,
            quote,
            readiness: input.readiness,
          }),
        });
        return;
      }
      if (
        miniAppFunding?.kind === "external_deposit" &&
        internalFunding?.kind !== "internal_route"
      ) {
        // A generic plan can authoritatively say that only a manual external
        // Deposit remains. Prefer that actionable result over a transient
        // server-profile inspection failure.
        internalFunding = { kind: "external_deposit_required" };
      }
      if (
        miniAppFunding?.kind === "temporarily_unavailable" &&
        preferWebFunding &&
        internalFunding == null
      ) {
        internalFunding = {
          kind: "temporarily_unavailable",
          reasonCodes: miniAppFunding.reasonCodes,
        };
      }
      if (internalFunding?.kind === "temporarily_unavailable") {
        const previewRecorded = await updatePreviewIntentStatus({
          allowedStatuses: ["draft", "previewed"],
          quoteSnapshot: buildTelegramTradeQuotePreview(quote),
          result: {
            fundingReasonCodes: internalFunding.reasonCodes,
            fundingState: "checking_internal_balance",
            previewQuote: quote,
            stage: "funding_preview",
          },
          status: "previewed",
        });
        if (!previewRecorded) return;
        await input.sendMessage({
          chat_id: input.chatId,
          parse_mode: "MarkdownV2",
          text: formatTelegramTradeLifecycleMessageMarkdownV2({
            heading: "Checking available Hunch funds.",
            tone: "working",
            lines: [
              "The internal balance or route could not be verified safely. No Deposit was opened and nothing was submitted. Try again shortly.",
            ],
            marketTitle: input.intent.market_title,
            venue: input.intent.venue,
          }),
          reply_markup: buildTelegramTradeShortfallUnavailableReplyMarkup(
            input.intent.id,
            input.intent.venue,
          ),
        });
        return;
      }
      if (internalFunding?.kind === "internal_route") {
        // `internal_route` is executable only by the server profile that just
        // produced it. A Mini App delivery mode may reach this branch when
        // `always`/`fallback` could not build a generic client plan; keep the
        // existing intent, but switch it to its actual bot consumer before
        // issuing Confirm. Leaving it as app_handoff would create a review
        // that the callback correctly refuses because it has no v2 plan.
        const deliveryMode =
          input.intent.delivery_mode === "app_handoff"
            ? "bot_submit"
            : undefined;
        const previewRecorded = await updatePreviewIntentStatus({
          allowedStatuses: ["draft", "previewed"],
          deliveryMode,
          quoteSnapshot: buildTelegramTradeQuotePreview(quote),
          result: {
            fundingProposal: internalFunding.proposal,
            fundingState: "internal_route",
            previewQuote: quote,
            stage: "funding_preview",
          },
          status: "previewed",
        });
        if (!previewRecorded) return;
        const confirming = await transitionIntentToConfirming({
          authorization: input.authorization,
          beforeConfirmLocked: input.beforeConfirmLocked,
          db: input.db,
          intent: input.intent,
        });
        if (confirming !== "confirmed") return;
        const current = await loadIntent(input.db, input.intent.id);
        if (!current) return;
        await input.sendMessage({
          chat_id: input.chatId,
          ...buildTelegramTradeConfirmationMessage({
            authorization: input.authorization,
            intent: current,
            market: input.market,
            policy: input.policy,
            quote,
            readiness: input.readiness,
          }),
        });
        return;
      }
      const previewRecorded = await updatePreviewIntentStatus({
        allowedStatuses: ["draft", "previewed"],
        quoteSnapshot: buildTelegramTradeQuotePreview(quote),
        result: {
          fundingState: fundingPreview.state,
          previewQuote: quote,
          stage: "funding_preview",
        },
        status: "previewed",
      });
      if (!previewRecorded) return;
      if (
        internalFunding?.kind !== "external_deposit_required" &&
        input.inspectTradeShortfall
      ) {
        await input.sendMessage({
          chat_id: input.chatId,
          parse_mode: "MarkdownV2",
          text: formatTelegramTradeLifecycleMessageMarkdownV2({
            heading: "Funding route is still being checked.",
            tone: "working",
            lines: ["No Deposit was opened. Try again shortly."],
            marketTitle: input.intent.market_title,
            venue: input.intent.venue,
          }),
        });
        return;
      }
      const fundingVenue = telegramShortfallVenue(input.intent.venue);
      if (
        shouldOpenTelegramFundingBuyReturn({
          amountUsd,
          buyContinuationEnabled: input.policy.buyContinuationEnabled,
          fundingState: fundingPreview.state,
          hasOpener: input.openFundingBuyReturn != null,
        }) &&
        input.openFundingBuyReturn &&
        amountUsd != null &&
        fundingVenue != null
      ) {
        let fundingMessage: TelegramBotTradingMessage | null;
        try {
          fundingMessage = await input.openFundingBuyReturn({
            authorizationId: input.authorization.id,
            chatId: input.chatId,
            continuationMode: input.intent.delivery_mode,
            eventId: input.intent.event_id,
            idempotencyKey: `funding-return:${input.intent.id}`,
            marketId: input.intent.market_id,
            minimumFundingUsd: resolveTelegramMinimumFundingUsd(
              fundingPreview.shortfallUsd,
            ),
            requestedSpendUsd: String(amountUsd),
            side,
            sourceIntentId: input.intent.id,
            telegramMessageId:
              input.intent.telegram_message_id == null
                ? null
                : Number(input.intent.telegram_message_id),
            telegramUserId: input.intent.telegram_user_id,
            venue: fundingVenue,
          });
        } catch (error) {
          const errorCode =
            error instanceof Error &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : error instanceof Error
                ? error.name
                : "unknown_error";
          input.log?.warn?.(
            {
              errorCode,
              event: "telegram_funding_buy_return_open_failed",
              intentId: input.intent.id,
              marketId: input.intent.market_id,
            },
            "Telegram funding Buy return could not be opened",
          );
          await input.sendMessage({
            chat_id: input.chatId,
            parse_mode: "MarkdownV2",
            text: formatTelegramTradeLifecycleMessageMarkdownV2({
              heading: "Receive setup is temporarily unavailable.",
              tone: "warn",
              lines: [
                "The existing trade was not submitted or replaced. Try again shortly.",
              ],
              marketTitle: input.intent.market_title,
              venue: input.intent.venue,
            }),
          });
          return;
        }
        if (fundingMessage) {
          await input.sendMessage({
            chat_id: input.chatId,
            ...fundingMessage,
          });
          return;
        }
      }
      const marketUrl = openMarketUrl(input.appBaseUrl, input.market);
      const openMarketButton = buildTelegramTradingMiniAppButton({
        appBaseUrl: input.appBaseUrl,
        path: marketUrl,
        telegramMiniAppEnabled: input.telegramMiniAppEnabled,
        text: "Open market",
      });
      if (fundingPreview.state === "convert") {
        const convertUrl = new URL(marketUrl);
        convertUrl.searchParams.set("deposit", "convert");
        const convertStartParam = input.market.event_id
          ? buildSignalBotBuyStartParam({
              amountUsd,
              eventId: input.market.event_id,
              marketId: input.market.id,
              side,
            })
          : null;
        const convertButton = buildHunchMiniAppWebButton({
          appBaseUrl: input.appBaseUrl,
          enabled: input.telegramMiniAppEnabled === true,
          path: convertUrl.toString(),
          startParam: convertStartParam,
          text: "Convert & continue",
        });
        await input.sendMessage({
          chat_id: input.chatId,
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [
              ...telegramTradingButtonRows(convertButton),
              [
                {
                  callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:retry_buy:${input.intent.id}`,
                  text: "🔄 Check balance & continue",
                },
              ],
              ...telegramTradingButtonRows(openMarketButton),
            ],
          },
          text: joinTelegramMarkdownV2Lines([
            `🔄 ${formatTelegramBoldMarkdownV2("Convert to continue")}`,
            "",
            formatTelegramVenueFieldMarkdownV2(input.intent.venue),
            `🎯 ${formatTelegramFieldMarkdownV2(
              "Market",
              `${input.market.title} · ${sideLabel(input.market, side)}`,
            )}`,
            formatTelegramUsdcLineMarkdownV2(
              `Maximum spend: ${formatUsd(maxSpendUsd)}`,
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
          ]),
        });
        return;
      }
      await input.sendMessage({
        chat_id: input.chatId,
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            [
              {
                callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:retry_buy:${input.intent.id}`,
                text: "🔄 Check balance & continue",
              },
            ],
            ...telegramTradingButtonRows(openMarketButton),
          ],
        },
        text: joinTelegramMarkdownV2Lines([
          `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramBoldMarkdownV2(
            "Deposit to continue",
          )}`,
          "",
          formatTelegramVenueFieldMarkdownV2(input.intent.venue),
          `🎯 ${formatTelegramFieldMarkdownV2(
            "Market",
            `${input.market.title} · ${sideLabel(input.market, side)}`,
          )}`,
          formatTelegramUsdcLineMarkdownV2(
            `Order: ${formatUsd(amountUsd ?? 0)}`,
          ),
          formatTelegramUsdcLineMarkdownV2(
            `Maximum spend: ${formatUsd(maxSpendUsd)}`,
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
          formatTelegramCalloutMarkdownV2({
            bodyMarkdownV2:
              "Open Add funds from the bot menu or Hunch to request a verified receive address\\.",
            icon: "ℹ️",
            title: "Add funds",
          }),
        ]),
      });
      return;
    }
  }
  let previewAuthorization = input.authorization;
  let previewHandoffBinding: TelegramBotTradeAuthorityBinding | null = null;
  let directHandoffPlan: TelegramAppHandoffV2Plan | null = null;
  if (input.intent.delivery_mode === "app_handoff") {
    if (
      !canUseTelegramAppHandoffV2DirectTrade({
        intent: input.intent,
        policy: input.policy,
        telegramMiniAppEnabled: input.telegramMiniAppEnabled,
      })
    ) {
      await input.sendMessage({
        chat_id: input.chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Mini App handoff is unavailable.",
          tone: "warn",
          lines: [
            "The current policy no longer permits this protected Buy handoff. Nothing was submitted. Open the market for a fresh Review.",
          ],
          marketTitle: input.intent.market_title,
          venue: input.intent.venue,
        }),
      });
      return;
    }
    const handoffAuthority = await resolveTelegramAppHandoffV2Authorization({
      db: input.db,
      originalAuthorization: input.authorization,
      telegramUserId: input.intent.telegram_user_id,
    });
    if (!handoffAuthority) {
      await input.sendMessage({
        chat_id: input.chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Mini App handoff is temporarily unavailable.",
          tone: "warn",
          lines: [
            "The verified wallet authority could not be checked. Nothing was submitted. Try again shortly.",
          ],
          marketTitle: input.intent.market_title,
          venue: input.intent.venue,
        }),
      });
      return;
    }
    previewAuthorization = handoffAuthority.authorization;
    previewHandoffBinding = handoffAuthority.binding;
    directHandoffPlan = buildTelegramAppHandoffV2DirectTradePlan({
      controllerWalletAddress: handoffAuthority.authorization.wallet_address,
      trade: buildTelegramAppHandoffV2TradeSnapshot({
        controllerWalletAddress: handoffAuthority.authorization.wallet_address,
        intent: input.intent,
        market: input.market,
        policy: input.policy,
        quote,
      }),
    });
  }
  const directHandoffResult = directHandoffPlan
    ? (() => {
        if (!previewHandoffBinding) {
          throw new Error("v2 direct handoff is missing its authority binding");
        }
        return {
          appHandoffV2: { plan: directHandoffPlan, version: 2 },
          ...buildIntentAuthorityResult(previewHandoffBinding),
        };
      })()
    : {};
  const previewRecorded = await updatePreviewIntentStatus({
    // A quote is the immutable Review snapshot. Concurrent callbacks can each
    // obtain a live quote, but only the draft/status CAS or the exact retry
    // state CAS may publish one; a loser cannot replace the winning plan/quote.
    allowedStatuses: replacingRetryableFundingInspection
      ? ["previewed"]
      : ["draft"],
    authorizationId: previewAuthorization.id,
    quoteSnapshot: buildTelegramTradeQuotePreview(quote),
    result: {
      ...directHandoffResult,
      ...(replacingRetryableFundingInspection
        ? {
            fundingReasonCodes: [],
            fundingState: "destination_ready",
            stage: "funding_preview",
          }
        : {}),
      previewQuote: quote,
    },
    status: "previewed",
  });
  if (!previewRecorded) {
    if (!replacingRetryableFundingInspection) {
      await sendCurrentConfirmation(previewAuthorization);
    }
    return;
  }
  if (input.intent.delivery_mode === "app_handoff") {
    const current = await loadIntent(input.db, input.intent.id);
    if (!current) return;
    if (!current.funding_reservation_id) {
      await sendCurrentConfirmation(previewAuthorization);
      return;
    }
    const handoffMessage = await sealConfirmedTelegramAppHandoff({
      authorization: input.authorization,
      db: input.db,
      intent: current,
      market: input.market,
      policy: input.policy,
      quote,
    });
    if (!handoffMessage) return;
    await input.sendMessage({
      chat_id: input.chatId,
      ...handoffMessage,
    });
    return;
  }
  const confirming = await transitionIntentToConfirming({
    authorization: input.authorization,
    beforeConfirmLocked: input.beforeConfirmLocked,
    db: input.db,
    intent: input.intent,
  });
  if (confirming !== "confirmed") {
    if (confirming === "overtaken" && (await sendCurrentConfirmation())) {
      return;
    }
    await input.sendMessage({
      chat_id: input.chatId,
      parse_mode: "MarkdownV2",
      text: formatTelegramTradeLifecycleMessageMarkdownV2({
        heading:
          confirming === "blocked"
            ? "Trade is still resolving."
            : "Trade state changed while opening confirmation.",
        tone: confirming === "blocked" ? "working" : "warn",
        lines: ["Check /trade_status before trying again."],
        marketTitle: input.intent.market_title,
        venue: input.intent.venue,
      }),
    });
    return;
  }
  await input.sendMessage({
    chat_id: input.chatId,
    ...buildTelegramTradeConfirmationMessage({
      authorization: input.authorization,
      intent: input.intent,
      market: input.market,
      policy: input.policy,
      quote,
      readiness: input.readiness,
    }),
  });
}

function normalizeTelegramTradeInputSyntax(
  action: "buy" | "sell",
  raw: string,
): Readonly<{
  inputMode: "all" | "percent" | "shares" | "usd";
  value: string;
}> | null {
  if (action === "buy") {
    const parsed = parseTelegramCustomBuyAmount(raw);
    return parsed ? { inputMode: "usd", value: parsed.normalized } : null;
  }
  const value = raw.trim();
  if (/^all$/iu.test(value)) return { inputMode: "all", value: "all" };
  const percent = parseTelegramSellPercentage(value);
  if (percent) {
    return {
      inputMode: "percent",
      value: percent.normalized,
    };
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)) return null;
  const sharesRaw = decimalToRaw(value, 6);
  return sharesRaw != null && sharesRaw > 0n
    ? { inputMode: "shares", value: ethers.formatUnits(sharesRaw, 6) }
    : null;
}

function telegramTradeInputFingerprint(input: {
  action: "buy" | "sell";
  chatId: string;
  contextId: string;
  marketId: string;
  normalizedValue: string;
  side: TelegramBotTradingSide;
  telegramUserId: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        action: input.action,
        chatId: input.chatId,
        contextId: input.contextId,
        marketId: input.marketId,
        normalizedValue: input.normalizedValue,
        side: input.side,
        telegramUserId: input.telegramUserId,
        version: 1,
      }),
    )
    .digest("hex");
}

function buildTelegramTradeInputNotice(input: {
  body: string;
  marketIntentId?: string | null;
  title: string;
}): TelegramBotTradingMessage {
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        ...(input.marketIntentId
          ? [
              [
                {
                  callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:open_market:${input.marketIntentId}`,
                  text: "🎯 Open market",
                },
              ],
            ]
          : []),
        [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
      ],
    },
    text: formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2: escapeMarkdown(input.body),
      icon: "⚠️",
      title: input.title,
    }),
  };
}

function readTelegramInputMarker(
  intent: TelegramTradeIntentRow,
): Record<string, unknown> | null {
  return isRecord(intent.result) && isRecord(intent.result.telegramInput)
    ? intent.result.telegramInput
    : null;
}

function readTelegramInputMode(
  intent: TelegramTradeIntentRow,
): "all" | "percent" | "shares" | "usd" | null {
  const value = readTelegramInputMarker(intent)?.inputMode;
  return value === "all" ||
    value === "percent" ||
    value === "shares" ||
    value === "usd"
    ? value
    : null;
}

function readTelegramInputSharesRaw(
  intent: TelegramTradeIntentRow,
  field: "executableSharesRaw" | "requestedSharesRaw",
): bigint | null {
  const value = readTelegramInputMarker(intent)?.[field];
  return typeof value === "string" && /^\d+$/u.test(value)
    ? BigInt(value)
    : null;
}

function customIntentMatches(input: {
  fingerprint: string;
  intent: TelegramTradeIntentRow;
  contextId: string;
  chatId: string;
  telegramUserId: string;
}): boolean {
  const marker = readTelegramInputMarker(input.intent);
  return Boolean(
    marker?.version === 1 &&
    marker.contextId === input.contextId &&
    marker.fingerprint === input.fingerprint &&
    input.intent.chat_id === input.chatId &&
    input.intent.telegram_user_id === input.telegramUserId,
  );
}

export async function completeTelegramBotTradeInput(input: {
  appBaseUrl: string;
  chatId: string;
  contextId: string;
  db: DbQuery;
  estimateRetainedSolUsd?: (raw: string) => Promise<string | null>;
  isLinkCurrent: () => Promise<boolean>;
  loadContext: () => Promise<TelegramBotTradeInputContext | null>;
  openFundingBuyReturn?: TelegramFundingBuyReturnOpener;
  inspectMiniAppFunding?: TelegramBotTradingCallbackInput["inspectMiniAppFunding"];
  inspectTradeShortfall?: TelegramBotTradingCallbackInput["inspectTradeShortfall"];
  telegramMessageId: number;
  telegramMiniAppEnabled?: boolean;
  telegramUserId: string;
  trading: ApiBotTradingExecutor;
  value: string;
}): Promise<{
  completed: boolean;
  message: TelegramBotTradingMessage;
}> {
  const idempotencyKey = `telegram-bot-input:${input.contextId}`;
  let intent = await loadIntentByIdempotencyKey(input.db, idempotencyKey);
  let context: TelegramBotTradeInputContext | null = null;
  const action =
    intent?.action === "sell"
      ? "sell"
      : intent?.action === "buy"
        ? "buy"
        : null;
  const syntax = action
    ? normalizeTelegramTradeInputSyntax(action, input.value)
    : null;
  if (intent) {
    if (!syntax || !intent.side || !action) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "This input does not match the amount already recorded for this request.",
          title: "Input conflict",
        }),
      };
    }
    const fingerprint = telegramTradeInputFingerprint({
      action,
      chatId: input.chatId,
      contextId: input.contextId,
      marketId: intent.market_id,
      normalizedValue: syntax.value,
      side: intent.side,
      telegramUserId: input.telegramUserId,
    });
    if (
      !customIntentMatches({
        chatId: input.chatId,
        contextId: input.contextId,
        fingerprint,
        intent,
        telegramUserId: input.telegramUserId,
      })
    ) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "This request was already used with a different amount or identity.",
          title: "Input conflict",
        }),
      };
    }
    // An input context is scoped to this intent, chat, and Telegram user above.
    // Once its trade intent has expired, never run the current policy/readiness
    // path: it cannot make that intent executable again and obscures the only
    // useful recovery action, opening the same market card for a fresh review.
    if (intent.expires_at.getTime() <= Date.now()) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "This trade intent expired. Open the market card again.",
          marketIntentId: intent.id,
          title: "Input expired",
        }),
      };
    }
  } else {
    context = await input.loadContext();
    if (
      !context ||
      context.id !== input.contextId ||
      context.chatId !== input.chatId ||
      context.telegramUserId !== input.telegramUserId ||
      Date.parse(context.expiresAt) <= Date.now()
    ) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "This custom amount request expired. Open the market card again.",
          title: "Input expired",
        }),
      };
    }
  }

  const targetAction =
    intent?.action === "sell"
      ? "sell"
      : intent?.action === "buy"
        ? "buy"
        : context?.action;
  if (!targetAction) {
    return {
      completed: false,
      message: buildTelegramTradeInputNotice({
        body: "Open the market card again.",
        title: "Input unavailable",
      }),
    };
  }
  const parsedSyntax = normalizeTelegramTradeInputSyntax(
    targetAction,
    input.value,
  );
  if (!parsedSyntax) {
    return {
      completed: false,
      message: buildTelegramTradeInputNotice({
        body:
          targetAction === "buy"
            ? "Enter a positive USD amount with at most two decimals, for example 2.50."
            : "Enter exact shares with at most six decimals, an explicit percentage such as 25%, or all.",
        title: "Invalid amount",
      }),
    };
  }

  const [policy, market] = await Promise.all([
    resolveTelegramBotTradingPolicy(input.db),
    loadMarketById(input.db, intent?.market_id ?? context?.marketId ?? ""),
  ]);
  const targetVenue = intent?.venue ?? context?.venue ?? "polymarket";
  const deliveryMode = intent?.delivery_mode ?? context?.deliveryMode;
  if (!deliveryMode) {
    return {
      completed: false,
      message: buildTelegramTradeInputNotice({
        body: "This request is missing its execution method. Open the market card again.",
        title: "Input unavailable",
      }),
    };
  }
  const authorization =
    deliveryMode === "app_handoff"
      ? await loadEnabledEvmAuthorization(input.db, input.telegramUserId, {
          allowInactiveForV2:
            policy.miniAppHandoffContractVersion >= 2 &&
            isTelegramAppHandoffV2TradeVenue(targetVenue),
        })
      : await loadEnabledAuthorization(
          input.db,
          input.telegramUserId,
          targetVenue,
        );
  const marketId = intent?.market_id ?? context?.marketId ?? "";
  const side = intent?.side ?? context?.side ?? null;
  const executionCapability = resolveTelegramTradeExecutionCapability({
    action: targetAction,
    venue: targetVenue,
    walletChain: authorization?.wallet_chain ?? null,
  });
  const policyVenueAllowsDelivery =
    policy.tradingVenues.includes(targetVenue) ||
    (deliveryMode === "app_handoff" &&
      executionCapability.sealedAppHandoffExact &&
      (targetAction === "sell" ||
        (policy.fundingReceiveEnabled && policy.buyContinuationEnabled)));
  const actionAllowed =
    policy.tradingEnabled &&
    policy.customTradeInputEnabled &&
    policy.tradingActions.includes(targetAction) &&
    policyVenueAllowsDelivery;
  const lifecycleAllowed = await venueLifecycleAllows(
    input.db,
    targetVenue,
    targetAction === "buy" ? "increaseExposure" : "reduceExposure",
  );
  if (
    !actionAllowed ||
    !lifecycleAllowed ||
    !market ||
    market.id !== marketId ||
    market.venue !== targetVenue ||
    !isMarketOrderable(market) ||
    !side ||
    !authorization ||
    !authorization.privy_wallet_id
  ) {
    return {
      completed: false,
      message: buildTelegramTradeInputNotice({
        body: "Trading policy, market state, or wallet authorization changed. Open the market card again.",
        title: "Trade not ready",
      }),
    };
  }
  const authorityMatches = intent
    ? intentMatchesTelegramTradeAuthority({ authorization, intent })
    : Boolean(
        context &&
        sameTelegramTradeAuthorityBinding(context.authority, authorization),
      );
  if (!authorityMatches) {
    return {
      completed: false,
      message: buildTelegramTradeInputNotice({
        body: "The linked Hunch account or Trading Wallet changed. Open the market card again.",
        title: "Account binding changed",
      }),
    };
  }
  if (!(await input.isLinkCurrent())) {
    return {
      completed: false,
      message: buildTelegramTradeInputNotice({
        body: "The linked Telegram account changed. Open the market card again.",
        title: "Account link changed",
      }),
    };
  }
  if (
    targetVenue === "polymarket" &&
    context?.controlledPositionId &&
    context.funderAddress
  ) {
    const credentials = await AuthService.getVenueCredentialsInfo(
      authorization.user_id,
      "polymarket",
      authorization.wallet_address,
    ).catch(() => null);
    if (
      !credentials?.funderAddress ||
      !sameAccountAddress(
        "evm:137",
        credentials.funderAddress,
        context.funderAddress,
      )
    ) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "The controlled position binding changed. Open My positions again.",
          title: "Position changed",
        }),
      };
    }
  }
  const readiness = await resolveTelegramTradingReadiness({
    action: targetAction === "sell" ? "SELL" : "BUY",
    authorization,
    market:
      targetAction === "sell"
        ? marketForCallbackReadiness("SELL", market)
        : market,
    trading: input.trading,
    venue: targetVenue,
  });
  if (
    targetAction === "buy"
      ? !canPreviewBuyForDelivery({ deliveryMode, readiness })
      : deliveryMode !== "app_handoff" && !canOfferTradeForReadiness(readiness)
  ) {
    return {
      completed: false,
      message: buildTelegramTradeInputNotice({
        body: readiness.message ?? "Direct trading is not ready.",
        title: "Trade not ready",
      }),
    };
  }
  const unresolvedIntent = await loadUnresolvedTelegramTradeIntent(input.db, {
    excludeIntentId: intent?.id,
    marketId: market.id,
    telegramUserId: input.telegramUserId,
  });
  if (unresolvedIntent) {
    return {
      completed: false,
      message: buildTelegramTradeInputNotice({
        body: EXISTING_TRADE_RESOLVING_MESSAGE,
        title: "Trade is still resolving",
      }),
    };
  }

  let amountUsd: number | null = null;
  let sharesRaw: bigint | null = null;
  let requestedSharesRaw: bigint | null = null;
  let availableSharesRaw: bigint | null = null;
  let sellPercent: number | null = null;
  let inputMode = parsedSyntax.inputMode;
  if (targetAction === "buy") {
    const parsed = parseTelegramCustomBuyAmount(input.value);
    const maxAmountUsd = resolveTelegramBuyIntentMaximumAmountUsd({
      authorizationMaxAmountUsd: authorization.max_amount_usd,
      deliveryMode,
      policy,
      venue: targetVenue,
    });
    if (!parsed || parsed.amountUsd > maxAmountUsd) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: `Enter an amount no greater than ${formatUsd(maxAmountUsd)}.`,
          title: "Amount exceeds policy",
        }),
      };
    }
    amountUsd = parsed.amountUsd;
  } else {
    const tokenId = side === "YES" ? market.token_yes : market.token_no;
    if (!tokenId) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "The selected outcome token is unavailable.",
          title: "Position unavailable",
        }),
      };
    }
    const availability = await resolveTelegramAvailablePositionRaw({
      pool: input.db,
      signer: authorization.wallet_address,
      tokenId,
      userId: authorization.user_id,
      venue: market.venue,
    }).catch(() => null);
    availableSharesRaw = availability?.availableRaw ?? null;
    const parsed =
      !intent && availability
        ? parseTelegramCustomSellAmount(input.value, availability.availableRaw)
        : null;
    const recordedSharesRaw =
      intent?.shares_raw && /^\d+$/u.test(intent.shares_raw)
        ? BigInt(intent.shares_raw)
        : null;
    if (
      (!intent && !parsed) ||
      (intent && recordedSharesRaw == null) ||
      (recordedSharesRaw != null &&
        recordedSharesRaw > (availability?.availableRaw ?? 0n))
    ) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "The requested quantity is unavailable. Enter no more than the currently available shares.",
          title: "Sell amount unavailable",
        }),
      };
    }
    requestedSharesRaw = parsed?.sharesRaw ?? null;
    sharesRaw = recordedSharesRaw ?? parsed?.sharesRaw ?? null;
    sellPercent = intent
      ? parseNumber(intent.sell_percent)
      : (parsed?.sellPercent ?? null);
    inputMode = intent
      ? (readTelegramInputMode(intent) ?? "shares")
      : (parsed?.inputMode ?? "shares");
  }

  const normalizedValue = parsedSyntax.value;
  const fingerprint = telegramTradeInputFingerprint({
    action: targetAction,
    chatId: input.chatId,
    contextId: input.contextId,
    marketId: market.id,
    normalizedValue,
    side,
    telegramUserId: input.telegramUserId,
  });
  const provisionalIntentId = intent?.id ?? crypto.randomUUID();
  const provisionalTradeIntent =
    targetAction === "sell" && sharesRaw != null
      ? buildTelegramSellTradeIntent({
          authorization,
          intentId: provisionalIntentId,
          market,
          maxSlippageBps: policy.maxSlippageBps,
          sharesRaw,
          side,
        })
      : buildTelegramTradeIntent({
          amountUsd: amountUsd as number,
          authorization,
          intentId: provisionalIntentId,
          market,
          maxSlippageBps: policy.maxSlippageBps,
          side,
        });
  let quoteOverride: TradeQuote | undefined;
  if (!intent) {
    const creationContext = context;
    if (!creationContext) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "Open the market card again.",
          title: "Input unavailable",
        }),
      };
    }
    try {
      quoteOverride = await input.trading.quote({
        intent: provisionalTradeIntent,
      });
    } catch {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "A fresh quote is unavailable. Try the same amount again shortly.",
          title: "Quote unavailable",
        }),
      };
    }
    const maxAmountUsd = resolveTelegramBuyIntentMaximumAmountUsd({
      authorizationMaxAmountUsd: authorization.max_amount_usd,
      deliveryMode,
      policy,
      venue: targetVenue,
    });
    const quoteMaxSpendUsd = quoteOverride.maxSpendUsd ?? amountUsd;
    if (
      isTelegramVenueMinimumBlocking({
        action: provisionalTradeIntent.action,
        meetsVenueMinimum: quoteOverride.meetsVenueMinimum,
        orderType: provisionalTradeIntent.orderType,
        venue: provisionalTradeIntent.venue,
      }) ||
      (targetAction === "buy" &&
        (quoteMaxSpendUsd == null || quoteMaxSpendUsd > maxAmountUsd))
    ) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body:
            targetAction === "buy"
              ? `Maximum total spend exceeds ${formatUsd(maxAmountUsd)}.`
              : "The current sell quote is not executable.",
          title: "Amount not executable",
        }),
      };
    }
    if (targetAction === "sell") {
      const executableSharesRaw =
        sharesRaw != null &&
        requestedSharesRaw != null &&
        availableSharesRaw != null
          ? resolveExecutableTelegramSellSharesRaw({
              availableRaw: availableSharesRaw,
              quote: quoteOverride,
              requestedRaw: requestedSharesRaw,
            })
          : null;
      if (executableSharesRaw == null) {
        return {
          completed: false,
          message: buildTelegramTradeInputNotice({
            body: "The venue did not return a safe executable sell quantity. Try again shortly.",
            title: "Sell quote unavailable",
          }),
        };
      }
      sharesRaw = executableSharesRaw;
    }
    const expiresAt = new Date(
      Math.min(
        Date.parse(creationContext.expiresAt),
        Date.now() + policy.intentTtlSec * 1_000,
      ),
    );
    const marker = {
      action: targetAction,
      contextId: input.contextId,
      fingerprint,
      inputMode,
      normalizedValue,
      ...(requestedSharesRaw == null
        ? {}
        : { requestedSharesRaw: requestedSharesRaw.toString() }),
      ...(sharesRaw == null
        ? {}
        : { executableSharesRaw: sharesRaw.toString() }),
      version: 1,
    };
    const currentAuthorization =
      deliveryMode === "app_handoff"
        ? await loadEnabledEvmAuthorization(input.db, input.telegramUserId, {
            allowInactiveForV2:
              policy.miniAppHandoffContractVersion >= 2 &&
              isTelegramAppHandoffV2TradeVenue(targetVenue),
          })
        : await loadEnabledAuthorization(
            input.db,
            input.telegramUserId,
            creationContext.venue,
          );
    if (
      !(await input.isLinkCurrent()) ||
      !sameTelegramTradeAuthorityBinding(
        creationContext.authority,
        currentAuthorization,
      )
    ) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "The linked Hunch account or Trading Wallet changed before the trade preview was recorded.",
          title: "Account binding changed",
        }),
      };
    }
    await input.db.query(
      `INSERT INTO telegram_trade_intents (
         id, telegram_user_id, user_id, authorization_id, chat_id,
         telegram_message_id, delivery_mode, action, venue, market_id, event_id, side,
         amount_usd, sell_percent, shares_raw, status, quote_snapshot,
         policy_snapshot, result, expires_at, idempotency_key
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, 'draft', $16::jsonb, $17::jsonb, $18::jsonb, $19, $20
       )
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        provisionalIntentId,
        input.telegramUserId,
        creationContext.authority.userId,
        creationContext.authority.authorizationId,
        input.chatId,
        input.telegramMessageId,
        deliveryMode,
        targetAction,
        targetVenue,
        market.id,
        market.event_id,
        side,
        amountUsd,
        sellPercent,
        sharesRaw?.toString() ?? null,
        JSON.stringify(buildTelegramTradeQuotePreview(quoteOverride)),
        JSON.stringify(buildPolicySnapshot(policy)),
        JSON.stringify({
          ...buildIntentAuthorityResult(creationContext.authority),
          telegramInput: marker,
        }),
        expiresAt,
        idempotencyKey,
      ],
    );
    intent = await loadIntentByIdempotencyKey(input.db, idempotencyKey);
    if (
      !intent ||
      !customIntentMatches({
        chatId: input.chatId,
        contextId: input.contextId,
        fingerprint,
        intent,
        telegramUserId: input.telegramUserId,
      })
    ) {
      return {
        completed: false,
        message: buildTelegramTradeInputNotice({
          body: "This request was completed concurrently with a different amount.",
          title: "Input conflict",
        }),
      };
    }
  }

  if (!intent || intent.expires_at.getTime() <= Date.now()) {
    return {
      completed: false,
      message: buildTelegramTradeInputNotice({
        body: "This trade intent expired. Open the market card again.",
        marketIntentId: intent?.id,
        title: "Input expired",
      }),
    };
  }
  if (isTerminalIntentStatus(intent.status) || intent.status === "executing") {
    return {
      completed: true,
      message: buildTelegramTradeInputNotice({
        body: `Current trade status: ${intent.status}. Check /trade_status before retrying.`,
        marketIntentId: intent.id,
        title: "Trade already processed",
      }),
    };
  }
  const messages: TelegramBotTradingMessage[] = [];
  await previewTelegramTradeIntent({
    appBaseUrl: input.appBaseUrl,
    authorization,
    chatId: input.chatId,
    db: input.db,
    estimateRetainedSolUsd: input.estimateRetainedSolUsd,
    intent,
    market,
    maxAmountUsd: resolveTelegramBuyIntentMaximumAmountUsd({
      authorizationMaxAmountUsd: authorization.max_amount_usd,
      deliveryMode: intent.delivery_mode,
      policy,
      venue: intent.venue,
    }),
    openFundingBuyReturn: input.openFundingBuyReturn,
    inspectMiniAppFunding: input.inspectMiniAppFunding,
    inspectTradeShortfall: input.inspectTradeShortfall,
    policy,
    quoteOverride,
    readiness,
    sendMessage: async (message) => {
      messages.push(message);
      return undefined;
    },
    telegramMiniAppEnabled: input.telegramMiniAppEnabled,
    trading: input.trading,
  });
  return {
    completed: true,
    message:
      messages.at(-1) ??
      buildTelegramTradeInputNotice({
        body: "Check /trade_status before trying again.",
        title: "Trade state changed",
      }),
  };
}

function hasClaimedOrCommittedTelegramAppHandoffV2(
  intent: Pick<TelegramTradeIntentRow, "delivery_mode" | "result">,
): boolean {
  if (intent.delivery_mode !== "app_handoff") return false;
  const consent = isRecord(intent.result.appHandoffConsent)
    ? intent.result.appHandoffConsent
    : null;
  const execution = isRecord(intent.result.appHandoffExecution)
    ? intent.result.appHandoffExecution
    : null;
  return (
    (consent?.version === 2 && typeof consent.handoffId === "string") ||
    (execution?.version === 2 && typeof execution.handoffId === "string")
  );
}

export async function handleTelegramBotTradingCallback(
  input: TelegramBotTradingCallbackInput,
): Promise<boolean> {
  const parsed = parseTelegramBotTradingCallbackData(input.callbackQuery.data);
  if (!parsed) return false;
  if (parsed.type === "buy_input" || parsed.type === "sell_input") {
    return false;
  }
  if (!("intentId" in parsed)) return false;
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
  // `retry_buy` is the stable historical callback identifier for reopening or
  // resuming a sealed card. It is not a Buy submission, so direct Sell cards
  // use it too; the sealed handoff still enforces the actual trade action.
  if (
    (parsed.type === "buy" && intent.action !== "buy") ||
    (parsed.type === "change_amount" && intent.action !== "buy") ||
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
  const sourceMessageId = input.callbackQuery.message?.message_id ?? null;
  const lifecycleDeliveryEligible = isTelegramTradeLifecycleDeliveryEligible({
    chatId: intent.chat_id,
    deliveryMode: intent.delivery_mode,
    fundingOperationId: intent.funding_operation_id,
    result: intent.result,
    telegramMessageId: intent.telegram_message_id,
  });
  if (
    sourceMessageId != null &&
    intent.telegram_message_id != null &&
    String(sourceMessageId) !== intent.telegram_message_id &&
    lifecycleDeliveryEligible
  ) {
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      showAlert: true,
      text: "⚠️ This trade card is no longer current. Use the latest card.",
    });
    return true;
  }
  const callbackMessageId = resolveTelegramCallbackMessageId(
    intent.telegram_message_id,
    input.callbackQuery.message?.message_id,
  );
  const marketNavigation = {
    inline_keyboard: [
      [
        {
          callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:open_market:${intent.id}`,
          text: "🎯 Open market",
        },
      ],
      [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
    ],
  } satisfies TelegramBotTradingReplyMarkup;
  const sendCurrentMarketCard = async (
    focusSide: TelegramBotTradingSide | null = null,
  ): Promise<boolean> => {
    // The user explicitly chose a different screen. Fence the old Telegram
    // message before building it so a pending lifecycle revision cannot later
    // overwrite the fresh market card. The next lifecycle state, if any, is
    // sent as a new message and safely establishes a new editable generation.
    if (callbackMessageId != null) {
      const fenced = await fenceTelegramTradeLifecycleNavigation({
        chatId,
        db: input.db,
        intentId: intent.id,
        messageId: callbackMessageId,
        telegramUserId: intent.telegram_user_id,
      });
      if (lifecycleDeliveryEligible && fenced !== 1) return false;
    }
    const marketMessage = await buildTelegramBotTradingMarketMessage({
      appBaseUrl: input.appBaseUrl,
      chatId,
      context: {
        ...(focusSide ? { focusSide } : {}),
        origin: "direct",
      },
      db: input.db,
      marketRef: intent.market_id,
      signerInspector: input.signerInspector,
      telegramMessageId: callbackMessageId,
      telegramMiniAppEnabled: input.telegramMiniAppEnabled,
      telegramUserId: intent.telegram_user_id,
      trading: input.trading,
      writeTradeInputContext: input.writeTradeInputContext,
    }).catch(() => null);
    await input.sendMessage({
      chat_id: chatId,
      ...(marketMessage ?? {
        parse_mode: "MarkdownV2" as const,
        reply_markup: marketNavigation,
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Market is temporarily unavailable.",
          tone: "warn",
          lines: ["Try Open market again or return Home."],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
      }),
    });
    return true;
  };
  if (parsed.type === "open_market") {
    // This callback is navigation only. It deliberately works for expired and
    // terminal intents and never changes a trade, funding operation, or quote.
    const opened = await sendCurrentMarketCard();
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      ...(opened
        ? { text: "Opening the current market card…" }
        : {
            showAlert: true,
            text: "⚠️ This trade card is no longer current. Use the latest card.",
          }),
    });
    return true;
  }
  if (sourceMessageId != null) {
    const rebound = await input.db.query(
      `UPDATE telegram_trade_intents
          SET telegram_message_id = $2,
              callback_query_id = $3,
              updated_at = now()
        WHERE id = $1
          AND (
            telegram_message_id IS NULL
            OR telegram_message_id = $2::bigint
          )
        RETURNING id`,
      [intent.id, sourceMessageId, input.callbackQuery.id],
    );
    if ((rebound.rowCount ?? 0) !== 1) {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "⚠️ This trade card is no longer current. Use the latest card.",
      });
      return true;
    }
    intent.telegram_message_id = String(sourceMessageId);
  }
  const restoredFundingVenue = telegramShortfallVenue(intent.venue);
  const isV2DirectHandoff =
    intent.funding_operation_id == null &&
    readTelegramAppHandoffV2Plan(intent)?.kind === "direct_trade";
  const appHandoffExecutionMarker = isRecord(intent.result.appHandoffExecution)
    ? intent.result.appHandoffExecution
    : null;
  const claimedOrCommittedV2AppHandoff =
    hasClaimedOrCommittedTelegramAppHandoffV2(intent);
  const committedFundedAppHandoffId =
    intent.delivery_mode === "app_handoff" &&
    intent.action === "buy" &&
    intent.funding_operation_id != null &&
    appHandoffExecutionMarker?.version === 2 &&
    (appHandoffExecutionMarker.kind == null ||
      appHandoffExecutionMarker.kind === "funding") &&
    typeof appHandoffExecutionMarker.handoffId === "string"
      ? appHandoffExecutionMarker.handoffId
      : null;
  const committedFundedAppHandoff = committedFundedAppHandoffId != null;
  if (
    parsed.type === "retry_buy" &&
    intent.status === "cancelled" &&
    intent.error_code === "superseded_via_funding" &&
    intent.action === "buy" &&
    intent.authorization_id &&
    intent.side &&
    intent.amount_usd &&
    input.openFundingBuyReturn &&
    restoredFundingVenue != null
  ) {
    try {
      const fundingMessage = await input.openFundingBuyReturn({
        authorizationId: intent.authorization_id,
        chatId,
        continuationMode: intent.delivery_mode,
        eventId: intent.event_id,
        idempotencyKey: `funding-return:${intent.id}`,
        marketId: intent.market_id,
        requestedSpendUsd: intent.amount_usd,
        side: intent.side,
        sourceIntentId: intent.id,
        telegramMessageId: callbackMessageId,
        telegramUserId: intent.telegram_user_id,
        venue: restoredFundingVenue,
      });
      if (fundingMessage) {
        await input.answerCallbackQuery({
          callbackQueryId: input.callbackQuery.id,
          text: "✅ Funding session restored.",
        });
        await input.sendMessage({ chat_id: chatId, ...fundingMessage });
        return true;
      }
    } catch {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "⚠️ Funding session is temporarily unavailable. Try the same button again.",
      });
      return true;
    }
  }
  if (
    parsed.type === "retry_buy" &&
    ["cancelled", "expired", "failed", "filled"].includes(intent.status)
  ) {
    // Compatibility for cards emitted before `open_market` existed. New cards
    // use the explicit navigation callback; `retry_buy` remains a real resume
    // and status action for non-terminal work.
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      text: "Opening a fresh market card…",
    });
    await sendCurrentMarketCard();
    return true;
  }
  const cancellationOperationId = intent.funding_operation_id;
  const cancellationUserId = intent.user_id;
  const cancellingFundingIntent =
    parsed.type === "cancel" &&
    intent.status === "funding" &&
    cancellationOperationId != null &&
    cancellationUserId != null &&
    intent.submit_started_at == null;
  let cancellingFundingPreparation = false;
  let cancellingBuyContinuation = false;
  if (cancellingFundingIntent) {
    const cancellationSafety = await input.db.query<{
      external_boundary_crossed: boolean;
    }>(
      `select exists (
         select 1
         from funding_operation_steps step_row
         left join funding_operation_step_attempts attempt_row
           on attempt_row.step_id = step_row.id
         where step_row.operation_id = $1::uuid
           and (
             attempt_row.id is not null
             or step_row.state not in ('planned', 'action_required')
           )
       ) or exists (
         select 1
         from funding_observations observation_row
         where observation_row.operation_id = $1::uuid
       ) as external_boundary_crossed
       from funding_operations operation_row
      where operation_row.id = $1::uuid
        and operation_row.user_id = $2::uuid`,
      [cancellationOperationId, cancellationUserId],
    );
    if (cancellationSafety.rows[0]?.external_boundary_crossed === false) {
      if (!input.cancelFundingOperation) {
        await input.answerCallbackQuery({
          callbackQueryId: input.callbackQuery.id,
          showAlert: true,
          text: "⚠️ Funding cancellation is temporarily unavailable. Nothing was changed.",
        });
        return true;
      }
      try {
        await input.cancelFundingOperation({
          operationId: cancellationOperationId,
          userId: cancellationUserId,
        });
        cancellingFundingPreparation = true;
      } catch {
        // A worker can cross the boundary after the read above. It is still
        // always safe to stop only the Buy continuation.
        cancellingBuyContinuation = true;
      }
    } else {
      // Funding is on-chain now and must continue to reconciliation. Cancel
      // only the Buy intent; the ready balance becomes ordinary venue cash.
      cancellingBuyContinuation = true;
    }
  }
  const exitsToMarket =
    parsed.type === "cancel" || parsed.type === "change_amount";
  const canExitExternalHandoff =
    exitsToMarket &&
    intent.status === "external_handoff" &&
    intent.delivery_mode === "app_handoff" &&
    intent.submit_started_at == null;
  if (canExitExternalHandoff && committedFundedAppHandoff) {
    // The transfer is already durable, but no venue order crossed its submit
    // boundary. Cancel only the Buy; lifecycle reconciliation releases the
    // consumer reservation and leaves the prepared venue cash available.
    cancellingBuyContinuation = true;
  }
  const canDeliverExternalHandoff =
    (parsed.type === "confirm" || parsed.type === "retry_buy") &&
    intent.status === "external_handoff" &&
    intent.delivery_mode === "app_handoff" &&
    intent.submit_started_at == null;
  if (
    parsed.type === "retry_buy" &&
    isV2DirectHandoff &&
    ["executing", "submitted", "reconcile_required"].includes(intent.status)
  ) {
    // The Mini App already crossed the direct venue-submit boundary. A status
    // tap is deliberately read-only: reconciliation owns the next durable
    // transition and the original card will be edited when it arrives.
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      text: `⏳ Hunch is checking the ${intent.action === "sell" ? "Sell" : "Buy"} automatically.`,
    });
    return true;
  }
  if (exitsToMarket) {
    const expiredExitIntent =
      (PENDING_INTENT_STATUSES.includes(intent.status) ||
        canExitExternalHandoff) &&
      !committedFundedAppHandoff &&
      !claimedOrCommittedV2AppHandoff &&
      intent.expires_at.getTime() <= Date.now();
    if (expiredExitIntent) {
      const expired = await updateIntentStatus({
        allowedStatuses: [
          ...PENDING_INTENT_STATUSES,
          ...(canExitExternalHandoff ? ["external_handoff"] : []),
        ],
        db: input.db,
        errorCode: "intent_expired",
        errorMessage: "Trade intent expired.",
        intentId: intent.id,
        preserveClaimedAppHandoff: true,
        status: "expired",
      });
      if (expired) {
        await input.answerCallbackQuery({
          callbackQueryId: input.callbackQuery.id,
          text: "Quote expired. Opening the market.",
        });
        await sendCurrentMarketCard();
        return true;
      }
      const latest = await loadIntent(input.db, intent.id);
      if (!latest || !hasClaimedOrCommittedTelegramAppHandoffV2(latest)) {
        await answerIntentAlreadyProcessed(input, latest ?? intent);
        return true;
      }
      // Claim won the race with quote expiry. Continue below and honour this
      // explicit Cancel/Change action instead of silently expiring consent.
    }
    if (
      intent.status === "expired" ||
      (isTerminalIntentStatus(intent.status) && !canExitExternalHandoff) ||
      intent.status === "executing" ||
      intent.status === "submitted" ||
      intent.status === "reconcile_required"
    ) {
      // An old card cannot authorise a new action. It can always safely return
      // to the market, including after a trade/funding broadcast boundary.
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        text:
          intent.status === "expired"
            ? "Quote expired. Opening the market."
            : "Opening the current market card…",
      });
      await sendCurrentMarketCard();
      return true;
    }
    const cancelled = await updateIntentStatus({
      allowedStatuses: [
        ...PENDING_INTENT_STATUSES,
        ...(cancellingFundingIntent ? ["funding"] : []),
        ...(canExitExternalHandoff ? ["external_handoff"] : []),
      ],
      db: input.db,
      errorCode:
        parsed.type === "change_amount"
          ? "amount_change_requested"
          : "cancelled_by_user",
      errorMessage:
        parsed.type === "change_amount"
          ? "The user returned to choose a different amount."
          : cancellingBuyContinuation
            ? "The user cancelled the Buy after funding started; funding will settle without a venue order."
            : "The user returned to the market card.",
      intentId: intent.id,
      status: "cancelled",
    });
    if (!cancelled) {
      await answerIntentAlreadyProcessed(input, intent);
      return true;
    }
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      text:
        parsed.type === "change_amount"
          ? "Choose a new amount."
          : cancellingFundingPreparation
            ? "Preparation cancelled. No money was moved."
            : cancellingBuyContinuation
              ? "Buy cancelled. Funding will settle safely without submitting a trade."
              : "Trade cancelled. Choose another option.",
    });
    await sendCurrentMarketCard(
      parsed.type === "change_amount" ? intent.side : null,
    );
    return true;
  }
  if (
    (isTerminalIntentStatus(intent.status) || intent.status === "executing") &&
    !canDeliverExternalHandoff
  ) {
    await answerIntentAlreadyProcessed(input, intent);
    return true;
  }
  // A committed shortfall has durable funding in flight. Its original quote
  // TTL cannot make its status/check callbacks unreachable; readiness will
  // still obtain a fresh quote inside the confirmed bounds when funding is
  // actually ready.
  if (
    intent.status !== "funding" &&
    !canDeliverExternalHandoff &&
    !committedFundedAppHandoff &&
    !claimedOrCommittedV2AppHandoff &&
    intent.expires_at.getTime() <= Date.now()
  ) {
    const expired = await updateIntentStatus({
      allowedStatuses: PENDING_INTENT_STATUSES,
      db: input.db,
      errorCode: "intent_expired",
      errorMessage: "Trade intent expired.",
      intentId: intent.id,
      preserveClaimedAppHandoff: true,
      status: "expired",
    });
    if (!expired) {
      const latest = await loadIntent(input.db, intent.id);
      if (!latest || !hasClaimedOrCommittedTelegramAppHandoffV2(latest)) {
        await answerIntentAlreadyProcessed(input, latest ?? intent);
        return true;
      }
      // Claim won the race with quote expiry; continue the compatibility
      // callback against the already-consented handoff.
    } else {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        text: "Quote expired. Opening the market.",
      });
      await sendCurrentMarketCard();
      return true;
    }
  }

  const [policy, authorization, market] = await Promise.all([
    resolveTelegramBotTradingPolicy(input.db),
    intent.delivery_mode === "app_handoff"
      ? loadEnabledEvmAuthorization(input.db, intent.telegram_user_id, {
          allowInactiveForV2: readTelegramAppHandoffV2Plan(intent) != null,
        })
      : loadEnabledAuthorization(
          input.db,
          intent.telegram_user_id,
          intent.venue,
        ),
    loadMarketById(input.db, intent.market_id),
  ]);
  const amountUsd = parseNumber(intent.amount_usd);
  const sharesRaw =
    intent.shares_raw && /^\d+$/.test(intent.shares_raw)
      ? BigInt(intent.shares_raw)
      : null;
  const nullableSellPercent =
    intent.sell_percent == null ? null : Number(intent.sell_percent);
  const action: "BUY" | "SELL" = intent.action === "sell" ? "SELL" : "BUY";
  const side = intent.side;
  const appHandoffV2Plan = readTelegramAppHandoffV2Plan(intent);
  const initialAppHandoffProposal = isInitialTelegramAppHandoffProposal({
    deliveryMode: intent.delivery_mode,
    status: intent.status,
  });
  const retryableAppHandoffFundingInspection =
    isRetryableTelegramAppHandoffFundingInspection(intent);
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
  if (!intentMatchesTelegramTradeAuthority({ authorization, intent })) {
    const markedFailed = await updateIntentStatus({
      allowedStatuses: PENDING_INTENT_STATUSES,
      db: input.db,
      errorCode: "authority_changed",
      errorMessage: "Telegram trade authority no longer matches this intent.",
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
      text: "⚠️ Account or Trading Wallet changed. Open the market again.",
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
  // A ready FundingOperation is an exact, durable reserve for this Buy. The
  // generic CLOB readiness read can legitimately lag that on-chain credit, so
  // do not reject a funding-resume before its own operation/reservation fence
  // below has had a chance to validate it. All policy, wallet, market, amount,
  // and venue gates remain unchanged.
  const resumingDurableFunding =
    parsed.type === "retry_buy" &&
    intent.status === "funding" &&
    intent.delivery_mode === "bot_submit" &&
    intent.action === "buy" &&
    intent.funding_operation_id != null;
  const maxAmountUsd = resolveTelegramBuyIntentMaximumAmountUsd({
    authorizationMaxAmountUsd: authorization?.max_amount_usd ?? null,
    deliveryMode: intent.delivery_mode,
    policy,
    venue: intent.venue,
  });
  let tradeReadiness =
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
    (isCustomTelegramTradeIntent(intent) && !policy.customTradeInputEnabled) ||
    (readTelegramFundingReturnIntentMarker(intent) != null &&
      !policy.buyContinuationEnabled) ||
    !policy.tradingActions.includes(intent.action) ||
    (intent.delivery_mode === "bot_submit" &&
      !policy.tradingVenues.includes(intent.venue)) ||
    (intent.delivery_mode === "app_handoff" &&
      intent.action === "buy" &&
      (!policy.fundingReceiveEnabled || !policy.buyContinuationEnabled)) ||
    !market ||
    !isMarketOrderable(market) ||
    !authorization ||
    !authorization.privy_wallet_id ||
    (intent.delivery_mode === "bot_submit" &&
      !isVenueAllowed(intent.venue, policy, authorizationVenues)) ||
    (intent.delivery_mode === "app_handoff" &&
      !initialAppHandoffProposal &&
      !retryableAppHandoffFundingInspection &&
      appHandoffV2Plan == null) ||
    (action === "BUY"
      ? !resumingDurableFunding &&
        !canPreviewBuyForDelivery({
          deliveryMode: intent.delivery_mode,
          readiness: tradeReadiness,
        })
      : intent.delivery_mode !== "app_handoff" &&
        !canOfferTradeForReadiness(tradeReadiness)) ||
    (action === "BUY" && (!amountUsd || amountUsd > maxAmountUsd)) ||
    (action === "SELL" &&
      (!sharesRaw ||
        sharesRaw <= 0n ||
        (nullableSellPercent != null &&
          (!Number.isFinite(nullableSellPercent) ||
            nullableSellPercent <= 0 ||
            nullableSellPercent > 100)))) ||
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
          tone: "warn",
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
    (parsed.type === "confirm" ||
      (parsed.type === "retry_buy" && intent.status === "external_handoff")) &&
    intent.delivery_mode === "app_handoff" &&
    (["previewed", "external_handoff"].includes(intent.status) ||
      (appHandoffV2Plan != null && intent.status === "confirming"))
  ) {
    const confirmedQuote = readTelegramTradeQuotePreview(intent.quote_snapshot);
    if (!confirmedQuote) {
      await updateIntentStatus({
        allowedStatuses: ["previewed", "external_handoff"],
        db: input.db,
        errorCode: "handoff_quote_missing",
        errorMessage: "The confirmed handoff quote is unavailable.",
        intentId: intent.id,
        status: "failed",
      });
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "⚠️ The quote is unavailable. Open the market again.",
      });
      return true;
    }
    try {
      let preissuedHandoff:
        | Awaited<ReturnType<typeof issueTelegramTradeAppHandoff>>
        | undefined;
      if (
        intent.status === "previewed" &&
        appHandoffV2Plan?.kind === "direct_trade"
      ) {
        // Compatibility for callback Confirm buttons already delivered before
        // one-click Review. Select exactly one old card under the same
        // market/authority lock used by new URL Reviews; otherwise two old
        // previewed cards could both be claimed and submitted.
        const selected = await transitionIntentToConfirming({
          authorization,
          db: input.db,
          intent,
          onDirectAppHandoffReviewSelected: async (
            client,
            currentAuthorization,
          ) => {
            preissuedHandoff = await issueTelegramTradeAppHandoff({
              authorization: currentAuthorization,
              db: client,
              intent,
              quote: confirmedQuote,
              v2Plan: appHandoffV2Plan,
            });
          },
        });
        if (selected !== "confirmed" || !preissuedHandoff) {
          await answerIntentAlreadyProcessed(input, intent);
          return true;
        }
      }
      const handoffMessage = await sealConfirmedTelegramAppHandoff({
        authorization,
        db: input.db,
        intent,
        market,
        policy,
        preissuedHandoff,
        quote: confirmedQuote,
      });
      if (!handoffMessage) {
        await answerIntentAlreadyProcessed(input, intent);
        return true;
      }
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        text: `✅ ${intent.action === "sell" ? "Sell" : "Buy"} confirmed. Open Hunch to continue it.`,
      });
      await input.sendMessage({ chat_id: chatId, ...handoffMessage });
    } catch (error) {
      input.log?.warn?.(
        {
          error: error instanceof Error ? error.message : "unknown_error",
          event: "telegram_app_handoff_issue_failed",
          intentId: intent.id,
        },
        "Confirmed Telegram app handoff could not be issued",
      );
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "⚠️ The processing window is temporarily unavailable. Try Confirm again.",
      });
    }
    return true;
  }

  let fundingResumedForExecution =
    intent.delivery_mode === "app_handoff" &&
    intent.funding_reservation_id != null &&
    readTelegramAppHandoffExecutionMarker(intent) != null;
  if (parsed.type === "retry_buy" && intent.status === "funding") {
    const fundingState = await input.db.query<{
      continuation_id: string | null;
      operation_status: string;
      progress_stage: string;
      reservation_id: string | null;
      root_requires_router_continuation: boolean;
      has_broadcast_boundary: boolean;
    }>(
      `select continuation.id::text as continuation_id,
              ${telegramPolymarketRootRequiresRouterContinuationSql("operation")}
                as root_requires_router_continuation,
              tracked_operation.status as operation_status,
              tracked_operation.progress_stage,
              (
                select reservation.id::text
                  from balance_reservations reservation
                 where reservation.operation_id = tracked_operation.id
                   and reservation.user_id = tracked_operation.user_id
                   and reservation.mode = 'settled_for_consumer'
                   and reservation.state = 'active'
                 order by reservation.id
                 limit 1
              ) as reservation_id,
              exists (
                select 1
                  from funding_operation_step_attempts attempt
                  join funding_operation_steps step on step.id = attempt.step_id
               where step.operation_id = tracked_operation.id
                   and (
                     attempt.broadcast_may_have_occurred
                     or attempt.outcome in ('submitted', 'ambiguous', 'succeeded')
                   )
              ) as has_broadcast_boundary
         from funding_operations operation
         left join lateral (
           select continuation.*
             from funding_operations continuation
            where continuation.user_id = operation.user_id
              and continuation.support_metadata ->> 'telegramTradeIntentId' = $3::text
              and continuation.support_metadata ->> 'continuationOfOperationId' = operation.id::text
            order by continuation.created_at desc, continuation.id desc
            limit 1
         ) continuation on true
         cross join lateral (
           select coalesce(continuation.id, operation.id) as id,
                  coalesce(continuation.user_id, operation.user_id) as user_id,
                  coalesce(continuation.status, operation.status) as status,
                  coalesce(continuation.progress_stage, operation.progress_stage) as progress_stage
         ) tracked_operation
        where operation.id = $1::uuid
          and operation.user_id = $2::uuid`,
      [intent.funding_operation_id, intent.user_id, intent.id],
    );
    const funding = fundingState.rows[0];
    const routerContinuationPending =
      isTelegramPolymarketRouterContinuationPending({
        continuationId: funding?.continuation_id,
        operationStatus: funding?.operation_status,
        progressStage: funding?.progress_stage,
        rootRequiresRouterContinuation:
          funding?.root_requires_router_continuation === true,
        venue: intent.venue,
      });
    if (routerContinuationPending) {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        text: "⏳ Moving pUSD into Polymarket.",
      });
      return true;
    }
    if (
      funding?.operation_status !== "ready" ||
      funding.progress_stage !== "ready_for_consumer" ||
      !funding.reservation_id
    ) {
      const terminalFunding =
        funding?.operation_status === "cancelled" ||
        funding?.operation_status === "failed" ||
        funding?.operation_status === "refunded" ||
        funding?.operation_status === "completed";
      if (terminalFunding) {
        await updateIntentStatus({
          allowedStatuses: ["funding"],
          db: input.db,
          errorCode: `funding_${funding.operation_status}`,
          errorMessage:
            "Funding ended before the Buy could continue. No trade was submitted.",
          intentId: intent.id,
          status: "failed",
        });
      }
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text:
          terminalFunding || funding?.operation_status === "recovery_required"
            ? "⚠️ Funding needs review. No Buy was submitted."
            : "⏳ Funding is still being prepared.",
      });
      const retryButton = {
        callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:retry_buy:${intent.id}`,
        text: "🔄 Refresh funding status",
      };
      const openMarketButton = market
        ? buildTelegramTradingMiniAppButton({
            appBaseUrl: input.appBaseUrl,
            path: openMarketUrl(input.appBaseUrl, market),
            telegramMiniAppEnabled: input.telegramMiniAppEnabled,
            text: "Open market",
          })
        : null;
      const canCancelPreparation =
        !terminalFunding &&
        funding?.operation_status !== "recovery_required" &&
        funding?.operation_status !== "reconcile_required" &&
        funding?.has_broadcast_boundary !== true;
      const progressRows = terminalFunding
        ? [
            ...telegramTradingButtonRows(openMarketButton),
            [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
          ]
        : [
            [retryButton],
            ...(canCancelPreparation
              ? [
                  [
                    {
                      callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:cancel:${intent.id}`,
                      text: "❌ Cancel preparation",
                    },
                  ],
                ]
              : []),
            [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
          ];
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        ...(progressRows.length > 0
          ? { reply_markup: { inline_keyboard: progressRows } }
          : {}),
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: terminalFunding
            ? "Funding stopped."
            : "Preparing funds for this Buy.",
          tone: terminalFunding ? "warn" : "working",
          lines: terminalFunding
            ? [
                "No trade was submitted and this route will not be retried automatically. Open the market to build a fresh quote.",
              ]
            : [
                intent.side && market
                  ? `↔️ ${formatTelegramFieldMarkdownV2(
                      "Side",
                      sideLabel(market, intent.side),
                    )}`
                  : null,
                `Order: ${formatUsd(Number(intent.amount_usd ?? 0))}`,
                `Status: ${telegramFundingProgressLabel(
                  funding?.progress_stage ?? null,
                  funding?.operation_status ?? null,
                )}`,
                "The Buy has not been submitted yet.",
              ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
      });
      return true;
    }
    if (intent.delivery_mode === "app_handoff") {
      if (!committedFundedAppHandoff) {
        await input.answerCallbackQuery({
          callbackQueryId: input.callbackQuery.id,
          showAlert: true,
          text: "⚠️ The protected funding continuation is unavailable. Open the market again.",
        });
        return true;
      }
      if (
        intent.funding_reservation_id != null &&
        intent.funding_reservation_id !== funding.reservation_id
      ) {
        await input.answerCallbackQuery({
          callbackQueryId: input.callbackQuery.id,
          showAlert: true,
          text: "⚠️ Funding is linked to a different continuation. Reopen the market.",
        });
        return true;
      }
      if (intent.funding_reservation_id == null) {
        const attached = await input.db.query(
          `update telegram_trade_intents intent
              set funding_reservation_id = $2::uuid,
                  error_code = null,
                  error_message = null,
                  result = coalesce(intent.result, '{}'::jsonb)
                    || jsonb_build_object(
                      'appHandoffFundingReady', jsonb_build_object(
                        'handoffId', $3::uuid,
                        'operationId', intent.funding_operation_id,
                        'reservationId', $2::uuid,
                        'version', 2
                      ),
                      'fundingReadyAt', clock_timestamp(),
                      'stage', 'funding_ready'
                    ),
                  updated_at = clock_timestamp()
            where intent.id = $1::uuid
              and intent.status = 'funding'
              and intent.delivery_mode = 'app_handoff'
              and intent.funding_operation_id is not null
              and intent.funding_reservation_id is null`,
          [intent.id, funding.reservation_id, committedFundedAppHandoffId],
        );
        if ((attached.rowCount ?? 0) !== 1) {
          await answerIntentAlreadyProcessed(input, intent);
          return true;
        }
      }
      const current = await loadIntent(input.db, intent.id);
      const confirmedQuote = readTelegramTradeQuotePreview(
        current?.quote_snapshot ?? intent.quote_snapshot,
      );
      if (!current || !confirmedQuote || !appHandoffV2Plan) {
        await input.answerCallbackQuery({
          callbackQueryId: input.callbackQuery.id,
          showAlert: true,
          text: "⚠️ The protected continuation is unavailable. Open the market again.",
        });
        return true;
      }
      const handoffMessage = await issueTelegramTradeAppHandoffMessage({
        authorization,
        db: input.db,
        intent: current,
        market,
        policy,
        quote: confirmedQuote,
        v2Plan: appHandoffV2Plan,
      });
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        text: "✅ Funding is ready. Continue the confirmed Buy in Hunch.",
      });
      await input.sendMessage({ chat_id: chatId, ...handoffMessage });
      return true;
    }
    const resumeStatus = "confirming";
    const resumed = await input.db.query(
      `update telegram_trade_intents
          set status = $3,
              funding_reservation_id = $2::uuid,
              error_code = null,
              error_message = null,
              result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                'fundingReadyAt', clock_timestamp(),
                'fundingProposalConsumedAt', clock_timestamp(),
                'stage', 'funding_ready'
              ),
              updated_at = clock_timestamp()
        where id = $1::uuid
          and status = 'funding'
          and funding_operation_id is not null
          and funding_reservation_id is null`,
      [intent.id, funding.reservation_id, resumeStatus],
    );
    if ((resumed.rowCount ?? 0) !== 1) {
      await answerIntentAlreadyProcessed(input, intent);
      return true;
    }
    intent.status = resumeStatus;
    intent.funding_reservation_id = funding.reservation_id;
    fundingResumedForExecution = true;
    // The readiness above was read before the durable funding operation became
    // ready. Re-read it for presentation/repair, but do not use its old
    // available-balance snapshot to reject the amount just reserved for this
    // exact intent below.
    tradeReadiness = await resolveTelegramTradingReadiness({
      action: action === "SELL" ? "SELL" : "BUY",
      authorization,
      market: marketForCallbackReadiness(action, market),
      trading: input.trading,
      venue: intent.venue,
    });
    await input.answerCallbackQuery({
      callbackQueryId: input.callbackQuery.id,
      text: "✅ Funding ready. Rechecking the confirmed Buy…",
    });
  }
  if (
    parsed.type === "buy" ||
    (parsed.type === "retry_buy" && !fundingResumedForExecution) ||
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
      // Rebuild the market card so the active intent's own Continue, status,
      // cancellation and market-navigation buttons are visible. Never leave a
      // user with a command-only "still resolving" message.
      await sendCurrentMarketCard();
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
    if (
      intent.venue === "polymarket" ||
      intent.delivery_mode === "app_handoff"
    ) {
      await previewTelegramTradeIntent({
        appBaseUrl: input.appBaseUrl,
        authorization,
        chatId,
        db: input.db,
        estimateRetainedSolUsd: input.estimateRetainedSolUsd,
        intent,
        market,
        maxAmountUsd,
        log: input.log,
        openFundingBuyReturn: input.openFundingBuyReturn,
        inspectMiniAppFunding: input.inspectMiniAppFunding,
        inspectTradeShortfall: input.inspectTradeShortfall,
        policy,
        readiness: tradeReadiness,
        sendMessage: input.sendMessage,
        telegramMiniAppEnabled: input.telegramMiniAppEnabled,
        trading,
      });
      return true;
    }
    const previewIntent = buildTelegramStoredTradeIntent({
      amountUsd,
      authorization,
      intent,
      market,
      policy,
      sharesRaw,
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
          tone: "warn",
          lines: ["Nothing was submitted. Send /market again."],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
      });
      return true;
    }
    const previewMaxSpendUsd =
      action === "BUY" ? (previewQuote.maxSpendUsd ?? amountUsd) : null;
    const venueMinimumBlocking = isTelegramVenueMinimumBlocking({
      action: previewIntent.action,
      meetsVenueMinimum: previewQuote.meetsVenueMinimum,
      orderType: previewIntent.orderType,
      venue: previewIntent.venue,
    });
    const sellProceedsBlocking =
      action === "SELL" &&
      !isTelegramSellProceedsDisplayable(previewQuote.minimumReceiveUsd);
    if (venueMinimumBlocking || sellProceedsBlocking) {
      await updateIntentStatus({
        allowedStatuses: ["draft", "previewed"],
        db: input.db,
        errorCode: "quote_changed",
        errorMessage: venueMinimumBlocking
          ? "Price moved and the order no longer meets venue minimum."
          : "The current Sell proceeds are below the minimum displayable amount.",
        intentId: intent.id,
        quoteSnapshot: buildTelegramTradeQuotePreview(previewQuote),
        result: { previewQuote },
        status: "failed",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: venueMinimumBlocking
            ? "Price moved."
            : "Sell amount is too small.",
          tone: "warn",
          lines: [
            sellProceedsBlocking
              ? "The current Sell would return less than $0.01. Nothing was submitted."
              : "Nothing was submitted. Send /market again.",
          ],
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
          tone: "warn",
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
            tone: "warn",
            lines: ["Open Hunch to continue."],
            marketTitle: market.title,
            venue: intent.venue,
          }),
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
          tone: "warn",
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
          tone: "working",
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
          tone: "warn",
          lines: ["Check /trade_status before trying again."],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
      });
      return true;
    }
    await input.sendMessage({
      chat_id: chatId,
      ...buildTelegramTradeConfirmationMessage({
        authorization,
        intent,
        market,
        policy,
        quote: previewQuote,
        readiness: tradeReadiness,
      }),
    });
    return true;
  }

  const tradeFundingProposal = readTelegramTradeShortfallProposal(
    intent.result,
  );
  if (
    tradeFundingProposal &&
    intent.status === "confirming" &&
    !fundingResumedForExecution
  ) {
    const fundingIdentity =
      amountUsd != null && side
        ? telegramTradeFundingIdentity({
            authorization,
            intent,
            market,
            maximumSpendUsd:
              readTelegramTradeQuotePreview(intent.quote_snapshot)
                ?.maxSpendUsd ?? amountUsd,
            policy,
            quoteExpiresAt: tradeFundingProposal.expiresAt,
            side,
          })
        : null;
    if (!fundingIdentity || !input.commitTradeShortfall) {
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "⚠️ Internal funding is temporarily unavailable. Nothing was moved.",
      });
      return true;
    }
    try {
      await input.commitTradeShortfall({
        ...fundingIdentity,
        proposal: tradeFundingProposal,
      });
      await input.db.query(
        `update telegram_trade_intents
            set result = result || jsonb_build_object(
                  'shortfallSideLabel', $2::text
                ),
                updated_at = clock_timestamp()
          where id = $1::uuid
            and status = 'funding'`,
        [intent.id, sideLabel(market, side)],
      );
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        text: "✅ Internal funding started.",
      });
      const startingMessage = {
        parse_mode: "MarkdownV2" as const,
        reply_markup: {
          inline_keyboard: [
            [
              {
                callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:retry_buy:${intent.id}`,
                text: "Check status",
              },
              {
                callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:cancel:${intent.id}`,
                text: "❌ Cancel preparation",
              },
            ],
          ],
        },
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Starting preparation.",
          tone: "working",
          lines: [
            `Side: ${sideLabel(market, side)}`,
            `Order: ${formatUsd(Number(intent.amount_usd ?? 0))}`,
            "Status: Starting automatically.",
            "Source: existing Hunch balance.",
            ...(tradeFundingProposal.eta
              ? [
                  `Expected time: about ${tradeFundingProposal.eta.minSeconds}–${tradeFundingProposal.eta.maxSeconds} seconds.`,
                ]
              : []),
            intent.delivery_mode === "app_handoff"
              ? "When ready, the final Buy will open in Hunch. No trade has been submitted yet."
              : "When ready, Hunch will check a fresh quote and Buy automatically within your confirmed limits.",
          ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
      };
      const sentStartingMessage = await input.sendMessage({
        chat_id: chatId,
        ...startingMessage,
      });
      const startingMessageId = telegramSentMessageId(sentStartingMessage);
      if (startingMessageId != null) {
        await input.db.query(
          `update telegram_trade_intents
              set telegram_message_id = $2::bigint,
                  updated_at = clock_timestamp()
            where id = $1::uuid and status = 'funding'`,
          [intent.id, startingMessageId],
        );
        intent.telegram_message_id = String(startingMessageId);
      }
      return true;
    } catch (error) {
      const safetyStop =
        error instanceof TelegramTradeShortfallCommitError ? error : null;
      try {
        await updateIntentStatus({
          allowedStatuses: ["confirming"],
          db: input.db,
          errorCode: safetyStop?.code ?? "funding_quote_rejected_pre_submit",
          errorMessage: safetyStop
            ? safetyStop.message
            : "The confirmed funding quote could not be committed before any external action.",
          intentId: intent.id,
          status: "cancelled",
        });
      } catch (statusError) {
        input.log?.warn?.(
          {
            error:
              statusError instanceof Error
                ? statusError.message
                : "unknown_error",
            event: "telegram_trade_shortfall_commit_terminalization_failed",
            intentId: intent.id,
          },
          "Telegram trade shortfall rejection could not terminalize the intent",
        );
      }
      input.log?.warn?.(
        {
          error: error instanceof Error ? error.message : "unknown_error",
          event: "telegram_trade_shortfall_commit_failed",
          intentId: intent.id,
        },
        "Telegram trade shortfall commit failed closed",
      );
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text:
          safetyStop?.code === "allowance_lane_unavailable"
            ? "⏳ Another funding action is still being checked. Nothing was moved."
            : "⚠️ Funding quote changed or is unavailable. Nothing was moved; reopen Review.",
      });
      const reopenMarketButton = buildTelegramTradingMiniAppButton({
        appBaseUrl: input.appBaseUrl,
        path: openMarketUrl(input.appBaseUrl, market),
        telegramMiniAppEnabled: input.telegramMiniAppEnabled,
        text: "🎯 Open market",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading:
            safetyStop?.code === "allowance_lane_unavailable"
              ? "Funding preparation is busy."
              : "Funding quote is no longer current.",
          tone: "warn",
          lines:
            safetyStop?.code === "allowance_lane_unavailable"
              ? [
                  "Another funding action is holding this wallet lane while it is checked.",
                  "Nothing was moved or submitted. Try again shortly.",
                ]
              : [
                  "Nothing was moved or submitted.",
                  "Open the market again to receive a fresh Review.",
                ],
          marketTitle: intent.market_title,
          venue: intent.venue,
        }),
        reply_markup: {
          inline_keyboard: [
            ...telegramTradingButtonRows(reopenMarketButton),
            [
              {
                callback_data: `hm:v1:deposit:${intent.venue}`,
                text: "Deposit",
              },
            ],
            [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
          ],
        },
      });
      return true;
    }
  }

  const executing = await transitionIntentToExecuting({
    authorization,
    db: input.db,
    intent,
  });
  if (executing !== "executing") {
    if (executing === "authority_changed") {
      await updateIntentStatus({
        allowedStatuses: ["confirming"],
        db: input.db,
        errorCode: "authority_changed",
        errorMessage: "Telegram trade authority changed before confirmation.",
        intentId: intent.id,
        status: "failed",
      });
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        showAlert: true,
        text: "⚠️ Account or Trading Wallet changed. Open the market again.",
      });
      return true;
    }
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
  const sharedIntent = buildTelegramStoredTradeIntent({
    amountUsd,
    authorization,
    intent,
    market,
    policy,
    sharesRaw,
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
            tone: "warn",
            lines: [message],
            marketTitle: intent.market_title,
            venue: intent.venue,
          }),
        });
        return true;
      }
    }
    const authorizationStillEnabled =
      intent.delivery_mode === "app_handoff" &&
      readTelegramAppHandoffExecutionMarker(intent)
        ? intentMatchesTelegramTradeAuthority({
            authorization: await loadEnabledEvmAuthorization(
              input.db,
              authorization.telegram_user_id,
              { allowInactiveForV2: true },
            ),
            intent,
          })
        : await isTelegramBotTradingAuthorizationEnabled(
            input.db,
            authorization,
            intent.venue,
            intent,
          );
    if (!authorizationStillEnabled) {
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
    const { maxSpendUsd: quoteMaxSpendUsd, venueMinimumBlocking } =
      resolveTelegramTradeQuoteLimits({
        amountUsd,
        intent: sharedIntent,
        quote,
      });
    if (
      venueMinimumBlocking ||
      (action === "BUY" &&
        quoteMaxSpendUsd != null &&
        quoteMaxSpendUsd > maxAmountUsd) ||
      (!fundingResumedForExecution &&
        tradeReadiness?.maxExecutableBuyUsd != null &&
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
      const openMarketButton = buildTelegramTradingMiniAppButton({
        appBaseUrl: input.appBaseUrl,
        path: openMarketUrl(input.appBaseUrl, market),
        telegramMiniAppEnabled: input.telegramMiniAppEnabled,
        text: "Open market",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            ...(openMarketButton ? [[openMarketButton]] : []),
            [
              {
                callback_data: "hm:v1:home",
                text: "🏠 Home",
              },
            ],
          ],
        },
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade not submitted.",
          tone: "warn",
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
      const reopenMarketButton = buildTelegramTradingMiniAppButton({
        appBaseUrl: input.appBaseUrl,
        path: openMarketUrl(input.appBaseUrl, market),
        telegramMiniAppEnabled: input.telegramMiniAppEnabled,
        text: "Open market again",
      });
      await input.sendMessage({
        chat_id: chatId,
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            ...(reopenMarketButton ? [[reopenMarketButton]] : []),
            [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
          ],
        },
        text: formatTelegramTradeLifecycleMessageMarkdownV2({
          heading: "Trade not submitted.",
          tone: "warn",
          lines: [
            "The quote moved beyond your confirmed tolerance.",
            "Nothing was submitted. Open the market for a new preview.",
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
      const recorded = await updateIntentStatus({
        allowedStatuses: ["executing"],
        db: input.db,
        intentId: intent.id,
        result: withReadinessRepair({ quote }),
        status: "executing",
      });
      if (!recorded) {
        throw new Error(
          "Telegram trade state changed before setup transaction evidence was recorded.",
        );
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
    };
    const enterIrreversibleSubmitBoundary = async (
      allowPreviouslyStarted: boolean,
    ) => {
      const submitMarked = await markTelegramIntentSubmitBoundary({
        allowPreviouslyStarted,
        authorization,
        db: input.db,
        intent,
        result: withReadinessRepair({ quote }),
      });
      if (!submitMarked) {
        throw new Error(
          "Telegram bot trading authority or intent changed before submit.",
        );
      }
      submitStarted = true;
      if (broadcastStartedAtMs == null) {
        broadcastStartedAtMs = Date.now();
        input.log?.info?.(
          {
            confirmToBroadcastMs: broadcastStartedAtMs - confirmStartedAtMs,
            intentId: intent.id,
            venue: intent.venue,
          },
          "Telegram trade reached irreversible submit boundary",
        );
      }
    };
    const prepared = await trading.prepareTrade({
      intent: sharedIntent,
      onBeforeSetupTransactionBroadcast: () =>
        enterIrreversibleSubmitBoundary(false),
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
      onBeforeBroadcast: () => enterIrreversibleSubmitBoundary(true),
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
          tone: "warn",
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
    // A terminal card is still part of the Telegram trading journey.  This is
    // deliberately a callback—not a Mini App link—so it restores the market
    // card with its live quote, presets, position context, and Back/Home rows.
    // The Mini App is reserved for an explicit sealed-handoff continuation.
    const filledMarketButton =
      resolution.intentStatus === "filled" && !postSubmitError
        ? {
            callback_data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:open_market:${intent.id}`,
            text: "🎯 Trade this market",
          }
        : null;
    const filledKeyboard =
      resolution.intentStatus === "filled" && !postSubmitError
        ? {
            inline_keyboard: [
              ...telegramTradingButtonRows(filledMarketButton),
              [{ callback_data: "hm:v1:positions", text: "💼 My positions" }],
              [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
            ],
          }
        : undefined;
    await input.sendMessage({
      chat_id: chatId,
      parse_mode: "MarkdownV2",
      ...(filledKeyboard ? { reply_markup: filledKeyboard } : {}),
      text: formatTelegramTradeLifecycleMessageMarkdownV2({
        heading: resolution.messageTitle,
        tone: postSubmitError
          ? "warn"
          : resolution.intentStatus === "filled"
            ? "ok"
            : resolution.intentStatus === "submitted"
              ? "working"
              : "warn",
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
    // A canonical FundingOperation reserves the exact source amount for this
    // intent. Polymarket can acknowledge its Deposit Wallet balance a little
    // after the on-chain receipt. Put the intent back into the durable funding
    // state so the automatic continuation retries its sync + fresh quote; do
    // not terminalize a funded Buy or release its reservation.
    if (
      normalized.code === "funding_balance_pending" &&
      fundingResumedForExecution &&
      !submitStarted &&
      setupTransactions.length === 0
    ) {
      const waiting = await input.db.query(
        `update telegram_trade_intents
            set status = 'funding',
                funding_reservation_id = null,
                error_code = 'funding_balance_pending',
                error_message = $2,
                result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                  'fundingVenueBalancePendingAt', clock_timestamp(),
                  'stage', 'waiting_for_venue_balance'
                ),
                updated_at = clock_timestamp()
          where id = $1::uuid
            and status = 'executing'
            and submit_started_at is null`,
        [intent.id, normalized.message],
      );
      if ((waiting.rowCount ?? 0) !== 1) {
        await answerIntentAlreadyProcessed(input, intent);
        return true;
      }
      input.log?.info?.(
        { intentId: intent.id, venue: intent.venue },
        "Telegram funded Buy is waiting for venue balance visibility",
      );
      await input.answerCallbackQuery({
        callbackQueryId: input.callbackQuery.id,
        text: "⏳ Waiting for Polymarket balance confirmation…",
      });
      return true;
    }
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
          tone: "working",
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
          tone: "working",
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
          tone: "working",
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
        tone: "warn",
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
  estimateRetainedSolUsd?: TelegramBotTradingCallbackInput["estimateRetainedSolUsd"];
  expectedIntentId?: string | null;
  expectedType?:
    | "buy"
    | "sell"
    | "redeem"
    | "open_market"
    | "cancel"
    | "change_amount"
    | "confirm"
    | null;
  log?: TelegramBotTradingCallbackInput["log"];
  openFundingBuyReturn?: TelegramFundingBuyReturnOpener;
  inspectMiniAppFunding?: TelegramBotTradingCallbackInput["inspectMiniAppFunding"];
  inspectTradeShortfall?: TelegramBotTradingCallbackInput["inspectTradeShortfall"];
  commitTradeShortfall?: TelegramBotTradingCallbackInput["commitTradeShortfall"];
  cancelFundingOperation?: TelegramBotTradingCallbackInput["cancelFundingOperation"];
  signerInspector?: TelegramBotTradingSignerInspector;
  telegramMiniAppEnabled?: boolean;
  trading?: ApiBotTradingExecutor;
  writeTradeInputContext?: (
    input: TelegramBotTradeInputContext,
  ) => Promise<boolean>;
}): Promise<CapturedTelegramBotTradingCallbackResult> {
  const answers: CapturedTelegramBotTradingCallbackResult["answers"] = [];
  const messages: CapturedTelegramBotTradingCallbackResult["messages"] = [];
  const parsed = parseTelegramBotTradingCallbackData(input.callbackQuery.data);
  const initialIntent =
    parsed?.type === "retry_buy" && "intentId" in parsed
      ? await loadIntent(input.db, parsed.intentId).catch(() => null)
      : null;
  const handled = await handleTelegramBotTradingCallback({
    answerCallbackQuery: async (answer) => {
      answers.push(answer);
      return undefined;
    },
    appBaseUrl: input.appBaseUrl,
    callbackQuery: input.callbackQuery,
    db: input.db,
    estimateRetainedSolUsd: input.estimateRetainedSolUsd,
    expectedIntentId: input.expectedIntentId,
    expectedType: input.expectedType,
    log: input.log,
    openFundingBuyReturn: input.openFundingBuyReturn,
    inspectMiniAppFunding: input.inspectMiniAppFunding,
    inspectTradeShortfall: input.inspectTradeShortfall,
    commitTradeShortfall: input.commitTradeShortfall,
    cancelFundingOperation: input.cancelFundingOperation,
    signerInspector: input.signerInspector,
    sendMessage: async (message) => {
      messages.push(message);
      return undefined;
    },
    telegramMiniAppEnabled: input.telegramMiniAppEnabled,
    trading: input.trading,
    writeTradeInputContext: input.writeTradeInputContext,
  });
  const currentIntent =
    parsed && "intentId" in parsed
      ? await loadIntent(input.db, parsed.intentId).catch(() => null)
      : null;
  return {
    answers,
    handled,
    intentStatus: currentIntent?.status ?? null,
    lifecycleOwnsTerminalDelivery:
      currentIntent != null &&
      currentIntent.status !== "expired" &&
      (parsed?.type === "confirm" ||
        (parsed?.type === "retry_buy" &&
          initialIntent != null &&
          !isTerminalIntentStatus(initialIntent.status))) &&
      isTelegramTradeLifecycleDeliveryEligible({
        chatId: currentIntent.chat_id,
        deliveryMode: currentIntent.delivery_mode,
        fundingOperationId: currentIntent.funding_operation_id,
        result: currentIntent.result,
        telegramMessageId: currentIntent.telegram_message_id,
      }),
    messages,
  };
}

export type TelegramAppHandoffProjection = Readonly<{
  action: "buy" | "sell";
  amountUsd: number | null;
  canAutoClose: boolean;
  continuesInBackground: boolean;
  error: Readonly<{ code: string | null; message: string | null }> | null;
  eventTitle: string | null;
  funding: Readonly<{
    operationId: string;
    progressStage: string | null;
    status: string | null;
  }> | null;
  marketTitle: string;
  /** Immutable v2 Sell floor, in the destination cash asset's raw units. */
  minimumReceiveRaw: string | null;
  order: Readonly<{
    executionId: string | null;
    orderId: string | null;
    txSignature: string | null;
    venueOrderId: string | null;
  }>;
  outcome: string;
  revision: string;
  /** Exact outcome-token Sell quantity, in six-decimal raw units. */
  sharesRaw: string | null;
  stage:
    | "attaching"
    | "failed"
    | "funding"
    | "reconciling"
    | "submitting"
    | "success";
  status: string;
  terminal: boolean;
  tradeIntentId: string;
  venue: TelegramBotTradingVenue;
}>;

export async function loadTelegramAppHandoffProjection(
  db: DbQuery,
  input: Readonly<{
    telegramUserId: string;
    tradeIntentId: string;
    userId: string;
  }>,
): Promise<TelegramAppHandoffProjection | null> {
  const projection = await db.query<{
    action: "buy" | "sell";
    amount_usd: string | null;
    error_code: string | null;
    error_message: string | null;
    event_title: string | null;
    execution_id: string | null;
    funding_operation_id: string | null;
    funding_progress_stage: string | null;
    funding_status: string | null;
    id: string;
    market_title: string;
    minimum_receive_raw: string | null;
    order_id: string | null;
    outcomes: string | null;
    side: TelegramBotTradingSide | null;
    shares_raw: string | null;
    status: string;
    tx_signature: string | null;
    updated_at: Date;
    venue: TelegramBotTradingVenue;
    venue_order_id: string | null;
  }>(
    `select intent.action,
            intent.amount_usd,
            case
              when intent.error_code = 'external_handoff_required'
                and (
                  intent.result -> 'appHandoffExecution' ->> 'version' = '2'
                  or handoff.plan_snapshot ->> 'version' = '2'
                )
                then null
              else intent.error_code
            end as error_code,
            case
              when intent.error_code = 'external_handoff_required'
                and (
                  intent.result -> 'appHandoffExecution' ->> 'version' = '2'
                  or handoff.plan_snapshot ->> 'version' = '2'
                )
                then null
              else intent.error_message
            end as error_message,
            event_row.title as event_title,
            intent.execution_id::text,
            intent.funding_operation_id::text,
            funding.progress_stage as funding_progress_stage,
            funding.status as funding_status,
            intent.id::text,
            market.title as market_title,
            case
              when intent.action = 'sell'
                and handoff.plan_snapshot -> 'trade' ->> 'minimumReceiveRaw' ~ '^[0-9]+$'
                then handoff.plan_snapshot -> 'trade' ->> 'minimumReceiveRaw'
              else null
            end as minimum_receive_raw,
            intent.order_id::text,
            market.outcomes,
            intent.side,
            intent.shares_raw,
            intent.status,
            intent.tx_signature,
            intent.updated_at,
            intent.venue,
            intent.venue_order_id
       from telegram_trade_intents intent
       join unified_markets market on market.id = intent.market_id
       left join unified_events event_row on event_row.id = market.event_id
       left join funding_operations funding
         on funding.id = intent.funding_operation_id
        and funding.user_id = intent.user_id
       left join lateral (
         select handoff_row.plan_snapshot
           from telegram_app_handoffs handoff_row
          where handoff_row.trade_intent_id = intent.id
            and handoff_row.user_id = intent.user_id
            and handoff_row.plan_snapshot ->> 'version' = '2'
          order by handoff_row.issued_at desc, handoff_row.id desc
          limit 1
       ) handoff on true
      where intent.id = $1::uuid
        and intent.user_id = $2::uuid
        and intent.telegram_user_id = $3
        and intent.delivery_mode = 'app_handoff'
        and intent.action in ('buy', 'sell')
      limit 1`,
    [input.tradeIntentId, input.userId, input.telegramUserId],
  );
  const row = projection.rows[0];
  if (!row) return null;
  const terminalFailure = ["cancelled", "expired", "failed"].includes(
    row.status,
  );
  const success = row.status === "filled";
  const reconciling = ["reconcile_required", "submitted"].includes(row.status);
  const fundingActive =
    row.funding_operation_id != null &&
    row.funding_status != null &&
    !["completed", "failed", "cancelled", "refunded"].includes(
      row.funding_status,
    ) &&
    row.funding_progress_stage !== "ready_for_consumer";
  const side = row.side ?? "YES";
  const amountUsd = parseNumber(row.amount_usd);
  return {
    action: row.action === "sell" ? "sell" : "buy",
    amountUsd,
    canAutoClose: success,
    continuesInBackground: reconciling || row.status === "executing",
    error:
      row.error_code || row.error_message
        ? { code: row.error_code, message: row.error_message }
        : null,
    eventTitle: row.event_title,
    funding: row.funding_operation_id
      ? {
          operationId: row.funding_operation_id,
          progressStage: row.funding_progress_stage,
          status: row.funding_status,
        }
      : null,
    marketTitle: row.market_title,
    minimumReceiveRaw: row.minimum_receive_raw,
    order: {
      executionId: row.execution_id,
      orderId: row.order_id,
      txSignature: row.tx_signature,
      venueOrderId: row.venue_order_id,
    },
    outcome: outcomeLabelOrSide(row.outcomes, side),
    revision: row.updated_at.toISOString(),
    sharesRaw: row.shares_raw,
    stage: success
      ? "success"
      : terminalFailure
        ? "failed"
        : fundingActive
          ? "funding"
          : reconciling
            ? "reconciling"
            : row.status === "confirming" || row.status === "external_handoff"
              ? "attaching"
              : "submitting",
    status: row.status,
    terminal: success || terminalFailure,
    tradeIntentId: row.id,
    venue: row.venue,
  };
}

export async function executeCommittedTelegramAppHandoff(
  input: Readonly<{
    appBaseUrl: string;
    db: DbQuery;
    log?: TelegramBotTradingCallbackInput["log"];
    signerInspector?: TelegramBotTradingSignerInspector;
    telegramUserId: string;
    tradeIntentId: string;
    trading: ApiBotTradingExecutor;
    userId: string;
  }>,
): Promise<TelegramAppHandoffProjection | null> {
  const intent = await loadIntent(input.db, input.tradeIntentId);
  if (
    !intent ||
    intent.user_id !== input.userId ||
    intent.telegram_user_id !== input.telegramUserId ||
    intent.delivery_mode !== "app_handoff" ||
    readTelegramAppHandoffExecutionMarker(intent) == null
  ) {
    return null;
  }
  if (intent.status === "confirming") {
    const senderId = Number(input.telegramUserId);
    if (!Number.isSafeInteger(senderId) || senderId <= 0 || !intent.chat_id) {
      return null;
    }
    const messageId = Number(intent.telegram_message_id);
    await captureTelegramBotTradingCallback({
      appBaseUrl: input.appBaseUrl,
      callbackQuery: {
        data: `${TELEGRAM_BOT_TRADING_CALLBACK_PREFIX}:confirm:${intent.id}`,
        from: { id: senderId },
        id: `app-handoff:${intent.id}`,
        message: {
          chat: { id: intent.chat_id, type: "private" },
          ...(Number.isSafeInteger(messageId) && messageId > 0
            ? { message_id: messageId }
            : {}),
        },
      },
      db: input.db,
      expectedIntentId: intent.id,
      expectedType: "confirm",
      log: input.log,
      signerInspector: input.signerInspector,
      telegramMiniAppEnabled: true,
      trading: input.trading,
    });
  }
  return loadTelegramAppHandoffProjection(input.db, {
    telegramUserId: input.telegramUserId,
    tradeIntentId: input.tradeIntentId,
    userId: input.userId,
  });
}
