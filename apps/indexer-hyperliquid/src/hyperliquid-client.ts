import type {
  HyperliquidCandle,
  HyperliquidL2Book,
  HyperliquidOutcomeMetaResponse,
  HyperliquidSpotMetaAndAssetCtxsResponse,
  HyperliquidTrade,
} from "./types.js";

export class HyperliquidInfoError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = "HyperliquidInfoError";
  }
}

export class HyperliquidClient {
  constructor(
    private readonly opts: {
      infoUrl: string;
      timeoutMs: number;
    },
  ) {}

  async postInfo<T>(body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const response = await fetch(this.opts.infoUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!response.ok) {
        throw new HyperliquidInfoError(
          `Hyperliquid info request failed with ${response.status}`,
          response.status,
          parsed,
        );
      }
      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  fetchOutcomeMeta(): Promise<HyperliquidOutcomeMetaResponse> {
    return this.postInfo<HyperliquidOutcomeMetaResponse>({
      type: "outcomeMeta",
    });
  }

  fetchSpotMetaAndAssetCtxs(): Promise<HyperliquidSpotMetaAndAssetCtxsResponse> {
    return this.postInfo<HyperliquidSpotMetaAndAssetCtxsResponse>({
      type: "spotMetaAndAssetCtxs",
    });
  }

  fetchAllMids(): Promise<Record<string, string>> {
    return this.postInfo<Record<string, string>>({ type: "allMids" });
  }

  fetchL2Book(coin: string): Promise<HyperliquidL2Book | null> {
    return this.postInfo<HyperliquidL2Book | null>({
      type: "l2Book",
      coin,
    });
  }

  fetchRecentTrades(coin: string): Promise<HyperliquidTrade[] | null> {
    return this.postInfo<HyperliquidTrade[] | null>({
      type: "recentTrades",
      coin,
    });
  }

  fetchCandleSnapshot(params: {
    coin: string;
    interval: string;
    startTime: number;
    endTime: number;
  }): Promise<HyperliquidCandle[] | null> {
    return this.postInfo<HyperliquidCandle[] | null>({
      type: "candleSnapshot",
      req: params,
    });
  }
}
