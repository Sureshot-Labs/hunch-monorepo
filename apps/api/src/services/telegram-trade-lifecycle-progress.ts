import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
import { isRawAmount } from "../funding/domain/raw-amount.js";
import {
  isTelegramPolymarketRouterContinuationPending,
  isTelegramRouterContinuationHardReason,
  telegramPolymarketRootRequiresRouterContinuationSql,
} from "../funding/reconciliation/telegram-router-continuation-state.js";
import { releaseFundingReservationForAbandonedTradeInTransaction } from "../funding/persistence/funding-evidence-repository.js";

import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramCodeMarkdownV2,
  formatTelegramFieldMarkdownV2,
  formatTelegramFieldWithMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";
import { formatTelegramVenueLabel } from "./telegram-market-identity.js";
import {
  TELEGRAM_BOT_TRADING_CALLBACK_PREFIX,
  type TelegramBotTradingClientButton,
  type TelegramBotTradingClientReplyMarkup,
} from "./telegram-bot-trading-client.js";
import {
  TELEGRAM_TRADE_GENERIC_NOTIFICATION_OWNER,
  TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION,
  TELEGRAM_TRADE_TERMINAL_DELIVERY_OWNER_RESULT_KEY,
} from "./telegram-trade-delivery-contract.js";

const CALLBACK_PREFIX = TELEGRAM_BOT_TRADING_CALLBACK_PREFIX;
// Telegram mutations abort after 20 seconds. A row still marked `sending`
// beyond this bound belongs to a crashed worker, not a live request.
const TELEGRAM_TRADE_LIFECYCLE_STALE_SENDING_SEC = 25;
const TELEGRAM_TRADE_LIFECYCLE_MAX_EDIT_ATTEMPTS = 5;
const TELEGRAM_TRADE_LIFECYCLE_DEFAULT_RETRY_SEC = 3;
// Preserve Telegram's retry_after. This cap only protects the PostgreSQL int
// boundary; shortening a valid provider delay would retry inside the 429
// window and consume the bounded edit attempts without a real delivery try.
const TELEGRAM_TRADE_LIFECYCLE_MAX_PERSISTABLE_RETRY_SEC = 2_147_483_647;

function formatRawShares(raw: string): string {
  if (!isRawAmount(raw)) return raw;
  const padded = raw.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

type TelegramTradeLifecycleState =
  | "awaiting_client"
  | "filled"
  | "failed"
  | "cancelled"
  | "starting"
  | "preparing"
  | "submitted"
  | "ready"
  | "submitting_trade"
  | "confirming_trade"
  | "needs_attention"
  | "stopped";

type TelegramTradeLifecycleProgress = Readonly<{
  action: "buy" | "sell";
  amountUsd: string;
  attemptStateFingerprint: string;
  canCancel: boolean;
  canCancelBuy: boolean;
  /** True only for a sealed v2 direct trade that has no funding operation. */
  isDirectHandoff: boolean;
  failureMessage: string | null;
  fundingAmountLabel: string | null;
  intentId: string;
  marketTitle: string;
  operationStatus: string | null;
  progressStage: string | null;
  receiptStateFingerprint: string;
  reasonCode: string | null;
  /**
   * The next durable boundary belongs to the authenticated Mini App. Telegram
   * must present a resume path instead of implying that the server will sign
   * or submit it; this covers both funding actions and a sealed direct trade.
   */
  requiresMiniAppContinuation: boolean;
  sideLabel: string;
  sharesRaw: string | null;
  sourceRoute: string | null;
  stepStateFingerprint: string;
  state: TelegramTradeLifecycleState;
  venueOrderId: string | null;
  venue: string;
  version: 1 | 2 | 3 | 4 | 5 | 6;
}>;

type ProjectionCandidate = Readonly<{
  action: string;
  amount_usd: string | null;
  attempt_state_fingerprint: string;
  chat_id: string | null;
  continuation_id: string | null;
  consumer_reservation_id: string | null;
  delivery_mode: string;
  error_code: string | null;
  error_message: string | null;
  funding_operation_id: string | null;
  funding_destination_asset_id: string | null;
  funding_destination_decimals: string | null;
  funding_destination_raw: string | null;
  id: string;
  market_title: string;
  operation_error_code: string | null;
  operation_status: string | null;
  progress_stage: string | null;
  receipt_state_fingerprint: string;
  result: Record<string, unknown>;
  root_requires_router_continuation: boolean;
  side: string | null;
  shares_raw: string | null;
  source_asset_id: string | null;
  source_asset_decimals: number | null;
  source_network_id: string | null;
  status: string;
  step_state_fingerprint: string;
  telegram_message_id: string | null;
  telegram_user_id: string;
  tracked_operation_id: string | null;
  user_id: string | null;
  venue: string;
  venue_order_id: string | null;
  has_automatic_provider_reference_wait: boolean;
  has_broadcast_boundary: boolean;
  has_started_attempt: boolean;
  is_direct_v2_handoff: boolean;
  submit_started_at: Date | null;
}>;

type TelegramTradeLifecycleOutboxRow = Readonly<{
  attempt_count: number;
  chat_id: string;
  delivery_attempt_id: string | null;
  id: string;
  payload: unknown;
  state_revision: number;
  telegram_message_id: string;
  trade_intent_id: string;
  user_id: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProgress(value: unknown): TelegramTradeLifecycleProgress | null {
  if (
    !isRecord(value) ||
    (value.version !== 1 &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4 &&
      value.version !== 5 &&
      value.version !== 6)
  ) {
    return null;
  }
  if (
    typeof value.intentId !== "string" ||
    typeof value.marketTitle !== "string" ||
    typeof value.venue !== "string" ||
    typeof value.sideLabel !== "string" ||
    typeof value.amountUsd !== "string" ||
    typeof value.canCancel !== "boolean" ||
    typeof value.canCancelBuy !== "boolean" ||
    typeof value.state !== "string"
  ) {
    return null;
  }
  if (
    ![
      "awaiting_client",
      "starting",
      "preparing",
      "submitted",
      "ready",
      "submitting_trade",
      "confirming_trade",
      "needs_attention",
      "stopped",
      "filled",
      "failed",
      "cancelled",
    ].includes(value.state)
  ) {
    return null;
  }
  // Older delivered cards predate venueOrderId. Normalising them to null keeps
  // the projector revision-stable until an actual venue order exists.
  return {
    ...value,
    action: value.action === "sell" ? "sell" : "buy",
    sharesRaw: isRawAmount(value.sharesRaw) ? value.sharesRaw : null,
    // Older cards were all server-executed. Missing is therefore safely
    // normalised to false while version 5 forces one authoritative edit.
    requiresMiniAppContinuation: value.requiresMiniAppContinuation === true,
    isDirectHandoff: value.isDirectHandoff === true,
    failureMessage:
      typeof value.failureMessage === "string" && value.failureMessage.trim()
        ? value.failureMessage.trim()
        : null,
    venueOrderId:
      typeof value.venueOrderId === "string" && value.venueOrderId.trim()
        ? value.venueOrderId
        : null,
  } as TelegramTradeLifecycleProgress;
}

type TelegramLifecycleEditFailureResolution = Readonly<{
  code: string;
  disposition: "dead" | "retry";
  retryAfterSec: number;
}>;

function telegramLifecycleEditFailureCode(error: unknown): string {
  const explicitCode =
    isRecord(error) && typeof error.error === "string" ? error.error : null;
  const message =
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error.description === "string"
        ? error.description
        : isRecord(error) && typeof error.message === "string"
          ? error.message
          : "";
  const normalized = message.toLowerCase();
  if (normalized.includes("message is not modified")) {
    return "already_applied";
  }
  if (
    explicitCode === "message_not_editable" ||
    normalized.includes("message to edit not found") ||
    normalized.includes("message can't be edited")
  ) {
    return "message_not_editable";
  }
  if (
    explicitCode === "blocked_or_missing" ||
    normalized.includes("bot was blocked")
  ) {
    return "blocked_or_missing";
  }
  if (explicitCode === "ambiguous" || explicitCode === "other") {
    return explicitCode;
  }
  return "unknown";
}

function resolveTelegramLifecycleEditFailure(
  error: unknown,
  attemptCount: number,
): TelegramLifecycleEditFailureResolution {
  const code = telegramLifecycleEditFailureCode(error);
  const explicitRetryAfterSec =
    isRecord(error) &&
    typeof error.retryAfterSec === "number" &&
    Number.isFinite(error.retryAfterSec) &&
    error.retryAfterSec > 0
      ? Math.min(
          TELEGRAM_TRADE_LIFECYCLE_MAX_PERSISTABLE_RETRY_SEC,
          Math.max(1, Math.trunc(error.retryAfterSec)),
        )
      : null;
  const permanent =
    code === "blocked_or_missing" ||
    code === "message_not_editable" ||
    (code === "other" && explicitRetryAfterSec == null);
  return {
    code,
    disposition:
      permanent || attemptCount >= TELEGRAM_TRADE_LIFECYCLE_MAX_EDIT_ATTEMPTS
        ? "dead"
        : "retry",
    retryAfterSec:
      explicitRetryAfterSec ?? TELEGRAM_TRADE_LIFECYCLE_DEFAULT_RETRY_SEC,
  };
}

function telegramLifecycleEditSucceeded(result: unknown): boolean {
  return isRecord(result) && result.ok === true;
}

async function markTelegramTradeLifecycleDelivered(input: {
  deliveryAttemptId: string;
  messageId: number;
  outboxId: string;
  pool: Pick<Pool, "query">;
  terminalFill: boolean;
}): Promise<void> {
  await input.pool.query(
    `with sent_outbox as (
       update telegram_bot_action_outbox
          set status = 'sent', sent_at = clock_timestamp(), last_error = null,
              updated_at = clock_timestamp()
        where id = $1::uuid
          and status = 'sending'
          and delivery_attempt_id = $2::uuid
        returning trade_intent_id
     )
     update telegram_trade_intents intent_row
        set result = coalesce(intent_row.result, '{}'::jsonb) ||
              jsonb_build_object(
                'telegramReceipt',
                jsonb_build_object(
                  'deliveredAt', clock_timestamp(),
                  'delivery', 'edit',
                  'messageId', $3::bigint,
                  'intentStatus', 'filled'
                )
              ),
            updated_at = clock_timestamp()
       from sent_outbox
      where $4::boolean
        and intent_row.id = sent_outbox.trade_intent_id`,
    [
      input.outboxId,
      input.deliveryAttemptId,
      input.messageId,
      input.terminalFill,
    ],
  );
}

async function recoverStaleTelegramTradeLifecycleDeliveries(input: {
  pool: Pick<Pool, "query">;
}): Promise<number> {
  // Repair crashed claims and quarantine any retry row left at the ceiling by
  // an older worker before the next claim query can see it.
  const result = await input.pool.query(
    `update telegram_bot_action_outbox outbox
        set status = case
              when intent_row.result ->> 'shortfallProgressRevision' =
                    outbox.state_revision::text
               and outbox.attempt_count < $3::integer
                then 'retry'
              else 'dead'
            end,
            next_attempt_at = clock_timestamp(),
            last_error = case
              when intent_row.result ->> 'shortfallProgressRevision' =
                    outbox.state_revision::text
               and outbox.attempt_count < $3::integer
                then 'telegram_trade_lifecycle_stale_sending_retry'
              when intent_row.result ->> 'shortfallProgressRevision' =
                    outbox.state_revision::text
                then 'telegram_trade_lifecycle_edit_attempts_exhausted'
              else 'telegram_trade_lifecycle_edit_superseded'
            end,
            delivery_attempt_id = null,
            delivery_started_at = null,
            updated_at = clock_timestamp()
       from telegram_trade_intents intent_row
      where outbox.trade_intent_id = intent_row.id
        and outbox.action = $1::text
        and (
          (
            outbox.status = 'sending'
            and outbox.delivery_started_at <=
                  clock_timestamp() -
                    ($2::double precision * interval '1 second')
          )
          or (
            outbox.status in ('pending', 'retry')
            and outbox.attempt_count >= $3::integer
          )
        )`,
    [
      TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION,
      TELEGRAM_TRADE_LIFECYCLE_STALE_SENDING_SEC,
      TELEGRAM_TRADE_LIFECYCLE_MAX_EDIT_ATTEMPTS,
    ],
  );
  return result.rowCount ?? 0;
}

function sideLabel(candidate: ProjectionCandidate): string {
  const stored = candidate.result.shortfallSideLabel;
  return typeof stored === "string" && stored.trim()
    ? stored.trim()
    : (candidate.side ?? "Buy");
}

function fundingNetworkLabel(networkId: string): string {
  if (networkId === "evm:8453") return "Base";
  if (networkId === "evm:137") return "Polygon";
  if (networkId === "solana:mainnet") return "Solana";
  return "source wallet";
}

function fundingDestinationAsset(venue: string): string {
  if (venue === "polymarket") return "pUSD";
  if (venue === "limitless") return "USDC";
  return "funds";
}

function fundingAmountLabel(candidate: ProjectionCandidate): string | null {
  const raw = candidate.funding_destination_raw;
  const decimals = Number(candidate.funding_destination_decimals);
  if (!isRawAmount(raw) || !Number.isSafeInteger(decimals)) {
    return null;
  }
  const symbol = resolveKnownAccountAssetSymbol({
    assetId: candidate.funding_destination_asset_id ?? "",
    decimals,
    networkId: candidate.venue === "polymarket" ? "evm:137" : "",
  });
  if (!symbol) return null;
  const amount = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fractionalRaw = (amount % scale).toString().padStart(decimals, "0");
  const omittedNonZeroFraction = /[1-9]/u.test(fractionalRaw.slice(6));
  const fraction = fractionalRaw.slice(0, 6).replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""}${
    omittedNonZeroFraction ? "…" : ""
  } ${symbol}`;
}

function sourceRoute(candidate: ProjectionCandidate): string | null {
  if (!candidate.source_network_id || !candidate.source_asset_id) return null;
  if (candidate.source_asset_decimals == null) return null;
  const symbol =
    resolveKnownAccountAssetSymbol({
      assetId: candidate.source_asset_id,
      decimals: candidate.source_asset_decimals,
      networkId: candidate.source_network_id,
    }) ?? "funds";
  const venue =
    candidate.venue === "polymarket"
      ? "Polymarket"
      : candidate.venue === "limitless"
        ? "Limitless"
        : candidate.venue;
  return `${fundingNetworkLabel(candidate.source_network_id)} ${symbol} → ${venue} ${fundingDestinationAsset(candidate.venue)}`;
}

function directHandoffProgressFor(
  candidate: ProjectionCandidate,
): TelegramTradeLifecycleProgress {
  const state: TelegramTradeLifecycleState =
    candidate.status === "external_handoff"
      ? "awaiting_client"
      : candidate.status === "executing"
        ? "submitting_trade"
        : ["submitted", "reconcile_required"].includes(candidate.status)
          ? "confirming_trade"
          : candidate.status === "filled"
            ? "filled"
            : candidate.status === "cancelled"
              ? "cancelled"
              : "failed";
  return {
    action: candidate.action === "sell" ? "sell" : "buy",
    amountUsd: candidate.amount_usd ?? "0",
    attemptStateFingerprint: "",
    canCancel:
      state === "awaiting_client" && candidate.submit_started_at == null,
    canCancelBuy: false,
    failureMessage:
      state === "failed" ? candidate.error_message?.trim() || null : null,
    fundingAmountLabel: null,
    intentId: candidate.id,
    isDirectHandoff: true,
    marketTitle: candidate.market_title,
    operationStatus: null,
    progressStage: null,
    receiptStateFingerprint: "",
    reasonCode: state === "failed" ? candidate.error_code : null,
    requiresMiniAppContinuation: state === "awaiting_client",
    sideLabel: sideLabel(candidate),
    sharesRaw: candidate.shares_raw,
    sourceRoute: null,
    stepStateFingerprint: "",
    state,
    venueOrderId: candidate.venue_order_id,
    venue: candidate.venue,
    version: 6,
  };
}

function liveProgressFor(
  candidate: ProjectionCandidate,
): TelegramTradeLifecycleProgress {
  if (candidate.is_direct_v2_handoff) {
    return directHandoffProgressFor(candidate);
  }
  const terminal = ["completed", "refunded", "failed", "cancelled"].includes(
    candidate.operation_status ?? "",
  );
  const ready =
    candidate.operation_status === "ready" &&
    candidate.progress_stage === "ready_for_consumer";
  const awaitingReconciliation =
    candidate.operation_status === "recovery_required" ||
    candidate.operation_status === "reconcile_required";
  const automaticProviderReferenceWait =
    candidate.has_automatic_provider_reference_wait;
  // A Relay root only makes pUSD available at the controller. It is not ready
  // for a Polymarket Buy until its exact Router continuation exists and has
  // reached the consumer-ready state. Keeping this as preparing prevents a
  // Refresh from re-quoting/trading the intermediate balance.
  const routerContinuationPending =
    isTelegramPolymarketRouterContinuationPending({
      continuationId: candidate.continuation_id,
      operationStatus: candidate.operation_status,
      progressStage: candidate.progress_stage,
      rootRequiresRouterContinuation:
        candidate.root_requires_router_continuation,
      venue: candidate.venue,
    });
  const continuationReason = candidate.result.fundingContinuationReasonCode;
  const routerContinuationNeedsAttention =
    routerContinuationPending &&
    isTelegramRouterContinuationHardReason(continuationReason);
  const reasonCode = routerContinuationPending
    ? typeof continuationReason === "string"
      ? continuationReason
      : "router_continuation_pending"
    : (candidate.operation_error_code ?? candidate.error_code);
  const venueBalancePending =
    ready &&
    candidate.status === "funding" &&
    candidate.error_code === "funding_balance_pending";
  const requiresMiniAppContinuation =
    candidate.delivery_mode === "app_handoff" &&
    isRecord(candidate.result.appHandoffExecution) &&
    candidate.result.appHandoffExecution.version === 2;
  // Once the intent crosses the venue submission boundary, the intent—not the
  // completed funding operation—owns the card. Otherwise consuming the funding
  // reservation would turn a submitted order into the false and unsafe
  // "Funding stopped / No trade was submitted" state.
  const tradeSubmissionState: TelegramTradeLifecycleState | null =
    candidate.status === "executing"
      ? "submitting_trade"
      : candidate.status === "submitted" ||
          candidate.status === "reconcile_required"
        ? "confirming_trade"
        : null;
  const state: TelegramTradeLifecycleState =
    tradeSubmissionState ??
    (routerContinuationPending
      ? routerContinuationNeedsAttention
        ? "needs_attention"
        : "preparing"
      : venueBalancePending
        ? "preparing"
        : ready
          ? "ready"
          : terminal
            ? "stopped"
            : awaitingReconciliation && !automaticProviderReferenceWait
              ? "needs_attention"
              : candidate.has_broadcast_boundary
                ? "submitted"
                : candidate.has_started_attempt
                  ? "preparing"
                  : "starting");
  return {
    action: candidate.action === "sell" ? "sell" : "buy",
    amountUsd: candidate.amount_usd ?? "0",
    attemptStateFingerprint: candidate.attempt_state_fingerprint,
    canCancel:
      tradeSubmissionState == null &&
      !terminal &&
      !awaitingReconciliation &&
      !candidate.has_broadcast_boundary &&
      !candidate.has_started_attempt &&
      !ready,
    // Funding already broadcast cannot be reversed safely. Its linked Buy can
    // still be cancelled before any venue order is submitted.
    canCancelBuy:
      candidate.action === "buy" &&
      candidate.submit_started_at == null &&
      (candidate.status === "funding" ||
        candidate.status === "external_handoff") &&
      !terminal &&
      (candidate.has_broadcast_boundary || ready),
    failureMessage: null,
    fundingAmountLabel: fundingAmountLabel(candidate),
    intentId: candidate.id,
    isDirectHandoff: false,
    marketTitle: candidate.market_title,
    operationStatus: candidate.operation_status,
    progressStage: candidate.progress_stage,
    receiptStateFingerprint: candidate.receipt_state_fingerprint,
    reasonCode: tradeSubmissionState == null ? reasonCode : null,
    requiresMiniAppContinuation,
    sideLabel: sideLabel(candidate),
    sharesRaw: candidate.shares_raw,
    sourceRoute: sourceRoute(candidate),
    stepStateFingerprint: candidate.step_state_fingerprint,
    state,
    venueOrderId: candidate.venue_order_id,
    venue: candidate.venue,
    version: 6,
  };
}

/**
 * The intent is the trade. Once it is failed or cancelled nothing revives it, so
 * the intent — not the funding operation it links to — decides the card: a
 * later `operation = ready` must never restore a "Funding ready" card over a
 * stopped one. Pinning the operation-derived fields also settles the revision,
 * so a stopped card is written once instead of re-edited on every subsequent
 * operation change.
 */
function progressFor(
  candidate: ProjectionCandidate,
): TelegramTradeLifecycleProgress {
  const live = liveProgressFor(candidate);
  if (
    candidate.status !== "failed" &&
    candidate.status !== "cancelled" &&
    candidate.status !== "filled"
  ) {
    return live;
  }
  return {
    ...live,
    attemptStateFingerprint: "",
    canCancel: false,
    canCancelBuy: false,
    operationStatus: null,
    progressStage: null,
    reasonCode:
      candidate.status === "filled"
        ? null
        : (candidate.error_code ?? live.reasonCode),
    receiptStateFingerprint: "",
    failureMessage:
      candidate.status === "failed"
        ? candidate.error_message?.trim() || null
        : null,
    state:
      candidate.status === "filled"
        ? "filled"
        : candidate.is_direct_v2_handoff
          ? candidate.status === "cancelled"
            ? "cancelled"
            : "failed"
          : "stopped",
    stepStateFingerprint: "",
  };
}

function sameProgress(
  left: TelegramTradeLifecycleProgress | null,
  right: TelegramTradeLifecycleProgress,
): boolean {
  return (
    left?.version === right.version &&
    left.action === right.action &&
    left.intentId === right.intentId &&
    left.venue === right.venue &&
    left.marketTitle === right.marketTitle &&
    left.sideLabel === right.sideLabel &&
    left.venueOrderId === right.venueOrderId &&
    left.sourceRoute === right.sourceRoute &&
    left.amountUsd === right.amountUsd &&
    left.sharesRaw === right.sharesRaw &&
    left.isDirectHandoff === right.isDirectHandoff &&
    left.failureMessage === right.failureMessage &&
    left.fundingAmountLabel === right.fundingAmountLabel &&
    left.operationStatus === right.operationStatus &&
    left.progressStage === right.progressStage &&
    left.reasonCode === right.reasonCode &&
    left.requiresMiniAppContinuation === right.requiresMiniAppContinuation &&
    left.stepStateFingerprint === right.stepStateFingerprint &&
    left.attemptStateFingerprint === right.attemptStateFingerprint &&
    left.receiptStateFingerprint === right.receiptStateFingerprint &&
    left.state === right.state &&
    left.canCancel === right.canCancel &&
    left.canCancelBuy === right.canCancelBuy
  );
}

async function listCandidates(
  client: PoolClient,
  limit: number,
): Promise<readonly ProjectionCandidate[]> {
  const { rows } = await client.query<ProjectionCandidate>(
    `select intent.id,
            intent.user_id,
            intent.telegram_user_id,
            intent.chat_id,
            intent.telegram_message_id::text,
            intent.venue,
            intent.action,
            intent.venue_order_id,
            coalesce(market.title, intent.market_id, 'Market') as market_title,
            intent.side,
            intent.shares_raw,
            funding_authorization.source_network_id,
            funding_authorization.source_asset_id,
            funding_authorization.source_asset_decimals,
            intent.amount_usd::text,
            intent.delivery_mode,
            intent.status,
            intent.error_code,
            intent.error_message,
            intent.result,
            intent.submit_started_at,
            intent.funding_operation_id::text,
            (
              intent.delivery_mode = 'app_handoff'
              and intent.funding_operation_id is null
              and intent.result -> 'appHandoffExecution' ->> 'version' = '2'
            ) as is_direct_v2_handoff,
            tracked_operation.id::text as tracked_operation_id,
            (
              select reservation.id::text
              from balance_reservations reservation
              where reservation.operation_id = tracked_operation.id
                and reservation.user_id = intent.user_id
                and reservation.mode = 'settled_for_consumer'
                and reservation.state = 'active'
              order by reservation.id
              limit 1
            ) as consumer_reservation_id,
            tracked_operation.destination_amount #>> '{asset,assetId}'
              as funding_destination_asset_id,
            tracked_operation.destination_amount #>> '{asset,decimals}'
              as funding_destination_decimals,
            tracked_operation.destination_amount #>> '{raw}'
              as funding_destination_raw,
            continuation.id::text as continuation_id,
            ${telegramPolymarketRootRequiresRouterContinuationSql("operation")}
              as root_requires_router_continuation,
            tracked_operation.status as operation_status,
            tracked_operation.progress_stage,
            tracked_operation.error_code as operation_error_code,
            coalesce((
              select string_agg(
                       step.ordinal::text || ':' || step.state,
                       ',' order by step.ordinal
                     )
                from funding_operation_steps step
               where step.operation_id = tracked_operation.id
            ), '') as step_state_fingerprint,
            coalesce((
              select string_agg(
                       step.ordinal::text || ':' || receipt.status,
                       ',' order by step.ordinal, receipt.observed_at, receipt.id
                     )
                from funding_step_receipt_observations receipt
                join funding_operation_steps step on step.id = receipt.step_id
               where step.operation_id = tracked_operation.id
            ), '') as receipt_state_fingerprint,
            coalesce((
              select string_agg(
                       step.ordinal::text || ':' ||
                       attempt.attempt_number::text || ':' || attempt.outcome,
                       ',' order by step.ordinal, attempt.attempt_number
                     )
                from funding_operation_step_attempts attempt
                join funding_operation_steps step on step.id = attempt.step_id
               where step.operation_id = tracked_operation.id
            ), '') as attempt_state_fingerprint,
            exists (
              select 1
                from funding_operation_step_attempts attempt
                join funding_operation_steps step on step.id = attempt.step_id
               where step.operation_id = tracked_operation.id
                 and (
                   attempt.broadcast_may_have_occurred
                   or attempt.outcome in ('submitted', 'ambiguous', 'succeeded')
                 )
            ) as has_broadcast_boundary,
            exists (
              select 1
                from funding_operation_step_attempts attempt
                join funding_operation_steps step on step.id = attempt.step_id
               where step.operation_id = tracked_operation.id
                 and attempt.outcome = 'ambiguous'
                 and attempt.broadcast_may_have_occurred
                 and attempt.reference_kind = 'provider_receipt'
                 and not exists (
                   select 1
                     from funding_step_receipt_observations receipt
                    where receipt.attempt_id = attempt.id
                      and receipt.status = 'finalized'
                      and receipt.canonical
                      and receipt.action_match
                 )
            ) as has_automatic_provider_reference_wait,
            exists (
              select 1
                from funding_operation_step_attempts attempt
                join funding_operation_steps step on step.id = attempt.step_id
               where step.operation_id = tracked_operation.id
                 and attempt.outcome = 'started'
            ) as has_started_attempt
       from telegram_trade_intents intent
       left join funding_operations operation
         on operation.id = intent.funding_operation_id
       left join lateral (
         select continuation.*
           from funding_operations continuation
          where continuation.user_id = operation.user_id
            and continuation.support_metadata ->> 'telegramTradeIntentId' = intent.id::text
            and continuation.support_metadata ->> 'continuationOfOperationId' = operation.id::text
          order by continuation.created_at desc, continuation.id desc
          limit 1
       ) continuation on true
       left join telegram_funding_authorizations funding_authorization
         on funding_authorization.id::text = coalesce(
              continuation.support_metadata ->> 'fundingAuthorizationId',
              operation.support_metadata ->> 'fundingAuthorizationId'
            )
       cross join lateral (
         select coalesce(continuation.id, operation.id) as id,
                coalesce(continuation.status, operation.status) as status,
                coalesce(continuation.progress_stage, operation.progress_stage) as progress_stage,
                coalesce(
                  continuation.actual_destination_amount,
                  operation.actual_destination_amount,
                  continuation.requested_destination_amount,
                  operation.requested_destination_amount
                ) as destination_amount,
                case
                  when continuation.id is null then operation.error_code
                  else continuation.error_code
                end as error_code
       ) tracked_operation
       left join unified_markets market
         on market.id = intent.market_id
      where intent.status in (
              'external_handoff', 'funding', 'executing', 'submitted',
              'reconcile_required', 'failed', 'cancelled', 'filled'
            )
        and (
          intent.funding_operation_id is not null
          or (
            intent.delivery_mode = 'app_handoff'
            and intent.funding_operation_id is null
            and intent.result -> 'appHandoffExecution' ->> 'version' = '2'
          )
        )
        and intent.result ->> $2::text is distinct from $3::text
      -- Never let already-projected historical rows monopolize a bounded
      -- worker batch. Unprojected cards go first; afterwards the newest intent
      -- or funding transition wins, regardless of whether execution is server
      -- or Mini App owned. This preserves one shared lifecycle for Buy/Sell.
      order by (intent.result -> 'shortfallProgress' is not null),
               greatest(
                 intent.updated_at,
                 coalesce(operation.updated_at, '-infinity'::timestamptz),
                 coalesce(continuation.updated_at, '-infinity'::timestamptz)
               ) desc,
               intent.id
      limit $1
      for update of intent skip locked`,
    [
      limit,
      TELEGRAM_TRADE_TERMINAL_DELIVERY_OWNER_RESULT_KEY,
      TELEGRAM_TRADE_GENERIC_NOTIFICATION_OWNER,
    ],
  );
  return rows;
}

/**
 * Turn durable Telegram trade transitions into one revisioned source-card
 * edit. Funding state, client handoff state, and ordinary venue reconciliation
 * are all reflected here; Refresh reads state but never moves money.
 */
export async function runTelegramTradeLifecycleProjectionBatchInTransaction(
  client: PoolClient,
  input: Readonly<{ limit?: number }> = {},
): Promise<Readonly<{ candidates: number; created: number; skipped: number }>> {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const candidates = await listCandidates(client, limit);
  let created = 0;
  for (const candidate of candidates) {
    // A cancelled Buy must never consume funded venue cash. Once the route
    // is ready, release just its consumer reservation; the transfer itself
    // is already final and is not cancelled or moved again.
    if (
      candidate.status === "cancelled" &&
      candidate.operation_status === "ready" &&
      candidate.progress_stage === "ready_for_consumer" &&
      candidate.tracked_operation_id &&
      candidate.consumer_reservation_id &&
      candidate.user_id
    ) {
      await releaseFundingReservationForAbandonedTradeInTransaction(client, {
        userId: candidate.user_id,
        link: {
          operationId: candidate.tracked_operation_id,
          reservationId: candidate.consumer_reservation_id,
        },
        outcomeReason: "telegram_buy_cancelled_after_funding",
      });
    }
    const progress = progressFor(candidate);
    const existing = parseProgress(candidate.result.shortfallProgress);
    if (sameProgress(existing, progress)) continue;
    const revision =
      typeof candidate.result.shortfallProgressRevision === "number" &&
      Number.isSafeInteger(candidate.result.shortfallProgressRevision)
        ? candidate.result.shortfallProgressRevision + 1
        : 1;
    const updated = await client.query(
      `update telegram_trade_intents
            set result = result || jsonb_build_object(
                  'shortfallProgress', $2::jsonb,
                  'shortfallProgressRevision', $3::int
                ),
                updated_at = clock_timestamp()
          where id = $1::uuid
            and status in (
              'external_handoff', 'funding', 'executing', 'submitted',
              'reconcile_required', 'failed', 'cancelled', 'filled'
            )`,
      [candidate.id, JSON.stringify(progress), revision],
    );
    if (updated.rowCount !== 1) continue;
    if (
      candidate.chat_id &&
      candidate.telegram_message_id &&
      candidate.user_id
    ) {
      // A later durable revision is authoritative. Old pending/retry edits
      // must never be delivered after it and restore stale card content.
      await client.query(
        `update telegram_bot_action_outbox
              set status = 'dead',
                  last_error = 'telegram_trade_lifecycle_edit_superseded',
                  updated_at = clock_timestamp()
            where trade_intent_id = $1::uuid
              and action = $3::text
              and state_revision < $2::int
              and status in ('pending', 'retry')`,
        [candidate.id, revision, TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION],
      );
      await client.query(
        `insert into telegram_bot_action_outbox (
             action, user_id, telegram_user_id, trade_intent_id,
             state_revision, payload
           ) values (
             $1::text, $2::uuid, $3, $4::uuid, $5, $6::jsonb
           )
           on conflict (trade_intent_id, state_revision, action)
             where action = '${TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION}'
           do nothing`,
        [
          TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION,
          candidate.user_id,
          candidate.telegram_user_id,
          candidate.id,
          revision,
          JSON.stringify(progress),
        ],
      );
    }
    created += 1;
  }
  return {
    candidates: candidates.length,
    created,
    skipped: candidates.length - created,
  };
}

export async function runTelegramTradeLifecycleProjectionBatch(
  pool: Pool,
  input: Readonly<{ limit?: number }> = {},
): Promise<Readonly<{ candidates: number; created: number; skipped: number }>> {
  return tx(pool, (client) =>
    runTelegramTradeLifecycleProjectionBatchInTransaction(client, input),
  );
}

function directHandoffText(progress: TelegramTradeLifecycleProgress): string {
  const trade = progress.action === "sell" ? "Sell" : "Buy";
  const subject = progress.action === "sell" ? "sell" : "buy";
  const status = {
    awaiting_client: [
      "▶️",
      `Continue ${trade} in Hunch`,
      `Your confirmed ${trade} is ready in Hunch. No order has been submitted.`,
    ],
    submitting_trade: [
      "⏳",
      `Submitting ${trade}`,
      `Hunch is submitting your ${trade} and recording the venue result automatically.`,
    ],
    confirming_trade: [
      "⏳",
      `Confirming ${trade}`,
      `The ${trade} may have reached the venue. Hunch is checking the result automatically.`,
    ],
    filled: ["✅", "Trade filled", `The ${trade} was filled successfully.`],
    failed: [
      "⚠️",
      "Trade failed",
      progress.failureMessage ??
        `The ${trade} failed before a confirmed venue submission. No order is being retried automatically.`,
    ],
    cancelled: [
      "ℹ️",
      `${trade} cancelled`,
      `No order was submitted. Open the market to choose another ${subject}.`,
    ],
  } as const;
  const [icon, heading, body] = status[progress.state as keyof typeof status];
  return joinTelegramMarkdownV2Lines(
    [
      `${icon} ${formatTelegramBoldMarkdownV2(heading)}`,
      "",
      `🔵 ${formatTelegramFieldMarkdownV2("Venue", formatTelegramVenueLabel(progress.venue))}`,
      `🎯 ${formatTelegramFieldMarkdownV2("Market", progress.marketTitle)}`,
      `↔️ ${formatTelegramFieldMarkdownV2("Side", progress.sideLabel)}`,
      progress.action === "sell"
        ? `📦 ${formatTelegramFieldMarkdownV2(
            "Sell",
            progress.sharesRaw == null
              ? "unavailable quantity"
              : `${formatRawShares(progress.sharesRaw)} shares`,
          )}`
        : `🛒 ${formatTelegramFieldMarkdownV2("Buy", `$${progress.amountUsd}`)}`,
      progress.venueOrderId
        ? `🔗 ${formatTelegramFieldWithMarkdownV2(
            "Order",
            formatTelegramCodeMarkdownV2(progress.venueOrderId),
          )}`
        : null,
      "",
      escapeTelegramMarkdownV2(body),
    ].filter((line): line is string => line != null),
  );
}

function progressText(progress: TelegramTradeLifecycleProgress): string {
  if (progress.isDirectHandoff) return directHandoffText(progress);
  if (progress.reasonCode === "funding_balance_pending") {
    return joinTelegramMarkdownV2Lines(
      [
        `🔄 ${formatTelegramBoldMarkdownV2(
          "Waiting for Polymarket balance confirmation",
        )}`,
        "",
        `🔵 ${formatTelegramFieldMarkdownV2("Venue", formatTelegramVenueLabel(progress.venue))}`,
        `🎯 ${formatTelegramFieldMarkdownV2("Market", progress.marketTitle)}`,
        `↔️ ${formatTelegramFieldMarkdownV2("Side", progress.sideLabel)}`,
        `🛒 ${formatTelegramFieldMarkdownV2("Buy target", `$${progress.amountUsd}`)}`,
        progress.fundingAmountLabel
          ? `💸 ${formatTelegramFieldMarkdownV2("Funding", progress.fundingAmountLabel)}`
          : null,
        progress.sourceRoute
          ? `🔄 ${formatTelegramFieldMarkdownV2("Funding route", progress.sourceRoute)}`
          : null,
        "",
        escapeTelegramMarkdownV2(
          progress.requiresMiniAppContinuation
            ? "Funding is confirmed. Polymarket is still reflecting the deposit in its trading balance. Continue in Hunch when it is ready; the Buy has not been submitted."
            : "Funding is confirmed. Polymarket is still reflecting the deposit in its trading balance; Hunch will retry the fresh Buy review automatically. The Buy has not been submitted yet.",
        ),
      ].filter((line): line is string => line != null),
    );
  }
  if (progress.reasonCode?.startsWith("router_")) {
    const pending = progress.reasonCode === "router_continuation_pending";
    const polygonRpcUnavailable =
      progress.reasonCode === "router_polygon_rpc_unavailable";
    const waiting = pending || polygonRpcUnavailable;
    return joinTelegramMarkdownV2Lines(
      [
        `${waiting ? "🔄" : "⚠️"} ${formatTelegramBoldMarkdownV2(
          pending
            ? "Moving funds into Polymarket"
            : polygonRpcUnavailable
              ? "Waiting for Polygon confirmation service"
              : "Polymarket funding needs attention",
        )}`,
        "",
        `🔵 ${formatTelegramFieldMarkdownV2("Venue", formatTelegramVenueLabel(progress.venue))}`,
        `🎯 ${formatTelegramFieldMarkdownV2("Market", progress.marketTitle)}`,
        `↔️ ${formatTelegramFieldMarkdownV2("Side", progress.sideLabel)}`,
        `🛒 ${formatTelegramFieldMarkdownV2("Buy target", `$${progress.amountUsd}`)}`,
        progress.fundingAmountLabel
          ? `💸 ${formatTelegramFieldMarkdownV2("Funding", progress.fundingAmountLabel)}`
          : null,
        progress.sourceRoute
          ? `🔄 ${formatTelegramFieldMarkdownV2("Funding route", progress.sourceRoute)}`
          : null,
        "",
        escapeTelegramMarkdownV2(
          pending
            ? progress.requiresMiniAppContinuation
              ? "Your funds are ready. Continue in Hunch to complete the final Polymarket funding step. The Buy has not been submitted."
              : "Your funds are ready. The final Polymarket funding step is being prepared automatically. The Buy has not been submitted yet."
            : polygonRpcUnavailable
              ? progress.requiresMiniAppContinuation
                ? "Your funds are safe. Hunch cannot reach Polygon right now. Continue in Hunch after the connection recovers; the Buy has not been submitted."
                : "Your funds are safe. Hunch can't reach Polygon right now and will retry automatically. The Buy has not been submitted yet."
              : progress.reasonCode === "router_root_amount_unavailable"
                ? "Your funds are safe, but Hunch could not confirm the exact amount received. The final funding step was not sent."
                : "Your funds are safe. The final funding step was not sent; Hunch will retry when wallet setup is ready.",
        ),
      ].filter((line): line is string => line != null),
    );
  }
  const clientExecution = progress.requiresMiniAppContinuation;
  const trade = progress.action === "sell" ? "Sell" : "Buy";
  const status = {
    starting: [
      "ℹ️",
      "Starting preparation",
      clientExecution
        ? "Open Hunch to start the approved funding action. The Buy has not been submitted."
        : "The approved funding route is being started automatically.",
    ],
    preparing: [
      "🔄",
      "Preparing source funds",
      clientExecution
        ? "Funding is waiting for the next approved action in Hunch. The Buy has not been submitted."
        : "The funding transfer is running automatically. The Buy has not been submitted.",
    ],
    submitted: [
      "⏳",
      "Confirming funding",
      clientExecution
        ? "The funding transaction was sent from Hunch. Hunch is confirming it automatically; the Buy has not been submitted."
        : "The funding transaction was sent. The bot is confirming it automatically; the Buy has not been submitted.",
    ],
    ready: [
      "✅",
      "Funding confirmed",
      clientExecution
        ? "Funding is confirmed. Continue in Hunch to use the reserved funds for the Buy within your confirmed limits."
        : "Funding is confirmed. Hunch is checking a fresh quote and will Buy automatically within your confirmed limits.",
    ],
    submitting_trade: [
      "⏳",
      `Submitting ${trade}`,
      `Funding is confirmed. Hunch is submitting the ${trade} within your confirmed limits.`,
    ],
    confirming_trade: [
      "⏳",
      "Checking order",
      "The order may already have been submitted. Hunch is checking the venue automatically; do not retry it.",
    ],
    needs_attention: [
      "⚠️",
      "Funding needs attention",
      "The route is waiting for safe reconciliation. No trade was submitted.",
    ],
    stopped: [
      "⚠️",
      "Funding stopped",
      "No trade was submitted. Open the market for a fresh Review.",
    ],
    filled: ["✅", "Trade filled", "The Buy was filled successfully."],
  } as const;
  const [icon, heading, body] = status[progress.state as keyof typeof status];
  return joinTelegramMarkdownV2Lines(
    [
      `${icon} ${formatTelegramBoldMarkdownV2(heading)}`,
      "",
      `🔵 ${formatTelegramFieldMarkdownV2("Venue", formatTelegramVenueLabel(progress.venue))}`,
      `🎯 ${formatTelegramFieldMarkdownV2("Market", progress.marketTitle)}`,
      `↔️ ${formatTelegramFieldMarkdownV2("Side", progress.sideLabel)}`,
      `🛒 ${formatTelegramFieldMarkdownV2("Buy target", `$${progress.amountUsd}`)}`,
      progress.venueOrderId
        ? `🔗 ${formatTelegramFieldWithMarkdownV2(
            "Order",
            formatTelegramCodeMarkdownV2(progress.venueOrderId),
          )}`
        : null,
      progress.fundingAmountLabel
        ? `💸 ${formatTelegramFieldMarkdownV2("Funding", progress.fundingAmountLabel)}`
        : null,
      progress.sourceRoute
        ? `🔄 ${formatTelegramFieldMarkdownV2("Funding route", progress.sourceRoute)}`
        : null,
      "",
      escapeTelegramMarkdownV2(body),
    ].filter((line): line is string => line != null),
  );
}

function progressKeyboard(
  progress: TelegramTradeLifecycleProgress,
): TelegramBotTradingClientReplyMarkup {
  const rows: TelegramBotTradingClientButton[][] = [];
  const openMarket = {
    callback_data: `${CALLBACK_PREFIX}:open_market:${progress.intentId}`,
    text: "🎯 Open market",
  } as const;
  if (progress.isDirectHandoff) {
    if (progress.state === "filled") {
      rows.push([{ ...openMarket, text: "🎯 Trade this market" }]);
      rows.push([
        { callback_data: "hm:v1:positions", text: "💼 My positions" },
      ]);
    } else if (progress.state === "awaiting_client") {
      rows.push([
        {
          callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
          text: `▶️ Continue ${progress.action === "sell" ? "Sell" : "Buy"} in Hunch`,
        },
      ]);
    } else if (progress.state === "failed" || progress.state === "cancelled") {
      rows.push([openMarket]);
    } else {
      rows.push([
        {
          callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
          text: "🔄 Check status",
        },
      ]);
    }
    if (progress.canCancel) {
      rows.push([
        {
          callback_data: `${CALLBACK_PREFIX}:cancel:${progress.intentId}`,
          text: `❌ Cancel ${progress.action === "sell" ? "Sell" : "Buy"}`,
        },
      ]);
    }
    rows.push([{ callback_data: "hm:v1:home", text: "🏠 Home" }]);
    return { inline_keyboard: rows };
  }
  if (progress.state === "filled") {
    rows.push([{ ...openMarket, text: "🎯 Trade this market" }]);
    rows.push([{ callback_data: "hm:v1:positions", text: "💼 My positions" }]);
  }
  if (
    progress.requiresMiniAppContinuation &&
    progress.state !== "filled" &&
    progress.state !== "stopped"
  ) {
    // This callback only reopens/reissues the same sealed handoff. It never
    // sends a client transaction and is safe to expose while the operation is
    // waiting, confirming, or ready for the trade consumer.
    rows.push([
      {
        callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
        text: "▶️ Continue in Hunch",
      },
    ]);
  } else if (
    progress.state === "needs_attention" ||
    progress.state === "stopped"
  ) {
    rows.push([
      progress.state === "stopped"
        ? openMarket
        : {
            callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
            text: "🔄 Check status",
          },
    ]);
  }
  if (progress.canCancel) {
    rows.push([
      {
        callback_data: `${CALLBACK_PREFIX}:cancel:${progress.intentId}`,
        text: "❌ Cancel preparation",
      },
    ]);
  }
  if (progress.canCancelBuy) {
    rows.push([
      {
        callback_data: `${CALLBACK_PREFIX}:cancel:${progress.intentId}`,
        text: "❌ Cancel Buy",
      },
    ]);
  }
  rows.push([{ callback_data: "hm:v1:home", text: "🏠 Home" }]);
  return { inline_keyboard: rows };
}

export const telegramTradeLifecycleProgressTestHooks = {
  markTelegramTradeLifecycleDelivered,
  progressKeyboard,
  progressText,
  recoverStaleTelegramTradeLifecycleDeliveries,
  resolveTelegramLifecycleEditFailure,
  telegramLifecycleEditSucceeded,
};

async function claimTelegramTradeLifecycleOutbox(
  pool: Pool,
): Promise<TelegramTradeLifecycleOutboxRow | null> {
  return tx(pool, async (client) => {
    const { rows } = await client.query<TelegramTradeLifecycleOutboxRow>(
      `select outbox.id,
              outbox.trade_intent_id::text,
              outbox.state_revision,
              outbox.payload,
              outbox.attempt_count,
              outbox.delivery_attempt_id::text,
              outbox.user_id::text,
              intent.chat_id,
              intent.telegram_message_id::text
         from telegram_bot_action_outbox outbox
         join telegram_trade_intents intent on intent.id = outbox.trade_intent_id
        where outbox.action = $1::text
          and outbox.status in ('pending', 'retry')
          and outbox.attempt_count < $2::integer
          and outbox.next_attempt_at <= clock_timestamp()
          and intent.chat_id is not null
          and intent.telegram_message_id is not null
          and intent.result ->> 'shortfallProgressRevision' =
                outbox.state_revision::text
          and intent.result ->> $3::text is distinct from $4::text
        order by outbox.next_attempt_at, outbox.created_at
        for update of outbox, intent skip locked
        limit 1`,
      [
        TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION,
        TELEGRAM_TRADE_LIFECYCLE_MAX_EDIT_ATTEMPTS,
        TELEGRAM_TRADE_TERMINAL_DELIVERY_OWNER_RESULT_KEY,
        TELEGRAM_TRADE_GENERIC_NOTIFICATION_OWNER,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    const claimed = await client.query<{
      attempt_count: number;
      delivery_attempt_id: string;
    }>(
      `update telegram_bot_action_outbox
          set status = 'sending',
              attempt_count = attempt_count + 1,
              delivery_attempt_id = gen_random_uuid(),
              delivery_started_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where id = $1::uuid
          and status in ('pending', 'retry')
          and attempt_count < $2::integer
        returning delivery_attempt_id::text, attempt_count`,
      [row.id, TELEGRAM_TRADE_LIFECYCLE_MAX_EDIT_ATTEMPTS],
    );
    const claimedRow = claimed.rows[0];
    return claimedRow?.delivery_attempt_id
      ? {
          ...row,
          attempt_count: claimedRow.attempt_count,
          delivery_attempt_id: claimedRow.delivery_attempt_id,
        }
      : null;
  });
}

export async function deliverTelegramTradeLifecycleProgress(
  input: Readonly<{
    limit?: number;
    pool: Pool;
    telegram: Readonly<{
      editMessageText: (request: {
        chat_id: string;
        disable_web_page_preview: boolean;
        message_id: number;
        parse_mode: "MarkdownV2";
        reply_markup: TelegramBotTradingClientReplyMarkup;
        text: string;
      }) => Promise<unknown>;
    }>;
  }>,
): Promise<Readonly<{ claimed: number; delivered: number; retried: number }>> {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  await recoverStaleTelegramTradeLifecycleDeliveries({ pool: input.pool });
  let claimed = 0;
  let delivered = 0;
  let retried = 0;
  while (claimed < limit) {
    const row = await claimTelegramTradeLifecycleOutbox(input.pool);
    if (!row) break;
    claimed += 1;
    const progress = parseProgress(row.payload);
    const messageId = Number(row.telegram_message_id);
    if (
      !progress ||
      !Number.isSafeInteger(messageId) ||
      !row.delivery_attempt_id
    ) {
      await input.pool.query(
        `update telegram_bot_action_outbox
            set status = 'dead', last_error = 'telegram_trade_lifecycle_payload_invalid',
                updated_at = clock_timestamp()
          where id = $1::uuid and status = 'sending'`,
        [row.id],
      );
      continue;
    }
    try {
      const editResult = await input.telegram.editMessageText({
        chat_id: row.chat_id,
        disable_web_page_preview: false,
        message_id: messageId,
        parse_mode: "MarkdownV2",
        reply_markup: progressKeyboard(progress),
        text: progressText(progress),
      });
      if (!telegramLifecycleEditSucceeded(editResult)) throw editResult;
      await markTelegramTradeLifecycleDelivered({
        deliveryAttemptId: row.delivery_attempt_id,
        messageId,
        outboxId: row.id,
        pool: input.pool,
        terminalFill: progress.state === "filled",
      });
      delivered += 1;
    } catch (error) {
      const failure = resolveTelegramLifecycleEditFailure(
        error,
        row.attempt_count,
      );
      // Telegram returns this after an applied edit whose response was lost.
      // Treating the exact same rendered message as delivered is idempotent.
      if (failure.code === "already_applied") {
        await markTelegramTradeLifecycleDelivered({
          deliveryAttemptId: row.delivery_attempt_id,
          messageId,
          outboxId: row.id,
          pool: input.pool,
          terminalFill: progress.state === "filled",
        });
        delivered += 1;
        continue;
      }
      if (failure.disposition === "dead") {
        await input.pool.query(
          `update telegram_bot_action_outbox
              set status = 'dead',
                  last_error = 'telegram_trade_lifecycle_edit_terminal:' || $3::text,
                  delivery_attempt_id = null,
                  delivery_started_at = null,
                  updated_at = clock_timestamp()
            where id = $1::uuid
              and status = 'sending'
              and delivery_attempt_id = $2::uuid`,
          [row.id, row.delivery_attempt_id, failure.code],
        );
        continue;
      }
      await input.pool.query(
        `update telegram_bot_action_outbox
            set status = 'retry',
                next_attempt_at = clock_timestamp() +
                  ($3::integer * interval '1 second'),
                last_error = 'telegram_trade_lifecycle_edit_failed:' || $4::text,
                delivery_attempt_id = null,
                delivery_started_at = null,
                updated_at = clock_timestamp()
          where id = $1::uuid
            and status = 'sending'
            and delivery_attempt_id = $2::uuid`,
        [row.id, row.delivery_attempt_id, failure.retryAfterSec, failure.code],
      );
      retried += 1;
    }
  }
  return { claimed, delivered, retried };
}
