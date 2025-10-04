// Mapper factory for creating venue-specific mappers
import { BaseMapper } from './base';
import { PolymarketMapper } from './polymarket';
import { KalshiMapper } from './kalshi';
import { LimitlessMapper } from './limitless';
import { Venue } from '../types/unified';

// Mapper factory class
export class MapperFactory {
  private static mappers: Map<Venue, BaseMapper<any, any, any>> = new Map();

  // Get or create a mapper for a specific venue
  public static getMapper<TEvent, TMarket, TPriceData>(
    venue: Venue
  ): BaseMapper<TEvent, TMarket, TPriceData> {
    if (!this.mappers.has(venue)) {
      this.mappers.set(venue, this.createMapper(venue));
    }
    
    return this.mappers.get(venue)! as BaseMapper<TEvent, TMarket, TPriceData>;
  }

  // Create a new mapper instance for a venue
  private static createMapper(venue: Venue): BaseMapper<any, any, any> {
    switch (venue) {
      case 'polymarket':
        return new PolymarketMapper();
      case 'kalshi':
        return new KalshiMapper();
      case 'limitless':
        return new LimitlessMapper();
      default:
        throw new Error(`Unsupported venue: ${venue}`);
    }
  }

  // Get all available venues
  public static getAvailableVenues(): Venue[] {
    return ['polymarket', 'kalshi', 'limitless'];
  }

  // Check if a venue is supported
  public static isVenueSupported(venue: string): venue is Venue {
    return this.getAvailableVenues().includes(venue as Venue);
  }

  // Clear all cached mappers (useful for testing)
  public static clearCache(): void {
    this.mappers.clear();
  }
}

// Convenience functions for direct mapper access
export const getPolymarketMapper = () => MapperFactory.getMapper('polymarket');
export const getKalshiMapper = () => MapperFactory.getMapper('kalshi');
export const getLimitlessMapper = () => MapperFactory.getMapper('limitless');

// Export the factory as default
export default MapperFactory;
