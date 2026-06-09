import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkArray } from "@hunch/shared";
import {
  publishMarketState,
  publishMarketUpdate,
  type RedisClientType,
} from "@hunch/infra";
import type { Pool } from "pg";
import { HyperliquidClient } from "./hyperliquid-client.js";
import { persistHyperliquidSnapshot } from "./hyperliquid-repo.js";
import {
  buildBookTopFromL2Book,
  hyperliquidCoinFromHunchTokenId,
  publishHyperliquidBookTop,
  selectTopBookTargets,
  type HyperliquidBookTarget,
} from "./market-data.js";
import { mapHyperliquidSnapshot } from "./mappers.js";
import type {
  HyperliquidMappedSnapshot,
  HyperliquidNetwork,
  HyperliquidOutcomeMetaResponse,
  HyperliquidSpotMetaAndAssetCtxsResponse,
} from "./types.js";

const VENUE = "hyperliquid";

type WrappedSample<T> = {
  response: T;
};

async function readWrappedSample<T>(
  fixtureDir: string,
  fileName: string,
): Promise<T> {
  const raw = await readFile(join(fixtureDir, fileName), "utf8");
  const parsed = JSON.parse(raw) as WrappedSample<T> | T;
  if (
    parsed &&
    typeof parsed === "object" &&
    "response" in parsed &&
    (parsed as WrappedSample<T>).response !== undefined
  ) {
    return (parsed as WrappedSample<T>).response;
  }
  return parsed as T;
}

export async function mapHyperliquidFixtureDir(params: {
  fixtureDir: string;
  network?: HyperliquidNetwork;
}): Promise<HyperliquidMappedSnapshot> {
  const network = params.network ?? "mainnet";
  const outcomeMeta = await readWrappedSample<HyperliquidOutcomeMetaResponse>(
    params.fixtureDir,
    `${network}_outcomeMeta.json`,
  );
  const spotMetaAndAssetCtxs =
    await readWrappedSample<HyperliquidSpotMetaAndAssetCtxsResponse>(
      params.fixtureDir,
      `${network}_spotMetaAndAssetCtxs.json`,
    );
  return mapHyperliquidSnapshot({
    network,
    outcomeMeta,
    spotMetaAndAssetCtxs,
  });
}

export async function fetchHyperliquidSnapshot(params: {
  client: HyperliquidClient;
  network?: HyperliquidNetwork;
}): Promise<HyperliquidMappedSnapshot> {
  const [outcomeMeta, spotMetaAndAssetCtxs] = await Promise.all([
    params.client.fetchOutcomeMeta(),
    params.client.fetchSpotMetaAndAssetCtxs(),
  ]);
  return mapHyperliquidSnapshot({
    network: params.network ?? "mainnet",
    outcomeMeta,
    spotMetaAndAssetCtxs,
  });
}

export async function syncHyperliquidMetadata(params: {
  client?: HyperliquidClient;
  fixtureDir?: string;
  pool?: Pool;
  network?: HyperliquidNetwork;
  dryRun?: boolean;
}): Promise<HyperliquidMappedSnapshot> {
  const snapshot = params.fixtureDir
    ? await mapHyperliquidFixtureDir({
        fixtureDir: params.fixtureDir,
        network: params.network,
      })
    : await (() => {
        if (!params.client) {
          throw new Error("client is required outside fixture mode");
        }
        return fetchHyperliquidSnapshot({
          client: params.client,
          network: params.network,
        });
      })();

  if (!params.dryRun) {
    if (!params.pool) {
      throw new Error("pool is required when dryRun=false");
    }
    await persistHyperliquidSnapshot(params.pool, snapshot);
  }

  return snapshot;
}

function marketTokenIds(market: HyperliquidMappedSnapshot["markets"][number]) {
  return [market.token_yes, market.token_no].filter(
    (tokenId): tokenId is string => Boolean(tokenId),
  );
}

export async function publishHyperliquidMarketMetadata(params: {
  redis: RedisClientType;
  snapshot: HyperliquidMappedSnapshot;
  tsMs?: number;
}): Promise<{ markets: number; tokens: number; failed: number }> {
  const tsMs = params.tsMs ?? Date.now();
  let markets = 0;
  let tokens = 0;
  let failed = 0;

  for (const batch of chunkArray(params.snapshot.markets, 25)) {
    await Promise.all(
      batch.map(async (market) => {
        const tokenIds = marketTokenIds(market);
        if (tokenIds.length === 0) return;
        try {
          await publishMarketUpdate({
            redis: params.redis,
            venue: VENUE,
            tokenIds,
            marketId: market.id,
            eventId: market.event_id,
            conditionId: market.condition_id ?? null,
            volumeTotal: null,
            volume24h: market.volume_24h ?? null,
            liquidity: null,
            openInterest: null,
            lastPrice: market.last_price ?? null,
            status: market.status ?? null,
            acceptingOrders: null,
            resolvedOutcome: market.resolved_outcome ?? null,
            resolvedOutcomePct: market.resolved_outcome_pct ?? null,
            eventVolumeTotal: null,
            eventVolume24h: null,
            eventLiquidity: null,
            eventOpenInterest: null,
            tsMs,
          });
          await Promise.all(
            tokenIds.map((tokenId) =>
              publishMarketState({
                redis: params.redis,
                venue: VENUE,
                tokenId,
                market: market.id,
                conditionId: market.condition_id ?? null,
                eventType: "metadata_refresh",
                status: market.status ?? null,
                acceptingOrders: null,
                resolvedOutcome: market.resolved_outcome ?? null,
                tsMs,
              }),
            ),
          );
          markets += 1;
          tokens += tokenIds.length;
        } catch {
          failed += 1;
        }
      }),
    );
  }

  return { markets, tokens, failed };
}

async function readHotSet(params: {
  redis: RedisClientType;
  key: string;
  maxTokens: number;
  ttlSec: number;
}): Promise<string[]> {
  if (params.maxTokens <= 0) return [];
  const cutoff = Date.now() - params.ttlSec * 1000;
  await params.redis.zRemRangeByScore(params.key, 0, cutoff);
  return params.redis.zRange(params.key, 0, params.maxTokens - 1, {
    REV: true,
  });
}

export async function fetchHotHyperliquidTokenIds(params: {
  redis: RedisClientType;
  hotTokensMax: number;
  hotTokensTtlSec: number;
  hotStreamTokensMax: number;
  hotStreamTokensTtlSec: number;
}): Promise<string[]> {
  const [streamTokens, hotTokens] = await Promise.all([
    readHotSet({
      redis: params.redis,
      key: "hot:tokens:stream:hyperliquid",
      maxTokens: params.hotStreamTokensMax,
      ttlSec: params.hotStreamTokensTtlSec,
    }),
    readHotSet({
      redis: params.redis,
      key: "hot:tokens:hyperliquid",
      maxTokens: params.hotTokensMax,
      ttlSec: params.hotTokensTtlSec,
    }),
  ]);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const tokenId of [...streamTokens, ...hotTokens]) {
    if (seen.has(tokenId)) continue;
    seen.add(tokenId);
    merged.push(tokenId);
  }
  return merged;
}

export function selectHyperliquidBookTargets(params: {
  snapshot: HyperliquidMappedSnapshot;
  hotTokenIds?: string[];
  maxTokens: number;
}): HyperliquidBookTarget[] {
  return selectTopBookTargets(params);
}

export async function selectHyperliquidBookTargetsFromDb(params: {
  pool: Pool;
  hotTokenIds?: string[];
  maxTokens: number;
}): Promise<HyperliquidBookTarget[]> {
  const maxTokens = Math.max(0, Math.trunc(params.maxTokens));
  if (maxTokens <= 0) return [];

  const hotTokenIds = Array.from(
    new Set(
      (params.hotTokenIds ?? []).filter(
        (tokenId) => hyperliquidCoinFromHunchTokenId(tokenId) != null,
      ),
    ),
  );

  const { rows } = await params.pool.query<{
    token_id: string;
    coin: string;
  }>(
    `
      with hot as (
        select token_id, ord
        from unnest($1::text[]) with ordinality as x(token_id, ord)
      )
      select a.hunch_token_id as token_id,
             a.coin
      from hyperliquid_outcome_assets a
      join hyperliquid_outcomes o on o.outcome_id = a.outcome_id
      left join hot h on h.token_id = a.hunch_token_id
      where o.status = 'ACTIVE'
        and a.hunch_token_id like 'hyperliquid:%'
      order by h.ord nulls last,
               a.day_ntl_vlm desc nulls last,
               a.hunch_token_id
      limit $2
    `,
    [hotTokenIds, maxTokens],
  );

  return rows.map((row) => ({
    tokenId: row.token_id,
    coin: row.coin,
  }));
}

async function fetchAndMaybePublishBook(params: {
  client: HyperliquidClient;
  pool?: Pool;
  redis?: RedisClientType;
  target: HyperliquidBookTarget;
  publish: boolean;
}): Promise<"published" | "fetched" | "empty" | "failed"> {
  try {
    const book = await params.client.fetchL2Book(params.target.coin);
    if (!book) return "empty";

    const top = buildBookTopFromL2Book(params.target.tokenId, book);
    if (!top) return "empty";

    if (params.publish) {
      if (!params.pool || !params.redis) return "failed";
      await publishHyperliquidBookTop({
        pool: params.pool,
        redis: params.redis,
        top,
        writeBookSnapshot: true,
      });
      return "published";
    }

    return "fetched";
  } catch {
    return "failed";
  }
}

export async function syncHyperliquidTopBooks(params: {
  client: HyperliquidClient;
  snapshot: HyperliquidMappedSnapshot;
  pool: Pool;
  redis: RedisClientType;
  maxTokens: number;
  concurrency: number;
  hotTokenIds?: string[];
}): Promise<{
  selectedTokens: number;
  fetchedBooks: number;
  publishedBooks: number;
  emptyBooks: number;
  failedBooks: number;
}> {
  const targets = selectHyperliquidBookTargets({
    snapshot: params.snapshot,
    hotTokenIds: params.hotTokenIds,
    maxTokens: params.maxTokens,
  });
  let fetchedBooks = 0;
  let publishedBooks = 0;
  let emptyBooks = 0;
  let failedBooks = 0;

  const concurrency = Math.max(1, Math.trunc(params.concurrency));
  for (const batch of chunkArray(targets, concurrency)) {
    const results = await Promise.all(
      batch.map((target) =>
        fetchAndMaybePublishBook({
          client: params.client,
          pool: params.pool,
          redis: params.redis,
          target,
          publish: true,
        }),
      ),
    );
    for (const result of results) {
      switch (result) {
        case "published":
          fetchedBooks += 1;
          publishedBooks += 1;
          break;
        case "empty":
          emptyBooks += 1;
          break;
        case "failed":
          failedBooks += 1;
          break;
        case "fetched":
          fetchedBooks += 1;
          break;
      }
    }
  }

  return {
    selectedTokens: targets.length,
    fetchedBooks,
    publishedBooks,
    emptyBooks,
    failedBooks,
  };
}

export async function dryRunHyperliquidTopBooks(params: {
  client: HyperliquidClient;
  snapshot: HyperliquidMappedSnapshot;
  maxTokens: number;
  concurrency: number;
  hotTokenIds?: string[];
}): Promise<{
  selectedTokens: number;
  fetchedBooks: number;
  emptyBooks: number;
  failedBooks: number;
}> {
  const targets = selectHyperliquidBookTargets({
    snapshot: params.snapshot,
    hotTokenIds: params.hotTokenIds,
    maxTokens: params.maxTokens,
  });
  let fetchedBooks = 0;
  let emptyBooks = 0;
  let failedBooks = 0;

  const concurrency = Math.max(1, Math.trunc(params.concurrency));
  for (const batch of chunkArray(targets, concurrency)) {
    const results = await Promise.all(
      batch.map((target) =>
        fetchAndMaybePublishBook({
          client: params.client,
          target,
          publish: false,
        }),
      ),
    );
    for (const result of results) {
      switch (result) {
        case "fetched":
          fetchedBooks += 1;
          break;
        case "empty":
          emptyBooks += 1;
          break;
        case "failed":
        case "published":
          failedBooks += 1;
          break;
      }
    }
  }

  return {
    selectedTokens: targets.length,
    fetchedBooks,
    emptyBooks,
    failedBooks,
  };
}
