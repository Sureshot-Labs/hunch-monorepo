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
import { fetchSolanaTokenBalancesByOwnerMints } from "./services/solana-rpc.js";
import { syncPositionsForUserWallet } from "./services/positions-sync.js";
import { runWhaleProfiles } from "./services/whale-profiles.js";

type Chain = "polygon" | "base" | "solana";
type Venue = "polymarket" | "limitless" | "kalshi";

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
  const arg = process.argv.find((entry) => entry.startsWith("--backfill="));
  if (arg) {
    const raw = arg.split("=")[1];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  const envValue = env.walletIntelBackfillSnapshots ?? 0;
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.floor(envValue);
  }
  return 0;
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
  let balances: Map<string, number>;
  try {
    balances = await fetchSolanaTokenBalancesByOwnerMints({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      owner: inputs.address,
      mints: inputs.tokenMints,
    });
  } catch (error) {
    console.error(
      "[wallets:intel:refresh] solana balances fetch failed",
      { wallet: inputs.address, mints: inputs.tokenMints.length },
      error,
    );
    return 0;
  }

  let inserted = 0;

  for (const [mint, amount] of balances.entries()) {
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
  },
): Promise<{ inserts: number; updates: number }> {
  if (inputs.walletIds.length === 0) return { inserts: 0, updates: 0 };

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
    `,
    [inputs.walletIds, inputs.occurredAt],
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
      order by wallet_id, venue, market_id, outcome_side, snapshot_at desc
    `,
    [inputs.walletIds, inputs.occurredAt],
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
      ? `and occurred_at >= $3::timestamptz - interval '${entry.since}' and occurred_at <= $3::timestamptz`
      : "and occurred_at <= $3::timestamptz";
    await client.query(
      `
        insert into wallet_metrics_snapshots (
          wallet_id,
          venue,
          period,
          as_of,
          trades_count,
          volume_usd,
          last_trade_at
        )
        select
          wallet_id,
          null,
          $2::text,
          $3::timestamptz,
          count(*)::int,
          sum(size_usd),
          max(occurred_at)
        from wallet_activity_events
        where wallet_id = any($1::uuid[])
          and activity_type in ('delta', 'trade')
        ${whereSince}
        group by wallet_id
        on conflict (wallet_id, venue, period, as_of)
        do update set
          trades_count = excluded.trades_count,
          volume_usd = excluded.volume_usd,
          last_trade_at = excluded.last_trade_at,
          updated_at = now()
      `,
      [inputs.walletIds, entry.period, inputs.asOf],
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
      set label = concat_ws(' ', src.label, '(Safe)'),
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
      set label = concat_ws(' ', src.label, '(Signer)'),
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
      set label = 'Safe (auto)',
          updated_at = now()
      where label is null
        and metadata->>'kind' = 'safe'
    `,
  );

  await client.query(
    `
      update wallets
      set label = 'Signer (auto)',
          updated_at = now()
      where label is null
        and metadata->>'kind' = 'safe_owner'
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
  const result = await client.query<MarketPickRow>(
    `
      with recent as (
        select token_id, sum(volume) as vol
        from unified_last_trade_1m
        where venue = 'polymarket'
          and bucket >= now() - ($1::text || ' hours')::interval
        group by token_id
      )
      select
        m.id,
        m.venue,
        m.volume_24h
      from unified_markets m
      join recent r on (m.clob_token_ids::jsonb ? r.token_id)
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
  const result = await client.query<MarketPickRow>(
    `
      with recent as (
        select token_id, sum(volume) as vol
        from unified_last_trade_1m
        where venue = 'kalshi'
          and bucket >= now() - ($1::text || ' hours')::interval
        group by token_id
      )
      select
        m.id,
        m.venue,
        m.volume_24h
      from unified_markets m
      join recent r on (m.token_yes = r.token_id or m.token_no = r.token_id)
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
  const polyMode = env.walletIntelSelectionModePoly;
  const kalshiMode = env.walletIntelSelectionModeKalshi;
  const limitlessMode = env.walletIntelSelectionModeLimitless;

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
  const holderLimit = env.walletIntelHolderLimit;
  const marketLimit = env.walletIntelMarketLimit;
  const marketLimitPerVenue = env.walletIntelMarketLimitPerVenue;
  const marketLimitKalshi = env.walletIntelMarketLimitKalshi;
  const marketLimitPerVenueMax = Math.max(
    marketLimitPerVenue,
    marketLimitKalshi,
  );

  console.log(
    `[wallets:intel:refresh] start markets=${marketLimit} holders=${holderLimit} snapshot=${snapshotAt.toISOString()}`,
  );

  const client = await pool.connect();
  try {
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
      [env.walletIntelMinVolume24h, marketLimit],
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
        select distinct um.id, um.venue, um.volume_24h
        from user_watchlist uw
        join wallet_follows wf on wf.user_id = uw.user_id
        join unified_markets um on um.id = uw.market_id
        where um.status = 'ACTIVE'
          and um.venue in ('polymarket', 'limitless', 'kalshi')
          and (um.venue != 'kalshi' or um.is_initialized is true)
      `,
    );

    const whaleMarkets =
      env.walletIntelWhaleMarketLimit > 0
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
            [env.walletIntelWhaleMarketLimit],
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
            sizeUsd >= env.walletIntelWhaleUsdSolana
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
      `,
    );

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
      freshDays: env.walletIntelFreshDays,
      dormantDays: env.walletIntelDormantDays,
      whaleUsd: env.walletIntelWhaleUsd,
      whaleUsdSolana: env.walletIntelWhaleUsdSolana,
      asOf: snapshotAt,
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
  const runAt = new Date();
  const baseSnapshot = bucketDate(runAt, env.walletIntelSnapshotHours);
  const backfillSteps = parseBackfillSnapshots();
  const snapshots: Date[] = [];

  if (backfillSteps > 0) {
    console.log(
      `[wallets:intel:refresh] backfill snapshots=${backfillSteps} stepHours=${env.walletIntelSnapshotHours}`,
    );
  }

  for (let step = backfillSteps; step >= 0; step -= 1) {
    snapshots.push(
      addHours(baseSnapshot, -step * env.walletIntelSnapshotHours),
    );
  }

  for (const snapshotAt of snapshots) {
    await runSnapshot(snapshotAt);
  }

  if (env.aiWhaleProfileAutoRun) {
    const result = await runWhaleProfiles({
      limit: env.aiWhaleProfileLimit,
      marketLimit: env.aiWhaleProfileMarketLimit,
      windowDays: env.aiWhaleProfileWindowDays,
    });
    console.log("[wallets:intel:refresh] whale profiles", result);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[wallets:intel:refresh] failed", error);
    process.exit(1);
  });
