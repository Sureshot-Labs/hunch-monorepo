import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";

import type { TDflowEvent, TDflowMarket, TDflowMarketAccount } from "./types";

function n(v: unknown): number | undefined {
  if (v == null) return undefined;
  const parsed = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  return undefined;
}

function minDate(values: Array<Date | undefined>): Date | undefined {
  const filtered = values.filter(Boolean) as Date[];
  filtered.sort((a, b) => a.getTime() - b.getTime());
  return filtered[0];
}

function maxDate(values: Array<Date | undefined>): Date | undefined {
  const filtered = values.filter(Boolean) as Date[];
  filtered.sort((a, b) => b.getTime() - a.getTime());
  return filtered[0];
}

function normalizeStatus(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

export function mapDflowStatusToUnified(
  value: unknown,
): "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" {
  const s = normalizeStatus(value);
  if (!s) return "ACTIVE";

  if (["archived"].includes(s)) return "ARCHIVED";
  if (["finalized", "finalised", "determined", "settled"].includes(s))
    return "SETTLED";
  if (["closed", "expired", "halted", "suspended"].includes(s)) return "CLOSED";

  return "ACTIVE";
}

function pickEventTicker(e: TDflowEvent): string | null {
  const candidates = [e.event_ticker, e.eventTicker, e.ticker, e.id].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  return candidates[0] ? candidates[0].trim() : null;
}

export function mapToUnifiedEvent(e: TDflowEvent): UnifiedEventRow | null {
  const venueEventId = pickEventTicker(e);
  if (!venueEventId) return null;

  const markets = (e.markets ?? []) as TDflowMarket[];
  const openTimes = markets.map((m) =>
    parseDate(m.openTime ?? (m as Record<string, unknown>).open_time),
  );
  const closeTimes = markets.map((m) =>
    parseDate(m.closeTime ?? (m as Record<string, unknown>).close_time),
  );
  const expTimes = markets.map((m) =>
    parseDate(
      m.expirationTime ?? (m as Record<string, unknown>).expiration_time,
    ),
  );

  const start_date =
    parseDate((e as Record<string, unknown>).openTime) ??
    parseDate((e as Record<string, unknown>).open_time) ??
    parseDate(e.startDate) ??
    minDate(openTimes);
  const end_date =
    parseDate((e as Record<string, unknown>).closeTime) ??
    parseDate((e as Record<string, unknown>).close_time) ??
    parseDate(e.endDate) ??
    maxDate(expTimes.concat(closeTimes));

  const volume_total =
    markets.reduce((sum, m) => sum + (n(m.volume) ?? 0), 0) || undefined;
  const volume_24h =
    markets.reduce((sum, m) => sum + (n(m.volume24h) ?? 0), 0) || undefined;
  const liquidity =
    markets.reduce((sum, m) => sum + (n(m.liquidity) ?? 0), 0) || undefined;
  const open_interest =
    markets.reduce((sum, m) => sum + (n(m.openInterest) ?? 0), 0) || undefined;

  const status = "ACTIVE";

  return {
    id: `kalshi:${venueEventId}`,
    venue: "kalshi",
    venue_event_id: venueEventId,
    title:
      (typeof e.title === "string" && e.title.trim().length
        ? e.title.trim()
        : venueEventId) || venueEventId,
    description:
      typeof (e as Record<string, unknown>).description === "string"
        ? ((e as Record<string, unknown>).description as string)
        : undefined,
    category:
      typeof e.category === "string" && e.category.trim().length
        ? e.category.trim()
        : undefined,
    status,
    start_date,
    end_date,
    volume_total,
    volume_24h,
    open_interest,
    liquidity,
    slug: undefined,
    image: undefined,
    icon: undefined,
    created_at: undefined,
    updated_at: undefined,
  };
}

type Instrument = {
  settlementMint: string;
  yesMint: string;
  noMint: string;
};

function pickUsdcInstrument(
  market: TDflowMarket,
  usdcMint: string,
): Instrument | null {
  const accounts = market.accounts ?? {};
  const entry = (accounts as Record<string, TDflowMarketAccount | null>)[
    usdcMint
  ];
  if (!entry) return null;

  if (entry.isInitialized !== true) return null;
  const yes = entry.yesMint?.trim();
  const no = entry.noMint?.trim();
  if (!yes || !no) return null;

  return { settlementMint: usdcMint, yesMint: yes, noMint: no };
}

export type DflowMarketSnapshot = {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  volume24h: number;
  liquidity: number;
};

export type DflowMappedMarket = {
  marketRow: UnifiedMarketRow;
  tokenRows: Array<{
    token_id: string;
    market_id: string;
    side: "YES" | "NO";
  }>;
  snapshot: DflowMarketSnapshot;
};

export function mapToUnifiedMarket(
  market: TDflowMarket,
  eventId: string,
  eventTitle: string,
  usdcMint: string,
): DflowMappedMarket | null {
  const instrument = pickUsdcInstrument(market, usdcMint);
  if (!instrument) return null;

  const status = mapDflowStatusToUnified(market.status);
  if (status !== "ACTIVE") return null;

  const yesTokenId = `sol:${instrument.yesMint}`;
  const noTokenId = `sol:${instrument.noMint}`;

  const yesBid = n(market.yesBid);
  const yesAsk = n(market.yesAsk);
  const noBid = n(market.noBid);
  const noAsk = n(market.noAsk);

  const volume24h = n(market.volume24h) ?? 0;
  const liquidity = n(market.liquidity) ?? 0;

  const open_time =
    parseDate(
      market.openTime ?? (market as Record<string, unknown>).open_time,
    ) ??
    parseDate((market as Record<string, unknown>).startDate) ??
    undefined;
  const close_time =
    parseDate(
      market.closeTime ?? (market as Record<string, unknown>).close_time,
    ) ??
    parseDate((market as Record<string, unknown>).endDate) ??
    undefined;
  const expiration_time =
    parseDate(
      market.expirationTime ??
        (market as Record<string, unknown>).expiration_time,
    ) ?? close_time;

  const title =
    (typeof market.title === "string" && market.title.trim().length
      ? market.title.trim()
      : eventTitle.trim().length
        ? eventTitle
        : market.ticker) || market.ticker;

  const marketRow: UnifiedMarketRow = {
    id: `kalshi:${market.ticker}`,
    venue: "kalshi",
    venue_market_id: market.ticker,
    event_id: eventId,
    title,
    description:
      typeof (market as Record<string, unknown>).description === "string"
        ? ((market as Record<string, unknown>).description as string)
        : undefined,
    category:
      typeof (market as Record<string, unknown>).category === "string"
        ? ((market as Record<string, unknown>).category as string)
        : undefined,
    status,
    market_type: "binary",
    open_time,
    close_time,
    expiration_time,
    best_bid: yesBid,
    best_ask: yesAsk,
    last_price:
      yesBid != null && yesAsk != null ? (yesBid + yesAsk) / 2 : undefined,
    volume_total: n(market.volume),
    volume_24h: volume24h || undefined,
    open_interest: n(market.openInterest),
    liquidity: liquidity || undefined,
    outcomes: JSON.stringify(["YES", "NO"]),
    token_yes: yesTokenId,
    token_no: noTokenId,
    condition_id: undefined,
    slug: undefined,
    image: undefined,
    icon: undefined,
    created_at: undefined,
    updated_at: undefined,
  };

  const tokenRows = [
    { token_id: yesTokenId, market_id: marketRow.id, side: "YES" as const },
    { token_id: noTokenId, market_id: marketRow.id, side: "NO" as const },
  ];

  const snapshot: DflowMarketSnapshot = {
    marketId: marketRow.id,
    yesTokenId,
    noTokenId,
    yesBid: yesBid ?? null,
    yesAsk: yesAsk ?? null,
    noBid: noBid ?? null,
    noAsk: noAsk ?? null,
    volume24h,
    liquidity,
  };

  return { marketRow, tokenRows, snapshot };
}
