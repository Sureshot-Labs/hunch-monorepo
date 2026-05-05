import PQueue from "p-queue";

import { env } from "./env.js";

export type KalshiPublicMarketData = {
  ticker: string;
  bestBid: number | null;
  bestAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  lastPrice: number | null;
  volumeTotal: number | null;
  volume24h: number | null;
  openInterest: number | null;
  liquidity: number | null;
};

export type KalshiPublicEventData = {
  eventTicker: string;
  marketsByTicker: Map<string, KalshiPublicMarketData>;
};

export type KalshiPublicFetchSummary = {
  eventsByTicker: Map<string, KalshiPublicEventData>;
  attemptedEvents: number;
  fetchedEvents: number;
  cachedEvents: number;
  resolvedEvents: number;
  failedEvents: number;
  skippedEvents: number;
  errors: Array<{ eventTicker: string; error: string }>;
};

type CacheEntry = {
  data: KalshiPublicEventData;
  expiresAt: number;
};

const eventCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<KalshiPublicEventData | null>>();

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCachedKalshiPublicEvent(
  eventTicker: string,
): KalshiPublicEventData | null {
  const cached = eventCache.get(eventTicker);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    eventCache.delete(eventTicker);
    return null;
  }
  return cached.data;
}

function rememberKalshiPublicEvent(
  eventTicker: string,
  data: KalshiPublicEventData,
): void {
  const expiresAt = Date.now() + env.kalshiPublicCacheTtlSec * 1000;
  eventCache.set(eventTicker, { data, expiresAt });
  if (data.eventTicker !== eventTicker) {
    eventCache.set(data.eventTicker, { data, expiresAt });
  }
}

function mapKalshiPublicMarket(
  raw: Record<string, unknown>,
): KalshiPublicMarketData | null {
  const ticker = parseString(raw.ticker);
  if (!ticker) return null;
  return {
    ticker,
    bestBid: parseNumber(raw.yes_bid_dollars),
    bestAsk: parseNumber(raw.yes_ask_dollars),
    noBid: parseNumber(raw.no_bid_dollars),
    noAsk: parseNumber(raw.no_ask_dollars),
    lastPrice: parseNumber(raw.last_price_dollars),
    volumeTotal: parseNumber(raw.volume_fp),
    volume24h: parseNumber(raw.volume_24h_fp),
    openInterest: parseNumber(raw.open_interest_fp),
    liquidity: parseNumber(raw.liquidity_dollars),
  };
}

async function fetchKalshiPublicEvent(
  eventTicker: string,
): Promise<KalshiPublicEventData | null> {
  const cached = getCachedKalshiPublicEvent(eventTicker);
  if (cached) return cached;

  const existing = inflight.get(eventTicker);
  if (existing) return existing;

  const promise = (async (): Promise<KalshiPublicEventData | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      env.kalshiPublicTimeoutMs,
    );
    try {
      const base = env.kalshiPublicApiBase.replace(/\/+$/, "");
      const url = `${base}/trade-api/v2/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`;
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });

      if (response.status === 404) return null;
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Kalshi public event ${response.status}: ${body.slice(0, 500)}`,
        );
      }

      const raw = (await response.json()) as Record<string, unknown>;
      const event =
        raw.event && typeof raw.event === "object"
          ? (raw.event as Record<string, unknown>)
          : null;
      if (!event) return null;

      const normalizedTicker =
        parseString(event.event_ticker) ??
        parseString(event.eventTicker) ??
        eventTicker;
      const rawMarkets = Array.isArray(event.markets) ? event.markets : [];
      const marketsByTicker = new Map<string, KalshiPublicMarketData>();
      for (const entry of rawMarkets) {
        if (!entry || typeof entry !== "object") continue;
        const market = mapKalshiPublicMarket(entry as Record<string, unknown>);
        if (!market) continue;
        marketsByTicker.set(market.ticker, market);
      }

      if (!marketsByTicker.size) return null;

      const data = { eventTicker: normalizedTicker, marketsByTicker };
      rememberKalshiPublicEvent(eventTicker, data);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  })();

  inflight.set(eventTicker, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(eventTicker);
  }
}

export async function fetchKalshiPublicEvents(
  eventTickers: string[],
): Promise<KalshiPublicFetchSummary> {
  if (!env.kalshiPublicEnrichEnabled || !eventTickers.length) {
    return {
      eventsByTicker: new Map(),
      attemptedEvents: 0,
      fetchedEvents: 0,
      cachedEvents: 0,
      resolvedEvents: 0,
      failedEvents: 0,
      skippedEvents: 0,
      errors: [],
    };
  }

  const uniqueTickers: string[] = [];
  const seen = new Set<string>();
  for (const ticker of eventTickers) {
    const trimmed = parseString(ticker);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    uniqueTickers.push(trimmed);
  }

  const limitedTickers = uniqueTickers.slice(
    0,
    env.kalshiPublicMaxEventsPerCycle,
  );
  const eventsByTicker = new Map<string, KalshiPublicEventData>();
  const errors: Array<{ eventTicker: string; error: string }> = [];
  let fetchedEvents = 0;
  let cachedEvents = 0;
  let resolvedEvents = 0;
  let failedEvents = 0;

  const queue = new PQueue({ concurrency: env.kalshiPublicConcurrency });
  await Promise.all(
    limitedTickers.map((eventTicker) =>
      queue.add(async () => {
        const cached = getCachedKalshiPublicEvent(eventTicker);
        if (cached) {
          cachedEvents += 1;
          resolvedEvents += 1;
          eventsByTicker.set(eventTicker, cached);
          if (cached.eventTicker !== eventTicker) {
            eventsByTicker.set(cached.eventTicker, cached);
          }
          return;
        }

        try {
          const data = await fetchKalshiPublicEvent(eventTicker);
          if (!data) return;
          fetchedEvents += 1;
          resolvedEvents += 1;
          eventsByTicker.set(eventTicker, data);
          if (data.eventTicker !== eventTicker) {
            eventsByTicker.set(data.eventTicker, data);
          }
        } catch (error) {
          failedEvents += 1;
          if (errors.length < 5) {
            errors.push({ eventTicker, error: String(error) });
          }
        }
      }),
    ),
  );

  return {
    eventsByTicker,
    attemptedEvents: limitedTickers.length,
    fetchedEvents,
    cachedEvents,
    resolvedEvents,
    failedEvents,
    skippedEvents: Math.max(0, uniqueTickers.length - limitedTickers.length),
    errors,
  };
}
