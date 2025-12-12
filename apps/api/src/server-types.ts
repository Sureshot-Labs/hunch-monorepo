export type PgParam = string | number | boolean | null | Date | string[];
export type PgParams = PgParam[];

export type PolymarketRequestData = {
  endpoint?: string;
  params?: URLSearchParams;
  isPost?: boolean;
  body?: unknown;
};

export type PriceHistoryPoint = Record<string, unknown> & { t: number };
export type PriceHistoryData = Record<string, unknown> & {
  history?: unknown;
  metadata?:
    | (Record<string, unknown> & { originalDataPoints?: number })
    | undefined;
};

export type TokenPair = { yes: string | null; no: string | null };

export type FeedMarket = {
  venue: string;
  marketId: string;
  marketTitle: string;
  marketSlug: string | null;
  volume24h: number;
  volumeTotal: number;
  openInterest: number;
  liquidity: number;
  acceptingOrders: boolean;
  tokens: TokenPair;
  conditionId: string | null;
  category: string | null;
  image: string | null;
  icon: string | null;
  top: {
    yesBid: number | null;
    yesAsk: number | null;
    noBid: number | null;
    noAsk: number | null;
  };
  lastUpdate: unknown;
};

export type FeedEvent = {
  eventId: string;
  eventTitle: string | null;
  category: string | null;
  startTime: unknown;
  endTime: unknown;
  eventLiquidity: number;
  eventVolume: number;
  eventOpenInterest: number;
  eventSlug: string | null;
  image: string | null;
  icon: string | null;
  markets: FeedMarket[];
};

export type WatchlistMarket = {
  marketId: string; // unified_markets.id
  venue: string;
  venueMarketId: string;
  marketTitle: string;
  marketSlug: string | null;
  volume24h: number;
  volumeTotal: number;
  openInterest: number;
  liquidity: number;
  acceptingOrders: boolean;
  tokens: TokenPair;
  conditionId: string | null;
  category: string | null;
  image: string | null;
  icon: string | null;
  status: string;
  top: {
    yesBid: number | null;
    yesAsk: number | null;
    noBid: number | null;
    noAsk: number | null;
  };
  lastUpdate: unknown;
  watchlistId: string;
  watchlistCreatedAt: unknown;
};

export type WatchlistEvent = {
  eventId: string;
  eventTitle: string | null;
  category: string | null;
  startTime: unknown;
  endTime: unknown;
  eventLiquidity: number;
  eventVolume: number;
  eventOpenInterest: number;
  eventSlug: string | null;
  image: string | null;
  icon: string | null;
  markets: WatchlistMarket[];
};
