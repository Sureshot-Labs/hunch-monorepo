import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
import {
  isTelegramPolymarketRouterContinuationPending,
  isTelegramRouterContinuationHardReason,
  telegramPolymarketRootRequiresRouterContinuationSql,
} from "../funding/reconciliation/telegram-router-continuation-state.js";

import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramFieldMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";
import { formatTelegramVenueLabel } from "./telegram-market-identity.js";
import {
  TELEGRAM_BOT_TRADING_CALLBACK_PREFIX,
  type TelegramBotTradingClientButton,
  type TelegramBotTradingClientReplyMarkup,
} from "./telegram-bot-trading-client.js";

const CALLBACK_PREFIX = TELEGRAM_BOT_TRADING_CALLBACK_PREFIX;

type TradeFundingState =
  | "starting"
  | "preparing"
  | "submitted"
  | "ready"
  | "needs_attention"
  | "stopped";

type TradeFundingProgress = Readonly<{
  amountUsd: string;
  attemptStateFingerprint: string;
  canCancel: boolean;
  fundingAmountLabel: string | null;
  intentId: string;
  marketTitle: string;
  operationStatus: string | null;
  progressStage: string | null;
  receiptStateFingerprint: string;
  reasonCode: string | null;
  sideLabel: string;
  sourceRoute: string | null;
  stepStateFingerprint: string;
  state: TradeFundingState;
  venue: string;
  version: 1 | 2;
}>;

type ProjectionCandidate = Readonly<{
  amount_usd: string | null;
  attempt_state_fingerprint: string;
  chat_id: string | null;
  continuation_id: string | null;
  error_code: string | null;
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
  user_id: string | null;
  venue: string;
  has_automatic_provider_reference_wait: boolean;
  has_broadcast_boundary: boolean;
  has_started_attempt: boolean;
}>;

type TradeFundingOutboxRow = Readonly<{
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

function parseProgress(value: unknown): TradeFundingProgress | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    return null;
  }
  if (
    typeof value.intentId !== "string" ||
    typeof value.marketTitle !== "string" ||
    typeof value.venue !== "string" ||
    typeof value.sideLabel !== "string" ||
    typeof value.amountUsd !== "string" ||
    typeof value.canCancel !== "boolean" ||
    typeof value.state !== "string"
  ) {
    return null;
  }
  if (
    ![
      "starting",
      "preparing",
      "submitted",
      "ready",
      "needs_attention",
      "stopped",
    ].includes(value.state)
  ) {
    return null;
  }
  return value as unknown as TradeFundingProgress;
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
  const fractionalRaw = (amount % scale)
    .toString()
    .padStart(decimals, "0");
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

function liveProgressFor(candidate: ProjectionCandidate): TradeFundingProgress {
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
  const state: TradeFundingState = routerContinuationPending
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
    fundingAmountLabel: fundingAmountLabel(candidate),
    intentId: candidate.id,
    marketTitle: candidate.market_title,
    operationStatus: candidate.operation_status,
    progressStage: candidate.progress_stage,
    receiptStateFingerprint: candidate.receipt_state_fingerprint,
    reasonCode,
    sideLabel: sideLabel(candidate),
    sourceRoute: sourceRoute(candidate),
    stepStateFingerprint: candidate.step_state_fingerprint,
    state,
    venue: candidate.venue,
    // Bump the card contract so existing terminal cards are revised to expose
    // the direct Open market escape rather than an inert status affordance.
    version: 2,
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
function progressFor(candidate: ProjectionCandidate): TradeFundingProgress {
  const live = liveProgressFor(candidate);
  if (candidate.status !== "failed" && candidate.status !== "cancelled") {
    return live;
  }
  return {
    ...live,
    attemptStateFingerprint: "",
    canCancel: false,
    operationStatus: null,
    progressStage: null,
    reasonCode: candidate.error_code ?? live.reasonCode,
    receiptStateFingerprint: "",
    state: "stopped",
    stepStateFingerprint: "",
  };
}

function sameProgress(
  left: TradeFundingProgress | null,
  right: TradeFundingProgress,
): boolean {
  return (
    left?.version === right.version &&
    left.intentId === right.intentId &&
    left.venue === right.venue &&
    left.marketTitle === right.marketTitle &&
    left.sideLabel === right.sideLabel &&
    left.sourceRoute === right.sourceRoute &&
    left.amountUsd === right.amountUsd &&
    left.fundingAmountLabel === right.fundingAmountLabel &&
    left.operationStatus === right.operationStatus &&
    left.progressStage === right.progressStage &&
    left.reasonCode === right.reasonCode &&
    left.stepStateFingerprint === right.stepStateFingerprint &&
    left.attemptStateFingerprint === right.attemptStateFingerprint &&
    left.receiptStateFingerprint === right.receiptStateFingerprint &&
    left.state === right.state &&
    left.canCancel === right.canCancel
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
            coalesce(market.title, intent.market_id, 'Market') as market_title,
            intent.side,
            funding_authorization.source_network_id,
            funding_authorization.source_asset_id,
            funding_authorization.source_asset_decimals,
            intent.amount_usd::text,
            intent.status,
            intent.error_code,
            intent.result,
            intent.funding_operation_id::text,
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
       join funding_operations operation
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
      where intent.status in ('funding', 'failed', 'cancelled')
        and intent.funding_operation_id is not null
      order by intent.updated_at, intent.id
      limit $1
      for update of intent, operation skip locked`,
    [limit],
  );
  return rows;
}

/**
 * Turn durable shortfall operation changes into one revisioned Telegram-card
 * edit. This is deliberately a projector: Refresh reads state but never moves
 * money, while the finance worker advances the operation independently.
 */
export async function runTelegramTradeShortfallProgressProjectionBatch(
  pool: Pool,
  input: Readonly<{ limit?: number }> = {},
): Promise<Readonly<{ candidates: number; created: number; skipped: number }>> {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  return tx(pool, async (client) => {
    const candidates = await listCandidates(client, limit);
    let created = 0;
    for (const candidate of candidates) {
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
            and status in ('funding', 'failed', 'cancelled')`,
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
                  last_error = 'trade_funding_edit_superseded',
                  updated_at = clock_timestamp()
            where trade_intent_id = $1::uuid
              and action = 'trade_funding_edit'
              and state_revision < $2::int
              and status in ('pending', 'retry')`,
          [candidate.id, revision],
        );
        await client.query(
          `insert into telegram_bot_action_outbox (
             action, user_id, telegram_user_id, trade_intent_id,
             state_revision, payload
           ) values (
             'trade_funding_edit', $1::uuid, $2, $3::uuid, $4, $5::jsonb
           )
           on conflict (trade_intent_id, state_revision, action)
             where action = 'trade_funding_edit'
           do nothing`,
          [
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
  });
}

function progressText(progress: TradeFundingProgress): string {
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
          "Funding is confirmed. Polymarket is still reflecting the deposit in its trading balance; Hunch will retry the fresh Buy review automatically. The Buy has not been submitted yet.",
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
        waiting
          ? null
          : `ℹ️ ${formatTelegramFieldMarkdownV2(
              "Status",
              progress.reasonCode.replaceAll("_", " "),
            )}`,
        "",
        escapeTelegramMarkdownV2(
          pending
            ? "The Relay transfer is ready. The final Polymarket funding step is being prepared automatically. The Buy has not been submitted yet."
            : polygonRpcUnavailable
              ? "Your Relay funds remain safe at the controller. The worker cannot currently read Polygon, so it will retry automatically when the Polygon confirmation service is available. The Buy has not been submitted yet."
              : progress.reasonCode === "router_root_amount_unavailable"
                ? "The Relay transfer remains safe at your controller, but its exact received amount could not be reconstructed. The final Polymarket step was not sent."
                : "The Relay transfer remains safe at your controller. The final Polymarket step was not sent; the bot will retry only when its exact wallet and policy checks are valid.",
        ),
      ].filter((line): line is string => line != null),
    );
  }
  const status = {
    starting: [
      "ℹ️",
      "Starting preparation",
      "The approved funding route is being started automatically.",
    ],
    preparing: [
      "🔄",
      "Preparing source funds",
      "The funding transfer is running automatically. The Buy has not been submitted.",
    ],
    submitted: [
      "⏳",
      "Confirming funding",
      "The funding transaction was sent. The bot is confirming it automatically; the Buy has not been submitted.",
    ],
    ready: [
      "✅",
      "Funding confirmed",
      "Funding is confirmed. Hunch is preparing the fresh Buy review automatically.",
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
  } as const;
  const [icon, heading, body] = status[progress.state];
  return joinTelegramMarkdownV2Lines(
    [
      `${icon} ${formatTelegramBoldMarkdownV2(heading)}`,
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
      progress.reasonCode
        ? `ℹ️ ${formatTelegramFieldMarkdownV2("Status", progress.reasonCode.replaceAll("_", " "))}`
        : null,
      "",
      escapeTelegramMarkdownV2(body),
    ].filter((line): line is string => line != null),
  );
}

function progressKeyboard(
  progress: TradeFundingProgress,
): TelegramBotTradingClientReplyMarkup {
  const rows: TelegramBotTradingClientButton[][] = [];
  if (progress.state === "needs_attention" || progress.state === "stopped") {
    rows.push([
      {
        callback_data: `${CALLBACK_PREFIX}:retry_buy:${progress.intentId}`,
        text:
          progress.state === "stopped"
            ? "🎯 Open market"
            : "🔄 Check status",
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
  rows.push([{ callback_data: "hm:v1:home", text: "🏠 Home" }]);
  return { inline_keyboard: rows };
}

async function claimTradeFundingOutbox(
  pool: Pool,
): Promise<TradeFundingOutboxRow | null> {
  return tx(pool, async (client) => {
    const { rows } = await client.query<TradeFundingOutboxRow>(
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
        where outbox.action = 'trade_funding_edit'
          and outbox.status in ('pending', 'retry')
          and outbox.next_attempt_at <= clock_timestamp()
          and intent.chat_id is not null
          and intent.telegram_message_id is not null
          and intent.result ->> 'shortfallProgressRevision' =
                outbox.state_revision::text
        order by outbox.next_attempt_at, outbox.created_at
        for update of outbox, intent skip locked
        limit 1`,
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

export async function deliverTelegramTradeShortfallProgress(
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
    const row = await claimTradeFundingOutbox(input.pool);
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
            set status = 'dead', last_error = 'trade_funding_payload_invalid',
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
                last_error = 'trade_funding_edit_failed',
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
