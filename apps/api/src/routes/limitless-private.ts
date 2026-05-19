import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  normalizeLimitlessRawTokenId,
  normalizeLimitlessScopedTokenId,
} from "../lib/limitless-token.js";
import { isRecord } from "../lib/type-guards.js";
import {
  expireStaleLimitlessFokOrders,
  fetchStoredOrderWalletContext,
  markOrderPositionDeltaApplied,
  normalizeLimitlessFokOrderSizesForMarket,
  storeOrder,
} from "../repos/orders-repo.js";
import {
  fetchErc1155BalancesByOwner,
  fetchEvmCode,
  fetchErc1155IsApprovedForAll,
} from "../services/polygon-rpc.js";
import {
  fetchLimitlessAmmQuote,
  fetchLimitlessOnchainSnapshot,
} from "../services/limitless-onchain.js";
import { buildLimitlessRedemptionPlan } from "../services/limitless-redemption-plan.js";
import { fetchConditionalTokensPayouts } from "../services/limitless-redemption.js";
import {
  extractLimitlessMessage,
  isLimitlessPartnerHmacConfigured,
  limitlessRequest,
  type LimitlessRequestAuthInputs,
} from "../services/limitless-client.js";
import {
  buildLimitlessRequestAuthInputs,
  extractLimitlessProfile,
  loadLimitlessProfileForWallet,
  type LimitlessProfile,
  resolveLimitlessAuthContext,
  verifyLimitlessAuthContext,
} from "../services/limitless-auth.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "../services/notifications.js";
import { tryRecordReferralFirstTradeConversion } from "../services/analytics-referrals.js";
import { applyOptimisticPositionTrade } from "../services/positions-optimistic.js";
import { recomputePositionMetricsForWallet } from "../services/positions-metrics.js";
import { syncLimitlessHistoryForWallet } from "../services/limitless-history.js";
import {
  deriveLimitlessSignedOrderSize,
  normalizeLimitlessMaybeRawAmount,
  normalizeLimitlessRawAmount,
} from "../services/limitless-order-normalization.js";
import { recordLimitlessVolumeEvent } from "../services/limitless-volume-events.js";
import { upsertLimitlessVenueShareAccrualFromOrderPayload } from "../services/limitless-fee-accruals.js";
import {
  buildEmbeddedPersonalSignRequest,
  createEmbeddedPrivyWalletRpcRequest,
  executePreparedPrivySignatureRequest,
  findEmbeddedAuthorizationSignature,
  resolveEmbeddedPrivyWalletContext,
  type EmbeddedPrivyAuthorizationRequest,
} from "../services/embedded-privy.js";
import {
  buildEmbeddedExecutionSingleFlightKey,
  getEmbeddedExecutionSingleFlightPromise,
  runEmbeddedExecutionSingleFlight,
} from "../services/embedded-execution-singleflight.js";
import {
  limitlessAuthLoginBodySchema,
  limitlessAccountQuerySchema,
  limitlessAmmQuoteQuerySchema,
  limitlessAmmOrderBodySchema,
  limitlessCancelBatchBodySchema,
  limitlessEmbeddedEnsureReadyBodySchema,
  limitlessEmbeddedEnsureReadyExecuteBodySchema,
  limitlessEmbeddedSignOrderExecuteBodySchema,
  limitlessEmbeddedSignOrderPrepareBodySchema,
  limitlessHistoryQuerySchema,
  limitlessMarketExchangeQuerySchema,
  limitlessOpenOrdersQuerySchema,
  limitlessOrderBodySchema,
  limitlessOrderIdParamsSchema,
  limitlessRedemptionPlanQuerySchema,
  limitlessRedemptionQuerySchema,
  limitlessSlugParamsSchema,
} from "../schemas/limitless-private.js";

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function toChecksumAddress(value: string): string | null {
  try {
    return ethers.getAddress(value.trim());
  } catch {
    return null;
  }
}

function encodeLimitlessSigningMessageHeader(value: string): string {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return trimmed;
  }
  return `0x${Buffer.from(value, "utf8").toString("hex")}`;
}

function mapLimitlessUpstreamStatus(status: number): number {
  if (status === 401 || status === 403) return 400;
  if (status >= 400 && status < 500) return status;
  return 502;
}

const LIMITLESS_FOK_UNMATCHED_REASON = "market_order_unmatched";
const LIMITLESS_FOK_UNMATCHED_MESSAGE =
  "Order was not filled because no immediate match was available. Nothing was bought or sold. Try again or place a limit order.";

function isLimitlessFokUnmatchedMessage(message: string | null): boolean {
  return message?.toLowerCase().includes("market order unmatched") ?? false;
}

function extractLimitlessOrderIdFromMessage(
  message: string | null,
): string | null {
  if (!message) return null;
  const match = message.match(
    /\border[_\s-]*id\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  );
  return match?.[1] ?? null;
}

function stringifyLimitlessRawError(payload: unknown): string | null {
  if (payload == null) return null;
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

function buildLimitlessOnBehalfHeaders(
  profile: LimitlessProfile | null | undefined,
): Record<string, string> | undefined {
  return profile?.id != null
    ? { "x-on-behalf-of": String(profile.id) }
    : undefined;
}

function buildLimitlessOnBehalfQueryPath(
  path: string,
  profile: LimitlessProfile | null | undefined,
): string {
  if (profile?.id == null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}onBehalfOf=${encodeURIComponent(String(profile.id))}`;
}

// Legacy Limitless markets sometimes expose only exchange in /markets payload.
// For these, SELL CT approvals may require a separate operator not returned by API.
const LIMITLESS_LEGACY_OPERATOR_BY_EXCHANGE: Readonly<Record<string, string>> =
  {
    [normalizeAddress("0x5a38afc17F7E97ad8d6C547ddb837E40B4aEDfC6")]:
      "0xb8daa4c8c9f690396f671bb601727a4c3741340c",
  };
const LIMITLESS_CLOB_EIP712_NAME = "Limitless CTF Exchange";
const LIMITLESS_CLOB_EIP712_VERSION = "1";
const LIMITLESS_CLOB_CHAIN_ID = 8453;
const LIMITLESS_ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
} as const;
const LIMITLESS_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

type LimitlessEmbeddedOrderPayload = {
  salt: string | number;
  maker: string;
  signer: string;
  taker?: string;
  tokenId: string | number;
  makerAmount: string | number;
  takerAmount: string | number;
  expiration: string | number;
  nonce: string | number;
  feeRateBps?: string | number;
  side: string | number;
  signatureType: string | number;
};

type LimitlessAccountPayload = Record<string, unknown>;
type LimitlessAccountCacheEntry = {
  value: LimitlessAccountPayload;
  expiresAt: number;
};
const limitlessAccountCache = new Map<string, LimitlessAccountCacheEntry>();
const limitlessAccountInflight = new Map<
  string,
  Promise<LimitlessAccountPayload>
>();

function resolveLimitlessLegacyOperatorForExchange(
  exchangeAddress: string | null,
): string | null {
  if (!exchangeAddress) return null;
  const mapped =
    LIMITLESS_LEGACY_OPERATOR_BY_EXCHANGE[normalizeAddress(exchangeAddress)];
  return mapped ?? null;
}

function canonicalizeLimitlessOrderPayload(
  payload: LimitlessEmbeddedOrderPayload,
): Record<string, string | number> & {
  maker: string;
  signer: string;
  taker: string;
} {
  return {
    ...payload,
    maker: ethers.getAddress(payload.maker),
    signer: ethers.getAddress(payload.signer),
    taker: ethers.getAddress(
      typeof payload.taker === "string" && payload.taker.trim().length > 0
        ? payload.taker
        : ethers.ZeroAddress,
    ),
    feeRateBps: payload.feeRateBps ?? 0,
  };
}

function buildEmbeddedLimitlessOrderTypedData(inputs: {
  signer: string;
  payload: LimitlessEmbeddedOrderPayload;
  exchangeAddress: string;
}) {
  const exchangeAddress = ethers.getAddress(inputs.exchangeAddress);
  const typedPayload = canonicalizeLimitlessOrderPayload(inputs.payload);
  if (typedPayload.signer.toLowerCase() !== inputs.signer.toLowerCase()) {
    throw new Error(
      "Embedded Limitless order signer must match the selected Trading Wallet.",
    );
  }
  if (typedPayload.maker.toLowerCase() !== inputs.signer.toLowerCase()) {
    throw new Error(
      "Embedded Limitless order maker must match the selected Trading Wallet.",
    );
  }
  return {
    domain: {
      name: LIMITLESS_CLOB_EIP712_NAME,
      version: LIMITLESS_CLOB_EIP712_VERSION,
      chainId: LIMITLESS_CLOB_CHAIN_ID,
      verifyingContract: exchangeAddress,
    },
    types: {
      EIP712Domain: LIMITLESS_DOMAIN_TYPES,
      Order: LIMITLESS_ORDER_TYPES.Order,
    },
    primaryType: "Order",
    message: typedPayload,
  } as const;
}

function buildEmbeddedLimitlessOrderRequest(inputs: {
  context: Awaited<ReturnType<typeof resolveEmbeddedPrivyWalletContext>>;
  payload: LimitlessEmbeddedOrderPayload;
  exchangeAddress: string;
}): EmbeddedPrivyAuthorizationRequest {
  const typedData = buildEmbeddedLimitlessOrderTypedData({
    signer: inputs.context.signer,
    payload: inputs.payload,
    exchangeAddress: inputs.exchangeAddress,
  });
  return createEmbeddedPrivyWalletRpcRequest({
    id: "limitless-order-signature",
    label: "Limitless order signature",
    walletId: inputs.context.walletId,
    body: {
      method: "eth_signTypedData_v4",
      params: {
        typed_data: {
          primary_type: typedData.primaryType,
          domain: typedData.domain,
          types: typedData.types,
          message: typedData.message,
        },
      },
    },
  });
}

async function prepareEmbeddedLimitlessOrderSigningRequest(inputs: {
  context: Awaited<ReturnType<typeof resolveEmbeddedPrivyWalletContext>>;
  marketSlug: string;
  requestAuth: LimitlessRequestAuthInputs;
  payload: LimitlessEmbeddedOrderPayload;
  signer: string;
  ownerId: number;
  exchangeAddress?: string | null;
}): Promise<{
  exchangeAddress: string;
  request: EmbeddedPrivyAuthorizationRequest;
}> {
  const providedExchangeAddress = inputs.exchangeAddress?.trim() ?? "";
  const resolvedExchangeAddress = providedExchangeAddress
    ? toChecksumAddress(providedExchangeAddress)
    : null;
  if (providedExchangeAddress && !resolvedExchangeAddress) {
    throw new Error("Embedded Limitless exchange address is invalid.");
  }
  const exchangeAddress =
    resolvedExchangeAddress ??
    (
      await resolveEmbeddedLimitlessOrderSigningContext({
        marketSlug: inputs.marketSlug,
        requestAuth: inputs.requestAuth,
        payload: inputs.payload,
        signer: inputs.signer,
        ownerId: inputs.ownerId,
      })
    ).exchangeAddress;

  return {
    exchangeAddress,
    request: buildEmbeddedLimitlessOrderRequest({
      context: inputs.context,
      payload: inputs.payload,
      exchangeAddress,
    }),
  };
}

function buildLimitlessAccountCacheKey(inputs: {
  userId: string;
  signer: string;
  clobSpender: string;
  negRiskSpender: string;
  adapterSpender: string;
  ammSpender: string;
  tokenId: string;
  credsUpdatedAt: string | null;
}): string {
  return [
    inputs.userId,
    normalizeAddress(inputs.signer),
    normalizeAddress(inputs.clobSpender),
    normalizeAddress(inputs.negRiskSpender),
    normalizeAddress(inputs.adapterSpender),
    normalizeAddress(inputs.ammSpender),
    inputs.tokenId,
    inputs.credsUpdatedAt ?? "none",
  ].join("|");
}

function readLimitlessAccountCache(
  key: string,
): LimitlessAccountPayload | null {
  if (env.limitlessAccountCacheTtlMs <= 0) return null;
  const entry = limitlessAccountCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    limitlessAccountCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeLimitlessAccountCache(
  key: string,
  value: LimitlessAccountPayload,
) {
  if (env.limitlessAccountCacheTtlMs <= 0) return;
  limitlessAccountCache.set(key, {
    value,
    expiresAt: Date.now() + env.limitlessAccountCacheTtlMs,
  });
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

function normalizeLimitlessPrice(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const normalized = value > 1 ? value / 100 : value;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 1) {
    return null;
  }
  return normalized;
}

function extractLimitlessImmediateFill(
  payload: unknown,
  side: "BUY" | "SELL",
  fallback: { price: number | null; size: number | null },
): { shares: number; notionalUsd: number } | null {
  const record = isRecord(payload)
    ? isRecord(payload.order)
      ? payload.order
      : payload
    : null;
  if (!record) return null;

  const outcomeShares = normalizeLimitlessMaybeRawAmount(
    record.outcomeTokenAmount ??
      record.outcome_token_amount ??
      record.size ??
      record.amount ??
      record.quantity,
  );
  const sideAmountRaw = parseNumberish(
    side === "BUY" ? record.takerAmount : record.makerAmount,
  );
  const sideShares =
    side === "BUY" && sideAmountRaw != null && sideAmountRaw <= 1
      ? null
      : normalizeLimitlessRawAmount(sideAmountRaw);
  const sharesCandidates = [outcomeShares, fallback.size, sideShares];
  const shares = sharesCandidates.find(
    (value): value is number =>
      value != null && Number.isFinite(value) && value > 0,
  );
  if (shares == null) return null;

  const priceCandidates = [
    normalizeLimitlessPrice(
      parseNumberish(
        record.price ??
          record.orderPrice ??
          record.limitPrice ??
          record.outcomeTokenPrice ??
          record.outcome_token_price,
      ),
    ),
    normalizeLimitlessPrice(fallback.price),
  ];
  const unitPrice =
    priceCandidates.find(
      (value): value is number =>
        value != null && Number.isFinite(value) && value > 0,
    ) ?? null;

  const notionalCandidates = [
    normalizeLimitlessMaybeRawAmount(
      record.collateralAmount ?? record.collateral_amount,
    ),
    normalizeLimitlessRawAmount(
      parseNumberish(side === "BUY" ? record.makerAmount : record.takerAmount),
    ),
    unitPrice != null ? unitPrice * shares : null,
  ];
  const notionalUsd =
    notionalCandidates.find(
      (value): value is number =>
        value != null && Number.isFinite(value) && value > 0,
    ) ?? null;

  if (notionalUsd == null) return null;
  return { shares, notionalUsd };
}

function isLimitlessTerminalFillStatus(status: string): boolean {
  return status === "filled" || status === "matched";
}

function normalizeOrderSide(value: unknown): "BUY" | "SELL" | null {
  if (typeof value === "string") {
    const trimmed = value.trim().toUpperCase();
    if (trimmed === "BUY" || trimmed === "SELL") return trimmed;
    if (trimmed === "0") return "BUY";
    if (trimmed === "1") return "SELL";
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return "BUY";
    if (value === 1) return "SELL";
  }
  return null;
}

function coerceOrderNumber(
  value: unknown,
  field: string,
  options: { allowFloat?: boolean } = {},
): number | null {
  if (value == null) return null;
  const raw =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? value
        : null;
  if (raw == null || raw === "") return null;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Order ${field} must be a valid number.`);
  }
  if (!options.allowFloat && !Number.isSafeInteger(parsed)) {
    throw new Error(`Order ${field} must be a safe integer.`);
  }
  return parsed;
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function isEvmWallet(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isBytes32(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function deriveSize(
  orderType: string,
  side: "BUY" | "SELL" | null,
  makerAmount: number | null,
  takerAmount: number | null,
): number | null {
  return deriveLimitlessSignedOrderSize({
    orderType,
    side,
    makerAmount,
    takerAmount,
  });
}

function readOrderField(
  record: Record<string, unknown>,
  keys: string[],
): unknown | null {
  for (const key of keys) {
    if (record[key] != null) return record[key];
  }
  if (isRecord(record.order)) {
    for (const key of keys) {
      if (record.order[key] != null) return record.order[key];
    }
  }
  return null;
}

function extractLimitlessOrders(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (isRecord(payload)) {
    const collection =
      payload.orders ?? payload.data ?? payload.items ?? payload.results;
    if (Array.isArray(collection)) {
      return collection.filter(isRecord);
    }
    if (isRecord(collection)) {
      return [collection];
    }
    if (payload.id || payload.orderId || payload.order_id) {
      return [payload];
    }
  }
  return [];
}

function normalizeOrderId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  return null;
}

function extractLimitlessOrderId(
  record: Record<string, unknown>,
): string | null {
  return normalizeOrderId(
    readOrderField(record, ["id", "orderId", "order_id"]),
  );
}

function extractLimitlessTokenId(
  record: Record<string, unknown>,
): string | null {
  const raw = normalizeOrderId(
    readOrderField(record, ["tokenId", "token_id", "outcomeTokenId"]),
  );
  return normalizeLimitlessScopedTokenId(raw);
}

function extractLimitlessOrderSide(
  record: Record<string, unknown>,
): "BUY" | "SELL" | null {
  return normalizeOrderSide(readOrderField(record, ["side", "orderSide"]));
}

function extractLimitlessOrderType(
  record: Record<string, unknown>,
): "GTC" | "FOK" | null {
  const value = readOrderField(record, ["orderType", "type"]);
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (upper === "GTC" || upper === "FOK") return upper;
  }
  return null;
}

function extractLimitlessOrderStatus(record: Record<string, unknown>): string {
  const value = readOrderField(record, ["status", "orderStatus"]);
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "open" ||
      normalized === "active" ||
      normalized === "live"
    ) {
      return "live";
    }
    if (normalized === "cancelled" || normalized === "canceled") {
      return "cancelled";
    }
    if (normalized === "filled" || normalized === "complete") {
      return "filled";
    }
    return normalized;
  }
  return "live";
}

function extractLimitlessOrderPrice(
  record: Record<string, unknown>,
): number | null {
  const value = readOrderField(record, [
    "price",
    "orderPrice",
    "limitPrice",
    "outcomeTokenPrice",
    "outcome_token_price",
  ]);
  return parseNumberish(value);
}

function extractLimitlessOrderSize(
  record: Record<string, unknown>,
): number | null {
  const value = readOrderField(record, [
    "size",
    "orderSize",
    "amount",
    "shares",
    "quantity",
    "outcomeAmount",
    "outcome_amount",
  ]);
  return parseNumberish(value);
}

function extractLimitlessCanceledIds(
  payload: unknown,
  fallback: string[],
): string[] {
  if (!isRecord(payload)) return fallback;
  const candidates =
    payload.canceled ??
    payload.cancelled ??
    payload.canceledOrders ??
    payload.cancelledOrders;
  if (!Array.isArray(candidates)) return fallback;
  const ids = candidates
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (isRecord(entry)) {
        return normalizeOrderId(
          entry.orderId ?? entry.order_id ?? entry.id ?? null,
        );
      }
      return null;
    })
    .filter((entry): entry is string => Boolean(entry));
  return ids.length ? ids : fallback;
}

function extractLimitlessMarketExchangeAddress(
  payload: unknown,
): string | null {
  const marketRecord = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  if (!marketRecord) return null;

  const directCandidates = [
    marketRecord.negRiskExchange,
    marketRecord.exchangeAddress,
    marketRecord.exchange,
    marketRecord.venueExchange,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && ethers.isAddress(candidate.trim())) {
      return ethers.getAddress(candidate.trim());
    }
  }

  const venue = marketRecord.venue;
  if (isRecord(venue)) {
    const nestedCandidates = [venue.exchangeAddress, venue.exchange];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === "string" && ethers.isAddress(candidate.trim())) {
        return ethers.getAddress(candidate.trim());
      }
    }
  }

  return null;
}

function extractLimitlessMarketAdapterAddress(payload: unknown): string | null {
  const marketRecord = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  if (!marketRecord) return null;

  // Approval target priority:
  // 1) operator/operatorAddress when provided (current Limitless UI behavior)
  // 2) adapter-style fields for older payload variants
  const directCandidates = [
    marketRecord.operator,
    marketRecord.operatorAddress,
    marketRecord.negRiskOperator,
    marketRecord.negRiskOperatorAddress,
    marketRecord.negRiskAdapter,
    marketRecord.adapter,
    marketRecord.adapterAddress,
    marketRecord.venueAdapter,
    marketRecord.exchangeAdapter,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && ethers.isAddress(candidate.trim())) {
      return ethers.getAddress(candidate.trim());
    }
  }

  const venue = marketRecord.venue;
  if (isRecord(venue)) {
    const nestedCandidates = [
      venue.operator,
      venue.operatorAddress,
      venue.negRiskOperator,
      venue.negRiskOperatorAddress,
      venue.adapter,
      venue.adapterAddress,
      venue.exchangeAdapter,
    ];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === "string" && ethers.isAddress(candidate.trim())) {
        return ethers.getAddress(candidate.trim());
      }
    }
  }

  return null;
}

function extractLimitlessExpectedExchangeAddress(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;

  const nestedPayload = isRecord(payload.payload) ? payload.payload : null;
  const candidates: unknown[] = [
    payload.message,
    payload.error,
    nestedPayload?.message,
    nestedPayload?.error,
  ];

  const pattern = /exchange address for this market:\s*(0x[a-fA-F0-9]{40})/i;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(pattern);
    if (!match?.[1]) continue;
    const value = match[1].trim();
    if (!ethers.isAddress(value)) continue;
    return ethers.getAddress(value);
  }

  return null;
}

type LimitlessTokenPair = { tokenYes: string | null; tokenNo: string | null };

function normalizeRawLimitlessTokenIdFromUnknown(
  value: unknown,
): string | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
    ? normalizeLimitlessRawTokenId(value)
    : null;
}

function extractLimitlessPositionTokenIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeRawLimitlessTokenIdFromUnknown(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function extractLimitlessTokenPair(
  payload: unknown,
): LimitlessTokenPair | null {
  const marketRecord = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  if (!marketRecord) return null;

  const tokensRecord = isRecord(marketRecord.tokens)
    ? marketRecord.tokens
    : isRecord(marketRecord.token)
      ? marketRecord.token
      : null;
  const positionIds = extractLimitlessPositionTokenIds(
    marketRecord.position_ids ?? marketRecord.positionIds,
  );

  const tokenYes =
    normalizeRawLimitlessTokenIdFromUnknown(
      tokensRecord
        ? (tokensRecord.yes ?? tokensRecord.YES ?? tokensRecord[0])
        : null,
    ) ??
    positionIds[0] ??
    null;
  const tokenNo =
    normalizeRawLimitlessTokenIdFromUnknown(
      tokensRecord
        ? (tokensRecord.no ?? tokensRecord.NO ?? tokensRecord[1])
        : null,
    ) ??
    positionIds[1] ??
    null;

  if (!tokenYes && !tokenNo) return null;
  return { tokenYes, tokenNo };
}

async function resolveLimitlessTokenPairForSlug(inputs: {
  slug: string;
  requestAuth: LimitlessRequestAuthInputs;
}): Promise<LimitlessTokenPair | null> {
  const slug = inputs.slug.trim();
  if (!slug) return null;

  const dbRow = await pool.query<{
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select token_yes, token_no
      from unified_markets
      where venue = 'limitless'
        and slug = $1
      limit 1
    `,
    [slug],
  );
  const dbTokenYes = normalizeLimitlessRawTokenId(
    dbRow.rows[0]?.token_yes ?? null,
  );
  const dbTokenNo = normalizeLimitlessRawTokenId(
    dbRow.rows[0]?.token_no ?? null,
  );
  if (dbTokenYes && dbTokenNo) {
    return { tokenYes: dbTokenYes, tokenNo: dbTokenNo };
  }

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}`,
    ...inputs.requestAuth,
  });
  if (!upstream.ok) {
    return dbTokenYes || dbTokenNo
      ? { tokenYes: dbTokenYes, tokenNo: dbTokenNo }
      : null;
  }

  const upstreamTokens = extractLimitlessTokenPair(upstream.payload);
  if (!upstreamTokens) {
    return dbTokenYes || dbTokenNo
      ? { tokenYes: dbTokenYes, tokenNo: dbTokenNo }
      : null;
  }

  return {
    tokenYes: upstreamTokens.tokenYes ?? dbTokenYes,
    tokenNo: upstreamTokens.tokenNo ?? dbTokenNo,
  };
}

async function resolveEmbeddedLimitlessOrderSigningContext(inputs: {
  marketSlug: string;
  requestAuth: LimitlessRequestAuthInputs;
  payload: LimitlessEmbeddedOrderPayload;
  signer: string;
  ownerId: number;
}): Promise<{
  exchangeAddress: string;
}> {
  const marketSlug = inputs.marketSlug.trim();
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(marketSlug)}`,
    ...inputs.requestAuth,
  });

  if (!upstream.ok) {
    throw Object.assign(new Error("Limitless market exchange fetch failed"), {
      responseStatus: 502,
      responsePayload: {
        status: upstream.status,
        payload: upstream.payload,
      },
    });
  }

  const tokenId = normalizeLimitlessRawTokenId(inputs.payload.tokenId);
  if (!tokenId) {
    throw new Error("Embedded Limitless order token is invalid.");
  }

  const tokenPair =
    extractLimitlessTokenPair(upstream.payload) ??
    (await resolveLimitlessTokenPairForSlug({
      slug: marketSlug,
      requestAuth: inputs.requestAuth,
    }));
  if (!tokenPair?.tokenYes && !tokenPair?.tokenNo) {
    throw new Error("Unable to resolve Limitless market tokens.");
  }
  if (tokenId !== tokenPair.tokenYes && tokenId !== tokenPair.tokenNo) {
    throw new Error(
      "Embedded Limitless order token does not belong to this market.",
    );
  }

  const exchangeAddress = extractLimitlessMarketExchangeAddress(
    upstream.payload,
  );
  if (!exchangeAddress) {
    throw new Error("Unable to resolve Limitless exchange for this market.");
  }

  let canonicalExchangeAddress = exchangeAddress;
  const probeTokenId = tokenPair?.tokenYes ?? tokenPair?.tokenNo ?? tokenId;
  const signerChecksum = toChecksumAddress(inputs.signer);
  if (signerChecksum && inputs.ownerId && probeTokenId) {
    const probeSide = Number(inputs.payload.side) === 1 ? 1 : 0;
    try {
      const probe = await limitlessRequest({
        method: "POST",
        requestPath: "/orders",
        ...inputs.requestAuth,
        body: {
          order: {
            salt: Date.now() * 1000,
            maker: signerChecksum,
            signer: signerChecksum,
            taker: "0x0000000000000000000000000000000000000000",
            tokenId: probeTokenId,
            makerAmount: 1_000_000,
            takerAmount: 1,
            expiration: "0",
            nonce: 0,
            feeRateBps: 300,
            side: probeSide,
            signatureType: 0,
            signature: `0x${"0".repeat(130)}`,
          },
          orderType: "FOK",
          marketSlug,
          ownerId: inputs.ownerId,
          onBehalfOf: inputs.ownerId,
        },
      });
      if (!probe.ok) {
        const probedExchange = extractLimitlessExpectedExchangeAddress(
          probe.payload,
        );
        if (probedExchange) {
          canonicalExchangeAddress = probedExchange;
        }
      }
    } catch (error) {
      void error;
    }
  }

  return { exchangeAddress: canonicalExchangeAddress };
}

export const limitlessPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  const resolveWalletAddresses = async (
    userId: string,
    walletAddress: string | undefined,
    requestedWallets: string[] | undefined,
  ): Promise<string[]> => {
    if (requestedWallets && requestedWallets.length) {
      const wallets = await AuthService.getUserWallets(userId);
      const walletMap = new Map(
        wallets.map((wallet) => [
          wallet.walletAddress.toLowerCase(),
          wallet.walletAddress,
        ]),
      );
      const resolved = requestedWallets
        .map((address) => address.trim().toLowerCase())
        .map((address) => walletMap.get(address))
        .filter((address): address is string => Boolean(address));
      return Array.from(new Set(resolved));
    }

    if (!walletAddress) return [];
    return [walletAddress];
  };

  const sendLimitlessUnavailable = (reply: FastifyReply) => {
    reply.code(503);
    return reply.send({ error: "Limitless is temporarily unavailable." });
  };

  const persistLimitlessProfileForWallet = async (inputs: {
    userId: string;
    signer: string;
    account: string;
    profile: LimitlessProfile;
  }) => {
    await AuthService.createOrUpdateVenueCredentials(
      inputs.userId,
      inputs.signer,
      "limitless",
      inputs.account,
      "",
      { authMode: "partner_hmac", profile: inputs.profile },
    );
  };

  const connectLimitlessPartnerAccount = async (inputs: {
    userId: string;
    signer: string;
    account: string;
    signingMessage: string;
    signature: string;
    clientType: "eoa" | "base" | "etherspot";
  }): Promise<
    | { ok: true; authMode: "partner_hmac"; profile: LimitlessProfile }
    | {
        ok: false;
        httpStatus: number;
        error: string;
        status?: number;
        payload?: unknown;
      }
  > => {
    const checksumAccount = toChecksumAddress(inputs.account);
    if (!checksumAccount) {
      return {
        ok: false,
        httpStatus: 400,
        error: "x-account is not a valid EVM address",
      };
    }

    const encodedSigningMessage = encodeLimitlessSigningMessageHeader(
      inputs.signingMessage,
    );
    const upstream = await limitlessRequest({
      method: "POST",
      requestPath: "/profiles/partner-accounts",
      auth: "partner_hmac",
      body: {
        displayName: checksumAccount,
      },
      headers: {
        "x-account": checksumAccount,
        "x-signing-message": encodedSigningMessage,
        "x-signature": inputs.signature,
      },
    });

    if (!upstream.ok) {
      if (upstream.status === 409) {
        const upstreamExistingProfile = extractLimitlessProfile(
          upstream.payload,
        );
        if (
          upstreamExistingProfile?.id &&
          (!upstreamExistingProfile.account ||
            normalizeAddress(upstreamExistingProfile.account) ===
              normalizeAddress(checksumAccount))
        ) {
          const recoveredProfile: LimitlessProfile = {
            ...upstreamExistingProfile,
            account: upstreamExistingProfile.account ?? checksumAccount,
            client: upstreamExistingProfile.client ?? inputs.clientType,
          };
          try {
            await persistLimitlessProfileForWallet({
              userId: inputs.userId,
              signer: inputs.signer,
              account: recoveredProfile.account ?? checksumAccount,
              profile: recoveredProfile,
            });
          } catch (error) {
            app.log.error(
              { error, userId: inputs.userId, signer: inputs.signer },
              "Failed to store recovered Limitless credentials from 409 response",
            );
            return {
              ok: false,
              httpStatus: 500,
              error: "Failed to store recovered Limitless credentials",
            };
          }

          return {
            ok: true,
            authMode: "partner_hmac",
            profile: recoveredProfile,
          };
        }

        const existingCreds = await AuthService.getVenueCredentials(
          inputs.userId,
          "limitless",
          inputs.signer,
        );
        const storedExistingProfile = existingCreds
          ? extractLimitlessProfile(existingCreds.additionalData ?? null)
          : null;
        if (
          storedExistingProfile?.id &&
          (!storedExistingProfile.account ||
            normalizeAddress(storedExistingProfile.account) ===
              normalizeAddress(checksumAccount))
        ) {
          const recoveredProfile: LimitlessProfile = {
            ...storedExistingProfile,
            account: storedExistingProfile.account ?? checksumAccount,
            client: storedExistingProfile.client ?? inputs.clientType,
          };
          try {
            await persistLimitlessProfileForWallet({
              userId: inputs.userId,
              signer: inputs.signer,
              account: recoveredProfile.account ?? checksumAccount,
              profile: recoveredProfile,
            });
          } catch (error) {
            app.log.error(
              { error, userId: inputs.userId, signer: inputs.signer },
              "Failed to store recovered Limitless credentials from existing mapping",
            );
            return {
              ok: false,
              httpStatus: 500,
              error: "Failed to store recovered Limitless credentials",
            };
          }

          return {
            ok: true,
            authMode: "partner_hmac",
            profile: recoveredProfile,
          };
        }

        const profileLookup = await limitlessRequest({
          method: "GET",
          requestPath: `/profiles/${checksumAccount}`,
          auth: "partner_hmac",
        });
        if (profileLookup.ok) {
          const existingProfile = extractLimitlessProfile(
            profileLookup.payload,
          );
          if (existingProfile?.id) {
            const recoveredProfile: LimitlessProfile = {
              ...existingProfile,
              account: existingProfile.account ?? checksumAccount,
              client: existingProfile.client ?? inputs.clientType,
            };
            try {
              await persistLimitlessProfileForWallet({
                userId: inputs.userId,
                signer: inputs.signer,
                account: recoveredProfile.account ?? checksumAccount,
                profile: recoveredProfile,
              });
            } catch (error) {
              app.log.error(
                { error, userId: inputs.userId, signer: inputs.signer },
                "Failed to store recovered Limitless credentials",
              );
              return {
                ok: false,
                httpStatus: 500,
                error: "Failed to store recovered Limitless credentials",
              };
            }

            return {
              ok: true,
              authMode: "partner_hmac",
              profile: recoveredProfile,
            };
          }
        }
      }

      return {
        ok: false,
        httpStatus:
          upstream.status >= 400 && upstream.status < 500
            ? upstream.status
            : 502,
        error: "Limitless connect failed",
        status: upstream.status,
        payload: upstream.payload,
      };
    }

    const profile = extractLimitlessProfile(upstream.payload);
    const profileSafe: LimitlessProfile | null = profile
      ? {
          ...profile,
          account: profile.account ?? checksumAccount,
          client: profile.client ?? inputs.clientType,
        }
      : { account: checksumAccount, client: inputs.clientType };

    if (!profileSafe?.id) {
      return {
        ok: false,
        httpStatus: 502,
        error: "Limitless partner account creation did not return a profile id",
        payload: upstream.payload,
      };
    }

    try {
      await persistLimitlessProfileForWallet({
        userId: inputs.userId,
        signer: inputs.signer,
        account: profileSafe.account ?? checksumAccount,
        profile: profileSafe,
      });
    } catch (error) {
      app.log.error(
        { error, userId: inputs.userId, signer: inputs.signer },
        "Failed to store Limitless credentials",
      );
      return {
        ok: false,
        httpStatus: 500,
        error: "Failed to store Limitless credentials",
      };
    }

    return {
      ok: true,
      authMode: "partner_hmac",
      profile: profileSafe,
    };
  };

  const requireLimitlessPartnerAuth = async (inputs: {
    reply: FastifyReply;
    userId: string;
    walletAddress: string;
  }) => {
    if (!isLimitlessPartnerHmacConfigured()) {
      sendLimitlessUnavailable(inputs.reply);
      return null;
    }

    const creds = await AuthService.getVenueCredentials(
      inputs.userId,
      "limitless",
      inputs.walletAddress,
    );
    const authContext = await resolveLimitlessAuthContext(
      inputs.userId,
      inputs.walletAddress,
    );

    if (!authContext || !creds) {
      inputs.reply.code(400);
      inputs.reply.send({
        error: "Connect Limitless for this wallet first.",
      });
      return null;
    }

    const verification = await verifyLimitlessAuthContext({
      authContext,
      walletAddress: inputs.walletAddress,
    });
    if (!verification.ok) {
      inputs.reply.code(mapLimitlessUpstreamStatus(verification.status));
      inputs.reply.send({
        error:
          verification.message ??
          "Limitless connection is invalid for the selected wallet.",
        status: verification.status,
        payload: verification.payload,
      });
      return null;
    }

    const profile = await loadLimitlessProfileForWallet({
      walletAddress: inputs.walletAddress,
      authContext,
      additionalData: creds.additionalData ?? null,
      baseProfile: verification.profile,
    });

    if (!profile?.id) {
      inputs.reply.code(400);
      inputs.reply.send({
        error: "Limitless profile mapping is missing for this wallet.",
      });
      return null;
    }

    return {
      creds,
      authContext,
      profile,
      requestAuth: buildLimitlessRequestAuthInputs(authContext),
    };
  };

  /**
   * GET /auth/signing-message
   */
  z.get(
    "/auth/signing-message",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isLimitlessPartnerHmacConfigured()) {
        return sendLimitlessUnavailable(reply);
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: "/auth/signing-message",
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless signing message failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const message = extractLimitlessMessage(upstream.payload);
      if (!message) {
        reply.code(502);
        return reply.send({
          error: "Limitless signing message invalid",
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, message });
    },
  );

  /**
   * POST /auth/login
   */
  z.post(
    "/auth/login",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessAuthLoginBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless login requires an EVM wallet address",
        });
      }

      const body = request.body;

      const headerAccount = getHeaderValue(request.headers, "x-account");
      const headerMessage = getHeaderValue(
        request.headers,
        "x-signing-message",
      );
      const headerSignature = getHeaderValue(request.headers, "x-signature");

      const account = headerAccount ?? body.account;
      const signingMessage = headerMessage ?? body.signingMessage;
      const signature = headerSignature ?? body.signature;

      if (!account || !signingMessage || !signature) {
        reply.code(400);
        return reply.send({
          error: "Missing x-account, x-signing-message, or x-signature",
        });
      }

      if (normalizeAddress(account) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "x-account must match the selected wallet",
        });
      }

      const clientType = body.client ?? "eoa";
      if (!isLimitlessPartnerHmacConfigured()) {
        return sendLimitlessUnavailable(reply);
      }

      const result = await connectLimitlessPartnerAccount({
        userId: user.id,
        signer,
        account,
        signingMessage,
        signature,
        clientType,
      });

      if (!result.ok) {
        reply.code(result.httpStatus);
        return reply.send({
          error: result.error,
          ...(result.status != null ? { status: result.status } : {}),
          ...(result.payload !== undefined ? { payload: result.payload } : {}),
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result);
    },
  );

  z.post(
    "/embedded/ensure-ready/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessEmbeddedEnsureReadyBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Embedded Limitless automation requires an EVM wallet address",
        });
      }
      if (!isLimitlessPartnerHmacConfigured()) {
        return sendLimitlessUnavailable(reply);
      }

      try {
        const context = await resolveEmbeddedPrivyWalletContext({
          user,
          signer,
          venueLabel: "Limitless",
        });
        const creds = await AuthService.getVenueCredentials(
          user.id,
          "limitless",
          signer,
        );
        const authContext = await resolveLimitlessAuthContext(user.id, signer);
        let connected = false;
        if (creds && authContext) {
          const verification = await verifyLimitlessAuthContext({
            authContext,
            walletAddress: signer,
          });
          connected = verification.ok;
        }

        if (connected) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            signer: context.signer,
            connected: true,
            requests: [],
          });
        }

        const signingMessageUpstream = await limitlessRequest({
          method: "GET",
          requestPath: "/auth/signing-message",
        });
        if (!signingMessageUpstream.ok) {
          reply.code(502);
          return reply.send({
            error: "Limitless signing message failed",
            status: signingMessageUpstream.status,
            payload: signingMessageUpstream.payload,
          });
        }
        const signingMessage = extractLimitlessMessage(
          signingMessageUpstream.payload,
        );
        if (!signingMessage) {
          reply.code(502);
          return reply.send({
            error: "Limitless signing message invalid",
            payload: signingMessageUpstream.payload,
          });
        }

        const requests: EmbeddedPrivyAuthorizationRequest[] = [
          buildEmbeddedPersonalSignRequest({
            context,
            id: "limitless-connect",
            label: "Limitless connect",
            message: signingMessage,
          }),
        ];

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer: context.signer,
          connected: false,
          signingMessage,
          requests,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to prepare embedded Limitless readiness",
        );
        reply.code(500);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Embedded Limitless setup preparation failed",
        });
      }
    },
  );

  z.post(
    "/embedded/ensure-ready/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessEmbeddedEnsureReadyExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Embedded Limitless automation requires an EVM wallet address",
        });
      }
      if (!isLimitlessPartnerHmacConfigured()) {
        return sendLimitlessUnavailable(reply);
      }

      try {
        const lockKey = normalizeAddress(signer);
        const singleFlightKey = buildEmbeddedExecutionSingleFlightKey(
          "limitless-private",
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
            const context = await resolveEmbeddedPrivyWalletContext({
              user,
              signer,
              venueLabel: "Limitless",
            });

            const connectRequest = buildEmbeddedPersonalSignRequest({
              context,
              id: "limitless-connect",
              label: "Limitless connect",
              message: request.body.signingMessage,
            });
            const authorizationSignature = findEmbeddedAuthorizationSignature(
              request.body.signedRequests,
              connectRequest.id,
            );
            const signature = await executePreparedPrivySignatureRequest({
              request: connectRequest,
              authorizationSignature,
            });

            const connectResult = await connectLimitlessPartnerAccount({
              userId: user.id,
              signer,
              account: context.signer,
              signingMessage: request.body.signingMessage,
              signature,
              clientType: "base",
            });

            if (!connectResult.ok) {
              throw Object.assign(new Error(connectResult.error), {
                responseStatus: connectResult.httpStatus,
                responsePayload: {
                  ...(connectResult.status != null
                    ? { status: connectResult.status }
                    : {}),
                  ...(connectResult.payload !== undefined
                    ? { payload: connectResult.payload }
                    : {}),
                },
              });
            }

            return {
              ok: true,
              signer: context.signer,
              connected: true,
              authMode: connectResult.authMode,
              profile: connectResult.profile,
            };
          },
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        const status =
          typeof (error as { responseStatus?: unknown })?.responseStatus ===
          "number"
            ? ((error as { responseStatus: number }).responseStatus ?? 500)
            : 500;
        const payload =
          (error as { responsePayload?: unknown })?.responsePayload ??
          undefined;
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to execute embedded Limitless readiness",
        );
        reply.code(status);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Embedded Limitless setup execution failed",
          ...(payload !== undefined
            ? (payload as Record<string, unknown>)
            : {}),
        });
      }
    },
  );

  z.post(
    "/embedded/sign-order/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: limitlessEmbeddedSignOrderPrepareBodySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Embedded Limitless automation requires an EVM wallet address",
        });
      }

      try {
        const partnerAuth = await requireLimitlessPartnerAuth({
          reply,
          userId: user.id,
          walletAddress: signer,
        });
        if (!partnerAuth) return;

        const context = await resolveEmbeddedPrivyWalletContext({
          user,
          signer,
          venueLabel: "Limitless",
        });
        const ownerId = partnerAuth.profile.id;
        if (ownerId == null) {
          throw new Error(
            "Limitless profile mapping is missing for this wallet.",
          );
        }
        const prepared = await prepareEmbeddedLimitlessOrderSigningRequest({
          context,
          marketSlug: request.body.marketSlug,
          requestAuth: partnerAuth.requestAuth,
          payload: request.body.order as LimitlessEmbeddedOrderPayload,
          signer,
          ownerId,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          exchangeAddress: prepared.exchangeAddress,
          request: prepared.request,
        });
      } catch (error) {
        const status =
          typeof (error as { responseStatus?: unknown })?.responseStatus ===
          "number"
            ? ((error as { responseStatus: number }).responseStatus ?? 400)
            : 400;
        reply.code(status);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare Limitless order signature",
          ...(((error as { responsePayload?: unknown })?.responsePayload ??
            undefined) as Record<string, unknown> | undefined),
        });
      }
    },
  );

  z.post(
    "/embedded/sign-order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessEmbeddedSignOrderExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Embedded Limitless automation requires an EVM wallet address",
        });
      }

      try {
        const partnerAuth = await requireLimitlessPartnerAuth({
          reply,
          userId: user.id,
          walletAddress: signer,
        });
        if (!partnerAuth) return;

        const context = await resolveEmbeddedPrivyWalletContext({
          user,
          signer,
          venueLabel: "Limitless",
        });
        const ownerId = partnerAuth.profile.id;
        if (ownerId == null) {
          throw new Error(
            "Limitless profile mapping is missing for this wallet.",
          );
        }
        const prepared = await prepareEmbeddedLimitlessOrderSigningRequest({
          context,
          marketSlug: request.body.marketSlug,
          requestAuth: partnerAuth.requestAuth,
          payload: request.body.order as LimitlessEmbeddedOrderPayload,
          signer,
          ownerId,
          exchangeAddress: request.body.exchangeAddress,
        });
        const signature = await executePreparedPrivySignatureRequest({
          request: prepared.request,
          authorizationSignature: request.body.authorizationSignature ?? "",
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, signature });
      } catch (error) {
        const status =
          typeof (error as { responseStatus?: unknown })?.responseStatus ===
          "number"
            ? ((error as { responseStatus: number }).responseStatus ?? 400)
            : 400;
        reply.code(status);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to sign Limitless order",
          ...(((error as { responsePayload?: unknown })?.responsePayload ??
            undefined) as Record<string, unknown> | undefined),
        });
      }
    },
  );

  /**
   * GET /auth/verify
   */
  z.get(
    "/auth/verify",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const partnerAuth = await requireLimitlessPartnerAuth({
        reply,
        userId: user.id,
        walletAddress: signer,
      });
      if (!partnerAuth) return;

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        authMode: partnerAuth.authContext.authMode,
        account: partnerAuth.profile.account ?? signer,
        profile: partnerAuth.profile,
      });
    },
  );

  /**
   * POST /auth/logout
   */
  z.post(
    "/auth/logout",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const deactivatedCount = await AuthService.deactivateVenueCredentials(
        user.id,
        "limitless",
        signer,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        disconnected: true,
        deactivatedCount,
        mode: "local_disconnect",
      });
    },
  );

  /**
   * GET /account
   * Returns a wallet-scoped Limitless account snapshot (Base on-chain reads).
   */
  z.get(
    "/account",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessAccountQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signerRaw = request.walletAddress;
      if (!user || !signerRaw) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signerRaw)) {
        reply.code(400);
        return reply.send({
          error: "Limitless account snapshot requires an EVM wallet address",
        });
      }
      const signer = toChecksumAddress(signerRaw);
      if (!signer) {
        reply.code(400);
        return reply.send({
          error:
            "Limitless account snapshot requires a valid EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signerRaw,
      );
      const authContext = await resolveLimitlessAuthContext(user.id, signerRaw);
      const credsUpdatedAtValue =
        creds?.updatedAt instanceof Date
          ? creds.updatedAt.toISOString()
          : (creds?.updatedAt ?? null);
      const refresh = request.query.refresh === true;
      let hasCredentials =
        Boolean(creds) &&
        Boolean(authContext) &&
        isLimitlessPartnerHmacConfigured();
      let verifiedProfileBase: LimitlessProfile | null = null;

      const clobSpender = request.query.clobSpender ?? env.limitlessClobAddress;
      const negRiskSpender =
        request.query.negRiskSpender ?? env.limitlessNegRiskAddress;
      const adapterSpender = request.query.adapterSpender ?? null;
      const ammSpender = request.query.ammSpender ?? null;
      const tokenId = normalizeLimitlessRawTokenId(request.query.tokenId);

      const cacheEnabled = !refresh && env.limitlessAccountCacheTtlMs > 0;
      const cacheKey = buildLimitlessAccountCacheKey({
        userId: user.id,
        signer,
        clobSpender: clobSpender ?? "none",
        negRiskSpender: negRiskSpender ?? "none",
        adapterSpender: adapterSpender ?? "none",
        ammSpender: ammSpender ?? "none",
        tokenId: tokenId ?? "none",
        credsUpdatedAt: credsUpdatedAtValue,
      });

      if (cacheEnabled) {
        const cached = readLimitlessAccountCache(cacheKey);
        if (cached) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cached);
        }
        const inflight = limitlessAccountInflight.get(cacheKey);
        if (inflight) {
          const payload = await inflight;
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(payload);
        }
      }

      if (hasCredentials && authContext) {
        const verification = await verifyLimitlessAuthContext({
          authContext,
          walletAddress: signer,
        });
        hasCredentials = verification.ok;
        if (verification.ok) {
          verifiedProfileBase = verification.profile;
        }
      }

      try {
        const conditionalTokensAddress = env.limitlessConditionalTokensAddress;
        const computePromise = (async (): Promise<LimitlessAccountPayload> => {
          const [
            code,
            snapshot,
            approvedClob,
            approvedNegRisk,
            approvedAdapter,
            approvedAmm,
            tokenBalanceMap,
            liveProfile,
          ] = await Promise.all([
            fetchEvmCode({
              rpcUrl: env.baseRpcUrl,
              timeoutMs: env.baseRpcTimeoutMs,
              address: signer,
            }),
            fetchLimitlessOnchainSnapshot({
              rpcUrl: env.baseRpcUrl,
              timeoutMs: env.baseRpcTimeoutMs,
              owner: signer,
              clobAddress: clobSpender,
              negRiskAddress: negRiskSpender,
              ammAddress: ammSpender,
            }),
            clobSpender
              ? fetchErc1155IsApprovedForAll({
                  rpcUrl: env.baseRpcUrl,
                  timeoutMs: env.baseRpcTimeoutMs,
                  contractAddress: conditionalTokensAddress,
                  owner: signer,
                  operator: clobSpender,
                  bypassCache: refresh,
                })
              : Promise.resolve(null),
            negRiskSpender
              ? fetchErc1155IsApprovedForAll({
                  rpcUrl: env.baseRpcUrl,
                  timeoutMs: env.baseRpcTimeoutMs,
                  contractAddress: conditionalTokensAddress,
                  owner: signer,
                  operator: negRiskSpender,
                  bypassCache: refresh,
                })
              : Promise.resolve(null),
            adapterSpender
              ? fetchErc1155IsApprovedForAll({
                  rpcUrl: env.baseRpcUrl,
                  timeoutMs: env.baseRpcTimeoutMs,
                  contractAddress: conditionalTokensAddress,
                  owner: signer,
                  operator: adapterSpender,
                  bypassCache: refresh,
                })
              : Promise.resolve(null),
            ammSpender
              ? fetchErc1155IsApprovedForAll({
                  rpcUrl: env.baseRpcUrl,
                  timeoutMs: env.baseRpcTimeoutMs,
                  contractAddress: conditionalTokensAddress,
                  owner: signer,
                  operator: ammSpender,
                  bypassCache: refresh,
                })
              : Promise.resolve(null),
            tokenId
              ? fetchErc1155BalancesByOwner({
                  rpcUrl: env.baseRpcUrl,
                  timeoutMs: env.baseRpcTimeoutMs,
                  contractAddress: conditionalTokensAddress,
                  owner: signer,
                  tokenIds: [tokenId],
                })
              : Promise.resolve(null),
            hasCredentials
              ? loadLimitlessProfileForWallet({
                  walletAddress: signer,
                  authContext,
                  additionalData: creds?.additionalData ?? null,
                  baseProfile: verifiedProfileBase,
                })
              : Promise.resolve(null),
          ]);

          const profile = liveProfile;

          const usdcBalance = snapshot.usdcBalance;
          const allowanceClob = snapshot.allowanceClob;
          const allowanceNegRisk = snapshot.allowanceNegRisk;
          const allowanceAmm = snapshot.allowanceAmm;
          const tokenBalanceRaw =
            tokenId && tokenBalanceMap
              ? (tokenBalanceMap.get(tokenId) ?? 0n)
              : null;

          const isContract = typeof code === "string" && code.length > 2;

          return {
            ok: true,
            venue: "limitless",
            chainId: 8453,
            signer,
            signerIsContract: isContract,
            rpcUrl: env.baseRpcUrl,
            usdc: {
              tokenAddress: env.limitlessUsdcAddress,
              decimals: 6,
              balance: ethers.formatUnits(usdcBalance, 6),
              balanceRaw: usdcBalance.toString(),
              allowance: {
                ...(clobSpender
                  ? {
                      clob: {
                        spender: clobSpender,
                        allowance: ethers.formatUnits(allowanceClob ?? 0n, 6),
                        allowanceRaw: (allowanceClob ?? 0n).toString(),
                      },
                    }
                  : {}),
                ...(negRiskSpender
                  ? {
                      negRisk: {
                        spender: negRiskSpender,
                        allowance: ethers.formatUnits(
                          allowanceNegRisk ?? 0n,
                          6,
                        ),
                        allowanceRaw: (allowanceNegRisk ?? 0n).toString(),
                      },
                    }
                  : {}),
                ...(ammSpender
                  ? {
                      amm: {
                        spender: ammSpender,
                        allowance: ethers.formatUnits(allowanceAmm ?? 0n, 6),
                        allowanceRaw: (allowanceAmm ?? 0n).toString(),
                      },
                    }
                  : {}),
              },
            },
            conditionalTokens: {
              contractAddress: conditionalTokensAddress,
              ...(tokenId
                ? {
                    tokenBalance: {
                      tokenId,
                      balance: ethers.formatUnits(tokenBalanceRaw ?? 0n, 6),
                      balanceRaw: (tokenBalanceRaw ?? 0n).toString(),
                    },
                  }
                : {}),
              isApprovedForAll: {
                ...(clobSpender ? { clob: approvedClob ?? false } : {}),
                ...(negRiskSpender
                  ? { negRisk: approvedNegRisk ?? false }
                  : {}),
                ...(adapterSpender
                  ? { adapter: approvedAdapter ?? false }
                  : {}),
                ...(ammSpender ? { amm: approvedAmm ?? false } : {}),
              },
            },
            profile: profile ?? null,
            hasCredentials,
            ...(authContext?.authMode
              ? { authMode: authContext.authMode }
              : {}),
          };
        })();

        if (cacheEnabled) {
          limitlessAccountInflight.set(cacheKey, computePromise);
        }
        try {
          const payload = await computePromise;
          if (cacheEnabled) {
            writeLimitlessAccountCache(cacheKey, payload);
          }
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(payload);
        } finally {
          limitlessAccountInflight.delete(cacheKey);
        }
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to fetch Limitless account snapshot",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Limitless account snapshot",
        });
      }
    },
  );

  /**
   * GET /amm/quote
   * Returns a Base-backed Limitless AMM quote without depending on wallet provider chain state.
   */
  z.get(
    "/amm/quote",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessAmmQuoteQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const amountUsdRaw =
        request.query.amountUsdRaw != null
          ? BigInt(request.query.amountUsdRaw)
          : null;
      const amountSharesRaw =
        request.query.amountSharesRaw != null
          ? BigInt(request.query.amountSharesRaw)
          : null;

      if (
        request.query.side === "BUY" &&
        (amountUsdRaw == null || amountUsdRaw <= 0n)
      ) {
        reply.code(400);
        return reply.send({ error: "amountUsdRaw is required for BUY quotes" });
      }

      if (
        request.query.side === "SELL" &&
        (amountSharesRaw == null || amountSharesRaw <= 0n)
      ) {
        reply.code(400);
        return reply.send({
          error: "amountSharesRaw is required for SELL quotes",
        });
      }

      try {
        const quote = await fetchLimitlessAmmQuote({
          rpcUrl: env.baseRpcUrl,
          timeoutMs: env.baseRpcTimeoutMs,
          marketAddress: request.query.marketAddress,
          outcomeIndex: request.query.outcomeIndex,
          side: request.query.side,
          amountUsdRaw,
          amountSharesRaw,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          marketAddress: ethers.getAddress(request.query.marketAddress),
          outcomeIndex: request.query.outcomeIndex,
          side: request.query.side,
          sharesRaw: quote.sharesRaw?.toString() ?? null,
          returnAmountRaw: quote.returnAmountRaw?.toString() ?? null,
        });
      } catch (error) {
        request.log.warn(
          {
            error,
            marketAddress: request.query.marketAddress,
            outcomeIndex: request.query.outcomeIndex,
            side: request.query.side,
          },
          "Limitless AMM quote failed",
        );
        reply.code(502);
        return reply.send({
          error:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Unable to fetch Limitless AMM quote",
        });
      }
    },
  );

  /**
   * GET /redemption/status
   * Returns payout readiness for one or more Limitless conditions.
   */
  z.get(
    "/redemption/status",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessRedemptionQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless redemption requires an EVM wallet address",
        });
      }

      const conditionIds = request.query.conditionIds
        .map((value) => value.trim())
        .filter((value) => isBytes32(value));

      if (conditionIds.length === 0) {
        reply.code(400);
        return reply.send({ error: "No valid conditionIds provided." });
      }

      const adapter =
        typeof request.query.adapter === "string"
          ? request.query.adapter.trim()
          : null;

      try {
        const [payouts, adapterApproved] = await Promise.all([
          fetchConditionalTokensPayouts({ conditionIds }),
          adapter && isEvmWallet(adapter)
            ? fetchErc1155IsApprovedForAll({
                rpcUrl: env.baseRpcUrl,
                timeoutMs: env.baseRpcTimeoutMs,
                contractAddress: env.limitlessConditionalTokensAddress,
                owner: signer,
                operator: adapter,
              })
            : Promise.resolve(null),
        ]);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "limitless",
          signer,
          conditionalTokens: {
            contractAddress: env.limitlessConditionalTokensAddress,
          },
          adapter: adapter ?? null,
          adapterApproved,
          conditions: payouts,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to fetch Limitless redemption status",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Limitless redemption status",
        });
      }
    },
  );

  z.get(
    "/redemption-plan",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessRedemptionPlanQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless redemption requires an EVM wallet address",
        });
      }

      try {
        const plan = await buildLimitlessRedemptionPlan({
          rpcUrl: env.baseRpcUrl,
          timeoutMs: env.baseRpcTimeoutMs,
          owner: signer,
          conditionId: request.query.conditionId,
          tokenId: request.query.tokenId,
          outcome: request.query.outcome,
          isNegRisk: request.query.negRisk === true,
          adapterAddress: request.query.adapter ?? null,
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
            conditionId: request.query.conditionId,
            outcome: request.query.outcome,
          },
          "Failed to build Limitless redemption plan",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to prepare Limitless redemption",
        });
      }
    },
  );

  /**
   * POST /order
   */
  z.post(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless order requires an EVM wallet address",
        });
      }

      const partnerAuth = await requireLimitlessPartnerAuth({
        reply,
        userId: user.id,
        walletAddress: signer,
      });
      if (!partnerAuth) return;

      const { profile, requestAuth } = partnerAuth;
      const ownerId = profile?.id;
      if (!ownerId) {
        reply.code(400);
        return reply.send({
          error: "Limitless profile mapping is missing for this wallet.",
        });
      }
      if (request.body.ownerId != null && request.body.ownerId !== ownerId) {
        app.log.warn(
          {
            userId: user.id,
            walletAddress: signer,
            requestedOwnerId: request.body.ownerId,
            resolvedOwnerId: ownerId,
          },
          "Ignoring client-supplied Limitless ownerId; using resolved ownerId",
        );
      }

      const order = request.body.order;
      const orderSigner = typeof order.signer === "string" ? order.signer : "";
      if (normalizeAddress(orderSigner) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "Order signer must match the selected wallet",
        });
      }

      const maker = typeof order.maker === "string" ? order.maker : "";
      if (normalizeAddress(maker) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "Order maker must match the selected wallet",
        });
      }
      const checksumSigner = toChecksumAddress(signer);
      if (!checksumSigner) {
        reply.code(400);
        return reply.send({
          error: "Selected wallet is not a valid EVM address",
        });
      }

      const side = normalizeOrderSide(order.side);
      if (!side) {
        reply.code(400);
        return reply.send({
          error: "Order side must be BUY/SELL (or 0/1)",
        });
      }

      let orderForUpstream: Record<string, unknown>;
      let coercedMakerAmount: number | null = null;
      let coercedTakerAmount: number | null = null;
      let coercedNonce: number | null = null;
      let coercedPrice: number | null = null;
      let coercedSideValue: number | null = null;
      try {
        const salt = coerceOrderNumber(order.salt, "salt");
        const makerAmount = coerceOrderNumber(order.makerAmount, "makerAmount");
        const takerAmount = coerceOrderNumber(order.takerAmount, "takerAmount");
        const expirationValue = order.expiration;
        const expiration =
          typeof expirationValue === "string"
            ? expirationValue.trim()
            : expirationValue == null
              ? null
              : String(expirationValue);
        const nonce = coerceOrderNumber(order.nonce, "nonce");
        const feeRateBps = coerceOrderNumber(
          order.feeRateBps ?? 0,
          "feeRateBps",
        );
        const profileFeeRateBps = profile.rank?.feeRateBps;
        if (
          profileFeeRateBps != null &&
          Number.isFinite(profileFeeRateBps) &&
          profileFeeRateBps >= 0 &&
          feeRateBps != null &&
          feeRateBps !== Math.trunc(profileFeeRateBps)
        ) {
          reply.code(409);
          return reply.send({
            error: "Limitless fee rate changed. Refresh the order and try again.",
          });
        }
        const sideValue = coerceOrderNumber(order.side, "side");
        const signatureType = coerceOrderNumber(
          order.signatureType,
          "signatureType",
        );
        const price =
          order.price == null
            ? null
            : coerceOrderNumber(order.price, "price", { allowFloat: true });

        if (
          salt == null ||
          makerAmount == null ||
          takerAmount == null ||
          expiration == null ||
          expiration === "" ||
          nonce == null ||
          sideValue == null ||
          signatureType == null
        ) {
          reply.code(400);
          return reply.send({
            error: "Order numeric fields are required.",
          });
        }

        coercedMakerAmount = makerAmount;
        coercedTakerAmount = takerAmount;
        coercedNonce = nonce;
        coercedPrice = price;
        coercedSideValue = sideValue;
        orderForUpstream = {
          ...order,
          maker: checksumSigner,
          signer: checksumSigner,
          salt,
          makerAmount,
          takerAmount,
          expiration,
          nonce,
          feeRateBps,
          side: sideValue,
          signatureType,
          ...(price == null ? {} : { price }),
        };
      } catch {
        reply.code(400);
        return reply.send({
          error: "Invalid order data.",
        });
      }

      if (request.body.orderType === "FOK") {
        if (coercedTakerAmount !== 1) {
          reply.code(400);
          return reply.send({
            error: "FOK orders require takerAmount to equal 1.",
          });
        }
        if (coercedNonce !== 0) {
          reply.code(400);
          return reply.send({
            error: "FOK orders require nonce to equal 0.",
          });
        }
        if (coercedPrice != null) {
          reply.code(400);
          return reply.send({
            error: "FOK orders must not include price.",
          });
        }
      } else {
        if (coercedPrice == null) {
          reply.code(400);
          return reply.send({
            error: "GTC orders require a price.",
          });
        }
        if (
          coercedMakerAmount == null ||
          coercedTakerAmount == null ||
          coercedSideValue == null
        ) {
          reply.code(400);
          return reply.send({
            error: "GTC orders require makerAmount, takerAmount, and side.",
          });
        }
        const priceRaw = Math.round(coercedPrice * 1_000_000);
        if (priceRaw <= 0 || priceRaw >= 1_000_000) {
          reply.code(400);
          return reply.send({
            error: "GTC price must be between 0 and 1.",
          });
        }
        if (priceRaw % 1_000 !== 0) {
          reply.code(400);
          return reply.send({
            error: "GTC price must align to 0.001 tick size.",
          });
        }
        const sharesRaw =
          coercedSideValue === 0 ? coercedTakerAmount : coercedMakerAmount;
        if (sharesRaw <= 0) {
          reply.code(400);
          return reply.send({
            error: "GTC share size must be positive.",
          });
        }
        if (sharesRaw % 1_000 !== 0) {
          reply.code(400);
          return reply.send({
            error: "GTC size must align to 0.001 shares.",
          });
        }
        const quoteRaw =
          coercedSideValue === 0 ? coercedMakerAmount : coercedTakerAmount;
        if (quoteRaw <= 0) {
          reply.code(400);
          return reply.send({
            error: "GTC quote size must be positive.",
          });
        }
        const numerator = BigInt(sharesRaw) * BigInt(priceRaw);
        const denominator = BigInt(1_000_000);
        const expectedQuote =
          coercedSideValue === 0
            ? Number((numerator + denominator - BigInt(1)) / denominator)
            : Number(numerator / denominator);
        if (Math.abs(expectedQuote - quoteRaw) > 1) {
          reply.code(400);
          return reply.send({
            error:
              "GTC order amounts are not aligned with price tick and share size.",
          });
        }
      }

      const requestedRawTokenId = normalizeRawLimitlessTokenIdFromUnknown(
        orderForUpstream.tokenId,
      );
      if (!requestedRawTokenId) {
        reply.code(400);
        return reply.send({ error: "Order tokenId is invalid." });
      }
      const marketTokens = await resolveLimitlessTokenPairForSlug({
        slug: request.body.marketSlug,
        requestAuth,
      });
      const allowedRawTokenIds = [
        marketTokens?.tokenYes ?? null,
        marketTokens?.tokenNo ?? null,
      ].filter((entry): entry is string => Boolean(entry));
      if (!allowedRawTokenIds.length) {
        reply.code(400);
        return reply.send({
          error:
            "Unable to validate market tokens for this marketSlug. Please refresh and retry.",
        });
      }
      if (!allowedRawTokenIds.includes(requestedRawTokenId)) {
        reply.code(400);
        return reply.send({
          error: "Order tokenId does not belong to marketSlug.",
          marketSlug: request.body.marketSlug,
          tokenId: requestedRawTokenId,
        });
      }

      const tokenId = normalizeLimitlessScopedTokenId(requestedRawTokenId);
      const makerAmount = coercedMakerAmount;
      const takerAmount = coercedTakerAmount;
      const price = coercedPrice;
      const size = deriveSize(
        request.body.orderType,
        side,
        makerAmount,
        takerAmount,
      );
      const orderPayload = {
        order: orderForUpstream,
        orderType: request.body.orderType,
        marketSlug: request.body.marketSlug,
        ownerId,
        onBehalfOf: ownerId,
      };

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: "/orders",
        ...requestAuth,
        body: orderPayload,
      });

      if (!upstream.ok) {
        const upstreamMessage = extractLimitlessMessage(upstream.payload);
        if (
          request.body.orderType === "FOK" &&
          isLimitlessFokUnmatchedMessage(upstreamMessage)
        ) {
          const venueOrderId =
            extractLimitlessOrderIdFromMessage(upstreamMessage);
          if (venueOrderId) {
            const now = new Date();
            const rawError = stringifyLimitlessRawError(upstream.payload);
            await storeOrder(pool, {
              userId: user.id,
              walletAddress: signer,
              signerAddress: signer,
              venue: "limitless",
              venueOrderId,
              tokenId: tokenId ?? null,
              side,
              orderType: request.body.orderType,
              price,
              size,
              status: "expired",
              errorMessage: LIMITLESS_FOK_UNMATCHED_MESSAGE,
              rawError,
              orderPayload,
              lastUpdate: now,
            });
            await pool.query(
              `
                update orders
                set status = 'expired',
                    error_message = $4,
                    raw_error = coalesce($5, raw_error),
                    last_update = $6
                where user_id = $1
                  and (wallet_address = $2 or signer_address = $2)
                  and venue = 'limitless'
                  and venue_order_id = $3
              `,
              [
                user.id,
                signer,
                venueOrderId,
                LIMITLESS_FOK_UNMATCHED_MESSAGE,
                rawError,
                now,
              ],
            );
          }

          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: false,
            reason: LIMITLESS_FOK_UNMATCHED_REASON,
            message: LIMITLESS_FOK_UNMATCHED_MESSAGE,
            status: "expired",
            executionStatus: "UNMATCHED",
            orderId: venueOrderId ?? undefined,
            payload: upstream.payload,
          });
        }
        reply.code(mapLimitlessUpstreamStatus(upstream.status));
        return reply.send({
          error: "Limitless order placement failed",
          ...(upstreamMessage ? { message: upstreamMessage } : {}),
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const venueOrderId =
        (isRecord(upstream.payload) &&
          isRecord(upstream.payload.order) &&
          typeof upstream.payload.order.id === "string" &&
          upstream.payload.order.id) ||
        null;

      if (!venueOrderId) {
        reply.code(502);
        return reply.send({
          error: "Limitless order placed but no orderId returned",
          payload: upstream.payload,
        });
      }

      const status =
        (isRecord(upstream.payload) &&
          isRecord(upstream.payload.order) &&
          typeof upstream.payload.order.status === "string" &&
          upstream.payload.order.status) ||
        "submitted";

      const immediateFill =
        request.body.orderType === "FOK"
          ? extractLimitlessImmediateFill(upstream.payload, side, {
              price,
              size,
            })
          : null;
      const confirmedImmediateFill =
        immediateFill != null && isLimitlessTerminalFillStatus(status)
          ? immediateFill
          : null;
      const storedPrice =
        confirmedImmediateFill && confirmedImmediateFill.shares > 0
          ? (price ??
            confirmedImmediateFill.notionalUsd / confirmedImmediateFill.shares)
          : price;
      const storedSize =
        confirmedImmediateFill && confirmedImmediateFill.shares > 0
          ? (size ?? confirmedImmediateFill.shares)
          : size;
      const confirmedFillAt = confirmedImmediateFill ? new Date() : null;

      const stored = await storeOrder(pool, {
        userId: user.id,
        walletAddress: signer,
        signerAddress: signer,
        venue: "limitless",
        venueOrderId,
        tokenId: tokenId ?? null,
        side,
        orderType: request.body.orderType,
        price: storedPrice,
        size: storedSize,
        status,
        errorMessage: null,
        rawError: null,
        orderPayload,
        lastUpdate: confirmedFillAt,
        filledAt: confirmedFillAt,
      });

      if (stored.kind === "stored" && confirmedFillAt) {
        try {
          await upsertLimitlessVenueShareAccrualFromOrderPayload(pool, {
            orderId: stored.order.id,
            userId: user.id,
            walletAddress: signer,
            signerAddress: signer,
            venueOrderId,
            orderHash: null,
            tokenId: tokenId ?? null,
            side,
            filledAt: confirmedFillAt,
            lastUpdate: confirmedFillAt,
            postedAt: stored.order.posted_at,
            payload: upstream.payload,
          });
        } catch (error) {
          app.log.warn(
            {
              error,
              userId: user.id,
              walletAddress: signer,
              venueOrderId,
            },
            "Limitless venue fee share accrual upsert failed",
          );
        }
      }

      let referralFirstTrade = null;
      if (
        stored.kind === "stored" &&
        request.body.orderType === "FOK" &&
        tokenId
      ) {
        if (confirmedImmediateFill) {
          referralFirstTrade = await tryRecordReferralFirstTradeConversion(
            pool,
            {
              userId: user.id,
              venue: "limitless",
              status,
              sourceType: "order",
              sourceId: venueOrderId,
              txHash: null,
              logger: app.log,
            },
          );
        }
        let optimisticApplied = false;
        if (confirmedImmediateFill) {
          try {
            const optimisticResult = await applyOptimisticPositionTrade(pool, {
              userId: user.id,
              walletAddress: signer,
              venue: "limitless",
              tokenId,
              side,
              shares: confirmedImmediateFill.shares,
              notionalUsd: confirmedImmediateFill.notionalUsd,
            });
            optimisticApplied = optimisticResult.applied;
            if (optimisticResult.applied) {
              await markOrderPositionDeltaApplied(pool, {
                id: stored.order.id,
              });
            }
          } catch (error) {
            app.log.warn(
              {
                error,
                userId: user.id,
                walletAddress: signer,
                tokenId,
                side,
              },
              "Limitless optimistic position update failed",
            );
          }
        }
        app.log.debug(
          {
            userId: user.id,
            walletAddress: signer,
            tokenId,
            side,
            status,
            hasImmediateFill: Boolean(immediateFill),
            optimisticApplied,
          },
          "Limitless optimistic position evaluation",
        );
      }

      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: user.id,
          venue: "limitless",
          status,
          side,
          size: storedSize,
          price: storedPrice,
          orderId: venueOrderId,
          tokenId: tokenId ?? null,
          walletAddress: signer,
        }),
        app.log,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        orderId: venueOrderId,
        status,
        referralFirstTrade: referralFirstTrade ?? undefined,
        payload: upstream.payload,
      });
    },
  );

  /**
   * POST /orders/amm
   * Store on-chain AMM executions as filled orders for portfolio/position sync.
   */
  z.post(
    "/orders/amm",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessAmmOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless AMM order requires an EVM wallet address",
        });
      }

      const tokenId = normalizeLimitlessScopedTokenId(request.body.tokenId);
      if (!tokenId) {
        reply.code(400);
        return reply.send({ error: "tokenId is required" });
      }

      const side = request.body.side;
      const size = request.body.size;
      const amountUsd = request.body.amountUsd ?? null;
      let price = request.body.price ?? null;
      if (price == null && amountUsd != null && size > 0) {
        price = amountUsd / size;
      }
      if (price != null && (!Number.isFinite(price) || price <= 0)) {
        price = null;
      }

      const txHash = request.body.txHash;
      const venueOrderId = `amm:${txHash}:${tokenId}`;
      const now = new Date();

      const stored = await storeOrder(pool, {
        userId: user.id,
        walletAddress: signer,
        signerAddress: signer,
        venue: "limitless",
        venueOrderId,
        tokenId,
        side,
        orderType: "FOK",
        price,
        size,
        status: "filled",
        errorMessage: null,
        rawError: null,
        orderPayload: {
          ...request.body,
          tokenId,
          price,
        },
        orderHash: txHash,
        postedAt: now,
        lastUpdate: now,
        filledAt: now,
      });

      const referralFirstTrade =
        stored.kind === "stored"
          ? await tryRecordReferralFirstTradeConversion(pool, {
              userId: user.id,
              venue: "limitless",
              status: "filled",
              sourceType: "amm",
              sourceId: venueOrderId,
              txHash,
              logger: app.log,
            })
          : null;

      const fallbackNotional =
        amountUsd != null && Number.isFinite(amountUsd) && amountUsd > 0
          ? amountUsd
          : price != null && Number.isFinite(price) && price > 0
            ? price * size
            : null;
      if (stored.kind === "stored" && fallbackNotional != null) {
        try {
          await recordLimitlessVolumeEvent(pool, {
            userId: user.id,
            walletAddress: signer,
            sourceId: venueOrderId,
            notionalUsd: fallbackNotional,
            createdAt: now,
          });
        } catch (error) {
          app.log.warn(
            {
              error,
              userId: user.id,
              walletAddress: signer,
              orderId: venueOrderId,
            },
            "Limitless AMM volume event insert failed",
          );
        }
        try {
          const optimisticResult = await applyOptimisticPositionTrade(pool, {
            userId: user.id,
            walletAddress: signer,
            venue: "limitless",
            tokenId,
            side,
            shares: size,
            notionalUsd: fallbackNotional,
          });
          if (optimisticResult.applied) {
            await markOrderPositionDeltaApplied(pool, { id: stored.order.id });
          }
        } catch (error) {
          app.log.warn(
            {
              error,
              userId: user.id,
              walletAddress: signer,
              tokenId,
              side,
            },
            "Limitless AMM optimistic position update failed",
          );
        }
      }

      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: user.id,
          venue: "limitless",
          status: "filled",
          side,
          size,
          price: price ?? null,
          orderId: venueOrderId,
          tokenId,
          walletAddress: signer,
        }),
        app.log,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        orderId: venueOrderId,
        referralFirstTrade: referralFirstTrade ?? undefined,
      });
    },
  );

  /**
   * POST /orders/sync
   * Fetch open orders from Limitless and upsert them into `orders`.
   */
  z.post(
    "/orders/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const partnerAuth = await requireLimitlessPartnerAuth({
        reply,
        userId: user.id,
        walletAddress: signer,
      });
      if (!partnerAuth) return;

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(
          request.query.slug,
        )}/user-orders`,
        ...partnerAuth.requestAuth,
        headers: buildLimitlessOnBehalfHeaders(partnerAuth.profile),
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless orders sync failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const ordersRaw = extractLimitlessOrders(upstream.payload);
      let storedNew = 0;
      let alreadyKnown = 0;
      let skippedNoId = 0;
      const orderIds: string[] = [];

      for (const order of ordersRaw) {
        const venueOrderId = extractLimitlessOrderId(order);
        if (!venueOrderId) {
          skippedNoId += 1;
          continue;
        }
        orderIds.push(venueOrderId);

        const tokenId = extractLimitlessTokenId(order);
        const side = extractLimitlessOrderSide(order);
        const orderType = extractLimitlessOrderType(order);
        const status = extractLimitlessOrderStatus(order);
        const price = extractLimitlessOrderPrice(order);
        const size = extractLimitlessOrderSize(order);

        const result = await storeOrder(pool, {
          userId: user.id,
          walletAddress: signer,
          signerAddress: signer,
          venue: "limitless",
          venueOrderId,
          tokenId: tokenId ?? null,
          side,
          orderType: orderType ?? undefined,
          price,
          size,
          status,
          errorMessage: null,
          rawError: null,
        });

        if (result.kind === "stored") storedNew += 1;
        if (result.kind === "exists") alreadyKnown += 1;
      }

      const normalizedFokSizes = await normalizeLimitlessFokOrderSizesForMarket(
        pool,
        {
          userId: user.id,
          walletAddress: signer,
          marketSlug: request.query.slug,
        },
      );
      let historyStats: Awaited<
        ReturnType<typeof syncLimitlessHistoryForWallet>
      > | null = null;
      let historyError: string | null = null;
      let expiredStaleFok = 0;
      let metricsError: string | null = null;

      try {
        historyStats = await syncLimitlessHistoryForWallet(pool, {
          userId: user.id,
          walletAddress: signer,
          authContext: partnerAuth.authContext,
          limit: 100,
        });
        expiredStaleFok = await expireStaleLimitlessFokOrders(pool, {
          userId: user.id,
          walletAddress: signer,
          marketSlug: request.query.slug,
          activeVenueOrderIds: orderIds,
        });
      } catch (error) {
        historyError =
          error instanceof Error
            ? error.message
            : "Limitless history sync failed.";
        app.log.warn(
          {
            error,
            userId: user.id,
            walletAddress: signer,
            marketSlug: request.query.slug,
          },
          "Limitless order history sync failed during order sync",
        );
      }

      if (historyStats || expiredStaleFok > 0) {
        try {
          await recomputePositionMetricsForWallet(pool, {
            userId: user.id,
            walletAddress: signer,
            venue: "limitless",
          });
        } catch (error) {
          metricsError =
            error instanceof Error
              ? error.message
              : "Limitless position metrics update failed.";
          app.log.error(
            { error, userId: user.id, walletAddress: signer },
            "Limitless position metrics update failed during order sync",
          );
        }
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "limitless",
        walletAddress: signer,
        fetched: ordersRaw.length,
        storedNew,
        alreadyKnown,
        skippedNoId,
        normalizedFokSizes,
        expiredStaleFok,
        history: historyStats,
        historyError,
        metricsError,
        sampleVenueOrderIds: orderIds.slice(0, 10),
      });
    },
  );

  /**
   * POST /orders/history/sync
   * Fetch portfolio history from Limitless and upsert into `orders`.
   */
  z.post(
    "/orders/history/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessHistoryQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const walletAddresses = await resolveWalletAddresses(
        user.id,
        signer,
        query.wallets,
      );

      if (walletAddresses.length === 0) {
        reply.code(400);
        return reply.send({ error: "No wallets available to sync." });
      }

      const results: Array<{
        walletAddress: string;
        status: "ok" | "error" | "skipped";
        fetched?: number;
        nextCursor?: string | null;
        storedNew?: number;
        alreadyKnown?: number;
        skippedNoId?: number;
        skippedNoSide?: number;
        skippedNoOutcome?: number;
        skippedNoMarket?: number;
        skippedNoToken?: number;
        error?: string;
        sampleVenueOrderIds?: string[];
      }> = [];

      let synced = 0;
      let skipped = 0;
      let errors = 0;

      for (const wallet of walletAddresses) {
        if (!isEvmWallet(wallet)) {
          skipped += 1;
          results.push({
            walletAddress: wallet,
            status: "skipped",
            error: "EVM wallet required for Limitless.",
          });
          continue;
        }

        if (!isLimitlessPartnerHmacConfigured()) {
          errors += 1;
          results.push({
            walletAddress: wallet,
            status: "error",
            error: "Limitless is temporarily unavailable.",
          });
          continue;
        }

        const authContext = await resolveLimitlessAuthContext(user.id, wallet);
        if (!authContext) {
          errors += 1;
          results.push({
            walletAddress: wallet,
            status: "error",
            error: "Connect Limitless for this wallet before syncing history.",
          });
          continue;
        }

        const verification = await verifyLimitlessAuthContext({
          authContext,
          walletAddress: wallet,
        });
        if (!verification.ok) {
          errors += 1;
          results.push({
            walletAddress: wallet,
            status: "error",
            error:
              verification.message ??
              "Limitless connection is invalid for this wallet.",
          });
          continue;
        }

        let stats;
        try {
          stats = await syncLimitlessHistoryForWallet(pool, {
            userId: user.id,
            walletAddress: wallet,
            authContext,
            limit: query.limit,
            cursor: query.cursor,
          });
        } catch (error) {
          errors += 1;
          results.push({
            walletAddress: wallet,
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Limitless history sync failed.",
          });
          continue;
        }

        try {
          await recomputePositionMetricsForWallet(pool, {
            userId: user.id,
            walletAddress: wallet,
            venue: "limitless",
          });
        } catch (error) {
          app.log.error(
            { error, userId: user.id, walletAddress: wallet },
            "Limitless position metrics update failed",
          );
        }

        synced += 1;
        results.push({
          walletAddress: wallet,
          status: "ok",
          fetched: stats.fetched,
          nextCursor: stats.nextCursor,
          storedNew: stats.storedNew,
          alreadyKnown: stats.alreadyKnown,
          skippedNoId: stats.skippedNoId,
          skippedNoSide: stats.skippedNoSide,
          skippedNoOutcome: stats.skippedNoOutcome,
          skippedNoMarket: stats.skippedNoMarket,
          skippedNoToken: stats.skippedNoToken,
          sampleVenueOrderIds: stats.sampleVenueOrderIds,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "limitless",
        limit: query.limit,
        cursor: query.cursor ?? null,
        results,
        summary: {
          synced,
          skipped,
          errors,
        },
      });
    },
  );

  /**
   * GET /market/exchange
   * Resolve canonical exchange address for a market slug directly from Limitless.
   */
  z.get(
    "/market/exchange",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessMarketExchangeQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const authContext = await resolveLimitlessAuthContext(user.id, signer);
      const requestAuth =
        authContext && isLimitlessPartnerHmacConfigured()
          ? buildLimitlessRequestAuthInputs(authContext)
          : {};

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(request.query.slug)}`,
        ...requestAuth,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless market exchange fetch failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const exchangeAddress = extractLimitlessMarketExchangeAddress(
        upstream.payload,
      );
      const adapterAddress = extractLimitlessMarketAdapterAddress(
        upstream.payload,
      );
      let canonicalExchangeAddress = exchangeAddress;
      let canonicalAdapterAddress = adapterAddress;

      if (
        (request.query.forceCanonical || !exchangeAddress) &&
        authContext &&
        isEvmWallet(signer)
      ) {
        const signerChecksum = toChecksumAddress(signer);
        const tokenPair = extractLimitlessTokenPair(upstream.payload);
        const probeTokenId = tokenPair?.tokenYes ?? tokenPair?.tokenNo ?? null;
        const profile = await loadLimitlessProfileForWallet({
          walletAddress: signer,
          authContext,
          additionalData: authContext.creds.additionalData ?? null,
        });
        const ownerId = profile?.id;

        if (signerChecksum && ownerId && probeTokenId) {
          const probeSide = request.query.side === "SELL" ? 1 : 0;
          try {
            const probe = await limitlessRequest({
              method: "POST",
              requestPath: "/orders",
              ...requestAuth,
              body: {
                order: {
                  salt: Date.now() * 1000,
                  maker: signerChecksum,
                  signer: signerChecksum,
                  taker: "0x0000000000000000000000000000000000000000",
                  tokenId: probeTokenId,
                  makerAmount: 1_000_000,
                  takerAmount: 1,
                  expiration: "0",
                  nonce: 0,
                  feeRateBps: 300,
                  side: probeSide,
                  signatureType: 0,
                  signature: `0x${"0".repeat(130)}`,
                },
                orderType: "FOK",
                marketSlug: request.query.slug,
                ownerId,
                onBehalfOf: ownerId,
              },
            });
            if (!probe.ok) {
              const probedExchange = extractLimitlessExpectedExchangeAddress(
                probe.payload,
              );
              if (probedExchange) {
                canonicalExchangeAddress = probedExchange;
              }
            }
          } catch (error) {
            app.log.warn(
              { error, slug: request.query.slug },
              "Limitless canonical exchange probe failed",
            );
          }
        }
      }

      // Null-only fallback for legacy markets: when upstream payload does not
      // provide adapter/operator, derive known operator from canonical exchange.
      if (!canonicalAdapterAddress) {
        canonicalAdapterAddress = resolveLimitlessLegacyOperatorForExchange(
          canonicalExchangeAddress ?? exchangeAddress ?? null,
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        marketSlug: request.query.slug,
        exchangeAddress: canonicalExchangeAddress,
        adapterAddress: canonicalAdapterAddress,
      });
    },
  );

  /**
   * GET /orders/:orderId
   */
  z.get(
    "/orders/:orderId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessOrderIdParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const partnerAuth = await requireLimitlessPartnerAuth({
        reply,
        userId: user.id,
        walletAddress: signer,
      });
      if (!partnerAuth) return;

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/orders/${request.params.orderId}`,
        ...partnerAuth.requestAuth,
        headers: buildLimitlessOnBehalfHeaders(partnerAuth.profile),
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless order fetch failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * DELETE /order/:orderId
   */
  z.delete(
    "/order/:orderId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessOrderIdParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const storedWalletContext = await fetchStoredOrderWalletContext(pool, {
        userId: user.id,
        venue: "limitless",
        venueOrderId: request.params.orderId,
      });
      const cancelWallet =
        storedWalletContext?.walletAddress ??
        storedWalletContext?.signerAddress ??
        signer;
      const partnerAuth = await requireLimitlessPartnerAuth({
        reply,
        userId: user.id,
        walletAddress: cancelWallet,
      });
      if (!partnerAuth) return;

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: buildLimitlessOnBehalfQueryPath(
          "/orders/cancel",
          partnerAuth.profile,
        ),
        ...partnerAuth.requestAuth,
        body: { orderId: request.params.orderId },
      });

      if (!upstream.ok) {
        const upstreamMessage = extractLimitlessMessage(upstream.payload);
        reply.code(mapLimitlessUpstreamStatus(upstream.status));
        return reply.send({
          error: "Limitless cancel failed",
          ...(upstreamMessage ? { message: upstreamMessage } : {}),
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      await pool.query(
        `
          update orders
          set status = 'cancelled',
              cancelled_at = now(),
              last_update = now()
          where user_id = $1
            and (wallet_address = $2 or signer_address = $2)
            and venue = 'limitless'
            and venue_order_id = $3
        `,
        [user.id, cancelWallet, request.params.orderId],
      );

      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: user.id,
          venue: "limitless",
          status: "cancelled",
          orderId: request.params.orderId,
          walletAddress: cancelWallet,
        }),
        app.log,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * POST /orders/cancel-batch
   */
  z.post(
    "/orders/cancel-batch",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessCancelBatchBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const partnerAuth = await requireLimitlessPartnerAuth({
        reply,
        userId: user.id,
        walletAddress: signer,
      });
      if (!partnerAuth) return;

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: buildLimitlessOnBehalfQueryPath(
          "/orders/cancel-batch",
          partnerAuth.profile,
        ),
        ...partnerAuth.requestAuth,
        body: { orderIds: request.body.orderIds },
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless cancel batch failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const cancelledIds = extractLimitlessCanceledIds(
        upstream.payload,
        request.body.orderIds,
      );
      if (cancelledIds.length) {
        await pool.query(
          `
            update orders
            set status = 'cancelled',
                cancelled_at = now(),
                last_update = now()
            where user_id = $1
              and (wallet_address = $2 or signer_address = $2)
              and venue = 'limitless'
              and venue_order_id = ANY($3::text[])
          `,
          [user.id, signer, cancelledIds],
        );

        void createNotificationSafe(
          pool,
          {
            userId: user.id,
            type: "order_cancelled",
            title: "Orders cancelled",
            body: `${cancelledIds.length} Limitless orders`,
            severity: "warning",
            data: {
              venue: "limitless",
              orderIds: cancelledIds,
              walletAddress: signer,
            },
            dedupeKey: `order_cancelled_batch:${cancelledIds[0] ?? "batch"}`,
          },
          app.log,
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * DELETE /orders/all/:slug
   */
  z.delete(
    "/orders/all/:slug",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessSlugParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const partnerAuth = await requireLimitlessPartnerAuth({
        reply,
        userId: user.id,
        walletAddress: signer,
      });
      if (!partnerAuth) return;
      const requestAuth = partnerAuth.requestAuth;

      let openOrderIds: string[] = [];
      const openOrders = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(
          request.params.slug,
        )}/user-orders`,
        ...requestAuth,
        headers: buildLimitlessOnBehalfHeaders(partnerAuth.profile),
      });
      if (openOrders.ok) {
        openOrderIds = extractLimitlessOrders(openOrders.payload)
          .map((order) => extractLimitlessOrderId(order))
          .filter((orderId): orderId is string => Boolean(orderId));
      } else {
        app.log.warn(
          {
            status: openOrders.status,
            payload: openOrders.payload,
            slug: request.params.slug,
          },
          "Limitless cancel all: failed to fetch open orders",
        );
      }

      const upstream = await limitlessRequest({
        method: "DELETE",
        requestPath: buildLimitlessOnBehalfQueryPath(
          `/orders/all/${encodeURIComponent(request.params.slug)}`,
          partnerAuth.profile,
        ),
        ...requestAuth,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless cancel all failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const cancelledIds = extractLimitlessCanceledIds(
        upstream.payload,
        openOrderIds,
      );
      if (cancelledIds.length) {
        await pool.query(
          `
            update orders
            set status = 'cancelled',
                cancelled_at = now(),
                last_update = now()
            where user_id = $1
              and (wallet_address = $2 or signer_address = $2)
              and venue = 'limitless'
              and venue_order_id = ANY($3::text[])
          `,
          [user.id, signer, cancelledIds],
        );

        void createNotificationSafe(
          pool,
          {
            userId: user.id,
            type: "order_cancelled",
            title: "Orders cancelled",
            body: `${cancelledIds.length} Limitless orders`,
            severity: "warning",
            data: {
              venue: "limitless",
              orderIds: cancelledIds,
              walletAddress: signer,
            },
            dedupeKey: `order_cancelled_all:${cancelledIds[0] ?? "all"}`,
          },
          app.log,
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * GET /orders/open
   */
  z.get(
    "/orders/open",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const partnerAuth = await requireLimitlessPartnerAuth({
        reply,
        userId: user.id,
        walletAddress: signer,
      });
      if (!partnerAuth) return;

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(request.query.slug)}/user-orders`,
        ...partnerAuth.requestAuth,
        headers: buildLimitlessOnBehalfHeaders(partnerAuth.profile),
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless open orders failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );
};
