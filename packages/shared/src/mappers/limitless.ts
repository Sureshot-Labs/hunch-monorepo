// Limitless-specific mapper implementation
import { BaseMapper } from './base';
import { UnifiedMarket, UnifiedEvent, UnifiedPriceData } from '../types/unified';
import { v4 as uuid } from 'uuid';

// Limitless-specific types (based on existing codebase)
export interface LimitlessMarket {
  id: number;
  address?: string | null;
  conditionId?: string | null;
  title: string;
  description?: string | null;
  collateralToken?: {
    address?: string | null;
    decimals?: number;
    symbol?: string | null;
  };
  creator?: {
    name?: string | null;
    imageURI?: string | null;
    link?: string | null;
  };
  prices?: (number | string)[]; // [yes%, no%]
  categories?: string[];
  tags?: string[];
  status?: string;
  expired?: boolean;
  expirationDate?: string | null;
  expirationTimestamp?: number | string | null;
  volume?: number | string | null;
  volumeFormatted?: string | null;
}

export interface LimitlessPriceData {
  id: number;
  timestamp: string | number;
  prices?: (number | string)[]; // [yes%, no%]
  volume?: number | string | null;
  volumeFormatted?: string | null;
}

export class LimitlessMapper extends BaseMapper<LimitlessMarket, LimitlessMarket, LimitlessPriceData> {
  constructor() {
    super('limitless');
  }

  mapEvent(venueMarket: LimitlessMarket): UnifiedEvent {
    const eventId = uuid();
    const now = new Date();

    // For Limitless, each market is essentially its own event
    const unifiedEvent: UnifiedEvent = {
      id: eventId,
      venue: this.venue,
      venueEventId: String(venueMarket.id),
      title: venueMarket.title,
      description: venueMarket.description || undefined,
      category: venueMarket.categories?.[0] || undefined,
      tags: this.extractTags(venueMarket),
      status: this.determineMarketStatus(venueMarket),
      startTime: undefined, // Limitless doesn't provide start time
      endTime: this.parseDate(venueMarket.expirationTimestamp),
      totalLiquidity: 0, // Limitless doesn't expose liquidity
      totalVolume24h: 0, // Limitless doesn't expose 24h volume
      totalVolume: this.normalizeVolume(venueMarket.volumeFormatted || venueMarket.volume),
      markets: [], // Will be populated separately
      rawData: venueMarket,
      lastUpdated: now,
      createdAt: now,
    };

    this.validateEventData(unifiedEvent);
    return unifiedEvent;
  }

  mapMarket(venueMarket: LimitlessMarket, eventId: string): UnifiedMarket {
    const marketId = uuid();
    const now = new Date();

    // Generate token IDs based on address or condition ID
    const tokenBase = venueMarket.address || venueMarket.conditionId || String(venueMarket.id);
    const yesTokenId = this.generateUnifiedTokenId(tokenBase.toLowerCase(), 'YES');
    const noTokenId = this.generateUnifiedTokenId(tokenBase.toLowerCase(), 'NO');

    // Extract prices from the prices array [yes%, no%]
    const prices = venueMarket.prices || [];
    const yesPrice = prices[0] ? this.normalizePrice(prices[0]) : 0;
    const noPrice = prices[1] ? this.normalizePrice(prices[1]) : 0;

    // Calculate order book data (Limitless doesn't have traditional order books)
    const bestBid = 0; // Limitless uses AMM, no traditional bids
    const bestAsk = yesPrice; // Use current price as ask
    const spread = 0; // No spread in AMM
    const midPrice = yesPrice;

    const unifiedMarket: UnifiedMarket = {
      id: marketId,
      venue: this.venue,
      venueMarketId: String(venueMarket.id),
      venueEventId: eventId,
      title: venueMarket.title,
      description: venueMarket.description || undefined,
      category: venueMarket.categories?.[0] || undefined,
      tags: this.extractTags(venueMarket),
      status: this.determineMarketStatus(venueMarket),
      acceptingOrders: this.isAcceptingOrders(venueMarket.status),
      startTime: undefined, // Limitless doesn't provide start time
      endTime: this.parseDate(venueMarket.expirationTimestamp),
      yesPrice,
      noPrice,
      liquidity: 0, // Limitless doesn't expose liquidity
      volume24h: 0, // Limitless doesn't expose 24h volume
      volumeTotal: this.normalizeVolume(venueMarket.volumeFormatted || venueMarket.volume),
      bestBid,
      bestAsk,
      spread,
      midPrice,
      yesTokenId: yesTokenId as any,
      noTokenId: noTokenId as any,
      minOrderSize: 0, // Limitless doesn't specify minimum order size
      tickSize: 0.01, // Default tick size for Limitless
      maxOrderSize: undefined,
      rawData: {
        ...venueMarket,
        normalizedPrices: { yes: yesPrice, no: noPrice },
      },
      lastUpdated: now,
      createdAt: now,
    };

    this.validateMarketData(unifiedMarket);
    return unifiedMarket;
  }

  mapPriceData(venuePriceData: LimitlessPriceData): UnifiedPriceData {
    const now = new Date();
    const timestamp = this.parseDate(venuePriceData.timestamp) || now;

    // Extract prices from the prices array [yes%, no%]
    const prices = venuePriceData.prices || [];
    const yesPrice = prices[0] ? this.normalizePrice(prices[0]) : 0;
    const noPrice = prices[1] ? this.normalizePrice(prices[1]) : 0;

    // Use YES price as the primary price
    const closePrice = yesPrice;

    const unifiedPriceData: UnifiedPriceData = {
      tokenId: this.generateUnifiedTokenId(String(venuePriceData.id), 'YES') as any,
      timestamp,
      open: closePrice, // Placeholder - would need historical data
      high: closePrice, // Placeholder - would need historical data
      low: closePrice, // Placeholder - would need historical data
      close: closePrice,
      volumeUsd: this.normalizeVolume(venuePriceData.volumeFormatted || venuePriceData.volume),
      tradeCount: 1, // Placeholder
      bestBid: undefined, // Limitless doesn't have traditional bids
      bestAsk: yesPrice,
      spread: 0, // No spread in AMM
      resolution: '1m', // Default resolution
    };

    this.validatePriceData(unifiedPriceData);
    return unifiedPriceData;
  }

  // Limitless-specific helper methods
  private isAcceptingOrders(status?: string): boolean {
    if (!status) return true;
    
    const normalizedStatus = status.toUpperCase();
    return ['ACTIVE', 'FUNDED'].includes(normalizedStatus);
  }

  // Override status determination for Limitless-specific logic
  protected determineMarketStatus(data: LimitlessMarket): 'active' | 'paused' | 'closed' | 'settled' {
    if (data.expired) return 'closed';
    
    if (data.status) {
      const status = data.status.toUpperCase();
      
      switch (status) {
        case 'ACTIVE':
        case 'FUNDED':
          return 'active';
        case 'PAUSED':
        case 'SUSPENDED':
          return 'paused';
        case 'CLOSED':
        case 'EXPIRED':
          return 'closed';
        case 'SETTLED':
        case 'RESOLVED':
          return 'settled';
        default:
          return 'active';
      }
    }
    
    return 'active';
  }

  // Override tag extraction for Limitless-specific fields
  protected extractTags(data: LimitlessMarket): string[] {
    const tags: string[] = [];
    
    if (data.categories && Array.isArray(data.categories)) {
      tags.push(...data.categories.filter(cat => typeof cat === 'string'));
    }
    
    if (data.tags && Array.isArray(data.tags)) {
      tags.push(...data.tags.filter(tag => typeof tag === 'string'));
    }
    
    if (data.creator?.name) {
      tags.push(`creator:${data.creator.name}`);
    }
    
    return [...new Set(tags)];
  }

  // Override volume normalization for Limitless-specific format
  protected normalizeVolume(volume: number | string | null | undefined): number {
    if (volume === null || volume === undefined) return 0;
    
    // Handle formatted volume string (e.g., "164.109293")
    if (typeof volume === 'string' && !Number.isNaN(Number(volume))) {
      return Math.max(0, Number(volume));
    }
    
    // Handle raw volume number (might need decimal adjustment)
    const numVolume = typeof volume === 'string' ? parseFloat(volume) : volume;
    
    if (!Number.isFinite(numVolume)) return 0;
    
    // Limitless volumes might be in micro units, adjust if needed
    // This would need to be determined based on the actual API responses
    return Math.max(0, numVolume);
  }

  // Limitless-specific validation
  protected validateMarketData(market: UnifiedMarket): void {
    super.validateMarketData(market);
    
    // Limitless-specific validations
    if (!market.yesTokenId || !market.noTokenId) {
      throw new Error('Both YES and NO token IDs are required for Limitless markets');
    }
  }
}
