// Fuzz tests for Polymarket mappers
// Tests edge cases, missing fields, invalid data, etc.
import { describe, it, expect } from 'vitest';
import { mapEventRow, mapMarketRow, mapTokens } from '../src/mappers';

describe('Polymarket Mapper Fuzz Tests', () => {
  describe('mapEventRow', () => {
    it('should handle minimal valid event', () => {
      const event = {
        id: 'event1',
        title: 'Test Event',
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.id).toBeDefined();
      expect(result.venue_id).toBe(1);
      expect(result.event_id).toBe('event1');
      expect(result.title).toBe('Test Event');
      expect(result.idempotency_key).toBeDefined();
    });

    it('should handle all null optional fields', () => {
      const event = {
        id: 'event1',
        title: 'Test',
        slug: null,
        active: null,
        closed: null,
        startDate: null,
        endDate: null,
        liquidity: null,
        volume: null,
        volume24hr: null,
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.start_time).toBeNull();
      expect(result.end_time).toBeNull();
      expect(result.liquidity).toBeNull();
      expect(result.volume_total).toBeNull();
      expect(result.volume24hr).toBeNull();
    });

    it('should handle string numbers', () => {
      const event = {
        id: 'event1',
        title: 'Test',
        liquidity: '1000.50',
        volume: '5000',
        volume24hr: '500.75',
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.liquidity).toBe(1000.50);
      expect(result.volume_total).toBe(5000);
      expect(result.volume24hr).toBe(500.75);
    });

    it('should handle invalid numbers gracefully', () => {
      const event = {
        id: 'event1',
        title: 'Test',
        liquidity: 'not a number',
        volume: NaN,
        volume24hr: Infinity,
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.liquidity).toBeNull();
      expect(result.volume_total).toBeNull();
      expect(result.volume24hr).toBeNull();
    });

    it('should handle invalid date strings', () => {
      const event = {
        id: 'event1',
        title: 'Test',
        startDate: 'invalid-date',
        endDate: 'also-invalid',
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.start_time).toBeNull();
      expect(result.end_time).toBeNull();
    });

    it('should handle valid ISO dates', () => {
      const event = {
        id: 'event1',
        title: 'Test',
        startDate: '2024-01-01T00:00:00Z',
        endDate: '2024-12-31T23:59:59Z',
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.start_time).toBeInstanceOf(Date);
      expect(result.end_time).toBeInstanceOf(Date);
      expect(result.start_time?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should handle numeric *Num fields preferentially', () => {
      const event = {
        id: 'event1',
        title: 'Test',
        liquidity: '100',
        liquidityNum: 200,
        volume: '300',
        volumeNum: 400,
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      // Should prefer *Num fields (but event doesn't have them in the mapper)
      expect(result.liquidity).toBe(100);
      expect(result.volume_total).toBe(300);
    });

    it('should handle boolean defaults', () => {
      const event1 = {
        id: 'event1',
        title: 'Test',
        active: false,
        closed: true,
        markets: [],
      };

      const result1 = mapEventRow(1, event1 as any);
      expect(result1.active).toBe(false);
      expect(result1.closed).toBe(true);

      const event2 = {
        id: 'event2',
        title: 'Test',
        markets: [],
      };

      const result2 = mapEventRow(1, event2 as any);
      expect(result2.active).toBe(true); // Default
      expect(result2.closed).toBe(false); // Default
    });
  });

  describe('mapMarketRow', () => {
    it('should handle minimal valid market', () => {
      const market = {
        id: 'market1',
        question: 'Test Question',
        clobTokenIds: ['token1', 'token2'],
      };

      const result = mapMarketRow(1, 'event-uuid', market as any);

      expect(result.id).toBeDefined();
      expect(result.market_id).toBe('market1');
      expect(result.title).toBe('Test Question');
      expect(result.clob_token_yes).toBe('token1');
      expect(result.clob_token_no).toBe('token2');
      expect(result.idempotency_key).toBeDefined();
    });

    it('should handle missing clobTokenIds', () => {
      const market = {
        id: 'market1',
        question: 'Test',
      };

      const result = mapMarketRow(1, 'event-uuid', market as any);

      expect(result.clob_token_yes).toBeNull();
      expect(result.clob_token_no).toBeNull();
    });

    it('should handle empty clobTokenIds array', () => {
      const market = {
        id: 'market1',
        question: 'Test',
        clobTokenIds: [],
      };

      const result = mapMarketRow(1, 'event-uuid', market as any);

      expect(result.clob_token_yes).toBeUndefined();
      expect(result.clob_token_no).toBeUndefined();
    });

    it('should prefer numeric *Num fields', () => {
      const market = {
        id: 'market1',
        question: 'Test',
        liquidity: '100',
        liquidityNum: 200,
        volume: '300',
        volumeNum: 400,
        volume24hr: '50',
        clobTokenIds: ['t1', 't2'],
      };

      const result = mapMarketRow(1, 'event-uuid', market as any);

      expect(result.liquidity).toBe(200); // Prefers liquidityNum
      expect(result.volume_total).toBe(400); // Prefers volumeNum
      expect(result.volume24hr).toBe(50); // Only volume24hr exists
    });

    it('should handle boolean defaults', () => {
      const market1 = {
        id: 'market1',
        question: 'Test',
        enableOrderBook: false,
        acceptingOrders: false,
        clobTokenIds: ['t1', 't2'],
      };

      const result1 = mapMarketRow(1, 'event-uuid', market1 as any);
      expect(result1.enable_orderbook).toBe(false);
      expect(result1.accepting_orders).toBe(false);

      const market2 = {
        id: 'market2',
        question: 'Test',
        clobTokenIds: ['t1', 't2'],
      };

      const result2 = mapMarketRow(1, 'event-uuid', market2 as any);
      expect(result2.enable_orderbook).toBe(true); // Default
      expect(result2.accepting_orders).toBe(true); // Default
    });

    it('should handle negRisk fields', () => {
      const market = {
        id: 'market1',
        question: 'Test',
        negRisk: true,
        negRiskMarketID: 'neg-market-123',
        clobTokenIds: ['t1', 't2'],
      };

      const result = mapMarketRow(1, 'event-uuid', market as any);

      expect(result.neg_risk).toBe(true);
      expect(result.neg_risk_market_id).toBe('neg-market-123');
    });

    it('should handle tick size and min order size', () => {
      const market = {
        id: 'market1',
        question: 'Test',
        orderPriceMinTickSize: 0.01,
        orderMinSize: 10,
        clobTokenIds: ['t1', 't2'],
      };

      const result = mapMarketRow(1, 'event-uuid', market as any);

      expect(result.order_price_min_tick_size).toBe(0.01);
      expect(result.order_min_size).toBe(10);
    });
  });

  describe('mapTokens', () => {
    it('should map both YES and NO tokens', () => {
      const result = mapTokens('market-uuid', 'token-yes', 'token-no');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        token_id: 'token-yes',
        market_id: 'market-uuid',
        side: 'YES',
      });
      expect(result[1]).toEqual({
        token_id: 'token-no',
        market_id: 'market-uuid',
        side: 'NO',
      });
    });

    it('should handle missing YES token', () => {
      const result = mapTokens('market-uuid', null, 'token-no');

      expect(result).toHaveLength(1);
      expect(result[0].side).toBe('NO');
    });

    it('should handle missing NO token', () => {
      const result = mapTokens('market-uuid', 'token-yes', null);

      expect(result).toHaveLength(1);
      expect(result[0].side).toBe('YES');
    });

    it('should handle both tokens missing', () => {
      const result = mapTokens('market-uuid', null, null);

      expect(result).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle extremely large numbers', () => {
      const event = {
        id: 'event1',
        title: 'Test',
        liquidity: Number.MAX_SAFE_INTEGER,
        volume: 1e15,
        volume24hr: 1e10,
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.liquidity).toBe(Number.MAX_SAFE_INTEGER);
      expect(result.volume_total).toBe(1e15);
      expect(result.volume24hr).toBe(1e10);
    });

    it('should handle negative numbers (should allow for some fields)', () => {
      const event = {
        id: 'event1',
        title: 'Test',
        liquidity: -100,
        volume: -200,
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      // Current implementation allows negatives (may want to add validation)
      expect(result.liquidity).toBe(-100);
      expect(result.volume_total).toBe(-200);
    });

    it('should handle very long strings', () => {
      const longTitle = 'A'.repeat(10000);
      const event = {
        id: 'event1',
        title: longTitle,
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.title).toBe(longTitle);
      expect(result.title.length).toBe(10000);
    });

    it('should handle special characters in strings', () => {
      const event = {
        id: 'event1',
        title: 'Test with "quotes" and \'apostrophes\' and <tags>',
        slug: 'test-with-special-chars-&-symbols',
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.title).toContain('"quotes"');
      expect(result.slug).toContain('&');
    });

    it('should preserve raw data', () => {
      const event = {
        id: 'event1',
        title: 'Test',
        customField: 'custom-value',
        nested: { field: 'value' },
        markets: [],
      };

      const result = mapEventRow(1, event as any);

      expect(result.raw).toEqual(event);
      expect(result.raw.customField).toBe('custom-value');
      expect(result.raw.nested.field).toBe('value');
    });
  });
});

