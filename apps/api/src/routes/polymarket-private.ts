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
  polymarketOpenOrdersQuerySchema,
  polymarketPlaceOrderBodySchema,
  polymarketQuoteBodySchema,
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
import { derivePolymarketFunders } from "../services/polymarket-funder.js";
import { requestPolymarketCredentials } from "../services/polymarket-credentials.js";
import { polymarketClient } from "../services/polymarket-client.js";
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
  POLYMARKET_UNCONFIRMED_STATUS,
  isPolymarketUnconfirmedStatus,
  resolvePolymarketUnconfirmedStatus,
  summarizePolymarketOnchainOrderExecution,
} from "../services/polymarket-order-execution.js";
import { syncPolymarketTradesForSigner } from "../services/positions-sync.js";
import {
  extractOrderArray,
  extractOrderId,
  extractTokenId,
  normalizeOpenOrder,
  polymarketL2Request,
} from "../services/polymarket-clob-l2.js";
import {
  calculatePolymarketBuilderFeeRaw,
  resolvePolymarketFeePolicySnapshot,
  validatePolymarketOrderBuilderCodeForConfig,
} from "../services/polymarket-builder-fees.js";

const POLY_DECIMALS = 6;
const MARKET_USD_MICRO_STEP = 10_000n; // 2 decimals in 6-decimal USDC
const MARKET_USD_MICRO_STEP_5_DEC = 10n; // 5 decimals in 6-decimal USDC
const MARKET_SHARES_MICRO_STEP = 100n; // 4 decimals in 6-decimal share units
const MARKET_SHARES_MICRO_STEP_2_DEC = 10_000n; // 2 decimals in 6-decimal share units
const LIMIT_USD_MICRO_STEP = 100n; // 4 decimals in 6-decimal USDC
const LIMIT_SHARES_MICRO_STEP = 10_000n; // 2 decimals in 6-decimal share units
const POLYMARKET_SUBMIT_SETTLEMENT_ATTEMPTS = 5;
const POLYMARKET_SUBMIT_SETTLEMENT_DELAY_MS = 800;
const POLYMARKET_UNCONFIRMED_LIMIT = 25;
const EMBEDDED_APPROVAL_THRESHOLD = 1n << 255n;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const POLYMARKET_SELL_BALANCE_CHANGED_CODE = "POLYMARKET_SELL_BALANCE_CHANGED";
const POLYMARKET_CREDENTIALS_INVALID_CODE =
  "polymarket_credentials_invalid";

function feeBaseRawForSide(
  side: "BUY" | "SELL",
  makerAmountRaw: bigint,
  takerAmountRaw: bigint,
): bigint {
  return side === "BUY" ? makerAmountRaw : takerAmountRaw;
}

function readFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function calculatePolymarketPlatformFeeRaw(inputs: {
  sizeRaw: bigint;
  price: number;
  feeRate: number;
  feeExponent: number;
}): bigint {
  const { sizeRaw, price, feeRate, feeExponent } = inputs;
  if (
    sizeRaw <= 0n ||
    !Number.isFinite(price) ||
    price <= 0 ||
    price >= 1 ||
    !Number.isFinite(feeRate) ||
    feeRate <= 0 ||
    !Number.isFinite(feeExponent) ||
    feeExponent < 0
  ) {
    return 0n;
  }
  const size = Number(sizeRaw) / 1_000_000;
  const term = Math.pow(price * (1 - price), feeExponent);
  const feeMicro = Math.ceil(size * feeRate * term * 1_000_000);
  return Number.isFinite(feeMicro) && feeMicro > 0
    ? BigInt(feeMicro)
    : 0n;
}

async function fetchPolymarketPlatformFeeCurve(
  conditionId: string | null | undefined,
): Promise<{ rate: number; exponent: number } | null> {
  if (!conditionId) return null;
  const payload = await polymarketClient.getClobMarketInfo(conditionId);
  if (!isRecord(payload) || !isRecord(payload.fd)) return null;
  const rate = readFiniteNumber(payload.fd.r);
  const exponent = readFiniteNumber(payload.fd.e);
  if (rate == null || exponent == null) return null;
  return { rate, exponent };
}

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
type OrderbookSummary = {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
};

type PolymarketUnconfirmedRow = {
  id: string;
  token_id: string | null;
  order_hash: string | null;
  order_payload: unknown | null;
  order_payload_version: string | null;
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
    normalized.includes("can't be found") ||
    normalized.includes("cannot be found")
  );
}

async function reconcilePolymarketTerminalOrder(inputs: {
  userId: string;
  venueOrderId: string;
}): Promise<{
  status: "matched" | "cancelled";
  tokenId: string | null;
  side: string | null;
  size: number | null;
  price: number | null;
} | null> {
  const { rows } = await pool.query<{
    id: string;
    token_id: string | null;
    side: string | null;
    price: number | null;
    size: number | null;
    order_hash: string | null;
    order_payload: unknown | null;
    filled_size: number | null;
    average_fill_price: number | null;
  }>(
    `
      select
        id,
        token_id,
        side,
        price,
        size,
        order_hash,
        order_payload,
        filled_size,
        average_fill_price
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

  let nextStatus: "matched" | "cancelled" = "cancelled";
  const orderHash = row.order_hash?.trim() ?? null;
  const makerAmount = readMakerAmountFromOrderPayload(row.order_payload);

  if (orderHash && makerAmount != null && makerAmount > 0n) {
    const exchangeAddress = await resolvePolymarketOrderExchangeAddress({
      tokenId: row.token_id?.trim() || null,
    });
    const summary = await fetchPolymarketExecutionSummary({
      exchangeAddress,
      orderHash,
      makerAmount,
    });
    if (summary.hasExecution) {
      nextStatus = "matched";
    }
  } else if ((row.filled_size ?? 0) > 0 || row.average_fill_price != null) {
    nextStatus = "matched";
  }

  await pool.query(
    `
      update orders
      set status = $2,
          cancelled_at = case when $2 = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end,
          filled_at = case when $2 = 'matched' then coalesce(filled_at, now()) else filled_at end,
          last_update = now()
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $3
    `,
    [inputs.userId, nextStatus, inputs.venueOrderId],
  );

  return {
    status: nextStatus,
    tokenId: row.token_id ?? null,
    side: row.side ?? null,
    size: row.filled_size ?? row.size ?? null,
    price: row.average_fill_price ?? row.price ?? null,
  };
}

const USDC_SCALE = 1_000_000n;

function ceilDivRaw(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
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

function parseOrderbookSide(
  side: unknown,
): Array<{ price: number; size: number }> {
  if (!Array.isArray(side)) return [];
  const entries: Array<{ price: number; size: number }> = [];
  for (const row of side) {
    if (!isRecord(row)) continue;
    const price = parseNumberish(row.price);
    const size = parseNumberish(row.size);
    if (price == null || size == null) continue;
    entries.push({ price, size });
  }
  return entries;
}

function extractOrderbookSummary(payload: unknown): OrderbookSummary | null {
  if (!isRecord(payload)) return null;
  const raw = isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(raw)) return null;

  const bidsRaw = Array.isArray(raw.bids)
    ? raw.bids
    : Array.isArray(raw.buys)
      ? raw.buys
      : [];
  const asksRaw = Array.isArray(raw.asks)
    ? raw.asks
    : Array.isArray(raw.sells)
      ? raw.sells
      : [];

  const bids = parseOrderbookSide(bidsRaw);
  const asks = parseOrderbookSide(asksRaw);

  const tickSize =
    parseNumberish(
      raw.tick_size ?? raw.tickSize ?? raw.order_price_min_tick_size,
    ) ?? null;
  const minOrderSize =
    parseNumberish(
      raw.min_order_size ?? raw.minOrderSize ?? raw.order_min_size,
    ) ?? null;
  const negRisk =
    typeof raw.neg_risk === "boolean"
      ? raw.neg_risk
      : typeof raw.negRisk === "boolean"
        ? raw.negRisk
        : null;

  return { bids, asks, tickSize, minOrderSize, negRisk };
}

function findBestBid(bids: Array<{ price: number }>): number | null {
  let best: number | null = null;
  for (const bid of bids) {
    if (best == null || bid.price > best) best = bid.price;
  }
  return best;
}

function findBestAsk(asks: Array<{ price: number }>): number | null {
  let best: number | null = null;
  for (const ask of asks) {
    if (best == null || ask.price < best) best = ask.price;
  }
  return best;
}

function roundPriceToTick(
  price: number,
  tickSize: number,
  side: PolymarketSide,
): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return price;
  }
  const ticks = price / tickSize;
  const roundedTicks =
    side === "BUY" ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  return roundedTicks * tickSize;
}

function roundLimitPriceToTick(
  price: number,
  tickSize: number,
  side: PolymarketSide,
): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return price;
  }
  const ticks = price / tickSize;
  const roundedTicks =
    side === "BUY" ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9);
  return roundedTicks * tickSize;
}

const DEFAULT_POLYMARKET_PRICE_TICK = 0.01;
const POLYMARKET_SERVICE_NOT_READY_STATUS = 425;
const POLYMARKET_ORDER_RETRY_DELAYS_MS = [250, 750, 1500] as const;

function resolvePolymarketPriceTick(
  tickSize: number | null | undefined,
): number {
  if (
    tickSize != null &&
    Number.isFinite(tickSize) &&
    tickSize > 0 &&
    tickSize < 1
  ) {
    return tickSize;
  }
  return DEFAULT_POLYMARKET_PRICE_TICK;
}

function clampMarketOrderPriceToValidRange(
  price: number,
  tickSize: number | null | undefined,
): number {
  if (!Number.isFinite(price)) return price;
  const tick = resolvePolymarketPriceTick(tickSize);
  const maxTicksBelowOne = Math.max(1, Math.floor((1 - 1e-12) / tick));
  const maxPrice = Number((maxTicksBelowOne * tick).toFixed(8));
  const minPrice = tick;
  return Math.min(maxPrice, Math.max(minPrice, price));
}

function isPolymarketServiceNotReadyResponse(inputs: {
  status: number;
  payload: unknown;
}): boolean {
  if (inputs.status !== POLYMARKET_SERVICE_NOT_READY_STATUS) return false;
  const message = extractPolymarketUpstreamMessage(inputs.payload);
  if (!message) return true;
  return message.toLowerCase().includes("service not ready");
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcd(a, b)) * b;
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
    const isLiveDefault =
      !onchainStatus.filled && onchainStatus.remaining === 0n;
    return summarizePolymarketOnchainOrderExecution({
      makerAmount: inputs.makerAmount,
      remaining: isLiveDefault ? inputs.makerAmount : onchainStatus.remaining,
      isFilledOrCancelled: onchainStatus.filled,
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
  userId: string;
  signerAddress: string;
  log: { warn: (payload: unknown, message: string) => void };
}) {
  const { rows } = await pool.query<PolymarketUnconfirmedRow>(
    `
      select id, token_id, order_hash, order_payload, order_payload_version
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and status = $3
        and order_hash is not null
        and (
          lower(coalesce(signer_address, '')) = lower($2)
          or lower(coalesce(wallet_address, '')) = lower($2)
        )
      order by posted_at desc nulls last
      limit $4
    `,
    [
      inputs.userId,
      inputs.signerAddress,
      POLYMARKET_UNCONFIRMED_STATUS,
      POLYMARKET_UNCONFIRMED_LIMIT,
    ],
  );

  if (!rows.length) {
    return { checked: 0, confirmedCount: 0, unmatchedCount: 0 };
  }

  let confirmedCount = 0;
  let unmatchedCount = 0;
  const exchangeAddressByTokenId = new Map<string, string>();

  for (const row of rows) {
    const orderHash = row.order_hash?.trim();
    const makerAmount = readMakerAmountFromOrderPayload(row.order_payload);
    if (!orderHash || makerAmount == null || makerAmount <= 0n) continue;

    const tokenId = row.token_id?.trim() || null;
    let exchangeAddress =
      tokenId != null ? (exchangeAddressByTokenId.get(tokenId) ?? null) : null;
    if (!exchangeAddress) {
      exchangeAddress = await resolvePolymarketOrderExchangeAddress({
        tokenId,
      });
      if (tokenId) {
        exchangeAddressByTokenId.set(tokenId, exchangeAddress);
      }
    }

    try {
      const summary = await fetchPolymarketExecutionSummary({
        exchangeAddress,
        orderHash,
        makerAmount,
        orderPayloadVersion:
          row.order_payload_version ??
          resolvePolymarketOrderPayloadVersion(row.order_payload),
      });
      const nextStatus = resolvePolymarketUnconfirmedStatus(summary);
      if (!isPolymarketUnconfirmedStatus(nextStatus)) {
        await pool.query(
          `
            update orders
            set status = $2,
                last_update = now()
            where id = $1
              and status = $3
          `,
          [row.id, nextStatus, POLYMARKET_UNCONFIRMED_STATUS],
        );
        if (nextStatus === "matched") confirmedCount += 1;
        if (nextStatus === "unmatched") unmatchedCount += 1;
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

  return { checked: rows.length, confirmedCount, unmatchedCount };
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
      const orderType = normalizeOrderTypeForClob(body.orderType ?? "FOK");
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
        const [orderbookPayload, marketInfo, feePolicySnapshot] =
          await Promise.all([
            polymarketClient.getOrderBook(tokenId),
            fetchPolymarketMarketInfo(pool, { tokenId }),
            resolvePolymarketFeePolicySnapshot(pool),
          ]);

        const orderbook = extractOrderbookSummary(orderbookPayload);
        if (!orderbook) {
          reply.code(502);
          return reply.send({ error: "Invalid Polymarket orderbook response" });
        }

        const bestBid = findBestBid(orderbook.bids);
        const bestAsk = findBestAsk(orderbook.asks);
        const bestPrice = body.side === "BUY" ? bestAsk : bestBid;
        const isLimitOrder = orderType === "GTC" || orderType === "GTD";

        if (
          !isLimitOrder &&
          (bestPrice == null || !Number.isFinite(bestPrice))
        ) {
          reply.code(502);
          return reply.send({ error: "Missing top-of-book price" });
        }

        if (marketInfo?.accepting_orders === false) {
          reply.code(400);
          return reply.send({ error: "Market is not accepting orders" });
        }
        let platformFeeCurve: { rate: number; exponent: number } | null = null;
        try {
          platformFeeCurve = await fetchPolymarketPlatformFeeCurve(
            marketInfo?.condition_id,
          );
        } catch (error) {
          request.log.warn(
            { error, tokenId, conditionId: marketInfo?.condition_id },
            "Failed to fetch Polymarket CLOB fee curve; using local fee fallback",
          );
        }

        const topPrice = bestPrice ?? NaN;
        const slippageBps = body.slippageBps ?? null;
        let price: number = isLimitOrder ? (body.limitPrice ?? NaN) : topPrice;
        if (!isLimitOrder && slippageBps != null) {
          const multiplier =
            body.side === "BUY"
              ? 1 + slippageBps / 10_000
              : 1 - slippageBps / 10_000;
          price = topPrice * multiplier;
        }

        const tickSize =
          orderbook.tickSize ??
          (marketInfo?.order_price_min_tick_size != null
            ? Number(marketInfo.order_price_min_tick_size)
            : null);
        const priceTick = resolvePolymarketPriceTick(tickSize);
        const minOrderSize =
          orderbook.minOrderSize ??
          (marketInfo?.order_min_size != null
            ? Number(marketInfo.order_min_size)
            : null);

        price = isLimitOrder
          ? roundLimitPriceToTick(price, priceTick, body.side)
          : roundPriceToTick(price, priceTick, body.side);

        if (!isLimitOrder) {
          price = clampMarketOrderPriceToValidRange(price, priceTick);
        }

        if (!Number.isFinite(price) || price <= 0 || price >= 1) {
          reply.code(400);
          return reply.send({
            error: isLimitOrder
              ? "Polymarket limit price must be greater than 0 and less than 1"
              : "Invalid price computed from orderbook",
          });
        }

        const priceMicro = BigInt(Math.round(price * 1_000_000));
        if (priceMicro <= 0n) {
          reply.code(400);
          return reply.send({ error: "Invalid price computed from orderbook" });
        }

        let sizeMicro: bigint;
        let makerAmountMicro: bigint;
        let takerAmountMicro: bigint;

        if (orderType === "FOK") {
          const shareStep =
            body.side === "SELL"
              ? MARKET_SHARES_MICRO_STEP_2_DEC
              : MARKET_SHARES_MICRO_STEP;
          const usdcStep =
            body.side === "SELL"
              ? MARKET_USD_MICRO_STEP_5_DEC
              : MARKET_USD_MICRO_STEP;
          const precisionProduct = usdcStep * USDC_SCALE;
          const stepForPrice =
            precisionProduct / gcd(priceMicro, precisionProduct);
          const step = lcm(stepForPrice, shareStep);

          if (amountType === "shares") {
            if (amountSharesInput == null) {
              reply.code(400);
              return reply.send({
                error: "amount is required for shares quotes",
              });
            }

            const sizeMicroRaw = BigInt(
              Math.floor(amountSharesInput * 1_000_000),
            );
            sizeMicro = sizeMicroRaw - (sizeMicroRaw % step);

            if (sizeMicro <= 0n) {
              reply.code(400);
              return reply.send({ error: "Amount too small for order" });
            }

            if (body.side === "BUY") {
              makerAmountMicro = (sizeMicro * priceMicro) / USDC_SCALE;
              takerAmountMicro = sizeMicro;
            } else {
              makerAmountMicro = sizeMicro;
              takerAmountMicro = (sizeMicro * priceMicro) / USDC_SCALE;
            }
          } else {
            if (amountUsdInput == null) {
              reply.code(400);
              return reply.send({
                error: "amountUsd is required for USD quotes",
              });
            }

            const amountUsdCents = BigInt(Math.floor(amountUsdInput * 100));
            if (amountUsdCents <= 0n) {
              reply.code(400);
              return reply.send({ error: "Invalid amount or price" });
            }

            const makerAmountMicroMax = amountUsdCents * MARKET_USD_MICRO_STEP;
            const sizeMicroRaw =
              (makerAmountMicroMax * USDC_SCALE) / priceMicro;
            if (body.side === "BUY") {
              sizeMicro = sizeMicroRaw - (sizeMicroRaw % shareStep);
              if (sizeMicro <= 0n) {
                reply.code(400);
                return reply.send({ error: "Amount too small for order" });
              }
              makerAmountMicro = makerAmountMicroMax;
              takerAmountMicro = sizeMicro;
            } else {
              sizeMicro = sizeMicroRaw - (sizeMicroRaw % step);
              if (sizeMicro <= 0n) {
                reply.code(400);
                return reply.send({ error: "Amount too small for order" });
              }
              makerAmountMicro = sizeMicro;
              takerAmountMicro = (sizeMicro * priceMicro) / USDC_SCALE;
            }
          }
        } else {
          const shareStep = LIMIT_SHARES_MICRO_STEP;
          const usdcStep = LIMIT_USD_MICRO_STEP;
          const precisionProduct = usdcStep * USDC_SCALE;
          const stepForPrice =
            precisionProduct / gcd(priceMicro, precisionProduct);
          const step = lcm(stepForPrice, shareStep);

          if (amountType === "shares") {
            if (amountSharesInput == null) {
              reply.code(400);
              return reply.send({
                error: "amount is required for shares quotes",
              });
            }

            const sizeMicroRaw = BigInt(
              Math.floor(amountSharesInput * 1_000_000),
            );
            sizeMicro = sizeMicroRaw - (sizeMicroRaw % step);

            if (sizeMicro <= 0n) {
              reply.code(400);
              return reply.send({ error: "Amount too small for order" });
            }
          } else {
            if (amountUsdInput == null) {
              reply.code(400);
              return reply.send({
                error: "amountUsd is required for USD quotes",
              });
            }

            const amountUsdMicroRaw = BigInt(
              Math.floor(amountUsdInput * 1_000_000),
            );
            const amountUsdMicro =
              amountUsdMicroRaw - (amountUsdMicroRaw % usdcStep);
            if (amountUsdMicro <= 0n) {
              reply.code(400);
              return reply.send({ error: "Invalid amount or price" });
            }

            const sizeMicroRaw = (amountUsdMicro * USDC_SCALE) / priceMicro;
            sizeMicro = sizeMicroRaw - (sizeMicroRaw % step);

            if (sizeMicro <= 0n) {
              reply.code(400);
              return reply.send({ error: "Amount too small for order" });
            }
          }

          makerAmountMicro =
            body.side === "BUY"
              ? (sizeMicro * priceMicro) / USDC_SCALE
              : sizeMicro;
          takerAmountMicro =
            body.side === "BUY"
              ? sizeMicro
              : (sizeMicro * priceMicro) / USDC_SCALE;
        }

        const violatesMinOrderSize =
          isLimitOrder && minOrderSize != null
            ? sizeMicro < BigInt(Math.ceil(minOrderSize * 1_000_000))
            : null;
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
        const platformFeeBps = isLimitOrder ? makerFeeBps : takerFeeBps;
        const builderFeeBps =
          feePolicySnapshot.collectionMode === "builder"
            ? isLimitOrder
              ? feePolicySnapshot.builderMakerFeeBps
              : feePolicySnapshot.builderTakerFeeBps
            : 0;
        const effectivePlatformFeeCurve =
          platformFeeCurve ??
          (platformFeeBps > 0
            ? { rate: platformFeeBps / 10_000, exponent: 1 }
            : null);
        const feeBaseRaw = feeBaseRawForSide(
          body.side,
          makerAmountMicro,
          takerAmountMicro,
        );
        let platformFeePrice = price;
        let platformFeeSizeRaw = sizeMicro;
        if (
          body.side === "BUY" &&
          bestAsk != null &&
          Number.isFinite(bestAsk) &&
          bestAsk > 0 &&
          bestAsk < 1
        ) {
          platformFeePrice = Math.min(price, bestAsk);
          const platformFeePriceMicro = BigInt(
            Math.round(platformFeePrice * 1_000_000),
          );
          if (platformFeePriceMicro > 0n) {
            platformFeeSizeRaw = ceilDivRaw(
              makerAmountMicro * USDC_SCALE,
              platformFeePriceMicro,
            );
          }
        }
        const platformFeeEstimateRaw = effectivePlatformFeeCurve
          ? calculatePolymarketPlatformFeeRaw({
              sizeRaw: platformFeeSizeRaw,
              price: platformFeePrice,
              feeRate: effectivePlatformFeeCurve.rate,
              feeExponent: effectivePlatformFeeCurve.exponent,
            })
          : 0n;
        const builderFeeEstimateRaw = calculatePolymarketBuilderFeeRaw(
          feeBaseRaw,
          builderFeeBps,
        );
        const totalFeeEstimateRaw =
          platformFeeEstimateRaw + builderFeeEstimateRaw;
        const totalRequiredUsdcRaw =
          body.side === "BUY"
            ? makerAmountMicro + totalFeeEstimateRaw
            : null;

        const size = Number(sizeMicro) / 1_000_000;
        const amountUsdUsed =
          body.side === "BUY"
            ? Number(makerAmountMicro) / 1_000_000
            : Number(takerAmountMicro) / 1_000_000;
        const estimatedPayout = size;
        const estimatedProfit =
          body.side === "BUY"
            ? estimatedPayout - amountUsdUsed
            : amountUsdUsed - estimatedPayout;

        const negRisk =
          orderbook.negRisk ??
          (marketInfo?.neg_risk != null ? Boolean(marketInfo.neg_risk) : null);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          tokenId,
          side: body.side,
          orderType,
          amountType,
          amountUsd: amountUsdInput ?? undefined,
          amountShares: amountSharesInput ?? undefined,
          amountUsdUsed,
          bestBid,
          bestAsk,
          price,
          size,
          makerAmount: makerAmountMicro.toString(),
          takerAmount: takerAmountMicro.toString(),
          platformFeeEstimateRaw: platformFeeEstimateRaw.toString(),
          builderFeeEstimateRaw: builderFeeEstimateRaw.toString(),
          totalFeeEstimateRaw: totalFeeEstimateRaw.toString(),
          totalRequiredUsdcRaw: totalRequiredUsdcRaw?.toString() ?? null,
          builderRateSource: feePolicySnapshot.builderRateSource,
          builderEnabled: feePolicySnapshot.builderEnabled,
          builderTakerFeeBps: feePolicySnapshot.builderTakerFeeBps,
          builderMakerFeeBps: feePolicySnapshot.builderMakerFeeBps,
          orderPriceMinTickSize: tickSize,
          orderMinSize: minOrderSize,
          violatesMinOrderSize,
          negRisk,
          exchangeAddress: exchangeAddressForNegRisk(negRisk),
          estimatedPayout,
          estimatedProfit,
          slippageBps,
        });
      } catch (error) {
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
              },
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
    { preHandler: createAuthMiddleware() },
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
          error: "Polymarket orders sync requires an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "polymarket",
          walletAddress: signer,
          skipped: true,
          reason: "missing_credentials",
          changed: false,
          fetched: 0,
          storedNew: 0,
          alreadyKnown: 0,
          skippedNoId: 0,
          sampleVenueOrderIds: [],
          tradeSync: {
            insertedFillCount: 0,
            positionsRecomputed: false,
          },
        });
      }

      // Per CLOB docs, open orders live under `/data/orders` (L2 header required).
      const requestPathAll = "/data/orders";

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
        requestPath: requestPathAll,
      });

      if (!upstream.ok) {
        if (
          await invalidatePolymarketCredentialsForInvalidApiKey({
            userId: user.id,
            signer,
            endpoint: "orders/sync",
            upstream,
            log: request.log,
          })
        ) {
          return sendPolymarketCredentialsInvalidResponse(reply, upstream);
        }

        reply.code(502);
        return reply.send({
          error: "Polymarket orders sync failed",
          status: upstream.status,
          tried: { get: requestPathAll },
          payload: upstream.payload,
        });
      }

      const ordersRaw = extractOrderArray(upstream.payload);
      const funder = creds.funderAddress ?? signer;

      let storedNew = 0;
      let alreadyKnown = 0;
      let skippedNoId = 0;
      const orderIds: string[] = [];

      for (const o of ordersRaw) {
        const venueOrderId = extractOrderId(o);
        if (!venueOrderId) {
          skippedNoId += 1;
          continue;
        }
        orderIds.push(venueOrderId);

        const normalizedOpenOrder = normalizeOpenOrder(o);
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
          userId: user.id,
          walletAddress: orderWalletAddress,
          signerAddress: signer,
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
        if (result.kind === "exists") alreadyKnown += 1;
      }

      let tradeSync = {
        insertedFillCount: 0,
        positionsRecomputed: false,
      };
      try {
        tradeSync = await syncPolymarketTradesForSigner(pool, {
          userId: user.id,
          signerAddress: signer,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Polymarket trade sync during orders sync failed",
        );
      }

      let settlementSync = {
        checked: 0,
        confirmedCount: 0,
        unmatchedCount: 0,
      };
      try {
        settlementSync = await reconcileUnconfirmedOrders({
          userId: user.id,
          signerAddress: signer,
          log: app.log,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Polymarket unconfirmed order reconcile during orders sync failed",
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        walletAddress: signer,
        changed:
          storedNew > 0 ||
          tradeSync.insertedFillCount > 0 ||
          settlementSync.confirmedCount > 0 ||
          settlementSync.unmatchedCount > 0,
        fetched: ordersRaw.length,
        storedNew,
        alreadyKnown,
        skippedNoId,
        sampleVenueOrderIds: orderIds.slice(0, 10),
        tradeSync,
        settlementSync,
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
            const reconciled = await reconcilePolymarketTerminalOrder({
              userId: user.id,
              venueOrderId: request.body.orderID,
            });
            const reconciledStatus = reconciled?.status ?? "cancelled";
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
                walletAddress: lastCancelRejection.signer,
              }),
              app.log,
            );
            reply.header("Content-Type", "application/json; charset=utf-8");
            return reply.send({
              ok: true,
              venue: "polymarket",
              orderId: request.body.orderID,
              signer: lastCancelRejection.signer,
              status: reconciledStatus ?? "cancelled",
              reconciled: true,
              payload: lastCancelRejection.payload,
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

      await pool.query(
        `
          update orders
          set status = 'cancelled',
              cancelled_at = now(),
              last_update = now()
          where user_id = $1
            and venue = 'polymarket'
            and venue_order_id = $2
        `,
        [user.id, request.body.orderID],
      );

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

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        orderId: request.body.orderID,
        signer: resolvedSigner,
        payload: resolvedPayload,
      });
    },
  );
};
