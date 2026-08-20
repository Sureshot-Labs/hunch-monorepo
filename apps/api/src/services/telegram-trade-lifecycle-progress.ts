import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
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

const CALLBACK_PREFIX = TELEGRAM_BOT_TRADING_CALLBACK_PREFIX;

/**
 * `trade_funding_edit` is the persisted outbox identifier introduced for the
 * original shortfall card. Its constraint is already deployed, so keep that
 * identifier while the payload now represents the whole trade lifecycle.
 */
const TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION = "trade_funding_edit";

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
  amountUsd: string;
  attemptStateFingerprint: string;
  canCancel: boolean;
  canCancelBuy: boolean;
  /** True only for a sealed v2 Buy that has no funding operation. */
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
   * or submit it; this covers both funding actions and a sealed direct Buy.
   */
  requiresMiniAppContinuation: boolean;
  sideLabel: string;
  sourceRoute: string | null;
  stepStateFingerprint: string;
  state: TelegramTradeLifecycleState;
  venueOrderId: string | null;
  venue: string;
  version: 1 | 2 | 3 | 4 | 5;
}>;

type ProjectionCandidate = Readonly<{
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
      value.version !== 5)
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
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(decimals)) {
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
    sourceRoute: null,
    stepStateFingerprint: "",
    state,
    venueOrderId: candidate.venue_order_id,
    venue: candidate.venue,
    version: 5,
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
  const state: TelegramTradeLifecycleState = routerContinuationPending
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
                : "starting";
  return {
    amountUsd: candidate.amount_usd ?? "0",
    attemptStateFingerprint: candidate.attempt_state_fingerprint,
    canCancel:
      !terminal &&
      !awaitingReconciliation &&
      !candidate.has_broadcast_boundary &&
      !candidate.has_started_attempt &&
      !ready,
    // Funding already broadcast cannot be reversed safely. Its linked Buy can
    // still be cancelled before any venue order is submitted.
    canCancelBuy:
      candidate.status === "funding" &&
      !terminal &&
      candidate.has_broadcast_boundary,
    failureMessage: null,
    fundingAmountLabel: fundingAmountLabel(candidate),
    intentId: candidate.id,
    isDirectHandoff: false,
    marketTitle: candidate.market_title,
    operationStatus: candidate.operation_status,
    progressStage: candidate.progress_stage,
    receiptStateFingerprint: candidate.receipt_state_fingerprint,
    reasonCode,
    requiresMiniAppContinuation,
    sideLabel: sideLabel(candidate),
    sourceRoute: sourceRoute(candidate),
    stepStateFingerprint: candidate.step_state_fingerprint,
    state,
    venueOrderId: candidate.venue_order_id,
    venue: candidate.venue,
    version: 5,
  };
}

/**
 * The intent is the Buy. Once it is failed or cancelled nothing revives it, so
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
    left.intentId === right.intentId &&
    left.venue === right.venue &&
    left.marketTitle === right.marketTitle &&
    left.sideLabel === right.sideLabel &&
    left.venueOrderId === right.venueOrderId &&
    left.sourceRoute === right.sourceRoute &&
    left.amountUsd === right.amountUsd &&
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
            intent.venue_order_id,
            coalesce(market.title, intent.market_id, 'Market') as market_title,
            intent.side,
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
      -- Keep the existing funded-card path first. Direct handoff projections
      -- are additive and must not consume a whole worker batch while a live
      -- FundingOperation is waiting to render its next durable transition.
      order by (intent.funding_operation_id is null), intent.updated_at, intent.id
      limit $1
      for update of intent skip locked`,
    [limit],
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
  const status = {
    awaiting_client: [
      "▶️",
      "Continue Buy in Hunch",
      "Your confirmed Buy is ready in Hunch. No order has been submitted.",
    ],
    submitting_trade: [
      "⏳",
      "Submitting Buy",
      "Hunch is submitting your Buy and recording the venue result automatically.",
    ],
    confirming_trade: [
      "⏳",
      "Confirming Buy",
      "The Buy may have reached the venue. Hunch is checking the result automatically.",
    ],
    filled: ["✅", "Trade filled", "The Buy was filled successfully."],
    failed: [
      "⚠️",
      "Trade failed",
      progress.failureMessage ??
        "The Buy failed before a confirmed venue submission. No order is being retried automatically.",
    ],
    cancelled: [
      "ℹ️",
      "Buy cancelled",
      "No order was submitted. Open the market to choose another Buy.",
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
      `🛒 ${formatTelegramFieldMarkdownV2("Buy", `$${progress.amountUsd}`)}`,
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
  if (progress.isDirectHandoff) {
    if (progress.state === "filled") {
      rows.push([
        {
          callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
          text: "🎯 Trade this market",
        },
      ]);
      rows.push([
        { callback_data: "hm:v1:positions", text: "💼 My positions" },
      ]);
    } else if (progress.state === "awaiting_client") {
      rows.push([
        {
          callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
          text: "▶️ Continue in Hunch",
        },
      ]);
    } else if (progress.state === "failed" || progress.state === "cancelled") {
      rows.push([
        {
          callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
          text: "🎯 Open market",
        },
      ]);
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
          text: "❌ Cancel Buy",
        },
      ]);
    }
    rows.push([{ callback_data: "hm:v1:home", text: "🏠 Home" }]);
    return { inline_keyboard: rows };
  }
  if (progress.state === "filled") {
    rows.push([
      {
        callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
        text: "🎯 Trade this market",
      },
    ]);
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
      {
        callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
        text:
          progress.state === "stopped" ? "🎯 Open market" : "🔄 Check status",
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
          and outbox.next_attempt_at <= clock_timestamp()
          and intent.chat_id is not null
          and intent.telegram_message_id is not null
          and intent.result ->> 'shortfallProgressRevision' =
                outbox.state_revision::text
        order by outbox.next_attempt_at, outbox.created_at
        for update of outbox, intent skip locked
        limit 1`,
      [TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION],
    );
    const row = rows[0];
    if (!row) return null;
    const claimed = await client.query(
      `update telegram_bot_action_outbox
          set status = 'sending',
              attempt_count = attempt_count + 1,
              delivery_attempt_id = gen_random_uuid(),
              delivery_started_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where id = $1::uuid
          and status in ('pending', 'retry')
        returning delivery_attempt_id::text`,
      [row.id],
    );
    const deliveryAttemptId = claimed.rows[0]?.delivery_attempt_id;
    return deliveryAttemptId
      ? { ...row, delivery_attempt_id: deliveryAttemptId }
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
      await input.telegram.editMessageText({
        chat_id: row.chat_id,
        disable_web_page_preview: false,
        message_id: messageId,
        parse_mode: "MarkdownV2",
        reply_markup: progressKeyboard(progress),
        text: progressText(progress),
      });
      await input.pool.query(
        `update telegram_bot_action_outbox
            set status = 'sent', sent_at = clock_timestamp(), last_error = null,
                updated_at = clock_timestamp()
          where id = $1::uuid
            and status = 'sending'
            and delivery_attempt_id = $2::uuid`,
        [row.id, row.delivery_attempt_id],
      );
      delivered += 1;
    } catch {
      await input.pool.query(
        `update telegram_bot_action_outbox
            set status = 'retry',
                next_attempt_at = clock_timestamp() + interval '3 seconds',
                last_error = 'telegram_trade_lifecycle_edit_failed',
                delivery_attempt_id = null,
                delivery_started_at = null,
                updated_at = clock_timestamp()
          where id = $1::uuid
            and status = 'sending'
            and delivery_attempt_id = $2::uuid`,
        [row.id, row.delivery_attempt_id],
      );
      retried += 1;
    }
  }
  return { claimed, delivered, retried };
}
