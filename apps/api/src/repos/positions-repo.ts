import type { Pool, PoolClient } from "@hunch/infra";
import { tx } from "@hunch/infra";
import type { Position } from "../order-types.js";
import type { PgParams } from "../server-types.js";

type PositionRow = {
  id: string;
  user_id: string;
  wallet_address: string | null;
  venue: string;
  token_id: string;
  side: string;
  size: string;
  average_price: string | null;
  unrealized_pnl: string | null;
  realized_pnl: string | null;
  last_updated_at: Date;
  created_at: Date;
  updated_at: Date;
};

export async function fetchPositionsForUserWallet(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue?: string;
  },
): Promise<Position[]> {
  let whereClause =
    "where user_id = $1 and (wallet_address is null or wallet_address = $2)";
  const params: PgParams = [inputs.userId, inputs.walletAddress];
  let paramCount = 2;

  if (inputs.venue) {
    paramCount += 1;
    whereClause += ` and venue = $${paramCount}`;
    params.push(inputs.venue);
  }

  const { rows } = await pool.query<PositionRow>(
    `
      with wallet_positions as (
        select distinct on (venue, token_id)
          id,
          user_id,
          wallet_address,
          venue,
          token_id,
          side,
          size,
          average_price,
          unrealized_pnl,
          realized_pnl,
          last_updated_at,
          created_at,
          updated_at
        from positions
        ${whereClause}
        order by
          venue asc,
          token_id asc,
          (wallet_address is null) asc,
          last_updated_at desc nulls last,
          updated_at desc nulls last
      )
      select
        id,
        user_id,
        wallet_address,
        venue,
        token_id,
        side,
        size,
        average_price,
        unrealized_pnl,
        realized_pnl,
        last_updated_at,
        created_at,
        updated_at
      from wallet_positions
      order by last_updated_at desc nulls last, venue asc, token_id asc
    `,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    venue: row.venue as Position["venue"],
    tokenId: row.token_id,
    side: row.side as Position["side"],
    size: parseFloat(row.size),
    averagePrice:
      row.average_price != null ? parseFloat(row.average_price) : undefined,
    unrealizedPnl: parseFloat(row.unrealized_pnl ?? "0"),
    realizedPnl: parseFloat(row.realized_pnl ?? "0"),
    lastUpdatedAt: row.last_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export type WalletTokenBalance = {
  tokenId: string;
  size: string;
};

async function upsertLongPositionsInTx(
  client: PoolClient,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: Position["venue"];
    positions: WalletTokenBalance[];
  },
): Promise<number> {
  if (inputs.positions.length === 0) return 0;

  const tokenIds = inputs.positions.map((p) => p.tokenId);
  const sizes = inputs.positions.map((p) => p.size);

  const result = await client.query(
    `
      insert into positions (
        id,
        user_id,
        wallet_address,
        venue,
        token_id,
        side,
        size,
        unrealized_pnl,
        realized_pnl,
        last_updated_at,
        created_at,
        updated_at
      )
      select
        gen_random_uuid(),
        $1,
        $2,
        $3,
        v.token_id,
        'LONG',
        v.size::numeric,
        0,
        0,
        now(),
        now(),
        now()
      from unnest($4::text[], $5::text[]) as v(token_id, size)
      on conflict on constraint positions_user_id_wallet_address_venue_token_id_key
      do update set
        side = 'LONG',
        size = excluded.size,
        last_updated_at = now(),
        updated_at = now()
    `,
    [inputs.userId, inputs.walletAddress, inputs.venue, tokenIds, sizes],
  );

  return result.rowCount ?? 0;
}

async function markMissingPositionsFlatInTx(
  client: PoolClient,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: Position["venue"];
    heldTokenIds: string[];
    tokenIdLike?: string;
  },
): Promise<number> {
  let whereClause = "where user_id = $1 and wallet_address = $2 and venue = $3";
  const params: PgParams = [inputs.userId, inputs.walletAddress, inputs.venue];
  let paramCount = 3;

  if (inputs.tokenIdLike) {
    paramCount += 1;
    whereClause += ` and token_id like $${paramCount}`;
    params.push(inputs.tokenIdLike);
  }

  paramCount += 1;
  whereClause += ` and not (token_id = any($${paramCount}::text[]))`;
  params.push(inputs.heldTokenIds);

  whereClause += " and (side <> 'FLAT' or size <> 0)";

  const result = await client.query(
    `
      update positions
      set
        side = 'FLAT',
        size = 0,
        last_updated_at = now(),
        updated_at = now()
      ${whereClause}
    `,
    params,
  );

  return result.rowCount ?? 0;
}

export type SyncWalletPositionsResult = {
  heldTokens: number;
  knownTokens: number;
  upsertedPositions: number;
  flattenedPositions: number;
};

export async function syncWalletPositionsFromTokenBalances(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: Position["venue"];
    tokenBalances: WalletTokenBalance[];
    tokenIdLike?: string;
  },
): Promise<SyncWalletPositionsResult> {
  const heldTokenIds = inputs.tokenBalances.map((b) => b.tokenId);

  const { rows: knownRows } = await pool.query<{ token_id: string }>(
    `
      select token_id
      from unified_tokens
      where venue = $1
        and token_id = any($2::text[])
    `,
    [inputs.venue, heldTokenIds],
  );

  const knownSet = new Set(knownRows.map((row) => row.token_id));
  const knownTokenBalances = inputs.tokenBalances.filter((b) =>
    knownSet.has(b.tokenId),
  );

  const result = await tx(pool, async (client: PoolClient) => {
    const upsertedPositions = await upsertLongPositionsInTx(client, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      venue: inputs.venue,
      positions: knownTokenBalances,
    });

    const flattenedPositions = await markMissingPositionsFlatInTx(client, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      venue: inputs.venue,
      heldTokenIds,
      tokenIdLike: inputs.tokenIdLike,
    });

    return { upsertedPositions, flattenedPositions };
  });

  return {
    heldTokens: heldTokenIds.length,
    knownTokens: knownTokenBalances.length,
    upsertedPositions: result.upsertedPositions,
    flattenedPositions: result.flattenedPositions,
  };
}
