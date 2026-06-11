import { tx, type Pool } from "@hunch/infra";
import type { Position } from "../order-types.js";
import {
  expandPolymarketWallets,
  syncWalletPositionsFromTokenBalances,
  type WalletTokenBalance,
} from "../repos/positions-repo.js";
import { env } from "../env.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { normalizeLimitlessScopedTokenId } from "../lib/limitless-token.js";
import { requestPriceRefreshForTokens } from "../lib/price-refresh.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchSolanaTokenBalancesByOwner,
  type SolanaTokenBalance,
} from "./solana-rpc.js";
import {
  fetchErc1155BalancesByOwner,
  fetchErc1155BalancesByOwners,
} from "./polygon-rpc.js";
import { ethers } from "ethers";
import { recomputePositionMetricsForWallet } from "./positions-metrics.js";
import { notifyResolvedPositions } from "./positions-notifications.js";
import { AuthService } from "../auth.js";
import { fetchPolymarketTrades } from "./polymarket-clob-l2.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "./notifications.js";
import { insertVolumeEventsWithMultiplierInTx } from "./rewards-multiplier.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "./limitless-client.js";
import {
  buildLimitlessRequestAuthInputs,
  resolveLimitlessAuthContext,
} from "./limitless-auth.js";
import { syncLimitlessHistoryForWallet } from "./limitless-history.js";
import {
  buildPolymarketBuilderFeeAccrual,
  resolvePolymarketBuilderFeeConfig,
  upsertPolymarketBuilderFeeAccruals,
} from "./polymarket-builder-fees.js";
import { isAbortError } from "@hunch/shared";

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
type PositionRefreshVenue = "polymarket" | "dflow" | "limitless";
const POSITION_REFRESH_STALE_MARKET_MINUTES = 15;
const POLYMARKET_BALANCE_BATCH_MAX_PAIRS = 1000;
const POLYMARKET_DATA_API_POSITIONS_LIMIT = 500;
const POLYMARKET_DATA_API_POSITIONS_SIZE_THRESHOLD = "0.01";
const POLYMARKET_RECENT_ORDER_CANDIDATE_HOURS = 24;
const LIMITLESS_HISTORY_SYNC_WARN_TTL_MS = 5 * 60 * 1000;
const limitlessHistorySyncWarnAt = new Map<string, number>();
let limitlessHistorySyncWarnSweepAt = 0;

function isEthAddress(address: string): boolean {
  return ETH_ADDRESS_RE.test(address);
}

function parseNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function normalizeFillSide(
  value: string | null | undefined,
): "BUY" | "SELL" | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "BUY" || normalized === "SELL") return normalized;
  return null;
}

function normalizeLimitlessSnapshotBalance(value: unknown): string | null {
  if (typeof value === "bigint") {
    if (value <= 0n) return null;
    return ethers.formatUnits(value, 6);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (Number.isInteger(value)) {
      return ethers.formatUnits(BigInt(Math.trunc(value)), 6);
    }
    return value.toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^[0-9]+$/.test(trimmed)) {
      try {
        const raw = BigInt(trimmed);
        if (raw <= 0n) return null;
        return ethers.formatUnits(raw, 6);
      } catch {
        return null;
      }
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return trimmed;
  }
  return null;
}

function parseTokenIdString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}

function extractPositionIds(value: unknown): string[] {
  const output: string[] = [];
  const visit = (input: unknown) => {
    if (Array.isArray(input)) {
      for (const entry of input) visit(entry);
      return;
    }
    if (typeof input === "string" || typeof input === "number") {
      const text = String(input).trim();
      if (text) output.push(text);
    }
  };
  visit(value);
  return output;
}

function resolveLimitlessMarketTokenId(
  market: Record<string, unknown> | null,
  side: "yes" | "no",
  fallback: string | null,
): string | null {
  if (!market) return fallback;
  const nested =
    (isRecord(market.tokens) ? market.tokens : null) ??
    (isRecord(market.token) ? market.token : null);
  if (nested) {
    const nestedTokenId = parseTokenIdString(nested[side]);
    if (nestedTokenId) return nestedTokenId;
  }

  const sideSuffix = side === "yes" ? "yes" : "no";
  const candidates = [
    market[`${sideSuffix}PositionId`],
    market[`${sideSuffix}_position_id`],
    market[`${sideSuffix}TokenId`],
    market[`${sideSuffix}_token_id`],
  ];
  for (const candidate of candidates) {
    const parsed = parseTokenIdString(candidate);
    if (parsed) return parsed;
  }

  return fallback;
}

function mergeWalletTokenBalances(
  ...sources: WalletTokenBalance[][]
): WalletTokenBalance[] {
  const merged = new Map<string, { numeric: number; size: string }>();
  for (const source of sources) {
    for (const balance of source) {
      const tokenId = balance.tokenId;
      const size = balance.size;
      if (!tokenId || !size) continue;
      const numeric = Number(size);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      const existing = merged.get(tokenId);
      if (!existing || numeric > existing.numeric) {
        merged.set(tokenId, { numeric, size });
      }
    }
  }
  return Array.from(merged.entries()).map(([tokenId, value]) => ({
    tokenId,
    size: value.size,
  }));
}

function shouldLogLimitlessHistorySyncWarning(
  walletAddress: string,
  message: string,
): boolean {
  const key = `${walletAddress}:${message}`;
  const now = Date.now();
  if (
    now - limitlessHistorySyncWarnSweepAt >=
    LIMITLESS_HISTORY_SYNC_WARN_TTL_MS
  ) {
    for (const [warnKey, lastAt] of limitlessHistorySyncWarnAt.entries()) {
      if (now - lastAt >= LIMITLESS_HISTORY_SYNC_WARN_TTL_MS) {
        limitlessHistorySyncWarnAt.delete(warnKey);
      }
    }
    limitlessHistorySyncWarnSweepAt = now;
  }
  const lastAt = limitlessHistorySyncWarnAt.get(key) ?? 0;
  if (now - lastAt < LIMITLESS_HISTORY_SYNC_WARN_TTL_MS) return false;
  limitlessHistorySyncWarnAt.set(key, now);
  return true;
}

function normalizeNumericTokenIds(tokenIds: string[]): string[] {
  return Array.from(
    new Set(
      tokenIds
        .map((tokenId) => tokenId.trim())
        .filter((tokenId) => tokenId.length > 0 && /^[0-9]+$/.test(tokenId)),
    ),
  );
}

export function normalizePositionRefreshTokenIds(
  venue: Position["venue"],
  tokenIds: Array<string | null | undefined>,
): string[] {
  if (venue === "polymarket") {
    return normalizeNumericTokenIds(
      tokenIds.filter((tokenId): tokenId is string => Boolean(tokenId)),
    );
  }

  const output = new Set<string>();
  for (const rawTokenId of tokenIds) {
    const tokenId = rawTokenId?.trim();
    if (!tokenId) continue;
    if (venue === "kalshi") {
      if (tokenId.startsWith("sol:")) output.add(tokenId);
      continue;
    }
    const scoped = normalizeLimitlessScopedTokenId(tokenId);
    if (scoped) output.add(scoped);
  }
  return Array.from(output);
}

function toPositionRefreshVenue(
  venue: Position["venue"],
): PositionRefreshVenue {
  return venue === "kalshi" ? "dflow" : venue;
}

function requestPositionMarketRefresh(inputs: {
  venue: Position["venue"];
  tokenIds: Array<string | null | undefined>;
}) {
  const tokenIds = normalizePositionRefreshTokenIds(
    inputs.venue,
    inputs.tokenIds,
  );
  if (!tokenIds.length) return;

  const refreshVenue = toPositionRefreshVenue(inputs.venue);
  void markHotTokens({
    tokenIds,
    venue: refreshVenue,
  });
  void requestPriceRefreshForTokens({ tokenIds, venue: refreshVenue });
}

async function fetchOpenPositionTokenIdsForRefresh(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: Position["venue"];
    positionScope: PositionScope;
    tokenIdLike?: string;
  },
): Promise<string[]> {
  const walletClause = isEthAddress(inputs.walletAddress)
    ? "lower(wallet_address) = lower($2)"
    : "wallet_address = $2";
  const params: Array<string> = [
    inputs.userId,
    inputs.walletAddress,
    inputs.venue,
    inputs.positionScope,
  ];
  let tokenLikeClause = "";
  if (inputs.tokenIdLike) {
    params.push(inputs.tokenIdLike);
    tokenLikeClause = `and p.token_id like $${params.length}`;
  }

  params.push(POSITION_REFRESH_STALE_MARKET_MINUTES.toString());
  const staleParam = params.length;

  const { rows } = await pool.query<{ token_id: string | null }>(
    `
      select distinct p.token_id
      from positions p
      left join unified_tokens t
        on t.venue = p.venue
       and t.token_id = p.token_id
      left join unified_markets m
        on m.id = t.market_id
       and m.venue = p.venue
      where p.user_id = $1
        and ${walletClause.replaceAll("wallet_address", "p.wallet_address")}
        and p.venue = $3
        and p.position_scope = $4
        and p.side <> 'FLAT'
        and p.size > 0
        and (p.is_hidden is null or p.is_hidden = false)
        and p.token_id is not null
        and p.token_id <> ''
        ${tokenLikeClause}
        and (
          m.id is null
          or (
            m.resolved_outcome is null
            and m.resolved_outcome_pct is null
            and (
              coalesce(m.updated_at_db, m.updated_at, m.created_at_db)
                < now() - ($${staleParam}::int * interval '1 minute')
              or (
                m.status = 'ACTIVE'
                and coalesce(m.expiration_time, m.close_time) is not null
                and coalesce(m.expiration_time, m.close_time) <= now()
              )
            )
          )
        )
    `,
    params,
  );

  return normalizePositionRefreshTokenIds(
    inputs.venue,
    rows.map((row) => row.token_id),
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  handler: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(Math.trunc(limit), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await handler(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function resolvePolymarketOwnerAddresses(
  walletAddress: string,
  funderAddress: string | null,
): string[] {
  const ownerCandidates = [funderAddress, walletAddress].filter(
    (address): address is string => Boolean(address),
  );
  return Array.from(
    new Map(
      ownerCandidates.map((address) => [address.toLowerCase(), address]),
    ).values(),
  );
}

export function resolvePolymarketTrackedTokenUniverse(
  candidateTokenIds: string[],
  trackedTokenIds: string[],
): string[] {
  return normalizeNumericTokenIds([...candidateTokenIds, ...trackedTokenIds]);
}

export function estimateErc1155BalanceRpcCalls(
  ownerCount: number,
  tokenIds: string[],
  chunkSize = 200,
): number {
  const normalizedTokenIds = normalizeNumericTokenIds(tokenIds);
  const owners = Math.max(0, Math.trunc(ownerCount));
  const safeChunkSize = Math.max(1, Math.trunc(chunkSize));
  if (owners === 0 || normalizedTokenIds.length === 0) return 0;
  return owners * Math.ceil(normalizedTokenIds.length / safeChunkSize);
}

export function estimateErc1155OwnerTokenPairRpcCalls(
  ownerCount: number,
  tokenIds: string[],
  maxPairsPerCall = POLYMARKET_BALANCE_BATCH_MAX_PAIRS,
): number {
  const normalizedTokenIds = normalizeNumericTokenIds(tokenIds);
  const owners = Math.max(0, Math.trunc(ownerCount));
  const safeMaxPairsPerCall = Math.max(1, Math.trunc(maxPairsPerCall));
  if (owners === 0 || normalizedTokenIds.length === 0) return 0;
  return Math.ceil((owners * normalizedTokenIds.length) / safeMaxPairsPerCall);
}

async function fetchErc1155OwnerTokenBalances(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  contractAddress: string;
  owner: string;
  tokenIds: string[];
  onRpcCall?: (() => void) | null;
}): Promise<WalletTokenBalance[]> {
  const tokenIds = normalizeNumericTokenIds(inputs.tokenIds);
  if (tokenIds.length === 0) return [];

  const balances: WalletTokenBalance[] = [];
  const chunkSize = 200;
  for (let i = 0; i < tokenIds.length; i += chunkSize) {
    const chunk = tokenIds.slice(i, i + chunkSize);
    inputs.onRpcCall?.();
    const chunkBalances = await fetchErc1155BalancesByOwner({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      contractAddress: inputs.contractAddress,
      owner: inputs.owner,
      tokenIds: chunk,
    });

    for (const tokenId of chunk) {
      const balance = chunkBalances.get(tokenId) ?? 0n;
      if (balance <= 0n) continue;
      balances.push({
        tokenId,
        size: ethers.formatUnits(balance, 6),
      });
    }
  }

  return balances;
}

async function fetchErc1155OwnerTokenBalancesForOwners(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  contractAddress: string;
  owners: string[];
  tokenIds: string[];
  maxPairsPerCall?: number;
  onRpcCall?: (() => void) | null;
}): Promise<Map<string, WalletTokenBalance[]>> {
  const owners = Array.from(
    new Map(
      inputs.owners
        .filter(isEthAddress)
        .map((owner) => [owner.toLowerCase(), owner]),
    ).values(),
  );
  const tokenIds = normalizeNumericTokenIds(inputs.tokenIds);
  const output = new Map<string, WalletTokenBalance[]>();
  for (const owner of owners) {
    output.set(owner.toLowerCase(), []);
  }
  if (owners.length === 0 || tokenIds.length === 0) return output;

  const balancesByOwner = await fetchErc1155BalancesByOwners({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    contractAddress: inputs.contractAddress,
    owners,
    tokenIds,
    maxPairsPerCall: inputs.maxPairsPerCall,
    onRpcCall: inputs.onRpcCall,
  });

  for (const owner of owners) {
    const rawBalances = balancesByOwner.get(owner.toLowerCase()) ?? new Map();
    const balances: WalletTokenBalance[] = [];
    for (const tokenId of tokenIds) {
      const balance = rawBalances.get(tokenId) ?? 0n;
      if (balance <= 0n) continue;
      balances.push({
        tokenId,
        size: ethers.formatUnits(balance, 6),
      });
    }
    output.set(owner.toLowerCase(), balances);
  }

  return output;
}

type PolymarketDataApiPositionSnapshot = {
  tokenId: string;
  averagePrice: string | null;
};

type PolymarketDataApiCacheEntry = {
  expiresAt: number;
  snapshots: PolymarketDataApiPositionSnapshot[];
};

const polymarketDataApiSnapshotCache = new Map<
  string,
  PolymarketDataApiCacheEntry
>();
const polymarketDataApiSnapshotFailureCache = new Map<
  string,
  PolymarketDataApiCacheEntry
>();
const polymarketDataApiSnapshotInflight = new Map<
  string,
  Promise<PolymarketDataApiPositionSnapshot[]>
>();
let polymarketDataApiSnapshotCacheSweepAt = 0;

function sweepPolymarketDataApiSnapshotCache(now: number) {
  if (now - polymarketDataApiSnapshotCacheSweepAt < 60_000) return;
  polymarketDataApiSnapshotCacheSweepAt = now;
  for (const [key, entry] of polymarketDataApiSnapshotCache.entries()) {
    if (entry.expiresAt <= now) {
      polymarketDataApiSnapshotCache.delete(key);
    }
  }
  for (const [key, entry] of polymarketDataApiSnapshotFailureCache.entries()) {
    if (entry.expiresAt <= now) {
      polymarketDataApiSnapshotFailureCache.delete(key);
    }
  }
}

function normalizePolymarketDataApiPrice(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value.toString() : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? trimmed : null;
  }
  return null;
}

function normalizePolymarketDataApiTokenId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 && /^[0-9]+$/.test(trimmed) ? trimmed : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "bigint" && value >= 0n) {
    return value.toString();
  }
  return null;
}

function extractPolymarketDataApiPositionEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const output: unknown[] = [];
  const roots = [payload, payload.data].filter(Boolean);
  for (const root of roots) {
    if (Array.isArray(root)) {
      output.push(...root);
      continue;
    }
    if (!isRecord(root)) continue;
    for (const key of ["positions", "data", "results", "items"]) {
      const value = root[key];
      if (Array.isArray(value)) {
        output.push(...value);
      }
    }
  }
  return output;
}

function extractPolymarketDataApiPositionSnapshots(
  payload: unknown,
): PolymarketDataApiPositionSnapshot[] {
  const snapshots: PolymarketDataApiPositionSnapshot[] = [];
  for (const entry of extractPolymarketDataApiPositionEntries(payload)) {
    if (!isRecord(entry)) continue;
    const tokenId =
      normalizePolymarketDataApiTokenId(entry.asset) ??
      normalizePolymarketDataApiTokenId(entry.tokenId) ??
      normalizePolymarketDataApiTokenId(entry.token_id) ??
      normalizePolymarketDataApiTokenId(entry.asset_id) ??
      normalizePolymarketDataApiTokenId(entry.outcomeTokenId);
    if (!tokenId) continue;
    snapshots.push({
      tokenId,
      averagePrice:
        normalizePolymarketDataApiPrice(entry.avgPrice) ??
        normalizePolymarketDataApiPrice(entry.averagePrice) ??
        normalizePolymarketDataApiPrice(entry.avg_price) ??
        normalizePolymarketDataApiPrice(entry.average_price),
    });
  }
  return Array.from(
    new Map(snapshots.map((snapshot) => [snapshot.tokenId, snapshot])).values(),
  );
}

async function fetchPolymarketDataApiPositionSnapshots(
  owner: string,
): Promise<PolymarketDataApiPositionSnapshot[]> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    env.polymarketDataApiPositionsTimeoutMs,
  );
  try {
    const url = new URL("/positions", env.polymarketDataApiBase);
    url.searchParams.set("user", owner);
    url.searchParams.set(
      "sizeThreshold",
      POLYMARKET_DATA_API_POSITIONS_SIZE_THRESHOLD,
    );
    url.searchParams.set("limit", String(POLYMARKET_DATA_API_POSITIONS_LIMIT));

    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Polymarket Data API positions failed: ${response.status}`,
      );
    }
    const payload = (await response.json()) as unknown;
    return extractPolymarketDataApiPositionSnapshots(payload);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCachedPolymarketDataApiPositionSnapshots(
  owner: string,
): Promise<PolymarketDataApiPositionSnapshot[]> {
  const key = owner.toLowerCase();
  const now = Date.now();
  sweepPolymarketDataApiSnapshotCache(now);

  if (env.polymarketDataApiPositionsCacheTtlMs > 0) {
    const cached = polymarketDataApiSnapshotCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.snapshots;
    }
  }
  if (env.polymarketDataApiPositionsFailureCacheTtlMs > 0) {
    const cachedFailure = polymarketDataApiSnapshotFailureCache.get(key);
    if (cachedFailure && cachedFailure.expiresAt > now) {
      return cachedFailure.snapshots;
    }
  }

  const inflight = polymarketDataApiSnapshotInflight.get(key);
  if (inflight) return inflight;

  const promise = fetchPolymarketDataApiPositionSnapshots(owner)
    .then((snapshots) => {
      if (env.polymarketDataApiPositionsCacheTtlMs > 0) {
        polymarketDataApiSnapshotCache.set(key, {
          expiresAt: Date.now() + env.polymarketDataApiPositionsCacheTtlMs,
          snapshots,
        });
      }
      return snapshots;
    })
    .catch((error) => {
      if (
        isAbortError(error) &&
        env.polymarketDataApiPositionsFailureCacheTtlMs > 0
      ) {
        polymarketDataApiSnapshotFailureCache.set(key, {
          expiresAt:
            Date.now() + env.polymarketDataApiPositionsFailureCacheTtlMs,
          snapshots: [],
        });
      }
      throw error;
    })
    .finally(() => {
      polymarketDataApiSnapshotInflight.delete(key);
    });
  polymarketDataApiSnapshotInflight.set(key, promise);
  return promise;
}

export function resetPolymarketDataApiSnapshotCachesForTests() {
  polymarketDataApiSnapshotCache.clear();
  polymarketDataApiSnapshotFailureCache.clear();
  polymarketDataApiSnapshotInflight.clear();
  polymarketDataApiSnapshotCacheSweepAt = 0;
}

export async function fetchPolymarketDataApiSnapshotsForOwnersForTests(
  owners: string[],
) {
  return fetchPolymarketDataApiSnapshotsForOwners(owners);
}

async function fetchPolymarketDataApiSnapshotsForOwners(
  owners: string[],
): Promise<Map<string, Map<string, PolymarketDataApiPositionSnapshot>>> {
  const normalizedOwners = Array.from(
    new Map(
      owners.filter(isEthAddress).map((owner) => [owner.toLowerCase(), owner]),
    ).values(),
  );
  const output = new Map<
    string,
    Map<string, PolymarketDataApiPositionSnapshot>
  >();
  if (normalizedOwners.length === 0) return output;

  const results = await mapWithConcurrency(
    normalizedOwners,
    4,
    async (owner) => {
      try {
        return {
          owner,
          snapshots: await fetchCachedPolymarketDataApiPositionSnapshots(owner),
        };
      } catch (error) {
        console.warn("Polymarket Data API position token discovery failed", {
          owner,
          error: error instanceof Error ? error.message : String(error),
        });
        return { owner, snapshots: [] };
      }
    },
  );

  for (const result of results) {
    output.set(
      result.owner.toLowerCase(),
      new Map(result.snapshots.map((snapshot) => [snapshot.tokenId, snapshot])),
    );
  }

  return output;
}

function flattenPolymarketDataApiTokenIds(
  snapshotsByOwner: Map<string, Map<string, PolymarketDataApiPositionSnapshot>>,
): string[] {
  const tokenIds: string[] = [];
  for (const snapshots of snapshotsByOwner.values()) {
    tokenIds.push(...snapshots.keys());
  }
  return normalizeNumericTokenIds(tokenIds);
}

function applyPolymarketDataApiAveragePrices(
  balances: WalletTokenBalance[],
  owner: string,
  snapshotsByOwner:
    | Map<string, Map<string, PolymarketDataApiPositionSnapshot>>
    | null
    | undefined,
): WalletTokenBalance[] {
  const snapshots = snapshotsByOwner?.get(owner.toLowerCase());
  if (!snapshots?.size) return balances;
  return balances.map((balance) => ({
    ...balance,
    averagePrice: snapshots.get(balance.tokenId)?.averagePrice ?? null,
  }));
}

async function fetchAutoHiddenPolymarketTokenIds(
  pool: Pool,
  inputs: { userId: string; walletAddresses: string[]; tokenIds: string[] },
): Promise<Set<string>> {
  const tokenIds = normalizeNumericTokenIds(inputs.tokenIds);
  const wallets = inputs.walletAddresses
    .filter(isEthAddress)
    .map((wallet) => wallet.toLowerCase());
  if (tokenIds.length === 0 || wallets.length === 0) return new Set();

  const { rows } = await pool.query<{ token_id: string }>(
    `
      select token_id
      from positions
      where user_id = $1
        and lower(wallet_address) = any($2::text[])
        and venue = 'polymarket'
        and position_scope = 'own'
        and is_hidden = true
        and hidden_reason = 'auto_lost'
        and token_id = any($3::text[])
    `,
    [inputs.userId, wallets, tokenIds],
  );

  return new Set(rows.map((row) => row.token_id));
}

async function filterAutoHiddenPolymarketTokenIds(
  pool: Pool,
  inputs: { userId: string; walletAddresses: string[]; tokenIds: string[] },
): Promise<string[]> {
  const tokenIds = normalizeNumericTokenIds(inputs.tokenIds);
  if (tokenIds.length === 0) return [];
  const hidden = await fetchAutoHiddenPolymarketTokenIds(pool, {
    userId: inputs.userId,
    walletAddresses: inputs.walletAddresses,
    tokenIds,
  });
  if (hidden.size === 0) return tokenIds;
  return tokenIds.filter((tokenId) => !hidden.has(tokenId));
}

export type PrefetchedPolymarketOwnerBalances = {
  owners: string[];
  funderAddress: string | null;
  candidateTokenIds: string[];
  trackedTokenIds: string[];
  unionTokenIds: string[];
  rpcCallEstimate: number;
  rpcCallCount: number;
  balancesByOwner: Map<string, WalletTokenBalance[]>;
  sourceCounts?: {
    dbCandidateTokenCount: number;
    dataApiTokenCount: number;
    hiddenCandidateTokenCount: number;
  };
  timings?: {
    expandMs: number;
    dbCandidateMs: number;
    dataApiMs: number;
    hiddenFilterMs: number;
    rpcMs: number;
    totalMs: number;
  };
};

type PrefetchRpcTelemetryMetadata = {
  walletIntelRpcCallCount?: number;
  walletIntelRpcCallEstimate?: number;
};

function attachPrefetchRpcTelemetry(
  error: unknown,
  metadata: PrefetchRpcTelemetryMetadata,
) {
  if (!error || typeof error !== "object") return error;
  const target = error as PrefetchRpcTelemetryMetadata;
  target.walletIntelRpcCallCount = metadata.walletIntelRpcCallCount ?? 0;
  target.walletIntelRpcCallEstimate = metadata.walletIntelRpcCallEstimate ?? 0;
  return error;
}

export function readPrefetchRpcTelemetry(error: unknown): {
  actualCalls: number;
  estimatedCalls: number;
} {
  if (!error || typeof error !== "object") {
    return { actualCalls: 0, estimatedCalls: 0 };
  }
  const target = error as PrefetchRpcTelemetryMetadata;
  const actualCalls = Number.isFinite(target.walletIntelRpcCallCount)
    ? Math.max(0, Math.trunc(target.walletIntelRpcCallCount ?? 0))
    : 0;
  const estimatedCalls = Number.isFinite(target.walletIntelRpcCallEstimate)
    ? Math.max(0, Math.trunc(target.walletIntelRpcCallEstimate ?? 0))
    : 0;
  return { actualCalls, estimatedCalls };
}

export function filterPrefetchedPolymarketOwnerBalances(inputs: {
  prefetched: PrefetchedPolymarketOwnerBalances;
  owners: string[];
  tokenIds: string[];
}): Array<{ owner: string; held: WalletTokenBalance[] }> {
  const tokenIdSet = new Set(normalizeNumericTokenIds(inputs.tokenIds));
  return inputs.owners.map((owner) => ({
    owner,
    held: (
      inputs.prefetched.balancesByOwner.get(owner.toLowerCase()) ?? []
    ).filter((balance) => tokenIdSet.has(balance.tokenId)),
  }));
}

export async function prefetchFollowedPolymarketOwnerBalances(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    trackedTokenIds: string[];
  },
): Promise<PrefetchedPolymarketOwnerBalances> {
  let rpcCallCount = 0;
  let rpcCallEstimate = 0;

  try {
    const funderAddress =
      (await fetchPolymarketFunderAddress(pool, {
        userId: inputs.userId,
        walletAddress: inputs.walletAddress,
      })) ?? null;

    const owners = resolvePolymarketOwnerAddresses(
      inputs.walletAddress,
      funderAddress,
    );

    const candidateTokenIds = await fetchPolymarketCandidateTokenIds(pool, {
      userId: inputs.userId,
      walletAddresses: owners,
      limit: 1000,
    });
    const trackedTokenIds = normalizeNumericTokenIds(inputs.trackedTokenIds);
    const unionTokenIds = resolvePolymarketTrackedTokenUniverse(
      candidateTokenIds,
      trackedTokenIds,
    );
    rpcCallEstimate = estimateErc1155BalanceRpcCalls(
      owners.length,
      unionTokenIds,
    );

    const balancesByOwner = new Map<string, WalletTokenBalance[]>();
    if (unionTokenIds.length > 0) {
      const conditionalTokensAddress = env.polymarketConditionalTokensAddress;
      const ownerResults = await Promise.all(
        owners.map(async (owner) => ({
          owner,
          balances: await fetchErc1155OwnerTokenBalances({
            rpcUrl: env.polygonRpcUrl,
            timeoutMs: env.polygonRpcTimeoutMs,
            contractAddress: conditionalTokensAddress,
            owner,
            tokenIds: unionTokenIds,
            onRpcCall: () => {
              rpcCallCount += 1;
            },
          }),
        })),
      );

      for (const { owner, balances } of ownerResults) {
        balancesByOwner.set(owner.toLowerCase(), balances);
      }
    }

    return {
      owners,
      funderAddress,
      candidateTokenIds,
      trackedTokenIds,
      unionTokenIds,
      rpcCallEstimate,
      rpcCallCount,
      balancesByOwner,
    };
  } catch (error) {
    throw attachPrefetchRpcTelemetry(error, {
      walletIntelRpcCallCount: rpcCallCount,
      walletIntelRpcCallEstimate: rpcCallEstimate,
    });
  }
}

export async function prefetchPolymarketOwnerBalancesForWallets(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddresses: string[];
    trackedTokenIds?: string[];
  },
): Promise<PrefetchedPolymarketOwnerBalances> {
  const totalStartedAt = Date.now();
  let rpcCallCount = 0;
  let rpcCallEstimate = 0;

  try {
    const requestedWallets = Array.from(
      new Map(
        inputs.walletAddresses
          .filter(isEthAddress)
          .map((address) => [address.toLowerCase(), address]),
      ).values(),
    );

    const expandStartedAt = Date.now();
    const owners =
      requestedWallets.length > 0
        ? await expandPolymarketWallets(pool, {
            userId: inputs.userId,
            walletAddresses: requestedWallets,
          })
        : [];
    const expandMs = Date.now() - expandStartedAt;

    const dbCandidateStartedAt = Date.now();
    const dbCandidateTokenIds =
      owners.length > 0
        ? await fetchPolymarketCandidateTokenIds(pool, {
            userId: inputs.userId,
            walletAddresses: owners,
            limit: 1000,
            mode: "active",
          })
        : [];
    const dbCandidateMs = Date.now() - dbCandidateStartedAt;

    const dataApiStartedAt = Date.now();
    const dataApiSnapshotsByOwner =
      owners.length > 0
        ? await fetchPolymarketDataApiSnapshotsForOwners(owners)
        : new Map<string, Map<string, PolymarketDataApiPositionSnapshot>>();
    const dataApiMs = Date.now() - dataApiStartedAt;
    const dataApiTokenIds = flattenPolymarketDataApiTokenIds(
      dataApiSnapshotsByOwner,
    );
    const hiddenFilterStartedAt = Date.now();
    const candidateTokenIds = await filterAutoHiddenPolymarketTokenIds(pool, {
      userId: inputs.userId,
      walletAddresses: owners,
      tokenIds: [...dbCandidateTokenIds, ...dataApiTokenIds],
    });
    const hiddenFilterMs = Date.now() - hiddenFilterStartedAt;
    const sourceTokenIds = normalizeNumericTokenIds([
      ...dbCandidateTokenIds,
      ...dataApiTokenIds,
    ]);
    const trackedTokenIds = normalizeNumericTokenIds(
      inputs.trackedTokenIds ?? [],
    );
    const unionTokenIds = resolvePolymarketTrackedTokenUniverse(
      candidateTokenIds,
      trackedTokenIds,
    );
    rpcCallEstimate = estimateErc1155OwnerTokenPairRpcCalls(
      owners.length,
      unionTokenIds,
    );

    const balancesByOwner = new Map<string, WalletTokenBalance[]>();
    const rpcStartedAt = Date.now();
    if (unionTokenIds.length > 0 && owners.length > 0) {
      const ownerBalances = await fetchErc1155OwnerTokenBalancesForOwners({
        rpcUrl: env.polygonRpcUrl,
        timeoutMs: env.polygonRpcTimeoutMs,
        contractAddress: env.polymarketConditionalTokensAddress,
        owners,
        tokenIds: unionTokenIds,
        maxPairsPerCall: POLYMARKET_BALANCE_BATCH_MAX_PAIRS,
        onRpcCall: () => {
          rpcCallCount += 1;
        },
      });

      for (const owner of owners) {
        balancesByOwner.set(
          owner.toLowerCase(),
          applyPolymarketDataApiAveragePrices(
            ownerBalances.get(owner.toLowerCase()) ?? [],
            owner,
            dataApiSnapshotsByOwner,
          ),
        );
      }
    }
    const rpcMs = Date.now() - rpcStartedAt;

    return {
      owners,
      funderAddress: null,
      candidateTokenIds,
      trackedTokenIds,
      unionTokenIds,
      rpcCallEstimate,
      rpcCallCount,
      balancesByOwner,
      sourceCounts: {
        dbCandidateTokenCount: dbCandidateTokenIds.length,
        dataApiTokenCount: dataApiTokenIds.length,
        hiddenCandidateTokenCount:
          sourceTokenIds.length - candidateTokenIds.length,
      },
      timings: {
        expandMs,
        dbCandidateMs,
        dataApiMs,
        hiddenFilterMs,
        rpcMs,
        totalMs: Date.now() - totalStartedAt,
      },
    };
  } catch (error) {
    throw attachPrefetchRpcTelemetry(error, {
      walletIntelRpcCallCount: rpcCallCount,
      walletIntelRpcCallEstimate: rpcCallEstimate,
    });
  }
}

function addTokenBalance(
  output: WalletTokenBalance[],
  seen: Set<string>,
  tokenId: string,
  size: string,
) {
  if (!tokenId || !size) return;
  const normalized = normalizeLimitlessScopedTokenId(tokenId);
  if (!normalized) return;
  if (seen.has(normalized)) return;
  const numeric = Number(size);
  if (!Number.isFinite(numeric) || numeric <= 0) return;
  seen.add(normalized);
  output.push({ tokenId: normalized, size });
}

function extractTokenBalancesFromMap(
  output: WalletTokenBalance[],
  seen: Set<string>,
  tokenBalances: Record<string, unknown>,
  yesToken: string | null,
  noToken: string | null,
) {
  const yesValue = normalizeLimitlessSnapshotBalance(tokenBalances.yes);
  const noValue = normalizeLimitlessSnapshotBalance(tokenBalances.no);
  if (yesValue && yesToken) {
    addTokenBalance(output, seen, yesToken, yesValue);
  }
  if (noValue && noToken) {
    addTokenBalance(output, seen, noToken, noValue);
  }

  for (const [key, value] of Object.entries(tokenBalances)) {
    if (key === "yes" || key === "no") continue;
    const size = normalizeLimitlessSnapshotBalance(value);
    if (!size) continue;
    addTokenBalance(output, seen, key, size);
  }
}

function extractTokenBalancesFromArray(
  output: WalletTokenBalance[],
  seen: Set<string>,
  tokenBalances: unknown[],
) {
  for (const entry of tokenBalances) {
    if (!isRecord(entry)) continue;
    const tokenId =
      typeof entry.tokenId === "string"
        ? entry.tokenId
        : typeof entry.token_id === "string"
          ? entry.token_id
          : typeof entry.positionId === "string"
            ? entry.positionId
            : typeof entry.id === "string"
              ? entry.id
              : null;
    const size = normalizeLimitlessSnapshotBalance(
      entry.balance ?? entry.amount ?? entry.size ?? entry.value,
    );
    if (!tokenId || !size) continue;
    addTokenBalance(output, seen, tokenId, size);
  }
}

function extractLimitlessClobEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

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

  const output: unknown[] = [];

  for (const root of roots) {
    if (Array.isArray(root)) {
      output.push(...root);
      continue;
    }
    if (!isRecord(root)) continue;
    for (const key of keys) {
      const value = root[key];
      if (Array.isArray(value)) {
        output.push(...value);
      }
    }
  }

  return output;
}

export function extractLimitlessTokenBalances(
  payload: unknown,
): WalletTokenBalance[] {
  const clob = extractLimitlessClobEntries(payload).filter(isRecord);
  if (!clob.length) return [];

  const output: WalletTokenBalance[] = [];
  const seen = new Set<string>();

  for (const entry of clob) {
    const market = isRecord(entry.market) ? entry.market : null;
    const positionIdsRaw =
      (market && (market.position_ids ?? market.positionIds)) ?? null;
    const positionIds = extractPositionIds(positionIdsRaw);
    const yesToken = resolveLimitlessMarketTokenId(
      market,
      "yes",
      positionIds[0] ?? null,
    );
    const noToken = resolveLimitlessMarketTokenId(
      market,
      "no",
      positionIds[1] ?? null,
    );

    const tokenBalances =
      entry.tokensBalance ??
      entry.tokens_balance ??
      entry.tokenBalances ??
      entry.token_balances ??
      entry.tokens ??
      null;
    if (Array.isArray(tokenBalances)) {
      extractTokenBalancesFromArray(output, seen, tokenBalances);
      continue;
    }
    if (isRecord(tokenBalances)) {
      extractTokenBalancesFromMap(
        output,
        seen,
        tokenBalances,
        yesToken,
        noToken,
      );
      continue;
    }

    const outcomeIndex =
      typeof entry.outcomeIndex === "number"
        ? entry.outcomeIndex
        : typeof entry.outcome_index === "number"
          ? entry.outcome_index
          : null;
    const outcomeToken =
      outcomeIndex === 0 ? yesToken : outcomeIndex === 1 ? noToken : null;
    const outcomeTokenAmount = normalizeLimitlessSnapshotBalance(
      entry.outcomeTokenAmount ?? entry.outcome_token_amount,
    );
    if (outcomeToken && outcomeTokenAmount) {
      addTokenBalance(output, seen, outcomeToken, outcomeTokenAmount);
    }
  }

  return output;
}

export function isLimitlessPublicPortfolioUserNotFound(
  payload: unknown,
): boolean {
  const message = extractLimitlessMessage(payload);
  return message?.toLowerCase() === "user not found";
}

async function backfillPolymarketUnifiedTokens(
  pool: Pool,
  tokenIds: string[],
): Promise<void> {
  if (tokenIds.length === 0) return;

  await pool.query(
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
    [tokenIds],
  );
}

async function backfillKalshiUnifiedTokens(
  pool: Pool,
  tokenIds: string[],
): Promise<void> {
  if (tokenIds.length === 0) return;

  await pool.query(
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
    [tokenIds],
  );
}

async function fetchPolymarketCandidateTokenIds(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddresses: string[];
    limit: number;
    mode?: "broad" | "active";
  },
): Promise<string[]> {
  if (inputs.walletAddresses.length === 0) return [];
  const normalizedWallets = inputs.walletAddresses.map((address) =>
    address.toLowerCase(),
  );
  if (inputs.mode === "active") {
    const { rows } = await pool.query<{ token_id: string }>(
      `
        with recent_order_tokens as (
          select token_id
          from orders
          where user_id = $1
            and (
              wallet_address is null
              or lower(wallet_address) = any($2::text[])
              or lower(signer_address) = any($2::text[])
            )
            and venue = 'polymarket'
            and token_id is not null
            and coalesce(filled_at, last_update, posted_at) >=
              now() - ($4::int * interval '1 hour')
        ),
        active_position_tokens as (
          select token_id
          from positions
          where user_id = $1
            and lower(wallet_address) = any($2::text[])
            and venue = 'polymarket'
            and position_scope = 'own'
            and side <> 'FLAT'
            and size > 0
            and not (is_hidden = true and hidden_reason = 'auto_lost')
        )
        select distinct token_id
        from (
          select token_id from recent_order_tokens
          union all
          select token_id from active_position_tokens
        ) t
        where token_id is not null
          and token_id <> ''
          and token_id ~ '^[0-9]+$'
        limit $3
      `,
      [
        inputs.userId,
        normalizedWallets,
        inputs.limit,
        POLYMARKET_RECENT_ORDER_CANDIDATE_HOURS,
      ],
    );

    return rows
      .map((row) => row.token_id)
      .filter((tokenId): tokenId is string => Boolean(tokenId));
  }

  const { rows } = await pool.query<{ token_id: string }>(
    `
      with watchlist_tokens as (
        select m.clob_token_ids::jsonb->>0 as token_id
        from user_watchlist w
        join unified_markets m
          on m.id = w.market_id
        where w.user_id = $1
          and m.venue = 'polymarket'
          and m.clob_token_ids is not null
          and m.clob_token_ids <> ''
          and m.clob_token_ids <> '[]'
        union all
        select m.clob_token_ids::jsonb->>1 as token_id
        from user_watchlist w
        join unified_markets m
          on m.id = w.market_id
        where w.user_id = $1
          and m.venue = 'polymarket'
          and m.clob_token_ids is not null
          and m.clob_token_ids <> ''
          and m.clob_token_ids <> '[]'
      ),
      order_tokens as (
        select token_id
        from orders
        where user_id = $1
          and (
            wallet_address is null
            or lower(wallet_address) = any($2::text[])
            or lower(signer_address) = any($2::text[])
          )
          and venue = 'polymarket'
          and token_id is not null
      ),
      position_tokens as (
        select token_id
        from positions
        where user_id = $1
          and lower(wallet_address) = any($2::text[])
          and venue = 'polymarket'
      )
      select distinct token_id
      from (
        select token_id from watchlist_tokens
        union all
        select token_id from order_tokens
        union all
        select token_id from position_tokens
      ) t
      where token_id is not null
        and token_id <> ''
        and token_id ~ '^[0-9]+$'
      limit $3
    `,
    [inputs.userId, normalizedWallets, inputs.limit],
  );

  return rows
    .map((row) => row.token_id)
    .filter((tokenId): tokenId is string => Boolean(tokenId));
}

async function fetchLimitlessCandidateTokenIds(
  pool: Pool,
  inputs: { userId: string; walletAddresses: string[]; limit: number },
): Promise<string[]> {
  if (inputs.walletAddresses.length === 0) return [];
  const normalizedWallets = inputs.walletAddresses.map((address) =>
    address.toLowerCase(),
  );
  const { rows } = await pool.query<{ token_id: string }>(
    `
      with watchlist_tokens as (
        select m.token_yes as token_id
        from user_watchlist w
        join unified_markets m
          on m.id = w.market_id
        where w.user_id = $1
          and m.venue = 'limitless'
          and m.token_yes is not null
          and m.token_yes <> ''
        union all
        select m.token_no as token_id
        from user_watchlist w
        join unified_markets m
          on m.id = w.market_id
        where w.user_id = $1
          and m.venue = 'limitless'
          and m.token_no is not null
          and m.token_no <> ''
      ),
      order_tokens as (
        select token_id
        from orders
        where user_id = $1
          and (wallet_address is null or lower(wallet_address) = any($2::text[]))
          and venue = 'limitless'
          and token_id is not null
      ),
      position_tokens as (
        select token_id
        from positions
        where user_id = $1
          and lower(wallet_address) = any($2::text[])
          and venue = 'limitless'
      )
      select distinct regexp_replace(token_id, '^limitless:', '') as token_id
      from (
        select token_id from watchlist_tokens
        union all
        select token_id from order_tokens
        union all
        select token_id from position_tokens
      ) t
      where token_id is not null
        and token_id <> ''
        and regexp_replace(token_id, '^limitless:', '') ~ '^[0-9]+$'
      limit $3
    `,
    [inputs.userId, normalizedWallets, inputs.limit],
  );

  return rows
    .map((row) => row.token_id)
    .filter((tokenId): tokenId is string => Boolean(tokenId));
}

async function fetchLimitlessOnchainTokenBalances(
  pool: Pool,
  inputs: { userId: string; walletAddress: string; limit?: number },
): Promise<WalletTokenBalance[]> {
  const tokenIds = await fetchLimitlessCandidateTokenIds(pool, {
    userId: inputs.userId,
    walletAddresses: [inputs.walletAddress],
    limit: inputs.limit ?? 1000,
  });

  if (tokenIds.length === 0) return [];

  const balances = await fetchErc1155OwnerTokenBalances({
    rpcUrl: env.baseRpcUrl,
    timeoutMs: env.baseRpcTimeoutMs,
    contractAddress: env.limitlessConditionalTokensAddress,
    owner: inputs.walletAddress,
    tokenIds,
  });

  return balances
    .map((balance) => {
      const scopedTokenId = normalizeLimitlessScopedTokenId(balance.tokenId);
      if (!scopedTokenId) return null;
      return {
        tokenId: scopedTokenId,
        size: balance.size,
      };
    })
    .filter((balance): balance is WalletTokenBalance => balance != null);
}

async function fetchPolymarketFunderAddress(
  pool: Pool,
  inputs: { userId: string; walletAddress: string },
): Promise<string | null> {
  const signerAddress = inputs.walletAddress.toLowerCase();
  const { rows } = await pool.query<{ funder_address: string | null }>(
    `
      select funder_address
      from user_venue_credentials
      where user_id = $1
        and lower(wallet_address) = $2
        and venue = 'polymarket'
        and is_active = true
      limit 1
    `,
    [inputs.userId, signerAddress],
  );
  const funder = rows[0]?.funder_address ?? null;
  if (!funder) return null;
  if (!isEthAddress(funder)) return null;
  return funder;
}

type PolymarketTradeSyncOptions = {
  syncPositionsOnFill?: boolean;
  positionScope?: PositionScope;
  prefetchedBalances?: PrefetchedPolymarketOwnerBalances | null;
  afterSecOverride?: number | null;
};

type PolymarketTradeSyncResult = {
  insertedFillCount: number;
  persistedFillCount: number;
  positionsRecomputed: boolean;
};

function normalizePolymarketTradeAfterSecOverride(
  value: number | null | undefined,
): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

async function syncPolymarketStoredPositionsFromPolygon(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    positionScope: PositionScope;
    prefetchedBalances?: PrefetchedPolymarketOwnerBalances | null;
  },
): Promise<PositionsSyncResult> {
  const totalStartedAt = Date.now();
  const prefetched = inputs.prefetchedBalances ?? null;
  const expandStartedAt = Date.now();
  const ownerCandidates = await expandPolymarketWallets(pool, {
    userId: inputs.userId,
    walletAddresses: [inputs.walletAddress],
  });
  const expandMs = Date.now() - expandStartedAt;
  const owners =
    prefetched != null
      ? (() => {
          const prefetchedOwnerKeys = new Set(
            prefetched.owners.map((owner) => owner.toLowerCase()),
          );
          const filtered = ownerCandidates.filter((owner) =>
            prefetchedOwnerKeys.has(owner.toLowerCase()),
          );
          return filtered.length > 0 ? filtered : ownerCandidates;
        })()
      : ownerCandidates;
  const dataApiStartedAt = Date.now();
  const dataApiSnapshotsByOwner =
    prefetched == null
      ? await fetchPolymarketDataApiSnapshotsForOwners(owners)
      : null;
  const dataApiMs = Date.now() - dataApiStartedAt;
  const candidateStartedAt = Date.now();
  const tokenIds =
    prefetched?.candidateTokenIds ??
    (await filterAutoHiddenPolymarketTokenIds(pool, {
      userId: inputs.userId,
      walletAddresses: owners,
      tokenIds: [
        ...(await fetchPolymarketCandidateTokenIds(pool, {
          userId: inputs.userId,
          walletAddresses: owners,
          limit: 1000,
          mode: "active",
        })),
        ...flattenPolymarketDataApiTokenIds(
          dataApiSnapshotsByOwner ?? new Map(),
        ),
      ],
    }));
  const candidateMs = Date.now() - candidateStartedAt;

  if (tokenIds.length === 0) {
    return {
      venue: "polymarket",
      walletAddress: inputs.walletAddress,
      heldTokens: 0,
      knownTokens: 0,
      upsertedPositions: 0,
      flattenedPositions: 0,
      timings: {
        expandMs,
        dataApiMs,
        candidateMs,
        totalMs: Date.now() - totalStartedAt,
      },
    };
  }

  const heldByOwner = new Map<
    string,
    Array<{ tokenId: string; size: string }>
  >();
  const allHeldTokens = new Set<string>();

  const balanceStartedAt = Date.now();
  const ownerHeldResults =
    prefetched != null
      ? filterPrefetchedPolymarketOwnerBalances({
          prefetched,
          owners,
          tokenIds,
        })
      : await (async () => {
          const balancesByOwner = await fetchErc1155OwnerTokenBalancesForOwners(
            {
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              contractAddress: env.polymarketConditionalTokensAddress,
              owners,
              tokenIds,
              maxPairsPerCall: POLYMARKET_BALANCE_BATCH_MAX_PAIRS,
            },
          );
          return owners.map((owner) => ({
            owner,
            held: applyPolymarketDataApiAveragePrices(
              balancesByOwner.get(owner.toLowerCase()) ?? [],
              owner,
              dataApiSnapshotsByOwner,
            ),
          }));
        })();
  const balanceMs = Date.now() - balanceStartedAt;

  for (const { owner, held } of ownerHeldResults) {
    for (const item of held) {
      allHeldTokens.add(item.tokenId);
    }
    heldByOwner.set(owner, held);
  }

  let backfillMs = 0;
  if (allHeldTokens.size > 0) {
    const backfillStartedAt = Date.now();
    await backfillPolymarketUnifiedTokens(pool, Array.from(allHeldTokens));
    backfillMs = Date.now() - backfillStartedAt;
  }

  let heldTokens = 0;
  let knownTokens = 0;
  let upsertedPositions = 0;
  let flattenedPositions = 0;
  let persistMs = 0;
  let postSyncMs = 0;

  for (const owner of owners) {
    const held = heldByOwner.get(owner) ?? [];
    const persistStartedAt = Date.now();
    const result = await syncWalletPositionsFromTokenBalances(pool, {
      userId: inputs.userId,
      walletAddress: owner,
      venue: "polymarket",
      positionScope: inputs.positionScope,
      tokenBalances: held,
      // Short grace avoids flattening fresh matched BUYs before Polygon state
      // catches up, while still converging quickly.
      flattenGraceSec: env.positionsSyncFlattenGraceSec,
      // Prevent immediate stale RPC snapshots from reopening freshly flattened
      // rows right after matched sells.
      protectRecentFlatsSec: env.positionsSyncFlattenGraceSec,
    });
    persistMs += Date.now() - persistStartedAt;
    heldTokens += result.heldTokens;
    knownTokens += result.knownTokens;
    upsertedPositions += result.upsertedPositions;
    flattenedPositions += result.flattenedPositions;

    if (inputs.positionScope === "own") {
      const postSyncStartedAt = Date.now();
      const [pmMetrics, pmNotifications] = await Promise.allSettled([
        recomputePositionMetricsForWallet(pool, {
          userId: inputs.userId,
          walletAddress: owner,
          venue: "polymarket",
        }),
        notifyResolvedPositions(pool, {
          userId: inputs.userId,
          walletAddress: owner,
          venue: "polymarket",
        }),
      ]);
      if (pmMetrics.status === "rejected") {
        console.error(
          "Polymarket position metrics update failed",
          pmMetrics.reason,
        );
      }
      if (pmNotifications.status === "rejected") {
        console.error(
          "Polymarket resolved position notification failed",
          pmNotifications.reason,
        );
      }
      postSyncMs += Date.now() - postSyncStartedAt;
    }
  }

  requestPositionMarketRefresh({
    venue: "polymarket",
    tokenIds: [...tokenIds, ...allHeldTokens],
  });

  return {
    venue: "polymarket",
    walletAddress: inputs.walletAddress,
    heldTokens,
    knownTokens,
    upsertedPositions,
    flattenedPositions,
    timings: {
      expandMs,
      dataApiMs,
      candidateMs,
      balanceMs,
      backfillMs,
      persistMs,
      postSyncMs,
      totalMs: Date.now() - totalStartedAt,
    },
  };
}

export async function syncPolymarketTradesForSigner(
  pool: Pool,
  inputs: { userId: string; signerAddress: string },
  options: PolymarketTradeSyncOptions = {},
): Promise<PolymarketTradeSyncResult> {
  const creds = await AuthService.getVenueCredentials(
    inputs.userId,
    "polymarket",
    inputs.signerAddress,
  );
  if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    return {
      insertedFillCount: 0,
      persistedFillCount: 0,
      positionsRecomputed: false,
    };
  }

  const { rows } = await pool.query<{ last_filled_at: Date | null }>(
    `
      select max(of.filled_at) as last_filled_at
      from order_fills of
      join orders o on o.id = of.order_id
      where o.user_id = $1
        and o.venue = 'polymarket'
        and (lower(o.signer_address) = lower($2) or lower(o.wallet_address) = lower($2))
    `,
    [inputs.userId, inputs.signerAddress],
  );
  const lastFilledAt = rows[0]?.last_filled_at ?? null;
  const afterSecOverride = normalizePolymarketTradeAfterSecOverride(
    options.afterSecOverride,
  );
  const afterSec =
    afterSecOverride ??
    (lastFilledAt != null
      ? Math.max(0, Math.floor(lastFilledAt.getTime() / 1000) - 1)
      : null);

  const tradesResponse = await fetchPolymarketTrades({
    baseUrl: env.polymarketClobBase,
    timeoutMs: 10_000,
    address: inputs.signerAddress,
    creds: {
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      apiPassphrase: creds.apiPassphrase,
    },
    query: afterSec != null ? { after: afterSec } : undefined,
  });

  if (!tradesResponse.ok) {
    console.error("Polymarket trades sync failed", tradesResponse.payload);
    return {
      insertedFillCount: 0,
      persistedFillCount: 0,
      positionsRecomputed: false,
    };
  }

  const trades = tradesResponse.trades;
  if (!trades.length) {
    return {
      insertedFillCount: 0,
      persistedFillCount: 0,
      positionsRecomputed: false,
    };
  }

  const orderIds = new Set<string>();
  for (const trade of trades) {
    if (trade.takerOrderId) orderIds.add(trade.takerOrderId);
    for (const maker of trade.makerOrders ?? []) {
      if (maker.orderId) orderIds.add(maker.orderId);
    }
  }

  if (!orderIds.size) {
    return {
      insertedFillCount: 0,
      persistedFillCount: 0,
      positionsRecomputed: false,
    };
  }

  type LocalPolymarketOrderRow = {
    id: string;
    venue_order_id: string;
    wallet_address: string | null;
    signer_address: string | null;
    token_id: string | null;
    side: string | null;
    order_hash: string | null;
    order_payload: Record<string, unknown> | null;
    fee_policy_snapshot: Record<string, unknown> | null;
  };

  const { rows: orderRows } = await pool.query<LocalPolymarketOrderRow>(
    `
      select
        id,
        venue_order_id,
        wallet_address,
        signer_address,
        token_id,
        side,
        order_hash,
        case when jsonb_typeof(order_payload) = 'object' then order_payload else null end as order_payload,
        case when jsonb_typeof(fee_policy_snapshot) = 'object' then fee_policy_snapshot else null end as fee_policy_snapshot
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = any($2::text[])
    `,
    [inputs.userId, Array.from(orderIds)],
  );

  if (!orderRows.length) {
    return {
      insertedFillCount: 0,
      persistedFillCount: 0,
      positionsRecomputed: false,
    };
  }

  const orderMap = new Map<string, LocalPolymarketOrderRow>();
  for (const row of orderRows) {
    if (row.venue_order_id) {
      orderMap.set(row.venue_order_id, row);
    }
  }

  const fillKeySet = new Set<string>();
  const fillOrderIds: string[] = [];
  const fillVenueIds: string[] = [];
  const fillSizes: number[] = [];
  const fillPrices: number[] = [];
  const fillSides: string[] = [];
  const fillTimes: Date[] = [];
  const fillTradeIds: string[] = [];
  const fillFees: number[] = [];
  const builderFeeConfig = await resolvePolymarketBuilderFeeConfig(pool);
  const builderFeeAccruals: Array<
    ReturnType<typeof buildPolymarketBuilderFeeAccrual>
  > = [];
  const builderFeeAccrualKeySet = new Set<string>();

  const maybeQueueBuilderAccrual = (params: {
    order: LocalPolymarketOrderRow;
    venueFillId: string;
    venueTradeId: string;
    txHash: string | null;
    side: "BUY" | "SELL";
    role: "maker" | "taker";
    size: string | number | null;
    price: string | number | null;
    filledAt: Date;
  }) => {
    const key = `${params.order.id}:${params.venueFillId}`;
    if (builderFeeAccrualKeySet.has(key)) return;
    builderFeeAccrualKeySet.add(key);
    const payload = params.order.order_payload;
    if (!payload || !isRecord(payload)) return;
    const builder =
      typeof payload.builder === "string" ? payload.builder : null;
    const accrual = buildPolymarketBuilderFeeAccrual(
      {
        userId: inputs.userId,
        walletAddress: params.order.wallet_address,
        signerAddress: params.order.signer_address,
        orderId: params.order.id,
        orderHash: params.order.order_hash ?? "",
        venueOrderId: params.order.venue_order_id,
        venueFillId: params.venueFillId,
        venueTradeId: params.venueTradeId,
        txHash: params.txHash,
        tokenId: params.order.token_id,
        side: params.side,
        role: params.role,
        size: params.size,
        price: params.price,
        filledAt: params.filledAt,
        orderBuilderCode: builder,
        feePolicySnapshot: params.order.fee_policy_snapshot,
      },
      builderFeeConfig,
    );
    if (accrual) builderFeeAccruals.push(accrual);
  };

  for (const trade of trades) {
    const tradeId = trade.id;
    const matchTime =
      parseNumber(trade.matchTime) ?? parseNumber(trade.lastUpdate);
    if (!tradeId || matchTime == null) continue;
    const filledAt = new Date(matchTime * 1000);

    const takerOrderId = trade.takerOrderId;
    if (takerOrderId && orderMap.has(takerOrderId)) {
      const side = normalizeFillSide(trade.side);
      const size = parseNumber(trade.size);
      const price = parseNumber(trade.price);
      if (side && size != null && size > 0 && price != null && price > 0) {
        const localOrder = orderMap.get(takerOrderId);
        if (!localOrder) continue;
        const internalOrderId = localOrder.id;
        const venueFillId = `${tradeId}:taker`;
        const key = `${internalOrderId}:${venueFillId}`;
        if (!fillKeySet.has(key)) {
          fillKeySet.add(key);
          fillOrderIds.push(internalOrderId);
          fillVenueIds.push(venueFillId);
          fillSizes.push(size);
          fillPrices.push(price);
          fillSides.push(side);
          fillTimes.push(filledAt);
          fillTradeIds.push(tradeId);
          fillFees.push(0);
        }
        maybeQueueBuilderAccrual({
          order: localOrder,
          venueFillId,
          venueTradeId: tradeId,
          txHash: trade.transactionHash,
          side,
          role: "taker",
          size: trade.size,
          price: trade.price,
          filledAt,
        });
      }
    }

    for (const maker of trade.makerOrders ?? []) {
      if (!maker.orderId || !orderMap.has(maker.orderId)) continue;
      const side = normalizeFillSide(maker.side);
      const size = parseNumber(maker.matchedAmount);
      const price = parseNumber(maker.price);
      if (side && size != null && size > 0 && price != null && price > 0) {
        const localOrder = orderMap.get(maker.orderId);
        if (!localOrder) continue;
        const internalOrderId = localOrder.id;
        const venueFillId = `${tradeId}:${maker.orderId}`;
        const key = `${internalOrderId}:${venueFillId}`;
        if (!fillKeySet.has(key)) {
          fillKeySet.add(key);
          fillOrderIds.push(internalOrderId);
          fillVenueIds.push(venueFillId);
          fillSizes.push(size);
          fillPrices.push(price);
          fillSides.push(side);
          fillTimes.push(filledAt);
          fillTradeIds.push(tradeId);
          fillFees.push(0);
        }
        maybeQueueBuilderAccrual({
          order: localOrder,
          venueFillId,
          venueTradeId: tradeId,
          txHash: trade.transactionHash,
          side,
          role: "maker",
          size: maker.matchedAmount,
          price: maker.price,
          filledAt,
        });
      }
    }
  }

  if (!fillOrderIds.length) {
    return {
      insertedFillCount: 0,
      persistedFillCount: 0,
      positionsRecomputed: false,
    };
  }

  const fillSync = await tx(pool, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [
        `polymarket-trades:${inputs.userId}:${inputs.signerAddress.toLowerCase()}`,
      ],
    );

    const { rows } = await client.query<{
      order_id: string;
      venue_fill_id: string;
      fill_size: number;
      fill_price: number;
      fill_side: string;
      filled_at: Date;
    }>(
      `
        with input as (
          select *
          from unnest(
            $1::uuid[],
            $2::text[],
            $3::numeric[],
            $4::numeric[],
            $5::text[],
            $6::timestamptz[],
            $7::text[],
            $8::numeric[]
          ) as t(order_id, venue_fill_id, fill_size, fill_price, fill_side, filled_at, venue_trade_id, fees)
        )
        insert into order_fills (
          order_id, venue_fill_id, fill_size, fill_price, fill_side, filled_at, venue_trade_id, fees
        )
        select
          t.order_id, t.venue_fill_id, t.fill_size, t.fill_price, t.fill_side, t.filled_at, t.venue_trade_id, t.fees
        from input t
        where not exists (
          select 1
          from order_fills of
          where of.order_id = t.order_id
            and of.venue_fill_id = t.venue_fill_id
        )
        on conflict do nothing
        returning order_id, venue_fill_id, fill_size, fill_price, fill_side, filled_at
      `,
      [
        fillOrderIds,
        fillVenueIds,
        fillSizes,
        fillPrices,
        fillSides,
        fillTimes,
        fillTradeIds,
        fillFees,
      ],
    );

    const { rows: persistedCandidateFills } = await client.query<{
      order_id: string;
      venue_fill_id: string;
      fill_size: number;
      fill_price: number;
      fill_side: string;
      filled_at: Date;
    }>(
      `
        with input as (
          select distinct t.order_id, t.venue_fill_id
          from unnest($1::uuid[], $2::text[]) as t(order_id, venue_fill_id)
          where t.venue_fill_id is not null
        )
        select
          f.order_id,
          f.venue_fill_id,
          f.fill_size,
          f.fill_price,
          f.fill_side,
          f.filled_at
        from input t
        join order_fills f
          on f.order_id = t.order_id
         and f.venue_fill_id = t.venue_fill_id
      `,
      [fillOrderIds, fillVenueIds],
    );

    let persistedAggregateUpdateCount = 0;
    if (persistedCandidateFills.length) {
      const { rows: persistedAggregateUpdates } = await client.query<{
        id: string;
      }>(
        `
          with agg as (
            select order_id,
                   sum(fill_size) as filled_size,
                   case when sum(fill_size) > 0
                        then sum(fill_size * fill_price) / sum(fill_size)
                        else null end as average_fill_price,
                   max(filled_at) as filled_at
            from order_fills
            where order_id = any($1::uuid[])
            group by order_id
          ),
          next_values as (
            select o.id,
                   agg.filled_size,
                   agg.average_fill_price,
                   agg.filled_at,
                   case
                     when agg.filled_size > 0 and upper(coalesce(o.order_type, '')) = 'FOK'
                       then 'matched'
                     when agg.filled_size > 0 and o.size is not null and agg.filled_size >= o.size
                       then 'filled'
                     when agg.filled_size > 0 and o.cancelled_at is not null
                       then 'cancelled'
                     when agg.filled_size > 0 and lower(coalesce(o.status, '')) in ('cancelled', 'rejected', 'expired', 'unmatched')
                       then lower(o.status)
                     when agg.filled_size > 0 then 'partially_filled'
                     when o.status in ('cancelled', 'rejected', 'expired', 'unmatched') then o.status
                     when o.status = 'unconfirmed' then o.status
                     else o.status
                   end as next_status
            from orders o
            join agg on o.id = agg.order_id
          )
          update orders o
          set filled_size = next_values.filled_size,
              average_fill_price = next_values.average_fill_price,
              filled_at = next_values.filled_at,
              status = next_values.next_status,
              last_update = now()
          from next_values
          where o.id = next_values.id
            and (
              o.filled_size is distinct from next_values.filled_size
              or o.average_fill_price is distinct from next_values.average_fill_price
              or o.filled_at is distinct from next_values.filled_at
              or lower(coalesce(o.status, '')) is distinct from lower(coalesce(next_values.next_status, ''))
            )
          returning o.id
        `,
        [
          Array.from(
            new Set(persistedCandidateFills.map((row) => row.order_id)),
          ),
        ],
      );
      persistedAggregateUpdateCount = persistedAggregateUpdates.length;

      const persistedFillKeys = new Set(
        persistedCandidateFills.map(
          (row) => `${row.order_id}:${row.venue_fill_id}`,
        ),
      );
      const persistedBuilderFeeAccruals = builderFeeAccruals.filter(
        (accrual) =>
          accrual != null &&
          persistedFillKeys.has(`${accrual.orderId}:${accrual.venueFillId}`),
      );
      if (persistedBuilderFeeAccruals.length) {
        await upsertPolymarketBuilderFeeAccruals(
          client,
          persistedBuilderFeeAccruals,
        );
      }

      await insertVolumeEventsWithMultiplierInTx(client, {
        userId: inputs.userId,
        walletAddress: inputs.signerAddress,
        venue: "polymarket",
        sourceType: "order",
        events: persistedCandidateFills.map((fill) => ({
          sourceId: fill.venue_fill_id,
          notionalUsd: Number(fill.fill_size) * Number(fill.fill_price),
          createdAt: fill.filled_at,
        })),
      });
    }

    return {
      insertedFills: rows,
      persistedFillCount: persistedAggregateUpdateCount,
    };
  });
  const insertedFills = fillSync.insertedFills;

  let positionsRecomputed = false;
  if (insertedFills.length && options.syncPositionsOnFill !== false) {
    try {
      await syncPolymarketStoredPositionsFromPolygon(pool, {
        userId: inputs.userId,
        walletAddress: inputs.signerAddress,
        positionScope: options.positionScope ?? "own",
        prefetchedBalances: options.prefetchedBalances ?? null,
      });
      positionsRecomputed = true;
    } catch (error) {
      console.error(
        "Polymarket position recompute after trade sync failed",
        error,
      );
    }
  }

  if (insertedFills.length) {
    const orderIds = Array.from(
      new Set(insertedFills.map((row) => row.order_id)),
    );
    const { rows: orderRows } = await pool.query<{
      id: string;
      venue_order_id: string | null;
      token_id: string | null;
      side: string | null;
      wallet_address: string | null;
    }>(
      `
        select id, venue_order_id, token_id, side, wallet_address
        from orders
        where id = any($1::uuid[])
      `,
      [orderIds],
    );

    const fillStats = new Map<
      string,
      { size: number; notional: number; fillSide: string | null }
    >();
    for (const fill of insertedFills) {
      const nextSize = Number(fill.fill_size);
      const nextPrice = Number(fill.fill_price);
      if (!Number.isFinite(nextSize) || !Number.isFinite(nextPrice)) continue;
      const stats = fillStats.get(fill.order_id) ?? {
        size: 0,
        notional: 0,
        fillSide: fill.fill_side ?? null,
      };
      stats.size += nextSize;
      stats.notional += nextSize * nextPrice;
      stats.fillSide = stats.fillSide ?? fill.fill_side ?? null;
      fillStats.set(fill.order_id, stats);
    }

    for (const order of orderRows) {
      const stats = fillStats.get(order.id);
      if (!stats || stats.size <= 0) continue;
      const avgPrice = stats.notional > 0 ? stats.notional / stats.size : null;
      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: inputs.userId,
          venue: "polymarket",
          status: "matched",
          side: order.side ?? stats.fillSide,
          size: stats.size,
          price: avgPrice,
          orderId: order.venue_order_id ?? order.id,
          tokenId: order.token_id ?? null,
          walletAddress: order.wallet_address ?? inputs.signerAddress,
        }),
      );
    }
  }

  return {
    insertedFillCount: insertedFills.length,
    persistedFillCount: fillSync.persistedFillCount,
    positionsRecomputed,
  };
}

export type PositionsSyncResult = {
  venue: Position["venue"];
  walletAddress: string;
  heldTokens: number;
  knownTokens: number;
  upsertedPositions: number;
  flattenedPositions: number;
  timings?: Record<string, number>;
};

type PositionScope = "own" | "followed";

async function syncKalshiPositionsFromSolana(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    positionScope: PositionScope;
    prefetchedBalances?: SolanaTokenBalance[] | null;
  },
): Promise<PositionsSyncResult> {
  const totalStartedAt = Date.now();
  const balanceStartedAt = Date.now();
  const balances =
    inputs.prefetchedBalances ??
    (await fetchSolanaTokenBalancesByOwner({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      owner: inputs.walletAddress,
      includeToken2022: true,
    }));
  const balanceMs = Date.now() - balanceStartedAt;

  const tokenBalances = balances.map((balance) => ({
    tokenId: `sol:${balance.mint}`,
    size: balance.uiAmountString,
  }));

  let backfillMs = 0;
  if (tokenBalances.length > 0) {
    const backfillStartedAt = Date.now();
    await backfillKalshiUnifiedTokens(
      pool,
      tokenBalances.map((balance) => balance.tokenId),
    );
    backfillMs = Date.now() - backfillStartedAt;
  }

  const refreshCandidatesStartedAt = Date.now();
  const openPositionTokenIds = await fetchOpenPositionTokenIdsForRefresh(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "kalshi",
    positionScope: inputs.positionScope,
    tokenIdLike: "sol:%",
  });
  const refreshCandidatesMs = Date.now() - refreshCandidatesStartedAt;
  requestPositionMarketRefresh({
    venue: "kalshi",
    tokenIds: [
      ...tokenBalances.map((balance) => balance.tokenId),
      ...openPositionTokenIds,
    ],
  });

  const persistStartedAt = Date.now();
  const result = await syncWalletPositionsFromTokenBalances(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "kalshi",
    positionScope: inputs.positionScope,
    tokenBalances,
    tokenIdLike: "sol:%",
    flattenGraceSec: env.positionsSyncFlattenGraceSec,
    protectRecentFlatsSec: env.positionsSyncFlattenGraceSec,
  });
  const persistMs = Date.now() - persistStartedAt;

  let postSyncMs = 0;
  if (inputs.positionScope === "own") {
    const postSyncStartedAt = Date.now();
    const [kalshiMetrics, kalshiNotifications] = await Promise.allSettled([
      recomputePositionMetricsForWallet(pool, {
        userId: inputs.userId,
        walletAddress: inputs.walletAddress,
        venue: "kalshi",
      }),
      notifyResolvedPositions(pool, {
        userId: inputs.userId,
        walletAddress: inputs.walletAddress,
        venue: "kalshi",
      }),
    ]);
    if (kalshiMetrics.status === "rejected") {
      console.error(
        "Kalshi position metrics update failed",
        kalshiMetrics.reason,
      );
    }
    if (kalshiNotifications.status === "rejected") {
      console.error(
        "Kalshi resolved position notification failed",
        kalshiNotifications.reason,
      );
    }
    postSyncMs = Date.now() - postSyncStartedAt;
  }

  return {
    venue: "kalshi",
    walletAddress: inputs.walletAddress,
    heldTokens: result.heldTokens,
    knownTokens: result.knownTokens,
    upsertedPositions: result.upsertedPositions,
    flattenedPositions: result.flattenedPositions,
    timings: {
      balanceMs,
      backfillMs,
      refreshCandidatesMs,
      persistMs,
      postSyncMs,
      totalMs: Date.now() - totalStartedAt,
    },
  };
}

async function syncPolymarketPositionsFromPolygon(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    positionScope: PositionScope;
    prefetchedBalances?: PrefetchedPolymarketOwnerBalances | null;
  },
): Promise<PositionsSyncResult> {
  return syncPolymarketStoredPositionsFromPolygon(pool, inputs);
}

async function syncLimitlessPositionsFromPortfolio(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    positionScope: PositionScope;
  },
): Promise<PositionsSyncResult> {
  const totalStartedAt = Date.now();
  const authStartedAt = Date.now();
  const creds = await AuthService.getVenueCredentials(
    inputs.userId,
    "limitless",
    inputs.walletAddress,
  );
  const authContext = await resolveLimitlessAuthContext(
    inputs.userId,
    inputs.walletAddress,
  );
  const authMs = Date.now() - authStartedAt;
  if (!authContext || !creds) {
    throw new Error(
      "Connect Limitless for this wallet before syncing positions.",
    );
  }

  const positionsApiStartedAt = Date.now();
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: "/portfolio/positions",
    ...buildLimitlessRequestAuthInputs(authContext),
  });
  const positionsApiMs = Date.now() - positionsApiStartedAt;

  if (!upstream.ok) {
    const message = extractLimitlessMessage(upstream.payload);
    throw new Error(
      message
        ? `Limitless positions sync failed: ${message}`
        : "Limitless positions sync failed.",
    );
  }

  let historyMs = 0;
  const historyStartedAt = Date.now();
  try {
    await syncLimitlessHistoryForWallet(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      authContext,
      limit: 50,
    });
    historyMs = Date.now() - historyStartedAt;
  } catch (error) {
    historyMs = Date.now() - historyStartedAt;
    const message =
      error instanceof Error ? error.message : "Limitless history sync failed.";
    if (shouldLogLimitlessHistorySyncWarning(inputs.walletAddress, message)) {
      console.warn("Limitless history sync skipped", {
        walletAddress: inputs.walletAddress,
        message,
      });
    }
  }

  const snapshotTokenBalances = extractLimitlessTokenBalances(upstream.payload);
  let onchainTokenBalances: WalletTokenBalance[] = [];
  let onchainMs = 0;
  const onchainStartedAt = Date.now();
  try {
    onchainTokenBalances = await fetchLimitlessOnchainTokenBalances(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
    });
    onchainMs = Date.now() - onchainStartedAt;
  } catch (error) {
    onchainMs = Date.now() - onchainStartedAt;
    console.error("Limitless on-chain balance sync failed", error);
  }
  const tokenBalances = mergeWalletTokenBalances(
    snapshotTokenBalances,
    onchainTokenBalances,
  );

  const refreshCandidatesStartedAt = Date.now();
  const openPositionTokenIds = await fetchOpenPositionTokenIdsForRefresh(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "limitless",
    positionScope: inputs.positionScope,
    tokenIdLike: "limitless:%",
  });
  const refreshCandidatesMs = Date.now() - refreshCandidatesStartedAt;
  requestPositionMarketRefresh({
    venue: "limitless",
    tokenIds: [
      ...tokenBalances.map((balance) => balance.tokenId),
      ...openPositionTokenIds,
    ],
  });

  const persistStartedAt = Date.now();
  const result = await syncWalletPositionsFromTokenBalances(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "limitless",
    positionScope: inputs.positionScope,
    tokenBalances,
    tokenIdLike: "limitless:%",
    flattenGraceSec: env.limitlessPositionsSyncFlattenGraceSec,
    protectRecentFlatsSec: env.limitlessPositionsSyncFlattenGraceSec,
  });
  const persistMs = Date.now() - persistStartedAt;

  let postSyncMs = 0;
  if (inputs.positionScope === "own") {
    const postSyncStartedAt = Date.now();
    const [limitlessMetrics, limitlessNotifications] = await Promise.allSettled(
      [
        recomputePositionMetricsForWallet(pool, {
          userId: inputs.userId,
          walletAddress: inputs.walletAddress,
          venue: "limitless",
        }),
        notifyResolvedPositions(pool, {
          userId: inputs.userId,
          walletAddress: inputs.walletAddress,
          venue: "limitless",
        }),
      ],
    );
    if (limitlessMetrics.status === "rejected") {
      console.error(
        "Limitless position metrics update failed",
        limitlessMetrics.reason,
      );
    }
    if (limitlessNotifications.status === "rejected") {
      console.error(
        "Limitless resolved position notification failed",
        limitlessNotifications.reason,
      );
    }
    postSyncMs = Date.now() - postSyncStartedAt;
  }

  return {
    venue: "limitless",
    walletAddress: inputs.walletAddress,
    heldTokens: result.heldTokens,
    knownTokens: result.knownTokens,
    upsertedPositions: result.upsertedPositions,
    flattenedPositions: result.flattenedPositions,
    timings: {
      authMs,
      positionsApiMs,
      historyMs,
      onchainMs,
      refreshCandidatesMs,
      persistMs,
      postSyncMs,
      totalMs: Date.now() - totalStartedAt,
    },
  };
}

async function syncLimitlessFollowedPositionsFromPublicPortfolio(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    positionScope: PositionScope;
  },
): Promise<PositionsSyncResult> {
  const totalStartedAt = Date.now();
  const positionsApiStartedAt = Date.now();
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/portfolio/${encodeURIComponent(inputs.walletAddress)}/positions`,
    auth: "none",
  });
  const positionsApiMs = Date.now() - positionsApiStartedAt;

  if (!upstream.ok) {
    if (isLimitlessPublicPortfolioUserNotFound(upstream.payload)) {
      return {
        venue: "limitless",
        walletAddress: inputs.walletAddress,
        heldTokens: 0,
        knownTokens: 0,
        upsertedPositions: 0,
        flattenedPositions: 0,
        timings: {
          positionsApiMs,
          totalMs: Date.now() - totalStartedAt,
        },
      };
    }

    const message = extractLimitlessMessage(upstream.payload);
    throw new Error(
      message
        ? `Limitless followed positions sync failed: ${message}`
        : "Limitless followed positions sync failed.",
    );
  }

  const tokenBalances = extractLimitlessTokenBalances(upstream.payload);

  const refreshCandidatesStartedAt = Date.now();
  const openPositionTokenIds = await fetchOpenPositionTokenIdsForRefresh(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "limitless",
    positionScope: inputs.positionScope,
    tokenIdLike: "limitless:%",
  });
  const refreshCandidatesMs = Date.now() - refreshCandidatesStartedAt;
  requestPositionMarketRefresh({
    venue: "limitless",
    tokenIds: [
      ...tokenBalances.map((balance) => balance.tokenId),
      ...openPositionTokenIds,
    ],
  });

  const persistStartedAt = Date.now();
  const result = await syncWalletPositionsFromTokenBalances(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "limitless",
    positionScope: inputs.positionScope,
    tokenBalances,
    tokenIdLike: "limitless:%",
    flattenGraceSec: env.limitlessPositionsSyncFlattenGraceSec,
    protectRecentFlatsSec: env.limitlessPositionsSyncFlattenGraceSec,
  });
  const persistMs = Date.now() - persistStartedAt;

  return {
    venue: "limitless",
    walletAddress: inputs.walletAddress,
    heldTokens: result.heldTokens,
    knownTokens: result.knownTokens,
    upsertedPositions: result.upsertedPositions,
    flattenedPositions: result.flattenedPositions,
    timings: {
      positionsApiMs,
      refreshCandidatesMs,
      persistMs,
      totalMs: Date.now() - totalStartedAt,
    },
  };
}

export async function syncPositionsForUserWallet(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue?: Position["venue"];
    positionScope?: PositionScope;
    prefetchedSolanaBalances?: SolanaTokenBalance[] | null;
    prefetchedPolymarketBalances?: PrefetchedPolymarketOwnerBalances | null;
  },
): Promise<PositionsSyncResult> {
  const requestedVenue = inputs.venue;
  const positionScope: PositionScope = inputs.positionScope ?? "own";

  if (
    requestedVenue &&
    requestedVenue !== "kalshi" &&
    requestedVenue !== "polymarket" &&
    requestedVenue !== "limitless"
  ) {
    throw new Error(
      `Positions sync is not implemented yet for venue=${requestedVenue}`,
    );
  }

  if (isEthAddress(inputs.walletAddress)) {
    if (requestedVenue === "kalshi") {
      throw new Error(
        "Selected wallet looks like an EVM address; select a Solana wallet to sync Kalshi positions.",
      );
    }
    if (requestedVenue === "limitless") {
      if (positionScope === "followed") {
        return syncLimitlessFollowedPositionsFromPublicPortfolio(pool, {
          userId: inputs.userId,
          walletAddress: inputs.walletAddress,
          positionScope,
        });
      }
      return syncLimitlessPositionsFromPortfolio(pool, {
        userId: inputs.userId,
        walletAddress: inputs.walletAddress,
        positionScope,
      });
    }
    return syncPolymarketPositionsFromPolygon(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      positionScope,
      prefetchedBalances: inputs.prefetchedPolymarketBalances ?? null,
    });
  }

  if (requestedVenue === "polymarket" || requestedVenue === "limitless") {
    throw new Error(
      "Selected wallet looks like a Solana address; select an EVM wallet to sync positions.",
    );
  }

  return syncKalshiPositionsFromSolana(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    positionScope,
    prefetchedBalances: inputs.prefetchedSolanaBalances ?? null,
  });
}
