import type { Pool } from "@hunch/infra";
import type { Position } from "../order-types.js";
import { syncWalletPositionsFromTokenBalances } from "../repos/positions-repo.js";
import { env } from "../env.js";
import { fetchSolanaTokenBalancesByOwner } from "./solana-rpc.js";
import { fetchErc1155BalancesByOwner } from "./polygon-rpc.js";
import { ethers } from "ethers";

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function isEthAddress(address: string): boolean {
  return ETH_ADDRESS_RE.test(address);
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
  inputs: { userId: string; walletAddress: string; limit: number },
): Promise<string[]> {
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
          and (wallet_address is null or wallet_address = $2)
          and venue = 'polymarket'
          and token_id is not null
      ),
      position_tokens as (
        select token_id
        from positions
        where user_id = $1
          and wallet_address = $2
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
    [inputs.userId, inputs.walletAddress, inputs.limit],
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
    rpcUrl: env.solanaRpcUrl,
    timeoutMs: env.solanaRpcTimeoutMs,
    owner: inputs.walletAddress,
    includeToken2022: true,
  });

  const tokenBalances = balances.map((balance) => ({
    tokenId: `sol:${balance.mint}`,
    size: balance.uiAmountString,
  }));

  const result = await syncWalletPositionsFromTokenBalances(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "kalshi",
    tokenBalances,
    tokenIdLike: "sol:%",
  });

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
  const tokenIds = await fetchPolymarketCandidateTokenIds(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
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

  const funder =
    (await fetchPolymarketFunderAddress(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
    })) ?? inputs.walletAddress;

  const held: Array<{ tokenId: string; size: string }> = [];
  const chunkSize = 200;
  for (let i = 0; i < tokenIds.length; i += chunkSize) {
    const chunk = tokenIds.slice(i, i + chunkSize);
    const balances = await fetchErc1155BalancesByOwner({
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      contractAddress: conditionalTokensAddress,
      owner: funder,
      tokenIds: chunk,
    });

  for (const tokenId of chunk) {
      const balance = balances.get(tokenId) ?? 0n;
      if (balance <= 0n) continue;
      held.push({ tokenId, size: ethers.formatUnits(balance, 6) });
    }
  }

  await backfillPolymarketUnifiedTokens(
    pool,
    held.map((item) => item.tokenId),
  );

  const result = await syncWalletPositionsFromTokenBalances(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "polymarket",
    tokenBalances: held,
  });

  return {
    venue: "polymarket",
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
