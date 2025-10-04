// Polymarket-specific mapper implementation
import { BaseMapper } from './base';
import { UnifiedMarket, UnifiedEvent, UnifiedPriceData } from '../types/unified';
import { v4 as uuid } from 'uuid';

// Polymarket-specific types (based on existing codebase)
export interface PolymarketEvent {
  id: string;
  ticker?: string | null;
  slug?: string | null;
  title: string;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  liquidity?: number | string | null;
  volume?: number | string | null;
  volume24hr?: number | string | null;
  markets: PolymarketMarket[];
}

export interface PolymarketMarket {
  id: string;
  question: string;
  slug?: string | null;
  conditionId?: string | null;
  endDate?: string | null;
  startDate?: string | null;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  orderPriceMinTickSize?: number | string | null;
  orderMinSize?: number | string | null;
  liquidity?: number | string | null;
  volume?: number | string | null;
  volume24hr?: number | string | null;
  liquidityNum?: number | string | null;
  volumeNum?: number | string | null;
  negRisk?: boolean | null;
  negRiskMarketID?: string | null;
  clobTokenIds?: string[] | string;
}

export interface PolymarketPriceData {
  asset_id: string;
  timestamp: string | number;
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
  last_trade_price?: number | string;
  volume?: number | string;
}

export class PolymarketMapper extends BaseMapper<PolymarketEvent, PolymarketMarket, PolymarketPriceData> {
  constructor() {
    super('polymarket');
  }

  mapEvent(venueEvent: PolymarketEvent): UnifiedEvent {
    const eventId = uuid();
    const now = new Date();

    // Aggregate financial data from markets
    const totalLiquidity = venueEvent.markets.reduce((sum, market) => {
      return sum + this.normalizeLiquidity(market.liquidityNum ?? market.liquidity);
    }, 0);

    const totalVolume24h = venueEvent.markets.reduce((sum, market) => {
      return sum + this.normalizeVolume(market.volume24hr);
    }, 0);

    const totalVolume = venueEvent.markets.reduce((sum, market) => {
      return sum + this.normalizeVolume(market.volumeNum ?? market.volume);
    }, 0);

    const unifiedEvent: UnifiedEvent = {
      id: eventId,
      venue: this.venue,
      venueEventId: venueEvent.id,
      title: venueEvent.title,
      description: venueEvent.description || undefined,
      category: undefined, // Polymarket doesn't have event-level categories
      tags: this.extractTags(venueEvent),
      status: this.determineMarketStatus(venueEvent),
      startTime: this.parseDate(venueEvent.startDate),
      endTime: this.parseDate(venueEvent.endDate),
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

  mapMarket(venueMarket: PolymarketMarket, eventId: string): UnifiedMarket {
    const marketId = uuid();
    const now = new Date();

    // Extract token IDs from clobTokenIds
    const tokenIds = this.extractTokenIds(venueMarket.clobTokenIds);
    const yesTokenId = tokenIds.yes ? this.generateUnifiedTokenId(venueMarket.id, 'YES') : '';
    const noTokenId = tokenIds.no ? this.generateUnifiedTokenId(venueMarket.id, 'NO') : '';

    // Calculate current prices (this would typically come from order book data)
    const yesPrice = this.normalizePrice(venueMarket.liquidityNum ?? venueMarket.liquidity);
    const noPrice = 1 - yesPrice; // Assuming binary market

    // Calculate order book data (would come from separate API call)
    const bestBid = 0; // Placeholder - would come from order book
    const bestAsk = 0; // Placeholder - would come from order book
    const spread = this.calculateSpread(bestBid, bestAsk);
    const midPrice = this.calculateMidPrice(bestBid, bestAsk);

    const unifiedMarket: UnifiedMarket = {
      id: marketId,
      venue: this.venue,
      venueMarketId: venueMarket.id,
      venueEventId: eventId,
      title: venueMarket.question,
      description: undefined,
      category: undefined,
      tags: this.extractTags(venueMarket),
      status: this.determineMarketStatus(venueMarket),
      acceptingOrders: venueMarket.acceptingOrders ?? true,
      startTime: this.parseDate(venueMarket.startDate),
      endTime: this.parseDate(venueMarket.endDate),
      yesPrice,
      noPrice,
      liquidity: this.normalizeLiquidity(venueMarket.liquidityNum ?? venueMarket.liquidity),
      volume24h: this.normalizeVolume(venueMarket.volume24hr),
      volumeTotal: this.normalizeVolume(venueMarket.volumeNum ?? venueMarket.volume),
      bestBid,
      bestAsk,
      spread,
      midPrice,
      yesTokenId: yesTokenId as any,
      noTokenId: noTokenId as any,
      minOrderSize: this.normalizeVolume(venueMarket.orderMinSize) || 1,
      tickSize: this.normalizePrice(venueMarket.orderPriceMinTickSize) || 0.01,
      maxOrderSize: undefined,
      rawData: venueMarket,
      lastUpdated: now,
      createdAt: now,
    };

    this.validateMarketData(unifiedMarket);
    return unifiedMarket;
  }

  mapPriceData(venuePriceData: PolymarketPriceData): UnifiedPriceData {
    const now = new Date();
    const timestamp = this.parseDate(venuePriceData.timestamp) || now;

    // Extract bid/ask from order book
    const bids = venuePriceData.bids || [];
    const asks = venuePriceData.asks || [];
    
    const bestBid = bids.length > 0 ? this.normalizePrice(bids[0].price) : undefined;
    const bestAsk = asks.length > 0 ? this.normalizePrice(asks[0].price) : undefined;
    
    const spread = this.calculateSpread(bestBid, bestAsk);
    const midPrice = this.calculateMidPrice(bestBid, bestAsk);

    // Use last trade price or mid price as close price
    const closePrice = this.normalizePrice(venuePriceData.last_trade_price) || midPrice;

    const unifiedPriceData: UnifiedPriceData = {
      tokenId: this.generateUnifiedTokenId(venuePriceData.asset_id, 'YES') as any, // This should be determined by the token
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

  // Polymarket-specific helper methods
  private extractTokenIds(clobTokenIds: string[] | string | undefined): { yes?: string; no?: string } {
    if (!clobTokenIds) return {};

    let tokenArray: string[];
    if (Array.isArray(clobTokenIds)) {
      tokenArray = clobTokenIds;
    } else if (typeof clobTokenIds === 'string') {
      try {
        tokenArray = JSON.parse(clobTokenIds);
      } catch {
        tokenArray = [clobTokenIds];
      }
    } else {
      return {};
    }

    return {
      yes: tokenArray[0],
      no: tokenArray[1],
    };
  }

  // Override status determination for Polymarket-specific logic
  protected determineMarketStatus(data: PolymarketEvent | PolymarketMarket): 'active' | 'paused' | 'closed' | 'settled' {
    if ('closed' in data && data.closed) return 'closed';
    if ('archived' in data && data.archived) return 'settled';
    if ('acceptingOrders' in data && !data.acceptingOrders) return 'paused';
    if ('enableOrderBook' in data && !data.enableOrderBook) return 'paused';
    
    return 'active';
  }

  // Polymarket-specific validation
  protected validateMarketData(market: UnifiedMarket): void {
    super.validateMarketData(market);
    
    // Polymarket-specific validations
    if (!market.yesTokenId && !market.noTokenId) {
      throw new Error('At least one token ID is required for Polymarket markets');
    }
  }
}
