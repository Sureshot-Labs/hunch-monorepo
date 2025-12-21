export type PgParam = string | number | boolean | null | Date | string[];
export type PgParams = PgParam[];

export type OrderHistoryRow = {
  id: string;
  user_id: string;
  venue: string;
  venue_order_id: string | null;
  token_id: string;
  side: string;
  order_type: string;
  price: string;
  size: string;
  status: string;
  filled_size: string | null;
  average_fill_price: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  filled_at: Date | null;
  cancelled_at: Date | null;
  error_message: string | null;
  raw_error: unknown;
};

export type OrderRow = {
  id: string;
  venue_order_id: string | null;
  venue: string;
  token_id: string;
  side: string;
  order_type: string;
  price: string | null;
  size: string | null;
  status: string;
  filled_size: string | null;
  average_fill_price: string | null;
  posted_at: Date | null;
  last_update: Date | null;
  filled_at: Date | null;
  cancelled_at: Date | null;
};

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
  outcomes?: unknown;
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
  eventVolume24h: number;
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
  eventVolume24h: number;
  eventOpenInterest: number;
  eventSlug: string | null;
  image: string | null;
  icon: string | null;
  markets: WatchlistMarket[];
};
