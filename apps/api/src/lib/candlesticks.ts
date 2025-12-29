import { isRecord } from "./type-guards.js";

type CandleValues = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

const SUPPORTED_PERIOD_MINUTES = new Set([1, 60, 1440]);
const LIMITLESS_INTERVALS = [
  { interval: "1m", minutes: 1 },
  { interval: "1h", minutes: 60 },
  { interval: "6h", minutes: 360 },
  { interval: "1d", minutes: 1440 },
  { interval: "1w", minutes: 10080 },
] as const;
type LimitlessInterval = (typeof LIMITLESS_INTERVALS)[number]["interval"];

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseTimestampSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = value > 1_000_000_000_000 ? value / 1000 : value;
    return Math.floor(seconds);
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? Math.floor(time / 1000) : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    const numeric = Number.parseFloat(value);
    if (Number.isFinite(numeric)) {
      const seconds = numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
      return Math.floor(seconds);
    }
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

export function resolveLimitlessBaseInterval(
  periodIntervalMinutes: number,
): { interval: LimitlessInterval; minutes: number } {
  const requested = Number.isFinite(periodIntervalMinutes)
    ? Math.max(1, periodIntervalMinutes)
    : 1;
  let selected: (typeof LIMITLESS_INTERVALS)[number] = LIMITLESS_INTERVALS[0];
  for (const option of LIMITLESS_INTERVALS) {
    if (option.minutes <= requested) {
      selected = option;
    }
  }
  return { interval: selected.interval, minutes: selected.minutes };
}

export function shouldAggregateKalshiCandles(
  periodIntervalMinutes: number,
): boolean {
  return !SUPPORTED_PERIOD_MINUTES.has(periodIntervalMinutes);
}

export function shouldAggregateLimitlessCandles(
  periodIntervalMinutes: number,
  baseMinutes: number,
): boolean {
  return periodIntervalMinutes !== baseMinutes;
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

export function parseLimitlessCandlesticks(
  payload: unknown,
  side: "YES" | "NO",
): CandleValues[] {
  let entries: unknown[] = [];
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) {
      entries = payload.data;
    } else if (Array.isArray(payload.prices)) {
      entries = [payload];
    }
  }

  const outcomeEntries = entries.filter(isRecord);
  if (outcomeEntries.length === 0) return [];

  const sideLabel = side.toUpperCase();
  let selected: Record<string, unknown> | null = null;

  for (const entry of outcomeEntries) {
    const title = entry.title;
    if (typeof title === "string" && title.toUpperCase().includes(sideLabel)) {
      selected = entry;
      break;
    }
  }

  if (!selected) {
    if (sideLabel === "NO" && outcomeEntries.length > 1) {
      selected = outcomeEntries[1];
    } else {
      selected = outcomeEntries[0];
    }
  }

  const prices = isRecord(selected) ? selected.prices : null;
  if (!Array.isArray(prices)) return [];

  const candles: CandleValues[] = [];
  for (const entry of prices) {
    if (!isRecord(entry)) continue;
    const t =
      parseTimestampSeconds(entry.timestamp) ??
      parseTimestampSeconds(entry.ts) ??
      parseTimestampSeconds(entry.t);
    const price =
      toNumber(entry.price) ??
      toNumber(entry.p) ??
      toNumber(entry.value);
    if (t == null || price == null) continue;
    candles.push({ t, o: price, h: price, l: price, c: price });
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
