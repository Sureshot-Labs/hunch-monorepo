import type { PoolClient } from "pg";

import { ethers } from "ethers";
import { chunkArray, isAbortError, isRpcRateLimit } from "@hunch/shared";

import { pool } from "./db.js";
import { env } from "./env.js";
import { fetchMarketHolderDataBatch } from "./services/holders-core.js";
import { isRecord } from "./lib/type-guards.js";
import { limitlessRequest } from "./services/limitless-client.js";
import { fetchErc1155BalancesByOwner } from "./services/polygon-rpc.js";
import {
  derivePolymarketFunders,
  inspectSafeWalletStrict,
  type PolymarketFunderCandidate,
} from "./services/polymarket-funder.js";
import {
  fetchSolanaTokenBalancesByOwner,
  type SolanaTokenBalance,
} from "./services/solana-rpc.js";
import {
  estimateErc1155BalanceRpcCalls,
  estimateErc1155OwnerTokenPairRpcCalls,
  prefetchPolymarketOwnerBalancesForWallets,
  readPrefetchRpcTelemetry,
  syncPositionsForUserWallet,
  type PrefetchedPolymarketOwnerBalances,
} from "./services/positions-sync.js";
import { markHotTokens } from "./lib/hot-tokens.js";
import { requestPriceRefreshForTokens } from "./lib/price-refresh.js";
import {
  normalizeOutcomeSideForStorage,
  shouldSuppressLegacySideTransitionDelta,
} from "./services/wallet-intel-helpers.js";
import {
  buildSnapshotDeltaTrackableActivitySql,
  buildWalletIntelTrackableMarketSql,
} from "./services/wallet-intel-market-eligibility.js";
import {
  createWalletIntelRetryTelemetry,
  type WalletIntelRetryTelemetry,
} from "./services/wallet-intel-retry.js";
import { refreshWalletMetrics } from "./services/wallet-metrics-refresh.js";
import { runWhaleProfiles } from "./services/whale-profiles.js";
import {
  getIntelPolicyDefaults,
  resolveAiWhaleProfilesPolicy,
  resolveWalletIntelRefreshPolicy,
  type AiWhaleProfilesPolicy,
  type WalletIntelRefreshPolicy,
} from "./services/runtime-policies.js";

type Chain = "polygon" | "base" | "solana";
type Venue = "polymarket" | "limitless" | "kalshi";
type WalletIntelMarketRefreshVenue = "polymarket" | "dflow" | "limitless";
type WalletIntelRefreshTelemetry = {
  holdersPolymarket: WalletIntelRetryTelemetry;
  holdersAlchemyPolygon: WalletIntelRetryTelemetry;
  holdersAlchemyBase: WalletIntelRetryTelemetry;
  holdersLimitlessBalanceVerify: WalletIntelRetryTelemetry;
  holdersSolana: WalletIntelRetryTelemetry;
  holdersSolanaLargestAccounts: WalletIntelRetryTelemetry;
  holdersSolanaOwnerLookup: WalletIntelRetryTelemetry;
  followedPrefetchPolymarket: WalletIntelRetryTelemetry;
  followedPositionsPolymarket: WalletIntelRetryTelemetry;
  followedPositionsLimitless: WalletIntelRetryTelemetry;
  followedPositionsKalshi: WalletIntelRetryTelemetry;
  followedSnapshotPolygon: WalletIntelRetryTelemetry;
  followedSnapshotBase: WalletIntelRetryTelemetry;
  followedSnapshotSolana: WalletIntelRetryTelemetry;
  limitlessPriceBackfill: WalletIntelRetryTelemetry;
};

type RetryableFailureSummary = {
  count: number;
  rateLimited: number;
  aborted: number;
  sampleWallets: string[];
};

let walletIntelRefreshPolicy: WalletIntelRefreshPolicy = getIntelPolicyDefaults(
  "wallet_intel_refresh",
);
let aiWhaleProfilesPolicy: AiWhaleProfilesPolicy =
  getIntelPolicyDefaults("ai_whale_profiles");

const VENUE_CHAIN: Record<string, Chain | null> = {
  polymarket: "polygon",
  limitless: "base",
  kalshi: "solana",
};

const SYSTEM_TAGS = [
  { slug: "fresh", label: "Fresh", tagType: "behavior" },
  { slug: "dormant", label: "Dormant", tagType: "behavior" },
  { slug: "whale", label: "Whale", tagType: "performance" },
] as const;
const REFRESH_ADVISORY_LOCK_KEY_1 = 4207;
const REFRESH_ADVISORY_LOCK_KEY_2 = 1;

type TokenIndexEntry = {
  marketId: string;
  venue: Venue;
  tokenId: string;
  side: "YES" | "NO";
  price: number | null;
};

type LimitlessOrderbook = {
  bids?: Array<{ price?: unknown }>;
  asks?: Array<{ price?: unknown }>;
  lastTradePrice?: unknown;
};

type LimitlessMarketDetail = {
  prices?: Array<unknown>;
  tradeType?: unknown;
};

function createRefreshTelemetry(): WalletIntelRefreshTelemetry {
  return {
    holdersPolymarket: createWalletIntelRetryTelemetry("holders_polymarket"),
    holdersAlchemyPolygon: createWalletIntelRetryTelemetry(
      "holders_alchemy_polygon",
    ),
    holdersAlchemyBase: createWalletIntelRetryTelemetry("holders_alchemy_base"),
    holdersLimitlessBalanceVerify: createWalletIntelRetryTelemetry(
      "holders_limitless_balance_verify",
    ),
    holdersSolana: createWalletIntelRetryTelemetry("holders_solana"),
    holdersSolanaLargestAccounts: createWalletIntelRetryTelemetry(
      "holders_solana_largest_accounts",
    ),
    holdersSolanaOwnerLookup: createWalletIntelRetryTelemetry(
      "holders_solana_owner_lookup",
    ),
    followedPrefetchPolymarket: createWalletIntelRetryTelemetry(
      "followed_prefetch_polymarket",
    ),
    followedPositionsPolymarket: createWalletIntelRetryTelemetry(
      "followed_positions_polymarket",
    ),
    followedPositionsLimitless: createWalletIntelRetryTelemetry(
      "followed_positions_limitless",
    ),
    followedPositionsKalshi: createWalletIntelRetryTelemetry(
      "followed_positions_kalshi",
    ),
    followedSnapshotPolygon: createWalletIntelRetryTelemetry(
      "followed_snapshot_polygon",
    ),
    followedSnapshotBase: createWalletIntelRetryTelemetry(
      "followed_snapshot_base",
    ),
    followedSnapshotSolana: createWalletIntelRetryTelemetry(
      "followed_snapshot_solana",
    ),
    limitlessPriceBackfill: createWalletIntelRetryTelemetry(
      "limitless_price_backfill",
    ),
  };
}

function telemetryBuckets(
  telemetry: WalletIntelRefreshTelemetry,
): WalletIntelRetryTelemetry[] {
  return Object.values(telemetry);
}

function logRefreshTelemetry(telemetry: WalletIntelRefreshTelemetry) {
  console.log(
    "[wallets:intel:refresh] telemetry",
    Object.fromEntries(
      telemetryBuckets(telemetry).map((bucket) => [
        bucket.source,
        {
          attempted: bucket.attempted,
          succeeded: bucket.succeeded,
          skipped: bucket.skipped,
          retried: bucket.retried,
          failed: bucket.failed,
          rateLimited: bucket.rateLimited,
          aborted: bucket.aborted,
          otherErrors: bucket.otherErrors,
          estimatedCalls: bucket.estimatedCalls,
          actualCalls: bucket.actualCalls,
        },
      ]),
    ),
  );
}

function createRetryableFailureSummary(): RetryableFailureSummary {
  return {
    count: 0,
    rateLimited: 0,
    aborted: 0,
    sampleWallets: [],
  };
}

function recordRetryableFailure(
  summary: RetryableFailureSummary,
  wallet: string,
  error: unknown,
): boolean {
  const rateLimited = isRpcRateLimit(error);
  const aborted = isAbortError(error);
  if (!rateLimited && !aborted) return false;

  summary.count += 1;
  if (rateLimited) summary.rateLimited += 1;
  if (aborted) summary.aborted += 1;
  if (
    summary.sampleWallets.length < 3 &&
    !summary.sampleWallets.includes(wallet)
  ) {
    summary.sampleWallets.push(wallet);
  }
  return true;
}

function logRetryableFailureSummary(
  label: string,
  summary: RetryableFailureSummary,
) {
  if (summary.count <= 0) return;
  console.warn(label, {
    count: summary.count,
    rateLimited: summary.rateLimited,
    aborted: summary.aborted,
    sampleWallets: summary.sampleWallets,
  });
}

async function runWithTelemetry<T>(
  bucket: WalletIntelRetryTelemetry,
  fn: () => Promise<T>,
  options?: { countActualCall?: boolean },
): Promise<T> {
  bucket.attempted += 1;
  if (options?.countActualCall !== false) {
    bucket.actualCalls += 1;
  }
  try {
    const result = await fn();
    bucket.succeeded += 1;
    return result;
  } catch (error) {
    bucket.failed += 1;
    if (isAbortError(error)) {
      bucket.aborted += 1;
    } else if (isRpcRateLimit(error)) {
      bucket.rateLimited += 1;
    } else {
      bucket.otherErrors += 1;
    }
    throw error;
  }
}

function markTelemetrySkipped(bucket: WalletIntelRetryTelemetry) {
  bucket.skipped += 1;
  if (bucket.failed > 0) bucket.failed -= 1;
  if (bucket.otherErrors > 0) bucket.otherErrors -= 1;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const size = Math.max(1, Math.trunc(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const run = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, () => run()),
  );
  return results;
}

function parseLimitlessNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeLimitlessPrice(
  value: unknown,
  tradeType: string | null,
): number | null {
  const raw = parseLimitlessNumber(value);
  if (raw == null) return null;
  if (tradeType?.toLowerCase() === "amm") {
    const normalized = raw / 100;
    return normalized >= 0 && normalized <= 1 ? normalized : null;
  }
  return raw;
}

async function fetchLimitlessOrderbook(
  slug: string,
  telemetry?: WalletIntelRetryTelemetry | null,
): Promise<LimitlessOrderbook | null> {
  const res = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}/orderbook`,
    telemetry: telemetry ?? null,
  });
  if (!res.ok) return null;
  const payload = res.payload;
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  return {
    bids: Array.isArray(data.bids)
      ? (data.bids as LimitlessOrderbook["bids"])
      : [],
    asks: Array.isArray(data.asks)
      ? (data.asks as LimitlessOrderbook["asks"])
      : [],
    lastTradePrice: data.lastTradePrice,
  };
}

async function fetchLimitlessMarketDetail(
  slug: string,
  telemetry?: WalletIntelRetryTelemetry | null,
): Promise<LimitlessMarketDetail | null> {
  const res = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}`,
    telemetry: telemetry ?? null,
  });
  if (!res.ok) return null;
  const payload = res.payload;
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  return {
    prices: Array.isArray(data.prices)
      ? (data.prices as LimitlessMarketDetail["prices"])
      : [],
    tradeType: data.tradeType,
  };
}

async function backfillLimitlessPrices(
  client: Queryable,
  markets: Array<{ id: string; venue: string }>,
  telemetry?: WalletIntelRetryTelemetry | null,
): Promise<number> {
  const limitlessIds = markets
    .filter((market) => market.venue === "limitless")
    .map((market) => market.id);
  if (limitlessIds.length === 0) return 0;

  const rows = await client.query<{
    id: string;
    slug: string | null;
    best_bid: number | null;
    best_ask: number | null;
    last_price: number | null;
    trade_type: string | null;
  }>(
    `
      select
        id,
        slug,
        best_bid,
        best_ask,
        last_price,
        metadata->>'tradeType' as trade_type
      from unified_markets
      where venue = 'limitless'
        and id = any($1::text[])
    `,
    [limitlessIds],
  );

  let updated = 0;
  let skipped = 0;
  let fetchCandidates = 0;

  for (const row of rows.rows) {
    const hasPrice =
      row.best_bid != null || row.best_ask != null || row.last_price != null;
    if (hasPrice) {
      skipped += 1;
      continue;
    }
    if (!row.slug) {
      skipped += 1;
      continue;
    }

    let bestBid: number | null = null;
    let bestAsk: number | null = null;
    let lastPrice: number | null = null;

    fetchCandidates += 1;
    if (telemetry) telemetry.estimatedCalls += 1;
    const orderbook = await fetchLimitlessOrderbook(
      row.slug,
      telemetry ?? null,
    );
    if (orderbook) {
      bestBid = parseLimitlessNumber(orderbook.bids?.[0]?.price ?? null);
      bestAsk = parseLimitlessNumber(orderbook.asks?.[0]?.price ?? null);
      lastPrice = parseLimitlessNumber(orderbook.lastTradePrice ?? null);
    }

    if (bestBid == null && bestAsk == null && lastPrice == null) {
      if (telemetry) telemetry.estimatedCalls += 1;
      const detail = await fetchLimitlessMarketDetail(
        row.slug,
        telemetry ?? null,
      );
      if (detail) {
        const tradeType =
          typeof detail.tradeType === "string"
            ? detail.tradeType
            : row.trade_type;
        const yesPrice = normalizeLimitlessPrice(detail.prices?.[0], tradeType);
        if (yesPrice != null) {
          bestBid = yesPrice;
          bestAsk = yesPrice;
          lastPrice = yesPrice;
        }
      }
    }

    if (bestBid == null && bestAsk == null && lastPrice == null) continue;

    await client.query(
      `
        update unified_markets
        set
          best_bid = coalesce($2, best_bid),
          best_ask = coalesce($3, best_ask),
          last_price = coalesce($4, last_price),
          updated_at = now()
        where id = $1
      `,
      [row.id, bestBid, bestAsk, lastPrice],
    );
    updated += 1;
  }

  if (telemetry) telemetry.skipped += skipped;
  if (limitlessIds.length > 0) {
    console.log("[wallets:intel:refresh] limitless price backfill scan", {
      selected: limitlessIds.length,
      scanned: rows.rows.length,
      skipped,
      fetchCandidates,
      updated,
    });
  }

  return updated;
}

function isLimitlessSessionMissing(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("message" in error))
    return false;
  return String((error as { message?: string }).message).includes(
    "Limitless session not found",
  );
}

function bucketDate(date: Date, hours: number): Date {
  const ms = Math.max(hours, 1) * 60 * 60 * 1000;
  const bucket = Math.floor(date.getTime() / ms) * ms;
  return new Date(bucket);
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function parseBackfillSnapshots(): number {
  const clamp = (value: number): number =>
    Math.max(
      0,
      Math.min(Math.floor(value), walletIntelRefreshPolicy.backfillMaxSteps),
    );
  const arg = process.argv.find((entry) => entry.startsWith("--backfill="));
  if (arg) {
    const raw = arg.split("=")[1];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return clamp(parsed);
    }
  }
  const envValue = walletIntelRefreshPolicy.backfillSnapshots ?? 0;
  if (Number.isFinite(envValue) && envValue > 0) {
    return clamp(envValue);
  }
  return 0;
}

type RetentionConfig = {
  snapshotsDays: number | null;
  activityDays: number | null;
  metricsDays: number | null;
  cleanupOnly: boolean;
  skipCleanup: boolean;
};

const WALLET_INTEL_CLEANUP_DELETE_BATCH_SIZE = 25_000;

type WalletIntelCleanupTarget = {
  table:
    | "wallet_position_snapshots"
    | "wallet_activity_events"
    | "wallet_activity_hourly"
    | "wallet_metrics_snapshots";
  timestampColumn: "snapshot_at" | "occurred_at" | "hour_bucket" | "as_of";
};

function parseOptionalArgInt(prefix: string): number | undefined {
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  if (!arg) return undefined;
  const raw = arg.slice(prefix.length);
  if (!raw.length) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

function normalizeRetentionDays(
  value: number | undefined | null,
): number | null {
  if (value == null) return null;
  const asInt = Math.trunc(value);
  return asInt > 0 ? asInt : null;
}

function resolveRetentionDays(
  explicit: number | undefined,
  global: number | undefined,
  envValue: number,
): number | null {
  if (explicit !== undefined) return normalizeRetentionDays(explicit);
  if (global !== undefined) return normalizeRetentionDays(global);
  return normalizeRetentionDays(envValue);
}

function parseRetentionConfig(): RetentionConfig {
  const cleanupOnly = process.argv.includes("--cleanup-only");
  const skipCleanup = process.argv.includes("--skip-cleanup");
  const globalRetention = parseOptionalArgInt("--retention-days=");
  const snapshotsRetention = parseOptionalArgInt("--retention-snapshots=");
  const activityRetention = parseOptionalArgInt("--retention-activity=");
  const metricsRetention = parseOptionalArgInt("--retention-metrics=");

  return {
    cleanupOnly,
    skipCleanup,
    snapshotsDays: resolveRetentionDays(
      snapshotsRetention,
      globalRetention,
      walletIntelRefreshPolicy.retentionDaysSnapshots ?? 0,
    ),
    activityDays: resolveRetentionDays(
      activityRetention,
      globalRetention,
      walletIntelRefreshPolicy.retentionDaysActivity ?? 0,
    ),
    metricsDays: resolveRetentionDays(
      metricsRetention,
      globalRetention,
      walletIntelRefreshPolicy.retentionDaysMetrics ?? 0,
    ),
  };
}

function isZeroEvmWalletAddress(address: string): boolean {
  return address.toLowerCase() === ethers.ZeroAddress;
}

function normalizeAddress(address: string, chain: Chain): string | null {
  const trimmed = address.trim();
  if (chain === "solana") return trimmed;
  const normalized = trimmed.toLowerCase();
  if (isZeroEvmWalletAddress(normalized)) return null;
  return normalized;
}

function normalizeOnchainTokenId(
  venue: Venue,
  tokenId: string | null,
): string | null {
  if (!tokenId) return null;
  const trimmed = tokenId.trim();
  if (!trimmed.length) return null;
  if (venue === "limitless") {
    return trimmed.replace(/^limitless:/, "");
  }
  if (venue === "kalshi") {
    return trimmed.replace(/^kalshi:/, "").replace(/^sol:/, "");
  }
  return trimmed;
}

function capTokenIds(tokenIds: string[], limit: number): string[] {
  if (tokenIds.length <= limit) return tokenIds;
  return tokenIds.slice(0, limit);
}

function toWalletIntelMarketRefreshVenue(
  venue: Venue,
): WalletIntelMarketRefreshVenue {
  return venue === "kalshi" ? "dflow" : venue;
}

async function enqueueWalletIntelMarketRefresh(
  tokenIdsByVenue: Record<Venue, string[]>,
): Promise<void> {
  const counts: Record<Venue, number> = {
    polymarket: tokenIdsByVenue.polymarket.length,
    limitless: tokenIdsByVenue.limitless.length,
    kalshi: tokenIdsByVenue.kalshi.length,
  };

  const venues: Venue[] = ["polymarket", "limitless", "kalshi"];
  await Promise.all(
    venues.map(async (venue) => {
      const tokenIds = tokenIdsByVenue[venue];
      if (!tokenIds.length) return;

      const refreshVenue = toWalletIntelMarketRefreshVenue(venue);
      try {
        await markHotTokens({ tokenIds, venue: refreshVenue });
        await requestPriceRefreshForTokens({
          tokenIds,
          venue: refreshVenue,
        });
      } catch (error) {
        console.warn("[wallets:intel:refresh] market refresh enqueue failed", {
          venue,
          error,
        });
      }
    }),
  );

  if (counts.polymarket || counts.limitless || counts.kalshi) {
    console.log("[wallets:intel:refresh] market refresh queued", counts);
  }
}

function parseMetadataSource(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const source = record.source;
  return typeof source === "string" ? source : null;
}

type Queryable = Pick<PoolClient, "query">;

async function hasWalletActivityBaselineSampleCountColumn(
  client: Queryable,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from pg_attribute
        where attrelid = to_regclass('public.wallet_activity_baseline')
          and attname = 'sample_count'
          and not attisdropped
      )
    `,
  );
  return result.rows[0]?.exists === true;
}

async function acquireRefreshAdvisoryLock(client: Queryable): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    `
      select pg_try_advisory_lock($1::int, $2::int) as locked
    `,
    [REFRESH_ADVISORY_LOCK_KEY_1, REFRESH_ADVISORY_LOCK_KEY_2],
  );
  return result.rows[0]?.locked ?? false;
}

async function releaseRefreshAdvisoryLock(client: Queryable): Promise<void> {
  await client.query(
    `
      select pg_advisory_unlock($1::int, $2::int)
    `,
    [REFRESH_ADVISORY_LOCK_KEY_1, REFRESH_ADVISORY_LOCK_KEY_2],
  );
}

async function ensureSystemTags(
  client: Queryable,
): Promise<Record<string, string>> {
  const values = SYSTEM_TAGS.map((tag) => tag.slug);
  const params: string[] = [];

  for (let i = 0; i < SYSTEM_TAGS.length; i += 1) {
    params.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, true)`);
  }

  await client.query(
    `
      insert into wallet_tags (slug, label, tag_type, is_system)
      values ${params.join(",")}
      on conflict (slug)
      do update set
        label = excluded.label,
        tag_type = excluded.tag_type,
        is_system = true,
        updated_at = now()
    `,
    SYSTEM_TAGS.flatMap((tag) => [tag.slug, tag.label, tag.tagType]),
  );

  const tagRows = await client.query<{ id: string; slug: string }>(
    `
      select id, slug
      from wallet_tags
      where slug = any($1::text[])
    `,
    [values],
  );
  return tagRows.rows.reduce<Record<string, string>>((acc, row) => {
    acc[row.slug] = row.id;
    return acc;
  }, {});
}

function retentionEnabled(config: RetentionConfig): boolean {
  return Boolean(
    config.snapshotsDays || config.activityDays || config.metricsDays,
  );
}

function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

async function deleteOldWalletIntelRowsInBatches(
  client: Queryable,
  target: WalletIntelCleanupTarget,
  cutoff: Date,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await client.query(
      `
        with doomed as (
          select ctid
          from ${target.table}
          where ${target.timestampColumn} < $1
          limit $2
        )
        delete from ${target.table} target_rows
        using doomed
        where target_rows.ctid = doomed.ctid
      `,
      [cutoff, WALLET_INTEL_CLEANUP_DELETE_BATCH_SIZE],
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < WALLET_INTEL_CLEANUP_DELETE_BATCH_SIZE) return total;
  }
}

async function cleanupWalletIntel(
  config: RetentionConfig,
  now: Date,
): Promise<{ snapshots: number; activity: number; metrics: number }> {
  const client = await pool.connect();
  try {
    let snapshots = 0;
    let activity = 0;
    let metrics = 0;

    if (config.snapshotsDays) {
      const cutoff = retentionCutoff(now, config.snapshotsDays);
      snapshots = await deleteOldWalletIntelRowsInBatches(
        client,
        {
          table: "wallet_position_snapshots",
          timestampColumn: "snapshot_at",
        },
        cutoff,
      );
    }

    if (config.activityDays) {
      const cutoff = retentionCutoff(now, config.activityDays);
      activity = await deleteOldWalletIntelRowsInBatches(
        client,
        {
          table: "wallet_activity_events",
          timestampColumn: "occurred_at",
        },
        cutoff,
      );

      await deleteOldWalletIntelRowsInBatches(
        client,
        {
          table: "wallet_activity_hourly",
          timestampColumn: "hour_bucket",
        },
        cutoff,
      );
    }

    if (config.metricsDays) {
      const cutoff = retentionCutoff(now, config.metricsDays);
      metrics = await deleteOldWalletIntelRowsInBatches(
        client,
        {
          table: "wallet_metrics_snapshots",
          timestampColumn: "as_of",
        },
        cutoff,
      );
    }

    return { snapshots, activity, metrics };
  } finally {
    client.release();
  }
}

async function upsertWallet(
  client: Queryable,
  inputs: { address: string; chain: Chain },
): Promise<string> {
  if (inputs.chain !== "solana" && isZeroEvmWalletAddress(inputs.address)) {
    throw new Error("Refusing to persist zero EVM wallet address");
  }
  const result = await client.query<{ id: string }>(
    `
      insert into wallets (address, chain, last_seen_at)
      values ($1, $2, now())
      on conflict (address, chain)
      do update set
        last_seen_at = greatest(wallets.last_seen_at, excluded.last_seen_at),
        updated_at = now()
      returning id
    `,
    [inputs.address, inputs.chain],
  );
  return result.rows[0].id;
}

async function upsertWalletWithMetadata(
  client: Queryable,
  inputs: { address: string; chain: Chain; metadata: Record<string, unknown> },
): Promise<string> {
  if (inputs.chain !== "solana" && isZeroEvmWalletAddress(inputs.address)) {
    throw new Error("Refusing to persist zero EVM wallet address");
  }
  const result = await client.query<{ id: string }>(
    `
      insert into wallets (address, chain, last_seen_at, metadata)
      values ($1, $2, now(), $3)
      on conflict (address, chain)
      do update set
        last_seen_at = greatest(wallets.last_seen_at, excluded.last_seen_at),
        metadata = coalesce(wallets.metadata, '{}'::jsonb) || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [inputs.address, inputs.chain, inputs.metadata],
  );
  return result.rows[0].id;
}

async function upsertWalletVenue(
  client: Queryable,
  walletId: string,
  venue: string,
) {
  await client.query(
    `
      insert into wallet_venues (wallet_id, venue)
      values ($1, $2)
      on conflict (wallet_id, venue)
      do nothing
    `,
    [walletId, venue],
  );
}

async function upsertWalletPositionSnapshot(
  client: Queryable,
  inputs: {
    walletId: string;
    venue: string;
    marketId: string;
    outcomeSide: string | null;
    shares: number;
    sizeUsd: number | null;
    price: number | null;
    metadata: Record<string, unknown>;
    snapshotAt: Date;
  },
) {
  await client.query(
    `
      insert into wallet_position_snapshots (
        wallet_id,
        venue,
        market_id,
        outcome_side,
        shares,
        size_usd,
        price,
        metadata,
        snapshot_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (wallet_id, venue, market_id, outcome_side, snapshot_at)
      do update set
        shares = excluded.shares,
        size_usd = excluded.size_usd,
        price = excluded.price,
        metadata = excluded.metadata
    `,
    [
      inputs.walletId,
      inputs.venue,
      inputs.marketId,
      normalizeOutcomeSideForStorage(inputs.outcomeSide),
      inputs.shares,
      inputs.sizeUsd,
      inputs.price,
      inputs.metadata,
      inputs.snapshotAt,
    ],
  );
}

async function clearSelectedMarketHolderSnapshots(
  client: Queryable,
  inputs: {
    marketIds: string[];
    snapshotAt: Date;
  },
): Promise<number> {
  const marketIds = Array.from(new Set(inputs.marketIds));
  if (marketIds.length === 0) return 0;

  const { rowCount } = await client.query(
    `
      delete from wallet_position_snapshots
      where snapshot_at = $1
        and market_id = any($2::text[])
        and coalesce(metadata->>'source', '') in ('polymarket', 'alchemy', 'solana')
    `,
    [inputs.snapshotAt, marketIds],
  );
  return rowCount ?? 0;
}

async function upsertWalletActivityEvent(
  client: Queryable,
  inputs: {
    walletId: string;
    venue: string;
    marketId: string;
    outcomeSide: string | null;
    action: string | null;
    deltaShares: number | null;
    sizeUsd: number | null;
    price: number | null;
    activityType: "delta" | "trade" | "holder";
    source: string | null;
    metadata: Record<string, unknown>;
    occurredAt: Date;
  },
) {
  await client.query(
    `
      insert into wallet_activity_events (
        wallet_id,
        venue,
        market_id,
        outcome_side,
        action,
        delta_shares,
        size_usd,
        price,
        activity_type,
        source,
        metadata,
        occurred_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      on conflict (
        wallet_id,
        venue,
        market_id,
        outcome_side,
        activity_type,
        occurred_at
      )
      do update set
        action = excluded.action,
        delta_shares = excluded.delta_shares,
        size_usd = excluded.size_usd,
        price = excluded.price,
        source = excluded.source,
        metadata = excluded.metadata
    `,
    [
      inputs.walletId,
      inputs.venue,
      inputs.marketId,
      normalizeOutcomeSideForStorage(inputs.outcomeSide),
      inputs.action,
      inputs.deltaShares,
      inputs.sizeUsd,
      inputs.price,
      inputs.activityType,
      inputs.source,
      inputs.metadata,
      inputs.occurredAt,
    ],
  );
}

async function snapshotFollowedWalletHoldingsEvm(
  client: Queryable,
  inputs: {
    walletId: string;
    address: string;
    venue: Venue;
    rpcUrl: string;
    rpcTimeoutMs: number;
    contractAddress: string;
    tokenIds: string[];
    tokenIndex: Map<string, TokenIndexEntry>;
    occurredAt: Date;
    prefetchedBalances?: Array<{ tokenId: string; size: string }> | null;
  },
): Promise<number> {
  if (inputs.tokenIds.length === 0) return 0;
  const trackedTokenIds = new Set(inputs.tokenIds);

  const snapshotTokenBalances = async (
    tokenBalances: Array<{ tokenId: string; size: string }>,
  ) => {
    let inserted = 0;
    for (const balance of tokenBalances) {
      if (!trackedTokenIds.has(balance.tokenId)) continue;
      const entry = inputs.tokenIndex.get(balance.tokenId);
      if (!entry) continue;

      const shares = Number(balance.size);
      if (!Number.isFinite(shares) || shares <= 0) continue;

      const sizeUsd =
        entry.price != null ? Number((shares * entry.price).toFixed(6)) : null;

      await upsertWalletVenue(client, inputs.walletId, entry.venue);

      await upsertWalletPositionSnapshot(client, {
        walletId: inputs.walletId,
        venue: entry.venue,
        marketId: entry.marketId,
        outcomeSide: entry.side,
        shares,
        sizeUsd,
        price: entry.price,
        metadata: {
          source: "followed_wallet",
          tokenId: entry.tokenId,
          onchainTokenId: balance.tokenId,
          shares,
        },
        snapshotAt: inputs.occurredAt,
      });

      inserted += 1;
    }
    return inserted;
  };

  if (inputs.prefetchedBalances) {
    return snapshotTokenBalances(inputs.prefetchedBalances);
  }

  const chunkSize = 200;
  let inserted = 0;

  for (let i = 0; i < inputs.tokenIds.length; i += chunkSize) {
    const chunk = inputs.tokenIds.slice(i, i + chunkSize);
    const balances = await fetchErc1155BalancesByOwner({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.rpcTimeoutMs,
      contractAddress: inputs.contractAddress,
      owner: inputs.address,
      tokenIds: chunk,
    });
    const chunkBalances: Array<{ tokenId: string; size: string }> = [];
    for (const tokenId of chunk) {
      const balance = balances.get(tokenId) ?? 0n;
      if (balance <= 0n) continue;
      chunkBalances.push({
        tokenId,
        size: ethers.formatUnits(balance, 6),
      });
    }
    inserted += await snapshotTokenBalances(chunkBalances);
  }

  return inserted;
}

type FollowedWalletRow = {
  user_id: string;
  wallet_id: string;
  address: string;
  chain: Chain;
};

type FollowedCollectionResult = {
  processed: number;
  rowInserts: number;
  activityRows: number;
};

async function collectFollowedWalletSnapshotRows(
  client: Queryable,
  inputs: {
    followedWallets: FollowedWalletRow[];
    snapshotAt: Date;
    tokenIdsByVenue: Record<Venue, string[]>;
    tokenIndexByVenue: Record<Venue, Map<string, TokenIndexEntry>>;
    telemetry: WalletIntelRefreshTelemetry;
    followedFetchConcurrency: number;
    touchedWalletIds: Set<string>;
    poolClient: typeof pool;
  },
): Promise<FollowedCollectionResult> {
  const followedByChain = { polygon: 0, base: 0, solana: 0 };
  for (const followed of inputs.followedWallets) {
    followedByChain[followed.chain] += 1;
  }

  const estPolygonHoldingsRpcCalls = estimateErc1155OwnerTokenPairRpcCalls(
    followedByChain.polygon,
    inputs.tokenIdsByVenue.polymarket,
  );
  const estBaseHoldingsRpcCalls = estimateErc1155BalanceRpcCalls(
    followedByChain.base,
    inputs.tokenIdsByVenue.limitless,
  );
  const estSolanaHoldingsRpcCalls =
    inputs.tokenIdsByVenue.kalshi.length > 0 ? followedByChain.solana : 0;
  inputs.telemetry.followedSnapshotPolygon.estimatedCalls +=
    followedByChain.polygon;
  inputs.telemetry.followedSnapshotBase.estimatedCalls +=
    estBaseHoldingsRpcCalls;
  inputs.telemetry.followedSnapshotSolana.estimatedCalls +=
    estSolanaHoldingsRpcCalls;
  inputs.telemetry.followedPositionsPolymarket.estimatedCalls +=
    followedByChain.polygon;
  inputs.telemetry.followedPositionsLimitless.estimatedCalls +=
    followedByChain.base;
  inputs.telemetry.followedPositionsKalshi.estimatedCalls +=
    followedByChain.solana;

  const followedPrefetchPolymarketRetryable = createRetryableFailureSummary();
  const followedPositionsPolymarketRetryable = createRetryableFailureSummary();
  const followedSnapshotPolygonRetryable = createRetryableFailureSummary();
  const followedSnapshotBaseRetryable = createRetryableFailureSummary();

  console.log("[wallets:intel:refresh] followed fanout", {
    followed: inputs.followedWallets.length,
    followedByChain,
    tokenIds: {
      polymarket: inputs.tokenIdsByVenue.polymarket.length,
      limitless: inputs.tokenIdsByVenue.limitless.length,
      kalshi: inputs.tokenIdsByVenue.kalshi.length,
    },
    holdingsRpcEstimate: {
      polymarketTrackedOnly: estPolygonHoldingsRpcCalls,
      base: estBaseHoldingsRpcCalls,
      solana: estSolanaHoldingsRpcCalls,
    },
    concurrency: {
      followedFetch: inputs.followedFetchConcurrency,
    },
  });

  const prefetchedSolanaBalances = new Map<
    string,
    SolanaTokenBalance[] | null
  >();
  const prefetchedPolymarketBalances = new Map<
    string,
    PrefetchedPolymarketOwnerBalances | null
  >();

  const solanaFollowedWallets = inputs.followedWallets.filter(
    (row) => row.chain === "solana",
  );
  if (
    solanaFollowedWallets.length > 0 &&
    inputs.tokenIdsByVenue.kalshi.length > 0
  ) {
    await mapWithConcurrency(
      solanaFollowedWallets,
      inputs.followedFetchConcurrency,
      async (followed) => {
        try {
          const balances = await runWithTelemetry(
            inputs.telemetry.followedSnapshotSolana,
            () =>
              fetchSolanaTokenBalancesByOwner({
                rpcUrls: env.solanaRpcUrls,
                timeoutMs: env.solanaRpcTimeoutMs,
                owner: followed.address,
                includeToken2022: true,
              }),
          );
          prefetchedSolanaBalances.set(followed.wallet_id, balances);
        } catch (error) {
          prefetchedSolanaBalances.set(followed.wallet_id, null);
          console.error(
            "[wallets:intel:refresh] prefetched solana balances failed",
            { wallet: followed.address },
            error,
          );
        }
      },
    );
  }

  const polygonFollowedWallets = inputs.followedWallets.filter(
    (row) => row.chain === "polygon",
  );
  if (polygonFollowedWallets.length > 0) {
    const byUser = new Map<string, FollowedWalletRow[]>();
    for (const followed of polygonFollowedWallets) {
      const rows = byUser.get(followed.user_id) ?? [];
      rows.push(followed);
      byUser.set(followed.user_id, rows);
    }

    await mapWithConcurrency(
      Array.from(byUser.entries()),
      inputs.followedFetchConcurrency,
      async ([userId, followedRows]) => {
        try {
          const prefetched = await runWithTelemetry(
            inputs.telemetry.followedPrefetchPolymarket,
            () =>
              prefetchPolymarketOwnerBalancesForWallets(inputs.poolClient, {
                userId,
                walletAddresses: followedRows.map((row) => row.address),
                trackedTokenIds: inputs.tokenIdsByVenue.polymarket,
              }),
            { countActualCall: false },
          );
          inputs.telemetry.followedPrefetchPolymarket.estimatedCalls +=
            prefetched.rpcCallEstimate;
          inputs.telemetry.followedPrefetchPolymarket.actualCalls +=
            prefetched.rpcCallCount;
          for (const followed of followedRows) {
            prefetchedPolymarketBalances.set(followed.wallet_id, prefetched);
          }
        } catch (error) {
          for (const followed of followedRows) {
            prefetchedPolymarketBalances.set(followed.wallet_id, null);
          }
          const rpcTelemetry = readPrefetchRpcTelemetry(error);
          inputs.telemetry.followedPrefetchPolymarket.estimatedCalls +=
            rpcTelemetry.estimatedCalls;
          inputs.telemetry.followedPrefetchPolymarket.actualCalls +=
            rpcTelemetry.actualCalls;
          const sampleWallet = followedRows[0]?.address ?? userId;
          if (
            !recordRetryableFailure(
              followedPrefetchPolymarketRetryable,
              sampleWallet,
              error,
            )
          ) {
            console.error(
              "[wallets:intel:refresh] prefetched polymarket balances failed",
              { wallets: followedRows.map((row) => row.address) },
              error,
            );
          }
        }
      },
    );
  }

  let processed = 0;
  let rowInserts = 0;
  let activityRows = 0;

  for (const followed of inputs.followedWallets) {
    processed += 1;
    if (followed.chain === "polygon") {
      const normalizedFollowedAddress = normalizeAddress(
        followed.address,
        "polygon",
      );
      if (!normalizedFollowedAddress) continue;
      const prefetchedPolymarket =
        prefetchedPolymarketBalances.get(followed.wallet_id) ?? null;

      try {
        await runWithTelemetry(
          inputs.telemetry.followedPositionsPolymarket,
          () =>
            syncPositionsForUserWallet(inputs.poolClient, {
              userId: followed.user_id,
              walletAddress: followed.address,
              venue: "polymarket",
              positionScope: "followed",
              prefetchedPolymarketBalances: prefetchedPolymarket,
            }),
        );
      } catch (error) {
        if (
          !recordRetryableFailure(
            followedPositionsPolymarketRetryable,
            followed.address,
            error,
          )
        ) {
          console.error(
            "[wallets:intel:refresh] polymarket positions sync failed",
            error,
          );
        }
      }

      try {
        const inserted = await runWithTelemetry(
          inputs.telemetry.followedSnapshotPolygon,
          () =>
            snapshotFollowedWalletHoldingsEvm(client, {
              walletId: followed.wallet_id,
              address: normalizedFollowedAddress,
              venue: "polymarket",
              rpcUrl: env.polygonRpcUrl,
              rpcTimeoutMs: env.polygonRpcTimeoutMs,
              contractAddress: env.polymarketConditionalTokensAddress,
              tokenIds: inputs.tokenIdsByVenue.polymarket,
              tokenIndex: inputs.tokenIndexByVenue.polymarket,
              occurredAt: inputs.snapshotAt,
              prefetchedBalances:
                prefetchedPolymarket?.balancesByOwner.get(
                  followed.address.toLowerCase(),
                ) ?? null,
            }),
        );
        if (inserted > 0) {
          rowInserts += inserted;
          inputs.touchedWalletIds.add(followed.wallet_id);
          activityRows += inserted;
        }
      } catch (error) {
        if (
          !recordRetryableFailure(
            followedSnapshotPolygonRetryable,
            followed.address,
            error,
          )
        ) {
          console.error(
            "[wallets:intel:refresh] polymarket followed snapshot failed",
            { wallet: followed.address },
            error,
          );
        }
      }

      const positionsInserted = await snapshotFollowedWalletPositions(client, {
        userId: followed.user_id,
        walletId: followed.wallet_id,
        walletAddress: followed.address,
        venue: "polymarket",
        occurredAt: inputs.snapshotAt,
      });
      if (positionsInserted > 0) {
        rowInserts += positionsInserted;
        inputs.touchedWalletIds.add(followed.wallet_id);
        activityRows += positionsInserted;
      }
      continue;
    }

    if (followed.chain === "base") {
      const normalizedFollowedAddress = normalizeAddress(
        followed.address,
        "base",
      );
      if (!normalizedFollowedAddress) continue;
      try {
        await runWithTelemetry(
          inputs.telemetry.followedPositionsLimitless,
          () =>
            syncPositionsForUserWallet(inputs.poolClient, {
              userId: followed.user_id,
              walletAddress: followed.address,
              venue: "limitless",
              positionScope: "followed",
            }),
        );
      } catch (error) {
        if (isLimitlessSessionMissing(error)) {
          markTelemetrySkipped(inputs.telemetry.followedPositionsLimitless);
          console.info(
            "[wallets:intel:refresh] limitless positions sync skipped (no session)",
            { wallet: followed.address },
          );
        } else {
          console.error(
            "[wallets:intel:refresh] limitless positions sync failed",
            error,
          );
        }
      }

      try {
        const inserted = await runWithTelemetry(
          inputs.telemetry.followedSnapshotBase,
          () =>
            snapshotFollowedWalletHoldingsEvm(client, {
              walletId: followed.wallet_id,
              address: normalizedFollowedAddress,
              venue: "limitless",
              rpcUrl: env.baseRpcUrl,
              rpcTimeoutMs: env.baseRpcTimeoutMs,
              contractAddress: env.limitlessConditionalTokensAddress,
              tokenIds: inputs.tokenIdsByVenue.limitless,
              tokenIndex: inputs.tokenIndexByVenue.limitless,
              occurredAt: inputs.snapshotAt,
            }),
        );
        if (inserted > 0) {
          rowInserts += inserted;
          inputs.touchedWalletIds.add(followed.wallet_id);
          activityRows += inserted;
        }
      } catch (error) {
        if (
          !recordRetryableFailure(
            followedSnapshotBaseRetryable,
            followed.address,
            error,
          )
        ) {
          console.error(
            "[wallets:intel:refresh] limitless followed snapshot failed",
            { wallet: followed.address },
            error,
          );
        }
      }

      const positionsInserted = await snapshotFollowedWalletPositions(client, {
        userId: followed.user_id,
        walletId: followed.wallet_id,
        walletAddress: followed.address,
        venue: "limitless",
        occurredAt: inputs.snapshotAt,
      });
      if (positionsInserted > 0) {
        rowInserts += positionsInserted;
        inputs.touchedWalletIds.add(followed.wallet_id);
        activityRows += positionsInserted;
      }
      continue;
    }

    if (followed.chain === "solana") {
      try {
        await runWithTelemetry(inputs.telemetry.followedPositionsKalshi, () =>
          syncPositionsForUserWallet(inputs.poolClient, {
            userId: followed.user_id,
            walletAddress: followed.address,
            venue: "kalshi",
            positionScope: "followed",
            prefetchedSolanaBalances:
              prefetchedSolanaBalances.get(followed.wallet_id) ?? null,
          }),
        );
      } catch (error) {
        console.error(
          "[wallets:intel:refresh] kalshi positions sync failed",
          error,
        );
      }

      const inserted = await snapshotFollowedWalletHoldingsSolana(client, {
        walletId: followed.wallet_id,
        address: followed.address,
        tokenMints: inputs.tokenIdsByVenue.kalshi,
        tokenIndex: inputs.tokenIndexByVenue.kalshi,
        occurredAt: inputs.snapshotAt,
        balances: prefetchedSolanaBalances.get(followed.wallet_id) ?? null,
        telemetry: inputs.telemetry.followedSnapshotSolana,
      });
      if (inserted > 0) {
        rowInserts += inserted;
        inputs.touchedWalletIds.add(followed.wallet_id);
        activityRows += inserted;
      }

      const positionsInserted = await snapshotFollowedWalletPositions(client, {
        userId: followed.user_id,
        walletId: followed.wallet_id,
        walletAddress: followed.address,
        venue: "kalshi",
        occurredAt: inputs.snapshotAt,
      });
      if (positionsInserted > 0) {
        rowInserts += positionsInserted;
        inputs.touchedWalletIds.add(followed.wallet_id);
        activityRows += positionsInserted;
      }
    }
  }

  logRetryableFailureSummary(
    "[wallets:intel:refresh] polymarket followed prefetch throttled",
    followedPrefetchPolymarketRetryable,
  );
  logRetryableFailureSummary(
    "[wallets:intel:refresh] polymarket followed positions throttled",
    followedPositionsPolymarketRetryable,
  );
  logRetryableFailureSummary(
    "[wallets:intel:refresh] polymarket followed snapshot throttled",
    followedSnapshotPolygonRetryable,
  );
  logRetryableFailureSummary(
    "[wallets:intel:refresh] limitless followed snapshot throttled",
    followedSnapshotBaseRetryable,
  );

  return {
    processed,
    rowInserts,
    activityRows,
  };
}

async function refreshTouchedWalletArtifacts(
  client: Queryable,
  inputs: {
    touchedWalletIds: Set<string>;
    selectedMarketIds: string[];
    snapshotAt: Date;
    tagIds: Record<string, string>;
  },
): Promise<{ deltaInserts: number; deltaUpdates: number }> {
  const walletIds = Array.from(inputs.touchedWalletIds);
  const stageCounts = {
    wallets: walletIds.length,
    markets: inputs.selectedMarketIds.length,
  };

  const deltaResult = await runWalletIntelArtifactStage(
    "snapshotDeltas",
    stageCounts,
    () =>
      applySnapshotDeltas(client, {
        walletIds,
        occurredAt: inputs.snapshotAt,
        marketIds: inputs.selectedMarketIds,
      }),
  );

  await runWalletIntelArtifactStage("walletMetrics", stageCounts, () =>
    refreshWalletMetrics(client, {
      walletIds,
      asOf: inputs.snapshotAt,
      logPrefix: "[wallets:intel:refresh]",
    }),
  );

  await runWalletIntelArtifactStage("systemTags", stageCounts, () =>
    refreshSystemTags(client, {
      walletIds,
      tagIds: inputs.tagIds,
      freshDays: walletIntelRefreshPolicy.freshDays,
      dormantDays: walletIntelRefreshPolicy.dormantDays,
      whaleUsd: walletIntelRefreshPolicy.whaleUsd,
      whaleUsdSolana: walletIntelRefreshPolicy.whaleUsdSolana,
      asOf: inputs.snapshotAt,
    }),
  );

  const whaleRows = await client.query<{ wallet_id: string }>(
    `
      select tm.wallet_id
      from wallet_tag_map tm
      join wallet_tags t on t.id = tm.tag_id and t.slug = 'whale'
    `,
  );
  const aggregateWalletIds = Array.from(
    new Set([...walletIds, ...whaleRows.rows.map((row) => row.wallet_id)]),
  );

  const activityLookbackDays = 365;
  const activitySince = new Date(
    inputs.snapshotAt.getTime() - activityLookbackDays * 24 * 60 * 60 * 1000,
  );
  const aggregateStageCounts = {
    wallets: aggregateWalletIds.length,
    markets: inputs.selectedMarketIds.length,
  };

  await runWalletIntelArtifactStage(
    "activityBaseline",
    aggregateStageCounts,
    () =>
      refreshWalletActivityBaseline(client, {
        walletIds: aggregateWalletIds,
        asOf: inputs.snapshotAt,
        windowDays: 30,
      }),
  );
  await runWalletIntelArtifactStage(
    "activityHourly",
    aggregateStageCounts,
    () =>
      refreshWalletActivityHourly(client, {
        walletIds: aggregateWalletIds,
        since: activitySince,
        enteredLateHours: 24,
      }),
  );
  await runWalletIntelArtifactStage(
    "positionExposure",
    aggregateStageCounts,
    () =>
      refreshWalletPositionExposure(client, {
        walletIds: aggregateWalletIds,
        asOf: inputs.snapshotAt,
      }),
  );
  await runWalletIntelArtifactStage(
    "inferredOutcomes",
    aggregateStageCounts,
    () =>
      refreshWalletInferredOutcomes(client, {
        walletIds: aggregateWalletIds,
      }),
  );

  return {
    deltaInserts: deltaResult.inserts,
    deltaUpdates: deltaResult.updates,
  };
}

async function runWalletIntelArtifactStage<T>(
  stage: string,
  counts: { wallets?: number; markets?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  console.log("[wallets:intel:refresh] artifact stage start", {
    stage,
    ...counts,
  });
  try {
    const result = await fn();
    console.log("[wallets:intel:refresh] artifact stage done", {
      stage,
      durationMs: Date.now() - startedAt,
      ...counts,
    });
    return result;
  } catch (error) {
    console.error(
      "[wallets:intel:refresh] artifact stage failed",
      {
        stage,
        durationMs: Date.now() - startedAt,
        ...counts,
      },
      error,
    );
    throw error;
  }
}

async function snapshotFollowedWalletHoldingsSolana(
  client: Queryable,
  inputs: {
    walletId: string;
    address: string;
    tokenMints: string[];
    tokenIndex: Map<string, TokenIndexEntry>;
    occurredAt: Date;
    balances?: SolanaTokenBalance[] | null;
    telemetry?: WalletIntelRetryTelemetry | null;
  },
): Promise<number> {
  if (inputs.tokenMints.length === 0) return 0;
  const targetMints = new Set(
    inputs.tokenMints
      .map((mint) => mint.trim())
      .filter((mint) => mint.length > 0),
  );
  if (targetMints.size === 0) return 0;
  let balances: Awaited<ReturnType<typeof fetchSolanaTokenBalancesByOwner>>;
  try {
    balances =
      inputs.balances ??
      (await runWithTelemetry(
        inputs.telemetry ?? createWalletIntelRetryTelemetry("solana_snapshot"),
        () =>
          fetchSolanaTokenBalancesByOwner({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            owner: inputs.address,
            includeToken2022: true,
          }),
      ));
  } catch (error) {
    console.error(
      "[wallets:intel:refresh] solana balances fetch failed",
      { wallet: inputs.address, mints: targetMints.size },
      error,
    );
    return 0;
  }

  let inserted = 0;

  for (const balance of balances) {
    const mint = balance.mint;
    if (!targetMints.has(mint)) continue;
    const amount = Number(balance.uiAmountString);
    const entry = inputs.tokenIndex.get(mint);
    if (!entry) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const sizeUsd =
      entry.price != null ? Number((amount * entry.price).toFixed(6)) : null;

    await upsertWalletVenue(client, inputs.walletId, entry.venue);

    await upsertWalletPositionSnapshot(client, {
      walletId: inputs.walletId,
      venue: entry.venue,
      marketId: entry.marketId,
      outcomeSide: entry.side,
      shares: amount,
      sizeUsd,
      price: entry.price,
      metadata: {
        source: "followed_wallet",
        tokenId: entry.tokenId,
        onchainTokenId: mint,
        shares: amount,
      },
      snapshotAt: inputs.occurredAt,
    });

    inserted += 1;
  }

  return inserted;
}

function resolveMidPrice(
  bid: string | null,
  ask: string | null,
  mid: string | null,
): number | null {
  const bidNum = bid ? Number(bid) : null;
  const askNum = ask ? Number(ask) : null;
  const midNum = mid ? Number(mid) : null;
  if (midNum != null && Number.isFinite(midNum)) return midNum;
  if (Number.isFinite(bidNum ?? NaN) && Number.isFinite(askNum ?? NaN)) {
    return ((bidNum ?? 0) + (askNum ?? 0)) / 2;
  }
  if (bidNum != null && Number.isFinite(bidNum)) return bidNum;
  if (askNum != null && Number.isFinite(askNum)) return askNum;
  return null;
}

async function snapshotFollowedWalletPositions(
  client: Queryable,
  inputs: {
    userId: string;
    walletId: string;
    walletAddress: string;
    venue: Venue;
    occurredAt: Date;
  },
): Promise<number> {
  const { rows } = await client.query<{
    token_id: string;
    size: string;
    market_id: string | null;
    outcome_side: "YES" | "NO" | null;
  }>(
    `
      select p.token_id,
             p.size,
             ut.market_id,
             ut.side as outcome_side
      from positions p
      left join unified_tokens ut on ut.token_id = p.token_id
      where p.user_id = $1
        and p.wallet_address = $2
        and p.venue = $3
        and p.position_scope = 'followed'
        and p.size > 0
        and (p.is_hidden is null or p.is_hidden = false)
    `,
    [inputs.userId, inputs.walletAddress, inputs.venue],
  );

  if (rows.length === 0) return 0;
  const tokenIds = rows.map((row) => row.token_id);
  const { rows: marks } = await client.query<{
    token_id: string;
    best_bid: string | null;
    best_ask: string | null;
    mid: string | null;
  }>(
    `
      select
        token_id,
        best_bid,
        best_ask,
        mid
      from unified_token_top_latest
      where token_id = any($1::text[])
    `,
    [tokenIds],
  );
  const markMap = new Map<string, number | null>();
  for (const row of marks) {
    markMap.set(
      row.token_id,
      resolveMidPrice(row.best_bid, row.best_ask, row.mid),
    );
  }

  let inserted = 0;
  for (const row of rows) {
    if (!row.market_id) continue;
    const size = Number(row.size);
    if (!Number.isFinite(size) || size <= 0) continue;
    const price = markMap.get(row.token_id) ?? null;
    const sizeUsd = price != null ? Number((size * price).toFixed(6)) : null;

    await upsertWalletVenue(client, inputs.walletId, inputs.venue);

    await upsertWalletPositionSnapshot(client, {
      walletId: inputs.walletId,
      venue: inputs.venue,
      marketId: row.market_id,
      outcomeSide: row.outcome_side,
      shares: size,
      sizeUsd,
      price,
      metadata: {
        source: "followed_positions",
        tokenId: row.token_id,
        size,
      },
      snapshotAt: inputs.occurredAt,
    });
    inserted += 1;
  }

  return inserted;
}

async function filterTrackableMarketIds(
  client: Queryable,
  inputs: {
    marketIds: string[];
    asOf: Date;
  },
): Promise<string[]> {
  if (inputs.marketIds.length === 0) return [];
  const { rows } = await client.query<{ id: string }>(
    `
      select m.id
      from unified_markets m
      left join unified_events e on e.id = m.event_id
      where m.id = any($1::text[])
        and ${buildWalletIntelTrackableMarketSql({
          marketAlias: "m",
          eventAlias: "e",
          asOfSql: "$2::timestamptz",
        })}
    `,
    [inputs.marketIds, inputs.asOf],
  );
  return rows.map((row) => row.id);
}

type SnapshotDeltaRow = {
  wallet_id: string;
  venue: string;
  market_id: string;
  outcome_side: string | null;
  shares: string | null;
  price: string | null;
  metadata: unknown;
};

type SnapshotDeltaMarketKey = {
  wallet_id: string;
  venue: string;
  market_id: string;
};

const SNAPSHOT_DELTA_WALLET_CHUNK_SIZE = 25;
const SNAPSHOT_DELTA_MARKET_KEY_CHUNK_SIZE = 250;
const SNAPSHOT_DELTA_OUTCOME_SIDES = ["", "YES", "NO"] as const;
const WALLET_POSITION_EXPOSURE_CHUNK_SIZE = 50;

async function fetchPreviousSnapshotDeltaRows(
  client: Queryable,
  inputs: {
    currentMarketKeys: SnapshotDeltaMarketKey[];
    occurredAt: Date;
  },
): Promise<SnapshotDeltaRow[]> {
  const rows: SnapshotDeltaRow[] = [];

  for (const marketKeyChunk of chunkArray(
    inputs.currentMarketKeys,
    SNAPSHOT_DELTA_MARKET_KEY_CHUNK_SIZE,
  )) {
    if (!marketKeyChunk.length) continue;
    const result = await client.query<SnapshotDeltaRow>(
      `
        with current_markets as (
          select distinct
            x.wallet_id,
            x.venue,
            x.market_id
          from unnest($1::uuid[], $2::text[], $3::text[]) as x(
            wallet_id,
            venue,
            market_id
          )
        ),
        outcome_sides as (
          select unnest($5::text[]) as outcome_side
        )
        select
          prev.wallet_id,
          prev.venue,
          prev.market_id,
          prev.outcome_side,
          prev.shares,
          prev.price,
          prev.metadata
        from current_markets cm
        cross join outcome_sides os
        join lateral (
          select
            ws.wallet_id,
            ws.venue,
            ws.market_id,
            ws.outcome_side,
            ws.shares,
            ws.price,
            ws.metadata
          from wallet_position_snapshots ws
          where ws.wallet_id = cm.wallet_id
            and ws.venue = cm.venue
            and ws.market_id = cm.market_id
            and ws.outcome_side = os.outcome_side
            and ws.snapshot_at < $4
          order by ws.snapshot_at desc
          limit 1
        ) prev on true
      `,
      [
        marketKeyChunk.map((row) => row.wallet_id),
        marketKeyChunk.map((row) => row.venue),
        marketKeyChunk.map((row) => row.market_id),
        inputs.occurredAt,
        SNAPSHOT_DELTA_OUTCOME_SIDES,
      ],
    );
    rows.push(...result.rows);
  }

  return rows;
}

async function applySnapshotDeltas(
  client: Queryable,
  inputs: {
    walletIds: string[];
    occurredAt: Date;
    marketIds: string[];
  },
): Promise<{ inserts: number; updates: number }> {
  const walletIds = Array.from(new Set(inputs.walletIds));
  if (walletIds.length === 0 || inputs.marketIds.length === 0) {
    return { inserts: 0, updates: 0 };
  }

  const eligibleMarketIds = await filterTrackableMarketIds(client, {
    marketIds: inputs.marketIds,
    asOf: inputs.occurredAt,
  });
  if (eligibleMarketIds.length === 0) {
    return { inserts: 0, updates: 0 };
  }

  let updates = 0;

  for (const walletChunk of chunkArray(
    walletIds,
    SNAPSHOT_DELTA_WALLET_CHUNK_SIZE,
  )) {
    const currentRows = await client.query<SnapshotDeltaRow>(
      `
      select wallet_id, venue, market_id, outcome_side, shares, price, metadata
      from wallet_position_snapshots
      where wallet_id = any($1::uuid[])
        and snapshot_at = $2
        and market_id = any($3::text[])
    `,
      [walletChunk, inputs.occurredAt, eligibleMarketIds],
    );

    if (currentRows.rows.length === 0) continue;

    const currentMarketKeysByKey = new Map<string, SnapshotDeltaMarketKey>();
    for (const row of currentRows.rows) {
      const key = `${row.wallet_id}|${row.venue}|${row.market_id}`;
      if (currentMarketKeysByKey.has(key)) continue;
      currentMarketKeysByKey.set(key, {
        wallet_id: row.wallet_id,
        venue: row.venue,
        market_id: row.market_id,
      });
    }
    const currentMarketKeys = Array.from(currentMarketKeysByKey.values());
    const prevWalletRows = await client.query<{ wallet_id: string }>(
      `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      )
      select wallet_set.wallet_id
      from wallet_set
      where exists (
        select 1
        from wallet_position_snapshots ws
        where ws.wallet_id = wallet_set.wallet_id
          and ws.snapshot_at < $2
      )
    `,
      [walletChunk, inputs.occurredAt],
    );

    const prevRows = await fetchPreviousSnapshotDeltaRows(client, {
      currentMarketKeys,
      occurredAt: inputs.occurredAt,
    });

    const prevWallets = new Set(
      prevWalletRows.rows.map((row) => row.wallet_id),
    );
    const currentMap = new Map<string, (typeof currentRows.rows)[number]>();
    const prevMap = new Map<string, (typeof prevRows)[number]>();
    const currentRowsByMarket = new Map<
      string,
      Array<(typeof currentRows.rows)[number]>
    >();
    const prevRowsByMarket = new Map<
      string,
      Array<(typeof prevRows)[number]>
    >();

    const makeKey = (row: {
      wallet_id: string;
      venue: string;
      market_id: string;
      outcome_side: string | null;
    }) =>
      `${row.wallet_id}|${row.venue}|${row.market_id}|${normalizeOutcomeSideForStorage(row.outcome_side)}`;
    const makeMarketKey = (row: {
      wallet_id: string;
      venue: string;
      market_id: string;
    }) => `${row.wallet_id}|${row.venue}|${row.market_id}`;

    for (const row of currentRows.rows) {
      currentMap.set(makeKey(row), row);
      const marketKey = makeMarketKey(row);
      const list = currentRowsByMarket.get(marketKey) ?? [];
      list.push(row);
      currentRowsByMarket.set(marketKey, list);
    }
    for (const row of prevRows) {
      prevMap.set(makeKey(row), row);
      const marketKey = makeMarketKey(row);
      const list = prevRowsByMarket.get(marketKey) ?? [];
      list.push(row);
      prevRowsByMarket.set(marketKey, list);
    }

    const keys = new Set<string>([...currentMap.keys(), ...prevMap.keys()]);
    const marketKeys = new Set<string>([
      ...currentRowsByMarket.keys(),
      ...prevRowsByMarket.keys(),
    ]);
    const suppressedLegacyTransitionMarkets = new Set<string>();

    for (const marketKey of marketKeys) {
      const currentMarketRows = currentRowsByMarket.get(marketKey) ?? [];
      const previousMarketRows = prevRowsByMarket.get(marketKey) ?? [];
      if (
        !shouldSuppressLegacySideTransitionDelta({
          currentRows: currentMarketRows,
          previousRows: previousMarketRows,
        })
      ) {
        continue;
      }
      suppressedLegacyTransitionMarkets.add(marketKey);

      const legacyPrevious = previousMarketRows.find(
        (row) => normalizeOutcomeSideForStorage(row.outcome_side) === "",
      );
      if (!legacyPrevious) continue;
      const prevShares = legacyPrevious.shares
        ? Number(legacyPrevious.shares)
        : 0;
      if (!Number.isFinite(prevShares) || prevShares <= 0) continue;

      const snapshotSource = parseMetadataSource(legacyPrevious.metadata);
      await upsertWalletVenue(
        client,
        legacyPrevious.wallet_id,
        legacyPrevious.venue as Venue,
      );
      await upsertWalletPositionSnapshot(client, {
        walletId: legacyPrevious.wallet_id,
        venue: legacyPrevious.venue,
        marketId: legacyPrevious.market_id,
        outcomeSide: legacyPrevious.outcome_side ?? null,
        shares: 0,
        sizeUsd: 0,
        price:
          legacyPrevious.price != null &&
          Number.isFinite(Number(legacyPrevious.price))
            ? Number(legacyPrevious.price)
            : null,
        metadata: {
          ...((legacyPrevious.metadata ?? {}) as Record<string, unknown>),
          source: "snapshot_transition_reset",
          snapshotSource,
          prevShares: Number(prevShares.toFixed(9)),
          currShares: 0,
          deltaShares: 0,
          suppressedLegacyTransition: true,
        },
        snapshotAt: inputs.occurredAt,
      });
    }

    for (const key of keys) {
      const current = currentMap.get(key);
      const previous = prevMap.get(key);
      const marketKey = current
        ? makeMarketKey(current)
        : previous
          ? makeMarketKey(previous)
          : null;
      if (marketKey && suppressedLegacyTransitionMarkets.has(marketKey))
        continue;
      const walletId = current?.wallet_id ?? previous?.wallet_id;
      if (!walletId) continue;
      if (!prevWallets.has(walletId)) continue;

      const currShares = current?.shares ? Number(current.shares) : 0;
      const prevShares = previous?.shares ? Number(previous.shares) : 0;
      const delta = currShares - prevShares;
      if (!Number.isFinite(delta) || Math.abs(delta) < 1e-9) continue;

      const action = delta > 0 ? "BUY" : "SELL";
      const absShares = Math.abs(delta);
      const price =
        (current?.price != null ? Number(current.price) : null) ??
        (previous?.price != null ? Number(previous.price) : null);
      const sizeUsd =
        price != null && Number.isFinite(price)
          ? Number((absShares * price).toFixed(6))
          : null;

      const metadataBase = (current?.metadata ??
        previous?.metadata ??
        {}) as Record<string, unknown>;
      const snapshotSource = parseMetadataSource(metadataBase);
      const metadata = {
        ...metadataBase,
        snapshotSource,
        deltaShares: Number(absShares.toFixed(9)),
        prevShares: Number(prevShares.toFixed(9)),
        currShares: Number(currShares.toFixed(9)),
      };

      const marketId = current?.market_id ?? previous?.market_id;
      if (!marketId) continue;

      await upsertWalletActivityEvent(client, {
        walletId,
        venue: current?.venue ?? previous?.venue ?? "polymarket",
        marketId,
        outcomeSide: current?.outcome_side ?? previous?.outcome_side ?? null,
        action,
        deltaShares: Number(absShares.toFixed(9)),
        sizeUsd,
        price,
        activityType: "delta",
        source: "snapshot_delta",
        metadata: metadata as Record<string, unknown>,
        occurredAt: inputs.occurredAt,
      });
      updates += 1;

      // When a selected market disappears from the current snapshot, record a
      // zero-share snapshot to prevent repeated synthetic "SELL" events on
      // subsequent runs.
      const missingCurrent = !current && previous && prevShares > 0;
      if (missingCurrent) {
        const venue = previous.venue;
        await upsertWalletVenue(client, walletId, venue as Venue);
        await upsertWalletPositionSnapshot(client, {
          walletId,
          venue,
          marketId,
          outcomeSide: previous.outcome_side ?? null,
          shares: 0,
          sizeUsd: 0,
          price:
            previous.price != null && Number.isFinite(Number(previous.price))
              ? Number(previous.price)
              : null,
          metadata: {
            ...(metadataBase as Record<string, unknown>),
            source: "snapshot_zero",
            snapshotSource,
            prevShares: Number(prevShares.toFixed(9)),
            currShares: 0,
            deltaShares: Number(absShares.toFixed(9)),
          },
          snapshotAt: inputs.occurredAt,
        });
      }
    }
  }

  return { inserts: 0, updates };
}

async function refreshWalletActivityBaseline(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
    windowDays: number;
  },
) {
  const walletIds = Array.from(new Set(inputs.walletIds));
  if (walletIds.length === 0) return;
  const hasSampleCountColumn =
    await hasWalletActivityBaselineSampleCountColumn(client);
  const sampleCountInsertColumnSql = hasSampleCountColumn
    ? `,
        sample_count`
    : "";
  const sampleCountSelectSql = hasSampleCountColumn
    ? `,
        count(*)::int as sample_count`
    : "";
  const sampleCountUpdateSql = hasSampleCountColumn
    ? `,
        sample_count = excluded.sample_count`
    : "";

  for (const chunk of chunkArray(walletIds, 100)) {
    await client.query(
      `
      insert into wallet_activity_baseline (
        wallet_id,
        window_days,
        as_of,
        p50_usd,
        p90_usd${sampleCountInsertColumnSql}
      )
      select
        wa.wallet_id,
        $2::int,
        $3::timestamptz,
        percentile_cont(0.5) within group (order by wa.size_usd) as p50_usd,
        percentile_cont(0.9) within group (order by wa.size_usd) as p90_usd${sampleCountSelectSql}
      from wallet_activity_events wa
      left join unified_markets m on m.id = wa.market_id
      left join unified_events e on e.id = m.event_id
      where wa.wallet_id = any($1::uuid[])
        and wa.activity_type in ('delta', 'trade')
        and wa.size_usd is not null
        and wa.occurred_at >= $3::timestamptz - ($2::text || ' days')::interval
        and wa.occurred_at <= $3::timestamptz
        and ${buildSnapshotDeltaTrackableActivitySql({
          activityAlias: "wa",
          marketAlias: "m",
          eventAlias: "e",
        })}
      group by wa.wallet_id
      on conflict (wallet_id, window_days)
      do update set
        p50_usd = excluded.p50_usd,
        p90_usd = excluded.p90_usd${sampleCountUpdateSql},
        as_of = excluded.as_of,
        updated_at = now()
    `,
      [chunk, inputs.windowDays, inputs.asOf],
    );
  }
}

async function refreshWalletActivityHourly(
  client: Queryable,
  inputs: {
    walletIds: string[];
    since: Date;
    enteredLateHours: number;
  },
) {
  const walletIds = Array.from(new Set(inputs.walletIds));
  if (walletIds.length === 0) return;

  for (const chunk of chunkArray(walletIds, 100)) {
    await client.query(
      `
      insert into wallet_activity_hourly (
        wallet_id,
        venue,
        market_id,
        outcome_side,
        activity_type,
        hour_bucket,
        event_count,
        volume_usd,
        delta_shares_sum,
        price_weighted_sum,
        signed_delta_shares,
        signed_delta_usd,
        abs_delta_usd,
        max_abs_delta_usd,
        last_occurred_at,
        last_price,
        last_change_action,
        entered_late,
        counts_opened,
        counts_closed,
        counts_increased,
        counts_reduced
      )
      select
        e.wallet_id,
        e.venue,
        e.market_id,
        coalesce(e.outcome_side, '') as outcome_side,
        e.activity_type,
        e.hour_bucket,
        count(*)::int as event_count,
        sum(e.size_usd) as volume_usd,
        sum(e.delta_shares) as delta_shares_sum,
        sum(e.price_weighted) as price_weighted_sum,
        sum(e.signed_delta_shares) as signed_delta_shares,
        sum(e.signed_delta_usd) as signed_delta_usd,
        sum(e.abs_delta_usd) as abs_delta_usd,
        max(e.abs_delta_usd) as max_abs_delta_usd,
        max(e.occurred_at) as last_occurred_at,
        (array_agg(e.price order by e.occurred_at desc))[1] as last_price,
        (array_agg(e.change_action order by e.occurred_at desc))[1] as last_change_action,
        bool_or(e.entered_late) as entered_late,
        sum(case when e.change_action = 'OPENED' then 1 else 0 end) as counts_opened,
        sum(case when e.change_action = 'CLOSED' then 1 else 0 end) as counts_closed,
        sum(case when e.change_action = 'INCREASED' then 1 else 0 end) as counts_increased,
        sum(case when e.change_action = 'REDUCED' then 1 else 0 end) as counts_reduced
      from (
        select
          wa.wallet_id,
          wa.venue,
          wa.market_id,
          wa.outcome_side,
          wa.activity_type,
          wa.delta_shares,
          wa.size_usd,
          wa.price,
          wa.occurred_at,
          date_trunc('hour', wa.occurred_at) as hour_bucket,
          case when upper(coalesce(wa.action, 'BUY')) = 'SELL' then -1 else 1 end as action_sign,
          coalesce(
            wa.size_usd,
            abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
          ) as delta_usd,
          coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0) as prev_shares,
          coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0) as curr_shares,
          case
            when wa.delta_shares is not null and wa.price is not null
              then wa.price * wa.delta_shares
            else null
          end as price_weighted,
          (case when upper(coalesce(wa.action, 'BUY')) = 'SELL' then -1 else 1 end)
            * coalesce(wa.delta_shares, 0) as signed_delta_shares,
          (case when upper(coalesce(wa.action, 'BUY')) = 'SELL' then -1 else 1 end)
            * coalesce(
                wa.size_usd,
                abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
              ) as signed_delta_usd,
          abs(
            coalesce(
              wa.size_usd,
              abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
            )
          ) as abs_delta_usd,
          case
            when coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0) <= 0
             and coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0) > 0
              then 'OPENED'
            when coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0) > 0
             and coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0) <= 0
              then 'CLOSED'
            when coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0)
              > coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0)
             and coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0) > 0
              then 'INCREASED'
            when coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0)
              < coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0)
             and coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0) > 0
              then 'REDUCED'
            else null
          end as change_action,
          case
            when coalesce(um.close_time, um.expiration_time) is not null
             and coalesce(um.close_time, um.expiration_time) >= wa.occurred_at
             and coalesce(um.close_time, um.expiration_time) - wa.occurred_at
               <= ($3::text || ' hours')::interval
              then true
            else false
          end as entered_late
        from wallet_activity_events wa
        left join unified_markets um on um.id = wa.market_id
        left join unified_events ue on ue.id = um.event_id
        where wa.wallet_id = any($1::uuid[])
          and wa.activity_type in ('delta', 'trade', 'holder')
          and wa.occurred_at >= $2::timestamptz
          and ${buildSnapshotDeltaTrackableActivitySql({
            activityAlias: "wa",
            marketAlias: "um",
            eventAlias: "ue",
          })}
      ) e
      group by
        e.wallet_id,
        e.venue,
        e.market_id,
        e.outcome_side,
        e.activity_type,
        e.hour_bucket
      on conflict (wallet_id, venue, market_id, outcome_side, activity_type, hour_bucket)
      do update set
        event_count = excluded.event_count,
        volume_usd = excluded.volume_usd,
        delta_shares_sum = excluded.delta_shares_sum,
        price_weighted_sum = excluded.price_weighted_sum,
        signed_delta_shares = excluded.signed_delta_shares,
        signed_delta_usd = excluded.signed_delta_usd,
        abs_delta_usd = excluded.abs_delta_usd,
        max_abs_delta_usd = excluded.max_abs_delta_usd,
        last_occurred_at = excluded.last_occurred_at,
        last_price = excluded.last_price,
        last_change_action = excluded.last_change_action,
        entered_late = excluded.entered_late,
        counts_opened = excluded.counts_opened,
        counts_closed = excluded.counts_closed,
        counts_increased = excluded.counts_increased,
        counts_reduced = excluded.counts_reduced,
        updated_at = now()
    `,
      [chunk, inputs.since, inputs.enteredLateHours],
    );
  }
}

async function refreshWalletPositionExposure(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
  },
) {
  const walletIds = Array.from(new Set(inputs.walletIds));
  if (walletIds.length === 0) return;

  for (const chunk of chunkArray(
    walletIds,
    WALLET_POSITION_EXPOSURE_CHUNK_SIZE,
  )) {
    await client.query(
      `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      ),
      latest as (
        select
          input.wallet_id,
          wv.venue,
          latest_snapshot.snapshot_at
        from wallet_set input
        join wallet_venues wv on wv.wallet_id = input.wallet_id
        join lateral (
          select ws.snapshot_at
          from wallet_position_snapshots ws
          where ws.wallet_id = input.wallet_id
            and ws.venue = wv.venue
            and ws.snapshot_at <= $2::timestamptz
          order by ws.snapshot_at desc
          limit 1
        ) latest_snapshot on true
      ),
      latest_rows as (
        select
          ws.wallet_id,
          ws.market_id,
          case
            when ws.outcome_side in ('YES', 'NO') then ws.outcome_side
            else '__OTHER__'
          end as outcome_side,
          greatest(
            coalesce(
              ws.size_usd,
              abs(coalesce(ws.shares, 0) * coalesce(ws.price, 0)),
              0
            ),
            0
          ) as leg_notional_usd
        from wallet_position_snapshots ws
        join latest l
          on l.wallet_id = ws.wallet_id
         and l.venue = ws.venue
         and l.snapshot_at = ws.snapshot_at
        join unified_markets m on m.id = ws.market_id
        left join unified_events e on e.id = m.event_id
        where ${buildWalletIntelTrackableMarketSql({
          marketAlias: "m",
          eventAlias: "e",
          asOfSql: "$2::timestamptz",
        })}
      ),
      market_rollup as (
        select
          wallet_id,
          market_id,
          sum(
            case when outcome_side = 'YES' then leg_notional_usd else 0 end
          ) as yes_notional_usd,
          sum(
            case when outcome_side = 'NO' then leg_notional_usd else 0 end
          ) as no_notional_usd,
          sum(
            case when outcome_side = '__OTHER__' then leg_notional_usd else 0 end
          ) as other_notional_usd
        from latest_rows
        group by wallet_id, market_id
      ),
      exposure as (
        select
          wallet_id,
          sum(yes_notional_usd + no_notional_usd + other_notional_usd) as exposure_usd,
          sum(2 * least(yes_notional_usd, no_notional_usd)) as hedged_notional_usd,
          sum(abs(yes_notional_usd - no_notional_usd) + other_notional_usd) as net_imbalance_usd,
          count(*) filter (
            where yes_notional_usd > 0 and no_notional_usd > 0
          )::int as two_sided_markets
        from market_rollup
        group by wallet_id
      ),
      final_rows as (
        select
          ws.wallet_id,
          coalesce(e.exposure_usd, 0) as exposure_usd,
          coalesce(e.hedged_notional_usd, 0) as hedged_notional_usd,
          coalesce(e.net_imbalance_usd, 0) as net_imbalance_usd,
          coalesce(e.two_sided_markets, 0) as two_sided_markets
        from wallet_set ws
        left join exposure e on e.wallet_id = ws.wallet_id
      )
      insert into wallet_position_exposure (
        wallet_id,
        exposure_usd,
        hedged_notional_usd,
        net_imbalance_usd,
        hedge_ratio,
        two_sided_markets,
        as_of
      )
      select
        wallet_id,
        exposure_usd,
        hedged_notional_usd,
        net_imbalance_usd,
        case
          when exposure_usd > 0 then hedged_notional_usd / exposure_usd
          else 0
        end as hedge_ratio,
        two_sided_markets,
        $2::timestamptz
      from final_rows
      on conflict (wallet_id)
      do update set
        exposure_usd = excluded.exposure_usd,
        hedged_notional_usd = excluded.hedged_notional_usd,
        net_imbalance_usd = excluded.net_imbalance_usd,
        hedge_ratio = excluded.hedge_ratio,
        two_sided_markets = excluded.two_sided_markets,
        as_of = excluded.as_of,
        updated_at = now()
    `,
      [chunk, inputs.asOf],
    );
  }
}

async function refreshWalletInferredOutcomes(
  client: Queryable,
  inputs: { walletIds: string[] },
) {
  const walletIds = Array.from(new Set(inputs.walletIds));
  if (walletIds.length === 0) return;

  for (const chunk of chunkArray(walletIds, 250)) {
    await client.query(
      `
      with input_wallets as (
        select unnest($1::uuid[]) as wallet_id
      ),
      summary as (
        select
          wa.wallet_id,
          count(*) filter (
            where wa.outcome_side = upper(coalesce(m.resolved_outcome::text, ''))
          )::int as wins,
          count(*)::int as total
        from wallet_activity_events wa
        join input_wallets iw on iw.wallet_id = wa.wallet_id
        join unified_markets m on m.id = wa.market_id
        left join unified_events e on e.id = m.event_id
        where wa.activity_type in ('delta', 'trade')
          and upper(coalesce(m.resolved_outcome::text, '')) in ('YES', 'NO')
          and wa.outcome_side in ('YES', 'NO')
          and upper(coalesce(wa.action, '')) in ('OPENED', 'INCREASED', 'BUY', 'SELL')
          and ${buildSnapshotDeltaTrackableActivitySql({
            activityAlias: "wa",
            marketAlias: "m",
            eventAlias: "e",
          })}
        group by wa.wallet_id
      )
      insert into wallet_inferred_outcomes (
        wallet_id,
        wins,
        total
      )
      select
        iw.wallet_id,
        coalesce(summary.wins, 0),
        coalesce(summary.total, 0)
      from input_wallets iw
      left join summary on summary.wallet_id = iw.wallet_id
      on conflict (wallet_id)
      do update set
        wins = excluded.wins,
        total = excluded.total,
        updated_at = now()
    `,
      [chunk],
    );
  }
}

async function refreshSystemTags(
  client: Queryable,
  inputs: {
    walletIds: string[];
    tagIds: Record<string, string>;
    freshDays: number;
    dormantDays: number;
    whaleUsd: number;
    whaleUsdSolana: number;
    asOf: Date;
  },
) {
  if (inputs.walletIds.length === 0) return;

  const freshRows = await client.query<{ id: string }>(
    `
      select id
      from wallets
      where id = any($1::uuid[])
        and first_seen_at >= $3::timestamptz - ($2::text || ' days')::interval
    `,
    [inputs.walletIds, inputs.freshDays, inputs.asOf],
  );

  const dormantRows = await client.query<{ wallet_id: string }>(
    `
      select w.id as wallet_id
      from wallets w
      left join lateral (
        select max(occurred_at) as last_trade
        from wallet_activity_events wa
        left join unified_markets m on m.id = wa.market_id
        left join unified_events e on e.id = m.event_id
        where wa.wallet_id = w.id
          and wa.activity_type in ('delta', 'trade')
          and ${buildSnapshotDeltaTrackableActivitySql({
            activityAlias: "wa",
            marketAlias: "m",
            eventAlias: "e",
          })}
      ) t on true
      where w.id = any($1::uuid[])
        and (t.last_trade is null or t.last_trade < $3::timestamptz - ($2::text || ' days')::interval)
    `,
    [inputs.walletIds, inputs.dormantDays, inputs.asOf],
  );

  const whaleRows = await client.query<{ wallet_id: string }>(
    `
      select distinct wa.wallet_id
      from wallet_activity_events wa
      join wallets w on w.id = wa.wallet_id
      left join unified_markets m on m.id = wa.market_id
      left join unified_events e on e.id = m.event_id
      where wa.wallet_id = any($1::uuid[])
        and wa.activity_type in ('delta', 'trade', 'holder')
        and wa.size_usd is not null
        and ${buildSnapshotDeltaTrackableActivitySql({
          activityAlias: "wa",
          marketAlias: "m",
          eventAlias: "e",
        })}
        and (
          (w.chain = 'solana' and wa.size_usd >= $2)
          or (w.chain <> 'solana' and wa.size_usd >= $3)
        )
        and wa.occurred_at >= $4::timestamptz - interval '7 days'
        and wa.occurred_at <= $4::timestamptz
    `,
    [inputs.walletIds, inputs.whaleUsdSolana, inputs.whaleUsd, inputs.asOf],
  );

  const tagAssignments: Array<{ slug: string; walletIds: string[] }> = [
    { slug: "fresh", walletIds: freshRows.rows.map((row) => row.id) },
    {
      slug: "dormant",
      walletIds: dormantRows.rows.map((row) => row.wallet_id),
    },
    { slug: "whale", walletIds: whaleRows.rows.map((row) => row.wallet_id) },
  ];

  for (const assignment of tagAssignments) {
    const tagId = inputs.tagIds[assignment.slug];
    if (!tagId) continue;

    await client.query(
      `
        delete from wallet_tag_map
        where tag_id = $1 and wallet_id = any($2::uuid[])
      `,
      [tagId, inputs.walletIds],
    );

    if (assignment.walletIds.length === 0) continue;

    await client.query(
      `
        insert into wallet_tag_map (wallet_id, tag_id, source)
        select wallet_id, $1::uuid, 'system'
        from unnest($2::uuid[]) as wallet_id
        on conflict (wallet_id, tag_id)
        do nothing
      `,
      [tagId, assignment.walletIds],
    );
  }
}

type SafeOwnerLinkResult = {
  selected: number;
  inspected: number;
  safe: number;
  notSafe: number;
  linked: number;
  errors: number;
};

type PolymarketProxyLinkResult = {
  selected: number;
  inspected: number;
  linked: number;
  skipped: number;
  errors: number;
};

function emptySafeOwnerLinkResult(): SafeOwnerLinkResult {
  return {
    selected: 0,
    inspected: 0,
    safe: 0,
    notSafe: 0,
    linked: 0,
    errors: 0,
  };
}

function emptyPolymarketProxyLinkResult(): PolymarketProxyLinkResult {
  return {
    selected: 0,
    inspected: 0,
    linked: 0,
    skipped: 0,
    errors: 0,
  };
}

async function updateWalletMetadata(
  client: Queryable,
  walletId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    `
      update wallets
      set metadata = coalesce(metadata, '{}'::jsonb) || $2,
          updated_at = now()
      where id = $1
    `,
    [walletId, metadata],
  );
}

async function linkSafeOwnersForWhales(
  client: Queryable,
): Promise<SafeOwnerLinkResult> {
  const limit = walletIntelRefreshPolicy.safeLinkLimit;
  if (limit <= 0) return emptySafeOwnerLinkResult();

  const staleBefore = new Date(
    Date.now() - walletIntelRefreshPolicy.safeLinkStaleHours * 60 * 60 * 1000,
  );
  const errorStaleBefore = new Date(
    Date.now() -
      walletIntelRefreshPolicy.safeLinkErrorStaleHours * 60 * 60 * 1000,
  );
  const whaleRows = await client.query<{
    id: string;
    address: string;
    chain: Chain;
  }>(
    `
      select w.id, w.address, w.chain
      from wallets w
      join wallet_tag_map tm on tm.wallet_id = w.id
      join wallet_tags t on t.id = tm.tag_id
      where t.slug = 'whale'
        and w.chain = 'polygon'
        and case
          when (w.metadata->>'safeOwnerCheckedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            then true
          when w.metadata->>'safeOwnerCheckStatus' = 'error'
            then w.metadata->>'safeOwnerCheckedAt' < $2::text
          when w.metadata->>'safeOwnerCheckStatus' in ('safe', 'not_safe')
            then w.metadata->>'safeOwnerCheckedAt' < $1::text
          else true
        end
      order by w.last_seen_at desc nulls last, w.id
      limit $3
    `,
    [staleBefore.toISOString(), errorStaleBefore.toISOString(), limit],
  );

  const result: SafeOwnerLinkResult = {
    ...emptySafeOwnerLinkResult(),
    selected: whaleRows.rows.length,
  };
  const inspected = new Set<string>();

  for (const row of whaleRows.rows) {
    const address = normalizeAddress(row.address, row.chain);
    if (!address) continue;
    if (inspected.has(address)) continue;
    inspected.add(address);
    result.inspected += 1;
    const checkedAt = new Date().toISOString();

    const safeInfo = await inspectSafeWalletStrict({ address });
    if (safeInfo.status === "error") {
      result.errors += 1;
      await updateWalletMetadata(client, row.id, {
        safeOwnerCheckedAt: checkedAt,
        safeOwnerCheckStatus: "error",
        safeOwnerCheckError: safeInfo.error,
      });
      continue;
    }

    if (safeInfo.status === "not_safe") {
      result.notSafe += 1;
      await updateWalletMetadata(client, row.id, {
        safeOwnerCheckedAt: checkedAt,
        safeOwnerCheckStatus: "not_safe",
        safeOwnerCheckError: null,
      });
      continue;
    }

    result.safe += 1;
    const owners = safeInfo.owners
      .map((owner) => normalizeAddress(owner, "polygon"))
      .filter((owner): owner is string => Boolean(owner));
    await updateWalletMetadata(client, row.id, {
      kind: "safe",
      owners,
      threshold: safeInfo.threshold,
      safeOwnerCheckedAt: checkedAt,
      safeOwnerCheckStatus: "safe",
      safeOwnerCheckError: null,
    });

    if (owners.length !== 1) continue;
    const owner = owners[0];
    if (!owner) continue;
    if (owner === address) continue;

    await upsertWalletWithMetadata(client, {
      address: owner,
      chain: "polygon",
      metadata: {
        kind: "safe_owner",
        derivedFrom: address,
        source: "whale_safe_owner",
        linkedAt: checkedAt,
      },
    });
    result.linked += 1;
  }

  return result;
}

type PolymarketProxyKind = "safe" | "magic" | "deposit_wallet";

function resolvePolymarketProxyKind(
  candidate: PolymarketFunderCandidate | null | undefined,
): PolymarketProxyKind | null {
  if (!candidate?.deployed) return null;
  if (candidate.signatureType === 1) return "magic";
  if (
    candidate.source === "safe_proxy" ||
    (candidate.signatureType === 2 && candidate.contractKind === "SAFE_LIKE")
  ) {
    return "safe";
  }
  if (candidate.signatureType === 3 && candidate.contractKind === "CONTRACT") {
    return "deposit_wallet";
  }
  return null;
}

function findPolymarketFunderCandidate(
  candidates: PolymarketFunderCandidate[],
  proxyAddress: string,
): PolymarketFunderCandidate | null {
  return (
    candidates.find(
      (candidate) =>
        normalizeAddress(candidate.funder, "polygon") === proxyAddress,
    ) ?? null
  );
}

async function linkPolymarketProxyOwnersForKnownWallets(
  client: Queryable,
): Promise<PolymarketProxyLinkResult> {
  const limit = walletIntelRefreshPolicy.safeLinkLimit;
  if (limit <= 0) return emptyPolymarketProxyLinkResult();

  const staleBefore = new Date(
    Date.now() - walletIntelRefreshPolicy.safeLinkStaleHours * 60 * 60 * 1000,
  );
  const errorStaleBefore = new Date(
    Date.now() -
      walletIntelRefreshPolicy.safeLinkErrorStaleHours * 60 * 60 * 1000,
  );
  const proxyRows = await client.query<{
    proxy_wallet_id: string;
    proxy_address: string;
    signer_address: string;
    user_id: string;
    source: "current_funder" | "order_wallet";
  }>(
    `
      with known as (
        select
          uvc.user_id,
          lower(uvc.wallet_address) as signer_address,
          lower(uvc.funder_address) as proxy_address,
          'current_funder'::text as source,
          coalesce(uvc.funder_updated_at, uvc.updated_at, uvc.created_at) as seen_at
        from user_venue_credentials uvc
        where uvc.venue = 'polymarket'
          and uvc.is_active = true
          and uvc.wallet_address ~* '^0x[0-9a-f]{40}$'
          and uvc.funder_address ~* '^0x[0-9a-f]{40}$'
          and lower(uvc.funder_address) <> lower(uvc.wallet_address)
        union all
        select
          o.user_id,
          lower(o.signer_address) as signer_address,
          lower(o.wallet_address) as proxy_address,
          'order_wallet'::text as source,
          max(coalesce(o.last_update, o.posted_at)) as seen_at
        from orders o
        where o.venue = 'polymarket'
          and o.signer_address ~* '^0x[0-9a-f]{40}$'
          and o.wallet_address ~* '^0x[0-9a-f]{40}$'
          and lower(o.wallet_address) <> lower(o.signer_address)
        group by o.user_id, lower(o.signer_address), lower(o.wallet_address)
      ),
      ranked as (
        select
          known.*,
          row_number() over (
            partition by known.proxy_address
            order by
              (known.source = 'current_funder') desc,
              known.seen_at desc nulls last,
              known.signer_address
          ) as rn
        from known
      )
      select
        w.id as proxy_wallet_id,
        w.address as proxy_address,
        ranked.signer_address,
        ranked.user_id,
        ranked.source::text as source
      from ranked
      join wallets w
        on w.chain = 'polygon'
       and lower(w.address) = ranked.proxy_address
      where ranked.rn = 1
        and case
          when (w.metadata->>'polymarketProxyOwnerCheckedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            then true
          when w.metadata->>'polymarketProxyOwnerCheckStatus' = 'error'
            then w.metadata->>'polymarketProxyOwnerCheckedAt' < $2::text
          when w.metadata->>'polymarketProxyOwnerCheckStatus' in ('linked', 'skipped')
            then w.metadata->>'polymarketProxyOwnerCheckedAt' < $1::text
          else true
        end
      order by w.last_seen_at desc nulls last, w.id
      limit $3
    `,
    [staleBefore.toISOString(), errorStaleBefore.toISOString(), limit],
  );

  const result: PolymarketProxyLinkResult = {
    ...emptyPolymarketProxyLinkResult(),
    selected: proxyRows.rows.length,
  };

  for (const row of proxyRows.rows) {
    const proxyAddress = normalizeAddress(row.proxy_address, "polygon");
    const signerAddress = normalizeAddress(row.signer_address, "polygon");
    if (!proxyAddress || !signerAddress || proxyAddress === signerAddress) {
      continue;
    }
    result.inspected += 1;
    const checkedAt = new Date().toISOString();

    try {
      const funderResult = await derivePolymarketFunders({
        signer: signerAddress,
        storedFunder: proxyAddress,
        includeMagicProxy: true,
      });
      const candidate = findPolymarketFunderCandidate(
        funderResult.candidates,
        proxyAddress,
      );
      const proxyKind = resolvePolymarketProxyKind(candidate);

      if (!proxyKind) {
        result.skipped += 1;
        await updateWalletMetadata(client, row.proxy_wallet_id, {
          polymarketProxyOwnerCheckedAt: checkedAt,
          polymarketProxyOwnerCheckStatus: "skipped",
          polymarketProxyOwnerCheckError: null,
          polymarketProxyKind: null,
          polymarketSignerAddress: signerAddress,
          linkedOwnerAddress: null,
          linkedOwnerSource: row.source,
          linkedOwnerAt: null,
        });
        continue;
      }

      await upsertWalletWithMetadata(client, {
        address: signerAddress,
        chain: "polygon",
        metadata: {
          polymarketProxyOwner: true,
          polymarketProxyOwnerLinkedAt: checkedAt,
          polymarketProxyOwnerSource: row.source,
        },
      });

      await updateWalletMetadata(client, row.proxy_wallet_id, {
        ...(proxyKind === "safe"
          ? {
              kind: "safe",
              owners: candidate?.safeOwners ?? [signerAddress],
              threshold: candidate?.safeThreshold ?? 1,
            }
          : {}),
        polymarketProxyKind: proxyKind,
        polymarketSignerAddress: signerAddress,
        linkedOwnerAddress: signerAddress,
        linkedOwnerSource: row.source,
        linkedOwnerAt: checkedAt,
        polymarketProxyOwnerCheckedAt: checkedAt,
        polymarketProxyOwnerCheckStatus: "linked",
        polymarketProxyOwnerCheckError: null,
      });
      result.linked += 1;
    } catch (error) {
      result.errors += 1;
      await updateWalletMetadata(client, row.proxy_wallet_id, {
        polymarketProxyOwnerCheckedAt: checkedAt,
        polymarketProxyOwnerCheckStatus: "error",
        polymarketProxyOwnerCheckError:
          error instanceof Error ? error.message.slice(0, 240) : String(error),
      });
    }
  }

  return result;
}

type MarketPickRow = {
  id: string;
  venue: string;
  volume_24h: number | null;
};

const TRADE_WINDOW_HOURS = 24;

async function selectPolymarketByTrade(
  client: Queryable,
  hours: number,
  limit: number,
  asOf: Date,
  mode: "trade_1h" | "trade_24h" | "hybrid",
): Promise<MarketPickRow[]> {
  const tradeTable =
    hours <= 1 ? "unified_last_trade_1m" : "unified_last_trade_1h";
  const result = await client.query<MarketPickRow>(
    `
      with recent as (
        select token_id, sum(volume) as vol
        from ${tradeTable}
        where venue = 'polymarket'
          and bucket >= now() - ($1::text || ' hours')::interval
        group by token_id
      )
      select
        m.id,
        m.venue,
        m.volume_24h
      from unified_markets m
      join unified_market_tokens t
        on t.market_id = m.id
       and t.venue = 'polymarket'
      join recent r on r.token_id = t.token_id
      left join unified_events e on e.id = m.event_id
      where ${buildWalletIntelTrackableMarketSql({
        marketAlias: "m",
        eventAlias: "e",
        asOfSql: "$3::timestamptz",
      })}
        and m.venue = 'polymarket'
      group by m.id, m.venue, m.volume_24h, m.liquidity
      order by ${
        mode === "hybrid"
          ? "(coalesce(sum(r.vol), 0) + 0.5 * coalesce(m.volume_24h, 0) + 0.3 * coalesce(m.liquidity, 0))"
          : "sum(r.vol)"
      } desc nulls last
      limit $2
    `,
    [hours, limit, asOf],
  );
  return result.rows;
}

async function selectPolymarketByMetric(
  client: Queryable,
  limit: number,
  asOf: Date,
  mode: "volume_24h" | "liquidity",
): Promise<MarketPickRow[]> {
  const order =
    mode === "volume_24h"
      ? "m.volume_24h desc nulls last"
      : "m.liquidity desc nulls last";
  const result = await client.query<MarketPickRow>(
    `
      select m.id, m.venue, m.volume_24h
      from unified_markets m
      left join unified_events e on e.id = m.event_id
      where ${buildWalletIntelTrackableMarketSql({
        marketAlias: "m",
        eventAlias: "e",
        asOfSql: "$2::timestamptz",
      })}
        and m.venue = 'polymarket'
      order by ${order}
      limit $1
    `,
    [limit, asOf],
  );
  return result.rows;
}

async function selectKalshiByTrade(
  client: Queryable,
  hours: number,
  limit: number,
  asOf: Date,
  mode: "trade_1h" | "trade_24h" | "hybrid",
): Promise<MarketPickRow[]> {
  const tradeTable =
    hours <= 1 ? "unified_last_trade_1m" : "unified_last_trade_1h";
  const result = await client.query<MarketPickRow>(
    `
      with recent as (
        select token_id, sum(volume) as vol
        from ${tradeTable}
        where venue = 'kalshi'
          and bucket >= now() - ($1::text || ' hours')::interval
        group by token_id
      )
      select
        m.id,
        m.venue,
        m.volume_24h
      from unified_markets m
      join unified_market_tokens t
        on t.market_id = m.id
       and t.venue = 'kalshi'
      join recent r on r.token_id = t.token_id
      left join unified_events e on e.id = m.event_id
      where ${buildWalletIntelTrackableMarketSql({
        marketAlias: "m",
        eventAlias: "e",
        asOfSql: "$3::timestamptz",
      })}
        and m.venue = 'kalshi'
        and m.is_initialized is true
      group by m.id, m.venue, m.volume_24h, m.open_interest
      order by ${
        mode === "hybrid"
          ? "(coalesce(sum(r.vol), 0) + 0.3 * coalesce(m.open_interest, 0))"
          : "sum(r.vol)"
      } desc nulls last
      limit $2
    `,
    [hours, limit, asOf],
  );
  return result.rows;
}

async function selectKalshiByMetric(
  client: Queryable,
  limit: number,
  asOf: Date,
  mode: "open_interest" | "updated",
): Promise<MarketPickRow[]> {
  const order =
    mode === "open_interest"
      ? "m.open_interest desc nulls last"
      : "m.updated_at desc nulls last";
  const result = await client.query<MarketPickRow>(
    `
      select m.id, m.venue, m.volume_24h
      from unified_markets m
      left join unified_events e on e.id = m.event_id
      where ${buildWalletIntelTrackableMarketSql({
        marketAlias: "m",
        eventAlias: "e",
        asOfSql: "$2::timestamptz",
      })}
        and m.venue = 'kalshi'
        and m.is_initialized is true
      order by ${order}
      limit $1
    `,
    [limit, asOf],
  );
  return result.rows;
}

async function selectLimitlessByMetric(
  client: Queryable,
  limit: number,
  asOf: Date,
  mode: "liquidity" | "updated" | "book" | "hybrid",
): Promise<MarketPickRow[]> {
  let order = "m.updated_at desc nulls last";
  if (mode === "liquidity") order = "m.liquidity desc nulls last";
  if (mode === "book") {
    order = `case when m.best_bid is not null or m.best_ask is not null then 1 else 0 end desc,
      m.liquidity desc nulls last,
      m.updated_at desc nulls last`;
  }
  if (mode === "hybrid") {
    order = `(coalesce(m.liquidity, 0) +
      case when m.best_bid is not null or m.best_ask is not null then 1 else 0 end) desc,
      m.updated_at desc nulls last`;
  }
  const result = await client.query<MarketPickRow>(
    `
      select m.id, m.venue, m.volume_24h
      from unified_markets m
      left join unified_events e on e.id = m.event_id
      where ${buildWalletIntelTrackableMarketSql({
        marketAlias: "m",
        eventAlias: "e",
        asOfSql: "$2::timestamptz",
      })}
        and m.venue = 'limitless'
      order by ${order}
      limit $1
    `,
    [limit, asOf],
  );
  return result.rows;
}

async function selectMarketsPerVenue(
  client: Queryable,
  limitPoly: number,
  limitKalshi: number,
  limitLimitless: number,
  asOf: Date,
): Promise<MarketPickRow[]> {
  const rows: MarketPickRow[] = [];
  const polyMode = walletIntelRefreshPolicy.selectionModePoly;
  const kalshiMode = walletIntelRefreshPolicy.selectionModeKalshi;
  const limitlessMode = walletIntelRefreshPolicy.selectionModeLimitless;

  if (limitPoly > 0) {
    if (polyMode === "trade_1h") {
      rows.push(
        ...(await selectPolymarketByTrade(
          client,
          1,
          limitPoly,
          asOf,
          "trade_1h",
        )),
      );
    } else if (polyMode === "trade_24h") {
      rows.push(
        ...(await selectPolymarketByTrade(
          client,
          TRADE_WINDOW_HOURS,
          limitPoly,
          asOf,
          "trade_24h",
        )),
      );
    } else if (polyMode === "hybrid") {
      rows.push(
        ...(await selectPolymarketByTrade(
          client,
          TRADE_WINDOW_HOURS,
          limitPoly,
          asOf,
          "hybrid",
        )),
      );
    } else if (polyMode === "volume_24h" || polyMode === "liquidity") {
      rows.push(
        ...(await selectPolymarketByMetric(client, limitPoly, asOf, polyMode)),
      );
    } else {
      rows.push(
        ...(await selectPolymarketByTrade(
          client,
          TRADE_WINDOW_HOURS,
          limitPoly,
          asOf,
          "trade_24h",
        )),
      );
    }
  }

  if (limitKalshi > 0) {
    if (kalshiMode === "trade_1h") {
      rows.push(
        ...(await selectKalshiByTrade(
          client,
          1,
          limitKalshi,
          asOf,
          "trade_1h",
        )),
      );
    } else if (kalshiMode === "trade_24h") {
      rows.push(
        ...(await selectKalshiByTrade(
          client,
          TRADE_WINDOW_HOURS,
          limitKalshi,
          asOf,
          "trade_24h",
        )),
      );
    } else if (kalshiMode === "hybrid") {
      rows.push(
        ...(await selectKalshiByTrade(
          client,
          TRADE_WINDOW_HOURS,
          limitKalshi,
          asOf,
          "hybrid",
        )),
      );
    } else if (kalshiMode === "open_interest" || kalshiMode === "updated") {
      rows.push(
        ...(await selectKalshiByMetric(client, limitKalshi, asOf, kalshiMode)),
      );
    } else {
      rows.push(
        ...(await selectKalshiByTrade(
          client,
          TRADE_WINDOW_HOURS,
          limitKalshi,
          asOf,
          "trade_24h",
        )),
      );
    }
  }

  if (limitLimitless > 0) {
    if (
      limitlessMode === "liquidity" ||
      limitlessMode === "updated" ||
      limitlessMode === "book" ||
      limitlessMode === "hybrid"
    ) {
      rows.push(
        ...(await selectLimitlessByMetric(
          client,
          limitLimitless,
          asOf,
          limitlessMode,
        )),
      );
    } else {
      rows.push(
        ...(await selectLimitlessByMetric(
          client,
          limitLimitless,
          asOf,
          "liquidity",
        )),
      );
    }
  }

  return rows;
}

async function runSnapshot(snapshotAt: Date) {
  const runStartedAt = new Date();
  const holderLimit = walletIntelRefreshPolicy.holderLimit;
  const marketLimit = walletIntelRefreshPolicy.marketLimit;
  const marketLimitPerVenue = walletIntelRefreshPolicy.marketLimitPerVenue;
  const marketLimitKalshi = walletIntelRefreshPolicy.marketLimitKalshi;
  const telemetry = createRefreshTelemetry();
  const marketFetchConcurrency = env.walletIntelMarketFetchConcurrency;
  const followedFetchConcurrency = env.walletIntelFollowedFetchConcurrency;
  const marketLimitPerVenueMax = Math.max(
    marketLimitPerVenue,
    marketLimitKalshi,
  );

  console.log(
    `[wallets:intel:refresh] start startedAt=${runStartedAt.toISOString()} markets=${marketLimit} holders=${holderLimit} snapshot=${snapshotAt.toISOString()} marketFetchConcurrency=${marketFetchConcurrency} followedFetchConcurrency=${followedFetchConcurrency}`,
  );

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '300s'");
    const tagIds = await ensureSystemTags(client);

    const markets = await client.query<{
      id: string;
      venue: string;
      volume_24h: number | null;
    }>(
      `
        select m.id, m.venue, m.volume_24h
        from unified_markets m
        left join unified_events e on e.id = m.event_id
        where ${buildWalletIntelTrackableMarketSql({
          marketAlias: "m",
          eventAlias: "e",
          asOfSql: "$3::timestamptz",
        })}
          and m.venue in ('polymarket', 'limitless', 'kalshi')
          and (m.venue != 'kalshi' or m.is_initialized is true)
          and coalesce(m.volume_24h, 0) >= $1
        order by m.volume_24h desc nulls last
        limit $2
      `,
      [walletIntelRefreshPolicy.minVolume24h, marketLimit, snapshotAt],
    );

    const marketsPerVenueRows =
      marketLimitPerVenueMax > 0
        ? await selectMarketsPerVenue(
            client,
            marketLimitPerVenue,
            marketLimitKalshi,
            marketLimitPerVenue,
            snapshotAt,
          )
        : [];

    const watchlistMarkets = await client.query<{
      id: string;
      venue: string;
      volume_24h: number | null;
    }>(
      `
        select id, venue, volume_24h
        from (
          select distinct um.id, um.venue, um.volume_24h
          from user_watchlist uw
          join wallet_follows wf on wf.user_id = uw.user_id
          join unified_markets um on um.id = uw.market_id
          left join unified_events ue on ue.id = um.event_id
          where ${buildWalletIntelTrackableMarketSql({
            marketAlias: "um",
            eventAlias: "ue",
            asOfSql: "$2::timestamptz",
          })}
            and um.venue in ('polymarket', 'limitless', 'kalshi')
            and (um.venue != 'kalshi' or um.is_initialized is true)
        ) selected
        order by volume_24h desc nulls last
        limit $1
      `,
      [walletIntelRefreshPolicy.watchlistMarketLimit, snapshotAt],
    );

    const whaleMarkets =
      walletIntelRefreshPolicy.whaleMarketLimit > 0
        ? await client.query<{
            id: string;
            venue: string;
            volume_24h: number | null;
          }>(
            `
              with whale_wallets as (
                select tm.wallet_id
                from wallet_tags t
                join wallet_tag_map tm on tm.tag_id = t.id
                where t.slug = 'whale'
              ),
              whale_markets as (
                select distinct wah.market_id
                from wallet_activity_hourly wah
                join whale_wallets ww on ww.wallet_id = wah.wallet_id
                where wah.hour_bucket >= $2::timestamptz - interval '7 days'
                  and wah.activity_type in ('delta', 'trade')
                  and wah.market_id is not null
              )
              select um.id, um.venue, um.volume_24h
              from whale_markets wm
              join unified_markets um on um.id = wm.market_id
              left join unified_events ue on ue.id = um.event_id
              where ${buildWalletIntelTrackableMarketSql({
                marketAlias: "um",
                eventAlias: "ue",
                asOfSql: "$2::timestamptz",
              })}
                and um.venue in ('polymarket', 'limitless', 'kalshi')
                and (um.venue != 'kalshi' or um.is_initialized is true)
              order by um.volume_24h desc nulls last
              limit $1
            `,
            [walletIntelRefreshPolicy.whaleMarketLimit, snapshotAt],
          )
        : { rows: [] };

    const marketMap = new Map<
      string,
      { id: string; venue: string; volume_24h: number | null }
    >();
    for (const row of markets.rows) {
      marketMap.set(row.id, row);
    }
    for (const row of marketsPerVenueRows) {
      marketMap.set(row.id, row);
    }
    for (const row of watchlistMarkets.rows) {
      marketMap.set(row.id, row);
    }
    for (const row of whaleMarkets.rows) {
      marketMap.set(row.id, row);
    }

    const marketRows = Array.from(marketMap.values());
    console.log("[wallets:intel:refresh] market selection", {
      selected: marketRows.length,
      base: markets.rows.length,
      perVenue: marketsPerVenueRows.length,
      watchlist: watchlistMarkets.rows.length,
      whale: whaleMarkets.rows.length,
    });
    const selectedMarketIds = marketRows.map((row) => row.id);
    const clearedHolderSnapshots = await clearSelectedMarketHolderSnapshots(
      client,
      {
        marketIds: selectedMarketIds,
        snapshotAt,
      },
    );
    if (clearedHolderSnapshots > 0) {
      console.log("[wallets:intel:refresh] cleared stale holder snapshots", {
        snapshot: snapshotAt.toISOString(),
        markets: selectedMarketIds.length,
        rows: clearedHolderSnapshots,
      });
    }
    const limitlessPriceBackfills = await backfillLimitlessPrices(
      client,
      marketRows,
      telemetry.limitlessPriceBackfill,
    );
    if (limitlessPriceBackfills > 0) {
      console.log(
        `[wallets:intel:refresh] limitless price backfills=${limitlessPriceBackfills}`,
      );
    }

    const walletCache = new Map<string, string>();
    const tokenIndexByVenue: Record<Venue, Map<string, TokenIndexEntry>> = {
      polymarket: new Map(),
      limitless: new Map(),
      kalshi: new Map(),
    };
    const tokenIdsByVenue: Record<Venue, string[]> = {
      polymarket: [],
      limitless: [],
      kalshi: [],
    };
    const touchedWalletIds = new Set<string>();
    let marketsProcessed = 0;
    let activityRows = 0;
    let deltaInserts = 0;
    let deltaUpdates = 0;
    let followedProcessed = 0;
    let followedRows = 0;
    let holderRateLimitErrors = 0;
    let holderAbortErrors = 0;
    let holderOtherErrors = 0;

    const marketResults = (
      await fetchMarketHolderDataBatch({
        markets: marketRows,
        limit: holderLimit,
        client,
        marketFetchConcurrency,
        telemetry: {
          holdersPolymarket: telemetry.holdersPolymarket,
          holdersAlchemyPolygon: telemetry.holdersAlchemyPolygon,
          holdersAlchemyBase: telemetry.holdersAlchemyBase,
          holdersLimitlessBalanceVerify:
            telemetry.holdersLimitlessBalanceVerify,
          holdersSolana: telemetry.holdersSolana,
          holdersSolanaLargestAccounts: telemetry.holdersSolanaLargestAccounts,
          holdersSolanaOwnerLookup: telemetry.holdersSolanaOwnerLookup,
        },
      })
    ).map((result) => ({
      market: result.market,
      chain: VENUE_CHAIN[result.market.venue] ?? null,
      data: result.data,
      error: result.error,
    }));

    for (const result of marketResults) {
      const market = result.market;
      const venue = market.venue as Venue;
      const chain = result.chain;
      if (!chain) continue;

      if (result.error) {
        const error = result.error;
        if (isRpcRateLimit(error)) {
          holderRateLimitErrors += 1;
          continue;
        }
        if (isAbortError(error)) {
          holderAbortErrors += 1;
          continue;
        }
        holderOtherErrors += 1;
        console.error(
          "[wallets:intel:refresh] market holders fetch failed",
          { marketId: market.id, venue: market.venue },
          error,
        );
        continue;
      }

      const data = result.data;
      if (!data) continue;

      const maybeAddToken = (tokenId: string | null, side: "YES" | "NO") => {
        if (!tokenId) return;
        const onchainTokenId = normalizeOnchainTokenId(venue, tokenId);
        if (!onchainTokenId) return;
        const bucket = tokenIndexByVenue[venue];
        if (!bucket.has(onchainTokenId)) {
          bucket.set(onchainTokenId, {
            marketId: market.id,
            venue,
            tokenId,
            side,
            price: data.priceBySide[side],
          });
          tokenIdsByVenue[venue].push(onchainTokenId);
        }
      };

      maybeAddToken(data.tokenIdsBySide.YES, "YES");
      maybeAddToken(data.tokenIdsBySide.NO, "NO");

      if (data.holders.length === 0) continue;

      marketsProcessed += 1;

      const aggregated = new Map<
        string,
        { yesShares: number; noShares: number }
      >();

      for (const holder of data.holders) {
        const key = holder.wallet.trim();
        const entry = aggregated.get(key) ?? { yesShares: 0, noShares: 0 };
        if (holder.side === "YES") entry.yesShares += holder.shares;
        if (holder.side === "NO") entry.noShares += holder.shares;
        aggregated.set(key, entry);
      }

      for (const [walletRaw, agg] of aggregated.entries()) {
        const address = normalizeAddress(walletRaw, chain);
        if (!address) continue;
        const cacheKey = `${chain}:${address}`;

        let walletId = walletCache.get(cacheKey);
        if (!walletId) {
          walletId = await upsertWallet(client, { address, chain });
          walletCache.set(cacheKey, walletId);
        }

        await upsertWalletVenue(client, walletId, market.venue);

        const upsertHolderSide = async (side: "YES" | "NO", shares: number) => {
          if (!Number.isFinite(shares) || shares <= 0) return;
          const price = data.priceBySide[side] ?? null;
          const sizeUsd =
            price != null ? Number((shares * price).toFixed(6)) : null;

          await upsertWalletPositionSnapshot(client, {
            walletId,
            venue: market.venue,
            marketId: market.id,
            outcomeSide: side,
            shares,
            sizeUsd,
            price,
            metadata: {
              source: data.source,
              tokenId: data.tokenIdsBySide[side],
              shares,
              yesShares: agg.yesShares || null,
              noShares: agg.noShares || null,
              yesPrice: data.priceBySide.YES,
              noPrice: data.priceBySide.NO,
            },
            snapshotAt,
          });

          if (
            chain === "solana" &&
            sizeUsd != null &&
            sizeUsd >= walletIntelRefreshPolicy.whaleUsdSolana
          ) {
            await upsertWalletActivityEvent(client, {
              walletId,
              venue: market.venue,
              marketId: market.id,
              outcomeSide: side,
              action: null,
              deltaShares: Number(shares.toFixed(9)),
              sizeUsd,
              price,
              activityType: "holder",
              source: "holder_snapshot",
              metadata: {
                source: data.source,
                tokenId: data.tokenIdsBySide[side],
                shares,
                snapshotAt: snapshotAt.toISOString(),
              },
              occurredAt: snapshotAt,
            });
          }
        };

        await upsertHolderSide("YES", agg.yesShares);
        await upsertHolderSide("NO", agg.noShares);

        touchedWalletIds.add(walletId);
        activityRows += 1;
      }
    }

    if (holderRateLimitErrors > 0 || holderAbortErrors > 0) {
      console.warn("[wallets:intel:refresh] holder fetch throttled", {
        rateLimited: holderRateLimitErrors,
        aborted: holderAbortErrors,
      });
    }
    if (holderOtherErrors > 0) {
      console.warn("[wallets:intel:refresh] holder fetch errors", {
        count: holderOtherErrors,
      });
    }

    tokenIdsByVenue.polymarket = capTokenIds(
      tokenIdsByVenue.polymarket,
      walletIntelRefreshPolicy.tokenLimitPoly,
    );
    tokenIdsByVenue.limitless = capTokenIds(
      tokenIdsByVenue.limitless,
      walletIntelRefreshPolicy.tokenLimitLimitless,
    );
    tokenIdsByVenue.kalshi = capTokenIds(
      tokenIdsByVenue.kalshi,
      walletIntelRefreshPolicy.tokenLimitKalshi,
    );
    await enqueueWalletIntelMarketRefresh(tokenIdsByVenue);

    const followedWallets = await client.query<{
      user_id: string;
      wallet_id: string;
      address: string;
      chain: Chain;
    }>(
      `
        select wf.user_id, w.id as wallet_id, w.address, w.chain
        from wallet_follows wf
        join wallets w on w.id = wf.wallet_id
        order by wf.created_at desc
        limit $1
      `,
      [walletIntelRefreshPolicy.followedWalletLimit],
    );

    const followedCollection = await collectFollowedWalletSnapshotRows(client, {
      followedWallets: followedWallets.rows,
      snapshotAt,
      tokenIdsByVenue,
      tokenIndexByVenue,
      telemetry,
      followedFetchConcurrency,
      touchedWalletIds,
      poolClient: pool,
    });
    followedProcessed = followedCollection.processed;
    followedRows += followedCollection.rowInserts;
    activityRows += followedCollection.activityRows;

    const artifactRefresh = await refreshTouchedWalletArtifacts(client, {
      touchedWalletIds,
      selectedMarketIds,
      snapshotAt,
      tagIds,
    });
    deltaInserts += artifactRefresh.deltaInserts;
    deltaUpdates += artifactRefresh.deltaUpdates;

    const whaleOwnersLinked = await linkSafeOwnersForWhales(client);
    const polymarketProxyOwnersLinked =
      await linkPolymarketProxyOwnersForKnownWallets(client);
    logRefreshTelemetry(telemetry);

    const runFinishedAt = new Date();
    console.log(
      `[wallets:intel:refresh] done finishedAt=${runFinishedAt.toISOString()} durationMs=${runFinishedAt.getTime() - runStartedAt.getTime()} markets=${marketsProcessed} wallets=${touchedWalletIds.size} rows=${activityRows} followed=${followedProcessed} followedRows=${followedRows} deltaInserts=${deltaInserts} deltaUpdates=${deltaUpdates} safeLinkSelected=${whaleOwnersLinked.selected} safeLinkInspected=${whaleOwnersLinked.inspected} whaleOwnersLinked=${whaleOwnersLinked.linked} safeLinkErrors=${whaleOwnersLinked.errors} polymarketProxyLinkSelected=${polymarketProxyOwnersLinked.selected} polymarketProxyLinkInspected=${polymarketProxyOwnersLinked.inspected} polymarketProxyOwnersLinked=${polymarketProxyOwnersLinked.linked} polymarketProxyLinkSkipped=${polymarketProxyOwnersLinked.skipped} polymarketProxyLinkErrors=${polymarketProxyOwnersLinked.errors}`,
    );
  } finally {
    client.release();
  }
}

async function main() {
  const lockClient = await pool.connect();
  try {
    const locked = await acquireRefreshAdvisoryLock(lockClient);
    if (!locked) {
      console.warn(
        "[wallets:intel:refresh] skipped; advisory lock is already held",
      );
      return;
    }

    const [refreshPolicy, whalePolicy] = await Promise.all([
      resolveWalletIntelRefreshPolicy(pool),
      resolveAiWhaleProfilesPolicy(pool),
    ]);
    walletIntelRefreshPolicy = refreshPolicy.effective;
    aiWhaleProfilesPolicy = whalePolicy.effective;

    const runAt = new Date();
    const baseSnapshot = bucketDate(
      runAt,
      walletIntelRefreshPolicy.snapshotHours,
    );
    const backfillSteps = parseBackfillSnapshots();
    const retention = parseRetentionConfig();
    const snapshots: Date[] = [];

    if (backfillSteps > 0) {
      console.log(
        `[wallets:intel:refresh] backfill snapshots=${backfillSteps} stepHours=${walletIntelRefreshPolicy.snapshotHours}`,
      );
    }

    if (retention.cleanupOnly) {
      if (retention.skipCleanup) {
        console.log(
          "[wallets:intel:refresh] cleanup-only skipped (--skip-cleanup)",
        );
        return;
      }
      if (!retentionEnabled(retention)) {
        console.log(
          "[wallets:intel:refresh] cleanup-only skipped (no retention)",
        );
        return;
      }
      console.log(
        `[wallets:intel:refresh] cleanup-only retention snapshots=${retention.snapshotsDays ?? 0}d activity=${retention.activityDays ?? 0}d metrics=${retention.metricsDays ?? 0}d`,
      );
      const result = await cleanupWalletIntel(retention, runAt);
      console.log(
        `[wallets:intel:refresh] cleanup-only done snapshots=${result.snapshots} activity=${result.activity} metrics=${result.metrics}`,
      );
      return;
    }

    for (let step = backfillSteps; step >= 0; step -= 1) {
      snapshots.push(
        addHours(baseSnapshot, -step * walletIntelRefreshPolicy.snapshotHours),
      );
    }

    for (const snapshotAt of snapshots) {
      await runSnapshot(snapshotAt);
    }

    if (aiWhaleProfilesPolicy.autoRun) {
      const result = await runWhaleProfiles({
        limit: aiWhaleProfilesPolicy.limit,
        marketLimit: aiWhaleProfilesPolicy.marketLimit,
        windowDays: aiWhaleProfilesPolicy.windowDays,
        policy: aiWhaleProfilesPolicy,
      });
      console.log("[wallets:intel:refresh] whale profiles", result);
    }

    if (retention.skipCleanup) {
      console.log("[wallets:intel:refresh] cleanup skipped (--skip-cleanup)");
    } else if (retentionEnabled(retention)) {
      console.log(
        `[wallets:intel:refresh] cleanup retention snapshots=${retention.snapshotsDays ?? 0}d activity=${retention.activityDays ?? 0}d metrics=${retention.metricsDays ?? 0}d`,
      );
      const result = await cleanupWalletIntel(retention, runAt);
      console.log(
        `[wallets:intel:refresh] cleanup done snapshots=${result.snapshots} activity=${result.activity} metrics=${result.metrics}`,
      );
    } else {
      console.log("[wallets:intel:refresh] cleanup skipped (no retention)");
    }
  } finally {
    try {
      await releaseRefreshAdvisoryLock(lockClient);
    } finally {
      lockClient.release();
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[wallets:intel:refresh] failed", error);
    process.exit(1);
  });
