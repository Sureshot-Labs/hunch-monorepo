import type {
  PolymarketRequestData,
  PriceHistoryData,
  PriceHistoryPoint,
} from "../server-types.js";
import { isRecord } from "../lib/type-guards.js";

function isPriceHistoryPoint(value: unknown): value is PriceHistoryPoint {
  return isRecord(value) && typeof value.t === "number";
}

export class PolymarketRateLimiter {
  public requestQueue: Array<{
    key: string;
    requestData: PolymarketRequestData;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  public isProcessing = false;
  private lastRequestTime = 0;
  public requestCount = 0;
  public windowStart = Date.now();

  // Polymarket rate limits by endpoint type
  private readonly RATE_LIMITS = {
    "price-history": { maxRequests: 100, windowMs: 10000 }, // 100 requests per 10 seconds
    book: { maxRequests: 200, windowMs: 10000 }, // 200 requests per 10 seconds
    books: { maxRequests: 80, windowMs: 10000 }, // 80 requests per 10 seconds
    price: { maxRequests: 200, windowMs: 10000 }, // 200 requests per 10 seconds
    prices: { maxRequests: 80, windowMs: 10000 }, // 80 requests per 10 seconds
    midpoint: { maxRequests: 200, windowMs: 10000 }, // 200 requests per 10 seconds
    spreads: { maxRequests: 200, windowMs: 10000 }, // 200 requests per 10 seconds
  };

  private readonly WINDOW_MS = 10000; // 10 seconds
  private readonly MIN_REQUEST_INTERVAL = 50; // Minimum 50ms between requests

  async queueRequest<T = unknown>(
    key: string,
    requestData: PolymarketRequestData,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const resolveUnknown = (value: unknown) => resolve(value as T);
      this.requestQueue.push({
        key,
        requestData,
        resolve: resolveUnknown,
        reject,
      });
      void this.processQueue().catch((error) => {
        // Avoid crashing the process if the queue loop throws unexpectedly.
        this.isProcessing = false;
        reject(error);
      });
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.requestQueue.length > 0) {
      const now = Date.now();

      // Reset window if needed
      if (now - this.windowStart >= this.WINDOW_MS) {
        this.requestCount = 0;
        this.windowStart = now;
      }

      // Check if we can make a request (use most restrictive limit)
      const maxRequests = Math.min(
        ...Object.values(this.RATE_LIMITS).map((limit) => limit.maxRequests),
      );
      if (this.requestCount >= maxRequests) {
        // Wait for window to reset
        const waitTime = this.WINDOW_MS - (now - this.windowStart);
        await new Promise((resolve) => setTimeout(resolve, waitTime + 100));
        continue;
      }

      // Ensure minimum interval between requests
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.MIN_REQUEST_INTERVAL - timeSinceLastRequest),
        );
      }

      const request = this.requestQueue.shift();
      if (!request) break;

      try {
        let result;

        // Handle different request types
        if (request.requestData.isPost) {
          if (!request.requestData.endpoint) {
            throw new Error(
              "Polymarket request isPost=true but endpoint is missing",
            );
          }
          result = await this.makePostRequest(
            request.requestData.endpoint,
            request.requestData.body,
          );
        } else if (request.requestData.endpoint) {
          result = await this.makeRequest(
            request.requestData.endpoint,
            request.requestData.params,
          );
        } else {
          // Legacy price history request
          const params = new URLSearchParams({
            market: request.key,
            interval: "max",
          });
          result = await this.makeRequest("/prices-history", params);
        }

        request.resolve(result);
        this.requestCount++;
        this.lastRequestTime = Date.now();
      } catch (error) {
        request.reject(error);
      }
    }

    this.isProcessing = false;
  }

  private async makeRequest(
    endpoint: string,
    params: URLSearchParams = new URLSearchParams(),
  ): Promise<unknown> {
    const url = `https://clob.polymarket.com${endpoint}${params.toString() ? "?" + params.toString() : ""}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Hunch-API/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Polymarket API error: ${response.status} ${response.statusText}`,
      );
    }

    return response.json();
  }

  private async makePostRequest(
    endpoint: string,
    body: unknown,
  ): Promise<unknown> {
    const url = `https://clob.polymarket.com${endpoint}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Hunch-API/1.0",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Polymarket API error: ${response.status} ${response.statusText}`,
      );
    }

    return response.json();
  }
}

class PriceHistoryProcessor {
  // Frontend-friendly time intervals in milliseconds
  private static readonly TIME_INTERVALS = {
    "1m": 60 * 1000, // 1 minute
    "30m": 30 * 60 * 1000, // 30 minutes
    "1h": 60 * 60 * 1000, // 1 hour
    "4h": 4 * 60 * 60 * 1000, // 4 hours
    "6h": 6 * 60 * 60 * 1000, // 6 hours
    "1d": 24 * 60 * 60 * 1000, // 1 day
    "1w": 7 * 24 * 60 * 60 * 1000, // 1 week
    "1M": 30 * 24 * 60 * 60 * 1000, // 1 month
    "6m": 6 * 30 * 24 * 60 * 60 * 1000, // 6 months (legacy)
    "6M": 6 * 30 * 24 * 60 * 60 * 1000, // 6 months
    "1Y": 365 * 24 * 60 * 60 * 1000, // 1 year
    max: Infinity, // All available data
  };

  static processPriceHistory(
    rawData: PriceHistoryData,
    requestedInterval: string,
    startTs?: number,
    endTs?: number,
    fidelityOverride?: number,
  ): PriceHistoryData {
    const historyRaw = rawData.history;
    if (!Array.isArray(historyRaw)) return rawData;

    const history = historyRaw.filter(isPriceHistoryPoint);
    if (history.length === 0) return rawData;

    const now = Date.now() / 1000; // Convert to Unix timestamp

    // Determine the actual time range to return
    const intervalMs =
      PriceHistoryProcessor.TIME_INTERVALS[
        requestedInterval as keyof typeof PriceHistoryProcessor.TIME_INTERVALS
      ];
    const resolvedEndTs = endTs ?? now;
    let actualStartTs: number | null = startTs ?? null;
    const actualEndTs: number = resolvedEndTs;

    if (actualStartTs == null) {
      if (intervalMs === undefined) {
        // Unknown interval and no explicit start; return all data.
        return rawData;
      }
      if (intervalMs === Infinity) {
        actualStartTs = history[0]?.t ?? resolvedEndTs;
      } else {
        actualStartTs = resolvedEndTs - intervalMs / 1000;
      }
    }

    // Filter and slice the data
    const filteredHistory = history.filter((point) => {
      const timestamp = point.t;
      return (
        actualStartTs != null &&
        timestamp >= actualStartTs &&
        timestamp <= actualEndTs
      );
    });

    // Apply fidelity (downsampling) if needed
    const fidelity =
      typeof fidelityOverride === "number" && fidelityOverride > 0
        ? fidelityOverride
        : PriceHistoryProcessor.calculateFidelity(
            actualStartTs ?? resolvedEndTs,
            actualEndTs,
            requestedInterval,
          );
    const downsampledHistory = PriceHistoryProcessor.downsampleData(
      filteredHistory,
      fidelity,
    );

    return {
      ...rawData,
      history: downsampledHistory,
      metadata: {
        requestedInterval,
        actualStartTs,
        actualEndTs,
        originalDataPoints: history.length,
        filteredDataPoints: filteredHistory.length,
        finalDataPoints: downsampledHistory.length,
        fidelityMinutes: fidelity,
      },
    };
  }

  private static calculateFidelity(
    startTs: number,
    endTs: number,
    interval: string,
  ): number {
    const durationMs = (endTs - startTs) * 1000;

    // Determine appropriate fidelity based on interval and duration
    switch (interval) {
      case "1m":
        return 1;
      case "30m":
        return 1;
      case "1h":
        return 1; // 1 minute fidelity for 1 hour
      case "4h":
        return 5; // 5 minute fidelity for 4 hours
      case "6h":
        return 5; // 5 minute fidelity for 6 hours
      case "1d":
        return 15; // 15 minute fidelity for 1 day
      case "1w":
        return 60; // 1 hour fidelity for 1 week
      case "1M":
        return 240; // 4 hour fidelity for 1 month
      case "6m":
      case "6M":
        return 1440; // 1 day fidelity for 6 months
      case "1Y":
        return 1440; // 1 day fidelity for 1 year
      default:
        return Math.max(1, Math.floor(durationMs / (1000 * 60 * 100))); // Dynamic based on duration
    }
  }

  private static downsampleData(
    history: PriceHistoryPoint[],
    fidelityMinutes: number,
  ): PriceHistoryPoint[] {
    if (fidelityMinutes <= 1 || history.length <= 100) {
      return history; // No downsampling needed
    }

    const downsampled: PriceHistoryPoint[] = [];
    const fidelityMs = fidelityMinutes * 60 * 1000;

    for (let i = 0; i < history.length; i++) {
      const currentPoint = history[i];
      const currentTime = currentPoint.t * 1000; // Convert to milliseconds

      if (downsampled.length === 0) {
        downsampled.push(currentPoint);
        continue;
      }

      const lastTime = downsampled[downsampled.length - 1].t * 1000;

      if (currentTime - lastTime >= fidelityMs) {
        downsampled.push(currentPoint);
      }
    }

    return downsampled;
  }
}

export class PolymarketClient {
  private pendingRequests = new Map<string, Promise<PriceHistoryData>>();

  constructor(private readonly rateLimiter: PolymarketRateLimiter) {}

  getRateLimiterStatus() {
    return {
      queueLength: this.rateLimiter.requestQueue.length,
      isProcessing: this.rateLimiter.isProcessing,
      requestCount: this.rateLimiter.requestCount,
      windowStart: this.rateLimiter.windowStart,
      timeUntilReset: Math.max(
        0,
        this.rateLimiter.windowStart + 10000 - Date.now(),
      ),
    };
  }

  // Existing price history method (maintains backward compatibility)
  async getPriceHistory(
    tokenId: string,
    options: {
      startTs?: number;
      endTs?: number;
      interval?: string;
      fidelity?: number;
    } = {},
  ): Promise<PriceHistoryData> {
    // Always use the same cache key for max data (tokenId only)
    // This ensures we fetch max data once and slice it for different requests
    const maxDataKey = `max-data:${tokenId}`;

    // If max data is already being fetched for this token, wait for it
    const existingPromise = this.pendingRequests.get(maxDataKey);
    if (existingPromise) {
      const maxData = await existingPromise;

      // Process the max data for the specific request
      return PriceHistoryProcessor.processPriceHistory(
        maxData,
        options.interval || "max",
        options.startTs,
        options.endTs,
        options.fidelity,
      );
    }

    // Create new request promise for max data
    const requestPromise = this.rateLimiter.queueRequest<PriceHistoryData>(
      tokenId,
      {
        endpoint: "/prices-history",
        params: new URLSearchParams({ market: tokenId, interval: "max" }),
      },
    );

    // Store the promise for deduplication (using max data key)
    this.pendingRequests.set(maxDataKey, requestPromise);

    // Clean up when request completes
    requestPromise.finally(() => {
      this.pendingRequests.delete(maxDataKey);
    });

    // Wait for max data and then process it
    const maxData = await requestPromise;
    return PriceHistoryProcessor.processPriceHistory(
      maxData,
      options.interval || "max",
      options.startTs,
      options.endTs,
      options.fidelity,
    );
  }

  // New market data methods for trading functionality

  /**
   * Get order book for a single token
   * Rate limit: 200 requests/10s
   */
  async getOrderBook(tokenId: string): Promise<unknown> {
    const params = new URLSearchParams({ token_id: tokenId });
    return this.rateLimiter.queueRequest(`/book:${tokenId}`, {
      endpoint: "/book",
      params,
    });
  }

  /**
   * Get order books for multiple tokens
   * Rate limit: 80 requests/10s
   */
  async getOrderBooksBatch(tokenIds: string[]): Promise<unknown> {
    const body = tokenIds.map((id) => ({ token_id: id }));
    return this.rateLimiter.queueRequest(`/books:${tokenIds.join(",")}`, {
      endpoint: "/books",
      body,
      isPost: true,
    });
  }

  /**
   * Get price for a single token with side
   * Rate limit: 200 requests/10s
   */
  async getPrice(tokenId: string, side: "BUY" | "SELL"): Promise<unknown> {
    const params = new URLSearchParams({
      token_id: tokenId,
      side: side,
    });
    return this.rateLimiter.queueRequest(`/price:${tokenId}:${side}`, {
      endpoint: "/price",
      params,
    });
  }

  /**
   * Get prices for multiple tokens with sides
   * Rate limit: 80 requests/10s
   */
  async getPricesBatch(
    requests: Array<{ token_id: string; side: "BUY" | "SELL" }>,
  ): Promise<unknown> {
    return this.rateLimiter.queueRequest(
      `/prices:${requests.map((r) => `${r.token_id}:${r.side}`).join(",")}`,
      {
        endpoint: "/prices",
        body: requests,
        isPost: true,
      },
    );
  }

  /**
   * Get midpoint price for a token
   * Rate limit: 200 requests/10s
   */
  async getMidpointPrice(tokenId: string): Promise<unknown> {
    const params = new URLSearchParams({ token_id: tokenId });
    return this.rateLimiter.queueRequest(`/midpoint:${tokenId}`, {
      endpoint: "/midpoint",
      params,
    });
  }

  /**
   * Get bid-ask spreads for multiple tokens
   * Rate limit: 200 requests/10s
   */
  async getSpreadsBatch(tokenIds: string[]): Promise<unknown> {
    const body = tokenIds.map((id) => ({ token_id: id }));
    return this.rateLimiter.queueRequest(`/spreads:${tokenIds.join(",")}`, {
      endpoint: "/spreads",
      body,
      isPost: true,
    });
  }
}

export const polymarketRateLimiter = new PolymarketRateLimiter();
export const polymarketClient = new PolymarketClient(polymarketRateLimiter);
