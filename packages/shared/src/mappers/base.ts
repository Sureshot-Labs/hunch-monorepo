// Abstract mapper interface for unified data transformation
import { UnifiedMarket, UnifiedEvent, UnifiedPriceData, Venue } from '../types/unified';

// Base mapper interface that all venue-specific mappers must implement
export abstract class BaseMapper<TEvent, TMarket, TPriceData> {
  protected readonly venue: Venue;

  constructor(venue: Venue) {
    this.venue = venue;
  }

  // Abstract methods that must be implemented by each venue
  abstract mapEvent(venueEvent: TEvent): UnifiedEvent;
  abstract mapMarket(venueMarket: TMarket, eventId: string): UnifiedMarket;
  abstract mapPriceData(venuePriceData: TPriceData): UnifiedPriceData;

  // Common utility methods
  protected normalizePrice(price: number | string | null | undefined): number {
    if (price === null || price === undefined) return 0;
    
    const numPrice = typeof price === 'string' ? parseFloat(price) : price;
    
    if (!Number.isFinite(numPrice)) return 0;
    
    // Handle different price formats
    if (numPrice > 1) {
      // Assume percentage format (e.g., 65.5 for 65.5%)
      return Math.max(0, Math.min(1, numPrice / 100));
    }
    
    // Already in 0-1 format
    return Math.max(0, Math.min(1, numPrice));
  }

  protected normalizeVolume(volume: number | string | null | undefined): number {
    if (volume === null || volume === undefined) return 0;
    
    const numVolume = typeof volume === 'string' ? parseFloat(volume) : volume;
    
    return Number.isFinite(numVolume) ? Math.max(0, numVolume) : 0;
  }

  protected normalizeLiquidity(liquidity: number | string | null | undefined): number {
    return this.normalizeVolume(liquidity);
  }

  protected generateUnifiedTokenId(marketId: string, side: 'YES' | 'NO'): string {
    return `${this.venue}:${marketId}:${side}`;
  }

  protected parseDate(dateString: string | number | null | undefined): Date | undefined {
    if (!dateString) return undefined;
    
    if (typeof dateString === 'number') {
      // Handle timestamp (seconds or milliseconds)
      const timestamp = dateString < 1e12 ? dateString * 1000 : dateString;
      return new Date(timestamp);
    }
    
    if (typeof dateString === 'string') {
      return new Date(dateString);
    }
    
    return undefined;
  }

  protected extractTags(data: any): string[] {
    const tags: string[] = [];
    
    // Extract tags from various possible fields
    if (data.tags && Array.isArray(data.tags)) {
      tags.push(...data.tags.filter((tag: any) => typeof tag === 'string'));
    }
    
    if (data.categories && Array.isArray(data.categories)) {
      tags.push(...data.categories.filter((cat: any) => typeof cat === 'string'));
    }
    
    if (data.category && typeof data.category === 'string') {
      tags.push(data.category);
    }
    
    return [...new Set(tags)]; // Remove duplicates
  }

  protected determineMarketStatus(data: any): 'active' | 'paused' | 'closed' | 'settled' {
    // Common status mapping logic
    const status = data.status?.toLowerCase() || data.active;
    
    if (typeof status === 'boolean') {
      return status ? 'active' : 'closed';
    }
    
    if (typeof status === 'string') {
      switch (status) {
        case 'open':
        case 'active':
        case 'trading':
        case 'funded':
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

  protected calculateSpread(bid: number | null, ask: number | null): number {
    if (bid === null || ask === null) return 0;
    return Math.max(0, ask - bid);
  }

  protected calculateMidPrice(bid: number | null, ask: number | null): number {
    if (bid === null || ask === null) return 0;
    return (bid + ask) / 2;
  }

  // Validation methods
  protected validateMarketData(market: UnifiedMarket): void {
    if (!market.id) throw new Error('Market ID is required');
    if (!market.venue) throw new Error('Venue is required');
    if (!market.venueMarketId) throw new Error('Venue market ID is required');
    if (!market.title) throw new Error('Market title is required');
    if (market.yesPrice < 0 || market.yesPrice > 1) {
      throw new Error('YES price must be between 0 and 1');
    }
    if (market.noPrice < 0 || market.noPrice > 1) {
      throw new Error('NO price must be between 0 and 1');
    }
    if (market.liquidity < 0) {
      throw new Error('Liquidity must be non-negative');
    }
    if (market.volume24h < 0) {
      throw new Error('24h volume must be non-negative');
    }
  }

  protected validateEventData(event: UnifiedEvent): void {
    if (!event.id) throw new Error('Event ID is required');
    if (!event.venue) throw new Error('Venue is required');
    if (!event.venueEventId) throw new Error('Venue event ID is required');
    if (!event.title) throw new Error('Event title is required');
  }

  protected validatePriceData(priceData: UnifiedPriceData): void {
    if (!priceData.tokenId) throw new Error('Token ID is required');
    if (!priceData.timestamp) throw new Error('Timestamp is required');
    if (priceData.open < 0 || priceData.open > 1) {
      throw new Error('Open price must be between 0 and 1');
    }
    if (priceData.high < 0 || priceData.high > 1) {
      throw new Error('High price must be between 0 and 1');
    }
    if (priceData.low < 0 || priceData.low > 1) {
      throw new Error('Low price must be between 0 and 1');
    }
    if (priceData.close < 0 || priceData.close > 1) {
      throw new Error('Close price must be between 0 and 1');
    }
    if (priceData.volumeUsd < 0) {
      throw new Error('Volume must be non-negative');
    }
  }

  // Batch processing methods
  public mapEvents(venueEvents: TEvent[]): UnifiedEvent[] {
    return venueEvents.map(event => {
      try {
        return this.mapEvent(event);
      } catch (error) {
        console.error(`Error mapping event for venue ${this.venue}:`, error);
        throw error;
      }
    });
  }

  public mapMarkets(venueMarkets: TMarket[], eventId: string): UnifiedMarket[] {
    return venueMarkets.map(market => {
      try {
        return this.mapMarket(market, eventId);
      } catch (error) {
        console.error(`Error mapping market for venue ${this.venue}:`, error);
        throw error;
      }
    });
  }

  public mapPriceDataArray(venuePriceDataArray: TPriceData[]): UnifiedPriceData[] {
    return venuePriceDataArray.map(priceData => {
      try {
        return this.mapPriceData(priceData);
      } catch (error) {
        console.error(`Error mapping price data for venue ${this.venue}:`, error);
        throw error;
      }
    });
  }
}
