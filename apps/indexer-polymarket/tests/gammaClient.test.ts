// Tests for Polymarket Gamma API client
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchEventsPage, fetchAllEvents } from '../src/gammaClient';

// Mock fetch globally
global.fetch = vi.fn();

// Mock Redis and rate limiter
vi.mock('../src/redis', () => ({
  getRedis: vi.fn().mockResolvedValue({
    hget: vi.fn(),
    hmset: vi.fn(),
    expire: vi.fn(),
    eval: vi.fn().mockResolvedValue(1), // Always allow rate limit tokens
  }),
}));

vi.mock('@hunch/shared/rate-limiter/distributed-rate-limiter', () => ({
  createExchangeRateLimiters: vi.fn().mockReturnValue({
    polymarket: {
      waitForTokens: vi.fn().mockResolvedValue(undefined),
    },
  }),
  parseRetryAfter: vi.fn().mockReturnValue(0),
  RateLimitError: class RateLimitError extends Error {},
}));

describe('Polymarket Gamma Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchEventsPage', () => {
    it('should fetch events with correct parameters', async () => {
      const mockEvents = {
        data: [
          {
            id: 'event1',
            title: 'Test Event',
            active: true,
            closed: false,
            markets: [],
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockEvents,
        headers: new Map(),
      });

      const result = await fetchEventsPage(0, 50);

      // Verify fetch was called with correct URL
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/events/pagination'),
        expect.objectContaining({
          headers: { accept: 'application/json' },
        })
      );

      // Verify URL parameters
      const callUrl = (global.fetch as any).mock.calls[0][0] as URL;
      expect(callUrl.searchParams.get('limit')).toBe('50');
      expect(callUrl.searchParams.get('active')).toBe('true');
      expect(callUrl.searchParams.get('archived')).toBe('false');
      expect(callUrl.searchParams.get('offset')).toBe('0');

      // Verify result
      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('event1');
    });

    it('should handle 429 rate limit errors', async () => {
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Map([['Retry-After', '60']]),
          text: async () => 'Rate limit exceeded',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
          headers: new Map(),
        });

      const result = await fetchEventsPage(0, 50);

      // Should have retried and succeeded
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result.events).toEqual([]);
    });

    it('should handle non-OK responses', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
        headers: new Map(),
      });

      await expect(fetchEventsPage(0, 50)).rejects.toThrow('Gamma 500');
    });

    it('should handle network errors', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      await expect(fetchEventsPage(0, 50)).rejects.toThrow('Network error');
    });

    it('should parse events from data or events field', async () => {
      // Test with 'data' field
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'event1', title: 'Test', markets: [] }],
        }),
        headers: new Map(),
      });

      const result1 = await fetchEventsPage(0, 50);
      expect(result1.events).toHaveLength(1);

      // Test with 'events' field
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          events: [{ id: 'event2', title: 'Test 2', markets: [] }],
        }),
        headers: new Map(),
      });

      const result2 = await fetchEventsPage(0, 50);
      expect(result2.events).toHaveLength(1);
    });
  });

  describe('fetchAllEvents', () => {
    it('should fetch multiple pages', async () => {
      // Mock two pages of results
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: Array(50).fill(null).map((_, i) => ({
              id: `event${i}`,
              title: `Event ${i}`,
              markets: [],
            })),
          }),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: Array(30).fill(null).map((_, i) => ({
              id: `event${i + 50}`,
              title: `Event ${i + 50}`,
              markets: [],
            })),
          }),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }), // Empty page
          headers: new Map(),
        });

      const result = await fetchAllEvents(100);

      // Should have fetched 80 events (50 + 30)
      expect(result).toHaveLength(80);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should stop when max is reached', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: Array(50).fill(null).map((_, i) => ({
            id: `event${i}`,
            title: `Event ${i}`,
            markets: [],
          })),
        }),
        headers: new Map(),
      });

      const result = await fetchAllEvents(75);

      // Should fetch 2 pages (50 + 25 from second page to reach 75)
      expect(result).toHaveLength(75);
    });

    it('should stop on empty page', async () => {
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: Array(10).fill(null).map((_, i) => ({
              id: `event${i}`,
              title: `Event ${i}`,
              markets: [],
            })),
          }),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
          headers: new Map(),
        });

      const result = await fetchAllEvents(100);

      // Should stop after first page + empty page
      expect(result).toHaveLength(10);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});

