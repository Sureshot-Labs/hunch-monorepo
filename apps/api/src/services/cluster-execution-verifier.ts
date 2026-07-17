import crypto from "node:crypto";
import type { Pool } from "@hunch/infra";

import { isRecord } from "../lib/type-guards.js";
import {
  applyClusterExecutionVerification,
  type ClusterExecutionSummary,
  type ClusterExecutionVerification,
  type ClusterNativeOutcome,
} from "./cluster-execution.js";
import {
  limitlessClobLevelsForToken,
  parseLimitlessClobBook,
  type LimitlessClobBookLevel,
} from "./limitless-clob-book.js";
import { limitlessRequest } from "./limitless-client.js";
import {
  calculatePolymarketQuote,
  loadPolymarketQuoteContext,
  type PolymarketQuoteContext,
} from "./polymarket-quote.js";

const VERIFICATION_CANDIDATE_LIMIT = 5;
const VERIFICATION_CONCURRENCY = 2;
const VERIFICATION_TIMEOUT_MS = 5_000;
const VERIFICATION_MAX_LEG_COST_USD = 25;
const VERIFICATION_CACHE_TTL_MS = 15_000;
const VERIFICATION_CACHE_MAX_ENTRIES = 500;
const LIMITLESS_PUBLIC_FEE_BPS = 300;
const LIMITLESS_FOK_MIN_SHARES = 0.000001;

type VerificationCluster = {
  execution: ClusterExecutionSummary;
  id: string;
};

type VerificationMarketRow = {
  clob_token_ids: string | null;
  id: string;
  metadata: unknown;
  order_min_size: unknown;
  slug: string | null;
  token_no: string | null;
  token_yes: string | null;
  venue: string;
};

type PreparedVerificationLeg = {
  minShares: number;
  quote(shares: number): Promise<ClusterVerifiedLeg>;
};

export type ClusterVerifiedLeg = {
  filledShares: number;
  fees: number;
  totalCost: number;
};

type CacheEntry = {
  expiresAt: number;
  fingerprint: string;
  value: ClusterExecutionVerification;
};

const verificationCache = new Map<string, CacheEntry>();

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function parseClobTokenIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function tokenForOutcome(
  market: VerificationMarketRow,
  outcome: ClusterNativeOutcome,
): string | null {
  const clob = parseClobTokenIds(market.clob_token_ids);
  return outcome === "YES"
    ? (clob[0] ?? market.token_yes)
    : (clob[1] ?? market.token_no);
}

function isLimitlessAmm(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  for (const key of ["amm", "isAmm", "is_amm", "enableAmm", "enable_amm"]) {
    const value = metadata[key];
    if (value === true || value === "true" || value === 1 || value === "1") {
      return true;
    }
  }
  const marketType =
    typeof metadata.marketType === "string"
      ? metadata.marketType
      : typeof metadata.market_type === "string"
        ? metadata.market_type
        : null;
  return marketType?.trim().toLowerCase() === "amm";
}

function unavailableVerification(): ClusterExecutionVerification {
  return {
    netEdge: null,
    shares: null,
    status: "unavailable",
    totalCost: null,
    totalFees: null,
    verifiedAt: null,
  };
}

function fingerprint(
  cluster: VerificationCluster,
  shares: number | null,
): string {
  const execution = cluster.execution;
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        no: execution.bestNoOffer
          ? {
              ask: execution.bestNoOffer.ask,
              asOf: execution.bestNoOffer.asOf,
              marketId: execution.bestNoOffer.marketId,
              nativeOutcome: execution.bestNoOffer.nativeOutcome,
            }
          : null,
        shares,
        yes: execution.bestYesOffer
          ? {
              ask: execution.bestYesOffer.ask,
              asOf: execution.bestYesOffer.asOf,
              marketId: execution.bestYesOffer.marketId,
              nativeOutcome: execution.bestYesOffer.nativeOutcome,
            }
          : null,
      }),
    )
    .digest("hex");
}

function verificationCacheKey(cluster: VerificationCluster): string {
  return `${cluster.id}:${fingerprint(cluster, null)}`;
}

function readCached(cluster: VerificationCluster, nowMs: number) {
  const key = verificationCacheKey(cluster);
  const cached = verificationCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= nowMs) {
    verificationCache.delete(key);
    return null;
  }
  if (cached.fingerprint !== fingerprint(cluster, cached.value.shares)) {
    verificationCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeCached(
  cluster: VerificationCluster,
  value: ClusterExecutionVerification,
  nowMs: number,
) {
  if (verificationCache.size >= VERIFICATION_CACHE_MAX_ENTRIES) {
    const oldest = verificationCache.keys().next().value;
    if (typeof oldest === "string") verificationCache.delete(oldest);
  }
  const key = verificationCacheKey(cluster);
  verificationCache.set(key, {
    expiresAt: nowMs + VERIFICATION_CACHE_TTL_MS,
    fingerprint: fingerprint(cluster, value.shares),
    value,
  });
}

function hasPolymarketDepth(
  context: PolymarketQuoteContext,
  shares: number,
  maxPrice: number,
): boolean {
  let available = 0;
  for (const ask of context.orderbook.asks) {
    if (
      !Number.isFinite(ask.price) ||
      !Number.isFinite(ask.size) ||
      ask.price <= 0 ||
      ask.size <= 0 ||
      ask.price > maxPrice + 1e-9
    ) {
      continue;
    }
    available += ask.size;
    if (available + 1e-9 >= shares) return true;
  }
  return false;
}

async function preparePolymarketLeg(input: {
  market: VerificationMarketRow;
  outcome: ClusterNativeOutcome;
  pool: Pool;
}): Promise<PreparedVerificationLeg | null> {
  const tokenId = tokenForOutcome(input.market, input.outcome);
  if (!tokenId) return null;
  const context = await loadPolymarketQuoteContext(input.pool, { tokenId });
  const minShares =
    positiveNumber(context.orderbook.minOrderSize) ??
    positiveNumber(input.market.order_min_size);
  if (minShares == null) return null;
  return {
    minShares,
    quote: async (shares) => {
      const quote = calculatePolymarketQuote({
        amountSharesInput: shares,
        amountType: "shares",
        context,
        orderType: "FOK",
        side: "BUY",
        slippageBps: 100,
        tokenId,
      });
      if (
        quote.violatesMinOrderSize === true ||
        quote.size + 1e-9 < shares ||
        !hasPolymarketDepth(context, quote.size, quote.price)
      ) {
        throw new Error("Polymarket depth is insufficient");
      }
      const fees = Number(quote.totalFeeEstimateRaw) / 1_000_000;
      const totalCost =
        quote.totalRequiredUsdcRaw != null
          ? Number(quote.totalRequiredUsdcRaw) / 1_000_000
          : quote.amountUsdUsed + fees;
      return { filledShares: quote.size, fees, totalCost };
    },
  };
}

export type LimitlessVerificationBookLevel = LimitlessClobBookLevel;

export function quoteLimitlessLevelsForVerification(
  levels: LimitlessVerificationBookLevel[],
  targetNetShares: number,
): ClusterVerifiedLeg {
  const feeRate = LIMITLESS_PUBLIC_FEE_BPS / 10_000;
  const grossShares = targetNetShares / (1 - feeRate);
  let remaining = grossShares;
  let totalCost = 0;
  for (const level of levels) {
    const taken = Math.min(remaining, level.size);
    totalCost += taken * level.price;
    remaining -= taken;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9) throw new Error("Limitless depth is insufficient");
  const feeShares = grossShares - targetNetShares;
  const averagePrice = grossShares > 0 ? totalCost / grossShares : 0;
  return {
    filledShares: targetNetShares,
    fees: feeShares * averagePrice,
    totalCost,
  };
}

async function prepareLimitlessLeg(input: {
  market: VerificationMarketRow;
  outcome: ClusterNativeOutcome;
}): Promise<PreparedVerificationLeg | null> {
  if (!input.market.slug || isLimitlessAmm(input.market.metadata)) return null;
  const tokenId = tokenForOutcome(input.market, input.outcome);
  if (!tokenId) return null;
  const response = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(input.market.slug)}/orderbook`,
  });
  if (!response.ok) return null;
  const book = parseLimitlessClobBook(response.payload);
  if (!book) return null;
  const levels = limitlessClobLevelsForToken({
    book,
    side: "BUY",
    tokenId,
  });
  if (!levels?.length) return null;
  return {
    minShares: LIMITLESS_FOK_MIN_SHARES,
    quote: async (shares) =>
      quoteLimitlessLevelsForVerification(levels, shares),
  };
}

async function loadVerificationMarkets(
  pool: Pool,
  marketIds: string[],
): Promise<Map<string, VerificationMarketRow>> {
  const { rows } = await pool.query<VerificationMarketRow>(
    `
      select
        m.id,
        m.venue,
        m.slug,
        m.metadata,
        m.token_yes,
        m.token_no,
        m.clob_token_ids,
        pm.order_min_size
      from unified_markets m
      left join polymarket_markets pm
        on pm.id = m.venue_market_id
       and m.venue = 'polymarket'
      where m.id = any($1::text[])
    `,
    [marketIds],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function prepareDefaultLeg(input: {
  market: VerificationMarketRow;
  outcome: ClusterNativeOutcome;
  pool: Pool;
}): Promise<PreparedVerificationLeg | null> {
  if (input.market.venue === "polymarket") {
    return preparePolymarketLeg(input);
  }
  if (input.market.venue === "limitless") {
    return prepareLimitlessLeg(input);
  }
  return null;
}

export function finalizeClusterExecutionVerification(input: {
  noLeg: ClusterVerifiedLeg;
  noMinShares: number;
  verifiedAt: string;
  yesLeg: ClusterVerifiedLeg;
  yesMinShares: number;
}): ClusterExecutionVerification {
  const shares = Math.max(input.yesMinShares, input.noMinShares);
  if (
    !Number.isFinite(shares) ||
    shares <= 0 ||
    input.yesLeg.filledShares + 1e-9 < shares ||
    input.noLeg.filledShares + 1e-9 < shares ||
    input.yesLeg.totalCost > VERIFICATION_MAX_LEG_COST_USD ||
    input.noLeg.totalCost > VERIFICATION_MAX_LEG_COST_USD
  ) {
    return unavailableVerification();
  }
  const totalCost = input.yesLeg.totalCost + input.noLeg.totalCost;
  const totalFees = input.yesLeg.fees + input.noLeg.fees;
  const netEdge = shares - totalCost;
  return {
    netEdge,
    shares,
    status: netEdge > 0 ? "verified" : "rejected",
    totalCost,
    totalFees,
    verifiedAt: input.verifiedAt,
  };
}

async function verifyOne(input: {
  cluster: VerificationCluster;
  pool: Pool;
  now: Date;
}): Promise<ClusterExecutionVerification> {
  const { bestNoOffer, bestYesOffer } = input.cluster.execution;
  if (!bestNoOffer || !bestYesOffer) return unavailableVerification();
  const markets = await loadVerificationMarkets(input.pool, [
    bestYesOffer.marketId,
    bestNoOffer.marketId,
  ]);
  const yesMarket = markets.get(bestYesOffer.marketId);
  const noMarket = markets.get(bestNoOffer.marketId);
  if (!yesMarket || !noMarket) return unavailableVerification();
  const [yesLeg, noLeg] = await Promise.all([
    prepareDefaultLeg({
      market: yesMarket,
      outcome: bestYesOffer.nativeOutcome,
      pool: input.pool,
    }),
    prepareDefaultLeg({
      market: noMarket,
      outcome: bestNoOffer.nativeOutcome,
      pool: input.pool,
    }),
  ]);
  if (!yesLeg || !noLeg) return unavailableVerification();
  const shares = Math.max(yesLeg.minShares, noLeg.minShares);
  if (!Number.isFinite(shares) || shares <= 0) return unavailableVerification();
  const [yesQuote, noQuote] = await Promise.all([
    yesLeg.quote(shares),
    noLeg.quote(shares),
  ]);
  return finalizeClusterExecutionVerification({
    noLeg: noQuote,
    noMinShares: noLeg.minShares,
    verifiedAt: input.now.toISOString(),
    yesLeg: yesQuote,
    yesMinShares: yesLeg.minShares,
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Cluster verification timed out")),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function verifyClusterExecutions<T extends VerificationCluster>(
  pool: Pool,
  clusters: T[],
  now = new Date(),
): Promise<T[]> {
  const deadlineMs = Date.now() + VERIFICATION_TIMEOUT_MS;
  const candidates = clusters
    .filter(
      (cluster) =>
        cluster.execution.quotesFresh &&
        (cluster.execution.grossEdge ?? 0) > 0 &&
        cluster.execution.bestYesOffer?.venue !==
          cluster.execution.bestNoOffer?.venue,
    )
    .sort(
      (left, right) =>
        (right.execution.grossEdge ?? 0) - (left.execution.grossEdge ?? 0),
    )
    .slice(0, VERIFICATION_CANDIDATE_LIMIT);
  const candidateIds = new Set(candidates.map((cluster) => cluster.id));
  const verifications = await mapWithConcurrency(
    candidates,
    VERIFICATION_CONCURRENCY,
    async (cluster) => {
      const cached = readCached(cluster, now.getTime());
      if (cached) return [cluster.id, cached] as const;
      let verification: ClusterExecutionVerification;
      try {
        const remainingMs = deadlineMs - Date.now();
        verification =
          remainingMs > 0
            ? await withTimeout(verifyOne({ cluster, pool, now }), remainingMs)
            : unavailableVerification();
      } catch {
        verification = unavailableVerification();
      }
      writeCached(cluster, verification, now.getTime());
      return [cluster.id, verification] as const;
    },
  );
  const byId = new Map(verifications);
  return clusters.map((cluster) => {
    if (!candidateIds.has(cluster.id)) return cluster;
    const verification = byId.get(cluster.id) ?? unavailableVerification();
    return {
      ...cluster,
      execution: applyClusterExecutionVerification(
        cluster.execution,
        verification,
      ),
    };
  });
}
