// Tests for Kalshi API client
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KalshiClient } from '../src/kalshiClient';
import fs from 'fs';

// Mock fs for private key reading
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue('mock-private-key'),
  },
  readFileSync: vi.fn().mockReturnValue('mock-private-key'),
}));

// Mock fetch
global.fetch = vi.fn();

// Mock Redis and rate limiter
vi.mock('../../indexer-polymarket/src/redis', () => ({
  getRedis: vi.fn().mockResolvedValue({
    hget: vi.fn(),
    hmset: vi.fn(),
    expire: vi.fn(),
    eval: vi.fn().mockResolvedValue(1),
  }),
}));

vi.mock('@hunch/shared/rate-limiter/distributed-rate-limiter', () => ({
  createExchangeRateLimiters: vi.fn().mockReturnValue({
    kalshiRead: {
      waitForTokens: vi.fn().mockResolvedValue(undefined),
    },
    kalshiWrite: {
      waitForTokens: vi.fn().mockResolvedValue(undefined),
    },
  }),
  parseRetryAfter: vi.fn().mockReturnValue(0),
  RateLimitError: class RateLimitError extends Error {},
}));

describe('Kalshi Client', () => {
  let client: KalshiClient;

  beforeEach(() => {
    client = new KalshiClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Authentication', () => {
    it('should include correct authentication headers', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ markets: [] }),
        headers: new Map(),
      });

      await client.get('/trade-api/v2/markets');

      const fetchCall = (global.fetch as any).mock.calls[0];
      const headers = fetchCall[1].headers;

      expect(headers['KALSHI-ACCESS-KEY']).toBeDefined();
      expect(headers['KALSHI-ACCESS-TIMESTAMP']).toBeDefined();
      expect(headers['KALSHI-ACCESS-SIGNATURE']).toBeDefined();
      expect(headers['accept']).toBe('application/json');
    });

    it('should generate unique signature for each request', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Map(),
      });

      await client.get('/trade-api/v2/markets');
      const sig1 = (global.fetch as any).mock.calls[0][1].headers['KALSHI-ACCESS-SIGNATURE'];

      // Wait a bit to get different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      await client.get('/trade-api/v2/markets');
      const sig2 = (global.fetch as any).mock.calls[1][1].headers['KALSHI-ACCESS-SIGNATURE'];

      // Signatures should be different (different timestamps)
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('Rate Limiting', () => {
    it('should handle 429 with exponential backoff', async () => {
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Map(),
          text: async () => 'Rate limit exceeded',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Map(),
          text: async () => 'Rate limit exceeded',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ markets: [] }),
          headers: new Map(),
        });

      await client.get('/trade-api/v2/markets');

      // Should have retried 3 times total
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should respect Retry-After header', async () => {
      const mockParseRetryAfter = vi.fn().mockReturnValue(5000); // 5 seconds
      vi.mocked(await import('@hunch/shared/rate-limiter/distributed-rate-limiter')).parseRetryAfter = mockParseRetryAfter;

      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Map([['Retry-After', '5']]),
          text: async () => 'Rate limit exceeded',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ markets: [] }),
          headers: new Map(),
        });

      await client.get('/trade-api/v2/markets');

      expect(mockParseRetryAfter).toHaveBeenCalledWith('5');
    });

    it('should use separate limiters for read and write', async () => {
      const mockRateLimiters = {
        kalshiRead: {
          waitForTokens: vi.fn().mockResolvedValue(undefined),
        },
        kalshiWrite: {
          waitForTokens: vi.fn().mockResolvedValue(undefined),
        },
      };

      vi.mocked(await import('@hunch/shared/rate-limiter/distributed-rate-limiter')).createExchangeRateLimiters = vi.fn().mockReturnValue(mockRateLimiters);

      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Map(),
      });

      // GET request should use read limiter
      await client.get('/trade-api/v2/markets');
      expect(mockRateLimiters.kalshiRead.waitForTokens).toHaveBeenCalled();

      // POST request should use write limiter
      await client.post('/trade-api/v2/orders', { ticker: 'TEST' });
      expect(mockRateLimiters.kalshiWrite.waitForTokens).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should throw error on non-OK response', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
        headers: new Map(),
      });

      await expect(client.get('/trade-api/v2/markets/INVALID')).rejects.toThrow('404');
    });

    it('should throw error on network failure', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      await expect(client.get('/trade-api/v2/markets')).rejects.toThrow('Network error');
    });

    it('should max out retries on persistent 429', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Map(),
        text: async () => 'Rate limit exceeded',
      });

      await expect(client.get('/trade-api/v2/markets')).rejects.toThrow();

      // Should have tried 4 times (initial + 3 retries)
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('Request Methods', () => {
    it('should handle GET requests with query params', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [] }),
        headers: new Map(),
      });

      await client.get('/trade-api/v2/events', { status: 'open', limit: 100 });

      const fetchUrl = (global.fetch as any).mock.calls[0][0];
      expect(fetchUrl).toContain('status=open');
      expect(fetchUrl).toContain('limit=100');
    });

    it('should handle POST requests with body', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ order_id: '123' }),
        headers: new Map(),
      });

      await client.post('/trade-api/v2/orders', {
        ticker: 'TEST',
        action: 'buy',
        count: 10,
      });

      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].headers['content-type']).toBe('application/json');
      
      const body = JSON.parse(fetchCall[1].body);
      expect(body.ticker).toBe('TEST');
      expect(body.action).toBe('buy');
      expect(body.count).toBe(10);
    });
  });
});

