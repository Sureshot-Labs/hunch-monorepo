import { isRecord } from "./type-guards.js";

type CandleValues = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

const SUPPORTED_PERIOD_MINUTES = new Set([1, 60, 1440]);

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readKalshiPriceValue(
  record: Record<string, unknown> | undefined,
  key: string,
): number | null {
  if (!record) return null;
  const dollars = toNumber(record[`${key}_dollars`]);
  if (dollars != null) return dollars;
  const cents = toNumber(record[key]);
  return cents != null ? cents / 100 : null;
}

function getKalshiCandleValues(
  candle: Record<string, unknown>,
): CandleValues | null {
  const endTs =
    toNumber(candle.end_period_ts) ??
    toNumber(candle.end_ts) ??
    toNumber(candle.t);
  if (endTs == null) return null;

  const price = isRecord(candle.price) ? candle.price : undefined;
  const yesAsk = isRecord(candle.yes_ask) ? candle.yes_ask : undefined;
  const yesBid = isRecord(candle.yes_bid) ? candle.yes_bid : undefined;

  const open =
    readKalshiPriceValue(price, "open") ??
    readKalshiPriceValue(yesAsk, "open") ??
    readKalshiPriceValue(yesBid, "open");
  const high =
    readKalshiPriceValue(price, "high") ??
    readKalshiPriceValue(yesAsk, "high") ??
    readKalshiPriceValue(yesBid, "high");
  const low =
    readKalshiPriceValue(price, "low") ??
    readKalshiPriceValue(yesAsk, "low") ??
    readKalshiPriceValue(yesBid, "low");
  const close =
    readKalshiPriceValue(price, "close") ??
    readKalshiPriceValue(price, "mean") ??
    readKalshiPriceValue(yesAsk, "close") ??
    readKalshiPriceValue(yesBid, "close");

  const resolvedClose = close ?? open ?? high ?? low;
  if (resolvedClose == null) return null;

  return {
    t: endTs,
    o: open ?? resolvedClose,
    h: high ?? resolvedClose,
    l: low ?? resolvedClose,
    c: resolvedClose,
  };
}

function extractKalshiCandlestickEntries(payload: unknown): unknown[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const candlesticks = payload.candlesticks;
  if (Array.isArray(candlesticks)) return candlesticks;

  const marketCandlesticks = payload.market_candlesticks;
  if (Array.isArray(marketCandlesticks)) {
    return marketCandlesticks.flatMap((entry) =>
      Array.isArray(entry) ? entry : [],
    );
  }

  return [];
}

export function resolveKalshiBaseInterval(
  periodIntervalMinutes: number,
): number {
  if (periodIntervalMinutes <= 1) return 1;
  if (periodIntervalMinutes <= 60) return 1;
  if (periodIntervalMinutes <= 1440) return 60;
  return 1440;
}

export function shouldAggregateKalshiCandles(
  periodIntervalMinutes: number,
): boolean {
  return !SUPPORTED_PERIOD_MINUTES.has(periodIntervalMinutes);
}

export function parseKalshiCandlesticks(payload: unknown): CandleValues[] {
  const entries = extractKalshiCandlestickEntries(payload);
  const candles: CandleValues[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const values = getKalshiCandleValues(entry);
    if (!values) continue;
    candles.push(values);
  }

  return candles.sort((a, b) => a.t - b.t);
}

export function aggregateKalshiCandlesticks(
  candles: CandleValues[],
  periodIntervalMinutes: number,
  startTs: number,
  endTs: number,
): CandleValues[] {
  if (candles.length === 0) return [];
  if (periodIntervalMinutes <= 0) return [];

  const periodSeconds = periodIntervalMinutes * 60;
  const anchor = startTs;
  const aggregated: CandleValues[] = [];

  let current: CandleValues | null = null;
  let currentBucketEnd = 0;

  for (const candle of candles) {
    if (candle.t < startTs || candle.t > endTs) continue;
    const bucketIndex = Math.floor((candle.t - anchor) / periodSeconds);
    const bucketEnd = anchor + (bucketIndex + 1) * periodSeconds;

    if (!current || currentBucketEnd !== bucketEnd) {
      if (current) aggregated.push(current);
      currentBucketEnd = bucketEnd;
      current = {
        t: bucketEnd,
        o: candle.o,
        h: candle.h,
        l: candle.l,
        c: candle.c,
      };
      continue;
    }

    current.h = Math.max(current.h, candle.h);
    current.l = Math.min(current.l, candle.l);
    current.c = candle.c;
  }

  if (current) aggregated.push(current);
  return aggregated;
}

export function formatKalshiCandlesticks(candles: CandleValues[]) {
  return {
    candlesticks: candles.map((candle) => ({
      end_period_ts: candle.t,
      price: {
        open_dollars: candle.o,
        high_dollars: candle.h,
        low_dollars: candle.l,
        close_dollars: candle.c,
      },
    })),
  };
}
