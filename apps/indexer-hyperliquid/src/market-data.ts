import type { Pool } from "pg";
import {
  publishMarketState,
  publishMarketUpdate,
  type RedisClientType,
} from "@hunch/infra";
import { writeUnifiedBookTop } from "@hunch/db";
import type {
  HyperliquidBboPayload,
  HyperliquidBookLevel,
  HyperliquidL2Book,
  HyperliquidMappedSnapshot,
  HyperliquidOutcomeAssetRow,
} from "./types.js";

const VENUE = "hyperliquid";
const OFFICIAL_OUTCOME_ASSET_OFFSET = 100_000_000;

export type HyperliquidBookTop = {
  tokenId: string;
  coin: string;
  bestBid: number | null;
  bestAsk: number | null;
  tsMs: number;
  snapshot: {
    token_id: string;
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
    timestamp: string;
  };
};

export type HyperliquidBookTarget = {
  tokenId: string;
  coin: string;
};

function parseFiniteNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hunchTokenIdFromHyperliquidCoin(coin: string): string | null {
  const match = /^#(\d+)$/.exec(coin.trim());
  if (!match) return null;
  return `${VENUE}:${OFFICIAL_OUTCOME_ASSET_OFFSET + Number(match[1])}`;
}

export function hyperliquidCoinFromHunchTokenId(
  tokenId: string,
): string | null {
  const prefix = `${VENUE}:`;
  if (!tokenId.startsWith(prefix)) return null;
  const assetId = Number(tokenId.slice(prefix.length));
  if (!Number.isSafeInteger(assetId)) return null;
  const encoding = assetId - OFFICIAL_OUTCOME_ASSET_OFFSET;
  if (!Number.isSafeInteger(encoding) || encoding < 0) return null;
  return `#${encoding}`;
}

function toBookSide(levels: HyperliquidBookLevel[]) {
  return levels.map((level) => ({
    price: level.px,
    size: level.sz,
  }));
}

function toMaybeBookSide(level?: HyperliquidBookLevel | null) {
  if (!level) return [];
  return [{ price: level.px, size: level.sz }];
}

export function buildBookTopFromL2Book(
  tokenId: string,
  book: HyperliquidL2Book,
): HyperliquidBookTop | null {
  const [bids, asks] = book.levels;
  const bestBid = parseFiniteNumber(bids[0]?.px);
  const bestAsk = parseFiniteNumber(asks[0]?.px);
  if (bestBid == null && bestAsk == null) return null;

  return {
    tokenId,
    coin: book.coin,
    bestBid,
    bestAsk,
    tsMs: book.time,
    snapshot: {
      token_id: tokenId,
      bids: toBookSide(bids),
      asks: toBookSide(asks),
      timestamp: String(book.time),
    },
  };
}

export function buildBookTopFromBbo(
  tokenId: string,
  bbo: HyperliquidBboPayload,
): HyperliquidBookTop | null {
  const [bid, ask] = bbo.bbo;
  const bestBid = parseFiniteNumber(bid?.px);
  const bestAsk = parseFiniteNumber(ask?.px);
  if (bestBid == null && bestAsk == null) return null;

  return {
    tokenId,
    coin: bbo.coin,
    bestBid,
    bestAsk,
    tsMs: bbo.time,
    snapshot: {
      token_id: tokenId,
      bids: toMaybeBookSide(bid),
      asks: toMaybeBookSide(ask),
      timestamp: String(bbo.time),
    },
  };
}

export function selectTopBookTokenIds(params: {
  snapshot: HyperliquidMappedSnapshot;
  hotTokenIds?: string[];
  maxTokens: number;
}): string[] {
  const maxTokens = Math.max(0, Math.trunc(params.maxTokens));
  if (maxTokens <= 0) return [];

  const selected: string[] = [];
  const seen = new Set<string>();
  const push = (tokenId: string | null | undefined) => {
    if (!tokenId || seen.has(tokenId)) return;
    if (!hyperliquidCoinFromHunchTokenId(tokenId)) return;
    if (selected.length >= maxTokens) return;
    seen.add(tokenId);
    selected.push(tokenId);
  };

  for (const tokenId of params.hotTokenIds ?? []) {
    push(tokenId);
  }

  const sortedAssets = [...params.snapshot.assets].sort(
    (left, right) => (right.day_ntl_vlm ?? 0) - (left.day_ntl_vlm ?? 0),
  );
  for (const asset of sortedAssets) {
    push(asset.hunch_token_id);
  }

  return selected;
}

export function assetCoinLookup(
  assets: HyperliquidOutcomeAssetRow[],
): Map<string, string> {
  return new Map(
    assets.map((asset) => [asset.hunch_token_id, asset.coin] as const),
  );
}

export function selectTopBookTargets(params: {
  snapshot: HyperliquidMappedSnapshot;
  hotTokenIds?: string[];
  maxTokens: number;
}): HyperliquidBookTarget[] {
  const coinByTokenId = assetCoinLookup(params.snapshot.assets);
  return selectTopBookTokenIds(params)
    .map((tokenId) => ({
      tokenId,
      coin:
        coinByTokenId.get(tokenId) ?? hyperliquidCoinFromHunchTokenId(tokenId),
    }))
    .filter((target): target is HyperliquidBookTarget => target.coin != null);
}

export function buildBookSnapshotFromTopTick(params: {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  tsMs: number;
}): HyperliquidBookTop["snapshot"] {
  return {
    token_id: params.tokenId,
    bids:
      params.bestBid != null
        ? [{ price: String(params.bestBid), size: "NA" }]
        : [],
    asks:
      params.bestAsk != null
        ? [{ price: String(params.bestAsk), size: "NA" }]
        : [],
    timestamp: String(params.tsMs),
  };
}

export async function publishHyperliquidBookTop(params: {
  pool: Pool;
  redis: RedisClientType;
  top: HyperliquidBookTop;
  writeBookSnapshot?: boolean;
}): Promise<void> {
  await publishHyperliquidTopTick({
    pool: params.pool,
    redis: params.redis,
    tokenId: params.top.tokenId,
    bestBid: params.top.bestBid,
    bestAsk: params.top.bestAsk,
    tsMs: params.top.tsMs,
    bookSnapshot:
      (params.writeBookSnapshot ?? true) ? params.top.snapshot : undefined,
  });
}

export async function publishHyperliquidTopTick(params: {
  pool: Pool;
  redis: RedisClientType;
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  tsMs: number;
  bookSnapshot?: HyperliquidBookTop["snapshot"];
}): Promise<void> {
  if (params.bestBid == null && params.bestAsk == null) return;

  const lastPrice =
    params.bestBid != null && params.bestAsk != null
      ? (params.bestBid + params.bestAsk) / 2
      : (params.bestBid ?? params.bestAsk ?? null);
  const tick = {
    token_id: params.tokenId,
    best_bid: params.bestBid,
    best_ask: params.bestAsk,
    ts: params.tsMs,
  };
  const tickJson = JSON.stringify(tick);
  const multi = params.redis.multi();
  if (params.bookSnapshot) {
    multi.set(`book:${params.tokenId}`, JSON.stringify(params.bookSnapshot), {
      EX: 5,
    });
  }
  multi.set(`top:${params.tokenId}`, tickJson, { EX: 60 });
  multi.publish(`prices:${params.tokenId}`, tickJson);

  await Promise.all([
    writeUnifiedBookTop(
      params.pool,
      params.tokenId,
      params.bestBid,
      params.bestAsk,
      new Date(params.tsMs),
    ),
    multi.exec(),
    publishMarketState({
      redis: params.redis,
      venue: VENUE,
      tokenId: params.tokenId,
      eventType: "top_book",
      tsMs: params.tsMs,
    }),
    publishMarketUpdate({
      redis: params.redis,
      venue: VENUE,
      tokenIds: [params.tokenId],
      lastPrice,
      tsMs: params.tsMs,
    }),
  ]);
}
