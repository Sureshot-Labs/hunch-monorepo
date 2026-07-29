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
    priority: "interactive" | "normal";
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  public isProcessing = false;
  public requestCount = 0;
  public windowStart = Date.now();
  private readonly pendingByKey = new Map<string, Promise<unknown>>();
  private activeRequests = 0;
  private activeBackgroundRequests = 0;
  private readonly maxConcurrentRequests = 8;
  private readonly maxBackgroundRequests = 6;
  private readonly interactiveRequestTimeoutMs: number;
  private readonly backgroundRequestTimeoutMs: number;

  constructor(
    options: {
      interactiveRequestTimeoutMs?: number;
      backgroundRequestTimeoutMs?: number;
    } = {},
  ) {
    this.interactiveRequestTimeoutMs =
      options.interactiveRequestTimeoutMs ?? 4_000;
    this.backgroundRequestTimeoutMs =
      options.backgroundRequestTimeoutMs ?? 15_000;
  }

  queueRequest<T = unknown>(
    key: string,
    requestData: PolymarketRequestData,
    options: { priority?: "interactive" | "normal" } = {},
  ): Promise<T> {
    const existing = this.pendingByKey.get(key);
    if (existing) {
      if (options.priority === "interactive") {
        this.promoteQueuedRequest(key);
      }
      return existing as Promise<T>;
    }

    const priority = options.priority ?? "normal";
    const requestPromise = new Promise<T>((resolve, reject) => {
      const resolveUnknown = (value: unknown) => resolve(value as T);
      const request = {
        key,
        requestData,
        priority,
        resolve: resolveUnknown,
        reject,
      };
      if (priority === "interactive") {
        this.requestQueue.unshift(request);
      } else {
        this.requestQueue.push(request);
      }
    });

    this.pendingByKey.set(key, requestPromise);
    const clearPending = () => {
      if (this.pendingByKey.get(key) === requestPromise) {
        this.pendingByKey.delete(key);
      }
    };
    void requestPromise.then(clearPending, clearPending);
    this.processQueue();
    return requestPromise;
  }

  private promoteQueuedRequest(key: string): void {
    const index = this.requestQueue.findIndex((request) => request.key === key);
    if (index <= 0) return;
    const [request] = this.requestQueue.splice(index, 1);
    if (!request) return;
    request.priority = "interactive";
    this.requestQueue.unshift(request);
  }

  private processQueue(): void {
    while (this.activeRequests < this.maxConcurrentRequests) {
      const interactiveIndex = this.requestQueue.findIndex(
        (request) => request.priority === "interactive",
      );
      const nextIndex =
        interactiveIndex >= 0
          ? interactiveIndex
          : this.activeBackgroundRequests < this.maxBackgroundRequests
            ? 0
            : -1;
      if (nextIndex < 0) break;

      const [request] = this.requestQueue.splice(nextIndex, 1);
      if (!request) break;

      const now = Date.now();
      if (now - this.windowStart >= 10_000) {
        this.requestCount = 0;
        this.windowStart = now;
      }

      this.activeRequests += 1;
      if (request.priority === "normal") {
        this.activeBackgroundRequests += 1;
      }
      this.requestCount += 1;
      this.isProcessing = true;
      void this.executeRequest(request);
    }

    if (this.activeRequests === 0) {
      this.isProcessing = false;
    }
  }

  private async executeRequest(
    request: (typeof this.requestQueue)[number],
  ): Promise<void> {
    try {
      let result;
      const timeoutMs =
        request.priority === "interactive"
          ? this.interactiveRequestTimeoutMs
          : this.backgroundRequestTimeoutMs;

      if (request.requestData.isPost) {
        if (!request.requestData.endpoint) {
          throw new Error(
            "Polymarket request isPost=true but endpoint is missing",
          );
        }
        result = await this.makePostRequest(
          request.requestData.endpoint,
          request.requestData.body,
          timeoutMs,
        );
      } else if (request.requestData.endpoint) {
        result = await this.makeRequest(
          request.requestData.endpoint,
          request.requestData.params,
          timeoutMs,
        );
      } else {
        const params = new URLSearchParams({
          market: request.key,
          interval: "max",
        });
        result = await this.makeRequest("/prices-history", params, timeoutMs);
      }

      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      this.activeRequests -= 1;
      if (request.priority === "normal") {
        this.activeBackgroundRequests -= 1;
      }
      this.processQueue();
    }
  }

  private async makeRequest(
    endpoint: string,
    params: URLSearchParams = new URLSearchParams(),
    timeoutMs = this.backgroundRequestTimeoutMs,
  ): Promise<unknown> {
    const url = `https://clob.polymarket.com${endpoint}${params.toString() ? "?" + params.toString() : ""}`;
    return this.fetchJson(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "Hunch-API/1.0",
        },
      },
      timeoutMs,
    );
  }

  private async makePostRequest(
    endpoint: string,
    body: unknown,
    timeoutMs = this.backgroundRequestTimeoutMs,
  ): Promise<unknown> {
    const url = `https://clob.polymarket.com${endpoint}`;
    return this.fetchJson(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Hunch-API/1.0",
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Polymarket API error: ${response.status} ${response.statusText}`,
        );
      }
      return response.json();
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `Polymarket API request timed out after ${timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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

    // Use both promise branches instead of a bare finally(), whose returned
    // rejected promise can become an unhandled rejection in Bun.
    const clearPending = () => {
      this.pendingRequests.delete(maxDataKey);
    };
    void requestPromise.then(clearPending, clearPending);

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
    return this.rateLimiter.queueRequest(
      `/book:${tokenId}`,
      {
        endpoint: "/book",
        params,
      },
      { priority: "interactive" },
    );
  }

  async getClobMarketInfo(conditionId: string): Promise<unknown> {
    return this.rateLimiter.queueRequest(
      `/clob-markets:${conditionId}`,
      {
        endpoint: `/clob-markets/${conditionId}`,
      },
      { priority: "interactive" },
    );
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
