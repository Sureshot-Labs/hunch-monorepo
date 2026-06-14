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
import { env } from "./env.js";
import type {
  HyperliquidCandle,
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

type JsonRecord = Record<string, unknown>;
type CandleEnrichmentStats = {
  selected: number;
  enriched: number;
  empty: number;
  failed: number;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function updateHyperliquidMetadata(
  row: { metadata?: unknown },
  patch: JsonRecord,
): void {
  const metadata = asRecord(row.metadata);
  const hyperliquid = asRecord(metadata.hyperliquid);
  row.metadata = {
    ...metadata,
    hyperliquid: {
      ...hyperliquid,
      ...patch,
    },
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function candleTimestamp(
  candle: HyperliquidCandle | undefined,
): Date | undefined {
  const timestamp = finiteNonNegative(candle?.t);
  return timestamp != null ? new Date(timestamp) : undefined;
}

function sumCandleVolume(candles: HyperliquidCandle[]): number {
  return candles.reduce(
    (sum, candle) => sum + (finiteNonNegative(candle.v) ?? 0),
    0,
  );
}

function selectCandleTotalMarkets(
  snapshot: HyperliquidMappedSnapshot,
  maxMarkets: number,
): HyperliquidMappedSnapshot["markets"] {
  if (maxMarkets <= 0) return [];
  return [...snapshot.markets]
    .filter((market) =>
      Boolean(
        hyperliquidCoinFromHunchTokenId(
          market.token_yes ?? market.token_no ?? "",
        ),
      ),
    )
    .sort((a, b) => {
      const volume = (b.volume_24h ?? 0) - (a.volume_24h ?? 0);
      if (volume !== 0) return volume;
      return a.id.localeCompare(b.id);
    })
    .slice(0, maxMarkets);
}

function refreshEventCandleTotals(snapshot: HyperliquidMappedSnapshot): void {
  const marketsByEvent = new Map<
    string,
    HyperliquidMappedSnapshot["markets"]
  >();
  for (const market of snapshot.markets) {
    const markets = marketsByEvent.get(market.event_id) ?? [];
    markets.push(market);
    marketsByEvent.set(market.event_id, markets);
  }

  for (const event of snapshot.events) {
    const markets = marketsByEvent.get(event.id) ?? [];
    const volumeTotals = markets
      .map((market) => market.volume_total)
      .filter((value): value is number => value != null);
    const starts = markets
      .map((market) => market.open_time?.getTime())
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    if (volumeTotals.length > 0) {
      event.volume_total = volumeTotals.reduce((sum, value) => sum + value, 0);
    }
    if (starts.length > 0) {
      event.start_date = new Date(Math.min(...starts));
    }
    updateHyperliquidMetadata(event, {
      volumeTotalAvailable: volumeTotals.length > 0,
      volumeTotalSource:
        volumeTotals.length > 0
          ? "sum_child_market_candle_1d_sum_base_volume"
          : undefined,
      openTimeSource:
        starts.length > 0 ? "min_child_first_available_1d_candle" : undefined,
      openTimeConfidence: starts.length > 0 ? "best_effort" : undefined,
    });
  }
}

export async function enrichHyperliquidCandleTotals(params: {
  client: HyperliquidClient;
  snapshot: HyperliquidMappedSnapshot;
  maxMarkets: number;
  concurrency: number;
  nowMs?: number;
}): Promise<CandleEnrichmentStats> {
  const targets = selectCandleTotalMarkets(params.snapshot, params.maxMarkets);
  const stats: CandleEnrichmentStats = {
    selected: targets.length,
    enriched: 0,
    empty: 0,
    failed: 0,
  };
  const concurrency = Math.max(1, Math.trunc(params.concurrency));
  const endTime = params.nowMs ?? Date.now();

  for (const batch of chunkArray(targets, concurrency)) {
    await Promise.all(
      batch.map(async (market) => {
        const coin = hyperliquidCoinFromHunchTokenId(
          market.token_yes ?? market.token_no ?? "",
        );
        if (!coin) {
          stats.empty += 1;
          return;
        }
        try {
          const candles =
            (await params.client.fetchCandleSnapshot({
              coin,
              interval: "1d",
              startTime: 0,
              endTime,
            })) ?? [];
          if (candles.length === 0) {
            stats.empty += 1;
            return;
          }
          const firstActiveCandle =
            candles.find((candle) => (finiteNonNegative(candle.v) ?? 0) > 0) ??
            candles[0];
          const firstCandleAt = candleTimestamp(firstActiveCandle);
          const lastCandleAt = candleTimestamp(candles[candles.length - 1]);
          market.volume_total = sumCandleVolume(candles);
          if (firstCandleAt) market.open_time = firstCandleAt;
          updateHyperliquidMetadata(market, {
            volumeTotalAvailable: true,
            volumeTotalSource: "candle_1d_sum_base_volume",
            volumeTotalConfidence: "best_effort",
            candleVolumeCoin: coin,
            candleVolumeInterval: "1d",
            firstCandleAt: firstCandleAt?.toISOString(),
            lastCandleAt: lastCandleAt?.toISOString(),
            openTimeSource: firstCandleAt
              ? "first_available_1d_candle"
              : undefined,
            openTimeConfidence: firstCandleAt ? "best_effort" : undefined,
          });
          stats.enriched += 1;
        } catch {
          stats.failed += 1;
        }
      }),
    );
  }

  refreshEventCandleTotals(params.snapshot);
  return stats;
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

  if (
    env.syncCandleTotals &&
    !params.dryRun &&
    params.client &&
    !params.fixtureDir &&
    env.candleTotalMaxMarkets > 0
  ) {
    await enrichHyperliquidCandleTotals({
      client: params.client,
      snapshot,
      maxMarkets: env.candleTotalMaxMarkets,
      concurrency: env.candleTotalConcurrency,
    });
  }

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
  const eventsById = new Map(
    params.snapshot.events.map((event) => [event.id, event]),
  );
  let markets = 0;
  let tokens = 0;
  let failed = 0;

  for (const batch of chunkArray(params.snapshot.markets, 25)) {
    await Promise.all(
      batch.map(async (market) => {
        const tokenIds = marketTokenIds(market);
        if (tokenIds.length === 0) return;
        try {
          const event = eventsById.get(market.event_id);
          await publishMarketUpdate({
            redis: params.redis,
            venue: VENUE,
            tokenIds,
            marketId: market.id,
            eventId: market.event_id,
            conditionId: market.condition_id ?? null,
            volumeTotal: market.volume_total ?? null,
            volume24h: market.volume_24h ?? null,
            liquidity: null,
            openInterest: null,
            lastPrice: market.last_price ?? null,
            status: market.status ?? null,
            acceptingOrders: null,
            resolvedOutcome: market.resolved_outcome ?? null,
            resolvedOutcomePct: market.resolved_outcome_pct ?? null,
            eventVolumeTotal: event?.volume_total ?? null,
            eventVolume24h: event?.volume_24h ?? null,
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
  bookMaxAgeSec?: number;
}): Promise<HyperliquidBookTarget[]> {
  const maxTokens = Math.max(0, Math.trunc(params.maxTokens));
  if (maxTokens <= 0) return [];
  const bookMaxAgeSec = Math.max(
    60,
    Math.trunc(params.bookMaxAgeSec ?? 15 * 60),
  );

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
      ),
      latest_book as (
        select distinct on (token_id)
               token_id,
               ts
        from unified_book_top
        where venue = 'hyperliquid'
          and token_id like 'hyperliquid:%'
          and ts >= now() - ($3::int * interval '1 second')
          and (best_bid is not null or best_ask is not null)
        order by token_id, ts desc
      )
      select a.hunch_token_id as token_id,
             a.coin
      from hyperliquid_outcome_assets a
      join hyperliquid_outcomes o on o.outcome_id = a.outcome_id
      join latest_book b on b.token_id = a.hunch_token_id
      left join hot h on h.token_id = a.hunch_token_id
      where o.status = 'ACTIVE'
        and a.hunch_token_id like 'hyperliquid:%'
      order by h.ord nulls last,
               a.day_ntl_vlm desc nulls last,
               a.hunch_token_id
      limit $2
    `,
    [hotTokenIds, maxTokens, bookMaxAgeSec],
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
