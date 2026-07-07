import type {
  FastifyBaseLogger,
  FastifyPluginAsync,
  FastifyReply,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { AuthService, createAuthMiddleware, type User } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { requestPriceRefreshForTokens } from "../lib/price-refresh.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchStoredOrderWalletContext,
  storeOrder,
} from "../repos/orders-repo.js";
import { fetchPolymarketMarketInfo } from "../repos/polymarket-markets.js";
import {
  polymarketBalanceAllowanceSyncBodySchema,
  polymarketCancelOrderBodySchema,
  polymarketFunderDeriveBatchBodySchema,
  polymarketAccountQuerySchema,
  polymarketRedemptionPlanQuerySchema,
  polymarketEmbeddedEnsureReadyBodySchema,
  polymarketEmbeddedEnsureReadyExecuteBodySchema,
  polymarketEmbeddedSignFeeAuthBodySchema,
  polymarketEmbeddedSignOrderBodySchema,
  polymarketEmbeddedSignTypedDataBodySchema,
  polymarketFunderDeriveQuerySchema,
  polymarketMarketInfoQuerySchema,
  polymarketOrderHashBodySchema,
  polymarketOrderParamsQuerySchema,
  polymarketOrdersSyncBodySchema,
  polymarketOpenOrdersQuerySchema,
  polymarketPlaceOrderBodySchema,
  polymarketQuoteBodySchema,
  polymarketMaxSpendBodySchema,
} from "../schemas/polymarket-private.js";
import {
  fetchErc1155BalancesByOwner,
  fetchEvmCode,
  fetchPolymarketOrderHashV2,
  fetchPolymarketOrderStatus,
  fetchPolymarketOrderStatusV2,
} from "../services/polygon-rpc.js";
import {
  fetchPolymarketOnchainSnapshot,
  POLYGON_NATIVE_USDC_ADDRESS,
} from "../services/polymarket-onchain.js";
import { buildPolymarketRedemptionPlan } from "../services/polymarket-redemption-plan.js";
import {
  derivePolymarketFunders,
  type PolymarketFunderCandidate,
} from "../services/polymarket-funder.js";
import { requestPolymarketCredentials } from "../services/polymarket-credentials.js";
import {
  buildEmbeddedPolymarketOrderRequest,
  buildEmbeddedPolymarketConnectRequest,
  buildEmbeddedPolymarketTypedDataRequest,
  executeEmbeddedPolymarketConnectRequest,
  executeEmbeddedPolymarketOrderRequest,
  executeEmbeddedPolymarketTypedDataRequest,
  executeEmbeddedSignerApprovalRequests,
  prepareEmbeddedPolymarketSignerApprovalRequests,
  resolveEmbeddedPolymarketWalletContext,
} from "../services/polymarket-embedded.js";
import {
  buildEmbeddedExecutionSingleFlightKey,
  getEmbeddedExecutionSingleFlightPromise,
  runEmbeddedExecutionSingleFlight,
} from "../services/embedded-execution-singleflight.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "../services/notifications.js";
import { tryRecordReferralFirstTradeConversion } from "../services/analytics-referrals.js";
import { applyOptimisticPositionTrade } from "../services/positions-optimistic.js";
import {
  type PolymarketClosedReasonHint,
  type PolymarketNoFillTerminalStatus,
  type PolymarketTerminalReconcileStatus,
  POLYMARKET_UNCONFIRMED_STATUS,
  canApplyPolymarketNoFillTerminalStatus,
  isPolymarketUnconfirmedStatus,
  summarizePolymarketClobOrderExecution,
  resolvePolymarketTerminalReconcileStatus,
  resolvePolymarketUnconfirmedReconcileDecision,
  summarizePolymarketOnchainOrderExecution,
  summarizePolymarketV2OnchainOrderExecution,
} from "../services/polymarket-order-execution.js";
import { syncPolymarketTradesForSigner } from "../services/positions-sync.js";
import {
  extractOrderArray,
  extractOrderId,
  extractTokenId,
  fetchPolymarketOrderByHash,
  normalizeOpenOrder,
  polymarketL2Request,
  type PolymarketL2Credentials,
} from "../services/polymarket-clob-l2.js";
import {
  resolvePolymarketFeePolicySnapshot,
  validatePolymarketOrderBuilderCodeForConfig,
} from "../services/polymarket-builder-fees.js";
import { fetchOpenOrderCollateralLocks } from "../services/open-order-collateral.js";
import {
  normalizeOrderTypeForClob as normalizeQuoteOrderTypeForClob,
  PolymarketQuoteError,
} from "../services/polymarket-quote.js";
import {
  findMaxPolymarketMarketBuyUsdForFunds,
  quotePolymarketOrder,
} from "../services/polymarket-trading-service.js";
import {
  computePolymarketClobOpenOrderLocks,
  computePolymarketExecutableFunds,
  type PolymarketFunderExecutionKind,
} from "../services/polymarket-max-spend.js";

const POLY_DECIMALS = 6;
const POLYMARKET_SUBMIT_SETTLEMENT_ATTEMPTS = 5;
const POLYMARKET_SUBMIT_SETTLEMENT_DELAY_MS = 800;
const POLYMARKET_UNCONFIRMED_LIMIT = 25;
const POLYMARKET_CLOB_NOT_FOUND_NO_FILL_GRACE_MS = 10_000;
const POLYMARKET_UNCONFIRMED_TRADE_SYNC_LOOKBACK_MS = 30_000;
const EMBEDDED_APPROVAL_THRESHOLD = 1n << 255n;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const POLYMARKET_SELL_BALANCE_CHANGED_CODE = "POLYMARKET_SELL_BALANCE_CHANGED";
const POLYMARKET_CREDENTIALS_INVALID_CODE = "polymarket_credentials_invalid";

type PolymarketAccountPayload = Record<string, unknown>;
type PolymarketAccountCacheEntry = {
  value: PolymarketAccountPayload;
  expiresAt: number;
};
const polymarketAccountCache = new Map<string, PolymarketAccountCacheEntry>();
const polymarketAccountInflight = new Map<
  string,
  Promise<PolymarketAccountPayload>
>();

type PolymarketSide = "BUY" | "SELL";
type PolymarketOrderType = "GTC" | "GTD" | "FAK" | "FOK";
type PolymarketClobOrderType = "GTC" | "GTD" | "FOK";
type PolymarketUnconfirmedRow = {
  id: string;
  venue_order_id: string | null;
  token_id: string | null;
  side: string | null;
  wallet_address: string | null;
  price: number | string | null;
  size: number | string | null;
  order_type: string | null;
  order_hash: string | null;
  order_payload: unknown | null;
  order_payload_version: string | null;
  posted_at: Date | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEvmAddress(value: string | null | undefined): value is string {
  return typeof value === "string" && EVM_ADDRESS_RE.test(value.trim());
}

function buildPolymarketCancelSignerCandidates(inputs: {
  requestedWalletAddress: string | null | undefined;
  storedSignerAddress: string | null | undefined;
  storedWalletAddress: string | null | undefined;
}): string[] {
  return Array.from(
    new Map(
      [
        inputs.storedSignerAddress,
        inputs.requestedWalletAddress,
        inputs.storedWalletAddress,
      ]
        .filter(isEvmAddress)
        .map((address) => [address.toLowerCase(), address]),
    ).values(),
  );
}

function summarizePolymarketCancelPayload(inputs: {
  payload: unknown;
  orderId: string;
}): {
  canceled: string[];
  isCanceled: boolean;
  notCanceledReason: string | null;
} {
  const canceledRaw = isRecord(inputs.payload) ? inputs.payload.canceled : null;
  const canceled = Array.isArray(canceledRaw)
    ? canceledRaw.filter((value): value is string => typeof value === "string")
    : [];

  if (canceled.includes(inputs.orderId)) {
    return { canceled, isCanceled: true, notCanceledReason: null };
  }

  const notCanceled = isRecord(inputs.payload)
    ? inputs.payload.not_canceled
    : null;
  const notCanceledReason =
    isRecord(notCanceled) && typeof notCanceled[inputs.orderId] === "string"
      ? (notCanceled[inputs.orderId] as string)
      : canceled.length === 0
        ? `Order[${inputs.orderId}] was not canceled by Polymarket`
        : null;

  return { canceled, isCanceled: false, notCanceledReason };
}

function isPolymarketAlreadyClosedReason(
  reason: string | null | undefined,
): boolean {
  if (!reason) return false;
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("already canceled") ||
    normalized.includes("already cancelled") ||
    normalized.includes("already matched") ||
    normalized.includes("matched orders can't be canceled") ||
    normalized.includes("matched orders can't be cancelled") ||
    normalized.includes("matched orders cannot be canceled") ||
    normalized.includes("matched orders cannot be cancelled") ||
    normalized.includes("can't be found") ||
    normalized.includes("cannot be found") ||
    normalized.includes("not found")
  );
}

function resolvePolymarketClosedReasonHint(
  reason: string | null | undefined,
): PolymarketClosedReasonHint {
  if (!reason) return null;
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return null;
  const mentionsMatched =
    normalized.includes("matched orders can't be canceled") ||
    normalized.includes("matched orders can't be cancelled") ||
    normalized.includes("matched orders cannot be canceled") ||
    normalized.includes("matched orders cannot be cancelled") ||
    normalized.includes("already matched") ||
    normalized.includes(" or matched");
  const mentionsCancelled =
    normalized.includes("already canceled") ||
    normalized.includes("already cancelled");
  const mentionsNotFound =
    normalized.includes("can't be found") ||
    normalized.includes("cannot be found") ||
    normalized.includes("not found");
  if ((mentionsMatched && mentionsCancelled) || mentionsNotFound) {
    return null;
  }
  if (
    normalized.includes("matched orders can't be canceled") ||
    normalized.includes("matched orders can't be cancelled") ||
    normalized.includes("matched orders cannot be canceled") ||
    normalized.includes("matched orders cannot be cancelled") ||
    normalized.includes("already matched")
  ) {
    return "matched";
  }
  if (mentionsCancelled) {
    return "cancelled";
  }
  return null;
}

function isPolymarketOrderLookupNotFoundResponse(
  status: number | null | undefined,
  payload: unknown,
  orderId: string,
): boolean {
  if (status === 404) return true;
  if (status !== 400 && status !== 410) return false;
  const message = extractPolymarketUpstreamMessage(payload)?.toLowerCase();
  if (!message) return false;
  const hasNotFoundText =
    message.includes("not found") ||
    message.includes("can't be found") ||
    message.includes("cannot be found");
  if (!hasNotFoundText) return false;
  const normalizedOrderId = orderId.trim().toLowerCase();
  if (normalizedOrderId.length > 0 && message.includes(normalizedOrderId)) {
    return true;
  }
  return Boolean(
    message.match(
      /\b(order|hash)\b.{0,80}(not found|can't be found|cannot be found)/,
    ) ??
    message.match(
      /(not found|can't be found|cannot be found).{0,80}\b(order|hash)\b/,
    ),
  );
}

async function reconcilePolymarketTerminalOrder(inputs: {
  userId: string;
  venueOrderId: string;
  statusHint?: PolymarketClosedReasonHint;
  externalFilledSize?: number | null;
  externalFillPrice?: number | null;
  externalHasExecution?: boolean;
  skipOnchainExecutionCheck?: boolean;
  allowAmbiguousNoFillReconcile?: boolean;
  allowExternalExecutionEvidence?: boolean;
  terminalNoFillStatus?: PolymarketNoFillTerminalStatus | null;
}): Promise<{
  status: PolymarketTerminalReconcileStatus;
  tokenId: string | null;
  side: string | null;
  size: number | null;
  price: number | null;
  walletAddress: string | null;
} | null> {
  const { rows } = await pool.query<{
    id: string;
    status: string | null;
    token_id: string | null;
    side: string | null;
    wallet_address: string | null;
    price: number | string | null;
    size: number | string | null;
    order_hash: string | null;
    order_payload: unknown | null;
    order_payload_version: string | null;
    order_type: string | null;
    filled_size: number | string | null;
    average_fill_price: number | string | null;
    has_positive_fill_rows: boolean;
  }>(
    `
      select
        id,
        status,
        token_id,
        side,
        wallet_address,
        price,
        size,
        order_hash,
        order_payload,
        order_payload_version,
        order_type,
        filled_size,
        average_fill_price,
        exists (
          select 1
          from order_fills f
          where f.order_id = orders.id
            and coalesce(f.fill_size, 0) > 0
        ) as has_positive_fill_rows
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
      order by
        (order_hash is not null)::int desc,
        posted_at desc nulls last,
        id desc
      limit 1
    `,
    [inputs.userId, inputs.venueOrderId],
  );

  const row = rows[0];
  if (!row) return null;

  const orderHash = row.order_hash?.trim() ?? null;
  const makerAmount = readMakerAmountFromOrderPayload(row.order_payload);
  const filledSize = parsePositiveNumber(row.filled_size);
  const orderSize = parsePositiveNumber(row.size);
  const averageFillPrice = parsePositiveNumber(row.average_fill_price);
  const orderPrice = parsePositiveNumber(row.price);
  const orderType = row.order_type?.trim().toUpperCase() ?? "";
  const externalFilledSize = parsePositiveNumber(inputs.externalFilledSize);
  const externalFillPrice = parsePositiveNumber(inputs.externalFillPrice);
  const hasExternalExecution =
    inputs.externalHasExecution === true || externalFilledSize != null;
  const hasStoredFill = filledSize != null || row.has_positive_fill_rows;
  const storedFillKind =
    hasStoredFill &&
    (orderType === "FOK" ||
      (filledSize != null && orderSize != null && filledSize >= orderSize))
      ? "full"
      : hasStoredFill
        ? "partial"
        : null;
  let executionSummary: { hasExecution: boolean } | null = null;

  if (
    !inputs.skipOnchainExecutionCheck &&
    !hasStoredFill &&
    orderHash &&
    makerAmount != null &&
    makerAmount > 0n
  ) {
    const exchangeAddress = await resolvePolymarketOrderExchangeAddress({
      tokenId: row.token_id?.trim() || null,
    });
    executionSummary = await fetchPolymarketExecutionSummary({
      exchangeAddress,
      orderHash,
      makerAmount,
      orderPayloadVersion:
        row.order_payload_version ??
        resolvePolymarketOrderPayloadVersion(row.order_payload),
    });
  }

  const hasExecutionEvidence =
    hasStoredFill ||
    executionSummary?.hasExecution === true ||
    (inputs.allowExternalExecutionEvidence !== false && hasExternalExecution);
  const hasDefinitiveNoFillEvidence = inputs.statusHint === "cancelled";
  if (
    !hasExecutionEvidence &&
    !hasDefinitiveNoFillEvidence &&
    inputs.allowAmbiguousNoFillReconcile !== true
  ) {
    return null;
  }

  const nextStatus = resolvePolymarketTerminalReconcileStatus({
    statusHint: inputs.statusHint,
    hasStoredFill:
      storedFillKind === "full" || (!hasStoredFill && hasExecutionEvidence),
    storedFillKind,
    executionSummary,
    noFillStatus: inputs.terminalNoFillStatus ?? null,
  });
  if (!nextStatus) return null;
  const allowPartialTerminalClose =
    storedFillKind === "partial" &&
    (nextStatus === "cancelled" || nextStatus === "expired");
  if (
    nextStatus !== "matched" &&
    !allowPartialTerminalClose &&
    !canApplyPolymarketNoFillTerminalStatus({
      currentStatus: row.status,
      hasPositiveFillRows: row.has_positive_fill_rows,
    })
  ) {
    return null;
  }

  const updateResult = await pool.query(
    `
      update orders o
      set status = $2,
          cancelled_at = case when $2 = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end,
          filled_at = case when $2 = 'matched' then coalesce(filled_at, now()) else filled_at end,
          filled_size = case
            when $2 = 'matched' and $4::numeric is not null and coalesce(filled_size, 0) = 0
              then $4::numeric
            else filled_size
          end,
          average_fill_price = case
            when $2 = 'matched' and $5::numeric is not null and average_fill_price is null
              then $5::numeric
            else average_fill_price
          end,
          last_update = now()
      where o.user_id = $1
        and o.id = $6
        and o.venue = 'polymarket'
        and o.venue_order_id = $3
        and (
          $2 = 'matched'
          or (
            $7::boolean = true
            and lower(coalesce(o.status, '')) = 'partially_filled'
            and exists (
              select 1
              from order_fills f
              where f.order_id = o.id
                and coalesce(f.fill_size, 0) > 0
            )
          )
          or (
            lower(coalesce(o.status, '')) in ('pending', 'submitted', 'live', 'open', 'delayed', 'unconfirmed')
            and not exists (
              select 1
              from order_fills f
              where f.order_id = o.id
                and coalesce(f.fill_size, 0) > 0
            )
          )
        )
    `,
    [
      inputs.userId,
      nextStatus,
      inputs.venueOrderId,
      externalFilledSize,
      externalFillPrice,
      row.id,
      allowPartialTerminalClose,
    ],
  );

  if ((updateResult.rowCount ?? 0) === 0) return null;

  return {
    status: nextStatus,
    tokenId: row.token_id ?? null,
    side: row.side ?? null,
    size:
      nextStatus === "matched"
        ? (externalFilledSize ?? filledSize ?? orderSize)
        : orderSize,
    price:
      nextStatus === "matched"
        ? (externalFillPrice ?? averageFillPrice ?? orderPrice)
        : orderPrice,
    walletAddress: row.wallet_address ?? null,
  };
}

async function markPolymarketDelayedOrderUnconfirmed(inputs: {
  userId: string;
  venueOrderId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `
      update orders
      set status = $3,
          last_update = now()
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
        and lower(coalesce(status, '')) = 'delayed'
    `,
    [inputs.userId, inputs.venueOrderId, POLYMARKET_UNCONFIRMED_STATUS],
  );
  return (result.rowCount ?? 0) > 0;
}

async function hasPolymarketOrderExecutionEvidence(
  orderId: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ has_execution: boolean }>(
    `
      select
        (
          lower(coalesce(o.status, '')) in ('matched', 'filled', 'partially_filled')
          or coalesce(o.filled_size, 0) > 0
          or exists (
            select 1
            from order_fills f
            where f.order_id = o.id
              and coalesce(f.fill_size, 0) > 0
          )
        ) as has_execution
      from orders o
      where o.id = $1
      limit 1
    `,
    [orderId],
  );
  return rows[0]?.has_execution === true;
}

async function hasPolymarketVenueOrderExecutionEvidence(inputs: {
  userId: string;
  venueOrderId: string;
}): Promise<boolean> {
  const { rows } = await pool.query<{ has_execution: boolean }>(
    `
      select
        (
          lower(coalesce(o.status, '')) in ('matched', 'filled', 'partially_filled')
          or coalesce(o.filled_size, 0) > 0
          or exists (
            select 1
            from order_fills f
            where f.order_id = o.id
              and coalesce(f.fill_size, 0) > 0
          )
        ) as has_execution
      from orders o
      where o.user_id = $1
        and o.venue = 'polymarket'
        and o.venue_order_id = $2
      limit 1
    `,
    [inputs.userId, inputs.venueOrderId],
  );
  return rows[0]?.has_execution === true;
}

async function isPolymarketOrderNoFillGraceElapsed(inputs: {
  userId: string;
  venueOrderId: string;
}): Promise<boolean> {
  const { rows } = await pool.query<{ posted_at: Date | null }>(
    `
      select posted_at
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
      order by posted_at desc nulls last
      limit 1
    `,
    [inputs.userId, inputs.venueOrderId],
  );
  return isPolymarketNoFillGraceElapsed(rows[0]?.posted_at ?? null);
}

async function fetchPolymarketClobOrderExecutionEvidence(inputs: {
  creds: PolymarketL2Credentials;
  log: { warn: (payload: unknown, message?: string) => void };
  orderId: string;
  signer: string;
}): Promise<{
  checked: boolean;
  externalFillPrice: number | null;
  externalFilledSize: number | null;
  hasExecution: boolean;
  orderType: string | null;
  orderStatus: string | null;
  payload: unknown;
  statusHint: PolymarketClosedReasonHint;
}> {
  try {
    const upstream = await fetchPolymarketOrderByHash({
      baseUrl: env.polymarketClobBase,
      timeoutMs: 10_000,
      address: inputs.signer,
      creds: inputs.creds,
      orderHash: inputs.orderId,
    });

    if (!upstream.ok) {
      if (
        isPolymarketOrderLookupNotFoundResponse(
          upstream.status,
          upstream.payload,
          inputs.orderId,
        )
      ) {
        return {
          checked: true,
          externalFillPrice: null,
          externalFilledSize: null,
          hasExecution: false,
          orderType: null,
          orderStatus: "not_found",
          payload: upstream.payload,
          statusHint: null,
        };
      }

      inputs.log.warn(
        {
          orderId: inputs.orderId,
          signer: inputs.signer,
          status: upstream.status,
          payload: upstream.payload,
        },
        "Polymarket cancel reconcile order status lookup failed",
      );
      return {
        checked: false,
        externalFillPrice: null,
        externalFilledSize: null,
        hasExecution: false,
        orderType: null,
        orderStatus: null,
        payload: upstream.payload,
        statusHint: null,
      };
    }

    if (!upstream.order) {
      inputs.log.warn(
        {
          orderId: inputs.orderId,
          signer: inputs.signer,
          payload: upstream.payload,
        },
        "Polymarket order status lookup returned no order",
      );
      return {
        checked: true,
        externalFillPrice: null,
        externalFilledSize: null,
        hasExecution: false,
        orderType: null,
        orderStatus: "not_found",
        payload: upstream.payload,
        statusHint: null,
      };
    }

    const summary = summarizePolymarketClobOrderExecution({
      associateTrades: upstream.order?.associateTrades ?? null,
      sizeMatched: upstream.order?.sizeMatched ?? null,
      status: upstream.order?.status ?? null,
    });

    return {
      checked: true,
      externalFillPrice: summary.hasExecution
        ? parsePositiveNumber(upstream.order?.price)
        : null,
      externalFilledSize: summary.hasExecution
        ? parsePositiveNumber(upstream.order?.sizeMatched)
        : null,
      hasExecution: summary.hasExecution,
      orderType: upstream.order?.type ?? null,
      orderStatus: upstream.order?.status ?? null,
      payload: upstream.payload,
      statusHint: summary.statusHint,
    };
  } catch (error) {
    inputs.log.warn(
      { error, orderId: inputs.orderId, signer: inputs.signer },
      "Polymarket cancel reconcile order status lookup errored",
    );
    return {
      checked: false,
      externalFillPrice: null,
      externalFilledSize: null,
      hasExecution: false,
      orderType: null,
      orderStatus: null,
      payload: null,
      statusHint: null,
    };
  }
}

function isPolymarketClobOpenStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase() ?? "";
  return (
    normalized === "open" ||
    normalized === "live" ||
    normalized === "pending" ||
    normalized === "partially_filled"
  );
}

function isPolymarketClobCancelledStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase() ?? "";
  return (
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "cancelled_by_user" ||
    normalized === "canceled_by_user"
  );
}

function isPolymarketClobNoFillTerminalStatus(
  status: string | null | undefined,
) {
  return resolvePolymarketClobNoFillTerminalStatus(status) != null;
}

function resolvePolymarketClobNoFillTerminalStatus(
  status: string | null | undefined,
): PolymarketNoFillTerminalStatus | null {
  const normalized = status?.trim().toLowerCase() ?? "";
  if (normalized === "expired") return "expired";
  if (
    normalized === "not_found" ||
    normalized === "invalid" ||
    normalized === "unmatched"
  ) {
    return "unmatched";
  }
  return null;
}

function isPolymarketPendingLocalOrderStatus(
  status: string | null | undefined,
) {
  const normalized = status?.trim().toLowerCase() ?? "";
  return normalized === "delayed" || normalized === "unconfirmed";
}

async function markPolymarketOrderLiveFromClob(inputs: {
  userId: string;
  venueOrderId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `
      update orders
      set status = 'live',
          last_update = now()
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
        and lower(coalesce(status, '')) in ('delayed', 'unconfirmed')
        and cancelled_at is null
        and lower(coalesce(status, '')) in ('pending', 'submitted', 'live', 'open', 'delayed', 'unconfirmed')
    `,
    [inputs.userId, inputs.venueOrderId],
  );
  return (result.rowCount ?? 0) > 0;
}

function normalizePolymarketOrdersSyncOrderIds(
  values: string[] | undefined,
): string[] {
  if (!values?.length) return [];
  const ids = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    ids.set(trimmed.toLowerCase(), trimmed);
  }
  return Array.from(ids.values());
}

async function fetchStoredPolymarketOrderSigners(inputs: {
  userId: string;
  orderIds: string[];
}): Promise<string[]> {
  if (inputs.orderIds.length === 0) return [];
  const { rows } = await pool.query<{ signer_address: string | null }>(
    `
      select distinct signer_address
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = any($2::text[])
        and signer_address is not null
      order by signer_address
    `,
    [inputs.userId, inputs.orderIds],
  );
  return rows
    .map((row) => row.signer_address?.trim() ?? "")
    .filter((address) => EVM_ADDRESS_RE.test(address));
}

async function fetchStoredPolymarketOrderWallets(inputs: {
  userId: string;
  orderIds: string[];
}): Promise<string[]> {
  if (inputs.orderIds.length === 0) return [];
  const { rows } = await pool.query<{ wallet_address: string | null }>(
    `
      select distinct wallet_address
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = any($2::text[])
        and wallet_address is not null
      order by wallet_address
    `,
    [inputs.userId, inputs.orderIds],
  );
  return rows
    .map((row) => row.wallet_address?.trim() ?? "")
    .filter((address) => EVM_ADDRESS_RE.test(address));
}

async function fetchPolymarketCredentialSignersForTargetWallet(inputs: {
  userId: string;
  targetWalletAddress: string | null;
}): Promise<string[]> {
  const target = inputs.targetWalletAddress?.trim() ?? "";
  if (!EVM_ADDRESS_RE.test(target)) return [];
  const { rows } = await pool.query<{ wallet_address: string }>(
    `
      select wallet_address
      from user_venue_credentials
      where user_id = $1
        and venue = 'polymarket'
        and is_active = true
        and (
          lower(wallet_address) = lower($2)
          or lower(coalesce(funder_address, '')) = lower($2)
        )
      order by
        case when lower(wallet_address) = lower($2) then 0 else 1 end,
        last_used_at desc nulls last,
        updated_at desc
    `,
    [inputs.userId, target],
  );
  return rows
    .map((row) => row.wallet_address.trim())
    .filter((address) => EVM_ADDRESS_RE.test(address));
}

async function resolvePolymarketOrdersSyncSignerCandidates(inputs: {
  userId: string;
  authWalletAddress: string | null | undefined;
  orderIds: string[];
  targetWalletAddress: string | null;
}): Promise<{ authFallbackSigner: string | null; signers: string[] }> {
  const candidates = new Map<string, string>();
  let authFallbackSigner: string | null = null;
  const isTargeted =
    inputs.orderIds.length > 0 || Boolean(inputs.targetWalletAddress?.trim());
  const addCandidate = (value: string | null | undefined) => {
    const trimmed = value?.trim() ?? "";
    if (!EVM_ADDRESS_RE.test(trimmed)) return;
    candidates.set(trimmed.toLowerCase(), trimmed);
  };

  for (const signer of await fetchStoredPolymarketOrderSigners({
    userId: inputs.userId,
    orderIds: inputs.orderIds,
  })) {
    addCandidate(signer);
  }

  for (const signer of await fetchPolymarketCredentialSignersForTargetWallet({
    userId: inputs.userId,
    targetWalletAddress: inputs.targetWalletAddress,
  })) {
    addCandidate(signer);
  }

  for (const wallet of await fetchStoredPolymarketOrderWallets({
    userId: inputs.userId,
    orderIds: inputs.orderIds,
  })) {
    for (const signer of await fetchPolymarketCredentialSignersForTargetWallet({
      userId: inputs.userId,
      targetWalletAddress: wallet,
    })) {
      addCandidate(signer);
    }
  }

  if (!isTargeted) {
    addCandidate(inputs.authWalletAddress);
  } else if (inputs.orderIds.length > 0 && candidates.size === 0) {
    const trimmed = inputs.authWalletAddress?.trim() ?? "";
    if (EVM_ADDRESS_RE.test(trimmed)) {
      authFallbackSigner = trimmed;
    }
  }
  if (inputs.orderIds.length > 0 && authFallbackSigner == null && isTargeted) {
    const trimmed = inputs.authWalletAddress?.trim() ?? "";
    if (EVM_ADDRESS_RE.test(trimmed)) {
      authFallbackSigner = trimmed;
    }
  }
  return {
    authFallbackSigner,
    signers: Array.from(candidates.values()),
  };
}

function normalizePolymarketSyncWalletAliases(
  values: Array<string | null | undefined>,
): string[] {
  const aliases = new Map<string, string>();
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (!EVM_ADDRESS_RE.test(trimmed)) continue;
    aliases.set(trimmed.toLowerCase(), trimmed.toLowerCase());
  }
  return Array.from(aliases.values());
}

function resolvePolymarketSignerWalletAliases(inputs: {
  signer: string;
  funderAddress?: string | null;
  authWalletAddress?: string | null;
  targetWalletAddress?: string | null;
}): string[] {
  const signerAliases = normalizePolymarketSyncWalletAliases([
    inputs.signer,
    inputs.funderAddress,
  ]);
  const signerAliasSet = new Set(signerAliases);
  const optionalAliases = normalizePolymarketSyncWalletAliases([
    inputs.authWalletAddress,
    inputs.targetWalletAddress,
  ]).filter((alias) => signerAliasSet.has(alias));
  return normalizePolymarketSyncWalletAliases([
    ...signerAliases,
    ...optionalAliases,
  ]);
}

async function backfillPolymarketRequestedOrderSigner(inputs: {
  userId: string;
  signerAddress: string;
  requestedOrderIds: string[];
  walletAliases: string[];
}): Promise<number> {
  if (
    inputs.requestedOrderIds.length === 0 ||
    inputs.walletAliases.length === 0
  ) {
    return 0;
  }
  const result = await pool.query(
    `
      update orders
      set signer_address = $2
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = any($3::text[])
        and (signer_address is null or btrim(signer_address) = '')
        and lower(coalesce(wallet_address, '')) = any($4::text[])
    `,
    [
      inputs.userId,
      inputs.signerAddress,
      inputs.requestedOrderIds,
      inputs.walletAliases,
    ],
  );
  return result.rowCount ?? 0;
}

function isPolymarketNoFillGraceElapsed(postedAt: Date | null | undefined) {
  if (!postedAt) return false;
  return (
    Date.now() - postedAt.getTime() >=
    POLYMARKET_CLOB_NOT_FOUND_NO_FILL_GRACE_MS
  );
}

function resolvePolymarketUnconfirmedTradeSyncAfterSecOverride(
  rows: Array<{ posted_at: Date | null | undefined }>,
): number | null {
  let earliestPostedAtMs: number | null = null;
  for (const row of rows) {
    const postedAtMs = row.posted_at?.getTime();
    if (postedAtMs == null || !Number.isFinite(postedAtMs)) continue;
    earliestPostedAtMs =
      earliestPostedAtMs == null
        ? postedAtMs
        : Math.min(earliestPostedAtMs, postedAtMs);
  }
  if (earliestPostedAtMs == null) return null;
  return Math.max(
    0,
    Math.floor(
      (earliestPostedAtMs - POLYMARKET_UNCONFIRMED_TRADE_SYNC_LOOKBACK_MS) /
        1000,
    ),
  );
}

function resolvePolymarketOpenOrderTimestampMs(inputs: {
  createdAt?: string | null;
  postedAt?: Date | null;
}): number | null {
  const createdAt = parseNumberish(inputs.createdAt);
  if (createdAt != null && createdAt > 0) {
    return createdAt > 1_000_000_000_000 ? createdAt : createdAt * 1000;
  }
  const postedAtMs = inputs.postedAt?.getTime();
  return postedAtMs != null && Number.isFinite(postedAtMs) ? postedAtMs : null;
}

function resolvePolymarketTradeSyncAfterSecFromMs(
  timestampMs: number | null,
): number | null {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return null;
  return Math.max(
    0,
    Math.floor(
      (timestampMs - POLYMARKET_UNCONFIRMED_TRADE_SYNC_LOOKBACK_MS) / 1000,
    ),
  );
}

async function reconcileDelayedPolymarketOrdersAfterOpenSync(inputs: {
  creds: PolymarketL2Credentials;
  openVenueOrderIds: string[];
  requestedOrderIds: string[];
  signerAddress: string;
  userId: string;
  walletAliases: string[];
  log: { warn: (payload: unknown, message?: string) => void };
}) {
  const { rows } = await pool.query<{
    id: string;
    venue_order_id: string;
    order_type: string | null;
    posted_at: Date | null;
  }>(
    `
      select id, venue_order_id, order_type, posted_at
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and lower(coalesce(status, '')) = 'delayed'
        and venue_order_id is not null
        and (
          lower(coalesce(signer_address, '')) = any($2::text[])
          or lower(coalesce(wallet_address, '')) = any($2::text[])
        )
        and (
          venue_order_id = any($3::text[])
          or not (venue_order_id = any($4::text[]))
        )
      order by
        (venue_order_id = any($3::text[])) desc,
        posted_at desc nulls last,
        last_update desc nulls last
      limit $5
    `,
    [
      inputs.userId,
      inputs.walletAliases,
      inputs.requestedOrderIds,
      inputs.openVenueOrderIds,
      25 + inputs.requestedOrderIds.length,
    ],
  );

  let checked = 0;
  let matchedCount = 0;
  let cancelledCount = 0;
  let unmatchedCount = 0;
  let unconfirmedCount = 0;
  let skippedOpenCount = 0;
  let liveCount = 0;
  let expiredCount = 0;
  const tradeSyncAfterSecOverride =
    resolvePolymarketUnconfirmedTradeSyncAfterSecOverride(rows);
  let tradeSyncForFillPromise: Promise<void> | null = null;
  const syncFillsOnce = () => {
    tradeSyncForFillPromise ??= (async () => {
      await syncPolymarketTradesForSigner(
        pool,
        {
          userId: inputs.userId,
          signerAddress: inputs.signerAddress,
        },
        {
          afterSecOverride: tradeSyncAfterSecOverride,
        },
      );
    })();
    return tradeSyncForFillPromise;
  };

  for (const row of rows) {
    const orderId = row.venue_order_id?.trim();
    if (!orderId) continue;
    const evidence = await fetchPolymarketClobOrderExecutionEvidence({
      creds: inputs.creds,
      log: inputs.log,
      orderId,
      signer: inputs.signerAddress,
    });
    if (!evidence.checked) continue;
    checked += 1;
    if (evidence.hasExecution) {
      try {
        await syncFillsOnce();
      } catch (error) {
        inputs.log.warn(
          {
            error,
            userId: inputs.userId,
            signerAddress: inputs.signerAddress,
            orderId,
            afterSecOverride: tradeSyncAfterSecOverride,
          },
          "Polymarket delayed order fill sync failed",
        );
      }
      if (!(await hasPolymarketOrderExecutionEvidence(row.id))) {
        const marked = await markPolymarketDelayedOrderUnconfirmed({
          userId: inputs.userId,
          venueOrderId: orderId,
        });
        if (marked) unconfirmedCount += 1;
        continue;
      }
    }

    if (
      !evidence.hasExecution &&
      isPolymarketClobOpenStatus(evidence.orderStatus)
    ) {
      skippedOpenCount += 1;
      const markedLive = await markPolymarketOrderLiveFromClob({
        userId: inputs.userId,
        venueOrderId: orderId,
      });
      if (markedLive) liveCount += 1;
      continue;
    }

    const noFillTerminalStatus = evidence.hasExecution
      ? null
      : resolvePolymarketClobNoFillTerminalStatus(evidence.orderStatus);

    const reconciled = await reconcilePolymarketTerminalOrder({
      userId: inputs.userId,
      venueOrderId: orderId,
      statusHint: evidence.statusHint,
      externalFilledSize: evidence.externalFilledSize,
      externalFillPrice: evidence.externalFillPrice,
      externalHasExecution: evidence.hasExecution,
      skipOnchainExecutionCheck: true,
      allowAmbiguousNoFillReconcile:
        noFillTerminalStatus != null &&
        isPolymarketNoFillGraceElapsed(row.posted_at),
      allowExternalExecutionEvidence: false,
      terminalNoFillStatus: noFillTerminalStatus,
    });

    if (reconciled?.status === "matched") matchedCount += 1;
    if (reconciled?.status === "cancelled") cancelledCount += 1;
    if (reconciled?.status === "unmatched") unmatchedCount += 1;
    if (reconciled?.status === "expired") expiredCount += 1;
    if (!reconciled) {
      const marked = await markPolymarketDelayedOrderUnconfirmed({
        userId: inputs.userId,
        venueOrderId: orderId,
      });
      if (marked) unconfirmedCount += 1;
    }
    if (reconciled && reconciled.status !== "matched") {
      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: inputs.userId,
          venue: "polymarket",
          status: reconciled.status,
          side: reconciled.side,
          size: reconciled.size,
          price: reconciled.price,
          orderId,
          tokenId: reconciled.tokenId,
          walletAddress: reconciled.walletAddress ?? inputs.signerAddress,
        }),
        inputs.log,
      );
    }
  }

  return {
    checked,
    matchedCount,
    cancelledCount,
    unmatchedCount,
    expiredCount,
    unconfirmedCount,
    skippedOpenCount,
    liveCount,
  };
}

function normalizeAddress(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function buildPolymarketAccountCacheKey(inputs: {
  userId: string;
  signer: string;
  funder: string;
  credentialsKey: string;
  funderUpdatedAt: string | null;
}): string {
  return [
    inputs.userId,
    normalizeAddress(inputs.signer),
    normalizeAddress(inputs.funder),
    inputs.credentialsKey,
    inputs.funderUpdatedAt ?? "none",
  ].join("|");
}

function readPolymarketAccountCache(
  key: string,
): PolymarketAccountPayload | null {
  if (env.polymarketAccountCacheTtlMs <= 0) return null;
  const entry = polymarketAccountCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    polymarketAccountCache.delete(key);
    return null;
  }
  return entry.value;
}

function writePolymarketAccountCache(
  key: string,
  value: PolymarketAccountPayload,
) {
  if (env.polymarketAccountCacheTtlMs <= 0) return;
  polymarketAccountCache.set(key, {
    value,
    expiresAt: Date.now() + env.polymarketAccountCacheTtlMs,
  });
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
}

function approvalSatisfiesEmbeddedAutomation(
  value: bigint | null | undefined,
): boolean {
  return Boolean(value != null && value >= EMBEDDED_APPROVAL_THRESHOLD);
}

function normalizeEvmAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

async function resolveEmbeddedEnsureReadyState(inputs: {
  user: User;
  signer: string;
  requestedFunder?: string | null;
}) {
  const context = await resolveEmbeddedPolymarketWalletContext({
    user: inputs.user,
    signer: inputs.signer,
  });
  let credsInfo = await AuthService.getVenueCredentialsInfo(
    inputs.user.id,
    "polymarket",
    inputs.signer,
  );
  const storedFunder = credsInfo?.funderAddress ?? null;
  const funderDerivation = await derivePolymarketFunders({
    signer: inputs.signer,
    storedFunder: inputs.requestedFunder ?? storedFunder,
    includeMagicProxy: true,
    bypassCodeCache: true,
  });
  const signerNormalized = normalizeEvmAddress(inputs.signer);
  const findCandidate = (address: string | null | undefined) => {
    const normalized = normalizeEvmAddress(address);
    if (!normalized) return null;
    return (
      funderDerivation.candidates.find(
        (candidate) => normalizeEvmAddress(candidate.funder) === normalized,
      ) ?? null
    );
  };
  const requestedCandidate = findCandidate(inputs.requestedFunder ?? null);
  const storedCandidate =
    requestedCandidate &&
    storedFunder &&
    normalizeEvmAddress(storedFunder) ===
      normalizeEvmAddress(requestedCandidate.funder)
      ? requestedCandidate
      : findCandidate(storedFunder);
  const desiredDistinctCandidate =
    (requestedCandidate &&
    normalizeEvmAddress(requestedCandidate.funder) !== signerNormalized
      ? requestedCandidate
      : null) ??
    (storedCandidate &&
    normalizeEvmAddress(storedCandidate.funder) !== signerNormalized
      ? storedCandidate
      : null);
  const canPreserveDistinctCandidate = Boolean(
    desiredDistinctCandidate?.deployed &&
    (desiredDistinctCandidate.signatureType === 2 ||
      desiredDistinctCandidate.signatureType === 3 ||
      desiredDistinctCandidate.contractKind === "SAFE_LIKE"),
  );
  const effectiveDistinctFunder = canPreserveDistinctCandidate
    ? (desiredDistinctCandidate?.funder ?? null)
    : null;
  const effectiveFunder = effectiveDistinctFunder ?? inputs.signer;
  const shouldClearStoredFunder = Boolean(
    storedFunder &&
    normalizeEvmAddress(storedFunder) !== signerNormalized &&
    !effectiveDistinctFunder,
  );
  const shouldUpdateStoredFunder = Boolean(
    credsInfo &&
    effectiveDistinctFunder &&
    normalizeEvmAddress(credsInfo?.funderAddress ?? null) !==
      normalizeEvmAddress(effectiveDistinctFunder),
  );

  if (shouldClearStoredFunder) {
    await AuthService.updateVenueFunderAddress(
      inputs.user.id,
      inputs.signer,
      "polymarket",
      null,
    );
    credsInfo = await AuthService.getVenueCredentialsInfo(
      inputs.user.id,
      "polymarket",
      inputs.signer,
    );
  } else if (shouldUpdateStoredFunder && effectiveDistinctFunder) {
    await AuthService.updateVenueFunderAddress(
      inputs.user.id,
      inputs.signer,
      "polymarket",
      effectiveDistinctFunder,
    );
    credsInfo = await AuthService.getVenueCredentialsInfo(
      inputs.user.id,
      "polymarket",
      inputs.signer,
    );
  }

  const snapshot = await fetchPolymarketOnchainSnapshot({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    signer: inputs.signer,
    funder: effectiveFunder,
    includeFeeCollectorNonce: false,
    negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress,
    ctfCollateralAdapterAddress: env.polymarketCtfCollateralAdapterAddress,
    negRiskCollateralAdapterAddress:
      env.polymarketNegRiskCollateralAdapterAddress,
    feeCollectorAddress: null,
  });

  const approvalRequests = prepareEmbeddedPolymarketSignerApprovalRequests({
    context,
    funder: effectiveFunder,
    currentApprovals: {
      exchangeApproved: snapshot.okExchange,
      negRiskExchangeApproved: snapshot.okNegRisk,
      negRiskAdapterApproved: env.polymarketNegRiskAdapterAddress
        ? (snapshot.okNegRiskAdapter ?? false)
        : true,
      ctfCollateralAdapterApproved: env.polymarketCtfCollateralAdapterAddress
        ? (snapshot.okCtfCollateralAdapter ?? false)
        : true,
      negRiskCollateralAdapterApproved:
        env.polymarketNegRiskCollateralAdapterAddress
          ? (snapshot.okNegRiskCollateralAdapter ?? false)
          : true,
      feeCollectorApproved: true,
      exchangeAllowanceOk: approvalSatisfiesEmbeddedAutomation(
        snapshot.allowanceExchange,
      ),
      negRiskExchangeAllowanceOk: approvalSatisfiesEmbeddedAutomation(
        snapshot.allowanceNegRisk,
      ),
      negRiskAdapterAllowanceOk: env.polymarketNegRiskAdapterAddress
        ? approvalSatisfiesEmbeddedAutomation(
            snapshot.allowanceNegRiskAdapter ?? null,
          )
        : true,
      feeCollectorAllowanceOk: true,
    },
  });

  return {
    context,
    credsInfo,
    effectiveFunder,
    effectiveDistinctFunder,
    approvalRequests,
    clearedStoredFunder: shouldClearStoredFunder,
  };
}

function buildEmbeddedEnsureReadyResponse(args: {
  signer: string;
  effectiveFunder: string;
  effectiveDistinctFunder: string | null;
  clearedStoredFunder: boolean;
  connected?: boolean;
  approvalsApplied?: boolean;
  approvalExecution?: {
    signer: string;
    funder: string;
    funderKind: "signer" | "safe" | "magic" | "deposit_wallet";
    transactionHashes: string[];
  } | null;
}) {
  return {
    ok: true,
    signer: args.signer,
    funder: args.effectiveFunder,
    funderSource: args.effectiveDistinctFunder ? "stored" : "signer",
    connected: args.connected ?? false,
    clearedStoredFunder: args.clearedStoredFunder,
    approvalsApplied: args.approvalsApplied ?? false,
    approvalExecution: args.approvalExecution ?? null,
  };
}

function extractPolymarketUpstreamMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length ? trimmed : null;
  }
  if (!isRecord(payload)) return null;

  const direct = [
    payload.error,
    payload.message,
    payload.msg,
    payload.detail,
    payload.reason,
  ];
  for (const value of direct) {
    if (typeof value === "string" && value.trim().length) {
      return value.trim();
    }
  }

  const nestedError = payload.error;
  if (isRecord(nestedError)) {
    const nested = [
      nestedError.message,
      nestedError.error,
      nestedError.msg,
      nestedError.detail,
      nestedError.reason,
    ];
    for (const value of nested) {
      if (typeof value === "string" && value.trim().length) {
        return value.trim();
      }
    }
  }

  const errors = payload.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "string" && entry.trim().length) {
        return entry.trim();
      }
      if (isRecord(entry)) {
        const nested = [
          entry.message,
          entry.error,
          entry.msg,
          entry.detail,
          entry.reason,
        ];
        for (const value of nested) {
          if (typeof value === "string" && value.trim().length) {
            return value.trim();
          }
        }
      }
    }
  }

  return null;
}

function isPolymarketInvalidApiKeyResponse(inputs: {
  status: number;
  payload: unknown;
}): boolean {
  if (inputs.status !== 401) return false;
  const message = extractPolymarketUpstreamMessage(inputs.payload);
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unauthorized/invalid api key") ||
    normalized.includes("invalid api key")
  );
}

async function invalidatePolymarketCredentialsForInvalidApiKey(inputs: {
  userId: string;
  signer: string;
  endpoint: string;
  upstream: { status: number; payload: unknown };
  log: FastifyBaseLogger;
}): Promise<boolean> {
  if (!isPolymarketInvalidApiKeyResponse(inputs.upstream)) return false;

  const upstreamMessage = extractPolymarketUpstreamMessage(
    inputs.upstream.payload,
  );
  let deactivated = 0;
  try {
    deactivated = await AuthService.deactivateVenueCredentials(
      inputs.userId,
      "polymarket",
      inputs.signer,
    );
  } catch (error) {
    inputs.log.error(
      {
        error,
        userId: inputs.userId,
        signer: inputs.signer,
        endpoint: inputs.endpoint,
        upstreamStatus: inputs.upstream.status,
        upstreamMessage,
      },
      "Failed to deactivate stale Polymarket credentials",
    );
  }

  inputs.log.warn(
    {
      userId: inputs.userId,
      signer: inputs.signer,
      endpoint: inputs.endpoint,
      upstreamStatus: inputs.upstream.status,
      upstreamMessage,
      deactivated,
    },
    "Polymarket credentials invalidated after CLOB auth failure",
  );

  return true;
}

function sendPolymarketCredentialsInvalidResponse(
  reply: FastifyReply,
  upstream: { status: number; payload: unknown },
) {
  reply.code(401);
  return reply.send({
    error: "Reconnect Polymarket to refresh trading credentials.",
    code: POLYMARKET_CREDENTIALS_INVALID_CODE,
    reconnectRequired: true,
    status: upstream.status,
    payload: upstream.payload,
  });
}

function isPolymarketDepositWalletRequiredMessage(
  message: string | null,
): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return (
    normalized.includes("maker address not allowed") &&
    normalized.includes("deposit wallet")
  );
}

function extractPolymarketOrderStatus(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const direct = payload.status;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  if (isRecord(payload.order)) {
    const nested = payload.order.status;
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }
  const result = payload.result;
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }
  return null;
}

function normalizeOrderSide(value: unknown): PolymarketSide | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    if (upper === "BUY" || upper === "SELL") return upper;
    if (upper === "0") return "BUY";
    if (upper === "1") return "SELL";
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return "BUY";
    if (value === 1) return "SELL";
  }

  return null;
}

function normalizeNumberishString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return null;
}

function parseInteger(value: unknown): bigint | null {
  const raw = normalizeNumberishString(value);
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return BigInt(Math.trunc(parsed));
}

function normalizeSignatureType(value: unknown): number | null {
  const raw = normalizeNumberishString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

type PolymarketOrderWalletValidation =
  | { ok: true; orderSigner: string; maker: string; depositWallet: boolean }
  | { ok: false; error: string };

function validatePolymarketOrderWallets(inputs: {
  order: Record<string, unknown>;
  selectedSigner: string;
  configuredFunder: string;
}): PolymarketOrderWalletValidation {
  const orderSigner =
    typeof inputs.order.signer === "string" ? inputs.order.signer : "";
  const maker =
    typeof inputs.order.maker === "string" ? inputs.order.maker : "";
  const signatureType = normalizeSignatureType(inputs.order.signatureType);
  const depositWallet = signatureType === 3;
  const legacySafe = signatureType === 2;
  const selectedSigner = normalizeAddress(inputs.selectedSigner);
  const configuredFunder = normalizeAddress(inputs.configuredFunder);
  const normalizedOrderSigner = normalizeAddress(orderSigner);
  const normalizedMaker = normalizeAddress(maker);

  if (!normalizedOrderSigner || !normalizedMaker) {
    return { ok: false, error: "Order signer and maker are required" };
  }

  if (depositWallet) {
    if (!configuredFunder || configuredFunder === selectedSigner) {
      return {
        ok: false,
        error:
          "Polymarket deposit-wallet orders require a configured deposit wallet funder",
      };
    }
    if (
      normalizedOrderSigner !== configuredFunder ||
      normalizedMaker !== configuredFunder
    ) {
      return {
        ok: false,
        error:
          "Deposit-wallet orders must use the configured Polymarket funder as maker and signer",
      };
    }
    return { ok: true, orderSigner, maker, depositWallet };
  }

  if (!legacySafe) {
    return {
      ok: false,
      error:
        "Polymarket orders require a deposit wallet or deployed legacy Safe funder",
    };
  }

  if (!configuredFunder || configuredFunder === selectedSigner) {
    return {
      ok: false,
      error: "Polymarket legacy Safe orders require a configured Safe funder",
    };
  }

  if (normalizedOrderSigner !== selectedSigner) {
    return { ok: false, error: "Order signer must match the selected wallet" };
  }
  if (normalizedMaker !== configuredFunder) {
    return {
      ok: false,
      error:
        "Order maker does not match the configured Polymarket funder/vault",
    };
  }

  return { ok: true, orderSigner, maker, depositWallet };
}

function normalizeOrderType(value: unknown): PolymarketOrderType | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  if (
    upper === "GTC" ||
    upper === "GTD" ||
    upper === "FAK" ||
    upper === "FOK"
  ) {
    return upper;
  }
  return null;
}

function normalizeOrderTypeForClob(value: unknown): PolymarketClobOrderType {
  const normalized = normalizeOrderType(value);
  if (normalized === "FAK") return "FOK";
  if (normalized === "GTC" || normalized === "GTD" || normalized === "FOK") {
    return normalized;
  }
  return "GTC";
}

function parseNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isImmediateExecutionStatus(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  // FOK is fill-or-kill: partial execution status should not be treated as
  // canonical immediate fill for optimistic position writes.
  return normalized === "matched" || normalized === "filled";
}

function readRecordField(
  record: Record<string, unknown> | null,
  keys: string[],
): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function parsePositiveNumber(value: unknown): number | null {
  const numeric = parseNumberish(value);
  if (numeric == null || !Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function parsePositiveMicroToUi(value: unknown): number | null {
  const numeric = parsePositiveNumber(value);
  if (numeric == null) return null;
  const ui = numeric / 1_000_000;
  if (!Number.isFinite(ui) || ui <= 0) return null;
  return ui;
}

function extractPolymarketImmediateFill(inputs: {
  payload: unknown;
  side: PolymarketSide;
  status: string;
  fallbackPrice: number | null;
  fallbackSize: number | null;
}): { shares: number; notionalUsd: number; fromPayload: boolean } | null {
  const payloadRecord = isRecord(inputs.payload) ? inputs.payload : null;
  const orderRecord = payloadRecord
    ? isRecord(payloadRecord.order)
      ? payloadRecord.order
      : payloadRecord
    : null;

  const statusNormalized = inputs.status.trim().toLowerCase();
  const side =
    normalizeOrderSide(
      readRecordField(orderRecord, ["side", "orderSide", "order_side"]),
    ) ?? inputs.side;

  const payloadShares =
    parsePositiveNumber(
      readRecordField(orderRecord, [
        "filled_size",
        "filledSize",
        "size_matched",
        "sizeMatched",
        "matched_amount",
        "matchedAmount",
      ]),
    ) ??
    parsePositiveMicroToUi(
      readRecordField(
        orderRecord,
        side === "BUY"
          ? ["filled_taker_amount", "filledTakerAmount"]
          : ["filled_maker_amount", "filledMakerAmount"],
      ),
    );

  const payloadPrice = parsePositiveNumber(
    readRecordField(orderRecord, [
      "average_fill_price",
      "averageFillPrice",
      "fill_price",
      "fillPrice",
      "price",
    ]),
  );

  const payloadNotional =
    parsePositiveMicroToUi(
      readRecordField(
        orderRecord,
        side === "BUY"
          ? ["filled_maker_amount", "filledMakerAmount"]
          : ["filled_taker_amount", "filledTakerAmount"],
      ),
    ) ??
    (payloadShares != null && payloadPrice != null
      ? payloadShares * payloadPrice
      : null);

  if (
    payloadShares != null &&
    payloadNotional != null &&
    Number.isFinite(payloadShares) &&
    payloadShares > 0 &&
    Number.isFinite(payloadNotional) &&
    payloadNotional > 0
  ) {
    return {
      shares: payloadShares,
      notionalUsd: payloadNotional,
      fromPayload: true,
    };
  }

  // Never fallback to full requested size for partial fills.
  if (statusNormalized === "partially_filled") return null;

  if (
    inputs.fallbackPrice != null &&
    inputs.fallbackSize != null &&
    Number.isFinite(inputs.fallbackPrice) &&
    Number.isFinite(inputs.fallbackSize) &&
    inputs.fallbackPrice > 0 &&
    inputs.fallbackSize > 0
  ) {
    return {
      shares: inputs.fallbackSize,
      notionalUsd: inputs.fallbackPrice * inputs.fallbackSize,
      fromPayload: false,
    };
  }

  return null;
}

const POLYMARKET_SERVICE_NOT_READY_STATUS = 425;
const POLYMARKET_ORDER_RETRY_DELAYS_MS = [250, 750, 1500] as const;

function isPolymarketServiceNotReadyResponse(inputs: {
  status: number;
  payload: unknown;
}): boolean {
  if (inputs.status !== POLYMARKET_SERVICE_NOT_READY_STATUS) return false;
  const message = extractPolymarketUpstreamMessage(inputs.payload);
  if (!message) return true;
  return message.toLowerCase().includes("service not ready");
}

function exchangeAddressForNegRisk(negRisk: boolean | null): string | null {
  if (negRisk == null) return null;
  return negRisk
    ? env.polymarketNegRiskExchangeAddress
    : env.polymarketExchangeAddress;
}

function parseBigIntValue(
  value: string | number | bigint | null | undefined,
): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

type PolymarketMaxSpendUnavailableReason =
  | "missing_credentials"
  | "unsupported_wallet"
  | "unsupported_order_type"
  | "quote_unavailable"
  | "balance_unavailable"
  | "no_executable_funds"
  | "no_liquidity"
  | "below_min_order";

function polymarketMaxSpendUnavailable(
  reason: PolymarketMaxSpendUnavailableReason,
  message: string,
) {
  return { ok: false, reason, message };
}

function resolvePolymarketFunderExecutionKindForMaxSpend(
  candidate: PolymarketFunderCandidate | null | undefined,
): PolymarketFunderExecutionKind {
  if (!candidate) return null;
  if (candidate.source === "magic_proxy") return "magic";
  if (candidate.source === "safe_proxy") return "safe";
  if (candidate.source === "stored") {
    if (candidate.signatureType === 3) return "deposit_wallet";
    if (
      candidate.signatureType === 2 &&
      candidate.contractKind === "SAFE_LIKE"
    ) {
      return "safe";
    }
    if (candidate.signatureType === 1) return "magic";
  }
  return null;
}

function findPolymarketFunderCandidateByAddress(
  candidates: PolymarketFunderCandidate[],
  address: string,
): PolymarketFunderCandidate | null {
  const normalized = normalizeEvmAddress(address);
  if (!normalized) return null;
  return (
    candidates.find(
      (candidate) => normalizeEvmAddress(candidate.funder) === normalized,
    ) ?? null
  );
}

class PolymarketMaxSpendLiveOrderLocksError extends Error {
  constructor(readonly upstream: { status: number; payload: unknown }) {
    super("Failed to fetch live Polymarket open-order locks");
    this.name = "PolymarketMaxSpendLiveOrderLocksError";
  }
}

async function fetchPolymarketMaxSpendLiveOpenOrderLocks(inputs: {
  signer: string;
  creds: PolymarketL2Credentials;
  wallets: string[];
}): Promise<Map<string, bigint>> {
  const upstream = await polymarketL2Request({
    baseUrl: env.polymarketClobBase,
    timeoutMs: 10_000,
    address: inputs.signer,
    creds: inputs.creds,
    method: "GET",
    requestPath: "/data/orders",
  });

  if (!upstream.ok) {
    throw new PolymarketMaxSpendLiveOrderLocksError(upstream);
  }

  return computePolymarketClobOpenOrderLocks({
    orders: extractOrderArray(upstream.payload),
    wallets: inputs.wallets,
  });
}

function maxRaw(a: bigint | null | undefined, b: bigint | null | undefined) {
  const left = a != null && a > 0n ? a : 0n;
  const right = b != null && b > 0n ? b : 0n;
  return left > right ? left : right;
}

async function resolvePolymarketMaxSpendFunds(inputs: {
  userId: string;
  signer: string;
  funder: string;
  funderExecutionKind: PolymarketFunderExecutionKind;
  creds: PolymarketL2Credentials;
}): Promise<{
  executableFundsRaw: bigint;
  funderPusdRaw: bigint;
  funderPusdAvailableRaw: bigint;
  funderLockedRaw: bigint;
  signerLockedRaw: bigint;
  signerPusdTopUpRaw: bigint;
  signerUsdceTopUpRaw: bigint;
  usesSignerTopUp: boolean;
}> {
  const signerNormalized = normalizeEvmAddress(inputs.signer);
  const funderNormalized = normalizeEvmAddress(inputs.funder);
  if (!signerNormalized || !funderNormalized) {
    throw new Error("Invalid Polymarket signer or funder address.");
  }

  const includeSignerUsdc =
    inputs.funderExecutionKind === "deposit_wallet" &&
    signerNormalized !== funderNormalized;
  const lockWallets = includeSignerUsdc
    ? [funderNormalized, signerNormalized]
    : [funderNormalized];
  const negRiskAdapterAddress =
    env.polymarketNegRiskAdapterAddress?.trim() || "";
  const [snapshot, localCollateralLocks, liveCollateralLocks] =
    await Promise.all([
      fetchPolymarketOnchainSnapshot({
        rpcUrl: env.polygonRpcUrl,
        timeoutMs: env.polygonRpcTimeoutMs,
        signer: signerNormalized,
        funder: funderNormalized,
        includeSignerUsdc,
        includeFeeCollectorNonce: false,
        negRiskAdapterAddress,
        feeCollectorAddress: null,
      }),
      fetchOpenOrderCollateralLocks(pool, {
        userId: inputs.userId,
        polymarketWallets: lockWallets,
        limitlessWallets: [],
      }),
      fetchPolymarketMaxSpendLiveOpenOrderLocks({
        signer: signerNormalized,
        creds: inputs.creds,
        wallets: lockWallets,
      }),
    ]);
  const funderLockKey = funderNormalized.toLowerCase();
  const signerLockKey = signerNormalized.toLowerCase();
  const funderLockedRaw = maxRaw(
    localCollateralLocks.polymarket.get(funderLockKey),
    liveCollateralLocks.get(funderLockKey),
  );
  const signerLockedRaw = maxRaw(
    localCollateralLocks.polymarket.get(signerLockKey),
    liveCollateralLocks.get(signerLockKey),
  );

  return computePolymarketExecutableFunds({
    signer: signerNormalized,
    funder: funderNormalized,
    funderExecutionKind: inputs.funderExecutionKind,
    funderPusdRaw: snapshot.pusdBalance,
    funderLockedRaw,
    signerPusdRaw: snapshot.signerPusdBalance,
    signerLockedRaw,
    signerUsdceRaw: snapshot.signerUsdceBalance,
  });
}

function readMakerAmountFromOrderPayload(orderPayload: unknown): bigint | null {
  if (!isRecord(orderPayload)) return null;
  const makerAmount = (orderPayload as Record<string, unknown>).makerAmount;
  if (
    makerAmount == null ||
    typeof makerAmount === "string" ||
    typeof makerAmount === "number" ||
    typeof makerAmount === "bigint"
  ) {
    return parseBigIntValue(makerAmount);
  }
  return null;
}

function isPolymarketOrderPayloadV2(orderPayload: unknown): boolean {
  return (
    isRecord(orderPayload) &&
    "timestamp" in orderPayload &&
    "metadata" in orderPayload &&
    "builder" in orderPayload
  );
}

function resolvePolymarketOrderPayloadVersion(orderPayload: unknown): string {
  return isPolymarketOrderPayloadV2(orderPayload)
    ? "polymarket_clob_v2"
    : "polymarket_clob_v1";
}

async function resolvePolymarketOrderExchangeAddress(inputs: {
  tokenId?: string | null;
  explicitExchangeAddress?: string | null;
}): Promise<string> {
  const explicit = inputs.explicitExchangeAddress?.trim();
  if (explicit) return explicit;

  const tokenId = inputs.tokenId?.trim();
  if (tokenId) {
    const marketInfo = await fetchPolymarketMarketInfo(pool, { tokenId });
    const marketExchangeAddress = exchangeAddressForNegRisk(
      marketInfo?.neg_risk ?? null,
    );
    if (marketExchangeAddress) return marketExchangeAddress;
  }

  return env.polymarketExchangeAddress;
}

async function fetchPolymarketExecutionSummary(inputs: {
  exchangeAddress: string;
  orderHash: string;
  makerAmount: bigint;
  orderPayloadVersion?: string | null;
}) {
  if (inputs.orderPayloadVersion === "polymarket_clob_v2") {
    const onchainStatus = await fetchPolymarketOrderStatusV2({
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      exchangeAddress: inputs.exchangeAddress,
      orderHash: inputs.orderHash,
    });
    return summarizePolymarketV2OnchainOrderExecution({
      makerAmount: inputs.makerAmount,
      filled: onchainStatus.filled,
      remaining: onchainStatus.remaining,
    });
  }

  const onchainStatus = await fetchPolymarketOrderStatus({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    exchangeAddress: inputs.exchangeAddress,
    orderHash: inputs.orderHash,
  });
  return summarizePolymarketOnchainOrderExecution({
    makerAmount: inputs.makerAmount,
    remaining: onchainStatus.remaining,
    isFilledOrCancelled: onchainStatus.isFilledOrCancelled,
  });
}

async function waitForPolymarketExecutionConfirmation(inputs: {
  exchangeAddress: string;
  orderHash: string;
  makerAmount: bigint;
  orderPayloadVersion?: string | null;
}) {
  for (
    let attempt = 0;
    attempt < POLYMARKET_SUBMIT_SETTLEMENT_ATTEMPTS;
    attempt += 1
  ) {
    const summary = await fetchPolymarketExecutionSummary(inputs);
    if (summary.hasExecution) return summary;
    if (attempt < POLYMARKET_SUBMIT_SETTLEMENT_ATTEMPTS - 1) {
      await sleep(POLYMARKET_SUBMIT_SETTLEMENT_DELAY_MS);
    }
  }
  return null;
}

async function reconcileUnconfirmedOrders(inputs: {
  creds: PolymarketL2Credentials;
  userId: string;
  requestedOrderIds: string[];
  signerAddress: string;
  walletAliases: string[];
  log: { warn: (payload: unknown, message?: string) => void };
}) {
  const { rows } = await pool.query<PolymarketUnconfirmedRow>(
    `
      select
        id,
        venue_order_id,
        token_id,
        side,
        wallet_address,
        price,
        size,
        order_type,
        order_hash,
        order_payload,
        order_payload_version,
        posted_at
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and status = $3
        and (
          order_hash is not null
          or venue_order_id is not null
        )
        and (
          lower(coalesce(signer_address, '')) = any($2::text[])
          or lower(coalesce(wallet_address, '')) = any($2::text[])
        )
      order by
        (venue_order_id = any($4::text[])) desc,
        posted_at desc nulls last
      limit $5
    `,
    [
      inputs.userId,
      inputs.walletAliases,
      POLYMARKET_UNCONFIRMED_STATUS,
      inputs.requestedOrderIds,
      POLYMARKET_UNCONFIRMED_LIMIT + inputs.requestedOrderIds.length,
    ],
  );

  if (!rows.length) {
    return {
      checked: 0,
      confirmedCount: 0,
      cancelledCount: 0,
      unmatchedCount: 0,
      expiredCount: 0,
    };
  }

  let confirmedCount = 0;
  let cancelledCount = 0;
  let unmatchedCount = 0;
  let expiredCount = 0;
  const exchangeAddressByTokenId = new Map<string, string>();
  const tradeSyncAfterSecOverride =
    resolvePolymarketUnconfirmedTradeSyncAfterSecOverride(rows);
  let tradeSyncForFillPromise: Promise<void> | null = null;
  const syncUnconfirmedFillsOnce = () => {
    tradeSyncForFillPromise ??= (async () => {
      await syncPolymarketTradesForSigner(
        pool,
        {
          userId: inputs.userId,
          signerAddress: inputs.signerAddress,
        },
        {
          afterSecOverride: tradeSyncAfterSecOverride,
        },
      );
    })();
    return tradeSyncForFillPromise;
  };

  for (const row of rows) {
    const orderHash = row.order_hash?.trim();
    const makerAmount = readMakerAmountFromOrderPayload(row.order_payload);

    try {
      if (orderHash && makerAmount != null && makerAmount > 0n) {
        const tokenId = row.token_id?.trim() || null;
        let exchangeAddress =
          tokenId != null
            ? (exchangeAddressByTokenId.get(tokenId) ?? null)
            : null;
        if (!exchangeAddress) {
          exchangeAddress = await resolvePolymarketOrderExchangeAddress({
            tokenId,
          });
          if (tokenId) {
            exchangeAddressByTokenId.set(tokenId, exchangeAddress);
          }
        }

        const summary = await fetchPolymarketExecutionSummary({
          exchangeAddress,
          orderHash,
          makerAmount,
          orderPayloadVersion:
            row.order_payload_version ??
            resolvePolymarketOrderPayloadVersion(row.order_payload),
        });
        const decision = resolvePolymarketUnconfirmedReconcileDecision(summary);
        if (decision === "sync_for_fill") {
          try {
            await syncUnconfirmedFillsOnce();
          } catch (error) {
            inputs.log.warn(
              {
                error,
                userId: inputs.userId,
                signerAddress: inputs.signerAddress,
                orderId: row.id,
                venueOrderId: row.venue_order_id,
                afterSecOverride: tradeSyncAfterSecOverride,
              },
              "Polymarket unconfirmed order fill sync failed",
            );
          }
          if (await hasPolymarketOrderExecutionEvidence(row.id)) {
            confirmedCount += 1;
          }
          continue;
        }
        if (!isPolymarketUnconfirmedStatus(decision)) {
          const updateResult = await pool.query(
            `
              update orders o
              set status = $2,
                  filled_at = null,
                  last_update = now()
              where o.id = $1
                and o.status = $3
                and lower(coalesce(o.status, '')) in ('pending', 'submitted', 'live', 'open', 'delayed', 'unconfirmed')
                and not exists (
                  select 1
                  from order_fills f
                  where f.order_id = o.id
                    and coalesce(f.fill_size, 0) > 0
                )
            `,
            [row.id, decision, POLYMARKET_UNCONFIRMED_STATUS],
          );
          if ((updateResult.rowCount ?? 0) === 0) continue;
          if (decision === "unmatched") {
            unmatchedCount += 1;
            void createNotificationSafe(
              pool,
              buildOrderNotification({
                userId: inputs.userId,
                venue: "polymarket",
                status: decision,
                side: row.side,
                size: row.size,
                price: row.price,
                orderId: row.venue_order_id,
                tokenId: row.token_id,
                walletAddress: row.wallet_address ?? inputs.signerAddress,
              }),
              inputs.log,
            );
          }
          continue;
        }
      }

      const venueOrderId = row.venue_order_id?.trim();
      if (venueOrderId) {
        const evidence = await fetchPolymarketClobOrderExecutionEvidence({
          creds: inputs.creds,
          log: inputs.log,
          orderId: venueOrderId,
          signer: inputs.signerAddress,
        });
        if (!evidence.checked) continue;
        if (evidence.hasExecution) {
          try {
            await syncUnconfirmedFillsOnce();
          } catch (error) {
            inputs.log.warn(
              {
                error,
                userId: inputs.userId,
                signerAddress: inputs.signerAddress,
                orderId: row.id,
                venueOrderId,
                afterSecOverride: tradeSyncAfterSecOverride,
              },
              "Polymarket unconfirmed order fill sync failed",
            );
          }
          if (!(await hasPolymarketOrderExecutionEvidence(row.id))) {
            continue;
          }
          if (
            evidence.statusHint === "cancelled" ||
            isPolymarketClobCancelledStatus(evidence.orderStatus)
          ) {
            const reconciled = await reconcilePolymarketTerminalOrder({
              userId: inputs.userId,
              venueOrderId,
              statusHint: "cancelled",
              externalFilledSize: null,
              externalFillPrice: null,
              externalHasExecution: false,
              skipOnchainExecutionCheck: true,
              allowAmbiguousNoFillReconcile: true,
              allowExternalExecutionEvidence: false,
              terminalNoFillStatus: null,
            });
            if (reconciled?.status === "cancelled") {
              cancelledCount += 1;
              void createNotificationSafe(
                pool,
                buildOrderNotification({
                  userId: inputs.userId,
                  venue: "polymarket",
                  status: "cancelled",
                  side: reconciled.side,
                  size: reconciled.size,
                  price: reconciled.price,
                  orderId: venueOrderId,
                  tokenId: reconciled.tokenId,
                  walletAddress:
                    reconciled.walletAddress ?? inputs.signerAddress,
                }),
                inputs.log,
              );
              continue;
            }
          }
          confirmedCount += 1;
          continue;
        }
        if (
          evidence.statusHint === "cancelled" ||
          isPolymarketClobCancelledStatus(evidence.orderStatus)
        ) {
          const reconciled = await reconcilePolymarketTerminalOrder({
            userId: inputs.userId,
            venueOrderId,
            statusHint: "cancelled",
            externalFilledSize: null,
            externalFillPrice: null,
            externalHasExecution: false,
            skipOnchainExecutionCheck: true,
            allowAmbiguousNoFillReconcile: true,
            allowExternalExecutionEvidence: false,
            terminalNoFillStatus: null,
          });
          if (reconciled?.status === "cancelled") {
            cancelledCount += 1;
            void createNotificationSafe(
              pool,
              buildOrderNotification({
                userId: inputs.userId,
                venue: "polymarket",
                status: "cancelled",
                side: reconciled.side,
                size: reconciled.size,
                price: reconciled.price,
                orderId: venueOrderId,
                tokenId: reconciled.tokenId,
                walletAddress: reconciled.walletAddress ?? inputs.signerAddress,
              }),
              inputs.log,
            );
          }
          continue;
        }
        if (isPolymarketClobOpenStatus(evidence.orderStatus)) {
          await markPolymarketOrderLiveFromClob({
            userId: inputs.userId,
            venueOrderId,
          });
          continue;
        }
        const noFillTerminalStatus = resolvePolymarketClobNoFillTerminalStatus(
          evidence.orderStatus,
        );
        if (
          noFillTerminalStatus != null &&
          isPolymarketNoFillGraceElapsed(row.posted_at)
        ) {
          const reconciled = await reconcilePolymarketTerminalOrder({
            userId: inputs.userId,
            venueOrderId,
            statusHint: null,
            externalFilledSize: null,
            externalFillPrice: null,
            externalHasExecution: false,
            skipOnchainExecutionCheck: true,
            allowAmbiguousNoFillReconcile: true,
            allowExternalExecutionEvidence: false,
            terminalNoFillStatus: noFillTerminalStatus,
          });
          if (
            reconciled?.status === "unmatched" ||
            reconciled?.status === "expired"
          ) {
            if (reconciled.status === "unmatched") unmatchedCount += 1;
            if (reconciled.status === "expired") expiredCount += 1;
            void createNotificationSafe(
              pool,
              buildOrderNotification({
                userId: inputs.userId,
                venue: "polymarket",
                status: reconciled.status,
                side: reconciled.side,
                size: reconciled.size,
                price: reconciled.price,
                orderId: venueOrderId,
                tokenId: reconciled.tokenId,
                walletAddress: reconciled.walletAddress ?? inputs.signerAddress,
              }),
              inputs.log,
            );
          }
        }
      }
    } catch (error) {
      inputs.log.warn(
        {
          error,
          userId: inputs.userId,
          signerAddress: inputs.signerAddress,
          orderId: row.id,
          orderHash,
        },
        "Polymarket unconfirmed order reconcile failed",
      );
    }
  }

  return {
    checked: rows.length,
    confirmedCount,
    cancelledCount,
    unmatchedCount,
    expiredCount,
  };
}

type PolymarketOrdersSyncStats = {
  changed: boolean;
  fetched: number;
  storedNew: number;
  alreadyKnown: number;
  skippedNoId: number;
  sampleVenueOrderIds: string[];
  tradeSync: {
    insertedFillCount: number;
    persistedFillCount: number;
    positionsRecomputed: boolean;
  };
  delayedSync: {
    checked: number;
    matchedCount: number;
    cancelledCount: number;
    unmatchedCount: number;
    expiredCount: number;
    unconfirmedCount: number;
    skippedOpenCount: number;
    liveCount: number;
  };
  settlementSync: {
    checked: number;
    confirmedCount: number;
    cancelledCount: number;
    unmatchedCount: number;
    expiredCount: number;
  };
};

type PolymarketOrdersSyncSignerResult =
  | {
      ok: true;
      signer: string;
      stats: PolymarketOrdersSyncStats;
    }
  | {
      ok: false;
      kind: "credentials_invalid" | "upstream";
      status: number;
      payload: unknown;
      tried?: { get: string };
    };

function emptyPolymarketOrdersSyncStats(): PolymarketOrdersSyncStats {
  return {
    changed: false,
    fetched: 0,
    storedNew: 0,
    alreadyKnown: 0,
    skippedNoId: 0,
    sampleVenueOrderIds: [],
    tradeSync: {
      insertedFillCount: 0,
      persistedFillCount: 0,
      positionsRecomputed: false,
    },
    delayedSync: {
      checked: 0,
      matchedCount: 0,
      cancelledCount: 0,
      unmatchedCount: 0,
      expiredCount: 0,
      unconfirmedCount: 0,
      skippedOpenCount: 0,
      liveCount: 0,
    },
    settlementSync: {
      checked: 0,
      confirmedCount: 0,
      cancelledCount: 0,
      unmatchedCount: 0,
      expiredCount: 0,
    },
  };
}

function mergePolymarketOrdersSyncStats(
  base: PolymarketOrdersSyncStats,
  next: PolymarketOrdersSyncStats,
): PolymarketOrdersSyncStats {
  return {
    changed: base.changed || next.changed,
    fetched: base.fetched + next.fetched,
    storedNew: base.storedNew + next.storedNew,
    alreadyKnown: base.alreadyKnown + next.alreadyKnown,
    skippedNoId: base.skippedNoId + next.skippedNoId,
    sampleVenueOrderIds: [
      ...base.sampleVenueOrderIds,
      ...next.sampleVenueOrderIds,
    ].slice(0, 10),
    tradeSync: {
      insertedFillCount:
        base.tradeSync.insertedFillCount + next.tradeSync.insertedFillCount,
      persistedFillCount:
        base.tradeSync.persistedFillCount + next.tradeSync.persistedFillCount,
      positionsRecomputed:
        base.tradeSync.positionsRecomputed ||
        next.tradeSync.positionsRecomputed,
    },
    delayedSync: {
      checked: base.delayedSync.checked + next.delayedSync.checked,
      matchedCount:
        base.delayedSync.matchedCount + next.delayedSync.matchedCount,
      cancelledCount:
        base.delayedSync.cancelledCount + next.delayedSync.cancelledCount,
      unmatchedCount:
        base.delayedSync.unmatchedCount + next.delayedSync.unmatchedCount,
      expiredCount:
        base.delayedSync.expiredCount + next.delayedSync.expiredCount,
      unconfirmedCount:
        base.delayedSync.unconfirmedCount + next.delayedSync.unconfirmedCount,
      skippedOpenCount:
        base.delayedSync.skippedOpenCount + next.delayedSync.skippedOpenCount,
      liveCount: base.delayedSync.liveCount + next.delayedSync.liveCount,
    },
    settlementSync: {
      checked: base.settlementSync.checked + next.settlementSync.checked,
      confirmedCount:
        base.settlementSync.confirmedCount + next.settlementSync.confirmedCount,
      cancelledCount:
        base.settlementSync.cancelledCount + next.settlementSync.cancelledCount,
      unmatchedCount:
        base.settlementSync.unmatchedCount + next.settlementSync.unmatchedCount,
      expiredCount:
        base.settlementSync.expiredCount + next.settlementSync.expiredCount,
    },
  };
}

async function syncPolymarketOrdersForSigner(inputs: {
  userId: string;
  signer: string;
  creds: PolymarketL2Credentials & { funderAddress?: string | null };
  authWalletAddress?: string | null;
  requestedOrderIds: string[];
  targetWalletAddress?: string | null;
  log: FastifyBaseLogger;
}): Promise<PolymarketOrdersSyncSignerResult> {
  const requestPathAll = "/data/orders";
  const walletAliases = resolvePolymarketSignerWalletAliases({
    signer: inputs.signer,
    funderAddress: inputs.creds.funderAddress,
    authWalletAddress: inputs.authWalletAddress,
    targetWalletAddress: inputs.targetWalletAddress,
  });
  const signerBackfillCount = await backfillPolymarketRequestedOrderSigner({
    userId: inputs.userId,
    signerAddress: inputs.signer,
    requestedOrderIds: inputs.requestedOrderIds,
    walletAliases,
  });

  const upstream = await polymarketL2Request({
    baseUrl: env.polymarketClobBase,
    timeoutMs: 10_000,
    address: inputs.signer,
    creds: {
      apiKey: inputs.creds.apiKey,
      apiSecret: inputs.creds.apiSecret,
      apiPassphrase: inputs.creds.apiPassphrase,
    },
    method: "GET",
    requestPath: requestPathAll,
  });

  if (!upstream.ok) {
    if (
      await invalidatePolymarketCredentialsForInvalidApiKey({
        userId: inputs.userId,
        signer: inputs.signer,
        endpoint: "orders/sync",
        upstream,
        log: inputs.log,
      })
    ) {
      return {
        ok: false,
        kind: "credentials_invalid",
        status: upstream.status,
        payload: upstream.payload,
      };
    }

    return {
      ok: false,
      kind: "upstream",
      status: upstream.status,
      tried: { get: requestPathAll },
      payload: upstream.payload,
    };
  }

  const ordersRaw = extractOrderArray(upstream.payload);
  const funder = inputs.creds.funderAddress ?? inputs.signer;

  let storedNew = 0;
  let alreadyKnown = 0;
  let skippedNoId = 0;
  let existingOpenMarkedLive = 0;
  let openOrderExecutionEvidenceCount = 0;
  let openOrderExecutionAfterSecOverride: number | null = null;
  const orderIds: string[] = [];

  for (const o of ordersRaw) {
    const venueOrderId = extractOrderId(o);
    if (!venueOrderId) {
      skippedNoId += 1;
      continue;
    }
    orderIds.push(venueOrderId);

    const normalizedOpenOrder = normalizeOpenOrder(o);
    const openOrderExecution = summarizePolymarketClobOrderExecution({
      associateTrades: normalizedOpenOrder?.associateTrades ?? null,
      sizeMatched: normalizedOpenOrder?.sizeMatched ?? null,
      status: normalizedOpenOrder?.status ?? null,
    });
    const tokenId = normalizedOpenOrder?.assetId ?? extractTokenId(o);
    const record = isRecord(o) ? o : null;
    const orderType =
      (record ? extractOrderType(record) : null) ??
      (normalizedOpenOrder?.type
        ? normalizeOrderType(normalizedOpenOrder.type)
        : null);
    const sideRaw =
      normalizedOpenOrder?.side?.toUpperCase() ??
      (typeof record?.side === "string" ? record.side.toUpperCase() : null);
    const side = sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;
    const derivedAmounts =
      side && record
        ? derivePriceAndSize(record, side)
        : { price: null, size: null };
    const { price, size } =
      derivedAmounts.price != null && derivedAmounts.size != null
        ? derivedAmounts
        : derivePriceAndSizeFromOpenOrder(normalizedOpenOrder, side);
    const orderWalletAddress = normalizedOpenOrder?.makerAddress ?? funder;

    const result = await storeOrder(pool, {
      userId: inputs.userId,
      walletAddress: orderWalletAddress,
      signerAddress: inputs.signer,
      venue: "polymarket",
      venueOrderId,
      tokenId,
      side,
      orderType: orderType ?? undefined,
      price,
      size,
      status: "live",
      errorMessage: null,
      rawError: null,
      orderPayload: o,
    });

    if (result.kind === "stored") storedNew += 1;
    if (openOrderExecution.hasExecution) {
      openOrderExecutionEvidenceCount += 1;
      const candidateAfterSec = resolvePolymarketTradeSyncAfterSecFromMs(
        resolvePolymarketOpenOrderTimestampMs({
          createdAt: normalizedOpenOrder?.createdAt ?? null,
          postedAt: result.order.posted_at,
        }),
      );
      if (candidateAfterSec != null) {
        openOrderExecutionAfterSecOverride =
          openOrderExecutionAfterSecOverride == null
            ? candidateAfterSec
            : Math.min(openOrderExecutionAfterSecOverride, candidateAfterSec);
      }
    }
    if (result.kind === "exists") {
      alreadyKnown += 1;
      if (
        !openOrderExecution.hasExecution &&
        isPolymarketPendingLocalOrderStatus(result.order.status)
      ) {
        const markedLive = await markPolymarketOrderLiveFromClob({
          userId: inputs.userId,
          venueOrderId,
        });
        if (markedLive) existingOpenMarkedLive += 1;
      }
    }
  }

  let tradeSync = {
    insertedFillCount: 0,
    persistedFillCount: 0,
    positionsRecomputed: false,
  };
  try {
    tradeSync = await syncPolymarketTradesForSigner(
      pool,
      {
        userId: inputs.userId,
        signerAddress: inputs.signer,
      },
      {
        afterSecOverride: openOrderExecutionAfterSecOverride,
      },
    );
  } catch (error) {
    inputs.log.error(
      { error, userId: inputs.userId, signer: inputs.signer },
      "Polymarket trade sync during orders sync failed",
    );
  }

  let delayedSync = {
    checked: 0,
    matchedCount: 0,
    cancelledCount: 0,
    unmatchedCount: 0,
    expiredCount: 0,
    unconfirmedCount: 0,
    skippedOpenCount: 0,
    liveCount: 0,
  };
  try {
    delayedSync = await reconcileDelayedPolymarketOrdersAfterOpenSync({
      creds: {
        apiKey: inputs.creds.apiKey,
        apiSecret: inputs.creds.apiSecret,
        apiPassphrase: inputs.creds.apiPassphrase,
      },
      openVenueOrderIds: orderIds,
      requestedOrderIds: inputs.requestedOrderIds,
      signerAddress: inputs.signer,
      userId: inputs.userId,
      walletAliases,
      log: inputs.log,
    });
  } catch (error) {
    inputs.log.error(
      { error, userId: inputs.userId, signer: inputs.signer },
      "Polymarket delayed order reconcile during orders sync failed",
    );
  }

  let settlementSync = {
    checked: 0,
    confirmedCount: 0,
    cancelledCount: 0,
    unmatchedCount: 0,
    expiredCount: 0,
  };
  try {
    settlementSync = await reconcileUnconfirmedOrders({
      creds: {
        apiKey: inputs.creds.apiKey,
        apiSecret: inputs.creds.apiSecret,
        apiPassphrase: inputs.creds.apiPassphrase,
      },
      userId: inputs.userId,
      requestedOrderIds: inputs.requestedOrderIds,
      signerAddress: inputs.signer,
      walletAliases,
      log: inputs.log,
    });
  } catch (error) {
    inputs.log.error(
      { error, userId: inputs.userId, signer: inputs.signer },
      "Polymarket unconfirmed order reconcile during orders sync failed",
    );
  }

  const stats: PolymarketOrdersSyncStats = {
    changed:
      storedNew > 0 ||
      signerBackfillCount > 0 ||
      existingOpenMarkedLive > 0 ||
      openOrderExecutionEvidenceCount > 0 ||
      tradeSync.insertedFillCount > 0 ||
      tradeSync.persistedFillCount > 0 ||
      delayedSync.matchedCount > 0 ||
      delayedSync.cancelledCount > 0 ||
      delayedSync.unmatchedCount > 0 ||
      delayedSync.expiredCount > 0 ||
      delayedSync.unconfirmedCount > 0 ||
      delayedSync.liveCount > 0 ||
      settlementSync.confirmedCount > 0 ||
      settlementSync.cancelledCount > 0 ||
      settlementSync.unmatchedCount > 0 ||
      settlementSync.expiredCount > 0,
    fetched: ordersRaw.length,
    storedNew,
    alreadyKnown,
    skippedNoId,
    sampleVenueOrderIds: orderIds.slice(0, 10),
    tradeSync,
    delayedSync: {
      ...delayedSync,
      liveCount: delayedSync.liveCount + existingOpenMarkedLive,
    },
    settlementSync,
  };

  return {
    ok: true,
    signer: inputs.signer,
    stats,
  };
}

function normalizeOrderForPayload(
  order: Record<string, unknown>,
  side: PolymarketSide,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...order };

  normalized.side = side;

  const signatureType = normalizeSignatureType(order.signatureType);
  if (signatureType !== null) {
    normalized.signatureType = signatureType;
  }

  const saltRaw = normalizeNumberishString(order.salt);
  if (saltRaw !== null) {
    const saltNumber = Number(saltRaw);
    normalized.salt = Number.isSafeInteger(saltNumber) ? saltNumber : saltRaw;
  }

  for (const key of [
    "tokenId",
    "makerAmount",
    "takerAmount",
    "timestamp",
    "expiration",
  ]) {
    const value = normalizeNumberishString(order[key]);
    if (value !== null) normalized[key] = value;
  }

  return normalized;
}

type NormalizedPolymarketOrderV2 = {
  salt: string;
  maker: string;
  signer: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: number;
  signatureType: number;
  timestamp: string;
  metadata: string;
  builder: string;
  signature: string;
};

function normalizeOrderForHash(
  order: Record<string, unknown>,
  side: PolymarketSide,
): NormalizedPolymarketOrderV2 | null {
  const signatureType = normalizeSignatureType(order.signatureType);
  if (signatureType == null) return null;

  const maker = typeof order.maker === "string" ? order.maker.trim() : "";
  const signer = typeof order.signer === "string" ? order.signer.trim() : "";
  if (!maker || !signer) return null;

  const salt = normalizeNumberishString(order.salt);
  const tokenId = normalizeNumberishString(order.tokenId);
  const makerAmount = normalizeNumberishString(order.makerAmount);
  const takerAmount = normalizeNumberishString(order.takerAmount);
  const timestamp = normalizeNumberishString(order.timestamp);
  const metadata =
    typeof order.metadata === "string" ? order.metadata.trim() : "";
  const builder = typeof order.builder === "string" ? order.builder.trim() : "";
  if (
    !salt ||
    !tokenId ||
    !makerAmount ||
    !takerAmount ||
    !timestamp ||
    !metadata ||
    !builder
  ) {
    return null;
  }

  const signature =
    typeof order.signature === "string" ? order.signature.trim() : "";
  if (!signature) return null;

  return {
    salt,
    maker,
    signer,
    tokenId,
    makerAmount,
    takerAmount,
    side: side === "BUY" ? 0 : 1,
    signatureType,
    timestamp,
    metadata,
    builder,
    signature,
  };
}

function derivePriceAndSize(
  order: Record<string, unknown>,
  side: PolymarketSide,
): { price: number | null; size: number | null } {
  const makerAmount = parseInteger(order.makerAmount);
  const takerAmount = parseInteger(order.takerAmount);
  if (!makerAmount || !takerAmount) return { price: null, size: null };
  if (makerAmount === 0n || takerAmount === 0n)
    return { price: null, size: null };

  const price =
    side === "BUY"
      ? Number(makerAmount) / Number(takerAmount)
      : Number(takerAmount) / Number(makerAmount);

  const sizeMicro = side === "BUY" ? takerAmount : makerAmount;
  const size = Number(sizeMicro) / 10 ** POLY_DECIMALS;

  if (!Number.isFinite(price) || !Number.isFinite(size)) {
    return { price: null, size: null };
  }

  return { price, size };
}

function derivePriceAndSizeFromOpenOrder(
  order: ReturnType<typeof normalizeOpenOrder>,
  side: PolymarketSide | null,
): { price: number | null; size: number | null } {
  if (!order || !side) return { price: null, size: null };

  const price =
    typeof order.price === "string" && order.price.trim().length > 0
      ? Number(order.price)
      : null;
  const size =
    typeof order.originalSize === "string" &&
    order.originalSize.trim().length > 0
      ? Number(order.originalSize)
      : null;

  if (
    price == null ||
    size == null ||
    !Number.isFinite(price) ||
    !Number.isFinite(size)
  ) {
    return { price: null, size: null };
  }

  return { price, size };
}

function extractOrderType(
  order: Record<string, unknown>,
): PolymarketOrderType | null {
  const raw =
    order.orderType ?? order.order_type ?? order.type ?? order.order_type;
  return normalizeOrderType(raw);
}

// Mounted under /trade/polymarket.
export const polymarketPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /market-info
   * Returns Polymarket-specific market constraints and exchange selection.
   */
  z.get(
    "/market-info",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketMarketInfoQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket market info requires an EVM wallet address",
        });
      }

      const query = request.query;

      try {
        const info = await fetchPolymarketMarketInfo(pool, {
          tokenId: query.tokenId,
          marketId: query.marketId,
          conditionId: query.conditionId,
        });

        if (!info) {
          reply.code(404);
          return reply.send({ error: "Polymarket market not found" });
        }

        let clobTokenIds: string[] | null = null;
        if (info.clob_token_ids) {
          try {
            const parsed = JSON.parse(info.clob_token_ids);
            if (Array.isArray(parsed)) {
              clobTokenIds = parsed.map((value) => String(value));
            }
          } catch {
            clobTokenIds = null;
          }
        }

        const negRisk = info.neg_risk != null ? Boolean(info.neg_risk) : null;
        const takerFeeRaw = info.taker_fee_bps ?? null;
        const makerFeeRaw = info.maker_fee_bps ?? null;
        const takerFeeBps =
          takerFeeRaw != null && takerFeeRaw !== ""
            ? Math.max(0, Number(takerFeeRaw))
            : 0;
        const makerFeeBps =
          makerFeeRaw != null && makerFeeRaw !== ""
            ? Math.max(0, Number(makerFeeRaw))
            : 0;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          tokenId: query.tokenId ?? null,
          marketId: query.marketId ?? null,
          conditionId: query.conditionId ?? null,
          polymarketId: info.polymarket_id,
          unifiedMarketId: info.unified_market_id,
          clobTokenIds,
          tokenYes: clobTokenIds?.[0] ?? null,
          tokenNo: clobTokenIds?.[1] ?? null,
          negRisk,
          exchangeAddress: exchangeAddressForNegRisk(negRisk),
          orderPriceMinTickSize:
            info.order_price_min_tick_size != null
              ? Number(info.order_price_min_tick_size)
              : null,
          orderMinSize:
            info.order_min_size != null ? Number(info.order_min_size) : null,
          acceptingOrders:
            info.accepting_orders != null
              ? Boolean(info.accepting_orders)
              : null,
          takerFeeBps: Number.isFinite(takerFeeBps) ? takerFeeBps : 0,
          makerFeeBps: Number.isFinite(makerFeeBps) ? makerFeeBps : 0,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer, query },
          "Failed to fetch Polymarket market info",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Polymarket market info",
        });
      }
    },
  );

  /**
   * GET /order-params
   * Returns default params needed to build an order signature.
   */
  z.get(
    "/order-params",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketOrderParamsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket order params require an EVM wallet address",
        });
      }

      const tokenId = request.query.tokenId.trim();
      if (!tokenId) {
        reply.code(400);
        return reply.send({ error: "tokenId is required" });
      }

      const marketInfo = await fetchPolymarketMarketInfo(pool, { tokenId });
      const takerFeeRaw = marketInfo?.taker_fee_bps ?? null;
      const makerFeeRaw = marketInfo?.maker_fee_bps ?? null;
      const takerFeeBps =
        takerFeeRaw != null && takerFeeRaw !== ""
          ? Math.max(0, Number(takerFeeRaw))
          : 0;
      const makerFeeBps =
        makerFeeRaw != null && makerFeeRaw !== ""
          ? Math.max(0, Number(makerFeeRaw))
          : 0;

      reply.header("Content-Type", "application/json; charset=utf-8");
      const nowMs = Date.now().toString();
      const zeroBytes32 =
        "0x0000000000000000000000000000000000000000000000000000000000000000";
      const feePolicySnapshot = await resolvePolymarketFeePolicySnapshot(pool);
      return reply.send({
        ok: true,
        version: "polymarket_clob_v2",
        tokenId,
        timestamp: nowMs,
        metadata: zeroBytes32,
        builder: feePolicySnapshot.builderCode,
        exchangeAddress:
          marketInfo?.neg_risk === true
            ? env.polymarketNegRiskExchangeAddress
            : env.polymarketExchangeAddress,
        collateralAddress: env.polymarketUsdcAddress,
        takerFeeBps: Number.isFinite(takerFeeBps) ? takerFeeBps : 0,
        makerFeeBps: Number.isFinite(makerFeeBps) ? makerFeeBps : 0,
        builderCollectionMode: feePolicySnapshot.collectionMode,
        builderTakerFeeBps: feePolicySnapshot.builderTakerFeeBps,
        builderMakerFeeBps: feePolicySnapshot.builderMakerFeeBps,
        builderRateSource: feePolicySnapshot.builderRateSource,
        builderEnabled: feePolicySnapshot.builderEnabled,
      });
    },
  );

  /**
   * POST /order-hash
   * Compute the Polymarket exchange order hash for a signed order.
   */
  z.post(
    "/order-hash",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketOrderHashBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket order hash requires an EVM wallet address",
        });
      }

      const body = request.body;
      const order = body.order;
      const orderTokenId =
        typeof order.tokenId === "string" ? order.tokenId : "";
      if (orderTokenId) {
        void markHotTokens({ tokenIds: [orderTokenId], venue: "polymarket" });
        void requestPriceRefreshForTokens({
          tokenIds: [orderTokenId],
          venue: "polymarket",
        });
      }

      const credsInfo = await AuthService.getVenueCredentialsInfo(
        user.id,
        "polymarket",
        signer,
      );
      const funder = credsInfo?.funderAddress ?? signer;
      const walletValidation = validatePolymarketOrderWallets({
        order,
        selectedSigner: signer,
        configuredFunder: funder,
      });
      if (!walletValidation.ok) {
        reply.code(400);
        return reply.send({ error: walletValidation.error });
      }

      const side = normalizeOrderSide(order.side);
      if (!side) {
        reply.code(400);
        return reply.send({
          error: "Order side must be BUY/SELL (or 0/1)",
        });
      }

      const normalizedForHash = normalizeOrderForHash(order, side);
      if (!normalizedForHash) {
        reply.code(400);
        return reply.send({
          error: "Order payload is missing required hash fields",
        });
      }

      const exchangeAddress =
        (typeof body.exchangeAddress === "string" && body.exchangeAddress) ||
        exchangeAddressForNegRisk(body.negRisk ?? null) ||
        env.polymarketExchangeAddress;

      try {
        const orderHash = await fetchPolymarketOrderHashV2({
          rpcUrl: env.polygonRpcUrl,
          timeoutMs: env.polygonRpcTimeoutMs,
          exchangeAddress,
          order: normalizedForHash,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          orderHash,
          exchangeAddress,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to compute Polymarket order hash",
        );
        reply.code(502);
        return reply.send({
          error: "Polymarket order hash failed",
        });
      }
    },
  );

  /**
   * GET /funder-derive
   * Returns candidate Polymarket funder/vault addresses for the selected signer.
   */
  z.get(
    "/funder-derive",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketFunderDeriveQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = isRecord(request.query) ? request.query : null;
      const walletOverride =
        typeof query?.walletAddress === "string"
          ? query.walletAddress.trim()
          : null;
      const signer = walletOverride || request.walletAddress;
      if (!signer) {
        reply.code(400);
        return reply.send({ error: "walletAddress is required" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket funder derive requires an EVM wallet address",
        });
      }

      if (walletOverride) {
        const walletRecord = await AuthService.getUserWalletByAddress(
          user.id,
          signer,
        );
        if (!walletRecord) {
          reply.code(403);
          return reply.send({
            error: "walletAddress does not belong to the current user",
          });
        }
      }

      const credsInfo = await AuthService.getVenueCredentialsInfo(
        user.id,
        "polymarket",
        signer,
      );

      const includeMagicProxy =
        parseOptionalBoolean(query?.includeMagicProxy) ?? false;
      const refresh = parseOptionalBoolean(query?.refresh) === true;

      const result = await derivePolymarketFunders({
        signer,
        storedFunder: credsInfo?.funderAddress ?? null,
        includeMagicProxy,
        bypassCodeCache: refresh,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        ...result,
      });
    },
  );

  /**
   * POST /funder-derive/batch
   * Returns candidate Polymarket funder/vault addresses for multiple signers.
   */
  z.post(
    "/funder-derive/batch",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketFunderDeriveBatchBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const wallets = Array.from(new Set(body.wallets.map(normalizeAddress)));

      const userWallets = await AuthService.getUserWallets(user.id);
      const allowedWallets = new Set(
        userWallets.map((wallet) => normalizeAddress(wallet.walletAddress)),
      );

      for (const wallet of wallets) {
        if (!allowedWallets.has(wallet)) {
          reply.code(403);
          return reply.send({
            error: "walletAddress does not belong to the current user",
          });
        }
      }

      const includeMagicProxy = Boolean(body.includeMagicProxy);
      const refresh = body.refresh === true;

      const results: Record<string, unknown> = {};

      for (const wallet of wallets) {
        try {
          const credsInfo = await AuthService.getVenueCredentialsInfo(
            user.id,
            "polymarket",
            wallet,
          );
          const result = await derivePolymarketFunders({
            signer: wallet,
            storedFunder: credsInfo?.funderAddress ?? null,
            includeMagicProxy,
            bypassCodeCache: refresh,
          });
          results[wallet] = result;
        } catch {
          results[wallet] = {
            error: "Funder derive failed",
          };
        }
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        results,
      });
    },
  );

  /**
   * POST /quote
   * Returns a price/size preview derived from the current orderbook.
   */
  z.post(
    "/quote",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketQuoteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket quote requires an EVM wallet address",
        });
      }

      const body = request.body;
      const tokenId = body.tokenId.trim();
      const orderType = normalizeQuoteOrderTypeForClob(body.orderType ?? "FOK");
      const amountType =
        (body.amountType ?? "usd") === "shares" ? "shares" : "usd";
      const amountUsdInput =
        amountType === "usd" ? (body.amountUsd ?? body.amount) : null;
      const amountSharesInput = amountType === "shares" ? body.amount : null;

      if (!tokenId) {
        reply.code(400);
        return reply.send({ error: "tokenId is required" });
      }

      void markHotTokens({ tokenIds: [tokenId], venue: "polymarket" });
      void requestPriceRefreshForTokens({
        tokenIds: [tokenId],
        venue: "polymarket",
      });

      try {
        const quote = await quotePolymarketOrder(pool, {
          tokenId,
          side: body.side,
          orderType,
          amountType,
          amountUsdInput,
          amountSharesInput,
          limitPrice: body.limitPrice,
          slippageBps: body.slippageBps,
          logWarn: ({ error, tokenId: warningTokenId, conditionId }) =>
            request.log.warn(
              { error, tokenId: warningTokenId, conditionId },
              "Failed to fetch Polymarket CLOB fee curve; using local fee fallback",
            ),
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(quote);
      } catch (error) {
        if (error instanceof PolymarketQuoteError) {
          reply.code(error.statusCode);
          return reply.send({ error: error.publicMessage });
        }
        app.log.error(
          { error, userId: user.id, signer, body },
          "Failed to quote Polymarket order",
        );
        reply.code(502);
        return reply.send({
          error: "Polymarket quote failed",
        });
      }
    },
  );

  /**
   * POST /max-spend
   * Returns the largest market BUY FOK USD amount executable with current funds.
   */
  z.post(
    "/max-spend",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketMaxSpendBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket max spend requires an EVM wallet address",
        });
      }

      const body = request.body;
      const tokenId = body.tokenId.trim();
      const orderType = body.orderType ?? "FOK";
      const amountType = body.amountType ?? "usd";

      if (orderType !== "FOK" || amountType !== "usd") {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(
          polymarketMaxSpendUnavailable(
            "unsupported_order_type",
            "Polymarket max spend currently supports market BUY FOK USD orders only.",
          ),
        );
      }

      void markHotTokens({ tokenIds: [tokenId], venue: "polymarket" });
      void requestPriceRefreshForTokens({
        tokenIds: [tokenId],
        venue: "polymarket",
      });

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(
          polymarketMaxSpendUnavailable(
            "missing_credentials",
            "Polymarket credentials not found.",
          ),
        );
      }

      const requestedFunder = body.funderAddress ?? creds.funderAddress ?? null;
      const funder = normalizeEvmAddress(requestedFunder);
      if (!funder || funder === normalizeEvmAddress(signer)) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(
          polymarketMaxSpendUnavailable(
            "unsupported_wallet",
            "Polymarket max spend requires a configured executable funder.",
          ),
        );
      }

      let funderExecutionKind: PolymarketFunderExecutionKind = null;
      try {
        const funderDerivation = await derivePolymarketFunders({
          signer,
          storedFunder: funder,
          includeMagicProxy: true,
          bypassCodeCache: false,
        });
        const candidate = findPolymarketFunderCandidateByAddress(
          funderDerivation.candidates,
          funder,
        );
        funderExecutionKind =
          resolvePolymarketFunderExecutionKindForMaxSpend(candidate);
        if (
          !candidate ||
          candidate.deployed !== true ||
          (funderExecutionKind !== "deposit_wallet" &&
            funderExecutionKind !== "safe")
        ) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(
            polymarketMaxSpendUnavailable(
              "unsupported_wallet",
              "Configured Polymarket funder cannot execute backend-supported orders.",
            ),
          );
        }
      } catch (error) {
        request.log.warn(
          { error, userId: user.id, signer, funder },
          "Failed to resolve Polymarket max-spend funder",
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(
          polymarketMaxSpendUnavailable(
            "unsupported_wallet",
            "Configured Polymarket funder could not be validated.",
          ),
        );
      }

      let funds: Awaited<ReturnType<typeof resolvePolymarketMaxSpendFunds>>;
      try {
        funds = await resolvePolymarketMaxSpendFunds({
          userId: user.id,
          signer,
          funder,
          funderExecutionKind,
          creds: {
            apiKey: creds.apiKey,
            apiSecret: creds.apiSecret,
            apiPassphrase: creds.apiPassphrase,
          },
        });
      } catch (error) {
        if (
          error instanceof PolymarketMaxSpendLiveOrderLocksError &&
          (await invalidatePolymarketCredentialsForInvalidApiKey({
            userId: user.id,
            signer,
            endpoint: "max-spend/open-orders",
            upstream: error.upstream,
            log: request.log,
          }))
        ) {
          return sendPolymarketCredentialsInvalidResponse(
            reply,
            error.upstream,
          );
        }
        request.log.warn(
          { error, userId: user.id, signer, funder },
          "Failed to resolve Polymarket max-spend balances",
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(
          polymarketMaxSpendUnavailable(
            "balance_unavailable",
            "Polymarket balances are unavailable.",
          ),
        );
      }

      if (funds.executableFundsRaw <= 0n) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(
          polymarketMaxSpendUnavailable(
            "no_executable_funds",
            "No executable Polymarket funds are available.",
          ),
        );
      }

      try {
        const maxSpend = await findMaxPolymarketMarketBuyUsdForFunds(pool, {
          tokenId,
          executableFundsRaw: funds.executableFundsRaw,
          slippageBps: body.slippageBps,
          logWarn: ({ error, tokenId: warningTokenId, conditionId }) =>
            request.log.warn(
              { error, tokenId: warningTokenId, conditionId },
              "Failed to fetch Polymarket CLOB fee curve; using local fee fallback",
            ),
        });

        if (!maxSpend.ok) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(
            polymarketMaxSpendUnavailable(
              maxSpend.reason,
              maxSpend.reason === "no_liquidity"
                ? "No executable Polymarket liquidity is available for the max spend amount."
                : "Executable funds are below the minimum Polymarket order amount.",
            ),
          );
        }

        const quote = maxSpend.quote;
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          reason: "ok",
          tokenId,
          side: "BUY",
          orderType: "FOK",
          amountType: "usd",
          maxAmountUsd: Number(maxSpend.maxAmountUsdRaw) / 1_000_000,
          maxAmountUsdRaw: maxSpend.maxAmountUsdRaw,
          totalRequiredUsdcRaw: quote.totalRequiredUsdcRaw ?? "0",
          totalFeeEstimateRaw: quote.totalFeeEstimateRaw,
          platformFeeEstimateRaw: quote.platformFeeEstimateRaw,
          builderFeeEstimateRaw: quote.builderFeeEstimateRaw,
          makerAmount: quote.makerAmount,
          takerAmount: quote.takerAmount,
          price: quote.price,
          size: quote.size,
          amountUsdUsed: quote.amountUsdUsed,
          bestBid: quote.bestBid,
          bestAsk: quote.bestAsk,
          slippageBps: quote.slippageBps,
          executableFundsRaw: funds.executableFundsRaw.toString(),
          funderPusdRaw: funds.funderPusdRaw.toString(),
          funderPusdAvailableRaw: funds.funderPusdAvailableRaw.toString(),
          funderLockedRaw: funds.funderLockedRaw.toString(),
          signerLockedRaw: funds.signerLockedRaw.toString(),
          signerPusdTopUpRaw: funds.signerPusdTopUpRaw.toString(),
          signerUsdceTopUpRaw: funds.signerUsdceTopUpRaw.toString(),
          usesSignerTopUp: funds.usesSignerTopUp,
        });
      } catch (error) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        if (error instanceof PolymarketQuoteError) {
          if (error.reason === "missing_top_of_book") {
            return reply.send(
              polymarketMaxSpendUnavailable(
                "no_liquidity",
                "No executable Polymarket liquidity is available.",
              ),
            );
          }
          if (error.reason === "amount_too_small") {
            return reply.send(
              polymarketMaxSpendUnavailable(
                "below_min_order",
                "Executable funds are below the minimum Polymarket order amount.",
              ),
            );
          }
          return reply.send(
            polymarketMaxSpendUnavailable(
              "quote_unavailable",
              error.publicMessage,
            ),
          );
        }
        app.log.error(
          { error, userId: user.id, signer, body },
          "Failed to compute Polymarket max spend",
        );
        return reply.send(
          polymarketMaxSpendUnavailable(
            "quote_unavailable",
            "Polymarket max spend quote is unavailable.",
          ),
        );
      }
    },
  );

  /**
   * GET /account
   * Returns a wallet-scoped Polymarket account snapshot (Polygon on-chain reads).
   *
   * Notes:
   * - `X-HUNCH-WALLET` is the signer EOA (selected wallet).
   * - `funder_address` (if set) is used as the on-chain owner for balances/allowances.
   */
  z.get(
    "/account",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketAccountQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket account snapshot requires an EVM wallet address",
        });
      }

      const credsInfo = await AuthService.getVenueCredentialsInfo(
        user.id,
        "polymarket",
        signer,
      );

      const requestedFunder = request.query.funderAddress;
      const funder = requestedFunder ?? credsInfo?.funderAddress ?? signer;
      const funderSource = requestedFunder
        ? "query"
        : credsInfo?.funderAddress
          ? "credentials"
          : "signer";
      const credentialsUpdatedAtValue =
        credsInfo?.updatedAt instanceof Date
          ? credsInfo.updatedAt.toISOString()
          : (credsInfo?.updatedAt ?? null);
      const credentialsKey = credsInfo
        ? `${credsInfo.id}|${credentialsUpdatedAtValue ?? "none"}`
        : "none";
      const funderUpdatedAtValue =
        credsInfo?.funderUpdatedAt instanceof Date
          ? credsInfo.funderUpdatedAt.toISOString()
          : (credsInfo?.funderUpdatedAt ?? null);
      const refresh = request.query.refresh === true;
      const cacheEnabled = !refresh && env.polymarketAccountCacheTtlMs > 0;
      const cacheKey = buildPolymarketAccountCacheKey({
        userId: user.id,
        signer,
        funder,
        credentialsKey,
        funderUpdatedAt: funderUpdatedAtValue,
      });

      if (cacheEnabled) {
        const cached = readPolymarketAccountCache(cacheKey);
        if (cached) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cached);
        }
        const inflight = polymarketAccountInflight.get(cacheKey);
        if (inflight) {
          const payload = await inflight;
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(payload);
        }
      }

      try {
        const negRiskAdapterAddress =
          env.polymarketNegRiskAdapterAddress?.trim() || "";
        const ctfCollateralAdapterAddress =
          env.polymarketCtfCollateralAdapterAddress?.trim() || "";
        const negRiskCollateralAdapterAddress =
          env.polymarketNegRiskCollateralAdapterAddress?.trim() || "";
        const funderDistinctFromSigner =
          normalizeEvmAddress(funder) !== normalizeEvmAddress(signer);
        const computePromise = (async (): Promise<PolymarketAccountPayload> => {
          const [code, snapshot] = await Promise.all([
            fetchEvmCode({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              address: funder,
            }),
            fetchPolymarketOnchainSnapshot({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              signer,
              funder,
              includeSignerUsdc: funderDistinctFromSigner,
              includeFeeCollectorNonce: false,
              negRiskAdapterAddress,
              ctfCollateralAdapterAddress,
              negRiskCollateralAdapterAddress,
              feeCollectorAddress: null,
            }),
          ]);

          const pusdBalance = snapshot.pusdBalance;
          const usdceBalance = snapshot.usdceBalance;
          const nativeUsdcBalance = snapshot.nativeUsdcBalance;
          const signerPusdBalance =
            snapshot.signerPusdBalance ?? snapshot.pusdBalance;
          const signerUsdceBalance =
            snapshot.signerUsdceBalance ?? snapshot.usdceBalance;
          const signerNativeUsdcBalance =
            snapshot.signerNativeUsdcBalance ?? snapshot.nativeUsdcBalance;
          const allowanceExchange = snapshot.allowanceExchange;
          const allowanceNegRisk = snapshot.allowanceNegRisk;
          const okExchange = snapshot.okExchange;
          const okNegRisk = snapshot.okNegRisk;
          const okNegRiskAdapter = snapshot.okNegRiskAdapter;
          const okCtfCollateralAdapter = snapshot.okCtfCollateralAdapter;
          const okNegRiskCollateralAdapter =
            snapshot.okNegRiskCollateralAdapter;
          const allowanceNegRiskAdapter = snapshot.allowanceNegRiskAdapter;

          const isContract = typeof code === "string" && code.length > 2;
          const pusdStatus = {
            tokenAddress: env.polymarketUsdcAddress,
            decimals: 6,
            balance: ethers.formatUnits(pusdBalance, 6),
            balanceRaw: pusdBalance.toString(),
            allowance: {
              exchange: {
                spender: env.polymarketExchangeAddress,
                allowance: ethers.formatUnits(allowanceExchange, 6),
                allowanceRaw: allowanceExchange.toString(),
              },
              negRiskExchange: {
                spender: env.polymarketNegRiskExchangeAddress,
                allowance: ethers.formatUnits(allowanceNegRisk, 6),
                allowanceRaw: allowanceNegRisk.toString(),
              },
              ...(negRiskAdapterAddress
                ? {
                    negRiskAdapter: {
                      spender: negRiskAdapterAddress,
                      allowance: ethers.formatUnits(
                        allowanceNegRiskAdapter ?? 0n,
                        6,
                      ),
                      allowanceRaw: (allowanceNegRiskAdapter ?? 0n).toString(),
                    },
                  }
                : {}),
            },
          };

          return {
            ok: true,
            venue: "polymarket",
            chainId: 137,
            signer,
            funder,
            funderSource,
            funderUpdatedAt: credsInfo?.funderUpdatedAt ?? null,
            funderIsContract: isContract,
            rpcUrl: env.polygonRpcUrl,
            negRiskAdapterAddress: negRiskAdapterAddress || null,
            ctfCollateralAdapterAddress: ctfCollateralAdapterAddress || null,
            negRiskCollateralAdapterAddress:
              negRiskCollateralAdapterAddress || null,
            pusd: pusdStatus,
            usdc: pusdStatus,
            nativeUsdc: {
              tokenAddress: POLYGON_NATIVE_USDC_ADDRESS,
              decimals: 6,
              balance: ethers.formatUnits(nativeUsdcBalance, 6),
              balanceRaw: nativeUsdcBalance.toString(),
            },
            usdce: {
              tokenAddress: env.polymarketUsdceAddress,
              decimals: 6,
              balance: ethers.formatUnits(usdceBalance, 6),
              balanceRaw: usdceBalance.toString(),
            },
            signerPusd: {
              tokenAddress: env.polymarketUsdcAddress,
              decimals: 6,
              balance: ethers.formatUnits(signerPusdBalance, 6),
              balanceRaw: signerPusdBalance.toString(),
            },
            signerUsdc: {
              tokenAddress: env.polymarketUsdcAddress,
              decimals: 6,
              balance: ethers.formatUnits(signerPusdBalance, 6),
              balanceRaw: signerPusdBalance.toString(),
            },
            signerUsdce: {
              tokenAddress: env.polymarketUsdceAddress,
              decimals: 6,
              balance: ethers.formatUnits(signerUsdceBalance, 6),
              balanceRaw: signerUsdceBalance.toString(),
            },
            signerNativeUsdc: {
              tokenAddress: POLYGON_NATIVE_USDC_ADDRESS,
              decimals: 6,
              balance: ethers.formatUnits(signerNativeUsdcBalance, 6),
              balanceRaw: signerNativeUsdcBalance.toString(),
            },
            conditionalTokens: {
              contractAddress: env.polymarketConditionalTokensAddress,
              isApprovedForAll: {
                exchange: okExchange,
                negRiskExchange: okNegRisk,
                ...(negRiskAdapterAddress
                  ? { negRiskAdapter: okNegRiskAdapter }
                  : {}),
                ...(ctfCollateralAdapterAddress
                  ? { ctfCollateralAdapter: okCtfCollateralAdapter }
                  : {}),
                ...(negRiskCollateralAdapterAddress
                  ? { negRiskCollateralAdapter: okNegRiskCollateralAdapter }
                  : {}),
              },
              operatorApprovals: snapshot.operatorApprovals,
            },
            hasCredentials: Boolean(credsInfo),
          };
        })();

        if (cacheEnabled) {
          polymarketAccountInflight.set(cacheKey, computePromise);
        }
        try {
          const payload = await computePromise;
          if (cacheEnabled) {
            writePolymarketAccountCache(cacheKey, payload);
          }
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(payload);
        } finally {
          polymarketAccountInflight.delete(cacheKey);
        }
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer, funder },
          "Failed to fetch Polymarket account snapshot",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Polymarket account snapshot",
        });
      }
    },
  );

  z.get(
    "/redemption-plan",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketRedemptionPlanQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket redemption requires an EVM wallet address",
        });
      }

      try {
        const credsInfo = await AuthService.getVenueCredentialsInfo(
          user.id,
          "polymarket",
          signer,
        );
        const funder =
          request.query.funderAddress ?? credsInfo?.funderAddress ?? signer;
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
          outcome: request.query.outcome,
          positionTokenId: request.query.tokenId,
          conditionId: request.query.conditionId ?? null,
          questionId: request.query.questionId ?? null,
          negRiskParentConditionId:
            request.query.negRiskParentConditionId ?? null,
          negRiskRequestId: request.query.negRiskRequestId ?? null,
          isNegRisk: request.query.negRisk === true,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(plan);
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            signer,
            tokenId: request.query.tokenId,
            outcome: request.query.outcome,
          },
          "Failed to build Polymarket redemption plan",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to prepare Polymarket redemption",
        });
      }
    },
  );

  z.post(
    "/embedded/ensure-ready/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedEnsureReadyBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error:
            "Embedded Polymarket automation requires an EVM wallet address",
        });
      }

      try {
        const lockKey = normalizeEvmAddress(signer) ?? signer.toLowerCase();
        const existingExecution = getEmbeddedExecutionSingleFlightPromise<
          Record<string, unknown>
        >(
          buildEmbeddedExecutionSingleFlightKey(
            "polymarket-private",
            "embedded-ensure-ready",
            lockKey,
          ),
        );
        if (existingExecution) {
          await existingExecution;
          const settledState = await resolveEmbeddedEnsureReadyState({
            user,
            signer,
            requestedFunder: request.body.funderAddress ?? null,
          });
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            signer,
            funder: settledState.effectiveFunder,
            funderSource: settledState.effectiveDistinctFunder
              ? "stored"
              : "signer",
            clearedStoredFunder: settledState.clearedStoredFunder,
            requests: [],
          });
        }

        const state = await resolveEmbeddedEnsureReadyState({
          user,
          signer,
          requestedFunder: request.body.funderAddress ?? null,
        });

        const requests = [...state.approvalRequests];
        if (!state.credsInfo) {
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const nonce = crypto.randomInt(1_000_000_000);
          requests.unshift(
            buildEmbeddedPolymarketConnectRequest({
              context: state.context,
              timestamp,
              nonce,
            }),
          );
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            signer,
            funder: state.effectiveFunder,
            funderSource: state.effectiveDistinctFunder ? "stored" : "signer",
            clearedStoredFunder: state.clearedStoredFunder,
            connectTimestamp: timestamp,
            connectNonce: nonce,
            requests,
          });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer,
          funder: state.effectiveFunder,
          funderSource: state.effectiveDistinctFunder ? "stored" : "signer",
          clearedStoredFunder: state.clearedStoredFunder,
          requests,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to prepare embedded Polymarket readiness",
        );
        reply.code(500);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Embedded setup preparation failed",
        });
      }
    },
  );

  z.post(
    "/embedded/ensure-ready/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedEnsureReadyExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error:
            "Embedded Polymarket automation requires an EVM wallet address",
        });
      }

      try {
        const lockKey = normalizeEvmAddress(signer) ?? signer.toLowerCase();
        const singleFlightKey = buildEmbeddedExecutionSingleFlightKey(
          "polymarket-private",
          "embedded-ensure-ready",
          lockKey,
        );
        const existingExecution =
          getEmbeddedExecutionSingleFlightPromise<Record<string, unknown>>(
            singleFlightKey,
          );
        if (existingExecution) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(await existingExecution);
        }

        const result = await runEmbeddedExecutionSingleFlight({
          key: singleFlightKey,
          run: async () => {
            const state = await resolveEmbeddedEnsureReadyState({
              user,
              signer,
              requestedFunder: request.body.funderAddress ?? null,
            });

            let connected = false;
            if (!state.credsInfo) {
              const connectRequest = request.body.signedRequests.find(
                (entry) => entry.id === "polymarket-connect",
              );
              if (!connectRequest?.signature?.trim()) {
                throw new Error(
                  "Missing Privy authorization signature for Polymarket connect",
                );
              }
              const connectTimestamp =
                request.body.connectTimestamp?.trim() ?? "";
              const connectNonce = request.body.connectNonce;
              if (!connectTimestamp || connectNonce == null) {
                throw new Error(
                  "Embedded Polymarket connect requires the prepared timestamp and nonce.",
                );
              }
              const preparedConnectRequest =
                buildEmbeddedPolymarketConnectRequest({
                  context: state.context,
                  timestamp: connectTimestamp,
                  nonce: connectNonce,
                });
              const connectSignature =
                await executeEmbeddedPolymarketConnectRequest({
                  request: preparedConnectRequest,
                  authorizationSignature: connectRequest.signature,
                });
              const { apiKey, apiSecret, passphrase } =
                await requestPolymarketCredentials({
                  walletAddress: signer,
                  signature: connectSignature,
                  timestamp: connectTimestamp,
                  nonce: connectNonce,
                });
              const additionalData: Record<string, unknown> = {
                passphrase,
                ...(state.effectiveDistinctFunder
                  ? { funderAddress: state.effectiveDistinctFunder }
                  : {}),
              };
              await AuthService.createOrUpdateVenueCredentials(
                user.id,
                signer,
                "polymarket",
                apiKey,
                apiSecret,
                additionalData,
              );
              connected = true;
            }

            const approvalRequests = state.approvalRequests;
            const approvalSignatures = request.body.signedRequests.filter(
              (entry) => entry.id.startsWith("approval-"),
            );
            const txHashes = await executeEmbeddedSignerApprovalRequests({
              requests: approvalRequests,
              signatures: approvalSignatures,
            });

            return buildEmbeddedEnsureReadyResponse({
              signer,
              effectiveFunder: state.effectiveFunder,
              effectiveDistinctFunder: state.effectiveDistinctFunder,
              clearedStoredFunder: state.clearedStoredFunder,
              connected,
              approvalsApplied: txHashes.length > 0,
              approvalExecution:
                txHashes.length > 0
                  ? {
                      signer,
                      funder: state.effectiveFunder,
                      funderKind: "signer",
                      transactionHashes: txHashes,
                    }
                  : null,
            });
          },
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to execute embedded Polymarket readiness",
        );
        reply.code(500);
        return reply.send({
          error:
            error instanceof Error ? error.message : "Embedded setup failed",
        });
      }
    },
  );

  z.post(
    "/embedded/sign-order/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: polymarketEmbeddedSignOrderBodySchema.omit({
          authorizationSignature: true,
        }),
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedPolymarketWalletContext({
          user,
          signer,
        });
        const authorizationRequest = buildEmbeddedPolymarketOrderRequest({
          context,
          payload: request.body.order,
          exchangeAddress: request.body.exchangeAddress,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, request: authorizationRequest });
      } catch (error) {
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare order signature",
        });
      }
    },
  );

  z.post(
    "/embedded/sign-order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedSignOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedPolymarketWalletContext({
          user,
          signer,
        });
        const authorizationRequest = buildEmbeddedPolymarketOrderRequest({
          context,
          payload: request.body.order,
          exchangeAddress: request.body.exchangeAddress,
        });
        const signature = await executeEmbeddedPolymarketOrderRequest({
          request: authorizationRequest,
          authorizationSignature: request.body.authorizationSignature,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, signature });
      } catch (error) {
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error ? error.message : "Failed to sign order",
        });
      }
    },
  );

  z.post(
    "/embedded/sign-fee-auth/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: polymarketEmbeddedSignFeeAuthBodySchema.omit({
          authorizationSignature: true,
        }),
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      reply.code(410);
      return reply.send({
        error:
          "Polymarket fee-auth signing is disabled; configure builder fees or submit without a Hunch fee.",
      });
    },
  );

  z.post(
    "/embedded/sign-fee-auth",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedSignFeeAuthBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      reply.code(410);
      return reply.send({
        error:
          "Polymarket fee-auth signing is disabled; configure builder fees or submit without a Hunch fee.",
      });
    },
  );

  z.post(
    "/embedded/sign-typed-data/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: polymarketEmbeddedSignTypedDataBodySchema.omit({
          authorizationSignature: true,
        }),
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedPolymarketWalletContext({
          user,
          signer,
        });
        const authorizationRequest = buildEmbeddedPolymarketTypedDataRequest({
          context,
          typedData: request.body.typedData,
          id: request.body.id,
          label: request.body.label,
          depositWalletBatchPurpose: request.body.depositWalletBatchPurpose,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, request: authorizationRequest });
      } catch (error) {
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare typed-data signature",
        });
      }
    },
  );

  z.post(
    "/embedded/sign-typed-data",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedSignTypedDataBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const context = await resolveEmbeddedPolymarketWalletContext({
          user,
          signer,
        });
        const authorizationRequest = buildEmbeddedPolymarketTypedDataRequest({
          context,
          typedData: request.body.typedData,
          id: request.body.id,
          label: request.body.label,
          depositWalletBatchPurpose: request.body.depositWalletBatchPurpose,
        });
        const signature = await executeEmbeddedPolymarketTypedDataRequest({
          request: authorizationRequest,
          authorizationSignature: request.body.authorizationSignature,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, signature });
      } catch (error) {
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to sign typed data",
        });
      }
    },
  );

  /**
   * POST /orders/sync
   * Fetch open orders from Polymarket CLOB using stored L2 credentials and upsert them into `orders`.
   */
  z.post(
    "/orders/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketOrdersSyncBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const authWalletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body ?? {};
      const requestedOrderIds = normalizePolymarketOrdersSyncOrderIds(
        body.orderIds,
      );
      const targetWalletAddress = body.targetWalletAddress ?? null;
      const signerResolution =
        await resolvePolymarketOrdersSyncSignerCandidates({
          userId: user.id,
          authWalletAddress,
          orderIds: requestedOrderIds,
          targetWalletAddress,
        });
      const signerCandidates = signerResolution.signers;

      if (
        signerCandidates.length === 0 &&
        signerResolution.authFallbackSigner == null
      ) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "polymarket",
          walletAddress: authWalletAddress ?? targetWalletAddress,
          skipped: true,
          reason: "missing_credentials",
          targetedAuthFallback: false,
          ...emptyPolymarketOrdersSyncStats(),
        });
      }

      let usedCredentials = false;
      let targetedAuthFallback = false;
      let aggregate = emptyPolymarketOrdersSyncStats();
      const syncedSigners: string[] = [];

      for (const signer of signerCandidates) {
        const creds = await AuthService.getVenueCredentials(
          user.id,
          "polymarket",
          signer,
        );
        if (
          !creds ||
          !creds.apiKey ||
          !creds.apiSecret ||
          !creds.apiPassphrase
        ) {
          continue;
        }
        usedCredentials = true;

        const result = await syncPolymarketOrdersForSigner({
          userId: user.id,
          signer,
          creds: {
            apiKey: creds.apiKey,
            apiSecret: creds.apiSecret,
            apiPassphrase: creds.apiPassphrase,
            funderAddress: creds.funderAddress ?? null,
          },
          authWalletAddress,
          requestedOrderIds,
          targetWalletAddress,
          log: app.log,
        });
        if (!result.ok) {
          if (result.kind === "credentials_invalid") {
            return sendPolymarketCredentialsInvalidResponse(reply, {
              status: result.status,
              payload: result.payload,
            });
          }
          reply.code(502);
          return reply.send({
            error: "Polymarket orders sync failed",
            status: result.status,
            tried: result.tried,
            payload: result.payload,
          });
        }

        syncedSigners.push(result.signer);
        aggregate = mergePolymarketOrdersSyncStats(aggregate, result.stats);
      }

      const fallbackSigner = signerResolution.authFallbackSigner;
      if (
        !usedCredentials &&
        fallbackSigner &&
        !signerCandidates.some(
          (signer) => signer.toLowerCase() === fallbackSigner.toLowerCase(),
        )
      ) {
        const creds = await AuthService.getVenueCredentials(
          user.id,
          "polymarket",
          fallbackSigner,
        );
        if (creds?.apiKey && creds.apiSecret && creds.apiPassphrase) {
          usedCredentials = true;
          targetedAuthFallback = true;
          const result = await syncPolymarketOrdersForSigner({
            userId: user.id,
            signer: fallbackSigner,
            creds: {
              apiKey: creds.apiKey,
              apiSecret: creds.apiSecret,
              apiPassphrase: creds.apiPassphrase,
              funderAddress: creds.funderAddress ?? null,
            },
            authWalletAddress,
            requestedOrderIds,
            targetWalletAddress,
            log: app.log,
          });
          if (!result.ok) {
            if (result.kind === "credentials_invalid") {
              return sendPolymarketCredentialsInvalidResponse(reply, {
                status: result.status,
                payload: result.payload,
              });
            }
            reply.code(502);
            return reply.send({
              error: "Polymarket orders sync failed",
              status: result.status,
              tried: result.tried,
              payload: result.payload,
            });
          }
          syncedSigners.push(result.signer);
          aggregate = mergePolymarketOrdersSyncStats(aggregate, result.stats);
        }
      }

      if (!usedCredentials) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "polymarket",
          walletAddress: authWalletAddress ?? targetWalletAddress,
          skipped: true,
          reason: "missing_credentials",
          targetedAuthFallback,
          ...emptyPolymarketOrdersSyncStats(),
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        walletAddress: syncedSigners[0] ?? authWalletAddress,
        syncedSigners,
        targetedAuthFallback,
        ...aggregate,
      });
    },
  );

  /**
   * GET /orders/open
   * Fetch open orders directly from Polymarket CLOB (no DB writes).
   */
  z.get(
    "/orders/open",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: polymarketOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket open orders require an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.code(400);
        return reply.send({
          error: "Polymarket credentials not found (connect first)",
        });
      }

      const query = request.query;
      const params = new URLSearchParams();

      const assetId = query.assetId ?? query.asset_id;
      if (assetId) params.set("asset_id", assetId);
      if (query.market) params.set("market", query.market);
      if (query.id) params.set("id", query.id);

      const requestPath = params.toString().length
        ? `/data/orders?${params.toString()}`
        : "/data/orders";

      const upstream = await polymarketL2Request({
        baseUrl: env.polymarketClobBase,
        timeoutMs: 10_000,
        address: signer,
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
        method: "GET",
        requestPath,
      });

      if (!upstream.ok) {
        if (
          await invalidatePolymarketCredentialsForInvalidApiKey({
            userId: user.id,
            signer,
            endpoint: "orders/open",
            upstream,
            log: request.log,
          })
        ) {
          return sendPolymarketCredentialsInvalidResponse(reply, upstream);
        }

        reply.code(502);
        return reply.send({
          error: "Polymarket open orders failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const orders = extractOrderArray(upstream.payload);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        count: orders.length,
        orders,
      });
    },
  );

  /**
   * POST /balance-allowance/sync
   * Refresh Polymarket's CLOB balance cache after wallet funding/approvals.
   */
  z.post(
    "/balance-allowance/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketBalanceAllowanceSyncBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket balance sync requires an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.code(400);
        return reply.send({
          error: "Polymarket credentials not found (connect first)",
        });
      }

      const body = request.body;
      const params = new URLSearchParams({
        asset_type: body.assetType,
      });
      if (body.signatureType != null) {
        params.set("signature_type", body.signatureType.toString());
      }
      if (body.tokenId) {
        params.set("token_id", body.tokenId);
      }

      const upstream = await polymarketL2Request({
        baseUrl: env.polymarketClobBase,
        timeoutMs: 10_000,
        address: signer,
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
        method: "GET",
        requestPath: `/balance-allowance/update?${params.toString()}`,
      });

      if (!upstream.ok) {
        if (
          await invalidatePolymarketCredentialsForInvalidApiKey({
            userId: user.id,
            signer,
            endpoint: "balance-allowance/sync",
            upstream,
            log: request.log,
          })
        ) {
          return sendPolymarketCredentialsInvalidResponse(reply, upstream);
        }

        const responseStatus =
          upstream.status >= 500
            ? 502
            : upstream.status >= 400
              ? upstream.status
              : 400;
        reply.code(responseStatus);
        return reply.send({
          error: "Polymarket balance sync failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        assetType: body.assetType,
        signatureType: body.signatureType ?? null,
        tokenId: body.tokenId ?? null,
        payload: upstream.payload,
      });
    },
  );

  /**
   * POST /order
   * Place a signed Polymarket order using stored L2 credentials.
   */
  z.post(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketPlaceOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket order placement requires an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.code(400);
        return reply.send({
          error: "Polymarket credentials not found (connect first)",
        });
      }

      const body = request.body;
      const order = body.order;

      const funder = creds.funderAddress ?? signer;
      const walletValidation = validatePolymarketOrderWallets({
        order,
        selectedSigner: signer,
        configuredFunder: funder,
      });
      if (!walletValidation.ok) {
        reply.code(400);
        return reply.send({ error: walletValidation.error });
      }

      const side = normalizeOrderSide(order.side);
      if (!side) {
        reply.code(400);
        return reply.send({
          error: "Order side must be BUY/SELL (or 0/1)",
        });
      }
      const positionWalletAddress =
        typeof body.positionWalletAddress === "string" &&
        body.positionWalletAddress.trim()
          ? body.positionWalletAddress.trim()
          : null;
      if (positionWalletAddress && side === "SELL") {
        const normalizedPositionWallet = positionWalletAddress.toLowerCase();
        if (
          normalizedPositionWallet !== signer.toLowerCase() &&
          normalizedPositionWallet !== funder.toLowerCase()
        ) {
          reply.code(400);
          return reply.send({
            error:
              "positionWalletAddress must match the signer or Polymarket funder",
          });
        }
      }

      const orderType = normalizeOrderTypeForClob(body.orderType);
      const orderTokenId = extractTokenId(order);
      const isClobV2Order = isPolymarketOrderPayloadV2(order);
      if (!isClobV2Order) {
        reply.code(400);
        return reply.send({
          error:
            "Polymarket CLOB V1 order payloads are no longer supported. Build and sign a CLOB V2 order with timestamp, metadata, and builder fields.",
        });
      }
      const feePolicySnapshot = await resolvePolymarketFeePolicySnapshot(pool);
      const builderFeeConfig = {
        active: feePolicySnapshot.collectionMode === "builder",
        builderCode: feePolicySnapshot.builderCode,
        takerFeeBps: feePolicySnapshot.builderTakerFeeBps,
        makerFeeBps: feePolicySnapshot.builderMakerFeeBps,
      };
      const builderValidation = validatePolymarketOrderBuilderCodeForConfig(
        typeof order.builder === "string" ? order.builder : null,
        builderFeeConfig,
      );
      if (!builderValidation.ok) {
        reply.code(400);
        return reply.send({ error: builderValidation.error });
      }
      let marketInfo = null;
      if (orderTokenId) {
        marketInfo = await fetchPolymarketMarketInfo(pool, {
          tokenId: orderTokenId,
        });
      }

      const normalizedOrder = normalizeOrderForPayload(order, side);
      const normalizedForHash = normalizeOrderForHash(order, side);
      if (normalizedOrder.expiration == null) {
        normalizedOrder.expiration = "0";
      }
      const orderPayload = normalizedForHash ?? normalizedOrder;

      const exchangeAddress =
        (typeof body.exchangeAddress === "string" &&
          body.exchangeAddress.trim()) ||
        exchangeAddressForNegRisk(
          body.negRisk ?? marketInfo?.neg_risk ?? null,
        ) ||
        env.polymarketExchangeAddress;
      let orderHash = "";
      const feeBps: number | null = null;
      const feeDeadline: number | null = null;
      const feeAuthStored: Record<string, unknown> | null = null;

      if (!normalizedForHash) {
        reply.code(400);
        return reply.send({
          error: "Order payload is missing required hash fields",
        });
      }

      if (side === "SELL") {
        const requestedSharesRaw = parseBigIntValue(
          normalizedForHash.makerAmount,
        );
        const sellTokenId = normalizedForHash.tokenId;
        if (
          requestedSharesRaw != null &&
          requestedSharesRaw > 0n &&
          sellTokenId
        ) {
          const balances = await fetchErc1155BalancesByOwner({
            rpcUrl: env.polygonRpcUrl,
            timeoutMs: env.polygonRpcTimeoutMs,
            contractAddress: env.polymarketConditionalTokensAddress,
            owner: funder,
            tokenIds: [sellTokenId],
          });
          const availableSharesRaw = balances.get(sellTokenId) ?? 0n;
          if (availableSharesRaw < requestedSharesRaw) {
            reply.code(400);
            return reply.send({
              error: "Polymarket position balance changed",
              code: POLYMARKET_SELL_BALANCE_CHANGED_CODE,
              tokenId: sellTokenId,
              owner: funder,
              availableSharesRaw: availableSharesRaw.toString(),
              requestedSharesRaw: requestedSharesRaw.toString(),
              availableShares: ethers.formatUnits(availableSharesRaw, 6),
              requestedShares: ethers.formatUnits(requestedSharesRaw, 6),
            });
          }
        }
      }

      orderHash = await fetchPolymarketOrderHashV2({
        rpcUrl: env.polygonRpcUrl,
        timeoutMs: env.polygonRpcTimeoutMs,
        exchangeAddress,
        order: normalizedForHash,
      });

      const payload = {
        order: normalizedOrder,
        owner: creds.apiKey,
        orderType,
        ...(body.deferExec !== undefined ? { deferExec: body.deferExec } : {}),
      };
      const clobCreds = {
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        apiPassphrase: creds.apiPassphrase,
      };

      const submitOrder = () =>
        polymarketL2Request({
          baseUrl: env.polymarketClobBase,
          timeoutMs: 10_000,
          address: signer,
          creds: clobCreds,
          method: "POST",
          requestPath: "/order",
          body: payload,
        });

      let upstream = await submitOrder();
      for (
        let attempt = 0;
        !upstream.ok &&
        isPolymarketServiceNotReadyResponse(upstream) &&
        attempt < POLYMARKET_ORDER_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        const delayMs = POLYMARKET_ORDER_RETRY_DELAYS_MS[attempt] ?? 0;
        request.log.warn(
          {
            upstreamStatus: upstream.status,
            upstreamPayload: upstream.payload,
            signer,
            funder,
            tokenId: orderTokenId,
            orderType,
            orderHash,
            retryAttempt: attempt + 1,
            retryDelayMs: delayMs,
          },
          "Polymarket order service not ready; retrying same signed order",
        );
        await sleep(delayMs);
        upstream = await submitOrder();
      }

      if (!upstream.ok) {
        if (
          await invalidatePolymarketCredentialsForInvalidApiKey({
            userId: user.id,
            signer,
            endpoint: "order",
            upstream,
            log: request.log,
          })
        ) {
          return sendPolymarketCredentialsInvalidResponse(reply, upstream);
        }

        const upstreamMessage = extractPolymarketUpstreamMessage(
          upstream.payload,
        );
        request.log.warn(
          {
            upstreamStatus: upstream.status,
            upstreamMessage,
            upstreamPayload: upstream.payload,
            signer,
            funder,
            tokenId: orderTokenId,
            orderType,
          },
          "Polymarket order placement upstream failed",
        );
        const responseStatus =
          upstream.status >= 500
            ? 502
            : upstream.status >= 400
              ? upstream.status
              : 400;
        reply.code(responseStatus);
        return reply.send({
          error: "Polymarket order placement failed",
          ...(isPolymarketDepositWalletRequiredMessage(upstreamMessage)
            ? {
                code: "polymarket_deposit_wallet_required",
                message:
                  "This Polymarket wallet must trade through its deposit wallet. Configure the deposit wallet funder and retry.",
              }
            : {}),
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      if (isRecord(upstream.payload) && upstream.payload.success === false) {
        reply.code(400);
        return reply.send({
          error: "Polymarket order rejected",
          payload: upstream.payload,
        });
      }

      const venueOrderId = extractOrderId(upstream.payload);
      if (!venueOrderId) {
        reply.code(502);
        return reply.send({
          error: "Polymarket order placed but no orderId returned",
          payload: upstream.payload,
        });
      }

      const tokenId = extractTokenId(order);
      const { price, size } = derivePriceAndSize(order, side);
      const statusRaw =
        extractPolymarketOrderStatus(upstream.payload) ?? "submitted";
      const immediateFill = extractPolymarketImmediateFill({
        payload: upstream.payload,
        side,
        status: statusRaw,
        fallbackPrice: price,
        fallbackSize: size,
      });
      const shouldConfirmImmediateExecution =
        orderType === "FOK" &&
        (isImmediateExecutionStatus(statusRaw) ||
          immediateFill?.fromPayload === true);

      let status = statusRaw;
      if (shouldConfirmImmediateExecution) {
        const makerAmount = parseBigIntValue(normalizedForHash.makerAmount);
        if (makerAmount != null && makerAmount > 0n) {
          try {
            const execution = await waitForPolymarketExecutionConfirmation({
              exchangeAddress,
              orderHash,
              makerAmount,
              orderPayloadVersion:
                resolvePolymarketOrderPayloadVersion(orderPayload),
            });
            status = execution?.hasExecution
              ? "matched"
              : POLYMARKET_UNCONFIRMED_STATUS;
          } catch (error) {
            request.log.warn(
              {
                error,
                userId: user.id,
                signer,
                funder,
                tokenId,
                orderHash,
              },
              "Polymarket submit-time on-chain confirmation failed",
            );
            status = POLYMARKET_UNCONFIRMED_STATUS;
          }
        } else {
          status = POLYMARKET_UNCONFIRMED_STATUS;
        }
      }

      const stored = await storeOrder(pool, {
        userId: user.id,
        walletAddress: funder,
        signerAddress: signer,
        venue: "polymarket",
        venueOrderId,
        tokenId,
        side,
        orderType,
        price,
        size,
        status,
        errorMessage: null,
        rawError: null,
        orderPayload,
        orderPayloadVersion: resolvePolymarketOrderPayloadVersion(orderPayload),
        orderHash,
        feeBps,
        feeAuth: feeAuthStored,
        feeAuthSig: null,
        feeCollectorAddress: null,
        feeDeadline,
        feePolicySnapshot,
      });

      const referralFirstTrade =
        stored.kind === "stored" && status === "matched"
          ? await tryRecordReferralFirstTradeConversion(pool, {
              userId: user.id,
              venue: "polymarket",
              status,
              sourceType: "order",
              sourceId: venueOrderId,
              txHash: orderHash,
              logger: app.log,
            })
          : null;

      if (
        stored.kind === "stored" &&
        status === "matched" &&
        tokenId &&
        immediateFill
      ) {
        const optimisticPositionWalletAddress =
          side === "SELL" && positionWalletAddress
            ? positionWalletAddress
            : funder;
        try {
          await applyOptimisticPositionTrade(pool, {
            userId: user.id,
            walletAddress: optimisticPositionWalletAddress,
            venue: "polymarket",
            tokenId,
            side,
            shares: immediateFill.shares,
            notionalUsd: immediateFill.notionalUsd,
          });
        } catch (error) {
          app.log.warn(
            {
              error,
              userId: user.id,
              walletAddress: optimisticPositionWalletAddress,
              funder,
              tokenId,
              side,
            },
            "Polymarket optimistic position update failed",
          );
        }
      }

      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: user.id,
          venue: "polymarket",
          status,
          side,
          size,
          price,
          orderId: venueOrderId,
          tokenId,
          walletAddress: funder,
        }),
        app.log,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        orderId: venueOrderId,
        orderHash,
        status,
        stored: stored.kind,
        referralFirstTrade: referralFirstTrade ?? undefined,
        payload: upstream.payload,
      });
    },
  );

  /**
   * DELETE /order
   * Cancel a Polymarket order by venue order ID.
   */
  z.delete(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketCancelOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const requestedWalletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const storedOrderWalletContext = await fetchStoredOrderWalletContext(
        pool,
        {
          userId: user.id,
          venue: "polymarket",
          venueOrderId: request.body.orderID,
        },
      );

      const signerCandidates = buildPolymarketCancelSignerCandidates({
        requestedWalletAddress,
        storedSignerAddress: storedOrderWalletContext?.signerAddress,
        storedWalletAddress: storedOrderWalletContext?.walletAddress,
      });

      if (signerCandidates.length === 0) {
        reply.code(400);
        return reply.send({
          error: "Polymarket cancel requires an EVM signer wallet address",
        });
      }

      let resolvedSigner: string | null = null;
      let resolvedPayload: unknown = null;
      let lastUpstreamFailure: { status: number; payload: unknown } | null =
        null;
      let lastInvalidCredentialsFailure: {
        status: number;
        payload: unknown;
      } | null = null;
      let lastCancelRejection: {
        creds: PolymarketL2Credentials;
        signer: string;
        reason: string;
        payload: unknown;
      } | null = null;
      let hasPolymarketCredentials = false;

      for (const signer of signerCandidates) {
        const creds = await AuthService.getVenueCredentials(
          user.id,
          "polymarket",
          signer,
        );
        if (
          !creds ||
          !creds.apiKey ||
          !creds.apiSecret ||
          !creds.apiPassphrase
        ) {
          continue;
        }
        hasPolymarketCredentials = true;

        const upstream = await polymarketL2Request({
          baseUrl: env.polymarketClobBase,
          timeoutMs: 10_000,
          address: signer,
          creds: {
            apiKey: creds.apiKey,
            apiSecret: creds.apiSecret,
            apiPassphrase: creds.apiPassphrase,
          },
          method: "DELETE",
          requestPath: "/order",
          body: { orderID: request.body.orderID },
        });

        if (!upstream.ok) {
          if (
            await invalidatePolymarketCredentialsForInvalidApiKey({
              userId: user.id,
              signer,
              endpoint: "order/cancel",
              upstream,
              log: request.log,
            })
          ) {
            lastInvalidCredentialsFailure = {
              status: upstream.status,
              payload: upstream.payload,
            };
            continue;
          }

          lastUpstreamFailure = {
            status: upstream.status,
            payload: upstream.payload,
          };
          continue;
        }

        const cancelSummary = summarizePolymarketCancelPayload({
          payload: upstream.payload,
          orderId: request.body.orderID,
        });

        if (cancelSummary.isCanceled) {
          resolvedSigner = signer;
          resolvedPayload = upstream.payload;
          break;
        }

        if (cancelSummary.notCanceledReason) {
          lastCancelRejection = {
            creds: {
              apiKey: creds.apiKey,
              apiSecret: creds.apiSecret,
              apiPassphrase: creds.apiPassphrase,
            },
            signer,
            reason: cancelSummary.notCanceledReason,
            payload: upstream.payload,
          };
        }
      }

      if (!resolvedSigner) {
        if (!hasPolymarketCredentials) {
          reply.code(400);
          return reply.send({
            error: "Polymarket credentials not found (connect first)",
          });
        }

        if (lastCancelRejection) {
          if (isPolymarketAlreadyClosedReason(lastCancelRejection.reason)) {
            const fallbackStatusHint = resolvePolymarketClosedReasonHint(
              lastCancelRejection.reason,
            );
            const clobOrderEvidence =
              await fetchPolymarketClobOrderExecutionEvidence({
                creds: lastCancelRejection.creds,
                log: request.log,
                orderId: request.body.orderID,
                signer: lastCancelRejection.signer,
              });
            let tradeSync: Awaited<
              ReturnType<typeof syncPolymarketTradesForSigner>
            > | null = null;
            if (clobOrderEvidence.hasExecution) {
              try {
                tradeSync = await syncPolymarketTradesForSigner(pool, {
                  userId: user.id,
                  signerAddress: lastCancelRejection.signer,
                });
              } catch (error) {
                app.log.error(
                  {
                    error,
                    userId: user.id,
                    signer: lastCancelRejection.signer,
                    orderId: request.body.orderID,
                  },
                  "Polymarket trade sync before cancel reconcile failed",
                );
              }
              if (
                !(await hasPolymarketVenueOrderExecutionEvidence({
                  userId: user.id,
                  venueOrderId: request.body.orderID,
                }))
              ) {
                const markedUnconfirmed =
                  await markPolymarketDelayedOrderUnconfirmed({
                    userId: user.id,
                    venueOrderId: request.body.orderID,
                  });
                reply.header("Content-Type", "application/json; charset=utf-8");
                return reply.send({
                  ok: true,
                  venue: "polymarket",
                  orderId: request.body.orderID,
                  signer: lastCancelRejection.signer,
                  status: POLYMARKET_UNCONFIRMED_STATUS,
                  reconciled: false,
                  pendingReconcile: true,
                  changed: markedUnconfirmed,
                  reason: lastCancelRejection.reason,
                  payload: lastCancelRejection.payload,
                  orderStatusPayload: clobOrderEvidence.payload ?? undefined,
                  tradeSync: tradeSync ?? undefined,
                });
              }
            }
            const statusHint =
              clobOrderEvidence.statusHint ?? fallbackStatusHint;
            const allowMissingOrderNoFill =
              isPolymarketClobNoFillTerminalStatus(
                clobOrderEvidence.orderStatus,
              ) &&
              (await isPolymarketOrderNoFillGraceElapsed({
                userId: user.id,
                venueOrderId: request.body.orderID,
              }));
            const terminalNoFillStatus =
              resolvePolymarketClobNoFillTerminalStatus(
                clobOrderEvidence.orderStatus,
              );
            let reconciled = await reconcilePolymarketTerminalOrder({
              userId: user.id,
              venueOrderId: request.body.orderID,
              statusHint,
              externalFilledSize: clobOrderEvidence.externalFilledSize,
              externalFillPrice: clobOrderEvidence.externalFillPrice,
              externalHasExecution: clobOrderEvidence.hasExecution,
              skipOnchainExecutionCheck: true,
              allowAmbiguousNoFillReconcile: allowMissingOrderNoFill,
              allowExternalExecutionEvidence: false,
              terminalNoFillStatus,
            });
            if (!reconciled || reconciled.status === "matched") {
              try {
                tradeSync ??= await syncPolymarketTradesForSigner(pool, {
                  userId: user.id,
                  signerAddress: lastCancelRejection.signer,
                });
                if (!reconciled && tradeSync.insertedFillCount > 0) {
                  reconciled = await reconcilePolymarketTerminalOrder({
                    userId: user.id,
                    venueOrderId: request.body.orderID,
                    statusHint,
                    externalFilledSize: clobOrderEvidence.externalFilledSize,
                    externalFillPrice: clobOrderEvidence.externalFillPrice,
                    externalHasExecution: clobOrderEvidence.hasExecution,
                    skipOnchainExecutionCheck: true,
                    allowAmbiguousNoFillReconcile: allowMissingOrderNoFill,
                    allowExternalExecutionEvidence: false,
                    terminalNoFillStatus,
                  });
                }
              } catch (error) {
                app.log.error(
                  {
                    error,
                    userId: user.id,
                    signer: lastCancelRejection.signer,
                    orderId: request.body.orderID,
                  },
                  "Polymarket trade sync after cancel reconcile failed",
                );
              }
            }

            if (!reconciled) {
              const markedUnconfirmed =
                await markPolymarketDelayedOrderUnconfirmed({
                  userId: user.id,
                  venueOrderId: request.body.orderID,
                });
              reply.header("Content-Type", "application/json; charset=utf-8");
              return reply.send({
                ok: true,
                venue: "polymarket",
                orderId: request.body.orderID,
                signer: lastCancelRejection.signer,
                status: POLYMARKET_UNCONFIRMED_STATUS,
                reconciled: false,
                pendingReconcile: true,
                changed: markedUnconfirmed,
                reason: lastCancelRejection.reason,
                payload: lastCancelRejection.payload,
                orderStatusPayload: clobOrderEvidence.payload ?? undefined,
                tradeSync: tradeSync ?? undefined,
              });
            }

            const reconciledStatus = reconciled.status;
            const shouldEmitCancelPathNotification =
              reconciledStatus !== "matched";

            if (shouldEmitCancelPathNotification) {
              void createNotificationSafe(
                pool,
                buildOrderNotification({
                  userId: user.id,
                  venue: "polymarket",
                  status: reconciledStatus,
                  side: reconciled?.side ?? null,
                  size: reconciled?.size ?? null,
                  price: reconciled?.price ?? null,
                  orderId: request.body.orderID,
                  tokenId: reconciled?.tokenId ?? null,
                  walletAddress:
                    reconciled?.walletAddress ?? lastCancelRejection.signer,
                }),
                app.log,
              );
            }
            reply.header("Content-Type", "application/json; charset=utf-8");
            return reply.send({
              ok: true,
              venue: "polymarket",
              orderId: request.body.orderID,
              signer: lastCancelRejection.signer,
              status: reconciledStatus ?? "cancelled",
              reconciled: true,
              changed: true,
              payload: lastCancelRejection.payload,
              orderStatusPayload: clobOrderEvidence.payload ?? undefined,
              tradeSync: tradeSync ?? undefined,
            });
          }

          reply.code(409);
          return reply.send({
            error: "Polymarket cancel rejected",
            signer: lastCancelRejection.signer,
            reason: lastCancelRejection.reason,
            payload: lastCancelRejection.payload,
          });
        }

        if (lastInvalidCredentialsFailure) {
          return sendPolymarketCredentialsInvalidResponse(
            reply,
            lastInvalidCredentialsFailure,
          );
        }

        if (lastUpstreamFailure) {
          reply.code(502);
          return reply.send({
            error: "Polymarket cancel failed",
            status: lastUpstreamFailure.status,
            payload: lastUpstreamFailure.payload,
          });
        }

        reply.code(502);
        return reply.send({
          error: "Polymarket cancel failed",
        });
      }

      const cancelUpdate = await pool.query(
        `
          update orders o
          set status = 'cancelled',
              cancelled_at = coalesce(cancelled_at, now()),
              last_update = now()
          where o.user_id = $1
            and o.venue = 'polymarket'
            and o.venue_order_id = $2
            and lower(coalesce(o.status, '')) in (
              'pending',
              'submitted',
              'live',
              'open',
              'delayed',
              'unconfirmed',
              'partially_filled'
            )
        `,
        [user.id, request.body.orderID],
      );

      if ((cancelUpdate.rowCount ?? 0) > 0) {
        void createNotificationSafe(
          pool,
          buildOrderNotification({
            userId: user.id,
            venue: "polymarket",
            status: "cancelled",
            orderId: request.body.orderID,
            walletAddress: resolvedSigner,
          }),
          app.log,
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        orderId: request.body.orderID,
        signer: resolvedSigner,
        status: "cancelled",
        changed: (cancelUpdate.rowCount ?? 0) > 0,
        payload: resolvedPayload,
      });
    },
  );
};
