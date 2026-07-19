import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";

import { resolveTerminalTokenPrices } from "@hunch/db";
import { requestFreshMarketPrices, type PriceRefreshRedis } from "@hunch/infra";
import { ethers } from "ethers";
import { chunkArray, isAbortError, isRpcRateLimit } from "@hunch/shared";

import { pool } from "./db.js";
import { env } from "./env.js";
import { getRedis } from "./redis.js";
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
  fetchWalletLiquidBalancesPartial,
  inspectPolymarketWalletIdentity,
  isWalletOnchainIdentityErrorFresh,
  resolveUsdLikeBalance,
  resolveWalletOnchainStateVenueQuotas,
  selectWalletOnchainStateCandidatesFromRanked,
  type PolymarketWalletKind,
  type WalletOnchainBalances,
  type WalletOwnerConfidence,
  type WalletOwnerSource,
} from "./services/wallet-onchain-state.js";
import {
  fetchSolanaTokenBalancesByOwner,
  type SolanaTokenBalance,
} from "./services/solana-rpc.js";
import {
  estimateErc1155BalanceRpcCalls,
  estimateErc1155OwnerTokenPairRpcCalls,
  extractLimitlessTokenBalances,
  fetchPolymarketDataApiPositionSnapshots,
  isLimitlessPublicPortfolioUserNotFound,
  prefetchPolymarketOwnerBalancesForWallets,
  readPrefetchRpcTelemetry,
  syncPositionsForUserWallet,
  type PolymarketErc1155BalanceCache,
  type PrefetchedPolymarketOwnerBalances,
} from "./services/positions-sync.js";
import { markHotTokens } from "./lib/hot-tokens.js";
import { normalizeLimitlessScopedTokenId } from "./lib/limitless-token.js";
import { requestPriceRefreshForTokens } from "./lib/price-refresh.js";
import {
  normalizeOutcomeSideForStorage,
  shouldSuppressLegacySideTransitionDelta,
} from "./services/wallet-intel-helpers.js";
import {
  buildSnapshotDeltaTrackableActivitySql,
  buildWalletIntelTrackableMarketSql,
} from "./services/wallet-intel-market-eligibility.js";
import { loadWalletOpenPositionStatsMap } from "./services/wallet-open-position-stats.js";
import {
  createWalletIntelRetryTelemetry,
  type WalletIntelRetryTelemetry,
} from "./services/wallet-intel-retry.js";
import { refreshWalletMetrics } from "./services/wallet-metrics-refresh.js";
import { buildWalletFinalOutcomeSampleActionSql } from "./services/wallet-final-outcome-samples.js";
import { resolveWalletIdentityNames } from "./services/wallet-identity-names.js";
import { runWhaleProfiles } from "./services/whale-profiles.js";
import { refreshWalletSpecialistAttribution } from "./services/wallet-attribution.js";
import {
  getIntelPolicyDefaults,
  resolveAiWhaleProfilesPolicy,
  resolveWalletIntelAttributionPolicy,
  resolveWalletIntelRefreshPolicy,
  type AiWhaleProfilesPolicy,
  type WalletIntelAttributionPolicy,
  type WalletIntelRefreshPolicy,
} from "./services/runtime-policies.js";
import {
  resolveLiveIntelVenueScope,
  type LiveIntelVenue,
  type LiveIntelVenueScope,
} from "./services/venue-lifecycle.js";
import {
  buildInternalHunchFillActivityEvents,
  shouldSuppressInternalHunchSnapshotDelta,
  type InternalHunchFillActivityInput,
  type InternalHunchFillInitialShares,
} from "./services/wallet-intel-internal-hunch.js";
import {
  upsertWalletTrackingSubjects,
  type WalletTrackingSubjectInput,
} from "./services/wallet-tracking-subjects.js";

type Chain = "polygon" | "base" | "solana";
type Venue = LiveIntelVenue;
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

class WalletIntelStageTimeoutError extends Error {
  stage: string;
  timeoutMs: number;
  metadata: Record<string, unknown>;

  constructor(
    stage: string,
    timeoutMs: number,
    metadata: Record<string, unknown> = {},
  ) {
    super(`Wallet intel stage "${stage}" timed out after ${timeoutMs}ms`);
    this.name = "WalletIntelStageTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
    this.metadata = metadata;
  }
}

function isWalletIntelStageTimeoutError(
  error: unknown,
): error is WalletIntelStageTimeoutError {
  return error instanceof WalletIntelStageTimeoutError;
}

function unrefTimer(timeout: ReturnType<typeof setTimeout>) {
  if (
    typeof timeout === "object" &&
    timeout != null &&
    "unref" in timeout &&
    typeof timeout.unref === "function"
  ) {
    timeout.unref();
  }
}

async function withWalletIntelDeadline<T>(
  stage: string,
  timeoutMs: number,
  fn: () => Promise<T>,
  metadata: Record<string, unknown> = {},
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fn();
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new WalletIntelStageTimeoutError(stage, timeoutMs, metadata));
    }, timeoutMs);
    unrefTimer(timeout);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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

export type TokenIndexEntry = {
  marketId: string;
  venue: Venue;
  tokenId: string;
  side: "YES" | "NO";
  price: number | null;
  priceFresh?: boolean;
  priceSource?: "top_of_book" | "legacy_fallback" | "terminal" | null;
  priceUpdatedAt?: string | null;
};

type InternalHunchWalletRow = {
  user_id: string;
  wallet_address: string;
  venue: Venue;
  chain: Chain;
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

export type WalletIntelRefreshCliArgs = {
  autoTrackedFreshPriceCheckEnabled: boolean | null;
  autoTrackedWalletFetchConcurrency: number | null;
  autoTrackedWalletAttemptBackoffMinutes: number | null;
  autoTrackedSubjectTtlDays: number | null;
  autoTrackedWalletEnabled: boolean | null;
  autoTrackedWalletLimit: number | null;
  autoTrackedWalletRefreshHours: number | null;
  followedFetchConcurrency: number | null;
  freshPriceMaxAgeMs: number | null;
  freshPriceTimeoutMs: number | null;
  holderLimit: number | null;
  ignoreRuntimePolicy: boolean;
  marketFetchConcurrency: number | null;
  printEffectivePolicy: boolean;
};

function parseCliPositiveInt(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer.`);
  }
  return Math.trunc(parsed);
}

function parseCliNonNegativeInt(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer.`);
  }
  return Math.trunc(parsed);
}

function clampCliConcurrency(value: number | null, fallback: number): number {
  const resolved = value ?? fallback;
  return Math.min(8, Math.max(1, Math.trunc(resolved)));
}

function parseCliBoolean(name: string, raw: string | undefined): boolean {
  if (raw == null || raw === "") return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`Invalid ${name}: expected true or false.`);
}

export function parseWalletIntelRefreshCliArgs(
  argv: string[] = process.argv.slice(2),
): WalletIntelRefreshCliArgs {
  const parsed: WalletIntelRefreshCliArgs = {
    autoTrackedFreshPriceCheckEnabled: null,
    autoTrackedWalletFetchConcurrency: null,
    autoTrackedWalletAttemptBackoffMinutes: null,
    autoTrackedSubjectTtlDays: null,
    autoTrackedWalletEnabled: null,
    autoTrackedWalletLimit: null,
    autoTrackedWalletRefreshHours: null,
    followedFetchConcurrency: null,
    freshPriceMaxAgeMs: null,
    freshPriceTimeoutMs: null,
    holderLimit: null,
    ignoreRuntimePolicy: false,
    marketFetchConcurrency: null,
    printEffectivePolicy: false,
  };

  for (const arg of argv) {
    if (arg === "--ignore-runtime-policy") {
      parsed.ignoreRuntimePolicy = true;
      continue;
    }
    if (arg === "--print-effective-policy") {
      parsed.printEffectivePolicy = true;
      continue;
    }
    const [name, value] = arg.split("=", 2);
    if (name === "--auto-tracked-wallets") {
      parsed.autoTrackedWalletEnabled = parseCliBoolean(name, value);
      continue;
    }
    if (name === "--auto-tracked-fresh-price-check") {
      parsed.autoTrackedFreshPriceCheckEnabled = parseCliBoolean(name, value);
      continue;
    }
    if (value == null) continue;
    if (name === "--holder-limit") {
      parsed.holderLimit = parseCliPositiveInt(name, value);
    } else if (name === "--market-fetch-concurrency") {
      parsed.marketFetchConcurrency = parseCliPositiveInt(name, value);
    } else if (name === "--followed-fetch-concurrency") {
      parsed.followedFetchConcurrency = parseCliPositiveInt(name, value);
    } else if (name === "--auto-tracked-wallet-limit") {
      parsed.autoTrackedWalletLimit = parseCliNonNegativeInt(name, value);
    } else if (name === "--auto-tracked-wallet-refresh-hours") {
      parsed.autoTrackedWalletRefreshHours = parseCliPositiveInt(name, value);
    } else if (name === "--auto-tracked-wallet-fetch-concurrency") {
      parsed.autoTrackedWalletFetchConcurrency = parseCliPositiveInt(
        name,
        value,
      );
    } else if (name === "--auto-tracked-attempt-backoff-minutes") {
      parsed.autoTrackedWalletAttemptBackoffMinutes = parseCliPositiveInt(
        name,
        value,
      );
    } else if (name === "--auto-tracked-subject-ttl-days") {
      parsed.autoTrackedSubjectTtlDays = parseCliNonNegativeInt(name, value);
    } else if (name === "--fresh-price-max-age-ms") {
      parsed.freshPriceMaxAgeMs = parseCliPositiveInt(name, value);
    } else if (name === "--fresh-price-timeout-ms") {
      parsed.freshPriceTimeoutMs = parseCliNonNegativeInt(name, value);
    }
  }

  return parsed;
}

export function applyWalletIntelRefreshCliArgs(
  policy: WalletIntelRefreshPolicy,
  args: WalletIntelRefreshCliArgs,
): WalletIntelRefreshPolicy {
  return {
    ...policy,
    autoTrackedFreshPriceCheckEnabled:
      args.autoTrackedFreshPriceCheckEnabled ??
      policy.autoTrackedFreshPriceCheckEnabled,
    autoTrackedWalletFetchConcurrency: clampCliConcurrency(
      args.autoTrackedWalletFetchConcurrency,
      policy.autoTrackedWalletFetchConcurrency,
    ),
    autoTrackedWalletAttemptBackoffMinutes:
      args.autoTrackedWalletAttemptBackoffMinutes ??
      policy.autoTrackedWalletAttemptBackoffMinutes,
    autoTrackedSubjectTtlDays:
      args.autoTrackedSubjectTtlDays ?? policy.autoTrackedSubjectTtlDays,
    autoTrackedWalletEnabled:
      args.autoTrackedWalletEnabled ?? policy.autoTrackedWalletEnabled,
    autoTrackedWalletLimit:
      args.autoTrackedWalletLimit ?? policy.autoTrackedWalletLimit,
    autoTrackedWalletRefreshHours:
      args.autoTrackedWalletRefreshHours ??
      policy.autoTrackedWalletRefreshHours,
    followedFetchConcurrency: clampCliConcurrency(
      args.followedFetchConcurrency,
      policy.followedFetchConcurrency,
    ),
    freshPriceMaxAgeMs: Math.max(
      1,
      Math.trunc(args.freshPriceMaxAgeMs ?? policy.freshPriceMaxAgeMs),
    ),
    freshPriceTimeoutMs: Math.max(
      0,
      Math.trunc(args.freshPriceTimeoutMs ?? policy.freshPriceTimeoutMs),
    ),
    holderLimit: args.holderLimit ?? policy.holderLimit,
    marketFetchConcurrency: clampCliConcurrency(
      args.marketFetchConcurrency,
      policy.marketFetchConcurrency,
    ),
  };
}

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

function walletVenueSnapshotKey(walletId: string, venue: Venue) {
  return `${walletId}:${venue}`;
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

function buildTokenIndexLookupTokenIds(
  venue: Venue,
  normalizedTokenIds: string[],
): string[] {
  const lookup = new Set<string>();
  for (const tokenId of normalizedTokenIds) {
    lookup.add(tokenId);
    if (venue === "limitless") {
      lookup.add(`limitless:${tokenId}`);
    } else if (venue === "kalshi") {
      lookup.add(`sol:${tokenId}`);
      lookup.add(`kalshi:${tokenId}`);
    }
  }
  return Array.from(lookup);
}

function addTokenIndexEntry(
  tokenIndexByVenue: Record<Venue, Map<string, TokenIndexEntry>>,
  tokenIdsByVenue: Record<Venue, string[]>,
  inputs: {
    marketId: string;
    price: number | null;
    side: "YES" | "NO";
    tokenId: string | null;
    venue: Venue;
  },
): string | null {
  const onchainTokenId = normalizeOnchainTokenId(inputs.venue, inputs.tokenId);
  if (!onchainTokenId) return null;
  const bucket = tokenIndexByVenue[inputs.venue];
  if (!bucket.has(onchainTokenId)) {
    bucket.set(onchainTokenId, {
      marketId: inputs.marketId,
      venue: inputs.venue,
      tokenId: inputs.tokenId ?? onchainTokenId,
      side: inputs.side,
      price: inputs.price,
    });
    tokenIdsByVenue[inputs.venue].push(onchainTokenId);
  }
  return onchainTokenId;
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

export function capWalletIntelSelectedTokenUniverse(
  tokenIdsByVenue: Record<Venue, string[]>,
  tokenIndexByVenue: Record<Venue, Map<string, TokenIndexEntry>>,
  policy: Pick<
    WalletIntelRefreshPolicy,
    "tokenLimitPoly" | "tokenLimitLimitless" | "tokenLimitKalshi"
  >,
): {
  tokenIdsByVenue: Record<Venue, string[]>;
  tokenIndexByVenue: Record<Venue, Map<string, TokenIndexEntry>>;
} {
  const limits: Record<Venue, number> = {
    polymarket: Math.max(1, Math.trunc(policy.tokenLimitPoly)),
    limitless: Math.max(1, Math.trunc(policy.tokenLimitLimitless)),
    kalshi: Math.max(1, Math.trunc(policy.tokenLimitKalshi)),
  };
  const cappedIds: Record<Venue, string[]> = {
    polymarket: [],
    limitless: [],
    kalshi: [],
  };
  const cappedIndex: Record<Venue, Map<string, TokenIndexEntry>> = {
    polymarket: new Map(),
    limitless: new Map(),
    kalshi: new Map(),
  };

  for (const venue of ["polymarket", "limitless", "kalshi"] as Venue[]) {
    const ids = tokenIdsByVenue[venue].slice(0, limits[venue]);
    cappedIds[venue] = ids;
    for (const tokenId of ids) {
      const entry = tokenIndexByVenue[venue].get(tokenId);
      if (entry) cappedIndex[venue].set(tokenId, entry);
    }
  }

  return { tokenIdsByVenue: cappedIds, tokenIndexByVenue: cappedIndex };
}

async function requestFreshWalletIntelMarketPrices(
  client: PoolClient,
  marketRows: Array<{ id: string }>,
): Promise<void> {
  if (!env.priceRefreshQueueEnabled || marketRows.length === 0) return;
  const maxTokens =
    walletIntelRefreshPolicy.tokenLimitPoly +
    walletIntelRefreshPolicy.tokenLimitLimitless +
    walletIntelRefreshPolicy.tokenLimitKalshi;
  if (maxTokens <= 0) return;

  const requestedAt = new Date();
  try {
    const redis = await getRedis();
    if (!redis) {
      console.log("[wallets:intel:refresh] fresh price check skipped", {
        reason: "redis_unavailable",
      });
      return;
    }
    const result = await requestFreshMarketPrices({
      db: client,
      enqueue: true,
      marketIds: marketRows.map((row) => row.id),
      maxFreshAgeMs: walletIntelRefreshPolicy.freshPriceMaxAgeMs,
      maxTokens,
      minFreshAt: requestedAt,
      pollMs: 1_000,
      priority: "high",
      redis: redis as unknown as PriceRefreshRedis,
      timeoutMs: walletIntelRefreshPolicy.freshPriceTimeoutMs,
    });
    console.log("[wallets:intel:refresh] fresh price check", {
      enqueued: result.enqueued,
      fresh: result.freshTokenIds.length,
      markets: result.marketStates.size,
      maxAgeMs: walletIntelRefreshPolicy.freshPriceMaxAgeMs,
      requested: result.requestedTokenIds.length,
      stale: Math.max(
        0,
        result.requestedTokenIds.length - result.freshTokenIds.length,
      ),
      timedOut: result.timedOut,
      timeoutMs: walletIntelRefreshPolicy.freshPriceTimeoutMs,
    });
  } catch (error) {
    console.warn("[wallets:intel:refresh] fresh price check skipped", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function requestFreshWalletIntelTokenPrices(
  client: Queryable,
  inputs: {
    label: string;
    tokenEntries: TokenIndexEntry[];
  },
): Promise<void> {
  if (
    !walletIntelRefreshPolicy.autoTrackedFreshPriceCheckEnabled ||
    !env.priceRefreshQueueEnabled ||
    inputs.tokenEntries.length === 0
  ) {
    return;
  }

  const tokenRefsByKey = new Map<
    string,
    { marketId: string; side: "YES" | "NO"; tokenId: string; venue: Venue }
  >();
  for (const entry of inputs.tokenEntries) {
    if (!entry.tokenId) continue;
    tokenRefsByKey.set(`${entry.venue}:${entry.tokenId}`, {
      marketId: entry.marketId,
      side: entry.side,
      tokenId: entry.tokenId,
      venue: entry.venue,
    });
  }
  const tokenRefs = Array.from(tokenRefsByKey.values());
  if (tokenRefs.length === 0) return;

  const requestedAt = new Date();
  try {
    const redis = await getRedis();
    if (!redis) {
      console.log("[wallets:intel:refresh] auto-tracked fresh price skipped", {
        label: inputs.label,
        reason: "redis_unavailable",
        requested: tokenRefs.length,
      });
      return;
    }
    const result = await requestFreshMarketPrices({
      db: client,
      enqueue: true,
      maxFreshAgeMs: walletIntelRefreshPolicy.freshPriceMaxAgeMs,
      maxTokens: tokenRefs.length,
      minFreshAt: requestedAt,
      pollMs: 1_000,
      priority: "high",
      redis: redis as unknown as PriceRefreshRedis,
      timeoutMs: walletIntelRefreshPolicy.freshPriceTimeoutMs,
      tokenRefs,
    });
    console.log("[wallets:intel:refresh] auto-tracked fresh price check", {
      label: inputs.label,
      enqueued: result.enqueued,
      fresh: result.freshTokenIds.length,
      markets: result.marketStates.size,
      maxAgeMs: walletIntelRefreshPolicy.freshPriceMaxAgeMs,
      requested: result.requestedTokenIds.length,
      stale: Math.max(
        0,
        result.requestedTokenIds.length - result.freshTokenIds.length,
      ),
      timedOut: result.timedOut,
      timeoutMs: walletIntelRefreshPolicy.freshPriceTimeoutMs,
    });
  } catch (error) {
    console.warn("[wallets:intel:refresh] auto-tracked fresh price skipped", {
      label: inputs.label,
      requested: tokenRefs.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseMetadataSource(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const source = record.source;
  return typeof source === "string" ? source : null;
}

type Queryable = Pick<PoolClient, "query">;

const hiddenOwnPositionSnapshotSuppressionCache = new Map<string, boolean>();

function parseSnapshotMetadataTokenId(
  metadata: Record<string, unknown>,
): string | null {
  const tokenId = metadata.tokenId;
  if (typeof tokenId !== "string") return null;
  const trimmed = tokenId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function shouldSuppressHiddenOwnPositionSnapshot(
  client: Queryable,
  inputs: { walletId: string; venue: string; tokenId: string | null },
): Promise<boolean> {
  if (!inputs.tokenId) return false;
  const cacheKey = `${inputs.walletId}:${inputs.venue}:${inputs.tokenId}`;
  const cached = hiddenOwnPositionSnapshotSuppressionCache.get(cacheKey);
  if (cached != null) return cached;

  const result = await client.query<{ suppressed: boolean }>(
    `
      select exists (
        select 1
        from wallets w
        join positions hp
          on hp.position_scope = 'own'
         and hp.is_hidden = true
         and hp.venue = $2
         and hp.token_id = $3
         and hp.wallet_address is not null
         and btrim(hp.wallet_address) <> ''
         and (
           (
             w.chain = 'solana'
             and hp.wallet_address = w.address
           )
           or (
             w.chain <> 'solana'
             and lower(hp.wallet_address) = lower(w.address)
           )
         )
        where w.id = $1
      ) as suppressed
    `,
    [inputs.walletId, inputs.venue, inputs.tokenId],
  );
  const suppressed = result.rows[0]?.suppressed === true;
  hiddenOwnPositionSnapshotSuppressionCache.set(cacheKey, suppressed);
  return suppressed;
}

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

async function upsertWalletIdentityOnly(
  client: Queryable,
  inputs: { address: string; chain: Chain; metadata: Record<string, unknown> },
): Promise<string> {
  if (inputs.chain !== "solana" && isZeroEvmWalletAddress(inputs.address)) {
    throw new Error("Refusing to persist zero EVM wallet address");
  }
  const result = await client.query<{ id: string }>(
    `
      insert into wallets (address, chain, metadata)
      values ($1, $2, $3)
      on conflict (address, chain)
      do update set
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
): Promise<boolean> {
  const tokenId = parseSnapshotMetadataTokenId(inputs.metadata);
  if (
    await shouldSuppressHiddenOwnPositionSnapshot(client, {
      walletId: inputs.walletId,
      venue: inputs.venue,
      tokenId,
    })
  ) {
    return false;
  }

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
  return true;
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
    occurredAt: Date | string;
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

export async function snapshotFollowedWalletHoldingsEvm(
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
    metadataSource?: string;
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

      const snapshotInserted = await upsertWalletPositionSnapshot(client, {
        walletId: inputs.walletId,
        venue: entry.venue,
        marketId: entry.marketId,
        outcomeSide: entry.side,
        shares,
        sizeUsd,
        price: entry.price,
        metadata: {
          source: inputs.metadataSource ?? "followed_wallet",
          tokenId: entry.tokenId,
          onchainTokenId: balance.tokenId,
          shares,
        },
        snapshotAt: inputs.occurredAt,
      });

      if (snapshotInserted) inserted += 1;
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

type AutoTrackedWalletSource =
  | "recent_top_holder"
  | "signal_candidate"
  | "whale";

type AutoTrackedWalletRow = {
  wallet_id: string;
  address: string;
  chain: Chain;
  venue: Venue;
  sources: AutoTrackedWalletSource[];
  priority: number;
};

type AutoTrackedPreviousOpenPositionRow = {
  wallet_id: string;
  venue: Venue;
  market_id: string;
  outcome_side: "YES" | "NO";
  token_id: string;
  price: string | null;
};

type RecentTopHolderTrackingCandidate = {
  walletId: string;
  venue: Venue;
  marketId: string;
  side: "YES" | "NO";
  sizeUsd: number;
  shares: number;
  snapshotAt: Date;
};

type FollowedCollectionResult = {
  processed: number;
  rowInserts: number;
  activityRows: number;
};

type AutoTrackedCollectionResult = {
  processed: number;
  rowInserts: number;
  activityRows: number;
  marketIds: string[];
  previousOpenMarketKeys: SnapshotDeltaMarketKey[];
  attemptedWallets: AutoTrackedWalletRow[];
  refreshedWallets: AutoTrackedWalletRow[];
};

export function dedupeFollowedWalletRowsForSnapshotWork<
  T extends { chain: string; wallet_id: string },
>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    const key = `${row.wallet_id}:${row.chain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

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
    snapshottedWalletVenueKeys: Set<string>;
    poolClient: typeof pool;
  },
): Promise<FollowedCollectionResult> {
  const followedSnapshotWallets = dedupeFollowedWalletRowsForSnapshotWork(
    inputs.followedWallets,
  );
  const followedByChain = { polygon: 0, base: 0, solana: 0 };
  for (const followed of inputs.followedWallets) {
    followedByChain[followed.chain] += 1;
  }
  const followedSnapshotByChain = { polygon: 0, base: 0, solana: 0 };
  for (const followed of followedSnapshotWallets) {
    followedSnapshotByChain[followed.chain] += 1;
  }

  const estPolygonHoldingsRpcCalls = estimateErc1155OwnerTokenPairRpcCalls(
    followedSnapshotByChain.polygon,
    inputs.tokenIdsByVenue.polymarket,
  );
  const estBaseHoldingsRpcCalls = estimateErc1155BalanceRpcCalls(
    followedSnapshotByChain.base,
    inputs.tokenIdsByVenue.limitless,
  );
  const estSolanaHoldingsRpcCalls =
    inputs.tokenIdsByVenue.kalshi.length > 0
      ? followedSnapshotByChain.solana
      : 0;
  inputs.telemetry.followedSnapshotPolygon.estimatedCalls +=
    followedSnapshotByChain.polygon;
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
    followedSnapshotWallets: followedSnapshotWallets.length,
    followedByChain,
    followedSnapshotByChain,
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
  const polymarketPrefetchBalanceCache: PolymarketErc1155BalanceCache =
    new Map();
  const polymarketPrefetchTimedOutWalletIds = new Set<string>();
  let followedSnapshotsSkippedAlreadyCollected = 0;

  const solanaSnapshotWallets = followedSnapshotWallets.filter(
    (row) => row.chain === "solana",
  );
  if (
    solanaSnapshotWallets.length > 0 &&
    inputs.tokenIdsByVenue.kalshi.length > 0
  ) {
    await mapWithConcurrency(
      solanaSnapshotWallets,
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

  const polygonSnapshotWallets = followedSnapshotWallets.filter(
    (row) => row.chain === "polygon",
  );
  if (polygonSnapshotWallets.length > 0) {
    const byUser = new Map<string, FollowedWalletRow[]>();
    for (const followed of polygonSnapshotWallets) {
      const rows = byUser.get(followed.user_id) ?? [];
      rows.push(followed);
      byUser.set(followed.user_id, rows);
    }

    await mapWithConcurrency(
      Array.from(byUser.entries()),
      inputs.followedFetchConcurrency,
      async ([userId, followedRows]) => {
        const startedAt = Date.now();
        console.log(
          "[wallets:intel:refresh] followed polymarket prefetch start",
          {
            userId,
            wallets: followedRows.length,
          },
        );
        try {
          const prefetched = await runWithTelemetry(
            inputs.telemetry.followedPrefetchPolymarket,
            () =>
              withWalletIntelDeadline(
                "followedPolymarketPrefetch",
                env.walletIntelFollowedPrefetchTimeoutMs,
                () =>
                  prefetchPolymarketOwnerBalancesForWallets(inputs.poolClient, {
                    userId,
                    walletAddresses: followedRows.map((row) => row.address),
                    trackedTokenIds: inputs.tokenIdsByVenue.polymarket,
                    balanceCache: polymarketPrefetchBalanceCache,
                  }),
                {
                  userId,
                  wallets: followedRows.length,
                },
              ),
            { countActualCall: false },
          );
          inputs.telemetry.followedPrefetchPolymarket.estimatedCalls +=
            prefetched.rpcCallEstimate;
          inputs.telemetry.followedPrefetchPolymarket.actualCalls +=
            prefetched.rpcCallCount;
          for (const followed of followedRows) {
            prefetchedPolymarketBalances.set(followed.wallet_id, prefetched);
            polymarketPrefetchTimedOutWalletIds.delete(followed.wallet_id);
          }
          const durationMs = Date.now() - startedAt;
          const logPayload = {
            userId,
            wallets: followedRows.length,
            owners: prefetched.owners.length,
            unionTokenIds: prefetched.unionTokenIds.length,
            rpcCalls: prefetched.rpcCallCount,
            rpcBalanceCacheHits: prefetched.rpcBalanceCacheHits ?? 0,
            rpcBalanceCacheMisses: prefetched.rpcBalanceCacheMisses ?? 0,
            durationMs,
          };
          if (durationMs > env.walletIntelFollowedWalletTimeoutMs) {
            console.warn(
              "[wallets:intel:refresh] followed polymarket prefetch slow",
              logPayload,
            );
          } else {
            console.log(
              "[wallets:intel:refresh] followed polymarket prefetch done",
              logPayload,
            );
          }
        } catch (error) {
          for (const followed of followedRows) {
            prefetchedPolymarketBalances.set(followed.wallet_id, null);
          }
          if (isWalletIntelStageTimeoutError(error)) {
            for (const followed of followedRows) {
              polymarketPrefetchTimedOutWalletIds.add(followed.wallet_id);
            }
            console.warn(
              "[wallets:intel:refresh] followed polymarket prefetch timed out",
              {
                userId,
                wallets: followedRows.map((row) => row.address),
                durationMs: Date.now() - startedAt,
                timeoutMs: error.timeoutMs,
              },
            );
            return;
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

      if (polymarketPrefetchTimedOutWalletIds.has(followed.wallet_id)) {
        console.warn(
          "[wallets:intel:refresh] followed polymarket wallet skipped after prefetch timeout",
          {
            userId: followed.user_id,
            walletId: followed.wallet_id,
            wallet: followed.address,
          },
        );
        continue;
      }

      try {
        await runWithTelemetry(
          inputs.telemetry.followedPositionsPolymarket,
          () =>
            withWalletIntelDeadline(
              "followedPolymarketPositions",
              env.walletIntelFollowedWalletTimeoutMs,
              () =>
                syncPositionsForUserWallet(inputs.poolClient, {
                  userId: followed.user_id,
                  walletAddress: followed.address,
                  venue: "polymarket",
                  positionScope: "followed",
                  prefetchedPolymarketBalances: prefetchedPolymarket,
                }),
              {
                userId: followed.user_id,
                walletId: followed.wallet_id,
                wallet: followed.address,
              },
            ),
        );
      } catch (error) {
        if (isWalletIntelStageTimeoutError(error)) {
          console.warn(
            "[wallets:intel:refresh] polymarket positions sync timed out",
            {
              userId: followed.user_id,
              walletId: followed.wallet_id,
              wallet: followed.address,
              timeoutMs: error.timeoutMs,
            },
          );
          continue;
        }
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

      const snapshotKey = walletVenueSnapshotKey(
        followed.wallet_id,
        "polymarket",
      );
      if (!inputs.snapshottedWalletVenueKeys.has(snapshotKey)) {
        inputs.snapshottedWalletVenueKeys.add(snapshotKey);
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
      } else {
        followedSnapshotsSkippedAlreadyCollected += 1;
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
            withWalletIntelDeadline(
              "followedLimitlessPositions",
              env.walletIntelFollowedWalletTimeoutMs,
              () =>
                syncPositionsForUserWallet(inputs.poolClient, {
                  userId: followed.user_id,
                  walletAddress: followed.address,
                  venue: "limitless",
                  positionScope: "followed",
                }),
              {
                userId: followed.user_id,
                walletId: followed.wallet_id,
                wallet: followed.address,
              },
            ),
        );
      } catch (error) {
        if (isWalletIntelStageTimeoutError(error)) {
          console.warn(
            "[wallets:intel:refresh] limitless positions sync timed out",
            {
              userId: followed.user_id,
              walletId: followed.wallet_id,
              wallet: followed.address,
              timeoutMs: error.timeoutMs,
            },
          );
          continue;
        } else if (isLimitlessSessionMissing(error)) {
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

      const snapshotKey = walletVenueSnapshotKey(
        followed.wallet_id,
        "limitless",
      );
      if (!inputs.snapshottedWalletVenueKeys.has(snapshotKey)) {
        inputs.snapshottedWalletVenueKeys.add(snapshotKey);
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
      } else {
        followedSnapshotsSkippedAlreadyCollected += 1;
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
          withWalletIntelDeadline(
            "followedKalshiPositions",
            env.walletIntelFollowedWalletTimeoutMs,
            () =>
              syncPositionsForUserWallet(inputs.poolClient, {
                userId: followed.user_id,
                walletAddress: followed.address,
                venue: "kalshi",
                positionScope: "followed",
                prefetchedSolanaBalances:
                  prefetchedSolanaBalances.get(followed.wallet_id) ?? null,
              }),
            {
              userId: followed.user_id,
              walletId: followed.wallet_id,
              wallet: followed.address,
            },
          ),
        );
      } catch (error) {
        if (isWalletIntelStageTimeoutError(error)) {
          console.warn(
            "[wallets:intel:refresh] kalshi positions sync timed out",
            {
              userId: followed.user_id,
              walletId: followed.wallet_id,
              wallet: followed.address,
              timeoutMs: error.timeoutMs,
            },
          );
          continue;
        }
        console.error(
          "[wallets:intel:refresh] kalshi positions sync failed",
          error,
        );
      }

      const snapshotKey = walletVenueSnapshotKey(followed.wallet_id, "kalshi");
      if (!inputs.snapshottedWalletVenueKeys.has(snapshotKey)) {
        inputs.snapshottedWalletVenueKeys.add(snapshotKey);
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
      } else {
        followedSnapshotsSkippedAlreadyCollected += 1;
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
  if (followedSnapshotsSkippedAlreadyCollected > 0) {
    console.log(
      "[wallets:intel:refresh] followed public snapshots skipped; already collected this run",
      { skipped: followedSnapshotsSkippedAlreadyCollected },
    );
  }

  return {
    processed,
    rowInserts,
    activityRows,
  };
}

function buildAutoTrackedPreviousOpenMarketKeys(
  rows: AutoTrackedPreviousOpenPositionRow[],
): SnapshotDeltaMarketKey[] {
  const marketKeys = new Map<string, SnapshotDeltaMarketKey>();
  for (const row of rows) {
    const key = `${row.wallet_id}:${row.venue}:${row.market_id}`;
    if (marketKeys.has(key)) continue;
    marketKeys.set(key, {
      wallet_id: row.wallet_id,
      venue: row.venue,
      market_id: row.market_id,
    });
  }
  return Array.from(marketKeys.values());
}

export async function loadAutoTrackedWalletRows(
  client: Queryable,
  inputs: {
    liveVenues: readonly Venue[];
    asOf: Date;
    attemptBackoffMinutes: number;
    limit: number;
    refreshHours: number;
    subjectTtlDays: number;
  },
): Promise<AutoTrackedWalletRow[]> {
  if (inputs.limit <= 0 || inputs.liveVenues.length === 0) return [];
  const { rows } = await client.query<{
    wallet_id: string;
    address: string;
    chain: Chain;
    venue: Venue;
    sources: AutoTrackedWalletSource[] | null;
    priority: string | number | null;
  }>(
    `
      select
        w.id::text as wallet_id,
        w.address,
        w.chain,
        wts.venue,
        array_agg(distinct wts.source order by wts.source) as sources,
        max(wts.priority) as priority
      from wallet_tracking_subjects wts
      join wallets w on w.id = wts.wallet_id
      where wts.status = 'active'
        and wts.source in ('whale', 'recent_top_holder', 'signal_candidate')
        and wts.venue = any($6::text[])
        and (
          $5::int <= 0 or
          (
            wts.last_selected_at is not null and
            wts.last_selected_at >= $2::timestamptz - ($5::int * interval '1 day')
          )
        )
        and (
          (wts.venue = 'polymarket' and w.chain = 'polygon') or
          (wts.venue = 'limitless' and w.chain = 'base') or
          (wts.venue = 'kalshi' and w.chain = 'solana')
        )
        and (
          wts.last_refreshed_at is null or
          wts.last_refreshed_at <= $2::timestamptz - ($3::int * interval '1 hour')
        )
        and (
          wts.last_refresh_attempted_at is null or
          wts.last_refreshed_at >= wts.last_refresh_attempted_at or
          wts.last_refresh_attempted_at <= $2::timestamptz - ($4::int * interval '1 minute')
        )
      group by w.id, w.address, w.chain, wts.venue
      order by
        max(wts.priority) desc,
        min(coalesce(wts.last_refreshed_at, 'epoch'::timestamptz)) asc,
        min(wts.created_at) asc
      limit $1
    `,
    [
      inputs.limit,
      inputs.asOf,
      Math.max(1, inputs.refreshHours),
      Math.max(1, inputs.attemptBackoffMinutes),
      Math.max(0, inputs.subjectTtlDays),
      inputs.liveVenues,
    ],
  );

  return rows.map((row) => ({
    wallet_id: row.wallet_id,
    address: row.address,
    chain: row.chain,
    venue: row.venue,
    sources: Array.isArray(row.sources) ? row.sources : [],
    priority: Number(row.priority ?? 0),
  }));
}

async function loadAutoTrackedPreviousOpenPositions(
  client: Queryable,
  inputs: { snapshotAt: Date; wallets: AutoTrackedWalletRow[] },
): Promise<AutoTrackedPreviousOpenPositionRow[]> {
  if (inputs.wallets.length === 0) return [];
  const { rows } = await client.query<{
    wallet_id: string;
    venue: Venue;
    market_id: string;
    outcome_side: "YES" | "NO";
    token_id: string | null;
    price: string | null;
  }>(
    `
      with subjects as (
        select distinct *
        from unnest($1::uuid[], $2::text[]) as x(wallet_id, venue)
      ),
      latest as (
        select distinct on (
          ws.wallet_id,
          ws.venue,
          ws.market_id,
          ws.outcome_side
        )
          ws.wallet_id::text as wallet_id,
          ws.venue,
          ws.market_id,
          ws.outcome_side,
          ws.shares,
          ws.price::text as price,
          coalesce(nullif(ws.metadata->>'tokenId', ''), ut.token_id) as token_id
        from wallet_position_snapshots ws
        join subjects s
          on s.wallet_id = ws.wallet_id
         and s.venue = ws.venue
        left join unified_tokens ut
          on ut.market_id = ws.market_id
         and ut.side = ws.outcome_side
        where ws.snapshot_at < $3
          and ws.outcome_side in ('YES', 'NO')
          and (
            ws.metadata->>'source' = 'auto_tracked_wallet' or
            ws.metadata->>'snapshotSource' = 'auto_tracked_wallet'
          )
        order by
          ws.wallet_id,
          ws.venue,
          ws.market_id,
          ws.outcome_side,
          ws.snapshot_at desc
      )
      select
        wallet_id,
        venue,
        market_id,
        outcome_side,
        token_id,
        price
      from latest
      where shares > 0
        and token_id is not null
    `,
    [
      inputs.wallets.map((row) => row.wallet_id),
      inputs.wallets.map((row) => row.venue),
      inputs.snapshotAt,
    ],
  );

  return rows
    .filter((row): row is AutoTrackedPreviousOpenPositionRow =>
      Boolean(row.token_id),
    )
    .map((row) => ({
      wallet_id: row.wallet_id,
      venue: row.venue,
      market_id: row.market_id,
      outcome_side: row.outcome_side,
      token_id: row.token_id,
      price: row.price,
    }));
}

function buildAutoTrackedWalletVenueKey(
  walletId: string,
  venue: Venue,
): string {
  return `${walletId}:${venue}`;
}

function previousOpenRowsForTrackedWallet(
  rows: AutoTrackedPreviousOpenPositionRow[],
  tracked: AutoTrackedWalletRow,
): AutoTrackedPreviousOpenPositionRow[] {
  return rows.filter(
    (row) => row.wallet_id === tracked.wallet_id && row.venue === tracked.venue,
  );
}

function previousOpenTokenIdsForTrackedWallet(
  rows: AutoTrackedPreviousOpenPositionRow[],
  tracked: AutoTrackedWalletRow,
): string[] {
  return Array.from(
    new Set(
      previousOpenRowsForTrackedWallet(rows, tracked)
        .map((row) => normalizeOnchainTokenId(row.venue, row.token_id))
        .filter((tokenId): tokenId is string => Boolean(tokenId)),
    ),
  );
}

function buildPreviousOpenMarketKeysForSuccessfulScans(
  rows: AutoTrackedPreviousOpenPositionRow[],
  successfulWalletVenueKeys: Set<string>,
): SnapshotDeltaMarketKey[] {
  return buildAutoTrackedPreviousOpenMarketKeys(
    rows.filter((row) =>
      successfulWalletVenueKeys.has(
        buildAutoTrackedWalletVenueKey(row.wallet_id, row.venue),
      ),
    ),
  );
}

function resolveMarkPrice(row: {
  best_bid: string | null;
  best_ask: string | null;
  mid: string | null;
  last_price: string | null;
}): number | null {
  return (
    resolveMidPrice(row.best_bid, row.best_ask, row.mid) ??
    parseLimitlessNumber(row.last_price)
  );
}

function isNearlySamePrice(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= 1e-9;
}

async function backfillPolymarketUnifiedTokensForWalletIntel(
  client: Queryable,
  tokenIds: string[],
): Promise<void> {
  const normalizedTokenIds = Array.from(
    new Set(
      tokenIds
        .map((tokenId) => normalizeOnchainTokenId("polymarket", tokenId))
        .filter((tokenId): tokenId is string => Boolean(tokenId)),
    ),
  );
  if (normalizedTokenIds.length === 0) return;
  await client.query(
    `
      with wanted as (
        select distinct unnest($1::text[]) as token_id
      ),
      missing as (
        select w.token_id
        from wanted w
        left join unified_tokens ut
          on ut.venue = 'polymarket'
         and ut.token_id = w.token_id
        where ut.token_id is null
      ),
      matched_yes as (
        select m.id as market_id, w.token_id, 'YES'::text as side
        from unified_markets m
        join missing w on w.token_id = m.token_yes
        where m.venue = 'polymarket'
      ),
      matched_no as (
        select m.id as market_id, w.token_id, 'NO'::text as side
        from unified_markets m
        join missing w on w.token_id = m.token_no
        where m.venue = 'polymarket'
      ),
      matched_clob as (
        select m.id as market_id,
               w.token_id,
               case
                 when m.clob_token_ids::jsonb->>0 = w.token_id then 'YES'
                 else 'NO'
               end as side
        from unified_markets m
        join missing w on m.clob_token_ids::jsonb ? w.token_id
        where m.venue = 'polymarket'
          and m.clob_token_ids is not null
          and m.clob_token_ids <> ''
          and m.clob_token_ids <> '[]'
          and (
            m.clob_token_ids::jsonb->>0 = w.token_id
            or m.clob_token_ids::jsonb->>1 = w.token_id
          )
      ),
      to_insert as (
        select * from matched_yes
        union all
        select * from matched_no
        union all
        select * from matched_clob
      )
      insert into unified_tokens(token_id, venue, market_id, side)
      select token_id, 'polymarket', market_id, side
      from to_insert
      on conflict do nothing
    `,
    [normalizedTokenIds],
  );
}

async function backfillKalshiUnifiedTokensForWalletIntel(
  client: Queryable,
  tokenIds: string[],
): Promise<void> {
  const scopedTokenIds = Array.from(
    new Set(
      tokenIds
        .map((tokenId) => {
          const normalized = normalizeOnchainTokenId("kalshi", tokenId);
          return normalized ? `sol:${normalized}` : null;
        })
        .filter((tokenId): tokenId is string => Boolean(tokenId)),
    ),
  );
  if (scopedTokenIds.length === 0) return;
  await client.query(
    `
      with wanted as (
        select distinct unnest($1::text[]) as token_id
      ),
      missing as (
        select w.token_id
        from wanted w
        left join unified_tokens ut
          on ut.venue = 'kalshi'
         and ut.token_id = w.token_id
        where ut.token_id is null
      ),
      matched_yes as (
        select m.id as market_id, w.token_id, 'YES'::text as side
        from unified_markets m
        join missing w on w.token_id = m.token_yes
        where m.venue = 'kalshi'
      ),
      matched_no as (
        select m.id as market_id, w.token_id, 'NO'::text as side
        from unified_markets m
        join missing w on w.token_id = m.token_no
        where m.venue = 'kalshi'
      ),
      to_insert as (
        select * from matched_yes
        union all
        select * from matched_no
      )
      insert into unified_tokens(token_id, venue, market_id, side)
      select token_id, 'kalshi', market_id, side
      from to_insert
      on conflict (market_id, side) do update
        set token_id = excluded.token_id,
            venue = excluded.venue,
            updated_at = now()
    `,
    [scopedTokenIds],
  );
}

async function loadTokenIndexEntriesForVenue(
  client: Queryable,
  inputs: {
    venue: Venue;
    tokenIds: string[];
    freshPriceMaxAgeMs?: number | null;
    now?: Date;
  },
): Promise<Map<string, TokenIndexEntry>> {
  const normalizedTokenIds = Array.from(
    new Set(
      inputs.tokenIds
        .map((tokenId) => normalizeOnchainTokenId(inputs.venue, tokenId))
        .filter((tokenId): tokenId is string => Boolean(tokenId)),
    ),
  );
  if (normalizedTokenIds.length === 0) return new Map();
  const lookupTokenIds = buildTokenIndexLookupTokenIds(
    inputs.venue,
    normalizedTokenIds,
  );
  if (lookupTokenIds.length === 0) return new Map();

  const { rows } = await client.query<{
    token_id: string;
    market_id: string;
    side: "YES" | "NO";
    top_ts: Date | string | null;
    best_bid: string | null;
    best_ask: string | null;
    mid: string | null;
    last_price: string | null;
    resolved_outcome: string | null;
    resolved_outcome_pct: string | null;
    status: string | null;
  }>(
    `
      with wanted as (
        select distinct unnest($2::text[]) as token_id
      )
      select
        ut.token_id,
        ut.market_id,
        ut.side,
        top.ts as top_ts,
        top.best_bid,
        top.best_ask,
        top.mid,
        um.last_price,
        um.resolved_outcome,
        um.resolved_outcome_pct::text as resolved_outcome_pct,
        um.status::text as status
      from wanted w
      join unified_tokens ut
        on ut.token_id = w.token_id
      join unified_markets um
        on um.id = ut.market_id
      left join unified_token_top_latest top
        on top.token_id = ut.token_id
      where ut.venue = $1
        and ut.side in ('YES', 'NO')
    `,
    [inputs.venue, lookupTokenIds],
  );

  const index = new Map<string, TokenIndexEntry>();
  const freshPriceMaxAgeMs =
    inputs.freshPriceMaxAgeMs != null
      ? Math.max(1, Math.trunc(inputs.freshPriceMaxAgeMs))
      : null;
  const minFreshMs =
    freshPriceMaxAgeMs != null
      ? (inputs.now ?? new Date()).getTime() - freshPriceMaxAgeMs
      : null;
  for (const row of rows) {
    const key = normalizeOnchainTokenId(inputs.venue, row.token_id);
    if (!key || index.has(key)) continue;
    const topTsMs =
      row.top_ts instanceof Date
        ? row.top_ts.getTime()
        : typeof row.top_ts === "string"
          ? Date.parse(row.top_ts)
          : NaN;
    const topIsFresh =
      minFreshMs == null || (Number.isFinite(topTsMs) && topTsMs >= minFreshMs);
    const topPrice = topIsFresh
      ? resolveMidPrice(row.best_bid, row.best_ask, row.mid)
      : null;
    const price = freshPriceMaxAgeMs != null ? topPrice : resolveMarkPrice(row);
    const terminalPrices = resolveTerminalTokenPrices({
      resolvedOutcome: row.resolved_outcome,
      resolvedOutcomePct: row.resolved_outcome_pct,
    });
    const terminalPrice =
      terminalPrices != null
        ? row.side === "YES"
          ? terminalPrices.yes
          : terminalPrices.no
        : null;
    const priceSource =
      price != null &&
      row.status === "SETTLED" &&
      isNearlySamePrice(price, terminalPrice)
        ? "terminal"
        : freshPriceMaxAgeMs != null
          ? price != null
            ? "top_of_book"
            : null
          : price != null
            ? "legacy_fallback"
            : null;
    index.set(key, {
      marketId: row.market_id,
      venue: inputs.venue,
      tokenId: row.token_id,
      side: row.side,
      price,
      priceFresh: freshPriceMaxAgeMs != null ? price != null : undefined,
      priceSource,
      priceUpdatedAt:
        Number.isFinite(topTsMs) && topTsMs > 0
          ? new Date(topTsMs).toISOString()
          : null,
    });
  }
  return index;
}

type AutoTrackedSnapshotCandidate = {
  walletId: string;
  venue: Venue;
  marketId: string;
  outcomeSide: "YES" | "NO";
  shares: number;
  sizeUsd: number | null;
  price: number | null;
  tokenId: string;
  onchainTokenId: string;
  priceFresh?: boolean;
  priceSource?: string | null;
  priceUpdatedAt?: string | null;
};

async function snapshotAutoTrackedWalletTokenBalances(
  client: Queryable,
  inputs: { candidates: AutoTrackedSnapshotCandidate[]; occurredAt: Date },
): Promise<{ inserted: number; marketIds: string[] }> {
  let inserted = 0;
  const marketIds = new Set<string>();

  for (const chunk of chunkArray(inputs.candidates, 1_000)) {
    if (chunk.length === 0) continue;
    const payload = chunk.map((row) => ({
      wallet_id: row.walletId,
      venue: row.venue,
      market_id: row.marketId,
      outcome_side: normalizeOutcomeSideForStorage(row.outcomeSide),
      shares: String(row.shares),
      size_usd: row.sizeUsd != null ? String(row.sizeUsd) : null,
      price: row.price != null ? String(row.price) : null,
      token_id: row.tokenId,
      metadata: {
        source: "auto_tracked_wallet",
        tokenId: row.tokenId,
        onchainTokenId: row.onchainTokenId,
        shares: row.shares,
        priceFresh: row.priceFresh ?? null,
        priceSource: row.priceSource ?? null,
        priceUpdatedAt: row.priceUpdatedAt ?? null,
      },
    }));

    const result = await client.query<{
      inserted: string | number;
      market_ids: string[] | null;
    }>(
      `
        with input_rows as (
          select
            x.wallet_id::uuid as wallet_id,
            x.venue::text as venue,
            x.market_id::text as market_id,
            x.outcome_side::text as outcome_side,
            x.shares::numeric as shares,
            x.size_usd::numeric as size_usd,
            x.price::numeric as price,
            x.token_id::text as token_id,
            x.metadata::jsonb as metadata
          from jsonb_to_recordset($1::jsonb) as x(
            wallet_id text,
            venue text,
            market_id text,
            outcome_side text,
            shares text,
            size_usd text,
            price text,
            token_id text,
            metadata jsonb
          )
        ),
        unsuppressed as (
          select i.*
          from input_rows i
          join wallets w on w.id = i.wallet_id
          where not exists (
            select 1
            from positions hp
            where hp.position_scope = 'own'
              and hp.is_hidden = true
              and hp.venue = i.venue
              and hp.venue in ('polymarket', 'limitless')
              and hp.token_id = i.token_id
              and hp.wallet_address is not null
              and btrim(hp.wallet_address) <> ''
              and w.chain <> 'solana'
              and lower(hp.wallet_address) = lower(w.address)
          )
          and not exists (
            select 1
            from positions hp
            where hp.position_scope = 'own'
              and hp.is_hidden = true
              and hp.venue = i.venue
              and hp.venue = 'kalshi'
              and hp.token_id = i.token_id
              and hp.wallet_address is not null
              and btrim(hp.wallet_address) <> ''
              and w.chain = 'solana'
              and hp.wallet_address = w.address
          )
        ),
        wallet_venue_upsert as (
          insert into wallet_venues (wallet_id, venue)
          select distinct wallet_id, venue
          from unsuppressed
          on conflict (wallet_id, venue)
          do nothing
        ),
        snapshot_upsert as (
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
          select
            wallet_id,
            venue,
            market_id,
            outcome_side,
            shares,
            size_usd,
            price,
            metadata,
            $2
          from unsuppressed
          on conflict (wallet_id, venue, market_id, outcome_side, snapshot_at)
          do update set
            shares = excluded.shares,
            size_usd = excluded.size_usd,
            price = excluded.price,
            metadata = excluded.metadata
          returning market_id
        )
        select
          count(*)::int as inserted,
          coalesce(array_agg(distinct market_id), '{}'::text[]) as market_ids
        from snapshot_upsert
      `,
      [JSON.stringify(payload), inputs.occurredAt],
    );
    inserted += Number(result.rows[0]?.inserted ?? 0);
    for (const marketId of result.rows[0]?.market_ids ?? []) {
      marketIds.add(marketId);
    }
  }

  return { inserted, marketIds: Array.from(marketIds) };
}

async function fetchPolymarketAutoTrackedTokenBalances(inputs: {
  address: string;
  previousOpenTokenIds: string[];
}): Promise<Array<{ tokenId: string; size: string }>> {
  const snapshots = await fetchPolymarketDataApiPositionSnapshots(
    inputs.address,
  );
  const dataApiTokenIds = snapshots.map((snapshot) => snapshot.tokenId);
  const tokenIds = Array.from(
    new Set([...dataApiTokenIds, ...inputs.previousOpenTokenIds]),
  );
  if (tokenIds.length === 0) return [];

  const output: Array<{ tokenId: string; size: string }> = [];
  const chunkSize = 200;
  for (let i = 0; i < tokenIds.length; i += chunkSize) {
    const chunk = tokenIds.slice(i, i + chunkSize);
    const balances = await fetchErc1155BalancesByOwner({
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      contractAddress: env.polymarketConditionalTokensAddress,
      owner: inputs.address,
      tokenIds: chunk,
    });
    for (const tokenId of chunk) {
      const balance = balances.get(tokenId) ?? 0n;
      if (balance <= 0n) continue;
      output.push({ tokenId, size: ethers.formatUnits(balance, 6) });
    }
  }
  return output;
}

async function fetchLimitlessAutoTrackedTokenBalances(
  address: string,
): Promise<Array<{ tokenId: string; size: string }>> {
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/portfolio/${encodeURIComponent(address)}/positions`,
    auth: "none",
  });
  if (!upstream.ok) {
    const message =
      isRecord(upstream.payload) && typeof upstream.payload.message === "string"
        ? upstream.payload.message.toLowerCase()
        : "";
    if (isLimitlessPublicPortfolioUserNotFound(upstream.payload)) return [];
    throw new Error(
      message
        ? `Limitless auto-tracked portfolio scan failed: ${message}`
        : "Limitless auto-tracked portfolio scan failed.",
    );
  }
  if (isLimitlessPublicPortfolioUserNotFound(upstream.payload)) return [];
  const tokenBalances = extractLimitlessTokenBalances(upstream.payload);
  if (
    tokenBalances.length === 0 &&
    !isRecognizedLimitlessPortfolioContainer(upstream.payload)
  ) {
    throw new Error(
      "Limitless auto-tracked portfolio scan returned an unrecognized empty payload.",
    );
  }
  return tokenBalances
    .map((balance) => ({
      tokenId: normalizeLimitlessScopedTokenId(balance.tokenId),
      size: balance.size,
    }))
    .filter((balance): balance is { tokenId: string; size: string } =>
      Boolean(balance.tokenId),
    );
}

function isRecognizedLimitlessPortfolioContainer(payload: unknown): boolean {
  if (Array.isArray(payload)) return true;
  if (!isRecord(payload)) return false;
  const roots: unknown[] = [payload];
  if (payload.data) {
    roots.push(payload.data);
    if (isRecord(payload.data) && payload.data.data) {
      roots.push(payload.data.data);
    }
  }
  const keys = [
    "clob",
    "amm",
    "positions",
    "clobPositions",
    "clob_positions",
    "clobPosition",
    "clob_position",
  ];
  return roots.some((root) => {
    if (Array.isArray(root)) return true;
    if (!isRecord(root)) return false;
    return keys.some((key) => Array.isArray(root[key]));
  });
}

async function fetchKalshiAutoTrackedTokenBalances(
  address: string,
  telemetry: WalletIntelRetryTelemetry,
): Promise<Array<{ tokenId: string; size: string }>> {
  const balances = await runWithTelemetry(telemetry, () =>
    fetchSolanaTokenBalancesByOwner({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      owner: address,
      includeToken2022: true,
    }),
  );
  return balances.map((balance) => ({
    tokenId: `sol:${balance.mint}`,
    size: balance.uiAmountString,
  }));
}

export async function upsertRecentTopHolderTrackingSubjects(
  client: Queryable,
  inputs: {
    candidates: RecentTopHolderTrackingCandidate[];
    limit: number;
    selectedAt: Date;
  },
): Promise<number> {
  const cappedLimit = Math.max(0, Math.trunc(inputs.limit));
  if (cappedLimit <= 0 || inputs.candidates.length === 0) return 0;

  const bestByWalletVenue = new Map<string, RecentTopHolderTrackingCandidate>();
  for (const candidate of inputs.candidates) {
    if (!Number.isFinite(candidate.sizeUsd) || candidate.sizeUsd <= 0) continue;
    const key = buildAutoTrackedWalletVenueKey(
      candidate.walletId,
      candidate.venue,
    );
    const existing = bestByWalletVenue.get(key);
    if (!existing || candidate.sizeUsd > existing.sizeUsd) {
      bestByWalletVenue.set(key, candidate);
    }
  }

  const subjects = Array.from(bestByWalletVenue.values())
    .sort((a, b) => b.sizeUsd - a.sizeUsd)
    .slice(0, cappedLimit)
    .map<WalletTrackingSubjectInput>((candidate, index) => ({
      walletId: candidate.walletId,
      venue: candidate.venue,
      source: "recent_top_holder",
      priority: 200 + Math.max(0, cappedLimit - index),
      reason: "recent_top_holder",
      metadata: {
        marketId: candidate.marketId,
        side: candidate.side,
        sizeUsd: candidate.sizeUsd,
        shares: candidate.shares,
        snapshotAt: candidate.snapshotAt.toISOString(),
      },
      selectedAt: inputs.selectedAt,
    }));

  return upsertWalletTrackingSubjects(client, subjects);
}

export async function upsertWhaleTrackingSubjects(
  client: Queryable,
  inputs: { asOf: Date; limit: number },
): Promise<number> {
  const limit = Math.max(0, Math.trunc(inputs.limit));
  if (limit <= 0) return 0;
  const { rows } = await client.query<{
    wallet_id: string;
    venue: Venue;
    max_size_usd: string | null;
    last_activity_at: Date | string | null;
  }>(
    `
      with whale_wallets as (
        select tm.wallet_id
        from wallet_tags t
        join wallet_tag_map tm on tm.tag_id = t.id
        where t.slug = 'whale'
      ),
      ranked as (
        select
          wa.wallet_id::text as wallet_id,
          wa.venue,
          max(wa.size_usd)::text as max_size_usd,
          max(wa.occurred_at) as last_activity_at
        from wallet_activity_events wa
        join whale_wallets ww on ww.wallet_id = wa.wallet_id
        join wallets w on w.id = wa.wallet_id
        where wa.venue in ('polymarket', 'limitless', 'kalshi')
          and wa.activity_type in ('delta', 'trade', 'holder')
          and wa.occurred_at >= $2::timestamptz - interval '7 days'
          and wa.occurred_at <= $2::timestamptz
          and (
            (wa.venue = 'polymarket' and w.chain = 'polygon') or
            (wa.venue = 'limitless' and w.chain = 'base') or
            (wa.venue = 'kalshi' and w.chain = 'solana')
          )
        group by wa.wallet_id, wa.venue
      )
      select wallet_id, venue, max_size_usd, last_activity_at
      from ranked
      order by coalesce(max_size_usd::numeric, 0) desc, last_activity_at desc nulls last
      limit $1
    `,
    [limit, inputs.asOf],
  );

  return upsertWalletTrackingSubjects(
    client,
    rows.map((row, index) => ({
      walletId: row.wallet_id,
      venue: row.venue,
      source: "whale",
      priority: 300 + Math.max(0, limit - index),
      reason: "whale_tag_recent_activity",
      metadata: {
        maxSizeUsd: row.max_size_usd != null ? Number(row.max_size_usd) : null,
        lastActivityAt:
          row.last_activity_at instanceof Date
            ? row.last_activity_at.toISOString()
            : row.last_activity_at,
      },
      selectedAt: inputs.asOf,
    })),
  );
}

export async function markAutoTrackedWalletRefreshAttempted(
  client: Queryable,
  inputs: { attemptedAt: Date; wallets: AutoTrackedWalletRow[] },
): Promise<void> {
  if (inputs.wallets.length === 0) return;
  await client.query(
    `
      with attempted as (
        select distinct *
        from unnest($1::uuid[], $2::text[]) as x(wallet_id, venue)
      )
      update wallet_tracking_subjects wts
      set
        last_refresh_attempted_at = $3,
        updated_at = now()
      from attempted a
      where wts.wallet_id = a.wallet_id
        and wts.venue = a.venue
        and wts.status = 'active'
    `,
    [
      inputs.wallets.map((row) => row.wallet_id),
      inputs.wallets.map((row) => row.venue),
      inputs.attemptedAt,
    ],
  );
}

export async function markAutoTrackedWalletsRefreshed(
  client: Queryable,
  inputs: { refreshedAt: Date; wallets: AutoTrackedWalletRow[] },
): Promise<void> {
  if (inputs.wallets.length === 0) return;
  await client.query(
    `
      with refreshed as (
        select distinct *
        from unnest($1::uuid[], $2::text[]) as x(wallet_id, venue)
      )
      update wallet_tracking_subjects wts
      set
        last_refreshed_at = $3,
        updated_at = now()
      from refreshed r
      where wts.wallet_id = r.wallet_id
        and wts.venue = r.venue
        and wts.status = 'active'
    `,
    [
      inputs.wallets.map((row) => row.wallet_id),
      inputs.wallets.map((row) => row.venue),
      inputs.refreshedAt,
    ],
  );
}

export async function collectAutoTrackedWalletSnapshotRows(
  client: Queryable,
  inputs: {
    autoTrackedWallets: AutoTrackedWalletRow[];
    previousOpenPositions: AutoTrackedPreviousOpenPositionRow[];
    snapshotAt: Date;
    tokenIdsByVenue: Record<Venue, string[]>;
    tokenIndexByVenue: Record<Venue, Map<string, TokenIndexEntry>>;
    telemetry: WalletIntelRefreshTelemetry;
    autoTrackedWalletFetchConcurrency: number;
    touchedWalletIds: Set<string>;
  },
): Promise<AutoTrackedCollectionResult> {
  if (inputs.autoTrackedWallets.length === 0) {
    return {
      processed: 0,
      rowInserts: 0,
      activityRows: 0,
      marketIds: [],
      previousOpenMarketKeys: [],
      attemptedWallets: [],
      refreshedWallets: [],
    };
  }

  let processed = 0;
  let rowInserts = 0;
  const marketIds = new Set<string>();
  const attemptedWallets: AutoTrackedWalletRow[] = [];
  const refreshedWallets: AutoTrackedWalletRow[] = [];
  const successfulWalletVenueKeys = new Set<string>();
  const fetchStartedAt = Date.now();

  const fetched = (
    await mapWithConcurrency(
      inputs.autoTrackedWallets,
      inputs.autoTrackedWalletFetchConcurrency,
      async (tracked) => {
        processed += 1;
        attemptedWallets.push(tracked);
        inputs.touchedWalletIds.add(tracked.wallet_id);
        try {
          let tokenBalances: Array<{ tokenId: string; size: string }> = [];
          const previousOpenTokenIds = previousOpenTokenIdsForTrackedWallet(
            inputs.previousOpenPositions,
            tracked,
          );

          if (tracked.venue === "polymarket" && tracked.chain === "polygon") {
            const address = normalizeAddress(tracked.address, "polygon");
            if (!address) return null;
            tokenBalances = await fetchPolymarketAutoTrackedTokenBalances({
              address,
              previousOpenTokenIds,
            });
          } else if (
            tracked.venue === "limitless" &&
            tracked.chain === "base"
          ) {
            const address = normalizeAddress(tracked.address, "base");
            if (!address) return null;
            tokenBalances =
              await fetchLimitlessAutoTrackedTokenBalances(address);
          } else if (tracked.venue === "kalshi" && tracked.chain === "solana") {
            tokenBalances = await fetchKalshiAutoTrackedTokenBalances(
              tracked.address,
              inputs.telemetry.followedSnapshotSolana,
            );
          } else {
            return null;
          }

          const discoveredTokenIds = tokenBalances.map(
            (balance) => balance.tokenId,
          );
          const tokenIdsForIndex = [
            ...discoveredTokenIds,
            ...previousOpenTokenIds,
          ];
          return {
            tracked,
            tokenBalances,
            tokenIdsForIndex,
            previousOpenRows: previousOpenRowsForTrackedWallet(
              inputs.previousOpenPositions,
              tracked,
            ),
          };
        } catch (error) {
          console.error(
            "[wallets:intel:refresh] auto-tracked wallet snapshot failed",
            {
              walletId: tracked.wallet_id,
              venue: tracked.venue,
            },
            error,
          );
          return null;
        }
      },
    )
  ).filter(
    (
      row,
    ): row is {
      tracked: AutoTrackedWalletRow;
      tokenBalances: Array<{ tokenId: string; size: string }>;
      tokenIdsForIndex: string[];
      previousOpenRows: AutoTrackedPreviousOpenPositionRow[];
    } => row != null,
  );

  const fetchDurationMs = Date.now() - fetchStartedAt;
  const tokenIdsForIndexByVenue: Record<Venue, string[]> = {
    polymarket: [],
    limitless: [],
    kalshi: [],
  };
  for (const result of fetched) {
    refreshedWallets.push(result.tracked);
    successfulWalletVenueKeys.add(
      buildAutoTrackedWalletVenueKey(
        result.tracked.wallet_id,
        result.tracked.venue,
      ),
    );
    for (const row of result.previousOpenRows) {
      marketIds.add(row.market_id);
    }
    tokenIdsForIndexByVenue[result.tracked.venue].push(
      ...result.tokenIdsForIndex,
    );
  }

  const backfillStartedAt = Date.now();
  await Promise.all([
    backfillPolymarketUnifiedTokensForWalletIntel(
      client,
      tokenIdsForIndexByVenue.polymarket,
    ),
    backfillKalshiUnifiedTokensForWalletIntel(
      client,
      tokenIdsForIndexByVenue.kalshi,
    ),
  ]);
  const backfillDurationMs = Date.now() - backfillStartedAt;

  const prePriceTokenIndexByVenue: Record<
    Venue,
    Map<string, TokenIndexEntry>
  > = {
    polymarket: new Map(),
    limitless: new Map(),
    kalshi: new Map(),
  };
  const indexStartedAt = Date.now();
  await Promise.all(
    (["polymarket", "limitless", "kalshi"] as Venue[]).map(async (venue) => {
      prePriceTokenIndexByVenue[venue] = await loadTokenIndexEntriesForVenue(
        client,
        {
          venue,
          tokenIds: tokenIdsForIndexByVenue[venue],
        },
      );
    }),
  );
  const prePriceIndexDurationMs = Date.now() - indexStartedAt;

  await requestFreshWalletIntelTokenPrices(client, {
    label: "auto_tracked_wallet",
    tokenEntries: (["polymarket", "limitless", "kalshi"] as Venue[]).flatMap(
      (venue) => Array.from(prePriceTokenIndexByVenue[venue].values()),
    ),
  });

  const finalTokenIndexByVenue: Record<Venue, Map<string, TokenIndexEntry>> = {
    polymarket: new Map(),
    limitless: new Map(),
    kalshi: new Map(),
  };
  const priceFreshAsOf = new Date();
  const finalIndexStartedAt = Date.now();
  await Promise.all(
    (["polymarket", "limitless", "kalshi"] as Venue[]).map(async (venue) => {
      finalTokenIndexByVenue[venue] = await loadTokenIndexEntriesForVenue(
        client,
        {
          venue,
          tokenIds: tokenIdsForIndexByVenue[venue],
          freshPriceMaxAgeMs:
            walletIntelRefreshPolicy.autoTrackedFreshPriceCheckEnabled
              ? walletIntelRefreshPolicy.freshPriceMaxAgeMs
              : null,
          now: priceFreshAsOf,
        },
      );
      for (const [tokenId, entry] of finalTokenIndexByVenue[venue].entries()) {
        if (!inputs.tokenIndexByVenue[venue].has(tokenId)) {
          inputs.tokenIndexByVenue[venue].set(tokenId, entry);
        }
        if (!inputs.tokenIdsByVenue[venue].includes(tokenId)) {
          inputs.tokenIdsByVenue[venue].push(tokenId);
        }
      }
    }),
  );
  const finalIndexDurationMs = Date.now() - finalIndexStartedAt;

  const snapshotCandidates: AutoTrackedSnapshotCandidate[] = [];
  let missingTokenIndexRows = 0;
  let pricedRows = 0;
  let freshPricedRows = 0;
  let unpricedRows = 0;
  for (const result of fetched) {
    const tokenIndex = finalTokenIndexByVenue[result.tracked.venue];
    for (const balance of result.tokenBalances) {
      const onchainTokenId = normalizeOnchainTokenId(
        result.tracked.venue,
        balance.tokenId,
      );
      if (!onchainTokenId) continue;
      const entry = tokenIndex.get(onchainTokenId);
      if (!entry) {
        missingTokenIndexRows += 1;
        continue;
      }
      const shares = Number(balance.size);
      if (!Number.isFinite(shares) || shares <= 0) continue;
      const sizeUsd =
        entry.price != null ? Number((shares * entry.price).toFixed(6)) : null;
      if (entry.price != null) pricedRows += 1;
      if (entry.priceFresh === true) freshPricedRows += 1;
      if (entry.price == null) unpricedRows += 1;
      snapshotCandidates.push({
        walletId: result.tracked.wallet_id,
        venue: entry.venue,
        marketId: entry.marketId,
        outcomeSide: entry.side,
        shares,
        sizeUsd,
        price: entry.price,
        tokenId: entry.tokenId,
        onchainTokenId,
        priceFresh: entry.priceFresh,
        priceSource: entry.priceSource,
        priceUpdatedAt: entry.priceUpdatedAt,
      });
    }
  }

  const writeStartedAt = Date.now();
  const snapshot = await snapshotAutoTrackedWalletTokenBalances(client, {
    candidates: snapshotCandidates,
    occurredAt: inputs.snapshotAt,
  });
  const writeDurationMs = Date.now() - writeStartedAt;
  rowInserts += snapshot.inserted;
  for (const marketId of snapshot.marketIds) marketIds.add(marketId);

  const previousOpenMarketKeys = buildPreviousOpenMarketKeysForSuccessfulScans(
    inputs.previousOpenPositions,
    successfulWalletVenueKeys,
  );

  console.log("[wallets:intel:refresh] auto-tracked wallets", {
    selected: inputs.autoTrackedWallets.length,
    processed,
    rowInserts,
    refreshed: refreshedWallets.length,
    previousOpenPositions: inputs.previousOpenPositions.length,
    previousOpenMarketKeys: previousOpenMarketKeys.length,
    fetchDurationMs,
    backfillDurationMs,
    prePriceIndexDurationMs,
    finalIndexDurationMs,
    writeDurationMs,
    candidates: snapshotCandidates.length,
    missingTokenIndexRows,
    pricedRows,
    freshPricedRows,
    unpricedRows,
  });

  return {
    processed,
    rowInserts,
    activityRows: rowInserts,
    marketIds: Array.from(marketIds),
    previousOpenMarketKeys,
    attemptedWallets,
    refreshedWallets,
  };
}

async function refreshTouchedWalletArtifacts(
  client: Queryable,
  inputs: {
    touchedWalletIds: Set<string>;
    selectedMarketIds: string[];
    previousOpenMarketKeys?: SnapshotDeltaMarketKey[];
    snapshotAt: Date;
    tagIds: Record<string, string>;
    attributionPolicy: WalletIntelAttributionPolicy;
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
        extraPreviousMarketKeys: inputs.previousOpenMarketKeys ?? [],
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
    "specialistAttribution",
    aggregateStageCounts,
    () =>
      refreshWalletSpecialistAttribution(client, {
        walletIds: aggregateWalletIds,
        policy: inputs.attributionPolicy,
        asOf: inputs.snapshotAt,
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
    const result = await withWalletIntelDeadline(
      `artifact:${stage}`,
      env.walletIntelArtifactStageTimeoutMs,
      fn,
      { stage, ...counts },
    );
    console.log("[wallets:intel:refresh] artifact stage done", {
      stage,
      durationMs: Date.now() - startedAt,
      ...counts,
    });
    return result;
  } catch (error) {
    if (isWalletIntelStageTimeoutError(error)) {
      console.error(
        "[wallets:intel:refresh] artifact stage timed out",
        {
          stage,
          durationMs: Date.now() - startedAt,
          timeoutMs: error.timeoutMs,
          ...counts,
        },
        error,
      );
      throw error;
    }
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

export async function snapshotFollowedWalletHoldingsSolana(
  client: Queryable,
  inputs: {
    walletId: string;
    address: string;
    tokenMints: string[];
    tokenIndex: Map<string, TokenIndexEntry>;
    occurredAt: Date;
    balances?: SolanaTokenBalance[] | null;
    telemetry?: WalletIntelRetryTelemetry | null;
    metadataSource?: string;
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

    const snapshotInserted = await upsertWalletPositionSnapshot(client, {
      walletId: inputs.walletId,
      venue: entry.venue,
      marketId: entry.marketId,
      outcomeSide: entry.side,
      shares: amount,
      sizeUsd,
      price: entry.price,
      metadata: {
        source: inputs.metadataSource ?? "followed_wallet",
        tokenId: entry.tokenId,
        onchainTokenId: mint,
        shares: amount,
      },
      snapshotAt: inputs.occurredAt,
    });

    if (snapshotInserted) inserted += 1;
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

    const snapshotInserted = await upsertWalletPositionSnapshot(client, {
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
    if (snapshotInserted) inserted += 1;
  }

  return inserted;
}

async function loadInternalHunchWalletRows(
  client: Queryable,
  snapshotAt: Date,
  liveVenues: readonly Venue[],
): Promise<InternalHunchWalletRow[]> {
  if (
    liveVenues.length === 0 ||
    !walletIntelRefreshPolicy.internalHunchEnabled ||
    walletIntelRefreshPolicy.internalHunchWalletLimit <= 0
  ) {
    return [];
  }

  const fillLookbackMs =
    walletIntelRefreshPolicy.internalHunchFillLookbackDays *
    24 *
    60 *
    60 *
    1000;
  const fillSince = new Date(snapshotAt.getTime() - fillLookbackMs);
  const fillCandidatesEnabled =
    walletIntelRefreshPolicy.internalHunchFillLimit > 0 &&
    walletIntelRefreshPolicy.internalHunchFillLookbackDays > 0;

  const { rows } = await client.query<InternalHunchWalletRow>(
    `
      with position_candidates as (
        select
          p.user_id,
          case
            when p.venue in ('polymarket', 'limitless') then lower(p.wallet_address)
            else p.wallet_address
          end as wallet_address,
          p.venue,
          max(coalesce(p.updated_at, p.last_updated_at, p.created_at)) as last_activity_at
        from positions p
        where p.position_scope = 'own'
          and p.venue = any($5::text[])
          and p.wallet_address is not null
          and btrim(p.wallet_address) <> ''
          and (p.is_hidden is null or p.is_hidden = false)
        group by
          p.user_id,
          case
            when p.venue in ('polymarket', 'limitless') then lower(p.wallet_address)
            else p.wallet_address
          end,
          p.venue
      ),
      fill_candidates as (
        select
          o.user_id,
          case
            when o.venue in ('polymarket', 'limitless')
              then lower(coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, '')))
            else coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, ''))
          end as wallet_address,
          o.venue,
          max(f.filled_at) as last_activity_at
        from order_fills f
        join orders o on o.id = f.order_id
        where $4::boolean
          and o.venue = any($5::text[])
          and coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, '')) is not null
          and f.fill_size > 0
          and f.filled_at >= $2
          and f.filled_at <= $3
        group by
          o.user_id,
          case
            when o.venue in ('polymarket', 'limitless')
              then lower(coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, '')))
            else coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, ''))
          end,
          o.venue
      ),
      candidates as (
        select * from position_candidates
        union all
        select * from fill_candidates
      )
      select
        c.user_id,
        c.wallet_address,
        c.venue::text as venue,
        case c.venue
          when 'polymarket' then 'polygon'
          when 'limitless' then 'base'
          when 'kalshi' then 'solana'
          else null
        end as chain
      from candidates c
      where c.wallet_address is not null
      group by c.user_id, c.wallet_address, c.venue
      having case c.venue
        when 'polymarket' then 'polygon'
        when 'limitless' then 'base'
        when 'kalshi' then 'solana'
        else null
      end is not null
      order by max(c.last_activity_at) desc nulls last, c.wallet_address
      limit $1
    `,
    [
      walletIntelRefreshPolicy.internalHunchWalletLimit,
      fillSince,
      snapshotAt,
      fillCandidatesEnabled,
      liveVenues,
    ],
  );

  return rows;
}

async function snapshotInternalHunchWalletPositions(
  client: Queryable,
  inputs: {
    userId: string;
    walletId: string;
    walletAddress: string;
    chain: Chain;
    venue: Venue;
    occurredAt: Date;
  },
): Promise<{ rows: number; marketIds: string[] }> {
  const isSolana = inputs.chain === "solana";
  const { rows } = await client.query<{
    token_id: string;
    size: string;
    market_id: string | null;
    outcome_side: "YES" | "NO" | null;
    best_bid: string | null;
    best_ask: string | null;
    mid: string | null;
  }>(
    `
      select
        p.token_id,
        p.size,
        ut.market_id,
        ut.side as outcome_side,
        top.best_bid,
        top.best_ask,
        top.mid
      from positions p
      join unified_tokens ut
        on ut.token_id = p.token_id
       and ut.venue = p.venue
      left join unified_token_top_latest top
        on top.token_id = p.token_id
      where p.user_id = $1
        and p.venue = $3
        and p.position_scope = 'own'
        and p.wallet_address is not null
        and (
          ($4::boolean and p.wallet_address = $2)
          or (not $4::boolean and lower(p.wallet_address) = lower($2))
        )
        and (p.is_hidden is null or p.is_hidden = false)
        and not exists (
          select 1
          from positions hp
          where hp.user_id = p.user_id
            and hp.position_scope = 'own'
            and hp.venue = p.venue
            and hp.token_id = p.token_id
            and hp.is_hidden = true
            and (
              hp.wallet_address is null
              or btrim(hp.wallet_address) = ''
              or ($4::boolean and hp.wallet_address = $2)
              or (not $4::boolean and lower(hp.wallet_address) = lower($2))
            )
        )
        and (
          p.size > 0
          or exists (
            select 1
            from order_fills f
            join orders o on o.id = f.order_id
            where o.user_id = p.user_id
              and o.venue = p.venue
              and o.token_id = p.token_id
              and coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, '')) is not null
              and (
                ($4::boolean and coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, '')) = $2)
                or (not $4::boolean and lower(coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, ''))) = lower($2))
              )
            limit 1
          )
        )
    `,
    [inputs.userId, inputs.walletAddress, inputs.venue, isSolana],
  );

  let inserted = 0;
  const marketIds = new Set<string>();

  for (const row of rows) {
    if (!row.market_id) continue;
    const rawSize = Number(row.size);
    if (!Number.isFinite(rawSize) || rawSize < 0) continue;
    const shares = Math.max(0, rawSize);
    const price = resolveMidPrice(row.best_bid, row.best_ask, row.mid);
    const sizeUsd = price != null ? Number((shares * price).toFixed(6)) : null;

    const snapshotInserted = await upsertWalletPositionSnapshot(client, {
      walletId: inputs.walletId,
      venue: inputs.venue,
      marketId: row.market_id,
      outcomeSide: row.outcome_side,
      shares,
      sizeUsd,
      price,
      metadata: {
        source:
          shares > 0 ? "hunch_own_position_open" : "hunch_own_position_closed",
        tokenId: row.token_id,
        size: shares,
      },
      snapshotAt: inputs.occurredAt,
    });
    if (snapshotInserted) {
      marketIds.add(row.market_id);
      inserted += 1;
    }
  }

  return { rows: inserted, marketIds: Array.from(marketIds) };
}

async function backfillInternalHunchOrderFillActivity(
  client: Queryable,
  inputs: {
    userId: string;
    walletId: string;
    walletAddress: string;
    chain: Chain;
    venue: Venue;
    snapshotAt: Date;
    fillLimit: number;
  },
): Promise<{ rows: number; selectedRows: number; marketIds: string[] }> {
  if (
    inputs.fillLimit <= 0 ||
    walletIntelRefreshPolicy.internalHunchFillLookbackDays <= 0
  ) {
    return { rows: 0, selectedRows: 0, marketIds: [] };
  }

  const fillSince = new Date(
    inputs.snapshotAt.getTime() -
      walletIntelRefreshPolicy.internalHunchFillLookbackDays *
        24 *
        60 *
        60 *
        1000,
  );
  const isSolana = inputs.chain === "solana";
  const { rows } = await client.query<{
    order_fill_id: string;
    order_id: string;
    venue_fill_id: string | null;
    venue_trade_id: string | null;
    token_id: string;
    market_id: string;
    outcome_side: "YES" | "NO" | null;
    fill_size: string;
    fill_price: string;
    fill_side: string;
    filled_at: Date;
  }>(
    `
      with selected_fills as (
        select
          f.id::text as order_fill_id,
          o.id::text as order_id,
          f.venue_fill_id,
          f.venue_trade_id,
          o.token_id,
          ut.market_id,
          ut.side as outcome_side,
          f.fill_size,
          f.fill_price,
          f.fill_side,
          f.filled_at
        from order_fills f
        join orders o on o.id = f.order_id
        join unified_tokens ut
          on ut.token_id = o.token_id
         and ut.venue = o.venue
        where o.user_id = $1
          and o.venue = $3
          and o.token_id is not null
          and coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, '')) is not null
          and (
            ($4::boolean and coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, '')) = $2)
            or (not $4::boolean and lower(coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, ''))) = lower($2))
          )
          and f.fill_size > 0
          and f.filled_at >= $5
          and f.filled_at <= $6
          and not exists (
            select 1
            from positions hp
            where hp.user_id = o.user_id
              and hp.position_scope = 'own'
              and hp.venue = o.venue
              and hp.token_id = o.token_id
              and hp.is_hidden = true
              and (
                hp.wallet_address is null
                or btrim(hp.wallet_address) = ''
                or ($4::boolean and hp.wallet_address = $2)
                or (not $4::boolean and lower(hp.wallet_address) = lower($2))
              )
          )
        order by f.filled_at desc, f.id desc
        limit $7
      )
      select *
      from selected_fills
      order by filled_at asc, order_fill_id asc
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.venue,
      isSolana,
      fillSince,
      inputs.snapshotAt,
      inputs.fillLimit,
    ],
  );

  const tokenIds = Array.from(new Set(rows.map((row) => row.token_id)));
  const firstSelectedAtByToken = new Map<string, Date>();
  for (const row of rows) {
    const existing = firstSelectedAtByToken.get(row.token_id);
    if (!existing || row.filled_at.getTime() < existing.getTime()) {
      firstSelectedAtByToken.set(row.token_id, row.filled_at);
    }
  }
  let initialShares: InternalHunchFillInitialShares[] = [];
  if (tokenIds.length > 0) {
    const cutoffTimes = tokenIds.map(
      (tokenId) => firstSelectedAtByToken.get(tokenId) ?? fillSince,
    );
    const priorRows = await client.query<{
      token_id: string;
      shares: string;
    }>(
      `
        with token_cutoffs as (
          select *
          from unnest($5::text[], $6::timestamptz[]) as t(token_id, cutoff_at)
        )
        select
          o.token_id,
          greatest(
            coalesce(
              sum(
                case
                  when f.fill_side = 'BUY' then f.fill_size
                  when f.fill_side = 'SELL' then -f.fill_size
                  else 0
                end
              ),
              0
            ),
            0
          ) as shares
        from order_fills f
        join orders o on o.id = f.order_id
        join token_cutoffs tc on tc.token_id = o.token_id
        where o.user_id = $1
          and o.venue = $3
          and coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, '')) is not null
          and (
            ($4::boolean and coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, '')) = $2)
            or (not $4::boolean and lower(coalesce(nullif(o.wallet_address, ''), nullif(o.signer_address, ''))) = lower($2))
          )
          and f.fill_size > 0
          and f.filled_at < tc.cutoff_at
          and not exists (
            select 1
            from positions hp
            where hp.user_id = o.user_id
              and hp.position_scope = 'own'
              and hp.venue = o.venue
              and hp.token_id = o.token_id
              and hp.is_hidden = true
              and (
                hp.wallet_address is null
                or btrim(hp.wallet_address) = ''
                or ($4::boolean and hp.wallet_address = $2)
                or (not $4::boolean and lower(hp.wallet_address) = lower($2))
              )
          )
        group by o.token_id
      `,
      [
        inputs.userId,
        inputs.walletAddress,
        inputs.venue,
        isSolana,
        tokenIds,
        cutoffTimes,
      ],
    );

    initialShares = priorRows.rows.map((row) => ({
      walletId: inputs.walletId,
      venue: inputs.venue,
      tokenId: row.token_id,
      shares: Number(row.shares),
    }));
  }

  const events = buildInternalHunchFillActivityEvents(
    rows.map(
      (row): InternalHunchFillActivityInput => ({
        walletId: inputs.walletId,
        venue: inputs.venue,
        marketId: row.market_id,
        outcomeSide: row.outcome_side,
        tokenId: row.token_id,
        orderId: row.order_id,
        orderFillId: row.order_fill_id,
        venueFillId: row.venue_fill_id,
        venueTradeId: row.venue_trade_id,
        fillSize: Number(row.fill_size),
        fillPrice: Number(row.fill_price),
        fillSide: row.fill_side,
        filledAt: row.filled_at,
      }),
    ),
    { initialShares },
  );

  const marketIds = new Set<string>();
  for (const event of events) {
    await upsertWalletActivityEvent(client, {
      walletId: event.walletId,
      venue: event.venue,
      marketId: event.marketId,
      outcomeSide: event.outcomeSide,
      action: event.action,
      deltaShares: event.deltaShares,
      sizeUsd: event.sizeUsd,
      price: event.price,
      activityType: "trade",
      source: "hunch_order_fill",
      metadata: event.metadata,
      occurredAt: event.occurredAt,
    });
    marketIds.add(event.marketId);
  }

  return {
    rows: events.length,
    selectedRows: rows.length,
    marketIds: Array.from(marketIds),
  };
}

async function collectInternalHunchWalletIntel(
  client: Queryable,
  inputs: {
    liveVenues: readonly Venue[];
    snapshotAt: Date;
    touchedWalletIds: Set<string>;
  },
): Promise<{
  processed: number;
  snapshotRows: number;
  activityRows: number;
  marketIds: string[];
}> {
  const wallets = await loadInternalHunchWalletRows(
    client,
    inputs.snapshotAt,
    inputs.liveVenues,
  );
  if (!wallets.length) {
    return { processed: 0, snapshotRows: 0, activityRows: 0, marketIds: [] };
  }

  let processed = 0;
  let snapshotRows = 0;
  let activityRows = 0;
  let remainingFillRows = walletIntelRefreshPolicy.internalHunchFillLimit;
  const marketIds = new Set<string>();

  for (const row of wallets) {
    const address = normalizeAddress(row.wallet_address, row.chain);
    if (!address) continue;

    const walletId = await upsertWallet(client, {
      address,
      chain: row.chain,
    });
    await upsertWalletVenue(client, walletId, row.venue);

    const snapshotResult = await snapshotInternalHunchWalletPositions(client, {
      userId: row.user_id,
      walletId,
      walletAddress: address,
      chain: row.chain,
      venue: row.venue,
      occurredAt: inputs.snapshotAt,
    });
    snapshotRows += snapshotResult.rows;
    for (const marketId of snapshotResult.marketIds) marketIds.add(marketId);

    const activityResult = await backfillInternalHunchOrderFillActivity(
      client,
      {
        userId: row.user_id,
        walletId,
        walletAddress: address,
        chain: row.chain,
        venue: row.venue,
        snapshotAt: inputs.snapshotAt,
        fillLimit: remainingFillRows,
      },
    );
    activityRows += activityResult.rows;
    remainingFillRows = Math.max(
      0,
      remainingFillRows - activityResult.selectedRows,
    );
    for (const marketId of activityResult.marketIds) marketIds.add(marketId);

    if (snapshotResult.rows > 0 || activityResult.rows > 0) {
      inputs.touchedWalletIds.add(walletId);
    }
    processed += 1;
  }

  console.log("[wallets:intel:refresh] internal hunch", {
    selected: wallets.length,
    processed,
    snapshotRows,
    activityRows,
    markets: marketIds.size,
  });

  return {
    processed,
    snapshotRows,
    activityRows,
    marketIds: Array.from(marketIds),
  };
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

export async function applySnapshotDeltas(
  client: Queryable,
  inputs: {
    walletIds: string[];
    occurredAt: Date;
    marketIds: string[];
    extraPreviousMarketKeys?: SnapshotDeltaMarketKey[];
  },
): Promise<{ inserts: number; updates: number }> {
  const walletIds = Array.from(new Set(inputs.walletIds));
  const extraPreviousMarketKeys = inputs.extraPreviousMarketKeys ?? [];
  const marketIds = Array.from(
    new Set([
      ...inputs.marketIds,
      ...extraPreviousMarketKeys.map((row) => row.market_id),
    ]),
  );
  if (walletIds.length === 0 || marketIds.length === 0) {
    return { inserts: 0, updates: 0 };
  }

  const eligibleMarketIds = await filterTrackableMarketIds(client, {
    marketIds,
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
    const walletChunkSet = new Set(walletChunk);
    const extraKeysForChunk = extraPreviousMarketKeys.filter(
      (row) =>
        walletChunkSet.has(row.wallet_id) &&
        eligibleMarketIds.includes(row.market_id),
    );
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

    if (currentRows.rows.length === 0 && extraKeysForChunk.length === 0) {
      continue;
    }

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
    for (const row of extraKeysForChunk) {
      const key = `${row.wallet_id}|${row.venue}|${row.market_id}`;
      if (currentMarketKeysByKey.has(key)) continue;
      currentMarketKeysByKey.set(key, row);
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
      if (
        shouldSuppressInternalHunchSnapshotDelta({
          snapshotSource,
          hasPreviousSameKey: previous != null,
          prevShares,
          currShares,
        })
      ) {
        continue;
      }
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

export async function refreshWalletPositionExposure(
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
    const openPositionStats = await loadWalletOpenPositionStatsMap(
      client,
      chunk,
      { asOf: inputs.asOf },
    );
    const openPositionStatsPayload = chunk.map((walletId) => {
      const stats = openPositionStats.get(walletId);
      return {
        wallet_id: walletId,
        open_positions_count: stats?.openPositionsCount ?? 0,
        open_markets_count: stats?.openMarketsCount ?? 0,
        avg_open_position_size_usd:
          stats?.avgOpenPositionSizeUsd != null
            ? String(stats.avgOpenPositionSizeUsd)
            : null,
        avg_open_entry_price:
          stats?.avgOpenEntryPrice != null
            ? String(stats.avgOpenEntryPrice)
            : null,
        avg_open_entry_approx: stats?.avgOpenEntryApprox ?? null,
      };
    });

    await client.query(
      `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      ),
      open_position_stats as (
        select
          x.wallet_id::uuid as wallet_id,
          x.open_positions_count::int as open_positions_count,
          x.open_markets_count::int as open_markets_count,
          x.avg_open_position_size_usd::numeric as avg_open_position_size_usd,
          x.avg_open_entry_price::numeric as avg_open_entry_price,
          x.avg_open_entry_approx::boolean as avg_open_entry_approx
        from jsonb_to_recordset($3::jsonb) as x(
          wallet_id text,
          open_positions_count int,
          open_markets_count int,
          avg_open_position_size_usd text,
          avg_open_entry_price text,
          avg_open_entry_approx boolean
        )
      ),
      latest as (
        select
          input.wallet_id,
          latest_snapshot.venue,
          latest_snapshot.snapshot_at
        from wallet_set input
        join lateral (
          select distinct on (ws.venue)
            ws.venue,
            ws.snapshot_at
          from wallet_position_snapshots ws
          where ws.wallet_id = input.wallet_id
            and ws.snapshot_at <= $2::timestamptz
          order by ws.venue, ws.snapshot_at desc
        ) latest_snapshot on true
      ),
      latest_rows as (
        select
          ws.wallet_id,
          ws.venue,
          ws.market_id,
          case
            when ws.outcome_side in ('YES', 'NO') then ws.outcome_side
            else '__OTHER__'
          end as outcome_side,
          greatest(coalesce(ws.shares, 0), 0) as shares,
          greatest(
            coalesce(
              ws.size_usd,
              abs(coalesce(ws.shares, 0) * coalesce(ws.price, 0)),
              0
            ),
            0
          ) as leg_notional_usd,
          case
            when ws.price is null then null
            when ws.price < 0 then 0::numeric
            when ws.price > 1 then least(1::numeric, ws.price / 100::numeric)
            else least(1::numeric, ws.price)
          end as price,
          ws.snapshot_at
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
      position_rollup as (
        select
          wallet_id,
          jsonb_agg(
            jsonb_build_object(
              'venue', venue,
              'marketId', market_id,
              'outcomeSide', outcome_side,
              'shares', shares::text,
              'sizeUsd', leg_notional_usd::text,
              'price', case when price is null then null else price::text end,
              'snapshotAt', snapshot_at
            )
            order by venue, market_id, outcome_side
          ) filter (
            where outcome_side in ('YES', 'NO')
              and (shares > 0.000000001 or leg_notional_usd > 0)
          ) as open_positions
        from latest_rows
        group by wallet_id
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
          coalesce(e.two_sided_markets, 0) as two_sided_markets,
          coalesce(ops.open_positions_count, 0) as open_positions_count,
          coalesce(ops.open_markets_count, 0) as open_markets_count,
          ops.avg_open_position_size_usd,
          ops.avg_open_entry_price,
          ops.avg_open_entry_approx,
          coalesce(pr.open_positions, '[]'::jsonb) as open_positions
        from wallet_set ws
        left join exposure e on e.wallet_id = ws.wallet_id
        left join open_position_stats ops on ops.wallet_id = ws.wallet_id
        left join position_rollup pr on pr.wallet_id = ws.wallet_id
      )
      insert into wallet_position_exposure (
        wallet_id,
        exposure_usd,
        hedged_notional_usd,
        net_imbalance_usd,
        hedge_ratio,
        two_sided_markets,
        open_positions_count,
        open_markets_count,
        avg_open_position_size_usd,
        avg_open_entry_price,
        avg_open_entry_approx,
        open_positions,
        open_positions_version,
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
        open_positions_count,
        open_markets_count,
        avg_open_position_size_usd,
        avg_open_entry_price,
        avg_open_entry_approx,
        open_positions,
        1,
        $2::timestamptz
      from final_rows
      on conflict (wallet_id)
      do update set
        exposure_usd = excluded.exposure_usd,
        hedged_notional_usd = excluded.hedged_notional_usd,
        net_imbalance_usd = excluded.net_imbalance_usd,
        hedge_ratio = excluded.hedge_ratio,
        two_sided_markets = excluded.two_sided_markets,
        open_positions_count = excluded.open_positions_count,
        open_markets_count = excluded.open_markets_count,
        avg_open_position_size_usd = excluded.avg_open_position_size_usd,
        avg_open_entry_price = excluded.avg_open_entry_price,
        avg_open_entry_approx = excluded.avg_open_entry_approx,
        open_positions = excluded.open_positions,
        open_positions_version = excluded.open_positions_version,
        as_of = excluded.as_of,
        updated_at = now()
    `,
      [chunk, inputs.asOf, JSON.stringify(openPositionStatsPayload)],
    );
  }
}

type WalletPositionRollupComparisonRow = {
  wallet_id: string;
  rollup_present: boolean;
  as_of_matches: boolean;
  expected_positions: string | number;
  actual_positions: string | number;
  membership_mismatches: string | number;
  shares_mismatches: string | number;
  size_usd_mismatches: string | number;
  price_mismatches: string | number;
  snapshot_at_mismatches: string | number;
  expected_open_markets: string | number;
  actual_open_markets: string | number;
  expected_total_exposure_usd: string | number;
  actual_total_exposure_usd: string | number;
};

export type WalletPositionRollupComparisonMismatch = {
  walletId: string;
  rollupPresent: boolean;
  asOfMatches: boolean;
  expectedPositions: number;
  actualPositions: number;
  membershipMismatches: number;
  sharesMismatches: number;
  sizeUsdMismatches: number;
  priceMismatches: number;
  snapshotAtMismatches: number;
  expectedOpenMarkets: number;
  actualOpenMarkets: number;
  expectedTotalExposureUsd: number;
  actualTotalExposureUsd: number;
};

export type WalletPositionRollupComparison = {
  requestedWallets: number;
  comparedWallets: number;
  matchedWallets: number;
  mismatchedWallets: number;
  missingRollupWallets: number;
  asOfMismatches: number;
  membershipMismatches: number;
  numericMismatches: number;
  snapshotAtMismatches: number;
  openMarketCountMismatches: number;
  totalExposureMismatches: number;
  mismatchSamples: WalletPositionRollupComparisonMismatch[];
};

function comparisonNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function compareWalletPositionRollups(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
    numericTolerance?: number;
    sampleLimit?: number;
  },
): Promise<WalletPositionRollupComparison> {
  const walletIds = Array.from(new Set(inputs.walletIds));
  const numericTolerance = Math.max(0, inputs.numericTolerance ?? 1e-9);
  const sampleLimit = Math.max(0, Math.trunc(inputs.sampleLimit ?? 10));
  if (walletIds.length === 0) {
    return {
      requestedWallets: 0,
      comparedWallets: 0,
      matchedWallets: 0,
      mismatchedWallets: 0,
      missingRollupWallets: 0,
      asOfMismatches: 0,
      membershipMismatches: 0,
      numericMismatches: 0,
      snapshotAtMismatches: 0,
      openMarketCountMismatches: 0,
      totalExposureMismatches: 0,
      mismatchSamples: [],
    };
  }

  const trackableSql = buildWalletIntelTrackableMarketSql({
    marketAlias: "market",
    eventAlias: "event",
    asOfSql: "$2::timestamptz",
  });
  const { rows } = await client.query<WalletPositionRollupComparisonRow>(
    `
      with wallet_set as materialized (
        select unnest($1::uuid[]) as wallet_id
      ),
      latest as materialized (
        select
          input.wallet_id,
          latest_snapshot.venue,
          latest_snapshot.snapshot_at
        from wallet_set input
        join lateral (
          select distinct on (snapshot.venue)
            snapshot.venue,
            snapshot.snapshot_at
          from wallet_position_snapshots snapshot
          where snapshot.wallet_id = input.wallet_id
            and snapshot.snapshot_at <= $2::timestamptz
          order by snapshot.venue, snapshot.snapshot_at desc
        ) latest_snapshot on true
      ),
      expected_rows as materialized (
        select
          snapshot.wallet_id,
          snapshot.venue,
          snapshot.market_id,
          upper(snapshot.outcome_side) as outcome_side,
          greatest(coalesce(snapshot.shares, 0), 0)::numeric as shares,
          greatest(
            coalesce(
              snapshot.size_usd,
              abs(coalesce(snapshot.shares, 0) * coalesce(snapshot.price, 0)),
              0
            ),
            0
          )::numeric as size_usd,
          case
            when snapshot.price is null then null
            when snapshot.price < 0 then 0::numeric
            when snapshot.price > 1 then least(1::numeric, snapshot.price / 100::numeric)
            else least(1::numeric, snapshot.price)
          end as price,
          snapshot.snapshot_at
        from latest
        join wallet_position_snapshots snapshot
          on snapshot.wallet_id = latest.wallet_id
         and snapshot.venue = latest.venue
         and snapshot.snapshot_at = latest.snapshot_at
        join unified_markets market on market.id = snapshot.market_id
        left join unified_events event on event.id = market.event_id
        where ${trackableSql}
          and upper(snapshot.outcome_side) in ('YES', 'NO')
          and (
            greatest(coalesce(snapshot.shares, 0), 0) > 0.000000001
            or greatest(
              coalesce(
                snapshot.size_usd,
                abs(coalesce(snapshot.shares, 0) * coalesce(snapshot.price, 0)),
                0
              ),
              0
            ) > 0
          )
      ),
      actual_rows as materialized (
        select
          exposure.wallet_id,
          position.venue,
          position."marketId" as market_id,
          upper(position."outcomeSide") as outcome_side,
          position.shares,
          position."sizeUsd" as size_usd,
          position.price,
          position."snapshotAt" as snapshot_at
        from wallet_position_exposure exposure
        join wallet_set input on input.wallet_id = exposure.wallet_id
        cross join lateral jsonb_to_recordset(exposure.open_positions) as position(
          venue text,
          "marketId" text,
          "outcomeSide" text,
          shares numeric,
          "sizeUsd" numeric,
          price numeric,
          "snapshotAt" timestamptz
        )
        where exposure.open_positions_version = 1
          and jsonb_typeof(exposure.open_positions) = 'array'
      ),
      joined_rows as materialized (
        select
          coalesce(expected.wallet_id, actual.wallet_id) as wallet_id,
          expected.venue as expected_venue,
          expected.market_id as expected_market_id,
          expected.outcome_side as expected_outcome_side,
          expected.shares as expected_shares,
          expected.size_usd as expected_size_usd,
          expected.price as expected_price,
          expected.snapshot_at as expected_snapshot_at,
          actual.venue as actual_venue,
          actual.market_id as actual_market_id,
          actual.outcome_side as actual_outcome_side,
          actual.shares as actual_shares,
          actual.size_usd as actual_size_usd,
          actual.price as actual_price,
          actual.snapshot_at as actual_snapshot_at
        from expected_rows expected
        full outer join actual_rows actual
          on actual.wallet_id = expected.wallet_id
         and actual.venue = expected.venue
         and actual.market_id = expected.market_id
         and actual.outcome_side = expected.outcome_side
      ),
      per_wallet as (
        select
          wallet_id,
          count(*) filter (where expected_market_id is not null) as expected_positions,
          count(*) filter (where actual_market_id is not null) as actual_positions,
          count(*) filter (
            where expected_market_id is null or actual_market_id is null
          ) as membership_mismatches,
          count(*) filter (
            where expected_market_id is not null
              and actual_market_id is not null
              and abs(expected_shares - actual_shares) > $3::numeric
          ) as shares_mismatches,
          count(*) filter (
            where expected_market_id is not null
              and actual_market_id is not null
              and abs(expected_size_usd - actual_size_usd) > $3::numeric
          ) as size_usd_mismatches,
          count(*) filter (
            where expected_market_id is not null
              and actual_market_id is not null
              and (
                (expected_price is null) <> (actual_price is null)
                or (
                  expected_price is not null
                  and actual_price is not null
                  and abs(expected_price - actual_price) > $3::numeric
                )
              )
          ) as price_mismatches,
          count(*) filter (
            where expected_market_id is not null
              and actual_market_id is not null
              and expected_snapshot_at is distinct from actual_snapshot_at
          ) as snapshot_at_mismatches,
          count(distinct (expected_venue, expected_market_id)) filter (
            where expected_market_id is not null
          ) as expected_open_markets,
          count(distinct (actual_venue, actual_market_id)) filter (
            where actual_market_id is not null
          ) as actual_open_markets,
          coalesce(sum(expected_size_usd), 0) as expected_total_exposure_usd,
          coalesce(sum(actual_size_usd), 0) as actual_total_exposure_usd
        from joined_rows
        group by wallet_id
      )
      select
        input.wallet_id::text as wallet_id,
        (
          exposure.wallet_id is not null
          and exposure.open_positions_version = 1
          and jsonb_typeof(exposure.open_positions) = 'array'
        ) as rollup_present,
        coalesce(exposure.as_of = $2::timestamptz, false) as as_of_matches,
        coalesce(compared.expected_positions, 0)::text as expected_positions,
        coalesce(compared.actual_positions, 0)::text as actual_positions,
        coalesce(compared.membership_mismatches, 0)::text as membership_mismatches,
        coalesce(compared.shares_mismatches, 0)::text as shares_mismatches,
        coalesce(compared.size_usd_mismatches, 0)::text as size_usd_mismatches,
        coalesce(compared.price_mismatches, 0)::text as price_mismatches,
        coalesce(compared.snapshot_at_mismatches, 0)::text as snapshot_at_mismatches,
        coalesce(compared.expected_open_markets, 0)::text as expected_open_markets,
        coalesce(compared.actual_open_markets, 0)::text as actual_open_markets,
        coalesce(compared.expected_total_exposure_usd, 0)::text as expected_total_exposure_usd,
        coalesce(compared.actual_total_exposure_usd, 0)::text as actual_total_exposure_usd
      from wallet_set input
      left join wallet_position_exposure exposure
        on exposure.wallet_id = input.wallet_id
      left join per_wallet compared on compared.wallet_id = input.wallet_id
      order by input.wallet_id
    `,
    [walletIds, inputs.asOf, numericTolerance],
  );

  let matchedWallets = 0;
  let missingRollupWallets = 0;
  let asOfMismatches = 0;
  let membershipMismatches = 0;
  let numericMismatches = 0;
  let snapshotAtMismatches = 0;
  let openMarketCountMismatches = 0;
  let totalExposureMismatches = 0;
  const mismatchSamples: WalletPositionRollupComparisonMismatch[] = [];
  for (const row of rows) {
    const mismatch: WalletPositionRollupComparisonMismatch = {
      walletId: row.wallet_id,
      rollupPresent: row.rollup_present,
      asOfMatches: row.as_of_matches,
      expectedPositions: comparisonNumber(row.expected_positions),
      actualPositions: comparisonNumber(row.actual_positions),
      membershipMismatches: comparisonNumber(row.membership_mismatches),
      sharesMismatches: comparisonNumber(row.shares_mismatches),
      sizeUsdMismatches: comparisonNumber(row.size_usd_mismatches),
      priceMismatches: comparisonNumber(row.price_mismatches),
      snapshotAtMismatches: comparisonNumber(row.snapshot_at_mismatches),
      expectedOpenMarkets: comparisonNumber(row.expected_open_markets),
      actualOpenMarkets: comparisonNumber(row.actual_open_markets),
      expectedTotalExposureUsd: comparisonNumber(
        row.expected_total_exposure_usd,
      ),
      actualTotalExposureUsd: comparisonNumber(row.actual_total_exposure_usd),
    };
    const numericMismatchCount =
      mismatch.sharesMismatches +
      mismatch.sizeUsdMismatches +
      mismatch.priceMismatches;
    const openMarketMismatch =
      mismatch.expectedOpenMarkets !== mismatch.actualOpenMarkets;
    const totalExposureMismatch =
      Math.abs(
        mismatch.expectedTotalExposureUsd - mismatch.actualTotalExposureUsd,
      ) > numericTolerance;
    const matches =
      mismatch.rollupPresent &&
      mismatch.asOfMatches &&
      mismatch.expectedPositions === mismatch.actualPositions &&
      mismatch.membershipMismatches === 0 &&
      numericMismatchCount === 0 &&
      mismatch.snapshotAtMismatches === 0 &&
      !openMarketMismatch &&
      !totalExposureMismatch;
    if (matches) {
      matchedWallets += 1;
      continue;
    }
    if (!mismatch.rollupPresent) missingRollupWallets += 1;
    if (!mismatch.asOfMatches) asOfMismatches += 1;
    membershipMismatches += mismatch.membershipMismatches;
    numericMismatches += numericMismatchCount;
    snapshotAtMismatches += mismatch.snapshotAtMismatches;
    if (openMarketMismatch) openMarketCountMismatches += 1;
    if (totalExposureMismatch) totalExposureMismatches += 1;
    if (mismatchSamples.length < sampleLimit) mismatchSamples.push(mismatch);
  }

  return {
    requestedWallets: walletIds.length,
    comparedWallets: rows.length,
    matchedWallets,
    mismatchedWallets: rows.length - matchedWallets,
    missingRollupWallets,
    asOfMismatches,
    membershipMismatches,
    numericMismatches,
    snapshotAtMismatches,
    openMarketCountMismatches,
    totalExposureMismatches,
    mismatchSamples,
  };
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
          and ${buildWalletFinalOutcomeSampleActionSql("wa.action")}
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

type WalletOnchainStateRefreshResult = {
  selected: number;
  identitiesInspected: number;
  identityErrors: number;
  identityNamesSelected: number;
  identityNamesUpdated: number;
  identityNamesPolymarketErrors: number;
  identityNamesPolymarketFresh: number;
  identityNamesPolymarketNotFound: number;
  identityNamesPolymarketResolved: number;
  identityNamesEnsResolved: number;
  identityNamesEnsSkipped: number;
  ownersUpserted: number;
  balancesFetched: number;
  balanceSubjectsFetched: number;
  ownerBalanceSubjects: number;
  skippedInvalidAddresses: number;
  stateUpserts: number;
};

type WalletOnchainStateCandidate = {
  wallet_id: string;
  address: string;
  chain: Chain;
  venue: Venue;
  metadata: Record<string, unknown> | null;
};

type WalletOnchainIdentityState = {
  walletKind: PolymarketWalletKind | null;
  ownerAddress: string | null;
  ownerSource: WalletOwnerSource;
  ownerConfidence: WalletOwnerConfidence;
  safeOwners: string[] | null;
  safeThreshold: number | null;
  identityResolvedAt: string | null;
};

type WalletIdentityNameCandidate = {
  walletId: string;
  address: string;
  chain: Chain;
  venue: Venue;
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

function emptyWalletOnchainStateRefreshResult(): WalletOnchainStateRefreshResult {
  return {
    selected: 0,
    identitiesInspected: 0,
    identityErrors: 0,
    identityNamesSelected: 0,
    identityNamesUpdated: 0,
    identityNamesPolymarketErrors: 0,
    identityNamesPolymarketFresh: 0,
    identityNamesPolymarketNotFound: 0,
    identityNamesPolymarketResolved: 0,
    identityNamesEnsResolved: 0,
    identityNamesEnsSkipped: 0,
    ownersUpserted: 0,
    balancesFetched: 0,
    balanceSubjectsFetched: 0,
    ownerBalanceSubjects: 0,
    skippedInvalidAddresses: 0,
    stateUpserts: 0,
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

async function refreshWalletIdentityNames(
  client: Queryable,
  candidates: WalletIdentityNameCandidate[],
): Promise<
  Pick<
    WalletOnchainStateRefreshResult,
    | "identityNamesSelected"
    | "identityNamesUpdated"
    | "identityNamesPolymarketErrors"
    | "identityNamesPolymarketFresh"
    | "identityNamesPolymarketNotFound"
    | "identityNamesPolymarketResolved"
    | "identityNamesEnsResolved"
    | "identityNamesEnsSkipped"
  >
> {
  const uniqueByWalletId = new Map<string, WalletIdentityNameCandidate>();
  for (const candidate of candidates) {
    if (candidate.chain === "solana") continue;
    const address = normalizeAddress(candidate.address, candidate.chain);
    if (!address) continue;
    if (uniqueByWalletId.has(candidate.walletId)) continue;
    uniqueByWalletId.set(candidate.walletId, { ...candidate, address });
  }
  const selected = Array.from(uniqueByWalletId.values());
  const result = {
    identityNamesSelected: selected.length,
    identityNamesUpdated: 0,
    identityNamesPolymarketErrors: 0,
    identityNamesPolymarketFresh: 0,
    identityNamesPolymarketNotFound: 0,
    identityNamesPolymarketResolved: 0,
    identityNamesEnsResolved: 0,
    identityNamesEnsSkipped: 0,
  };
  if (selected.length === 0) return result;

  const metadataRows = await client.query<{
    id: string;
    metadata: Record<string, unknown> | null;
  }>(
    `
      select id, metadata
      from wallets
      where id = any($1::uuid[])
    `,
    [selected.map((candidate) => candidate.walletId)],
  );
  const metadataByWalletId = new Map(
    metadataRows.rows.map((row) => [row.id, row.metadata]),
  );

  let skipEnsForRun = false;
  let loggedEnsRunSkip = false;
  const polymarketErrorSamples = new Map<string, number>();
  for (const chunk of chunkArray(selected, 4)) {
    const reports = await Promise.all(
      chunk.map(async (candidate) => {
        const metadata = metadataByWalletId.get(candidate.walletId) ?? null;
        const report = await resolveWalletIdentityNames({
          address: candidate.address,
          chain: candidate.chain,
          venue: candidate.venue,
          metadata,
          skipEns: skipEnsForRun,
        });
        return { candidate, report };
      }),
    );

    for (const { candidate, report } of reports) {
      if (report.ensSkipReason) {
        skipEnsForRun = true;
        if (!loggedEnsRunSkip) {
          loggedEnsRunSkip = true;
          console.warn("[wallets:intel:refresh] ENS identity names skipped", {
            reason: report.ensSkipReason,
          });
        }
      }
      if (report.polymarketStatus === "resolved") {
        result.identityNamesPolymarketResolved += 1;
      }
      if (report.polymarketStatus === "not_found") {
        result.identityNamesPolymarketNotFound += 1;
      }
      if (report.polymarketStatus === "fresh") {
        result.identityNamesPolymarketFresh += 1;
      }
      if (report.polymarketStatus === "error") {
        result.identityNamesPolymarketErrors += 1;
        const sample = report.polymarketError ?? "unknown";
        polymarketErrorSamples.set(
          sample,
          (polymarketErrorSamples.get(sample) ?? 0) + 1,
        );
      }
      if (report.ensStatus === "resolved") {
        result.identityNamesEnsResolved += 1;
      }
      if (report.ensStatus === "skipped") {
        result.identityNamesEnsSkipped += 1;
      }
      if (!report.changed || !report.identityNames) continue;
      await updateWalletMetadata(client, candidate.walletId, {
        identityNames: report.identityNames,
      });
      result.identityNamesUpdated += 1;
    }
  }

  if (result.identityNamesPolymarketErrors > 0) {
    console.warn("[wallets:intel:refresh] Polymarket identity names errors", {
      errors: result.identityNamesPolymarketErrors,
      samples: Array.from(polymarketErrorSamples.entries())
        .slice(0, 5)
        .map(([error, count]) => ({ error, count })),
    });
  }

  return result;
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

function emptyWalletOnchainIdentityState(): WalletOnchainIdentityState {
  return {
    walletKind: null,
    ownerAddress: null,
    ownerSource: null,
    ownerConfidence: null,
    safeOwners: null,
    safeThreshold: null,
    identityResolvedAt: null,
  };
}

function shouldInspectPolymarketIdentity(
  row: WalletOnchainStateCandidate,
): boolean {
  return row.chain === "polygon" && row.venue === "polymarket";
}

function walletOnchainBalanceKey(chain: Chain, address: string): string {
  return chain === "solana"
    ? `${chain}:${address.trim()}`
    : `${chain}:${address.toLowerCase()}`;
}

function incrementCount(
  counts: Record<string, number>,
  key: string | null | undefined,
): void {
  const normalized = key && key.length > 0 ? key : "unknown";
  counts[normalized] = (counts[normalized] ?? 0) + 1;
}

function buildPolymarketIdentityMetadata(
  identity: WalletOnchainIdentityState,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    walletKind: identity.walletKind,
    ownerAddress: identity.ownerAddress,
    ownerSource: identity.ownerSource,
    ownerConfidence: identity.ownerConfidence,
    identityResolvedAt: identity.identityResolvedAt,
    walletOnchainIdentityCheckStatus: "ok",
    walletOnchainIdentityCheckedAt: identity.identityResolvedAt,
  };

  if (identity.walletKind === "safe") {
    metadata.kind = "safe";
    metadata.owners = identity.safeOwners ?? [];
    metadata.threshold = identity.safeThreshold;
    metadata.polymarketProxyKind = "safe";
  }
  if (identity.walletKind === "polymarket_deposit_wallet") {
    metadata.polymarketProxyKind = "deposit_wallet";
  }
  if (identity.walletKind === "polymarket_magic_proxy") {
    metadata.polymarketProxyKind = "magic";
  }
  if (identity.ownerAddress) {
    metadata.linkedOwnerAddress = identity.ownerAddress;
    metadata.linkedOwnerSource = identity.ownerSource;
    metadata.linkedOwnerAt = identity.identityResolvedAt;
  }
  return metadata;
}

async function upsertWalletOnchainState(
  client: Queryable,
  input: {
    walletId: string;
    chain: Chain;
    walletAddress: string;
    identity: WalletOnchainIdentityState;
    ownerWalletId: string | null;
    walletBalances: WalletOnchainBalances | null;
    ownerBalances: WalletOnchainBalances | null;
    balanceAsOf: string | null;
  },
): Promise<void> {
  await client.query(
    `
      insert into wallet_onchain_state (
        wallet_id,
        chain,
        wallet_address,
        wallet_kind,
        owner_wallet_id,
        owner_address,
        owner_source,
        owner_confidence,
        identity_resolved_at,
        wallet_balances,
        owner_balances,
        wallet_usd_like_balance,
        owner_usd_like_balance,
        balance_as_of
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9::timestamptz, $10::jsonb, $11::jsonb, $12::numeric, $13::numeric,
        $14::timestamptz
      )
      on conflict (wallet_id)
      do update set
        chain = excluded.chain,
        wallet_address = excluded.wallet_address,
        wallet_kind = case
          when excluded.identity_resolved_at is null then wallet_onchain_state.wallet_kind
          else excluded.wallet_kind
        end,
        owner_wallet_id = case
          when excluded.identity_resolved_at is null then wallet_onchain_state.owner_wallet_id
          else excluded.owner_wallet_id
        end,
        owner_address = case
          when excluded.identity_resolved_at is null then wallet_onchain_state.owner_address
          else excluded.owner_address
        end,
        owner_source = case
          when excluded.identity_resolved_at is null then wallet_onchain_state.owner_source
          else excluded.owner_source
        end,
        owner_confidence = case
          when excluded.identity_resolved_at is null then wallet_onchain_state.owner_confidence
          else excluded.owner_confidence
        end,
        identity_resolved_at = coalesce(
          excluded.identity_resolved_at,
          wallet_onchain_state.identity_resolved_at
        ),
        wallet_balances = case
          when excluded.balance_as_of is null then wallet_onchain_state.wallet_balances
          else excluded.wallet_balances
        end,
        owner_balances = case
          when excluded.balance_as_of is null then wallet_onchain_state.owner_balances
          else excluded.owner_balances
        end,
        wallet_usd_like_balance = case
          when excluded.balance_as_of is null then wallet_onchain_state.wallet_usd_like_balance
          else excluded.wallet_usd_like_balance
        end,
        owner_usd_like_balance = case
          when excluded.balance_as_of is null then wallet_onchain_state.owner_usd_like_balance
          else excluded.owner_usd_like_balance
        end,
        balance_as_of = coalesce(excluded.balance_as_of, wallet_onchain_state.balance_as_of),
        updated_at = now()
    `,
    [
      input.walletId,
      input.chain,
      input.walletAddress,
      input.identity.walletKind,
      input.ownerWalletId,
      input.identity.ownerAddress,
      input.identity.ownerSource,
      input.identity.ownerConfidence,
      input.identity.identityResolvedAt,
      input.walletBalances,
      input.ownerBalances,
      resolveUsdLikeBalance(input.walletBalances),
      resolveUsdLikeBalance(input.ownerBalances),
      input.balanceAsOf,
    ],
  );
}

async function refreshWalletOnchainState(
  client: Queryable,
  liveVenues: readonly Venue[],
): Promise<WalletOnchainStateRefreshResult> {
  const refreshStartedAtMs = Date.now();
  const limit = walletIntelRefreshPolicy.onchainStateLimit;
  if (limit <= 0 || liveVenues.length === 0) {
    return emptyWalletOnchainStateRefreshResult();
  }

  const staleBefore = new Date(
    Date.now() -
      walletIntelRefreshPolicy.onchainStateStaleHours * 60 * 60 * 1000,
  ).toISOString();
  const errorStaleBefore = new Date(
    Date.now() -
      walletIntelRefreshPolicy.onchainStateErrorStaleHours * 60 * 60 * 1000,
  ).toISOString();
  const quotas = resolveWalletOnchainStateVenueQuotas(limit);
  const rows = await client.query<WalletOnchainStateCandidate>(
    `
      with candidates as (
        select
          w.id as wallet_id,
          w.address,
          w.chain,
          wv.venue,
          w.metadata,
          greatest(
            coalesce(wpe.exposure_usd, 0),
            coalesce(wis.exposure_usd, 0)
          ) as exposure_usd,
          wis.last_activity_at,
          wis.metrics_volume_30d,
          w.last_seen_at,
          row_number() over (
            partition by w.id
            order by case wv.venue
              when 'polymarket' then 0
              when 'limitless' then 1
              when 'kalshi' then 2
              else 9
            end
          ) as venue_rank
        from wallets w
        join wallet_venues wv on wv.wallet_id = w.id
        left join wallet_intel_selector_snapshot wis on wis.wallet_id = w.id
        left join wallet_position_exposure wpe on wpe.wallet_id = w.id
        left join wallet_onchain_state wos on wos.wallet_id = w.id
        where (
            (w.chain = 'polygon' and wv.venue = 'polymarket')
            or (w.chain = 'base' and wv.venue = 'limitless')
            or (w.chain = 'solana' and wv.venue = 'kalshi')
          )
          and wv.venue = any($7::text[])
          and (
            wos.balance_as_of is null
            or wos.balance_as_of < $1::timestamptz
            or (
              w.chain = 'polygon'
              and wv.venue = 'polymarket'
              and (
                wos.identity_resolved_at is null
                or wos.identity_resolved_at < $1::timestamptz
              )
            )
          )
          and not (
            w.chain = 'polygon'
            and wv.venue = 'polymarket'
            and w.metadata->>'walletOnchainIdentityCheckStatus' = 'error'
            and coalesce(
              w.metadata->>'walletOnchainIdentityCheckedAt',
              ''
            ) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            and w.metadata->>'walletOnchainIdentityCheckedAt' >= $2::text
          )
      )
      select wallet_id, address, chain, venue, metadata
      from (
        select
          wallet_id,
          address,
          chain,
          venue,
          metadata,
          exposure_usd,
          last_activity_at,
          metrics_volume_30d,
          last_seen_at,
          row_number() over (
            order by
              exposure_usd desc nulls last,
              last_activity_at desc nulls last,
              metrics_volume_30d desc nulls last,
              last_seen_at desc nulls last,
              wallet_id
          ) as global_rank,
          row_number() over (
            partition by venue
            order by
              exposure_usd desc nulls last,
              last_activity_at desc nulls last,
              metrics_volume_30d desc nulls last,
              last_seen_at desc nulls last,
              wallet_id
          ) as venue_candidate_rank
        from candidates
        where venue_rank = 1
      ) ranked
      where (
          global_rank <= $3
          or (
            venue = 'polymarket'
            and venue_candidate_rank <= $4
          )
          or (
            venue = 'limitless'
            and venue_candidate_rank <= $5
          )
          or (
            venue = 'kalshi'
            and venue_candidate_rank <= $6
          )
        )
      order by global_rank
    `,
    [
      staleBefore,
      errorStaleBefore,
      limit,
      quotas.polymarket,
      quotas.limitless,
      quotas.kalshi,
      liveVenues,
    ],
  );
  const errorStaleBeforeDate = new Date(errorStaleBefore);
  const eligibleRows = rows.rows.filter(
    (row) =>
      !shouldInspectPolymarketIdentity(row) ||
      !isWalletOnchainIdentityErrorFresh(row.metadata, errorStaleBeforeDate),
  );
  const skippedRecentIdentityErrors = rows.rows.length - eligibleRows.length;
  const selectedRows = selectWalletOnchainStateCandidatesFromRanked(
    eligibleRows,
    limit,
    quotas,
  );
  const selectedByChain: Record<string, number> = {};
  for (const row of selectedRows) incrementCount(selectedByChain, row.chain);
  const skippedInvalidAddresses = selectedRows.filter(
    (row) => !normalizeAddress(row.address, row.chain),
  ).length;

  const result: WalletOnchainStateRefreshResult = {
    ...emptyWalletOnchainStateRefreshResult(),
    selected: selectedRows.length,
    skippedInvalidAddresses,
  };
  if (selectedRows.length === 0) {
    console.log("[wallets:intel:refresh] onchain state summary", {
      selected: 0,
      selectedByChain,
      identityKindCounts: {},
      ownersUpserted: 0,
      balanceInputsByChain: {},
      balanceFetchedByChain: {},
      balanceSubjectsFetched: 0,
      ownerBalanceSubjects: 0,
      identityNamesSelected: 0,
      identityNamesUpdated: 0,
      identityNamesPolymarketErrors: 0,
      identityNamesPolymarketFresh: 0,
      identityNamesPolymarketNotFound: 0,
      identityNamesPolymarketResolved: 0,
      identityNamesEnsResolved: 0,
      identityNamesEnsSkipped: 0,
      skippedInvalidAddresses,
      skippedRecentIdentityErrors,
      durationMs: Date.now() - refreshStartedAtMs,
    });
    return result;
  }

  const identities = new Map<string, WalletOnchainIdentityState>();
  const identityKindCounts: Record<string, number> = {};
  const inspectRows = selectedRows.filter(shouldInspectPolymarketIdentity);
  type WalletMetadataUpdate = {
    metadata: Record<string, unknown>;
    walletId: string;
  };
  for (const chunk of chunkArray(inspectRows, 8)) {
    const metadataUpdates = await Promise.all(
      chunk.map(async (row): Promise<WalletMetadataUpdate | null> => {
        const address = normalizeAddress(row.address, row.chain);
        if (!address) return null;
        result.identitiesInspected += 1;
        const checkedAt = new Date().toISOString();
        try {
          const identity = await inspectPolymarketWalletIdentity({ address });
          const state: WalletOnchainIdentityState = {
            walletKind: identity.walletKind,
            ownerAddress: identity.ownerAddress,
            ownerSource: identity.ownerSource,
            ownerConfidence: identity.ownerConfidence,
            safeOwners: identity.safeOwners,
            safeThreshold: identity.safeThreshold,
            identityResolvedAt: checkedAt,
          };
          identities.set(row.wallet_id, state);
          incrementCount(identityKindCounts, state.walletKind);
          return {
            walletId: row.wallet_id,
            metadata: buildPolymarketIdentityMetadata(state),
          };
        } catch (error) {
          result.identityErrors += 1;
          return {
            walletId: row.wallet_id,
            metadata: {
              walletOnchainIdentityCheckStatus: "error",
              walletOnchainIdentityCheckedAt: checkedAt,
              walletOnchainIdentityCheckError:
                error instanceof Error
                  ? error.message.slice(0, 240)
                  : String(error),
            },
          };
        }
      }),
    );

    for (const update of metadataUpdates) {
      if (!update) continue;
      await updateWalletMetadata(client, update.walletId, update.metadata);
    }
  }

  const ownerWalletIds = new Map<string, string>();
  const ownerIdentityNameCandidates: WalletIdentityNameCandidate[] = [];
  for (const row of selectedRows) {
    const identity = identities.get(row.wallet_id);
    const ownerAddress = identity?.ownerAddress;
    if (!ownerAddress) continue;
    const walletAddress = normalizeAddress(row.address, row.chain);
    if (!walletAddress || ownerAddress === walletAddress) continue;
    const ownerWalletId = await upsertWalletIdentityOnly(client, {
      address: ownerAddress,
      chain: row.chain,
      metadata: {
        kind: "wallet_identity_owner",
        ownerForAddress: walletAddress,
        ownerForWalletId: row.wallet_id,
        ownerSource: identity.ownerSource,
        ownerConfidence: identity.ownerConfidence,
        ownerLinkedAt: identity.identityResolvedAt,
      },
    });
    ownerWalletIds.set(
      walletOnchainBalanceKey(row.chain, ownerAddress),
      ownerWalletId,
    );
    ownerIdentityNameCandidates.push({
      walletId: ownerWalletId,
      address: ownerAddress,
      chain: row.chain,
      venue: row.venue,
    });
    result.ownersUpserted += 1;
  }

  const identityNameResult = await refreshWalletIdentityNames(client, [
    ...selectedRows.map((row) => ({
      walletId: row.wallet_id,
      address: row.address,
      chain: row.chain,
      venue: row.venue,
    })),
    ...ownerIdentityNameCandidates,
  ]);
  result.identityNamesSelected = identityNameResult.identityNamesSelected;
  result.identityNamesUpdated = identityNameResult.identityNamesUpdated;
  result.identityNamesPolymarketErrors =
    identityNameResult.identityNamesPolymarketErrors;
  result.identityNamesPolymarketFresh =
    identityNameResult.identityNamesPolymarketFresh;
  result.identityNamesPolymarketNotFound =
    identityNameResult.identityNamesPolymarketNotFound;
  result.identityNamesPolymarketResolved =
    identityNameResult.identityNamesPolymarketResolved;
  result.identityNamesEnsResolved = identityNameResult.identityNamesEnsResolved;
  result.identityNamesEnsSkipped = identityNameResult.identityNamesEnsSkipped;

  const balanceInputs = new Map<string, { address: string; chain: Chain }>();
  const ownerBalanceSubjectKeys = new Set<string>();
  for (const row of selectedRows) {
    const address = normalizeAddress(row.address, row.chain);
    if (!address) continue;
    balanceInputs.set(walletOnchainBalanceKey(row.chain, address), {
      address,
      chain: row.chain,
    });
    const ownerAddress = identities.get(row.wallet_id)?.ownerAddress;
    if (ownerAddress && ownerAddress !== address) {
      const ownerBalanceKey = walletOnchainBalanceKey(row.chain, ownerAddress);
      balanceInputs.set(ownerBalanceKey, {
        address: ownerAddress,
        chain: row.chain,
      });
      ownerBalanceSubjectKeys.add(ownerBalanceKey);
    }
  }
  const balanceInputsByChain: Record<string, number> = {};
  for (const input of balanceInputs.values()) {
    incrementCount(balanceInputsByChain, input.chain);
  }

  let balances = new Map<string, WalletOnchainBalances>();
  let balanceFetchedByChain: Record<string, number> = {};
  try {
    const balanceResult = await fetchWalletLiquidBalancesPartial(
      Array.from(balanceInputs.values()),
    );
    balances = balanceResult.balances;
    result.balancesFetched = balances.size;
    result.balanceSubjectsFetched = balances.size;
    result.ownerBalanceSubjects = ownerBalanceSubjectKeys.size;
    balanceFetchedByChain = {};
    for (const key of balances.keys()) {
      incrementCount(balanceFetchedByChain, key.split(":")[0]);
    }
    for (const failure of balanceResult.errors) {
      console.warn("[wallets:intel:refresh] onchain balance fetch failed", {
        chain: failure.chain,
        error: failure.error,
      });
    }
  } catch (error) {
    console.warn("[wallets:intel:refresh] onchain balance fetch failed", {
      error,
    });
  }

  for (const row of selectedRows) {
    const address = normalizeAddress(row.address, row.chain);
    if (!address) continue;
    const identity =
      identities.get(row.wallet_id) ?? emptyWalletOnchainIdentityState();
    const ownerAddress = identity.ownerAddress;
    const walletBalances =
      balances.get(walletOnchainBalanceKey(row.chain, address)) ?? null;
    const ownerBalances =
      ownerAddress && ownerAddress !== address
        ? (balances.get(walletOnchainBalanceKey(row.chain, ownerAddress)) ??
          null)
        : null;
    const ownerWalletId =
      ownerAddress && ownerAddress !== address
        ? (ownerWalletIds.get(
            walletOnchainBalanceKey(row.chain, ownerAddress),
          ) ?? null)
        : null;
    const balanceAsOf =
      walletBalances || ownerBalances ? new Date().toISOString() : null;

    await upsertWalletOnchainState(client, {
      walletId: row.wallet_id,
      chain: row.chain,
      walletAddress: address,
      identity,
      ownerWalletId,
      walletBalances,
      ownerBalances,
      balanceAsOf,
    });
    result.stateUpserts += 1;
  }

  console.log("[wallets:intel:refresh] onchain state summary", {
    selected: result.selected,
    selectedByChain,
    identitiesInspected: result.identitiesInspected,
    identityErrors: result.identityErrors,
    identityKindCounts,
    identityNamesSelected: result.identityNamesSelected,
    identityNamesUpdated: result.identityNamesUpdated,
    identityNamesPolymarketErrors: result.identityNamesPolymarketErrors,
    identityNamesPolymarketFresh: result.identityNamesPolymarketFresh,
    identityNamesPolymarketNotFound: result.identityNamesPolymarketNotFound,
    identityNamesPolymarketResolved: result.identityNamesPolymarketResolved,
    identityNamesEnsResolved: result.identityNamesEnsResolved,
    identityNamesEnsSkipped: result.identityNamesEnsSkipped,
    ownersUpserted: result.ownersUpserted,
    balanceInputsByChain,
    balanceFetchedByChain,
    balanceSubjectsFetched: result.balanceSubjectsFetched,
    ownerBalanceSubjects: result.ownerBalanceSubjects,
    skippedInvalidAddresses: result.skippedInvalidAddresses,
    skippedRecentIdentityErrors,
    stateUpserts: result.stateUpserts,
    durationMs: Date.now() - refreshStartedAtMs,
  });

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
  liveVenues: readonly Venue[],
): Promise<MarketPickRow[]> {
  const rows: MarketPickRow[] = [];
  const liveVenueSet = new Set(liveVenues);
  const polyMode = walletIntelRefreshPolicy.selectionModePoly;
  const kalshiMode = walletIntelRefreshPolicy.selectionModeKalshi;
  const limitlessMode = walletIntelRefreshPolicy.selectionModeLimitless;

  if (liveVenueSet.has("polymarket") && limitPoly > 0) {
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

  if (liveVenueSet.has("kalshi") && limitKalshi > 0) {
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

  if (liveVenueSet.has("limitless") && limitLimitless > 0) {
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

async function runSnapshot(
  snapshotAt: Date,
  liveIntelScope: LiveIntelVenueScope,
) {
  const runStartedAt = new Date();
  const holderLimit = walletIntelRefreshPolicy.holderLimit;
  const marketLimit = walletIntelRefreshPolicy.marketLimit;
  const marketLimitPerVenue = walletIntelRefreshPolicy.marketLimitPerVenue;
  const marketLimitKalshi = walletIntelRefreshPolicy.marketLimitKalshi;
  const liveVenues = liveIntelScope.venues;
  const liveChains = liveVenues
    .map((venue) => VENUE_CHAIN[venue])
    .filter((chain): chain is Chain => chain != null);
  const telemetry = createRefreshTelemetry();
  const marketFetchConcurrency =
    walletIntelRefreshPolicy.marketFetchConcurrency;
  const attributionPolicy = await resolveWalletIntelAttributionPolicy(pool);
  const followedFetchConcurrency =
    walletIntelRefreshPolicy.followedFetchConcurrency;
  const autoTrackedWalletFetchConcurrency =
    walletIntelRefreshPolicy.autoTrackedWalletFetchConcurrency;
  const marketLimitPerVenueMax = Math.max(
    marketLimitPerVenue,
    marketLimitKalshi,
  );

  console.log(
    `[wallets:intel:refresh] start startedAt=${runStartedAt.toISOString()} markets=${marketLimit} holders=${holderLimit} snapshot=${snapshotAt.toISOString()} liveVenues=${liveVenues.join(",") || "none"} lifecycleRevision=${liveIntelScope.revision} marketFetchConcurrency=${marketFetchConcurrency} followedFetchConcurrency=${followedFetchConcurrency} autoTrackedWalletFetchConcurrency=${autoTrackedWalletFetchConcurrency} autoTrackedFreshPriceCheckEnabled=${walletIntelRefreshPolicy.autoTrackedFreshPriceCheckEnabled} freshPriceMaxAgeMs=${walletIntelRefreshPolicy.freshPriceMaxAgeMs} freshPriceTimeoutMs=${walletIntelRefreshPolicy.freshPriceTimeoutMs}`,
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
          and m.venue = any($4::text[])
          and (m.venue != 'kalshi' or m.is_initialized is true)
          and coalesce(m.volume_24h, 0) >= $1
        order by m.volume_24h desc nulls last
        limit $2
      `,
      [
        walletIntelRefreshPolicy.minVolume24h,
        marketLimit,
        snapshotAt,
        liveVenues,
      ],
    );

    const marketsPerVenueRows =
      marketLimitPerVenueMax > 0
        ? await selectMarketsPerVenue(
            client,
            marketLimitPerVenue,
            marketLimitKalshi,
            marketLimitPerVenue,
            snapshotAt,
            liveVenues,
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
            and um.venue = any($3::text[])
            and (um.venue != 'kalshi' or um.is_initialized is true)
        ) selected
        order by volume_24h desc nulls last
        limit $1
      `,
      [walletIntelRefreshPolicy.watchlistMarketLimit, snapshotAt, liveVenues],
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
                and um.venue = any($3::text[])
                and (um.venue != 'kalshi' or um.is_initialized is true)
              order by um.volume_24h desc nulls last
              limit $1
            `,
            [walletIntelRefreshPolicy.whaleMarketLimit, snapshotAt, liveVenues],
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
    await requestFreshWalletIntelMarketPrices(client, marketRows);

    const walletCache = new Map<string, string>();
    const snapshottedWalletVenueKeys = new Set<string>();
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
    let autoTrackedProcessed = 0;
    let autoTrackedRows = 0;
    let internalProcessed = 0;
    let internalSnapshotRows = 0;
    let internalActivityRows = 0;
    let holderRateLimitErrors = 0;
    let holderAbortErrors = 0;
    let holderOtherErrors = 0;
    const recentTopHolderTrackingCandidates: RecentTopHolderTrackingCandidate[] =
      [];

    const marketResults = (
      await fetchMarketHolderDataBatch({
        markets: marketRows,
        limit: holderLimit,
        liveVenues,
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
        addTokenIndexEntry(tokenIndexByVenue, tokenIdsByVenue, {
          marketId: market.id,
          price: data.priceBySide[side],
          side,
          tokenId,
          venue,
        });
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
          if (
            walletIntelRefreshPolicy.autoTrackedWalletEnabled &&
            sizeUsd != null &&
            Number.isFinite(sizeUsd) &&
            sizeUsd > 0
          ) {
            recentTopHolderTrackingCandidates.push({
              walletId,
              venue,
              marketId: market.id,
              side,
              sizeUsd,
              shares,
              snapshotAt,
            });
          }

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

        snapshottedWalletVenueKeys.add(
          walletVenueSnapshotKey(walletId, market.venue as Venue),
        );
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

    if (walletIntelRefreshPolicy.autoTrackedWalletEnabled) {
      const producerLimit = Math.max(
        1,
        walletIntelRefreshPolicy.autoTrackedWalletLimit * 4,
      );
      const [recentTopHolderSubjects, whaleSubjects] = await Promise.all([
        upsertRecentTopHolderTrackingSubjects(client, {
          candidates: recentTopHolderTrackingCandidates,
          limit: producerLimit,
          selectedAt: snapshotAt,
        }),
        upsertWhaleTrackingSubjects(client, {
          asOf: snapshotAt,
          limit: producerLimit,
        }),
      ]);
      if (recentTopHolderSubjects > 0 || whaleSubjects > 0) {
        console.log("[wallets:intel:refresh] tracking subjects upserted", {
          recentTopHolder: recentTopHolderSubjects,
          whale: whaleSubjects,
        });
      }
    }

    const autoTrackedWallets = walletIntelRefreshPolicy.autoTrackedWalletEnabled
      ? await loadAutoTrackedWalletRows(client, {
          liveVenues,
          asOf: snapshotAt,
          attemptBackoffMinutes:
            walletIntelRefreshPolicy.autoTrackedWalletAttemptBackoffMinutes,
          limit: walletIntelRefreshPolicy.autoTrackedWalletLimit,
          refreshHours: walletIntelRefreshPolicy.autoTrackedWalletRefreshHours,
          subjectTtlDays: walletIntelRefreshPolicy.autoTrackedSubjectTtlDays,
        })
      : [];
    const autoTrackedPreviousOpenPositions =
      walletIntelRefreshPolicy.autoTrackedWalletEnabled
        ? await loadAutoTrackedPreviousOpenPositions(client, {
            snapshotAt,
            wallets: autoTrackedWallets,
          })
        : [];
    const cappedSelectedTokenUniverse = capWalletIntelSelectedTokenUniverse(
      tokenIdsByVenue,
      tokenIndexByVenue,
      walletIntelRefreshPolicy,
    );
    const cappedTokenCounts: Record<Venue, number> = {
      polymarket: cappedSelectedTokenUniverse.tokenIdsByVenue.polymarket.length,
      limitless: cappedSelectedTokenUniverse.tokenIdsByVenue.limitless.length,
      kalshi: cappedSelectedTokenUniverse.tokenIdsByVenue.kalshi.length,
    };
    const droppedTokenCounts: Record<Venue, number> = {
      polymarket: Math.max(
        0,
        tokenIdsByVenue.polymarket.length - cappedTokenCounts.polymarket,
      ),
      limitless: Math.max(
        0,
        tokenIdsByVenue.limitless.length - cappedTokenCounts.limitless,
      ),
      kalshi: Math.max(
        0,
        tokenIdsByVenue.kalshi.length - cappedTokenCounts.kalshi,
      ),
    };
    if (
      droppedTokenCounts.polymarket ||
      droppedTokenCounts.limitless ||
      droppedTokenCounts.kalshi
    ) {
      console.warn("[wallets:intel:refresh] selected token universe capped", {
        kept: cappedTokenCounts,
        dropped: droppedTokenCounts,
      });
    }
    await enqueueWalletIntelMarketRefresh(
      cappedSelectedTokenUniverse.tokenIdsByVenue,
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
        where w.chain = any($2::text[])
        order by wf.created_at desc
        limit $1
      `,
      [walletIntelRefreshPolicy.followedWalletLimit, liveChains],
    );

    const followedCollection = await collectFollowedWalletSnapshotRows(client, {
      followedWallets: followedWallets.rows,
      snapshotAt,
      tokenIdsByVenue: cappedSelectedTokenUniverse.tokenIdsByVenue,
      tokenIndexByVenue: cappedSelectedTokenUniverse.tokenIndexByVenue,
      telemetry,
      followedFetchConcurrency,
      touchedWalletIds,
      snapshottedWalletVenueKeys,
      poolClient: pool,
    });
    followedProcessed = followedCollection.processed;
    followedRows += followedCollection.rowInserts;
    activityRows += followedCollection.activityRows;

    const autoTrackedCollection = await collectAutoTrackedWalletSnapshotRows(
      client,
      {
        autoTrackedWallets,
        previousOpenPositions: autoTrackedPreviousOpenPositions,
        snapshotAt,
        tokenIdsByVenue: cappedSelectedTokenUniverse.tokenIdsByVenue,
        tokenIndexByVenue: cappedSelectedTokenUniverse.tokenIndexByVenue,
        telemetry,
        autoTrackedWalletFetchConcurrency,
        touchedWalletIds,
      },
    );
    autoTrackedProcessed = autoTrackedCollection.processed;
    autoTrackedRows = autoTrackedCollection.rowInserts;
    activityRows += autoTrackedCollection.activityRows;
    await markAutoTrackedWalletRefreshAttempted(client, {
      attemptedAt: snapshotAt,
      wallets: autoTrackedCollection.attemptedWallets,
    });
    await markAutoTrackedWalletsRefreshed(client, {
      refreshedAt: snapshotAt,
      wallets: autoTrackedCollection.refreshedWallets,
    });

    const internalCollection = await collectInternalHunchWalletIntel(client, {
      liveVenues,
      snapshotAt,
      touchedWalletIds,
    });
    internalProcessed = internalCollection.processed;
    internalSnapshotRows = internalCollection.snapshotRows;
    internalActivityRows = internalCollection.activityRows;
    activityRows += internalSnapshotRows + internalActivityRows;
    const artifactMarketIds = Array.from(
      new Set([
        ...selectedMarketIds,
        ...autoTrackedCollection.marketIds,
        ...internalCollection.marketIds,
      ]),
    );

    const artifactRefresh = await refreshTouchedWalletArtifacts(client, {
      touchedWalletIds,
      selectedMarketIds: artifactMarketIds,
      previousOpenMarketKeys: autoTrackedCollection.previousOpenMarketKeys,
      snapshotAt,
      tagIds,
      attributionPolicy: attributionPolicy.effective,
    });
    deltaInserts += artifactRefresh.deltaInserts;
    deltaUpdates += artifactRefresh.deltaUpdates;

    const whaleOwnersLinked = await linkSafeOwnersForWhales(client);
    const polymarketProxyOwnersLinked =
      await linkPolymarketProxyOwnersForKnownWallets(client);
    const onchainStateRefresh = await refreshWalletOnchainState(
      client,
      liveVenues,
    );
    logRefreshTelemetry(telemetry);

    const runFinishedAt = new Date();
    console.log(
      `[wallets:intel:refresh] done finishedAt=${runFinishedAt.toISOString()} durationMs=${runFinishedAt.getTime() - runStartedAt.getTime()} markets=${marketsProcessed} wallets=${touchedWalletIds.size} rows=${activityRows} followed=${followedProcessed} followedRows=${followedRows} autoTracked=${autoTrackedProcessed} autoTrackedRows=${autoTrackedRows} internal=${internalProcessed} internalSnapshotRows=${internalSnapshotRows} internalActivityRows=${internalActivityRows} deltaInserts=${deltaInserts} deltaUpdates=${deltaUpdates} safeLinkSelected=${whaleOwnersLinked.selected} safeLinkInspected=${whaleOwnersLinked.inspected} whaleOwnersLinked=${whaleOwnersLinked.linked} safeLinkErrors=${whaleOwnersLinked.errors} polymarketProxyLinkSelected=${polymarketProxyOwnersLinked.selected} polymarketProxyLinkInspected=${polymarketProxyOwnersLinked.inspected} polymarketProxyOwnersLinked=${polymarketProxyOwnersLinked.linked} polymarketProxyLinkSkipped=${polymarketProxyOwnersLinked.skipped} polymarketProxyLinkErrors=${polymarketProxyOwnersLinked.errors} onchainStateSelected=${onchainStateRefresh.selected} onchainIdentitiesInspected=${onchainStateRefresh.identitiesInspected} onchainIdentityErrors=${onchainStateRefresh.identityErrors} identityNamesSelected=${onchainStateRefresh.identityNamesSelected} identityNamesUpdated=${onchainStateRefresh.identityNamesUpdated} identityNamesPolymarketResolved=${onchainStateRefresh.identityNamesPolymarketResolved} identityNamesPolymarketNotFound=${onchainStateRefresh.identityNamesPolymarketNotFound} identityNamesPolymarketFresh=${onchainStateRefresh.identityNamesPolymarketFresh} identityNamesPolymarketErrors=${onchainStateRefresh.identityNamesPolymarketErrors} identityNamesEnsSkipped=${onchainStateRefresh.identityNamesEnsSkipped} onchainOwnersUpserted=${onchainStateRefresh.ownersUpserted} onchainBalancesFetched=${onchainStateRefresh.balancesFetched} onchainBalanceSubjectsFetched=${onchainStateRefresh.balanceSubjectsFetched} onchainOwnerBalanceSubjects=${onchainStateRefresh.ownerBalanceSubjects} onchainSkippedInvalidAddresses=${onchainStateRefresh.skippedInvalidAddresses} onchainStateUpserts=${onchainStateRefresh.stateUpserts}`,
    );
  } finally {
    client.release();
  }
}

async function main() {
  const lockClient = await pool.connect();
  try {
    const cliArgs = parseWalletIntelRefreshCliArgs();
    const locked = await acquireRefreshAdvisoryLock(lockClient);
    if (!locked) {
      console.warn(
        "[wallets:intel:refresh] skipped; advisory lock is already held",
      );
      return;
    }

    const [refreshPolicy, whalePolicy, liveIntelScope] = await Promise.all([
      cliArgs.ignoreRuntimePolicy
        ? Promise.resolve({
            effective: getIntelPolicyDefaults("wallet_intel_refresh"),
          })
        : resolveWalletIntelRefreshPolicy(pool),
      resolveAiWhaleProfilesPolicy(pool),
      resolveLiveIntelVenueScope(pool),
    ]);
    walletIntelRefreshPolicy = applyWalletIntelRefreshCliArgs(
      refreshPolicy.effective,
      cliArgs,
    );
    aiWhaleProfilesPolicy = whalePolicy.effective;
    hiddenOwnPositionSnapshotSuppressionCache.clear();
    console.log("[wallets:intel:refresh] live venue scope", {
      invalidOverride: liveIntelScope.invalidOverride,
      revision: liveIntelScope.revision,
      source: liveIntelScope.source,
      venues: liveIntelScope.venues,
    });
    if (cliArgs.printEffectivePolicy) {
      console.log("[wallets:intel:refresh] effective wallet intel policy", {
        ignoreRuntimePolicy: cliArgs.ignoreRuntimePolicy,
        walletIntelRefreshPolicy,
      });
    }

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
      await runSnapshot(snapshotAt, liveIntelScope);
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[wallets:intel:refresh] failed", error);
      process.exit(1);
    });
}
