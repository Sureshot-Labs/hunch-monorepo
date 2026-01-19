type ClusterMarketRow = {
  id: string;
  event_id: string;
  venue: string;
  title: string | null;
  description?: string | null;
  market_type: string | null;
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
  volume_24h: unknown;
  volume_total: unknown;
  liquidity: unknown;
  open_interest: unknown;
  close_time: unknown;
  expiration_time: unknown;
  event_title: string | null;
  event_description?: string | null;
};

export type ClusterMarketSummary = {
  marketId: string;
  eventId: string;
  venue: string;
  marketTitle: string | null;
  marketDescription: string | null;
  eventTitle: string | null;
  eventDescription: string | null;
  marketType: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  yesMid: number | null;
  noMid: number | null;
  liquidity: number | null;
  volume24h: number | null;
  volumeTotal: number | null;
  openInterest: number | null;
  expiresAt: string | null;
};

type ClusterMetrics = {
  venueCounts: Record<string, number>;
  venueCount: number;
  priceSpread: number | null;
  minLiquidity: number | null;
  totalLiquidity: number | null;
  volume24h: number | null;
  expiresAt: string | null;
};

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolveYesMid(row: Pick<ClusterMarketRow, "best_bid" | "best_ask" | "last_price">): number | null {
  const bid = toNumber(row.best_bid);
  const ask = toNumber(row.best_ask);
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return toNumber(row.last_price);
}

export function resolveExpiresAt(
  row: Pick<ClusterMarketRow, "expiration_time" | "close_time">,
): string | null {
  const expiration = parseDate(row.expiration_time);
  const close = parseDate(row.close_time);
  if (expiration && close) {
    return (expiration < close ? expiration : close).toISOString();
  }
  if (expiration) return expiration.toISOString();
  if (close) return close.toISOString();
  return null;
}

export function scoreMarket(row: Pick<
  ClusterMarketRow,
  "volume_24h" | "volume_total" | "liquidity" | "open_interest"
>): number {
  const volume24h = toNumber(row.volume_24h) ?? 0;
  const volumeTotal = toNumber(row.volume_total) ?? 0;
  const liquidity = toNumber(row.liquidity) ?? 0;
  const openInterest = toNumber(row.open_interest) ?? 0;
  return volume24h * 2 + liquidity + openInterest + volumeTotal * 0.2;
}

export function buildMarketSummary(row: ClusterMarketRow): ClusterMarketSummary {
  const yesBid = toNumber(row.best_bid);
  const yesAsk = toNumber(row.best_ask);
  const yesMid = resolveYesMid(row);
  const noMid = yesMid != null ? 1 - yesMid : null;

  return {
    marketId: row.id,
    eventId: row.event_id,
    venue: row.venue,
    marketTitle: row.title,
    marketDescription: row.description ?? null,
    eventTitle: row.event_title,
    eventDescription: row.event_description ?? null,
    marketType: row.market_type,
    yesBid,
    yesAsk,
    yesMid,
    noMid,
    liquidity: toNumber(row.liquidity),
    volume24h: toNumber(row.volume_24h),
    volumeTotal: toNumber(row.volume_total),
    openInterest: toNumber(row.open_interest),
    expiresAt: resolveExpiresAt(row),
  };
}

export function computeClusterMetrics(
  markets: ClusterMarketSummary[],
): ClusterMetrics {
  const venueCounts: Record<string, number> = {};
  let minLiquidity: number | null = null;
  let totalLiquidity = 0;
  let volume24h = 0;
  let expiresAt: string | null = null;
  const yesPrices: number[] = [];

  for (const market of markets) {
    const venue = market.venue;
    venueCounts[venue] = (venueCounts[venue] ?? 0) + 1;

    if (market.liquidity != null) {
      totalLiquidity += market.liquidity;
      if (minLiquidity == null || market.liquidity < minLiquidity) {
        minLiquidity = market.liquidity;
      }
    }

    if (market.volume24h != null) {
      volume24h += market.volume24h;
    }

    if (market.yesMid != null) yesPrices.push(market.yesMid);

    if (market.expiresAt) {
      if (!expiresAt || market.expiresAt < expiresAt) {
        expiresAt = market.expiresAt;
      }
    }
  }

  const venueCount = Object.keys(venueCounts).length;
  const priceSpread =
    yesPrices.length >= 2
      ? Math.max(...yesPrices) - Math.min(...yesPrices)
      : null;

  return {
    venueCounts,
    venueCount,
    priceSpread,
    minLiquidity,
    totalLiquidity: Number.isFinite(totalLiquidity) ? totalLiquidity : null,
    volume24h: Number.isFinite(volume24h) ? volume24h : null,
    expiresAt,
  };
}
