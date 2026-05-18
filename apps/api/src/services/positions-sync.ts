import type { Pool } from "@hunch/infra";
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
import { fetchErc1155BalancesByOwner } from "./polygon-rpc.js";
import { ethers } from "ethers";
import { recomputePositionMetricsForWallet } from "./positions-metrics.js";
import { notifyResolvedPositions } from "./positions-notifications.js";
import { AuthService } from "../auth.js";
import { fetchPolymarketTrades } from "./polymarket-clob-l2.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "./notifications.js";
import { insertVolumeEventsWithMultiplier } from "./rewards-multiplier.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "./limitless-client.js";
import {
  buildLimitlessRequestAuthInputs,
  resolveLimitlessAuthContext,
} from "./limitless-auth.js";
import { syncLimitlessHistoryForWallet } from "./limitless-history.js";

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const POLYMARKET_RECENT_FLAT_PROTECT_SEC = 15;
const POLYMARKET_FLATTEN_GRACE_SEC = 15;
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

export type PrefetchedPolymarketOwnerBalances = {
  owners: string[];
  funderAddress: string | null;
  candidateTokenIds: string[];
  trackedTokenIds: string[];
  unionTokenIds: string[];
  rpcCallEstimate: number;
  rpcCallCount: number;
  balancesByOwner: Map<string, WalletTokenBalance[]>;
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

function extractLimitlessTokenBalances(payload: unknown): WalletTokenBalance[] {
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
    }
  }

  return output;
}

async function backfillPolymarketUnifiedTokens(
  pool: Pool,
  tokenIds: string[],
): Promise<void> {
  if (tokenIds.length === 0) return;

  await pool.query(
    `
      with wanted as (
        select unnest($1::text[]) as token_id
      ),
      matched_yes as (
        select m.id as market_id, w.token_id, 'YES'::text as side
        from unified_markets m
        join wanted w on w.token_id = m.token_yes
        where m.venue = 'polymarket'
      ),
      matched_no as (
        select m.id as market_id, w.token_id, 'NO'::text as side
        from unified_markets m
        join wanted w on w.token_id = m.token_no
        where m.venue = 'polymarket'
      ),
      matched_clob as (
        select m.id as market_id,
               elem.token_id,
               case when elem.ordinality = 1 then 'YES' else 'NO' end as side
        from unified_markets m
        join lateral json_array_elements_text(m.clob_token_ids::json)
          with ordinality as elem(token_id, ordinality) on true
        join wanted w on w.token_id = elem.token_id
        where m.venue = 'polymarket'
          and m.clob_token_ids is not null
          and m.clob_token_ids <> ''
          and m.clob_token_ids <> '[]'
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
        select unnest($1::text[]) as token_id
      ),
      matched_yes as (
        select m.id as market_id, w.token_id, 'YES'::text as side
        from unified_markets m
        join wanted w on w.token_id = m.token_yes
        where m.venue = 'kalshi'
      ),
      matched_no as (
        select m.id as market_id, w.token_id, 'NO'::text as side
        from unified_markets m
        join wanted w on w.token_id = m.token_no
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
  inputs: { userId: string; walletAddresses: string[]; limit: number },
): Promise<string[]> {
  if (inputs.walletAddresses.length === 0) return [];
  const normalizedWallets = inputs.walletAddresses.map((address) =>
    address.toLowerCase(),
  );
  const { rows } = await pool.query<{ token_id: string }>(
    `
      with watchlist_tokens as (
        select json_array_elements_text(m.clob_token_ids::json) as token_id
        from user_watchlist w
        join unified_markets m
          on m.id = w.market_id
        where w.user_id = $1
          and m.venue = 'polymarket'
          and m.clob_token_ids is not null
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
};

type PolymarketTradeSyncResult = {
  insertedFillCount: number;
  positionsRecomputed: boolean;
};

async function syncPolymarketStoredPositionsFromPolygon(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    positionScope: PositionScope;
    prefetchedBalances?: PrefetchedPolymarketOwnerBalances | null;
  },
): Promise<PositionsSyncResult> {
  const prefetched = inputs.prefetchedBalances ?? null;
  const owners =
    prefetched?.owners ??
    (await expandPolymarketWallets(pool, {
      userId: inputs.userId,
      walletAddresses: [inputs.walletAddress],
    }));
  const tokenIds =
    prefetched?.candidateTokenIds ??
    (await fetchPolymarketCandidateTokenIds(pool, {
      userId: inputs.userId,
      walletAddresses: owners,
      limit: 1000,
    }));

  if (tokenIds.length === 0) {
    return {
      venue: "polymarket",
      walletAddress: inputs.walletAddress,
      heldTokens: 0,
      knownTokens: 0,
      upsertedPositions: 0,
      flattenedPositions: 0,
    };
  }

  const heldByOwner = new Map<
    string,
    Array<{ tokenId: string; size: string }>
  >();
  const allHeldTokens = new Set<string>();

  const ownerHeldResults =
    prefetched != null
      ? filterPrefetchedPolymarketOwnerBalances({
          prefetched,
          owners,
          tokenIds,
        })
      : await Promise.all(
          owners.map(async (owner) => ({
            owner,
            held: await fetchErc1155OwnerTokenBalances({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              contractAddress: env.polymarketConditionalTokensAddress,
              owner,
              tokenIds,
            }),
          })),
        );

  for (const { owner, held } of ownerHeldResults) {
    for (const item of held) {
      allHeldTokens.add(item.tokenId);
    }
    heldByOwner.set(owner, held);
  }

  if (allHeldTokens.size > 0) {
    await backfillPolymarketUnifiedTokens(pool, Array.from(allHeldTokens));
  }

  let heldTokens = 0;
  let knownTokens = 0;
  let upsertedPositions = 0;
  let flattenedPositions = 0;

  for (const owner of owners) {
    const held = heldByOwner.get(owner) ?? [];
    const result = await syncWalletPositionsFromTokenBalances(pool, {
      userId: inputs.userId,
      walletAddress: owner,
      venue: "polymarket",
      positionScope: inputs.positionScope,
      tokenBalances: held,
      // Short grace avoids flattening fresh matched BUYs before Polygon state
      // catches up, while still converging quickly.
      flattenGraceSec: POLYMARKET_FLATTEN_GRACE_SEC,
      // Prevent immediate stale RPC snapshots from reopening freshly flattened
      // rows right after matched sells.
      protectRecentFlatsSec: POLYMARKET_RECENT_FLAT_PROTECT_SEC,
    });
    heldTokens += result.heldTokens;
    knownTokens += result.knownTokens;
    upsertedPositions += result.upsertedPositions;
    flattenedPositions += result.flattenedPositions;

    if (inputs.positionScope === "own") {
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
    }
  }

  if (allHeldTokens.size) {
    const tokenIds = Array.from(allHeldTokens);
    void markHotTokens({
      tokenIds,
      venue: "polymarket",
    });
    void requestPriceRefreshForTokens({ tokenIds, venue: "polymarket" });
  }

  return {
    venue: "polymarket",
    walletAddress: inputs.walletAddress,
    heldTokens,
    knownTokens,
    upsertedPositions,
    flattenedPositions,
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
  const afterSec =
    lastFilledAt != null
      ? Math.max(0, Math.floor(lastFilledAt.getTime() / 1000) - 1)
      : null;

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
      positionsRecomputed: false,
    };
  }

  const trades = tradesResponse.trades;
  if (!trades.length) {
    return {
      insertedFillCount: 0,
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
      positionsRecomputed: false,
    };
  }

  const { rows: orderRows } = await pool.query<{
    id: string;
    venue_order_id: string;
  }>(
    `
      select id, venue_order_id
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
      positionsRecomputed: false,
    };
  }

  const orderMap = new Map<string, string>();
  for (const row of orderRows) {
    if (row.venue_order_id) {
      orderMap.set(row.venue_order_id, row.id);
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
  const volumeSourceIds: string[] = [];
  const volumeNotionals: number[] = [];
  const volumeTimes: Date[] = [];

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
        const internalOrderId = orderMap.get(takerOrderId);
        if (!internalOrderId) continue;
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
          volumeSourceIds.push(venueFillId);
          volumeNotionals.push(size * price);
          volumeTimes.push(filledAt);
        }
      }
    }

    for (const maker of trade.makerOrders ?? []) {
      if (!maker.orderId || !orderMap.has(maker.orderId)) continue;
      const side = normalizeFillSide(maker.side);
      const size = parseNumber(maker.matchedAmount);
      const price = parseNumber(maker.price);
      if (side && size != null && size > 0 && price != null && price > 0) {
        const internalOrderId = orderMap.get(maker.orderId);
        if (!internalOrderId) continue;
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
          volumeSourceIds.push(venueFillId);
          volumeNotionals.push(size * price);
          volumeTimes.push(filledAt);
        }
      }
    }
  }

  if (!fillOrderIds.length) {
    return {
      insertedFillCount: 0,
      positionsRecomputed: false,
    };
  }

  const { rows: insertedFills } = await pool.query<{
    order_id: string;
    fill_size: number;
    fill_price: number;
    fill_side: string;
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
      returning order_id, fill_size, fill_price, fill_side
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

  if (volumeSourceIds.length) {
    await insertVolumeEventsWithMultiplier(pool, {
      userId: inputs.userId,
      walletAddress: inputs.signerAddress,
      venue: "polymarket",
      sourceType: "order",
      events: volumeSourceIds.map((sourceId, index) => ({
        sourceId,
        notionalUsd: volumeNotionals[index] ?? 0,
        createdAt: volumeTimes[index] ?? new Date(),
      })),
    });
  }

  await pool.query(
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
      )
      update orders o
      set filled_size = agg.filled_size,
          average_fill_price = agg.average_fill_price,
          filled_at = agg.filled_at,
          status = case
            when o.status in ('cancelled', 'rejected', 'expired') then o.status
            when o.status = 'unconfirmed' then o.status
            when agg.filled_size > 0 and upper(coalesce(o.order_type, '')) = 'FOK'
              then 'matched'
            when agg.filled_size > 0 and o.size is not null and agg.filled_size >= o.size
              then 'filled'
            when agg.filled_size > 0 then 'partially_filled'
            else o.status
          end,
          last_update = now()
      from agg
      where o.id = agg.order_id
    `,
    [Array.from(new Set(fillOrderIds))],
  );

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
};

type PositionScope = "own" | "followed";
const KALSHI_POSITIONS_SYNC_GRACE_SEC = 0;

async function syncKalshiPositionsFromSolana(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    positionScope: PositionScope;
    prefetchedBalances?: SolanaTokenBalance[] | null;
  },
): Promise<PositionsSyncResult> {
  const balances =
    inputs.prefetchedBalances ??
    (await fetchSolanaTokenBalancesByOwner({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      owner: inputs.walletAddress,
      includeToken2022: true,
    }));

  const tokenBalances = balances.map((balance) => ({
    tokenId: `sol:${balance.mint}`,
    size: balance.uiAmountString,
  }));

  if (tokenBalances.length > 0) {
    await backfillKalshiUnifiedTokens(
      pool,
      tokenBalances.map((balance) => balance.tokenId),
    );
  }

  if (tokenBalances.length) {
    const tokenIds = tokenBalances.map((balance) => balance.tokenId);
    void markHotTokens({
      tokenIds,
      venue: "dflow",
    });
    void requestPriceRefreshForTokens({ tokenIds, venue: "dflow" });
  }

  const result = await syncWalletPositionsFromTokenBalances(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "kalshi",
    positionScope: inputs.positionScope,
    tokenBalances,
    tokenIdLike: "sol:%",
    flattenGraceSec: KALSHI_POSITIONS_SYNC_GRACE_SEC,
    protectRecentFlatsSec: KALSHI_POSITIONS_SYNC_GRACE_SEC,
  });

  if (inputs.positionScope === "own") {
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
  }

  return {
    venue: "kalshi",
    walletAddress: inputs.walletAddress,
    heldTokens: result.heldTokens,
    knownTokens: result.knownTokens,
    upsertedPositions: result.upsertedPositions,
    flattenedPositions: result.flattenedPositions,
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
  const creds = await AuthService.getVenueCredentials(
    inputs.userId,
    "limitless",
    inputs.walletAddress,
  );
  const authContext = await resolveLimitlessAuthContext(
    inputs.userId,
    inputs.walletAddress,
  );
  if (!authContext || !creds) {
    throw new Error(
      "Connect Limitless for this wallet before syncing positions.",
    );
  }

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: "/portfolio/positions",
    ...buildLimitlessRequestAuthInputs(authContext),
  });

  if (!upstream.ok) {
    const message = extractLimitlessMessage(upstream.payload);
    throw new Error(
      message
        ? `Limitless positions sync failed: ${message}`
        : "Limitless positions sync failed.",
    );
  }

  try {
    await syncLimitlessHistoryForWallet(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      authContext,
      page: 1,
      limit: 50,
    });
  } catch (error) {
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
  try {
    onchainTokenBalances = await fetchLimitlessOnchainTokenBalances(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
    });
  } catch (error) {
    console.error("Limitless on-chain balance sync failed", error);
  }
  const tokenBalances = mergeWalletTokenBalances(
    snapshotTokenBalances,
    onchainTokenBalances,
  );

  if (tokenBalances.length) {
    const tokenIds = tokenBalances.map((balance) => balance.tokenId);
    void markHotTokens({
      tokenIds,
      venue: "limitless",
    });
    void requestPriceRefreshForTokens({ tokenIds, venue: "limitless" });
  }

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

  if (inputs.positionScope === "own") {
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
  }

  return {
    venue: "limitless",
    walletAddress: inputs.walletAddress,
    heldTokens: result.heldTokens,
    knownTokens: result.knownTokens,
    upsertedPositions: result.upsertedPositions,
    flattenedPositions: result.flattenedPositions,
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
