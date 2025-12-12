// apps/indexer-kalshi/src/mappers.ts
import { v4 as uuid } from "uuid";
import type { z } from "zod";
import { KalshiEvent, KalshiMarket } from "./types";
import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";

const n = (v: unknown): number | null => {
  if (v == null) return null;
  const x = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(x) ? (x as number) : null;
};
const parseDate = (s?: string | null) => (s ? new Date(s) : null);
const minDate = (ds: Array<Date | null>): Date | null => {
  const dates = ds.filter((d): d is Date => d !== null);
  dates.sort((a, b) => a.getTime() - b.getTime());
  return dates[0] ?? null;
};
const maxDate = (ds: Array<Date | null>): Date | null => {
  const dates = ds.filter((d): d is Date => d !== null);
  dates.sort((a, b) => b.getTime() - a.getTime());
  return dates[0] ?? null;
};

export function mapEventRow(venueId: number, e: z.infer<typeof KalshiEvent>) {
  const id = uuid();

  const markets = (e.markets ?? []) as z.infer<typeof KalshiMarket>[];

  // aggregate from child markets
  const mOpens = markets.map((m) => parseDate(m.open_time));
  const mCloses = markets.map((m) =>
    parseDate(m.close_time ?? m.expiration_time),
  );
  const mLatest = markets.map((m) => {
    const latest = (m as Record<string, unknown>).latest_expiration_time;
    return parseDate(typeof latest === "string" ? latest : null);
  });

  const liqSum = markets.reduce((s, m) => s + (n(m.liquidity) ?? 0), 0);
  const vol24Sum = markets.reduce((s, m) => s + (n(m.volume_24h) ?? 0), 0);
  const volSum = markets.reduce((s, m) => s + (n(m.volume) ?? 0), 0);

  const statuses = markets.map((m) => (m.status ?? "open").toLowerCase());
  const anyOpen = statuses.some((s) =>
    ["open", "active", "trading"].includes(s),
  );
  const allShut =
    statuses.length > 0 &&
    statuses.every((s) => ["closed", "settled", "expired"].includes(s));

  // prefer event-level if present, else derive from markets
  const start = parseDate(e.open_time) ?? minDate(mOpens);
  const end =
    parseDate(e.close_time) ??
    parseDate(e.expiration_time) ??
    parseDate(e.latest_expiration_time) ??
    maxDate(mCloses.concat(mLatest));

  return {
    id,
    venue_id: venueId,
    event_id: e.event_ticker,
    title: e.title,
    category: e.category ?? null,
    slug: e.event_ticker,
    active: anyOpen || statuses.length === 0, // Kalshi "open universe" fetch; keep true as default
    closed: allShut || false,
    start_time: start,
    end_time: end,
    liquidity: liqSum || null,
    volume_total: volSum || null,
    volume24hr: vol24Sum || null,
    raw: e,
  };
}

const pos = (x: number | null) => (x != null ? Math.max(0, x) : null);

export function mapMarketRow(
  venueId: number,
  eventUuid: string,
  m: z.infer<typeof KalshiMarket>,
) {
  const id = uuid();
  return {
    id,
    event_id: eventUuid,
    venue_id: venueId,
    market_id: m.ticker,
    title: m.yes_sub_title ?? m.no_sub_title ?? m.title,
    enable_orderbook: true,
    accepting_orders: ["open", "active", "trading"].includes(
      (m.status ?? "open").toLowerCase(),
    ),
    condition_id: null,
    order_price_min_tick_size: 0.01, // dollars
    order_min_size: 1,
    neg_risk: null,
    neg_risk_market_id: null,
    liquidity: pos(n(m.liquidity)),
    volume_total: n(m.volume),
    volume24hr: n(m.volume_24h),
    clob_token_yes: `kalshi:${m.ticker}:YES`,
    clob_token_no: `kalshi:${m.ticker}:NO`,
    raw: m,
  };
}

export function mapTokens(marketUuid: string, marketTicker: string) {
  return [
    {
      token_id: `kalshi:${marketTicker}:YES`,
      market_id: marketUuid,
      side: "YES" as const,
    },
    {
      token_id: `kalshi:${marketTicker}:NO`,
      market_id: marketUuid,
      side: "NO" as const,
    },
  ];
}

// Unified table mappers for Kalshi
export function mapToUnifiedEvent(
  e: z.infer<typeof KalshiEvent>,
): UnifiedEventRow {
  const markets = (e.markets ?? []) as z.infer<typeof KalshiMarket>[];

  // Aggregate from child markets
  const mOpens = markets.map((m) => parseDate(m.open_time));
  const mCloses = markets.map((m) =>
    parseDate(m.close_time ?? m.expiration_time),
  );
  const mLatest = markets.map((m) => {
    const latest = (m as Record<string, unknown>).latest_expiration_time;
    return parseDate(typeof latest === "string" ? latest : null);
  });

  const liqSum = markets.reduce((s, m) => s + (n(m.liquidity) ?? 0), 0);
  const vol24Sum = markets.reduce((s, m) => s + (n(m.volume_24h) ?? 0), 0);
  const volSum = markets.reduce((s, m) => s + (n(m.volume) ?? 0), 0);

  const statuses = markets.map((m) => (m.status ?? "open").toLowerCase());
  const allShut =
    statuses.length > 0 &&
    statuses.every((s) =>
      ["closed", "settled", "finalized", "expired"].includes(s),
    );

  // Determine unified status
  let status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" = "ACTIVE";
  if (allShut) {
    if (statuses.some((s) => s === "settled" || s === "finalized"))
      status = "SETTLED";
    else status = "CLOSED";
  }

  // Calculate start_date: prefer event-level open_time, else min of market opens
  const start_date = parseDate(e.open_time) ?? minDate(mOpens) ?? undefined;

  // Calculate end_date: prefer event-level close_time → expiration_time → latest_expiration_time,
  // else max of market closes and latest expiration times
  const end_date =
    parseDate(e.close_time) ??
    parseDate(e.expiration_time) ??
    parseDate(e.latest_expiration_time) ??
    maxDate(mCloses.concat(mLatest)) ??
    undefined;

  return {
    id: `kalshi:${e.event_ticker}`,
    venue: "kalshi",
    venue_event_id: e.event_ticker,
    title: e.title,
    description: typeof e.sub_title === "string" ? e.sub_title : undefined,
    category: e.category ?? undefined,
    status,
    start_date,
    end_date,
    volume_total: volSum || undefined,
    volume_24h: vol24Sum || undefined,
    open_interest:
      markets.reduce(
        (s, m) => s + (n((m as Record<string, unknown>).open_interest) ?? 0),
        0,
      ) || undefined,
    liquidity: liqSum || undefined,
    slug: undefined, // Kalshi doesn't provide slug data
    created_at: undefined, // Kalshi doesn't provide event creation time
    updated_at: undefined, // Kalshi doesn't provide event update time
  };
}

export function mapToUnifiedMarket(
  m: z.infer<typeof KalshiMarket>,
  eventId: string,
): UnifiedMarketRow {
  const extra = m as Record<string, unknown>;

  // Map Kalshi status to unified status
  let status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" = "ACTIVE";
  const marketStatus = (m.status ?? "open").toLowerCase();
  if (marketStatus === "settled" || marketStatus === "finalized")
    status = "SETTLED";
  else if (["closed", "expired"].includes(marketStatus)) status = "CLOSED";

  // Convert Kalshi prices from dollars to decimal
  const bestBid = n(extra.yes_bid_dollars) ?? undefined;
  const bestAsk = n(extra.yes_ask_dollars) ?? undefined;
  const lastPrice = n(extra.last_price_dollars) ?? undefined;

  return {
    id: `kalshi:${m.ticker}`,
    venue: "kalshi",
    venue_market_id: m.ticker,
    event_id: `kalshi:${eventId}`,
    title:
      typeof extra.yes_sub_title === "string"
        ? extra.yes_sub_title
        : typeof extra.no_sub_title === "string"
          ? extra.no_sub_title
          : (m.title ?? m.ticker),
    description:
      typeof extra.subtitle === "string" ? extra.subtitle : undefined,
    category: typeof extra.category === "string" ? extra.category : undefined,
    status,
    market_type:
      typeof extra.market_type === "string" ? extra.market_type : "binary",
    open_time: parseDate(m.open_time) || undefined,
    close_time: parseDate(m.close_time) || undefined,
    expiration_time: parseDate(m.expiration_time) || undefined,
    best_bid: bestBid,
    best_ask: bestAsk,
    last_price: lastPrice,
    volume_total: n(m.volume) ?? undefined,
    volume_24h: n(m.volume_24h) ?? undefined,
    open_interest: n(extra.open_interest) ?? undefined,
    liquidity: n(m.liquidity) ?? undefined,
    outcomes: JSON.stringify(["YES", "NO"]), // Kalshi markets are binary
    token_yes: `kalshi:${m.ticker}:YES`,
    token_no: `kalshi:${m.ticker}:NO`,
    condition_id: undefined, // Kalshi doesn't have condition_id
    slug: undefined, // Kalshi doesn't provide slug data
    created_at: undefined, // Kalshi doesn't provide market creation time
    updated_at: undefined, // Kalshi doesn't provide market update time
  };
}
