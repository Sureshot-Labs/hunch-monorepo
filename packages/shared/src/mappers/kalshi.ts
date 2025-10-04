// Kalshi-specific mapper implementation
import { BaseMapper } from './base';
import { UnifiedMarket, UnifiedEvent, UnifiedPriceData } from '../types/unified';
import { v4 as uuid } from 'uuid';

// Kalshi-specific types (based on existing codebase)
export interface KalshiEvent {
  event_ticker: string;
  title: string;
  category?: string | null;
  open_time?: string | null;
  close_time?: string | null;
  expiration_time?: string | null;
  latest_expiration_time?: string | null;
  series_ticker?: string | null;
  markets?: KalshiMarket[];
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string | null;
  status?: string;
  open_time?: string | null;
  close_time?: string | null;
  expiration_time?: string | null;
  yes_price?: number | string | null;
  no_price?: number | string | null;
  liquidity?: number | string | null;
  volume_24h?: number | string | null;
  volume?: number | string | null;
}

export interface KalshiPriceData {
  ticker: string;
  timestamp: string | number;
  yes_price?: number | string | null;
  no_price?: number | string | null;
  orderbook?: {
    yes?: [number, number][];
    no?: [number, number][];
    yes_dollars?: [string, number][];
    no_dollars?: [string, number][];
  };
  volume?: number | string | null;
}

export class KalshiMapper extends BaseMapper<KalshiEvent, KalshiMarket, KalshiPriceData> {
  constructor() {
    super('kalshi');
  }

  mapEvent(venueEvent: KalshiEvent): UnifiedEvent {
    const eventId = uuid();
    const now = new Date();

    // Aggregate financial data from markets
    const markets = venueEvent.markets || [];
    const totalLiquidity = markets.reduce((sum, market) => {
      return sum + this.normalizeLiquidity(market.liquidity);
    }, 0);

    const totalVolume24h = markets.reduce((sum, market) => {
      return sum + this.normalizeVolume(market.volume_24h);
    }, 0);

    const totalVolume = markets.reduce((sum, market) => {
      return sum + this.normalizeVolume(market.volume);
    }, 0);

    // Determine event status from markets
    const marketStatuses = markets.map(m => this.determineMarketStatus(m));
    const anyActive = marketStatuses.some(s => s === 'active');
    const allClosed = marketStatuses.length > 0 && marketStatuses.every(s => s === 'closed' || s === 'settled');

    const unifiedEvent: UnifiedEvent = {
      id: eventId,
      venue: this.venue,
      venueEventId: venueEvent.event_ticker,
      title: venueEvent.title,
      description: undefined,
      category: venueEvent.category || undefined,
      tags: this.extractTags(venueEvent),
      status: allClosed ? 'closed' : (anyActive ? 'active' : 'closed'),
      startTime: this.parseDate(venueEvent.open_time),
      endTime: this.parseDate(venueEvent.close_time || venueEvent.expiration_time || venueEvent.latest_expiration_time),
      totalLiquidity,
      totalVolume24h,
      totalVolume,
      markets: [], // Will be populated separately
      rawData: venueEvent,
      lastUpdated: now,
      createdAt: now,
    };

    this.validateEventData(unifiedEvent);
    return unifiedEvent;
  }

  mapMarket(venueMarket: KalshiMarket, eventId: string): UnifiedMarket {
    const marketId = uuid();
    const now = new Date();

    // Generate synthetic token IDs for Kalshi
    const yesTokenId = this.generateUnifiedTokenId(venueMarket.ticker, 'YES');
    const noTokenId = this.generateUnifiedTokenId(venueMarket.ticker, 'NO');

    // Kalshi prices are in dollar format (0-100), convert to 0-1
    const yesPrice = this.normalizeKalshiPrice(venueMarket.yes_price);
    const noPrice = this.normalizeKalshiPrice(venueMarket.no_price);

    // Calculate order book data (would come from separate API call)
    const bestBid = 0; // Placeholder - would come from order book
    const bestAsk = 0; // Placeholder - would come from order book
    const spread = this.calculateSpread(bestBid, bestAsk);
    const midPrice = this.calculateMidPrice(bestBid, bestAsk);

    const unifiedMarket: UnifiedMarket = {
      id: marketId,
      venue: this.venue,
      venueMarketId: venueMarket.ticker,
      venueEventId: eventId,
      title: venueMarket.title || venueMarket.ticker,
      description: undefined,
      category: undefined,
      tags: this.extractTags(venueMarket),
      status: this.determineMarketStatus(venueMarket),
      acceptingOrders: this.isAcceptingOrders(venueMarket.status),
      startTime: this.parseDate(venueMarket.open_time),
      endTime: this.parseDate(venueMarket.close_time || venueMarket.expiration_time),
      yesPrice,
      noPrice,
      liquidity: this.normalizeLiquidity(venueMarket.liquidity),
      volume24h: this.normalizeVolume(venueMarket.volume_24h),
      volumeTotal: this.normalizeVolume(venueMarket.volume),
      bestBid,
      bestAsk,
      spread,
      midPrice,
      yesTokenId: yesTokenId as any,
      noTokenId: noTokenId as any,
      minOrderSize: 1, // Kalshi minimum is $1
      tickSize: 0.01, // Kalshi tick size is $0.01
      maxOrderSize: undefined,
      rawData: venueMarket,
      lastUpdated: now,
      createdAt: now,
    };

    this.validateMarketData(unifiedMarket);
    return unifiedMarket;
  }

  mapPriceData(venuePriceData: KalshiPriceData): UnifiedPriceData {
    const now = new Date();
    const timestamp = this.parseDate(venuePriceData.timestamp) || now;

    // Extract bid/ask from order book
    const orderbook = venuePriceData.orderbook || {};
    const yesLevels = orderbook.yes_dollars || [];
    const noLevels = orderbook.no_dollars || [];
    
    const bestBid = yesLevels.length > 0 ? this.normalizeKalshiPrice(yesLevels[0][0]) : undefined;
    const bestAsk = noLevels.length > 0 ? this.normalizeKalshiPrice(noLevels[0][0]) : undefined;
    
    const spread = this.calculateSpread(bestBid, bestAsk);
    const midPrice = this.calculateMidPrice(bestBid, bestAsk);

    // Use current prices or mid price as close price
    const yesPrice = this.normalizeKalshiPrice(venuePriceData.yes_price);
    const noPrice = this.normalizeKalshiPrice(venuePriceData.no_price);
    const closePrice = yesPrice || midPrice;

    const unifiedPriceData: UnifiedPriceData = {
      tokenId: this.generateUnifiedTokenId(venuePriceData.ticker, 'YES') as any,
      timestamp,
      open: closePrice, // Placeholder - would need historical data
      high: closePrice, // Placeholder - would need historical data
      low: closePrice, // Placeholder - would need historical data
      close: closePrice,
      volumeUsd: this.normalizeVolume(venuePriceData.volume),
      tradeCount: 1, // Placeholder
      bestBid,
      bestAsk,
      spread,
      resolution: '1m', // Default resolution
    };

    this.validatePriceData(unifiedPriceData);
    return unifiedPriceData;
  }

  // Kalshi-specific helper methods
  private normalizeKalshiPrice(price: number | string | null | undefined): number {
    if (price === null || price === undefined) return 0;
    
    const numPrice = typeof price === 'string' ? parseFloat(price) : price;
    
    if (!Number.isFinite(numPrice)) return 0;
    
    // Kalshi prices are in dollar format (0-100), convert to 0-1
    return Math.max(0, Math.min(1, numPrice / 100));
  }

  private isAcceptingOrders(status?: string): boolean {
    if (!status) return true;
    
    const normalizedStatus = status.toLowerCase();
    return ['open', 'active', 'trading'].includes(normalizedStatus);
  }

  // Override status determination for Kalshi-specific logic
  protected determineMarketStatus(data: KalshiEvent | KalshiMarket): 'active' | 'paused' | 'closed' | 'settled' {
    if ('status' in data && data.status) {
      const status = data.status.toLowerCase();
      
      switch (status) {
        case 'open':
        case 'active':
        case 'trading':
          return 'active';
        case 'paused':
        case 'suspended':
          return 'paused';
        case 'closed':
        case 'expired':
          return 'closed';
        case 'settled':
        case 'resolved':
          return 'settled';
        default:
          return 'active';
      }
    }
    
    return 'active';
  }

  // Override tag extraction for Kalshi-specific fields
  protected extractTags(data: KalshiEvent | KalshiMarket): string[] {
    const tags: string[] = [];
    
    if ('category' in data && data.category) {
      tags.push(data.category);
    }
    
    if ('series_ticker' in data && data.series_ticker) {
      tags.push(data.series_ticker);
    }
    
    return [...new Set(tags)];
  }

  // Kalshi-specific validation
  protected validateMarketData(market: UnifiedMarket): void {
    super.validateMarketData(market);
    
    // Kalshi-specific validations
    if (!market.yesTokenId || !market.noTokenId) {
      throw new Error('Both YES and NO token IDs are required for Kalshi markets');
    }
  }
}
