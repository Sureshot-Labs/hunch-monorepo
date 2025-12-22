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
  is_hidden: boolean | null;
  hidden_reason: string | null;
  hidden_at: Date | null;
  last_updated_at: Date;
  created_at: Date;
  updated_at: Date;
};

function mapPositionRow(row: PositionRow): Position {
  const size = parseFloat(row.size);
  const averagePrice =
    row.average_price != null ? parseFloat(row.average_price) : undefined;
  const estimatedPayout = Number.isFinite(size) && size > 0 ? size : 0;
  const estimatedProfit =
    averagePrice != null && Number.isFinite(size)
      ? estimatedPayout - averagePrice * size
      : undefined;

  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    venue: row.venue as Position["venue"],
    tokenId: row.token_id,
    side: row.side as Position["side"],
    size,
    averagePrice,
    unrealizedPnl: parseFloat(row.unrealized_pnl ?? "0"),
    realizedPnl: parseFloat(row.realized_pnl ?? "0"),
    estimatedPayout,
    estimatedProfit,
    isHidden: row.is_hidden ?? false,
    hiddenReason: row.hidden_reason ?? undefined,
    hiddenAt: row.hidden_at ?? undefined,
    lastUpdatedAt: row.last_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function fetchPositionsForUserWallet(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddresses: string[];
    venue?: string;
    includeHidden?: boolean;
  },
): Promise<Position[]> {
  if (inputs.walletAddresses.length === 0) return [];

  let whereClause =
    "where user_id = $1 and (wallet_address is null or wallet_address = any($2::text[]))";
  const params: PgParams = [inputs.userId, inputs.walletAddresses];
  let paramCount = 2;

  if (!inputs.includeHidden) {
    whereClause += " and (is_hidden is null or is_hidden = false)";
  }

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
          is_hidden,
          hidden_reason,
          hidden_at,
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
        is_hidden,
        hidden_reason,
        hidden_at,
        last_updated_at,
        created_at,
        updated_at
      from wallet_positions
      order by last_updated_at desc nulls last, venue asc, token_id asc
    `,
    params,
  );

  return rows.map((row) => mapPositionRow(row));
}

export async function fetchPositionsForUserWalletByTokenIds(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddresses: string[];
    tokenIds: string[];
    venue?: string;
    includeHidden?: boolean;
  },
): Promise<Position[]> {
  if (inputs.tokenIds.length === 0) return [];
  if (inputs.walletAddresses.length === 0) return [];

  let whereClause =
    "where user_id = $1 and (wallet_address is null or wallet_address = any($2::text[]))";
  const params: PgParams = [inputs.userId, inputs.walletAddresses];
  let paramCount = 2;

  paramCount += 1;
  whereClause += ` and token_id = any($${paramCount}::text[])`;
  params.push(inputs.tokenIds);

  if (!inputs.includeHidden) {
    whereClause += " and (is_hidden is null or is_hidden = false)";
  }

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
          is_hidden,
          hidden_reason,
          hidden_at,
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
        is_hidden,
        hidden_reason,
        hidden_at,
        last_updated_at,
        created_at,
        updated_at
      from wallet_positions
      order by last_updated_at desc nulls last, venue asc, token_id asc
    `,
    params,
  );

  return rows.map((row) => mapPositionRow(row));
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

export async function autoHideResolvedLosingPositions(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: Position["venue"];
  },
): Promise<number> {
  const result = await pool.query(
    `
      update positions p
      set
        is_hidden = true,
        hidden_reason = 'auto_lost',
        hidden_at = now(),
        updated_at = now()
      from unified_tokens ut
      join unified_markets m on m.id = ut.market_id
      where p.user_id = $1
        and p.wallet_address = $2
        and p.venue = $3
        and p.token_id = ut.token_id
        and ut.venue = $3
        and (p.is_hidden is null or p.is_hidden = false)
        and p.side <> 'FLAT'
        and p.size > 0
        and m.resolved_outcome is not null
        and upper(m.resolved_outcome) in ('YES', 'NO')
        and upper(m.resolved_outcome) <> ut.side
    `,
    [inputs.userId, inputs.walletAddress, inputs.venue],
  );

  return result.rowCount ?? 0;
}

export async function updatePositionMetrics(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: Position["venue"];
    metrics: Array<{
      tokenId: string;
      averagePrice: number | null;
      realizedPnl: number;
      unrealizedPnl: number;
    }>;
  },
): Promise<void> {
  if (inputs.metrics.length === 0) return;

  const tokenIds = inputs.metrics.map((metric) => metric.tokenId);
  const averagePrices = inputs.metrics.map((metric) => metric.averagePrice);
  const realizedPnls = inputs.metrics.map((metric) => metric.realizedPnl);
  const unrealizedPnls = inputs.metrics.map((metric) => metric.unrealizedPnl);

  await pool.query(
    `
      update positions p
      set
        average_price = v.average_price,
        realized_pnl = v.realized_pnl,
        unrealized_pnl = v.unrealized_pnl,
        last_updated_at = now(),
        updated_at = now()
      from (
        select
          unnest($1::text[]) as token_id,
          unnest($2::numeric[]) as average_price,
          unnest($3::numeric[]) as realized_pnl,
          unnest($4::numeric[]) as unrealized_pnl
      ) v
      where p.user_id = $5
        and (p.wallet_address is null or p.wallet_address = $6)
        and p.venue = $7
        and p.token_id = v.token_id
    `,
    [
      tokenIds,
      averagePrices,
      realizedPnls,
      unrealizedPnls,
      inputs.userId,
      inputs.walletAddress,
      inputs.venue,
    ],
  );
}
