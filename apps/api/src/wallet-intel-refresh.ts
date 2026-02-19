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
import { fetchSolanaTokenBalancesByOwner } from "./services/solana-rpc.js";
import { syncPositionsForUserWallet } from "./services/positions-sync.js";
import { runWhaleProfiles } from "./services/whale-profiles.js";
import {
  getIntelPolicyDefaults,
  resolveAiWhaleProfilesPolicy,
  resolveWalletIntelRefreshPolicy,
  type AiWhaleProfilesPolicy,
  type WalletIntelRefreshPolicy,
} from "./services/runtime-policies.js";
import { NET_SHARES_EPSILON } from "./services/wallet-intel-pnl.js";

type Chain = "polygon" | "base" | "solana";
type Venue = "polymarket" | "limitless" | "kalshi";

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
): Promise<LimitlessOrderbook | null> {
  const res = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}/orderbook`,
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
): Promise<LimitlessMarketDetail | null> {
  const res = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}`,
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

    const orderbook = await fetchLimitlessOrderbook(row.slug);
    if (orderbook) {
      bestBid = parseLimitlessNumber(orderbook.bids?.[0]?.price ?? null);
      bestAsk = parseLimitlessNumber(orderbook.asks?.[0]?.price ?? null);
      lastPrice = parseLimitlessNumber(orderbook.lastTradePrice ?? null);
    }

    if (bestBid == null && bestAsk == null && lastPrice == null) {
      const detail = await fetchLimitlessMarketDetail(row.slug);
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

function normalizeAddress(address: string, chain: Chain): string {
  const trimmed = address.trim();
  if (chain === "solana") return trimmed;
  if (trimmed.startsWith("0x")) return trimmed.toLowerCase();
  return trimmed.toLowerCase();
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
      on conflict (wallet_id, venue, market_id, snapshot_at)
      do update set
        outcome_side = excluded.outcome_side,
        shares = excluded.shares,
        size_usd = excluded.size_usd,
        price = excluded.price,
        metadata = excluded.metadata
    `,
    [
      inputs.walletId,
      inputs.venue,
      inputs.marketId,
      inputs.outcomeSide,
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
      on conflict (wallet_id, venue, market_id, activity_type, occurred_at)
      do update set
        outcome_side = excluded.outcome_side,
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
      inputs.outcomeSide,
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
  },
): Promise<number> {
  if (inputs.tokenIds.length === 0) return 0;
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

    for (const tokenId of chunk) {
      const balance = balances.get(tokenId) ?? 0n;
      if (balance <= 0n) continue;
      const entry = inputs.tokenIndex.get(tokenId);
      if (!entry) continue;

      const shares = Number(ethers.formatUnits(balance, 6));
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
          onchainTokenId: tokenId,
          shares,
        },
        snapshotAt: inputs.occurredAt,
      });

      inserted += 1;
    }
  }

  return inserted;
}

async function snapshotFollowedWalletHoldingsSolana(
  client: Queryable,
  inputs: {
    walletId: string;
    address: string;
    tokenMints: string[];
    tokenIndex: Map<string, TokenIndexEntry>;
    occurredAt: Date;
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
    balances = await fetchSolanaTokenBalancesByOwner({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      owner: inputs.address,
      includeToken2022: true,
    });
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
      select distinct on (token_id)
        token_id,
        best_bid,
        best_ask,
        mid
      from unified_book_top
      where token_id = any($1::text[])
      order by token_id, ts desc
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

  const makeKey = (row: {
    wallet_id: string;
    venue: string;
    market_id: string;
    outcome_side: string | null;
  }) =>
    `${row.wallet_id}|${row.venue}|${row.market_id}|${row.outcome_side ?? "—"}`;

  for (const row of currentRows.rows) {
    currentMap.set(makeKey(row), row);
  }
  for (const row of prevRows.rows) {
    prevMap.set(makeKey(row), row);
  }

  const keys = new Set<string>([
    ...currentMap.keys(),
    ...prevMap.keys(),
  ]);

  const inserts = 0;
  let updates = 0;

  for (const key of keys) {
    const current = currentMap.get(key);
    const previous = prevMap.get(key);
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

async function refreshMetrics(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
  },
) {
  if (inputs.walletIds.length === 0) return;
  const periods: Array<{ period: "1d" | "7d" | "30d" | "all"; since: string | null }> = [
    { period: "1d", since: "1 day" },
    { period: "7d", since: "7 days" },
    { period: "30d", since: "30 days" },
    { period: "all", since: null },
  ];

  for (const entry of periods) {
    const whereSince = entry.since
      ? `and wa.occurred_at >= $3::timestamptz - interval '${entry.since}' and wa.occurred_at <= $3::timestamptz`
      : "and wa.occurred_at <= $3::timestamptz";
    const metricsResult = await client.query<{ negative_legs: number | string }>(
      `
        with base_events as (
          select
            wa.wallet_id,
            wa.market_id,
            upper(coalesce(wa.outcome_side, '')) as outcome_side,
            coalesce(
              wa.size_usd,
              abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
            ) as notional_usd,
            (case when upper(coalesce(wa.action, 'BUY')) = 'SELL' then -1 else 1 end)
              * coalesce(wa.delta_shares, 0) as signed_shares,
            (case when upper(coalesce(wa.action, 'BUY')) = 'SELL' then -1 else 1 end)
              * coalesce(
                  wa.size_usd,
                  abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
                ) as signed_usd,
            wa.occurred_at
          from wallet_activity_events wa
          where wa.wallet_id = any($1::uuid[])
            and wa.activity_type in ('delta', 'trade')
            ${whereSince}
        ),
        agg as (
          select
            wallet_id,
            count(*)::int as trades_count,
            sum(notional_usd) as volume_usd,
            max(occurred_at) as last_trade_at
          from base_events
          group by wallet_id
        ),
        legs as (
          select
            wallet_id,
            market_id,
            outcome_side,
            sum(signed_shares) as net_shares,
            sum(signed_usd) as net_cost
          from base_events
          where outcome_side in ('YES', 'NO')
          group by wallet_id, market_id, outcome_side
        ),
        negative_legs as (
          select count(*)::int as negative_legs
          from legs
          where net_shares < -${NET_SHARES_EPSILON}
        ),
        leg_marks as (
          select
            l.wallet_id,
            l.net_shares,
            l.net_cost,
            case
              when upper(coalesce(um.resolved_outcome, '')) in ('YES', 'NO')
                then case
                  when l.outcome_side = upper(coalesce(um.resolved_outcome, ''))
                    then l.net_shares
                  else 0
                end
              else
                case
                  when l.outcome_side = 'YES' then greatest(
                    0::numeric,
                    least(1::numeric, coalesce(um.best_ask, um.best_bid, um.last_price))
                  )
                  when l.outcome_side = 'NO' then
                    case
                      when coalesce(um.best_ask, um.best_bid, um.last_price) is null then null
                      else 1::numeric - greatest(
                        0::numeric,
                        least(1::numeric, coalesce(um.best_ask, um.best_bid, um.last_price))
                      )
                    end
                  else null
                end * l.net_shares
            end as mark_value
          from legs l
          left join unified_markets um on um.id = l.market_id
          where l.net_shares >= ${NET_SHARES_EPSILON}
        ),
        pnl as (
          select
            wallet_id,
            sum(mark_value - net_cost) as pnl_usd
          from leg_marks
          where mark_value is not null
          group by wallet_id
        ),
        upserted as (
          insert into wallet_metrics_snapshots (
            wallet_id,
            venue,
            period,
            as_of,
            trades_count,
            volume_usd,
            pnl_usd,
            last_trade_at
          )
          select
            agg.wallet_id,
            null,
            $2::text,
            $3::timestamptz,
            agg.trades_count,
            agg.volume_usd,
            pnl.pnl_usd,
            agg.last_trade_at
          from agg
          left join pnl on pnl.wallet_id = agg.wallet_id
          on conflict (wallet_id, venue, period, as_of)
          do update set
            trades_count = excluded.trades_count,
            volume_usd = excluded.volume_usd,
            pnl_usd = excluded.pnl_usd,
            last_trade_at = excluded.last_trade_at,
            updated_at = now()
          returning wallet_id
        )
        select negative_legs.negative_legs
        from negative_legs
      `,
      [inputs.walletIds, entry.period, inputs.asOf],
    );
    const negativeLegs = Number(metricsResult.rows[0]?.negative_legs ?? 0);
    if (negativeLegs > 0) {
      console.warn("[wallets:intel:refresh] pnl skipped negative net-share legs", {
        period: entry.period,
        negativeLegs,
      });
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
      with latest as (
        select
          ws.wallet_id,
          ws.venue,
          max(ws.snapshot_at) as snapshot_at
        from wallet_position_snapshots ws
        where ws.wallet_id = any($1::uuid[])
        group by ws.wallet_id, ws.venue
      ),
      exposure as (
        select
          ws.wallet_id,
          sum(coalesce(ws.size_usd, 0)) as exposure_usd
        from wallet_position_snapshots ws
        join latest l
          on l.wallet_id = ws.wallet_id
         and l.venue = ws.venue
         and l.snapshot_at = ws.snapshot_at
        where ws.wallet_id = any($1::uuid[])
        group by ws.wallet_id
      )
      insert into wallet_position_exposure (
        wallet_id,
        exposure_usd,
        as_of
      )
      select
        wallet_id,
        exposure_usd,
        $2::timestamptz
      from exposure
      on conflict (wallet_id)
      do update set
        exposure_usd = excluded.exposure_usd,
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
  const marketLimitPerVenueMax = Math.max(
    marketLimitPerVenue,
    marketLimitKalshi,
  );

  console.log(
    `[wallets:intel:refresh] start markets=${marketLimit} holders=${holderLimit} snapshot=${snapshotAt.toISOString()}`,
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
    let holderRateLimitErrors = 0;
    let holderAbortErrors = 0;
    let holderOtherErrors = 0;

    for (const market of marketRows) {
      const venue = market.venue as Venue;
      const chain = VENUE_CHAIN[market.venue] ?? null;
      if (!chain) continue;

      let data;
      try {
        data = await fetchMarketHolderData({
          marketId: market.id,
          limit: holderLimit,
          client,
        });
      } catch (error) {
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

    const followedByChain = { polygon: 0, base: 0, solana: 0 };
    for (const followed of followedWallets.rows) {
      followedByChain[followed.chain] += 1;
    }
    const estPolygonHoldingsRpcCalls =
      followedByChain.polygon *
      Math.ceil(tokenIdsByVenue.polymarket.length / 200);
    const estBaseHoldingsRpcCalls =
      followedByChain.base * Math.ceil(tokenIdsByVenue.limitless.length / 200);
    const estSolanaHoldingsRpcCalls = followedByChain.solana * 2;
    console.log("[wallets:intel:refresh] followed fanout", {
      followed: followedWallets.rows.length,
      followedByChain,
      tokenIds: {
        polymarket: tokenIdsByVenue.polymarket.length,
        limitless: tokenIdsByVenue.limitless.length,
        kalshi: tokenIdsByVenue.kalshi.length,
      },
      holdingsRpcEstimate: {
        polygon: estPolygonHoldingsRpcCalls,
        base: estBaseHoldingsRpcCalls,
        solana: estSolanaHoldingsRpcCalls,
      },
    });

    let followedProcessed = 0;
    let followedRows = 0;

    for (const followed of followedWallets.rows) {
      followedProcessed += 1;
      if (followed.chain === "polygon") {
        try {
          await syncPositionsForUserWallet(pool, {
            userId: followed.user_id,
            walletAddress: followed.address,
            venue: "polymarket",
            positionScope: "followed",
          });
        } catch (error) {
          console.error(
            "[wallets:intel:refresh] polymarket positions sync failed",
            error,
          );
        }

        const inserted = await snapshotFollowedWalletHoldingsEvm(client, {
          walletId: followed.wallet_id,
          address: normalizeAddress(followed.address, "polygon"),
          venue: "polymarket",
          rpcUrl: env.polygonRpcUrl,
          rpcTimeoutMs: env.polygonRpcTimeoutMs,
          contractAddress: env.polymarketConditionalTokensAddress,
          tokenIds: tokenIdsByVenue.polymarket,
          tokenIndex: tokenIndexByVenue.polymarket,
          occurredAt: snapshotAt,
        });
        if (inserted > 0) {
          followedRows += inserted;
          touchedWalletIds.add(followed.wallet_id);
          activityRows += inserted;
        }

        const positionsInserted = await snapshotFollowedWalletPositions(client, {
          userId: followed.user_id,
          walletId: followed.wallet_id,
          walletAddress: followed.address,
          venue: "polymarket",
          occurredAt: snapshotAt,
        });
        if (positionsInserted > 0) {
          followedRows += positionsInserted;
          touchedWalletIds.add(followed.wallet_id);
          activityRows += positionsInserted;
        }
      }

      if (followed.chain === "base") {
        try {
          await syncPositionsForUserWallet(pool, {
            userId: followed.user_id,
            walletAddress: followed.address,
            venue: "limitless",
            positionScope: "followed",
          });
        } catch (error) {
          if (isLimitlessSessionMissing(error)) {
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

        const inserted = await snapshotFollowedWalletHoldingsEvm(client, {
          walletId: followed.wallet_id,
          address: normalizeAddress(followed.address, "base"),
          venue: "limitless",
          rpcUrl: env.baseRpcUrl,
          rpcTimeoutMs: env.baseRpcTimeoutMs,
          contractAddress: env.limitlessConditionalTokensAddress,
          tokenIds: tokenIdsByVenue.limitless,
          tokenIndex: tokenIndexByVenue.limitless,
          occurredAt: snapshotAt,
        });
        if (inserted > 0) {
          followedRows += inserted;
          touchedWalletIds.add(followed.wallet_id);
          activityRows += inserted;
        }

        const positionsInserted = await snapshotFollowedWalletPositions(client, {
          userId: followed.user_id,
          walletId: followed.wallet_id,
          walletAddress: followed.address,
          venue: "limitless",
          occurredAt: snapshotAt,
        });
        if (positionsInserted > 0) {
          followedRows += positionsInserted;
          touchedWalletIds.add(followed.wallet_id);
          activityRows += positionsInserted;
        }
      }

      if (followed.chain === "solana") {
        try {
          await syncPositionsForUserWallet(pool, {
            userId: followed.user_id,
            walletAddress: followed.address,
            venue: "kalshi",
            positionScope: "followed",
          });
        } catch (error) {
          console.error(
            "[wallets:intel:refresh] kalshi positions sync failed",
            error,
          );
        }

        const inserted = await snapshotFollowedWalletHoldingsSolana(client, {
          walletId: followed.wallet_id,
          address: followed.address,
          tokenMints: tokenIdsByVenue.kalshi,
          tokenIndex: tokenIndexByVenue.kalshi,
          occurredAt: snapshotAt,
        });
        if (inserted > 0) {
          followedRows += inserted;
          touchedWalletIds.add(followed.wallet_id);
          activityRows += inserted;
        }

        const positionsInserted = await snapshotFollowedWalletPositions(client, {
          userId: followed.user_id,
          walletId: followed.wallet_id,
          walletAddress: followed.address,
          venue: "kalshi",
          occurredAt: snapshotAt,
        });
        if (positionsInserted > 0) {
          followedRows += positionsInserted;
          touchedWalletIds.add(followed.wallet_id);
          activityRows += positionsInserted;
        }
      }
    }

    const deltaResult = await applySnapshotDeltas(client, {
      walletIds: Array.from(touchedWalletIds),
      occurredAt: snapshotAt,
      marketIds: selectedMarketIds,
    });
    deltaInserts += deltaResult.inserts;
    deltaUpdates += deltaResult.updates;

    const walletIds = Array.from(touchedWalletIds);
    await refreshMetrics(client, {
      walletIds,
      asOf: snapshotAt,
    });

    await refreshSystemTags(client, {
      walletIds,
      tagIds,
      freshDays: walletIntelRefreshPolicy.freshDays,
      dormantDays: walletIntelRefreshPolicy.dormantDays,
      whaleUsd: walletIntelRefreshPolicy.whaleUsd,
      whaleUsdSolana: walletIntelRefreshPolicy.whaleUsdSolana,
      asOf: snapshotAt,
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
      snapshotAt.getTime() - activityLookbackDays * 24 * 60 * 60 * 1000,
    );

    await refreshWalletActivityBaseline(client, {
      walletIds: aggregateWalletIds,
      asOf: snapshotAt,
      windowDays: 30,
    });
    await refreshWalletActivityHourly(client, {
      walletIds: aggregateWalletIds,
      since: activitySince,
      enteredLateHours: 24,
    });
    await refreshWalletPositionExposure(client, {
      walletIds: aggregateWalletIds,
      asOf: snapshotAt,
    });
    await refreshWalletInferredOutcomes(client, {
      walletIds: aggregateWalletIds,
    });

    const whaleOwnersLinked = await linkSafeOwnersForWhales(client);

    console.log(
      `[wallets:intel:refresh] done markets=${marketsProcessed} wallets=${walletIds.length} rows=${activityRows} followed=${followedProcessed} followedRows=${followedRows} deltaInserts=${deltaInserts} deltaUpdates=${deltaUpdates} whaleOwnersLinked=${whaleOwnersLinked}`,
    );
  } finally {
    client.release();
  }
}

async function main() {
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
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[wallets:intel:refresh] failed", error);
    process.exit(1);
  });
