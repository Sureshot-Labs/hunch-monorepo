import type { Pool } from "@hunch/infra";
import type { Position } from "../order-types.js";
import { syncWalletPositionsFromTokenBalances } from "../repos/positions-repo.js";
import { env } from "../env.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { fetchSolanaTokenBalancesByOwner } from "./solana-rpc.js";
import { fetchErc1155BalancesByOwner } from "./polygon-rpc.js";
import { ethers } from "ethers";
import { recomputePositionMetricsForWallet } from "./positions-metrics.js";
import { AuthService } from "../auth.js";
import { fetchPolymarketTrades } from "./polymarket-clob-l2.js";

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function isEthAddress(address: string): boolean {
  return ETH_ADDRESS_RE.test(address);
}

function parseNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function normalizeFillSide(value: string | null | undefined): "BUY" | "SELL" | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "BUY" || normalized === "SELL") return normalized;
  return null;
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

async function fetchPolymarketCandidateTokenIds(
  pool: Pool,
  inputs: { userId: string; walletAddresses: string[]; limit: number },
): Promise<string[]> {
  if (inputs.walletAddresses.length === 0) return [];
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
          and (wallet_address is null or wallet_address = any($2::text[]))
          and venue = 'polymarket'
          and token_id is not null
      ),
      position_tokens as (
        select token_id
        from positions
        where user_id = $1
          and wallet_address = any($2::text[])
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
    [inputs.userId, inputs.walletAddresses, inputs.limit],
  );

  return rows
    .map((row) => row.token_id)
    .filter((tokenId): tokenId is string => Boolean(tokenId));
}

async function fetchPolymarketFunderAddress(
  pool: Pool,
  inputs: { userId: string; walletAddress: string },
): Promise<string | null> {
  const { rows } = await pool.query<{ funder_address: string | null }>(
    `
      select funder_address
      from user_venue_credentials
      where user_id = $1
        and wallet_address = $2
        and venue = 'polymarket'
        and is_active = true
      limit 1
    `,
    [inputs.userId, inputs.walletAddress],
  );
  const funder = rows[0]?.funder_address ?? null;
  if (!funder) return null;
  if (!isEthAddress(funder)) return null;
  return funder;
}

async function syncPolymarketTradesForSigner(
  pool: Pool,
  inputs: { userId: string; signerAddress: string },
): Promise<void> {
  const creds = await AuthService.getVenueCredentials(
    inputs.userId,
    "polymarket",
    inputs.signerAddress,
  );
  if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    return;
  }

  const { rows } = await pool.query<{ last_filled_at: Date | null }>(
    `
      select max(of.filled_at) as last_filled_at
      from order_fills of
      join orders o on o.id = of.order_id
      where o.user_id = $1
        and o.venue = 'polymarket'
        and (o.signer_address = $2 or o.wallet_address = $2)
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
    return;
  }

  const trades = tradesResponse.trades;
  if (!trades.length) return;

  const orderIds = new Set<string>();
  for (const trade of trades) {
    if (trade.takerOrderId) orderIds.add(trade.takerOrderId);
    for (const maker of trade.makerOrders ?? []) {
      if (maker.orderId) orderIds.add(maker.orderId);
    }
  }

  if (!orderIds.size) return;

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

  if (!orderRows.length) return;

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

  for (const trade of trades) {
    const tradeId = trade.id;
    const matchTime = parseNumber(trade.matchTime) ?? parseNumber(trade.lastUpdate);
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
        }
      }
    }
  }

  if (!fillOrderIds.length) return;

  await pool.query(
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
          last_update = now()
      from agg
      where o.id = agg.order_id
    `,
    [Array.from(new Set(fillOrderIds))],
  );
}

export type PositionsSyncResult = {
  venue: Position["venue"];
  walletAddress: string;
  heldTokens: number;
  knownTokens: number;
  upsertedPositions: number;
  flattenedPositions: number;
};

async function syncKalshiPositionsFromSolana(
  pool: Pool,
  inputs: { userId: string; walletAddress: string },
): Promise<PositionsSyncResult> {
  const balances = await fetchSolanaTokenBalancesByOwner({
    rpcUrls: env.solanaRpcUrls,
    timeoutMs: env.solanaRpcTimeoutMs,
    owner: inputs.walletAddress,
    includeToken2022: true,
  });

  const tokenBalances = balances.map((balance) => ({
    tokenId: `sol:${balance.mint}`,
    size: balance.uiAmountString,
  }));

  if (tokenBalances.length) {
    void markHotTokens({
      tokenIds: tokenBalances.map((balance) => balance.tokenId),
      venue: "dflow",
    });
  }

  const result = await syncWalletPositionsFromTokenBalances(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "kalshi",
    tokenBalances,
    tokenIdLike: "sol:%",
  });

  try {
    await recomputePositionMetricsForWallet(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      venue: "kalshi",
    });
  } catch (error) {
    console.error("Kalshi position metrics update failed", error);
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
  inputs: { userId: string; walletAddress: string },
): Promise<PositionsSyncResult> {
  try {
    await syncPolymarketTradesForSigner(pool, {
      userId: inputs.userId,
      signerAddress: inputs.walletAddress,
    });
  } catch (error) {
    console.error("Polymarket trade sync failed", error);
  }

  const funder =
    (await fetchPolymarketFunderAddress(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
    })) ?? inputs.walletAddress;
  const ownerCandidates = [funder, inputs.walletAddress].filter(Boolean);
  const owners = Array.from(
    new Map(
      ownerCandidates.map((address) => [address.toLowerCase(), address]),
    ).values(),
  );
  const tokenIds = await fetchPolymarketCandidateTokenIds(pool, {
    userId: inputs.userId,
    walletAddresses: owners,
    limit: 1000,
  });

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

  const conditionalTokensAddress =
    process.env.POLYMARKET_CONDITIONAL_TOKENS_ADDRESS?.trim() ||
    "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

  const heldByOwner = new Map<string, Array<{ tokenId: string; size: string }>>();
  const allHeldTokens = new Set<string>();
  const chunkSize = 200;
  for (const owner of owners) {
    const held: Array<{ tokenId: string; size: string }> = [];
    for (let i = 0; i < tokenIds.length; i += chunkSize) {
      const chunk = tokenIds.slice(i, i + chunkSize);
      const balances = await fetchErc1155BalancesByOwner({
        rpcUrl: env.polygonRpcUrl,
        timeoutMs: env.polygonRpcTimeoutMs,
        contractAddress: conditionalTokensAddress,
        owner,
        tokenIds: chunk,
      });

      for (const tokenId of chunk) {
        const balance = balances.get(tokenId) ?? 0n;
        if (balance <= 0n) continue;
        held.push({ tokenId, size: ethers.formatUnits(balance, 6) });
      }
    }
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
      tokenBalances: held,
    });
    heldTokens += result.heldTokens;
    knownTokens += result.knownTokens;
    upsertedPositions += result.upsertedPositions;
    flattenedPositions += result.flattenedPositions;

    try {
      await recomputePositionMetricsForWallet(pool, {
        userId: inputs.userId,
        walletAddress: owner,
        venue: "polymarket",
      });
    } catch (error) {
      console.error("Polymarket position metrics update failed", error);
    }

  }

  if (allHeldTokens.size) {
    void markHotTokens({
      tokenIds: Array.from(allHeldTokens),
      venue: "polymarket",
    });
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

export async function syncPositionsForUserWallet(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue?: Position["venue"];
  },
): Promise<PositionsSyncResult> {
  const requestedVenue = inputs.venue;

  if (
    requestedVenue &&
    requestedVenue !== "kalshi" &&
    requestedVenue !== "polymarket"
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
    return syncPolymarketPositionsFromPolygon(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
    });
  }

  if (requestedVenue === "polymarket") {
    throw new Error(
      "Selected wallet looks like a Solana address; select an EVM wallet to sync Polymarket positions.",
    );
  }

  return syncKalshiPositionsFromSolana(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
  });
}
