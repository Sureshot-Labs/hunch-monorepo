import type { Pool } from "@hunch/infra";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchPolymarketMarketInfo,
  type PolymarketMarketInfoRow,
} from "../repos/polymarket-markets.js";
import {
  calculatePolymarketBuilderFeeRaw,
  resolvePolymarketBuilderFeeBoundBps,
  resolvePolymarketFeePolicySnapshot,
  type PolymarketFeePolicySnapshot,
} from "./polymarket-builder-fees.js";
import { polymarketClient } from "./polymarket-client.js";

export type PolymarketSide = "BUY" | "SELL";
export type PolymarketOrderType = "GTC" | "GTD" | "FAK" | "FOK";
export type PolymarketClobOrderType = "GTC" | "GTD" | "FAK" | "FOK";
export type PolymarketAmountType = "usd" | "shares";
export type PolymarketFeeRoleAssumption = "maker" | "taker" | "maker_or_taker";

export type PlatformFeeCurve = {
  rate: number;
  exponent: number;
  takerOnly: boolean;
  makerBaseFeeBps: number;
  takerBaseFeeBps: number;
} | null;

export type PolymarketOrderbookSummary = {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  tickSize: number | null;
  minOrderSize: number | null;
  negRisk: boolean | null;
};

export type PolymarketQuoteContext = {
  orderbook: PolymarketOrderbookSummary;
  marketInfo: PolymarketMarketInfoRow | null;
  feePolicySnapshot: PolymarketFeePolicySnapshot;
  platformFeeCurve: PlatformFeeCurve;
  platformFeeCurveUnavailable?: boolean;
};

export type PolymarketQuoteResult = {
  ok: true;
  tokenId: string;
  side: PolymarketSide;
  orderType: PolymarketClobOrderType;
  amountType: PolymarketAmountType;
  amountUsd?: number;
  amountShares?: number;
  amountUsdUsed: number;
  bestBid: number | null;
  bestAsk: number | null;
  price: number;
  size: number;
  makerAmount: string;
  takerAmount: string;
  platformFeeEstimateRaw: string;
  builderFeeEstimateRaw: string;
  builderFeeBoundBps: number;
  totalFeeEstimateRaw: string;
  totalRequiredUsdcRaw: string | null;
  postOnly: boolean;
  feeRoleAssumption: PolymarketFeeRoleAssumption;
  builderRateSource: string;
  builderEnabled: boolean;
  builderTakerFeeBps: number;
  builderMakerFeeBps: number;
  orderPriceMinTickSize: number | null;
  orderMinSize: number | null;
  violatesMinOrderSize: boolean | null;
  negRisk: boolean | null;
  exchangeAddress: string | null;
  estimatedPayout: number;
  estimatedProfit: number;
  slippageBps: number | null;
};

export type PolymarketMaxSpendFailureReason =
  | "below_min_order"
  | "no_liquidity";

export type PolymarketMaxSpendResult = {
  quote: PolymarketQuoteResult;
  maxAmountUsdRaw: string;
};

export type PolymarketMaxSpendDetailedResult =
  | ({ ok: true } & PolymarketMaxSpendResult)
  | { ok: false; reason: PolymarketMaxSpendFailureReason };

export class PolymarketQuoteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly publicMessage: string,
    readonly reason:
      | "invalid_orderbook"
      | "missing_top_of_book"
      | "market_not_accepting_orders"
      | "quote_timeout"
      | "invalid_price"
      | "invalid_order_options"
      | "missing_amount"
      | "amount_too_small"
      | "fee_unavailable",
  ) {
    super(publicMessage);
    this.name = "PolymarketQuoteError";
  }
}

const USDC_SCALE = 1_000_000n;
const MARKET_USD_MICRO_STEP = 10_000n;
const MARKET_USD_MICRO_STEP_5_DEC = 10n;
const MARKET_SHARES_MICRO_STEP = 100n;
const MARKET_SHARES_MICRO_STEP_2_DEC = 10_000n;
const LIMIT_USD_MICRO_STEP = 100n;
const LIMIT_SHARES_MICRO_STEP = 10_000n;
const DEFAULT_POLYMARKET_PRICE_TICK = 0.01;
const MAX_POLYMARKET_PLATFORM_FEE_RATE = 1;
const MAX_POLYMARKET_BASE_FEE_BPS = 10_000;

function floorNumberToRaw(value: number, scale: bigint): bigint | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const raw = Math.floor(value * Number(scale) + 1e-9);
  return Number.isFinite(raw) && raw > 0 ? BigInt(raw) : null;
}

function roundDownToStep(value: bigint, step: bigint): bigint {
  return step > 0n ? value - (value % step) : value;
}

function readFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
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

function calculatePolymarketPlatformFeeRaw(inputs: {
  sizeRaw: bigint;
  price: number;
  feeRate: number;
  feeExponent: number;
}): bigint | null {
  const { sizeRaw, price, feeRate, feeExponent } = inputs;
  if (
    sizeRaw <= 0n ||
    !Number.isFinite(price) ||
    price <= 0 ||
    price >= 1 ||
    !Number.isFinite(feeRate) ||
    feeRate < 0 ||
    !Number.isFinite(feeExponent) ||
    feeExponent < 0
  ) {
    return null;
  }
  if (feeRate === 0) return 0n;
  const size = Number(sizeRaw) / 1_000_000;
  const term = Math.pow(price * (1 - price), feeExponent);
  const feeMicro = Math.ceil(size * feeRate * term * 1_000_000);
  if (!Number.isFinite(feeMicro) || feeMicro < 0) return null;
  return feeMicro > 0 ? BigInt(feeMicro) : 0n;
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

export function extractOrderbookSummary(
  payload: unknown,
): PolymarketOrderbookSummary | null {
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

export function normalizeOrderTypeForClob(
  value: unknown,
): PolymarketClobOrderType {
  const normalized = normalizeOrderType(value);
  if (
    normalized === "GTC" ||
    normalized === "GTD" ||
    normalized === "FAK" ||
    normalized === "FOK"
  ) {
    return normalized;
  }
  return "GTC";
}

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

function feeBaseRawForSide(
  side: PolymarketSide,
  makerAmountRaw: bigint,
  takerAmountRaw: bigint,
): bigint {
  return side === "BUY" ? makerAmountRaw : takerAmountRaw;
}

function calculateMaximumPolymarketMarketBuyFeeRaw(input: {
  feeExponent: number;
  feeRate: number;
  makerAmountRaw: bigint;
  maximumPrice: number;
  priceTick: number;
}): bigint | null {
  const minimumPrice = input.priceTick;
  const maximumPrice = input.maximumPrice;
  if (
    input.makerAmountRaw <= 0n ||
    !Number.isFinite(input.feeRate) ||
    input.feeRate < 0 ||
    !Number.isFinite(input.feeExponent) ||
    input.feeExponent < 0 ||
    !Number.isFinite(minimumPrice) ||
    !Number.isFinite(maximumPrice) ||
    minimumPrice <= 0 ||
    maximumPrice < minimumPrice ||
    maximumPrice >= 1
  ) {
    return null;
  }
  if (input.feeRate === 0) return 0n;
  const makerAmount = Number(input.makerAmountRaw);
  if (!Number.isSafeInteger(makerAmount)) return null;

  const maximumPowerProduct = (alpha: number, beta: number): number => {
    const evaluate = (price: number) =>
      Math.pow(price, alpha) * Math.pow(1 - price, beta);
    const candidates = [minimumPrice, maximumPrice];
    if (alpha > 0 && beta > 0) {
      const stationaryPrice = alpha / (alpha + beta);
      if (stationaryPrice >= minimumPrice && stationaryPrice <= maximumPrice) {
        candidates.push(stationaryPrice);
      }
    }
    return Math.max(...candidates.map(evaluate));
  };

  // A FOK market Buy signs a maximum price, not its eventual match price.
  // At any better price q, the venue may fill up to maker/q shares. The first
  // term is the continuous maximum of that fee curve; the second covers the
  // single raw share introduced by integer ceiling. One final raw unit covers
  // floating-point evaluation error, so this is an upper bound rather than a
  // mutable top-of-book estimate.
  const mainFeeUpperBound =
    makerAmount *
    input.feeRate *
    maximumPowerProduct(input.feeExponent - 1, input.feeExponent);
  const sizeRoundingUpperBound =
    input.feeRate * maximumPowerProduct(input.feeExponent, input.feeExponent);
  const feeUpperBound = mainFeeUpperBound + sizeRoundingUpperBound;
  if (
    !Number.isFinite(feeUpperBound) ||
    feeUpperBound <= 0 ||
    feeUpperBound > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  return BigInt(Math.ceil(feeUpperBound)) + 1n;
}

function calculatePolymarketFeeEstimateRaw(input: {
  feeRoleAssumption: PolymarketFeeRoleAssumption;
  feePolicySnapshot: PolymarketFeePolicySnapshot;
  makerAmountRaw: bigint;
  marketInfo: PolymarketMarketInfoRow | null;
  platformFeeCurve: PlatformFeeCurve;
  platformFeeCurveUnavailable: boolean;
  price: number;
  priceTick: number;
  side: PolymarketSide;
  sizeRaw: bigint;
  takerAmountRaw: bigint;
}): Readonly<{
  builderFeeRaw: bigint;
  builderFeeBps: number;
  platformFeeRaw: bigint;
  totalFeeRaw: bigint;
}> | null {
  const calculateForRole = (
    role: Exclude<PolymarketFeeRoleAssumption, "maker_or_taker">,
  ) => {
    // Without the live market metadata we do not know whether the fd curve is
    // taker-only or applies to both roles. Never infer a zero maker debit from
    // cached Gamma fields when the authoritative CLOB role metadata is absent.
    if (input.platformFeeCurveUnavailable) return null;

    const liveRoleBaseFeeBps =
      role === "taker"
        ? input.platformFeeCurve?.takerBaseFeeBps
        : input.platformFeeCurve?.makerBaseFeeBps;
    const platformFeeRawValue =
      liveRoleBaseFeeBps ??
      (role === "taker"
        ? input.marketInfo?.taker_fee_bps
        : input.marketInfo?.maker_fee_bps);
    const platformFeeBps =
      platformFeeRawValue != null && platformFeeRawValue !== ""
        ? Math.max(0, Number(platformFeeRawValue))
        : 0;
    const builderFeeBps = resolvePolymarketBuilderFeeBoundBps(
      input.feePolicySnapshot,
      role,
    );
    // fd.to=true is authoritative that the curve is taker-only. The SDK
    // contract says the flag is omitted when false, so an absent/false flag
    // means the curve also applies to makers. mbf/tbf are role-specific static
    // fallbacks when no dynamic curve applies to that role.
    const dynamicCurveApplies =
      input.platformFeeCurve != null &&
      input.platformFeeCurve.rate > 0 &&
      (role === "taker" || input.platformFeeCurve.takerOnly !== true);
    const effectivePlatformFeeCurve =
      dynamicCurveApplies && input.platformFeeCurve
        ? input.platformFeeCurve
        : platformFeeBps > 0
          ? { rate: platformFeeBps / 10_000, exponent: 1 }
          : null;
    let platformFeeRaw = 0n;
    if (effectivePlatformFeeCurve) {
      if (input.side === "BUY" && role === "taker") {
        const maximumPlatformFeeRaw = calculateMaximumPolymarketMarketBuyFeeRaw(
          {
            feeExponent: effectivePlatformFeeCurve.exponent,
            feeRate: effectivePlatformFeeCurve.rate,
            makerAmountRaw: input.makerAmountRaw,
            maximumPrice: input.price,
            priceTick: input.priceTick,
          },
        );
        if (maximumPlatformFeeRaw == null) return null;
        platformFeeRaw = maximumPlatformFeeRaw;
      } else {
        const calculatedPlatformFeeRaw = calculatePolymarketPlatformFeeRaw({
          sizeRaw: input.sizeRaw,
          price: input.price,
          feeRate: effectivePlatformFeeCurve.rate,
          feeExponent: effectivePlatformFeeCurve.exponent,
        });
        if (calculatedPlatformFeeRaw == null) return null;
        platformFeeRaw = calculatedPlatformFeeRaw;
      }
    }
    const builderFeeRaw = calculatePolymarketBuilderFeeRaw(
      feeBaseRawForSide(input.side, input.makerAmountRaw, input.takerAmountRaw),
      builderFeeBps,
    );
    return {
      builderFeeRaw,
      builderFeeBps,
      platformFeeRaw,
      totalFeeRaw: platformFeeRaw + builderFeeRaw,
    };
  };

  if (input.feeRoleAssumption === "maker") return calculateForRole("maker");
  if (input.feeRoleAssumption === "taker") return calculateForRole("taker");
  const maker = calculateForRole("maker");
  const taker = calculateForRole("taker");
  if (!maker || !taker) return null;
  return taker.totalFeeRaw > maker.totalFeeRaw ? taker : maker;
}

/**
 * Recompute the maximum collateral debit represented by one signed Buy.
 * The order signs nominal maker/taker amounts; venue and builder fees are
 * additional. GTC/GTD without postOnly can execute immediately or rest, so the
 * bound covers both roles. This is the canonical calculator used by quote,
 * max-spend, funding reservation, and final submission validation.
 */
export function calculatePolymarketSignedBuyRequiredSpendRaw(input: {
  context: PolymarketQuoteContext;
  makerAmountRaw: bigint;
  orderType: PolymarketClobOrderType;
  postOnly?: boolean;
  takerAmountRaw: bigint;
}): bigint | null {
  if (input.makerAmountRaw <= 0n || input.takerAmountRaw <= 0n) return null;
  if (
    input.postOnly === true &&
    (input.orderType === "FOK" || input.orderType === "FAK")
  ) {
    return null;
  }
  const priceTick = resolvePolymarketPriceTick(
    input.context.orderbook.tickSize ??
      (input.context.marketInfo?.order_price_min_tick_size != null
        ? Number(input.context.marketInfo.order_price_min_tick_size)
        : null),
  );
  const rawPrice = Number(input.makerAmountRaw) / Number(input.takerAmountRaw);
  const price = roundLimitPriceToTick(rawPrice, priceTick, "BUY");
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  const feeRoleAssumption: PolymarketFeeRoleAssumption =
    input.orderType === "FOK" || input.orderType === "FAK"
      ? "taker"
      : input.postOnly === true
        ? "maker"
        : "maker_or_taker";
  const fees = calculatePolymarketFeeEstimateRaw({
    feeRoleAssumption,
    feePolicySnapshot: input.context.feePolicySnapshot,
    makerAmountRaw: input.makerAmountRaw,
    marketInfo: input.context.marketInfo,
    platformFeeCurve: input.context.platformFeeCurve,
    platformFeeCurveUnavailable:
      input.context.platformFeeCurveUnavailable === true,
    price,
    priceTick,
    side: "BUY",
    sizeRaw: input.takerAmountRaw,
    takerAmountRaw: input.takerAmountRaw,
  });
  if (!fees) return null;
  return input.makerAmountRaw + fees.totalFeeRaw;
}

/** Backward-compatible alias for existing FOK callers. */
export function calculatePolymarketSignedFokBuyRequiredSpendRaw(input: {
  context: PolymarketQuoteContext;
  makerAmountRaw: bigint;
  takerAmountRaw: bigint;
}): bigint | null {
  return calculatePolymarketSignedBuyRequiredSpendRaw({
    ...input,
    orderType: "FOK",
    postOnly: false,
  });
}

function hasAvailableAskDepthForBuy(
  orderbook: PolymarketOrderbookSummary,
  quote: PolymarketQuoteResult,
): boolean {
  const targetSharesRaw = BigInt(quote.takerAmount);
  if (targetSharesRaw <= 0n) return false;

  let availableSharesRaw = 0n;
  for (const ask of orderbook.asks) {
    if (
      !Number.isFinite(ask.price) ||
      !Number.isFinite(ask.size) ||
      ask.price <= 0 ||
      ask.size <= 0
    ) {
      continue;
    }
    if (ask.price > quote.price + 1e-9) continue;

    const sizeRaw = floorNumberToRaw(ask.size, USDC_SCALE);
    if (sizeRaw == null || sizeRaw <= 0n) continue;
    availableSharesRaw += sizeRaw;
    if (availableSharesRaw >= targetSharesRaw) return true;
  }

  return false;
}

function exchangeAddressForNegRisk(negRisk: boolean | null): string | null {
  if (negRisk == null) return null;
  return negRisk
    ? env.polymarketNegRiskExchangeAddress
    : env.polymarketExchangeAddress;
}

export function parsePolymarketPlatformFeeCurve(
  payload: unknown,
): NonNullable<PlatformFeeCurve> {
  if (!isRecord(payload)) {
    throw new Error("Invalid Polymarket fee metadata response");
  }
  const readBaseFeeBps = (value: unknown): number => {
    if (value == null) return 0;
    const parsed = readFiniteNumber(value);
    if (parsed == null || parsed < 0 || parsed > MAX_POLYMARKET_BASE_FEE_BPS) {
      throw new Error("Invalid Polymarket base fee parameters");
    }
    return parsed;
  };
  const makerBaseFeeBps = readBaseFeeBps(payload.mbf ?? payload.makerBaseFee);
  const takerBaseFeeBps = readBaseFeeBps(payload.tbf ?? payload.takerBaseFee);
  if (payload.fd == null) {
    return {
      rate: 0,
      exponent: 1,
      takerOnly: true,
      makerBaseFeeBps,
      takerBaseFeeBps,
    };
  }
  if (!isRecord(payload.fd)) {
    throw new Error("Invalid Polymarket fee curve response");
  }
  const rate = readFiniteNumber(payload.fd.r);
  const exponent = readFiniteNumber(payload.fd.e);
  if (
    rate == null ||
    rate < 0 ||
    rate > MAX_POLYMARKET_PLATFORM_FEE_RATE ||
    exponent == null ||
    exponent < 0
  ) {
    throw new Error("Invalid Polymarket fee curve parameters");
  }
  if (payload.fd.to != null && typeof payload.fd.to !== "boolean") {
    throw new Error("Invalid Polymarket fee role metadata");
  }
  return {
    rate,
    exponent,
    takerOnly: payload.fd.to === true,
    makerBaseFeeBps,
    takerBaseFeeBps,
  };
}

async function fetchPolymarketPlatformFeeCurve(
  conditionId: string | null | undefined,
): Promise<PlatformFeeCurve> {
  if (!conditionId) return null;
  const payload = await polymarketClient.getClobMarketInfo(conditionId);
  return parsePolymarketPlatformFeeCurve(payload);
}

export async function loadPolymarketQuoteContext(
  pool: Pool,
  inputs: {
    tokenId: string;
    logWarn?: (args: {
      error: unknown;
      tokenId: string;
      conditionId: string | null | undefined;
    }) => void;
  },
): Promise<PolymarketQuoteContext> {
  const [orderbookPayload, marketInfo, feePolicySnapshot] = await Promise.all([
    polymarketClient.getOrderBook(inputs.tokenId),
    fetchPolymarketMarketInfo(pool, { tokenId: inputs.tokenId }),
    resolvePolymarketFeePolicySnapshot(pool),
  ]);

  const orderbook = extractOrderbookSummary(orderbookPayload);
  if (!orderbook) {
    throw new PolymarketQuoteError(
      502,
      "Invalid Polymarket orderbook response",
      "invalid_orderbook",
    );
  }

  let platformFeeCurve: PlatformFeeCurve = null;
  const conditionId = marketInfo?.condition_id;
  let platformFeeCurveUnavailable = !conditionId;
  if (conditionId) {
    try {
      platformFeeCurve = await fetchPolymarketPlatformFeeCurve(conditionId);
    } catch (error) {
      platformFeeCurveUnavailable = true;
      inputs.logWarn?.({
        error,
        tokenId: inputs.tokenId,
        conditionId,
      });
    }
  }

  return {
    orderbook,
    marketInfo,
    feePolicySnapshot,
    platformFeeCurve,
    platformFeeCurveUnavailable,
  };
}

export function calculatePolymarketQuote(inputs: {
  tokenId: string;
  side: PolymarketSide;
  orderType: PolymarketClobOrderType;
  amountType: PolymarketAmountType;
  amountUsdInput?: number | null;
  amountUsdRawInput?: bigint | null;
  amountSharesInput?: number | null;
  amountSharesRawInput?: bigint | null;
  limitPrice?: number | null;
  postOnly?: boolean;
  slippageBps?: number | null;
  context: PolymarketQuoteContext;
}): PolymarketQuoteResult {
  const { orderbook, marketInfo, feePolicySnapshot, platformFeeCurve } =
    inputs.context;
  const bestBid = findBestBid(orderbook.bids);
  const bestAsk = findBestAsk(orderbook.asks);
  const bestPrice = inputs.side === "BUY" ? bestAsk : bestBid;
  const isLimitOrder = inputs.orderType === "GTC" || inputs.orderType === "GTD";
  const postOnly = inputs.postOnly === true;
  if (postOnly && !isLimitOrder) {
    throw new PolymarketQuoteError(
      400,
      "postOnly is only supported for GTC/GTD orders",
      "invalid_order_options",
    );
  }
  const feeRoleAssumption: PolymarketFeeRoleAssumption = !isLimitOrder
    ? "taker"
    : postOnly
      ? "maker"
      : "maker_or_taker";

  if (!isLimitOrder && (bestPrice == null || !Number.isFinite(bestPrice))) {
    throw new PolymarketQuoteError(
      502,
      "Missing top-of-book price",
      "missing_top_of_book",
    );
  }

  if (marketInfo?.accepting_orders === false) {
    throw new PolymarketQuoteError(
      400,
      "Market is not accepting orders",
      "market_not_accepting_orders",
    );
  }

  const topPrice = bestPrice ?? NaN;
  const slippageBps = inputs.slippageBps ?? null;
  let price = isLimitOrder ? (inputs.limitPrice ?? NaN) : topPrice;
  if (!isLimitOrder && slippageBps != null) {
    const multiplier =
      inputs.side === "BUY"
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
    ? roundLimitPriceToTick(price, priceTick, inputs.side)
    : roundPriceToTick(price, priceTick, inputs.side);

  if (!isLimitOrder) {
    price = clampMarketOrderPriceToValidRange(price, priceTick);
  }

  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new PolymarketQuoteError(
      400,
      isLimitOrder
        ? "Polymarket limit price must be greater than 0 and less than 1"
        : "Invalid price computed from orderbook",
      "invalid_price",
    );
  }

  const priceMicro = BigInt(Math.round(price * 1_000_000));
  if (priceMicro <= 0n) {
    throw new PolymarketQuoteError(
      400,
      "Invalid price computed from orderbook",
      "invalid_price",
    );
  }

  let sizeMicro: bigint;
  let makerAmountMicro: bigint;
  let takerAmountMicro: bigint;

  if (inputs.orderType === "FOK" || inputs.orderType === "FAK") {
    const shareStep =
      inputs.side === "SELL"
        ? MARKET_SHARES_MICRO_STEP_2_DEC
        : MARKET_SHARES_MICRO_STEP;
    const usdcStep =
      inputs.side === "SELL"
        ? MARKET_USD_MICRO_STEP_5_DEC
        : MARKET_USD_MICRO_STEP;
    const precisionProduct = usdcStep * USDC_SCALE;
    const stepForPrice = precisionProduct / gcd(priceMicro, precisionProduct);
    const step = lcm(stepForPrice, shareStep);

    if (inputs.amountType === "shares") {
      const sizeMicroRaw =
        inputs.amountSharesRawInput ??
        (inputs.amountSharesInput != null
          ? floorNumberToRaw(inputs.amountSharesInput, USDC_SCALE)
          : null);
      if (sizeMicroRaw == null) {
        throw new PolymarketQuoteError(
          400,
          "amount is required for shares quotes",
          "missing_amount",
        );
      }

      sizeMicro = roundDownToStep(sizeMicroRaw, step);

      if (sizeMicro <= 0n) {
        throw new PolymarketQuoteError(
          400,
          "Amount too small for order",
          "amount_too_small",
        );
      }

      if (inputs.side === "BUY") {
        makerAmountMicro = (sizeMicro * priceMicro) / USDC_SCALE;
        takerAmountMicro = sizeMicro;
      } else {
        makerAmountMicro = sizeMicro;
        takerAmountMicro = (sizeMicro * priceMicro) / USDC_SCALE;
      }
    } else {
      const amountUsdRaw =
        inputs.amountUsdRawInput ??
        (inputs.amountUsdInput != null
          ? floorNumberToRaw(inputs.amountUsdInput, USDC_SCALE)
          : null);
      if (amountUsdRaw == null) {
        throw new PolymarketQuoteError(
          400,
          "amountUsd is required for USD quotes",
          "missing_amount",
        );
      }

      const makerAmountMicroMax = roundDownToStep(
        amountUsdRaw,
        MARKET_USD_MICRO_STEP,
      );
      if (makerAmountMicroMax <= 0n) {
        throw new PolymarketQuoteError(
          400,
          "Invalid amount or price",
          "invalid_price",
        );
      }

      const sizeMicroRaw = (makerAmountMicroMax * USDC_SCALE) / priceMicro;
      if (inputs.side === "BUY") {
        sizeMicro = roundDownToStep(sizeMicroRaw, shareStep);
        if (sizeMicro <= 0n) {
          throw new PolymarketQuoteError(
            400,
            "Amount too small for order",
            "amount_too_small",
          );
        }
        makerAmountMicro = makerAmountMicroMax;
        takerAmountMicro = sizeMicro;
      } else {
        sizeMicro = roundDownToStep(sizeMicroRaw, step);
        if (sizeMicro <= 0n) {
          throw new PolymarketQuoteError(
            400,
            "Amount too small for order",
            "amount_too_small",
          );
        }
        makerAmountMicro = sizeMicro;
        takerAmountMicro = (sizeMicro * priceMicro) / USDC_SCALE;
      }
    }
  } else {
    const shareStep = LIMIT_SHARES_MICRO_STEP;
    const usdcStep = LIMIT_USD_MICRO_STEP;
    const precisionProduct = usdcStep * USDC_SCALE;
    const stepForPrice = precisionProduct / gcd(priceMicro, precisionProduct);
    const step = lcm(stepForPrice, shareStep);

    if (inputs.amountType === "shares") {
      const sizeMicroRaw =
        inputs.amountSharesRawInput ??
        (inputs.amountSharesInput != null
          ? floorNumberToRaw(inputs.amountSharesInput, USDC_SCALE)
          : null);
      if (sizeMicroRaw == null) {
        throw new PolymarketQuoteError(
          400,
          "amount is required for shares quotes",
          "missing_amount",
        );
      }

      sizeMicro = roundDownToStep(sizeMicroRaw, step);

      if (sizeMicro <= 0n) {
        throw new PolymarketQuoteError(
          400,
          "Amount too small for order",
          "amount_too_small",
        );
      }
    } else {
      const amountUsdRaw =
        inputs.amountUsdRawInput ??
        (inputs.amountUsdInput != null
          ? floorNumberToRaw(inputs.amountUsdInput, USDC_SCALE)
          : null);
      if (amountUsdRaw == null) {
        throw new PolymarketQuoteError(
          400,
          "amountUsd is required for USD quotes",
          "missing_amount",
        );
      }

      const amountUsdMicro = roundDownToStep(amountUsdRaw, usdcStep);
      if (amountUsdMicro <= 0n) {
        throw new PolymarketQuoteError(
          400,
          "Invalid amount or price",
          "invalid_price",
        );
      }

      const sizeMicroRaw = (amountUsdMicro * USDC_SCALE) / priceMicro;
      sizeMicro = roundDownToStep(sizeMicroRaw, step);

      if (sizeMicro <= 0n) {
        throw new PolymarketQuoteError(
          400,
          "Amount too small for order",
          "amount_too_small",
        );
      }
    }

    makerAmountMicro =
      inputs.side === "BUY" ? (sizeMicro * priceMicro) / USDC_SCALE : sizeMicro;
    takerAmountMicro =
      inputs.side === "BUY" ? sizeMicro : (sizeMicro * priceMicro) / USDC_SCALE;
  }

  const minOrderSizeRaw =
    minOrderSize != null && Number.isFinite(minOrderSize) && minOrderSize > 0
      ? BigInt(Math.ceil(minOrderSize * 1_000_000))
      : null;
  const violatesMinOrderSize =
    minOrderSizeRaw != null ? sizeMicro < minOrderSizeRaw : null;
  const feeEstimate = calculatePolymarketFeeEstimateRaw({
    feeRoleAssumption,
    feePolicySnapshot,
    makerAmountRaw: makerAmountMicro,
    marketInfo,
    platformFeeCurve,
    platformFeeCurveUnavailable:
      inputs.context.platformFeeCurveUnavailable === true,
    price,
    priceTick,
    side: inputs.side,
    sizeRaw: sizeMicro,
    takerAmountRaw: takerAmountMicro,
  });
  if (!feeEstimate) {
    throw new PolymarketQuoteError(
      502,
      "Polymarket fee estimate is unavailable",
      "fee_unavailable",
    );
  }
  const platformFeeEstimateRaw = feeEstimate.platformFeeRaw;
  const builderFeeEstimateRaw = feeEstimate.builderFeeRaw;
  const totalFeeEstimateRaw = feeEstimate.totalFeeRaw;
  const totalRequiredUsdcRaw =
    inputs.side === "BUY" ? makerAmountMicro + totalFeeEstimateRaw : null;

  const size = Number(sizeMicro) / 1_000_000;
  const amountUsdUsed =
    inputs.side === "BUY"
      ? Number(makerAmountMicro) / 1_000_000
      : Number(takerAmountMicro) / 1_000_000;
  const estimatedPayout = size;
  const estimatedProfit =
    inputs.side === "BUY"
      ? estimatedPayout - amountUsdUsed
      : amountUsdUsed - estimatedPayout;

  const negRisk =
    orderbook.negRisk ??
    (marketInfo?.neg_risk != null ? Boolean(marketInfo.neg_risk) : null);

  return {
    ok: true,
    tokenId: inputs.tokenId,
    side: inputs.side,
    orderType: inputs.orderType,
    amountType: inputs.amountType,
    amountUsd: inputs.amountUsdInput ?? undefined,
    amountShares: inputs.amountSharesInput ?? undefined,
    amountUsdUsed,
    bestBid,
    bestAsk,
    price,
    size,
    makerAmount: makerAmountMicro.toString(),
    takerAmount: takerAmountMicro.toString(),
    platformFeeEstimateRaw: platformFeeEstimateRaw.toString(),
    builderFeeEstimateRaw: builderFeeEstimateRaw.toString(),
    builderFeeBoundBps: feeEstimate.builderFeeBps,
    totalFeeEstimateRaw: totalFeeEstimateRaw.toString(),
    totalRequiredUsdcRaw: totalRequiredUsdcRaw?.toString() ?? null,
    postOnly,
    feeRoleAssumption,
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
  };
}

function searchMaxPolymarketMarketBuyUsd(inputs: {
  context: PolymarketQuoteContext;
  tokenId: string;
  executableFundsRaw: bigint;
  slippageBps?: number | null;
  requireOrderbookDepth?: boolean;
}): PolymarketMaxSpendDetailedResult {
  const upperCents = inputs.executableFundsRaw / MARKET_USD_MICRO_STEP;
  if (upperCents <= 0n) return { ok: false, reason: "below_min_order" };

  const quoteAtCents = (cents: bigint): PolymarketQuoteResult | null => {
    if (cents <= 0n) return null;
    try {
      return calculatePolymarketQuote({
        tokenId: inputs.tokenId,
        side: "BUY",
        orderType: "FOK",
        amountType: "usd",
        amountUsdRawInput: cents * MARKET_USD_MICRO_STEP,
        slippageBps: inputs.slippageBps,
        context: inputs.context,
      });
    } catch (error) {
      if (
        error instanceof PolymarketQuoteError &&
        error.reason === "amount_too_small"
      ) {
        return null;
      }
      throw error;
    }
  };

  let low = 1n;
  let high = upperCents;
  let bestQuote: PolymarketQuoteResult | null = null;
  let bestCents = 0n;
  let sawMinValidQuote = false;
  let sawDepthLimitedQuote = false;

  while (low <= high) {
    const mid = (low + high) / 2n;
    const quote = quoteAtCents(mid);
    const totalRequiredRaw =
      quote?.totalRequiredUsdcRaw != null
        ? BigInt(quote.totalRequiredUsdcRaw)
        : null;
    if (!quote || quote.violatesMinOrderSize === true) {
      low = mid + 1n;
      continue;
    }
    sawMinValidQuote = true;
    if (
      inputs.requireOrderbookDepth === true &&
      !hasAvailableAskDepthForBuy(inputs.context.orderbook, quote)
    ) {
      sawDepthLimitedQuote = true;
      high = mid - 1n;
      continue;
    }
    if (
      totalRequiredRaw != null &&
      totalRequiredRaw <= inputs.executableFundsRaw
    ) {
      bestQuote = quote;
      bestCents = mid;
      low = mid + 1n;
    } else {
      high = mid - 1n;
    }
  }

  if (!bestQuote || bestCents <= 0n) {
    return {
      ok: false,
      reason:
        sawMinValidQuote && sawDepthLimitedQuote
          ? "no_liquidity"
          : "below_min_order",
    };
  }
  return {
    ok: true,
    quote: bestQuote,
    maxAmountUsdRaw: (bestCents * MARKET_USD_MICRO_STEP).toString(),
  };
}

export function findMaxPolymarketMarketBuyUsdDetailed(inputs: {
  context: PolymarketQuoteContext;
  tokenId: string;
  executableFundsRaw: bigint;
  slippageBps?: number | null;
  requireOrderbookDepth?: boolean;
}): PolymarketMaxSpendDetailedResult {
  return searchMaxPolymarketMarketBuyUsd(inputs);
}

export function findMaxPolymarketMarketBuyUsd(inputs: {
  context: PolymarketQuoteContext;
  tokenId: string;
  executableFundsRaw: bigint;
  slippageBps?: number | null;
  requireOrderbookDepth?: boolean;
}): PolymarketMaxSpendResult | null {
  const result = searchMaxPolymarketMarketBuyUsd(inputs);
  return result.ok
    ? {
        quote: result.quote,
        maxAmountUsdRaw: result.maxAmountUsdRaw,
      }
    : null;
}
