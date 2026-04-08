import type { PoolClient } from "pg";

import { ethers } from "ethers";
import { isAbortError, isRpcRateLimit } from "@hunch/shared";

import { pool } from "./db.js";
import { env } from "./env.js";
import { fetchMarketHolderData } from "./services/holders-core.js";
import { isRecord } from "./lib/type-guards.js";
import { limitlessRequest } from "./services/limitless-client.js";
import { fetchErc1155BalancesByOwner } from "./services/polygon-rpc.js";
import { inspectSafeWallet } from "./services/polymarket-funder.js";
import {
  fetchSolanaTokenBalancesByOwner,
  type SolanaTokenBalance,
} from "./services/solana-rpc.js";
import {
  estimateErc1155BalanceRpcCalls,
  prefetchFollowedPolymarketOwnerBalances,
  readPrefetchRpcTelemetry,
  syncPositionsForUserWallet,
  type PrefetchedPolymarketOwnerBalances,
} from "./services/positions-sync.js";
import {
  normalizeOutcomeSideForStorage,
  shouldSuppressLegacySideTransitionDelta,
} from "./services/wallet-intel-helpers.js";
import {
  createWalletIntelRetryTelemetry,
  type WalletIntelRetryTelemetry,
} from "./services/wallet-intel-retry.js";
import {
  makeWalletPositionLedgerKey,
  replayWalletPositionLedgerRows,
  type WalletPositionLedgerRow,
} from "./services/wallet-position-ledger.js";
import { buildWalletThirtyDayMetricsUpsertRows } from "./services/wallet-metrics-30d.js";
import { runWhaleProfiles } from "./services/whale-profiles.js";
import {
  getIntelPolicyDefaults,
  resolveAiWhaleProfilesPolicy,
  resolveWalletIntelRefreshPolicy,
  type AiWhaleProfilesPolicy,
  type WalletIntelRefreshPolicy,
} from "./services/runtime-policies.js";
import {
  NET_SHARES_EPSILON,
  resolveApproxYesMarkPrice,
} from "./services/wallet-intel-pnl.js";

type Chain = "polygon" | "base" | "solana";
type Venue = "polymarket" | "limitless" | "kalshi";
type WalletIntelRefreshTelemetry = {
  holdersPolymarket: WalletIntelRetryTelemetry;
  holdersAlchemyPolygon: WalletIntelRetryTelemetry;
  holdersAlchemyBase: WalletIntelRetryTelemetry;
  holdersSolana: WalletIntelRetryTelemetry;
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
let aiWhaleProfilesPolicy: AiWhaleProfilesPolicy = getIntelPolicyDefaults(
  "ai_whale_profiles",
);

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
    holdersSolana: createWalletIntelRetryTelemetry("holders_solana"),
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
    followedSnapshotBase: createWalletIntelRetryTelemetry("followed_snapshot_base"),
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
  if (summary.sampleWallets.length < 3 && !summary.sampleWallets.includes(wallet)) {
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
    bids: Array.isArray(data.bids) ? (data.bids as LimitlessOrderbook["bids"]) : [],
    asks: Array.isArray(data.asks) ? (data.asks as LimitlessOrderbook["asks"]) : [],
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
    prices: Array.isArray(data.prices) ? (data.prices as LimitlessMarketDetail["prices"]) : [],
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

  for (const row of rows.rows) {
    const hasPrice =
      row.best_bid != null || row.best_ask != null || row.last_price != null;
    if (hasPrice) continue;
    if (!row.slug) continue;

    let bestBid: number | null = null;
    let bestAsk: number | null = null;
    let lastPrice: number | null = null;

    const orderbook = await fetchLimitlessOrderbook(row.slug, telemetry ?? null);
    if (orderbook) {
      bestBid = parseLimitlessNumber(orderbook.bids?.[0]?.price ?? null);
      bestAsk = parseLimitlessNumber(orderbook.asks?.[0]?.price ?? null);
      lastPrice = parseLimitlessNumber(orderbook.lastTradePrice ?? null);
    }

    if (bestBid == null && bestAsk == null && lastPrice == null) {
      const detail = await fetchLimitlessMarketDetail(row.slug, telemetry ?? null);
      if (detail) {
        const tradeType =
          typeof detail.tradeType === "string" ? detail.tradeType : row.trade_type;
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

  return updated;
}


function isLimitlessSessionMissing(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("message" in error)) return false;
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

function parseOptionalArgInt(prefix: string): number | undefined {
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  if (!arg) return undefined;
  const raw = arg.slice(prefix.length);
  if (!raw.length) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

function normalizeRetentionDays(value: number | undefined | null): number | null {
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

function parseMetadataSource(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const source = record.source;
  return typeof source === "string" ? source : null;
}

type Queryable = Pick<PoolClient, "query">;

type WalletMetricsAggregateRow = {
  wallet_id: string;
  trades_count: number;
  volume_usd: string | null;
  last_trade_at: Date | null;
  resolved_count: number;
  winning_count: number;
};

type WalletMetricMarketRow = {
  id: string;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
  best_ask: string | null;
  best_bid: string | null;
  last_price: string | null;
};

type WalletMetricMarketMark = {
  resolvedOutcome: string | null;
  yesMarkPrice: number | null;
};

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function periodStart(asOf: Date, days: number | null): Date | null {
  if (days == null) return null;
  return new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000);
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
    params.push(
      `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, true)`,
    );
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
      const result = await client.query(
        `
          delete from wallet_position_snapshots
          where snapshot_at < $1
        `,
        [cutoff],
      );
      snapshots = result.rowCount ?? 0;
    }

    if (config.activityDays) {
      const cutoff = retentionCutoff(now, config.activityDays);
      const result = await client.query(
        `
          delete from wallet_activity_events
          where occurred_at < $1
        `,
        [cutoff],
      );
      activity = result.rowCount ?? 0;

      await client.query(
        `
          delete from wallet_activity_hourly
          where hour_bucket < $1
        `,
        [cutoff],
      );
    }

    if (config.metricsDays) {
      const cutoff = retentionCutoff(now, config.metricsDays);
      const result = await client.query(
        `
          delete from wallet_metrics_snapshots
          where as_of < $1
        `,
        [cutoff],
      );
      metrics = result.rowCount ?? 0;
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

  const estPolygonHoldingsRpcCalls =
    estimateErc1155BalanceRpcCalls(
      followedByChain.polygon,
      inputs.tokenIdsByVenue.polymarket,
    );
  const estBaseHoldingsRpcCalls =
    estimateErc1155BalanceRpcCalls(
      followedByChain.base,
      inputs.tokenIdsByVenue.limitless,
    );
  const estSolanaHoldingsRpcCalls =
    inputs.tokenIdsByVenue.kalshi.length > 0 ? followedByChain.solana : 0;
  inputs.telemetry.followedSnapshotPolygon.estimatedCalls +=
    followedByChain.polygon;
  inputs.telemetry.followedSnapshotBase.estimatedCalls += estBaseHoldingsRpcCalls;
  inputs.telemetry.followedSnapshotSolana.estimatedCalls +=
    estSolanaHoldingsRpcCalls;
  inputs.telemetry.followedPositionsPolymarket.estimatedCalls +=
    followedByChain.polygon;
  inputs.telemetry.followedPositionsLimitless.estimatedCalls += followedByChain.base;
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

  const prefetchedSolanaBalances = new Map<string, SolanaTokenBalance[] | null>();
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
    await mapWithConcurrency(
      polygonFollowedWallets,
      inputs.followedFetchConcurrency,
      async (followed) => {
        try {
          const prefetched = await runWithTelemetry(
            inputs.telemetry.followedPrefetchPolymarket,
            () =>
              prefetchFollowedPolymarketOwnerBalances(inputs.poolClient, {
                userId: followed.user_id,
                walletAddress: followed.address,
                trackedTokenIds: inputs.tokenIdsByVenue.polymarket,
              }),
            { countActualCall: false },
          );
          inputs.telemetry.followedPrefetchPolymarket.estimatedCalls +=
            prefetched.rpcCallEstimate;
          inputs.telemetry.followedPrefetchPolymarket.actualCalls +=
            prefetched.rpcCallCount;
          prefetchedPolymarketBalances.set(followed.wallet_id, prefetched);
        } catch (error) {
          prefetchedPolymarketBalances.set(followed.wallet_id, null);
          const rpcTelemetry = readPrefetchRpcTelemetry(error);
          inputs.telemetry.followedPrefetchPolymarket.estimatedCalls +=
            rpcTelemetry.estimatedCalls;
          inputs.telemetry.followedPrefetchPolymarket.actualCalls +=
            rpcTelemetry.actualCalls;
          if (
            !recordRetryableFailure(
              followedPrefetchPolymarketRetryable,
              followed.address,
              error,
            )
          ) {
            console.error(
              "[wallets:intel:refresh] prefetched polymarket balances failed",
              { wallet: followed.address },
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
        await runWithTelemetry(
          inputs.telemetry.followedPositionsKalshi,
          () =>
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
  const deltaResult = await applySnapshotDeltas(client, {
    walletIds: Array.from(inputs.touchedWalletIds),
    occurredAt: inputs.snapshotAt,
    marketIds: inputs.selectedMarketIds,
  });

  const walletIds = Array.from(inputs.touchedWalletIds);
  await refreshMetrics(client, {
    walletIds,
    asOf: inputs.snapshotAt,
  });

  await refreshSystemTags(client, {
    walletIds,
    tagIds: inputs.tagIds,
    freshDays: walletIntelRefreshPolicy.freshDays,
    dormantDays: walletIntelRefreshPolicy.dormantDays,
    whaleUsd: walletIntelRefreshPolicy.whaleUsd,
    whaleUsdSolana: walletIntelRefreshPolicy.whaleUsdSolana,
    asOf: inputs.snapshotAt,
  });

  const whaleRows = await client.query<{ wallet_id: string }>(
    `
      select tm.wallet_id
      from wallet_tag_map tm
      join wallet_tags t on t.id = tm.tag_id and t.slug = 'whale'
    `,
  );
  const aggregateWalletIds = Array.from(
    new Set([
      ...walletIds,
      ...whaleRows.rows.map((row) => row.wallet_id),
    ]),
  );

  const activityLookbackDays = 365;
  const activitySince = new Date(
    inputs.snapshotAt.getTime() - activityLookbackDays * 24 * 60 * 60 * 1000,
  );

  await refreshWalletActivityBaseline(client, {
    walletIds: aggregateWalletIds,
    asOf: inputs.snapshotAt,
    windowDays: 30,
  });
  await refreshWalletActivityHourly(client, {
    walletIds: aggregateWalletIds,
    since: activitySince,
    enteredLateHours: 24,
  });
  await refreshWalletPositionExposure(client, {
    walletIds: aggregateWalletIds,
    asOf: inputs.snapshotAt,
  });
  await refreshWalletInferredOutcomes(client, {
    walletIds: aggregateWalletIds,
  });

  return {
    deltaInserts: deltaResult.inserts,
    deltaUpdates: deltaResult.updates,
  };
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
    const sizeUsd =
      price != null ? Number((size * price).toFixed(6)) : null;

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

async function applySnapshotDeltas(
  client: Queryable,
  inputs: {
    walletIds: string[];
    occurredAt: Date;
    marketIds: string[];
  },
): Promise<{ inserts: number; updates: number }> {
  if (inputs.walletIds.length === 0 || inputs.marketIds.length === 0) {
    return { inserts: 0, updates: 0 };
  }

  const currentRows = await client.query<{
    wallet_id: string;
    venue: string;
    market_id: string;
    outcome_side: string | null;
    shares: string | null;
    price: string | null;
    metadata: unknown;
  }>(
    `
      select wallet_id, venue, market_id, outcome_side, shares, price, metadata
      from wallet_position_snapshots
      where wallet_id = any($1::uuid[])
        and snapshot_at = $2
        and market_id = any($3::text[])
    `,
    [inputs.walletIds, inputs.occurredAt, inputs.marketIds],
  );

  const prevRows = await client.query<{
    wallet_id: string;
    venue: string;
    market_id: string;
    outcome_side: string | null;
    shares: string | null;
    price: string | null;
    metadata: unknown;
  }>(
    `
      select distinct on (wallet_id, venue, market_id, outcome_side)
        wallet_id,
        venue,
        market_id,
        outcome_side,
        shares,
        price,
        metadata
      from wallet_position_snapshots
      where wallet_id = any($1::uuid[])
        and snapshot_at < $2
        and market_id = any($3::text[])
      order by wallet_id, venue, market_id, outcome_side, snapshot_at desc
    `,
    [inputs.walletIds, inputs.occurredAt, inputs.marketIds],
  );

  const prevWallets = new Set(prevRows.rows.map((row) => row.wallet_id));
  const currentMap = new Map<string, typeof currentRows.rows[number]>();
  const prevMap = new Map<string, typeof prevRows.rows[number]>();
  const currentRowsByMarket = new Map<
    string,
    Array<typeof currentRows.rows[number]>
  >();
  const prevRowsByMarket = new Map<string, Array<typeof prevRows.rows[number]>>();

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
  for (const row of prevRows.rows) {
    prevMap.set(makeKey(row), row);
    const marketKey = makeMarketKey(row);
    const list = prevRowsByMarket.get(marketKey) ?? [];
    list.push(row);
    prevRowsByMarket.set(marketKey, list);
  }

  const keys = new Set<string>([
    ...currentMap.keys(),
    ...prevMap.keys(),
  ]);
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
    const prevShares = legacyPrevious.shares ? Number(legacyPrevious.shares) : 0;
    if (!Number.isFinite(prevShares) || prevShares <= 0) continue;

    const snapshotSource = parseMetadataSource(legacyPrevious.metadata);
    await upsertWalletVenue(client, legacyPrevious.wallet_id, legacyPrevious.venue as Venue);
    await upsertWalletPositionSnapshot(client, {
      walletId: legacyPrevious.wallet_id,
      venue: legacyPrevious.venue,
      marketId: legacyPrevious.market_id,
      outcomeSide: legacyPrevious.outcome_side ?? null,
      shares: 0,
      sizeUsd: 0,
      price:
        legacyPrevious.price != null && Number.isFinite(Number(legacyPrevious.price))
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

  const inserts = 0;
  let updates = 0;

  for (const key of keys) {
    const current = currentMap.get(key);
    const previous = prevMap.get(key);
    const marketKey = current
      ? makeMarketKey(current)
      : previous
        ? makeMarketKey(previous)
        : null;
    if (marketKey && suppressedLegacyTransitionMarkets.has(marketKey)) continue;
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

  return { inserts, updates };
}

async function loadWalletMetricsAggregateRows(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
    since: Date | null;
  },
): Promise<WalletMetricsAggregateRow[]> {
  if (inputs.walletIds.length === 0) return [];

  const { rows } = await client.query<WalletMetricsAggregateRow>(
    `
      with base_events as (
        select
          wa.wallet_id,
          wa.market_id,
          upper(coalesce(wa.outcome_side, '')) as outcome_side,
          upper(coalesce(wa.action, '')) as action,
          coalesce(
            wa.size_usd,
            abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
          ) as notional_usd,
          wa.occurred_at
        from wallet_activity_events wa
        where wa.wallet_id = any($1::uuid[])
          and wa.activity_type in ('delta', 'trade')
          and wa.occurred_at <= $2::timestamptz
          and ($3::timestamptz is null or wa.occurred_at >= $3::timestamptz)
      )
      select
        b.wallet_id,
        count(*)::int as trades_count,
        sum(b.notional_usd) as volume_usd,
        max(b.occurred_at) as last_trade_at,
        count(*) filter (
          where upper(coalesce(um.resolved_outcome::text, '')) in ('YES', 'NO')
            and b.outcome_side in ('YES', 'NO')
            and b.action in ('OPENED', 'INCREASED', 'BUY', 'SELL')
        )::int as resolved_count,
        count(*) filter (
          where upper(coalesce(um.resolved_outcome::text, '')) in ('YES', 'NO')
            and b.outcome_side = upper(coalesce(um.resolved_outcome::text, ''))
            and b.action in ('OPENED', 'INCREASED', 'BUY', 'SELL')
        )::int as winning_count
      from base_events b
      left join unified_markets um on um.id = b.market_id
      group by b.wallet_id
    `,
    [inputs.walletIds, inputs.asOf, inputs.since],
  );

  return rows;
}

async function loadWalletMetricLedgerRows(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
    since: Date | null;
  },
): Promise<WalletPositionLedgerRow[]> {
  if (inputs.walletIds.length === 0) return [];

  const { rows } = await client.query<{
    wallet_id: string;
    market_id: string;
    outcome_side: string | null;
    action: string | null;
    delta_shares: string | null;
    size_usd: string | null;
    price: string | null;
    occurred_at: Date;
    created_at: Date | null;
    id: string;
  }>(
    `
      select
        wa.wallet_id,
        wa.market_id,
        upper(coalesce(wa.outcome_side, '')) as outcome_side,
        wa.action,
        wa.delta_shares::text as delta_shares,
        wa.size_usd::text as size_usd,
        wa.price::text as price,
        wa.occurred_at,
        wa.created_at,
        wa.id
      from wallet_activity_events wa
      where wa.wallet_id = any($1::uuid[])
        and wa.activity_type in ('delta', 'trade')
        and upper(coalesce(wa.outcome_side, '')) in ('YES', 'NO')
        and wa.occurred_at <= $2::timestamptz
        and ($3::timestamptz is null or wa.occurred_at >= $3::timestamptz)
      order by
        wa.wallet_id,
        wa.market_id,
        upper(coalesce(wa.outcome_side, '')),
        wa.occurred_at asc,
        wa.created_at asc nulls last,
        wa.id asc
    `,
    [inputs.walletIds, inputs.asOf, inputs.since],
  );

  return rows.map((row) => ({
    walletId: row.wallet_id,
    marketId: row.market_id,
    outcomeSide: row.outcome_side,
    action: row.action,
    deltaShares: row.delta_shares,
    sizeUsd: row.size_usd,
    price: row.price,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    id: row.id,
  }));
}

async function loadWalletMetricMarketMarkMap(
  client: Queryable,
  marketIds: string[],
): Promise<Map<string, WalletMetricMarketMark>> {
  const byMarket = new Map<string, WalletMetricMarketMark>();
  if (marketIds.length === 0) return byMarket;

  const { rows } = await client.query<WalletMetricMarketRow>(
    `
      select
        um.id,
        upper(coalesce(um.resolved_outcome::text, '')) as resolved_outcome,
        um.resolved_outcome_pct::text as resolved_outcome_pct,
        um.best_ask::text as best_ask,
        um.best_bid::text as best_bid,
        um.last_price::text as last_price
      from unified_markets um
      where um.id = any($1::text[])
    `,
    [marketIds],
  );

  for (const row of rows) {
    byMarket.set(row.id, {
      resolvedOutcome:
        row.resolved_outcome === "YES" || row.resolved_outcome === "NO"
          ? row.resolved_outcome
          : null,
      yesMarkPrice: resolveApproxYesMarkPrice({
        resolvedOutcome: row.resolved_outcome,
        resolvedOutcomePct: parseNumeric(row.resolved_outcome_pct),
        markPrice:
          parseNumeric(row.best_ask) ??
          parseNumeric(row.best_bid) ??
          parseNumeric(row.last_price),
      }),
    });
  }

  return byMarket;
}

async function refreshLedgerWindowMetrics(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
  } & {
    period: "1d" | "7d" | "30d" | "all";
    since: Date | null;
  },
): Promise<void> {
  const aggregates = await loadWalletMetricsAggregateRows(client, {
    walletIds: inputs.walletIds,
    asOf: inputs.asOf,
    since: inputs.since,
  });

  const ledgerRows = await loadWalletMetricLedgerRows(client, {
    walletIds: inputs.walletIds,
    asOf: inputs.asOf,
    since: inputs.since,
  });

  const ledgerRowsByKey = new Map<string, WalletPositionLedgerRow[]>();
  for (const row of ledgerRows) {
    const key = makeWalletPositionLedgerKey(
      row.walletId,
      row.marketId,
      row.outcomeSide,
    );
    const existing = ledgerRowsByKey.get(key) ?? [];
    existing.push(row);
    ledgerRowsByKey.set(key, existing);
  }

  const ledgersByWallet = new Map<
    string,
    Array<{
      marketId: string;
      outcomeSide: string | null;
      ledger: ReturnType<typeof replayWalletPositionLedgerRows>;
    }>
  >();
  const openMarketIds = new Set<string>();

  for (const rows of ledgerRowsByKey.values()) {
    const ledger = replayWalletPositionLedgerRows(rows);
    if (ledger.eventCount <= 0) continue;
    const first = rows[0];
    const existing = ledgersByWallet.get(first.walletId) ?? [];
    existing.push({
      marketId: first.marketId,
      outcomeSide: first.outcomeSide,
      ledger,
    });
    ledgersByWallet.set(first.walletId, existing);
    if (ledger.remainingShares > NET_SHARES_EPSILON) {
      openMarketIds.add(first.marketId);
    }
  }

  const marketMarksById = await loadWalletMetricMarketMarkMap(
    client,
    Array.from(openMarketIds),
  );

  const {
    rows: upsertRows,
    approximateWalletCount,
    unmarkedOpenLegCount,
  } = buildWalletThirtyDayMetricsUpsertRows({
    walletIds: inputs.walletIds,
    aggregates: aggregates.map((aggregate) => ({
      walletId: aggregate.wallet_id,
      tradesCount: aggregate.trades_count,
      volumeUsd: parseNumeric(aggregate.volume_usd),
      lastTradeAt: aggregate.last_trade_at,
      resolvedCount: aggregate.resolved_count,
      winningCount: aggregate.winning_count,
    })),
    ledgersByWallet,
    marketMarksById,
  });

  await client.query(
    `
      with upsert_rows as (
        select
          x.wallet_id::uuid as wallet_id,
          $2::text as period,
          $3::timestamptz as as_of,
          x.trades_count::int as trades_count,
          x.volume_usd::numeric as volume_usd,
          x.pnl_usd::numeric as pnl_usd,
          x.roi::numeric as roi,
          x.win_rate::numeric as win_rate,
          x.last_trade_at::timestamptz as last_trade_at
        from jsonb_to_recordset($1::jsonb) as x(
          wallet_id text,
          trades_count int,
          volume_usd text,
          pnl_usd text,
          roi text,
          win_rate text,
          last_trade_at text
        )
      )
      insert into wallet_metrics_snapshots (
        wallet_id,
        venue,
        period,
        as_of,
        trades_count,
        volume_usd,
        pnl_usd,
        roi,
        win_rate,
        last_trade_at
      )
      select
        wallet_id,
        null,
        period,
        as_of,
        trades_count,
        volume_usd,
        pnl_usd,
        roi,
        win_rate,
        last_trade_at
      from upsert_rows
      on conflict (wallet_id, venue, period, as_of)
      do update set
        trades_count = excluded.trades_count,
        volume_usd = excluded.volume_usd,
        pnl_usd = excluded.pnl_usd,
        roi = excluded.roi,
        win_rate = excluded.win_rate,
        last_trade_at = excluded.last_trade_at,
        updated_at = now()
    `,
    [
      JSON.stringify(
        upsertRows.map((row) => ({
          wallet_id: row.walletId,
          trades_count: row.tradesCount,
          volume_usd:
            row.volumeUsd != null ? String(row.volumeUsd) : null,
          pnl_usd: row.pnlUsd != null ? String(row.pnlUsd) : null,
          roi: row.roi != null ? String(row.roi) : null,
          win_rate: row.winRate != null ? String(row.winRate) : null,
          last_trade_at: row.lastTradeAt?.toISOString() ?? null,
        })),
      ),
      inputs.period,
      inputs.asOf,
    ],
  );

  if (approximateWalletCount > 0 || unmarkedOpenLegCount > 0) {
    console.warn(
      `[wallets:intel:refresh] ${inputs.period} pnl uses approximate ledger replay`,
      {
        walletCount: upsertRows.length,
        approximateWalletCount,
        unmarkedOpenLegCount,
      },
    );
  }
}

async function refreshOneDayMetrics(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
  },
): Promise<void> {
  await refreshLedgerWindowMetrics(client, {
    ...inputs,
    period: "1d",
    since: periodStart(inputs.asOf, 1),
  });
}

async function refreshSevenDayMetrics(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
  },
): Promise<void> {
  await refreshLedgerWindowMetrics(client, {
    ...inputs,
    period: "7d",
    since: periodStart(inputs.asOf, 7),
  });
}

async function refreshThirtyDayMetrics(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
  },
): Promise<void> {
  await refreshLedgerWindowMetrics(client, {
    ...inputs,
    period: "30d",
    since: periodStart(inputs.asOf, 30),
  });
}

async function refreshAllTimeMetrics(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
  },
): Promise<void> {
  await refreshLedgerWindowMetrics(client, {
    ...inputs,
    period: "all",
    since: null,
  });
}

async function refreshMetrics(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
  },
) {
  if (inputs.walletIds.length === 0) return;
  const periods: Array<"1d" | "7d" | "30d" | "all"> = [
    "1d",
    "7d",
    "30d",
    "all",
  ];

  for (const period of periods) {
    if (period === "1d") {
      await refreshOneDayMetrics(client, inputs);
      continue;
    }
    if (period === "7d") {
      await refreshSevenDayMetrics(client, inputs);
      continue;
    }
    if (period === "30d") {
      await refreshThirtyDayMetrics(client, inputs);
      continue;
    }
    if (period === "all") {
      await refreshAllTimeMetrics(client, inputs);
    }
  }
}

async function refreshWalletActivityBaseline(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
    windowDays: number;
  },
) {
  if (inputs.walletIds.length === 0) return;
  await client.query(
    `
      insert into wallet_activity_baseline (
        wallet_id,
        window_days,
        as_of,
        p50_usd,
        p90_usd
      )
      select
        wa.wallet_id,
        $2::int,
        $3::timestamptz,
        percentile_cont(0.5) within group (order by wa.size_usd) as p50_usd,
        percentile_cont(0.9) within group (order by wa.size_usd) as p90_usd
      from wallet_activity_events wa
      where wa.wallet_id = any($1::uuid[])
        and wa.activity_type in ('delta', 'trade')
        and wa.size_usd is not null
        and wa.occurred_at >= $3::timestamptz - ($2::text || ' days')::interval
        and wa.occurred_at <= $3::timestamptz
      group by wa.wallet_id
      on conflict (wallet_id, window_days)
      do update set
        p50_usd = excluded.p50_usd,
        p90_usd = excluded.p90_usd,
        as_of = excluded.as_of,
        updated_at = now()
    `,
    [inputs.walletIds, inputs.windowDays, inputs.asOf],
  );
}

async function refreshWalletActivityHourly(
  client: Queryable,
  inputs: {
    walletIds: string[];
    since: Date;
    enteredLateHours: number;
  },
) {
  if (inputs.walletIds.length === 0) return;
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
        where wa.wallet_id = any($1::uuid[])
          and wa.activity_type in ('delta', 'trade', 'holder')
          and wa.occurred_at >= $2::timestamptz
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
    [inputs.walletIds, inputs.since, inputs.enteredLateHours],
  );
}

async function refreshWalletPositionExposure(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
  },
) {
  if (inputs.walletIds.length === 0) return;
  await client.query(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      ),
      latest as (
        select
          ws.wallet_id,
          ws.venue,
          max(ws.snapshot_at) as snapshot_at
        from wallet_position_snapshots ws
        where ws.wallet_id = any($1::uuid[])
        group by ws.wallet_id, ws.venue
      ),
      latest_rows as (
        select
          ws.wallet_id,
          ws.market_id,
          case
            when upper(ws.outcome_side) in ('YES', 'NO') then upper(ws.outcome_side)
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
        where ws.wallet_id = any($1::uuid[])
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
    [inputs.walletIds, inputs.asOf],
  );
}

async function refreshWalletInferredOutcomes(
  client: Queryable,
  inputs: { walletIds: string[] },
) {
  if (inputs.walletIds.length === 0) return;
  await client.query(
    `
      with latest as (
        select distinct on (ws.wallet_id, ws.market_id, ws.outcome_side)
          ws.wallet_id,
          ws.market_id,
          ws.outcome_side,
          ws.shares
        from wallet_position_snapshots ws
        where ws.wallet_id = any($1::uuid[])
          and ws.shares > 0
        order by ws.wallet_id, ws.market_id, ws.outcome_side, ws.snapshot_at desc
      ),
      agg as (
        select
          wallet_id,
          market_id,
          sum(case when outcome_side = 'YES' then shares else 0 end) as yes_shares,
          sum(case when outcome_side = 'NO' then shares else 0 end) as no_shares
        from latest
        group by wallet_id, market_id
      ),
      resolved as (
        select
          agg.wallet_id,
          agg.market_id,
          agg.yes_shares,
          agg.no_shares,
          upper(m.resolved_outcome) as resolved_outcome
        from agg
        join unified_markets m on m.id = agg.market_id
        where m.resolved_outcome is not null
          and upper(m.resolved_outcome) in ('YES', 'NO')
      ),
      eligible as (
        select *
        from resolved
        where (yes_shares > 0 and coalesce(no_shares, 0) = 0)
           or (no_shares > 0 and coalesce(yes_shares, 0) = 0)
      ),
      summary as (
        select
          wallet_id,
          count(*) filter (
            where (resolved_outcome = 'YES' and yes_shares > 0 and no_shares = 0)
               or (resolved_outcome = 'NO' and no_shares > 0 and yes_shares = 0)
          )::int as wins,
          count(*)::int as total
        from eligible
        group by wallet_id
      )
      insert into wallet_inferred_outcomes (
        wallet_id,
        wins,
        total
      )
      select
        wallet_id,
        wins,
        total
      from summary
      on conflict (wallet_id)
      do update set
        wins = excluded.wins,
        total = excluded.total,
        updated_at = now()
    `,
    [inputs.walletIds],
  );
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
        from wallet_activity_events
        where wallet_id = w.id
          and activity_type in ('delta', 'trade')
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
      where wa.wallet_id = any($1::uuid[])
        and wa.activity_type in ('delta', 'trade', 'holder')
        and wa.size_usd is not null
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
    { slug: "dormant", walletIds: dormantRows.rows.map((row) => row.wallet_id) },
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

async function backfillDerivedWalletLabels(client: Queryable) {
  await client.query(
    `
      update wallets w
      set label = concat_ws(' ', src.label, '(Trading wallet)'),
          updated_at = now()
      from wallets src
      where w.label = concat_ws(' ', src.label, '(Safe)')
        and w.metadata->>'kind' = 'safe'
        and w.metadata->>'derivedFrom' = src.address
        and w.chain = src.chain
        and src.label is not null
    `,
  );

  await client.query(
    `
      update wallets w
      set label = concat_ws(' ', src.label, '(Signer wallet)'),
          updated_at = now()
      from wallets src
      where w.label = concat_ws(' ', src.label, '(Signer)')
        and w.metadata->>'kind' = 'safe_owner'
        and w.metadata->>'derivedFrom' = src.address
        and w.chain = src.chain
        and src.label is not null
    `,
  );

  await client.query(
    `
      update wallets w
      set label = concat_ws(' ', src.label, '(Trading wallet)'),
          updated_at = now()
      from wallets src
      where w.label is null
        and w.metadata->>'kind' = 'safe'
        and w.metadata->>'derivedFrom' = src.address
        and w.chain = src.chain
        and src.label is not null
    `,
  );

  await client.query(
    `
      update wallets w
      set label = concat_ws(' ', src.label, '(Signer wallet)'),
          updated_at = now()
      from wallets src
      where w.label is null
        and w.metadata->>'kind' = 'safe_owner'
        and w.metadata->>'derivedFrom' = src.address
        and w.chain = src.chain
        and src.label is not null
    `,
  );

  await client.query(
    `
      update wallets
      set label = 'Trading wallet (auto)',
          updated_at = now()
      where metadata->>'kind' = 'safe'
        and (label is null or label = 'Safe (auto)')
    `,
  );

  await client.query(
    `
      update wallets
      set label = 'Signer wallet (auto)',
          updated_at = now()
      where metadata->>'kind' = 'safe_owner'
        and (label is null or label = 'Signer (auto)')
    `,
  );
}

async function linkSafeOwnersForWhales(client: Queryable): Promise<number> {
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
    `,
  );

  const inspected = new Set<string>();
  let linked = 0;

  for (const row of whaleRows.rows) {
    const address = normalizeAddress(row.address, row.chain);
    if (!address) continue;
    if (inspected.has(address)) continue;
    inspected.add(address);

    const safeInfo = await inspectSafeWallet({ address });
    if (!safeInfo.safe || !safeInfo.owners || !safeInfo.threshold) {
      continue;
    }

    await client.query(
      `
        update wallets
        set metadata = coalesce(metadata, '{}'::jsonb) || $2,
            updated_at = now()
        where id = $1
      `,
      [
        row.id,
        {
          kind: "safe",
          owners: safeInfo.owners,
          threshold: safeInfo.threshold,
        },
      ],
    );

    if (safeInfo.owners.length !== 1) continue;
    const owner = normalizeAddress(safeInfo.owners[0], "polygon");
    if (!owner) continue;
    if (owner === address) continue;

    await upsertWalletWithMetadata(client, {
      address: owner,
      chain: "polygon",
      metadata: {
        kind: "safe_owner",
        derivedFrom: address,
        source: "whale_safe_owner",
      },
    });
    linked += 1;
  }

  return linked;
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
      where m.status = 'ACTIVE'
        and m.venue = 'polymarket'
      group by m.id, m.venue, m.volume_24h, m.liquidity
      order by ${
        mode === "hybrid"
          ? "(coalesce(sum(r.vol), 0) + 0.5 * coalesce(m.volume_24h, 0) + 0.3 * coalesce(m.liquidity, 0))"
          : "sum(r.vol)"
      } desc nulls last
      limit $2
    `,
    [hours, limit],
  );
  return result.rows;
}

async function selectPolymarketByMetric(
  client: Queryable,
  limit: number,
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
      where m.status = 'ACTIVE'
        and m.venue = 'polymarket'
      order by ${order}
      limit $1
    `,
    [limit],
  );
  return result.rows;
}

async function selectKalshiByTrade(
  client: Queryable,
  hours: number,
  limit: number,
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
      where m.status = 'ACTIVE'
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
    [hours, limit],
  );
  return result.rows;
}

async function selectKalshiByMetric(
  client: Queryable,
  limit: number,
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
      where m.status = 'ACTIVE'
        and m.venue = 'kalshi'
        and m.is_initialized is true
      order by ${order}
      limit $1
    `,
    [limit],
  );
  return result.rows;
}

async function selectLimitlessByMetric(
  client: Queryable,
  limit: number,
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
      where m.status = 'ACTIVE'
        and m.venue = 'limitless'
      order by ${order}
      limit $1
    `,
    [limit],
  );
  return result.rows;
}

async function selectMarketsPerVenue(
  client: Queryable,
  limitPoly: number,
  limitKalshi: number,
  limitLimitless: number,
): Promise<MarketPickRow[]> {
  const rows: MarketPickRow[] = [];
  const polyMode = walletIntelRefreshPolicy.selectionModePoly;
  const kalshiMode = walletIntelRefreshPolicy.selectionModeKalshi;
  const limitlessMode = walletIntelRefreshPolicy.selectionModeLimitless;

  if (limitPoly > 0) {
    if (polyMode === "trade_1h") {
      rows.push(...(await selectPolymarketByTrade(client, 1, limitPoly, "trade_1h")));
    } else if (polyMode === "trade_24h") {
      rows.push(...(await selectPolymarketByTrade(client, TRADE_WINDOW_HOURS, limitPoly, "trade_24h")));
    } else if (polyMode === "hybrid") {
      rows.push(...(await selectPolymarketByTrade(client, TRADE_WINDOW_HOURS, limitPoly, "hybrid")));
    } else if (polyMode === "volume_24h" || polyMode === "liquidity") {
      rows.push(...(await selectPolymarketByMetric(client, limitPoly, polyMode)));
    } else {
      rows.push(...(await selectPolymarketByTrade(client, TRADE_WINDOW_HOURS, limitPoly, "trade_24h")));
    }
  }

  if (limitKalshi > 0) {
    if (kalshiMode === "trade_1h") {
      rows.push(...(await selectKalshiByTrade(client, 1, limitKalshi, "trade_1h")));
    } else if (kalshiMode === "trade_24h") {
      rows.push(...(await selectKalshiByTrade(client, TRADE_WINDOW_HOURS, limitKalshi, "trade_24h")));
    } else if (kalshiMode === "hybrid") {
      rows.push(...(await selectKalshiByTrade(client, TRADE_WINDOW_HOURS, limitKalshi, "hybrid")));
    } else if (kalshiMode === "open_interest" || kalshiMode === "updated") {
      rows.push(...(await selectKalshiByMetric(client, limitKalshi, kalshiMode)));
    } else {
      rows.push(...(await selectKalshiByTrade(client, TRADE_WINDOW_HOURS, limitKalshi, "trade_24h")));
    }
  }

  if (limitLimitless > 0) {
    if (
      limitlessMode === "liquidity" ||
      limitlessMode === "updated" ||
      limitlessMode === "book" ||
      limitlessMode === "hybrid"
    ) {
      rows.push(...(await selectLimitlessByMetric(client, limitLimitless, limitlessMode)));
    } else {
      rows.push(...(await selectLimitlessByMetric(client, limitLimitless, "liquidity")));
    }
  }

  return rows;
}

async function runSnapshot(snapshotAt: Date) {
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
    `[wallets:intel:refresh] start markets=${marketLimit} holders=${holderLimit} snapshot=${snapshotAt.toISOString()} marketFetchConcurrency=${marketFetchConcurrency} followedFetchConcurrency=${followedFetchConcurrency}`,
  );

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '120s'");
    const tagIds = await ensureSystemTags(client);
    await backfillDerivedWalletLabels(client);

    const markets = await client.query<{ id: string; venue: string; volume_24h: number | null }>(
      `
        select id, venue, volume_24h
        from unified_markets
        where status = 'ACTIVE'
          and venue in ('polymarket', 'limitless', 'kalshi')
          and (venue != 'kalshi' or is_initialized is true)
          and coalesce(volume_24h, 0) >= $1
        order by volume_24h desc nulls last
        limit $2
      `,
      [walletIntelRefreshPolicy.minVolume24h, marketLimit],
    );

    const marketsPerVenueRows =
      marketLimitPerVenueMax > 0
        ? await selectMarketsPerVenue(
            client,
            marketLimitPerVenue,
            marketLimitKalshi,
            marketLimitPerVenue,
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
          where um.status = 'ACTIVE'
            and um.venue in ('polymarket', 'limitless', 'kalshi')
            and (um.venue != 'kalshi' or um.is_initialized is true)
        ) selected
        order by volume_24h desc nulls last
        limit $1
      `,
      [walletIntelRefreshPolicy.watchlistMarketLimit],
    );

    const whaleMarkets =
      walletIntelRefreshPolicy.whaleMarketLimit > 0
        ? await client.query<{
            id: string;
            venue: string;
            volume_24h: number | null;
          }>(
            `
              select distinct um.id, um.venue, um.volume_24h
              from wallet_position_snapshots ws
              join wallet_tag_map tm on tm.wallet_id = ws.wallet_id
              join wallet_tags t on t.id = tm.tag_id and t.slug = 'whale'
              join unified_markets um on um.id = ws.market_id
              where um.status = 'ACTIVE'
                and um.venue in ('polymarket', 'limitless', 'kalshi')
                and (um.venue != 'kalshi' or um.is_initialized is true)
              order by um.volume_24h desc nulls last
              limit $1
            `,
            [walletIntelRefreshPolicy.whaleMarketLimit],
          )
        : { rows: [] };

    const marketMap = new Map<string, { id: string; venue: string; volume_24h: number | null }>();
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
    console.log(
      "[wallets:intel:refresh] market selection",
      {
        selected: marketRows.length,
        base: markets.rows.length,
        perVenue: marketsPerVenueRows.length,
        watchlist: watchlistMarkets.rows.length,
        whale: whaleMarkets.rows.length,
      },
    );
    const selectedMarketIds = marketRows.map((row) => row.id);
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

    const marketResults = await mapWithConcurrency(
      marketRows,
      marketFetchConcurrency,
      async (market) => {
        const chain = VENUE_CHAIN[market.venue] ?? null;
        if (!chain) {
          return { market, chain, data: null, error: null };
        }
        try {
          const data = await fetchMarketHolderData({
            marketId: market.id,
            limit: holderLimit,
            telemetry: {
              holdersPolymarket: telemetry.holdersPolymarket,
              holdersAlchemyPolygon: telemetry.holdersAlchemyPolygon,
              holdersAlchemyBase: telemetry.holdersAlchemyBase,
              holdersSolana: telemetry.holdersSolana,
            },
          });
          return { market, chain, data, error: null };
        } catch (error) {
          return { market, chain, data: null, error };
        }
      },
    );

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

      const maybeAddToken = (
        tokenId: string | null,
        side: "YES" | "NO",
      ) => {
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

        const upsertHolderSide = async (
          side: "YES" | "NO",
          shares: number,
        ) => {
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
    logRefreshTelemetry(telemetry);

    console.log(
      `[wallets:intel:refresh] done markets=${marketsProcessed} wallets=${touchedWalletIds.size} rows=${activityRows} followed=${followedProcessed} followedRows=${followedRows} deltaInserts=${deltaInserts} deltaUpdates=${deltaUpdates} whaleOwnersLinked=${whaleOwnersLinked}`,
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
    const baseSnapshot = bucketDate(runAt, walletIntelRefreshPolicy.snapshotHours);
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
        console.log("[wallets:intel:refresh] cleanup-only skipped (--skip-cleanup)");
        return;
      }
      if (!retentionEnabled(retention)) {
        console.log("[wallets:intel:refresh] cleanup-only skipped (no retention)");
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
