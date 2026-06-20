import type { Pool, PoolClient } from "@hunch/infra";
import { tx } from "@hunch/infra";
import {
  EFFECTIVE_PNL_SQL,
  POSITION_MARKET_JOIN_SQL,
  RESOLVED_MARKET_SQL,
  UNREALIZED_PNL_COMPONENT_SQL,
} from "../lib/pnl-sql.js";
import { normalizeLimitlessScopedTokenId } from "../lib/limitless-token.js";
import { MIN_POSITION_SIZE } from "../lib/positions-constants.js";
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

type PositionPnlSummaryRow = {
  open_positions_count: string;
  positions_count: string;
  total_pnl_all_time: string | null;
  unrealized_cost_basis_current: string | null;
  unrealized_pnl_current: string | null;
};

export type PositionPnlSummary = {
  openPositionsCount: number;
  positionsCount: number;
  realizedPnlAllTime: number;
  unrealizedCostBasisCurrent: number;
  unrealizedPnlCurrent: number;
  unrealizedPnlPercentCurrent: number | null;
};

export type PositionReadScopeInput = {
  userId: string;
  walletAddresses: string[];
  venue?: string;
  venues?: string[];
};

export type ResolvedPositionReadScope = {
  walletAddresses: string[];
  venueList?: string[];
};

export type PositionPnlScopeInput = PositionReadScopeInput;
export type ResolvedPositionPnlScope = ResolvedPositionReadScope;

type PositionMutationLockInput = {
  userId: string;
  venue: Position["venue"];
};

const SUPPORTED_POSITION_READ_VENUES: Position["venue"][] = [
  "polymarket",
  "kalshi",
  "limitless",
];

export type PositionMetricsInput = {
  userId: string;
  walletAddress: string;
  venue: Position["venue"];
  metrics: Array<{
    tokenId: string;
    averagePrice: number | null;
    realizedPnl: number;
    unrealizedPnl: number;
  }>;
};

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const MATERIALIZABLE_RESOLVED_POSITION_SQL = `
  p.average_price is not null
  and ${RESOLVED_MARKET_SQL}
`;

function isEthAddress(address: string | null | undefined): address is string {
  if (!address) return false;
  return ETH_ADDRESS_RE.test(address);
}

function normalizeWalletKey(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("0x")) return trimmed.toLowerCase();
  return trimmed;
}

function normalizeTokenIdsForLookup(
  tokenIds: string[],
  venueList: string[] | null | undefined,
): string[] {
  if (venueList?.length === 1 && venueList[0] === "limitless") {
    return Array.from(
      new Map(
        tokenIds
          .map((tokenId) => normalizeLimitlessScopedTokenId(tokenId))
          .filter((tokenId): tokenId is string => Boolean(tokenId))
          .map((tokenId) => [tokenId, tokenId]),
      ).values(),
    );
  }

  return tokenIds;
}

export async function expandPolymarketWallets(
  pool: Pool,
  inputs: { userId: string; walletAddresses: string[] },
): Promise<string[]> {
  if (inputs.walletAddresses.length === 0) return [];
  const evmWallets = inputs.walletAddresses
    .filter(isEthAddress)
    .map((address) => address.toLowerCase());
  if (evmWallets.length === 0) {
    return Array.from(
      new Map(
        inputs.walletAddresses.map((address) => [
          normalizeWalletKey(address),
          address,
        ]),
      ).values(),
    );
  }
  const { rows } = await pool.query<{
    funder_address: string | null;
    order_wallet: string | null;
  }>(
    `
      with current_funders as (
        select distinct funder_address
        from user_venue_credentials
        where user_id = $1
          and lower(wallet_address) = any($2::text[])
          and venue = 'polymarket'
          and is_active = true
          and funder_address is not null
      ),
      historical_order_wallets as (
        select distinct wallet_address as order_wallet
        from orders
        where user_id = $1
          and venue = 'polymarket'
          and lower(signer_address) = any($2::text[])
          and wallet_address is not null
      )
      select
        current_funders.funder_address,
        null::text as order_wallet
      from current_funders
      union all
      select
        null::text as funder_address,
        historical_order_wallets.order_wallet
      from historical_order_wallets
    `,
    [inputs.userId, evmWallets],
  );

  const merged = new Map<string, string>();
  for (const address of inputs.walletAddresses) {
    const key = normalizeWalletKey(address);
    if (key) merged.set(key, address);
  }
  for (const row of rows) {
    const funder = row.funder_address;
    if (!isEthAddress(funder)) continue;
    const key = normalizeWalletKey(funder);
    if (key) merged.set(key, funder);
  }
  for (const row of rows) {
    const orderWallet = row.order_wallet;
    if (!isEthAddress(orderWallet)) continue;
    const key = normalizeWalletKey(orderWallet);
    if (key) merged.set(key, orderWallet);
  }
  return Array.from(merged.values());
}

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

function parseNumeric(value: string | null | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getPgErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isTransientPgWriteConflict(error: unknown): boolean {
  const code = getPgErrorCode(error);
  return code === "40P01" || code === "40001";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithPositionWriteRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientPgWriteConflict(error) || attempt >= maxAttempts) {
        throw error;
      }
      const delayMs = 50 * attempt + Math.floor(Math.random() * 75);
      console.warn("[positions] retry after transient write conflict", {
        label,
        attempt,
        maxAttempts,
        delayMs,
        code: getPgErrorCode(error),
      });
      await sleep(delayMs);
    }
  }
  throw new Error("position write retry exhausted");
}

function sortTokenIds(tokenIds: string[]): string[] {
  return Array.from(new Set(tokenIds)).sort((a, b) => a.localeCompare(b));
}

function sortTokenBalances(
  balances: WalletTokenBalance[],
): WalletTokenBalance[] {
  return [...balances].sort((a, b) => a.tokenId.localeCompare(b.tokenId));
}

function sortPositionMetrics(
  metrics: PositionMetricsInput["metrics"],
): PositionMetricsInput["metrics"] {
  const byToken = new Map<string, PositionMetricsInput["metrics"][number]>();
  for (const metric of metrics) {
    byToken.set(metric.tokenId, metric);
  }
  return [...byToken.values()].sort((a, b) =>
    a.tokenId.localeCompare(b.tokenId),
  );
}

export async function acquirePositionMutationLock(
  client: PoolClient,
  inputs: PositionMutationLockInput,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `positions:${inputs.userId}:${inputs.venue}`,
  ]);
}

export async function withPositionMutationLock<T>(
  pool: Pool,
  inputs: PositionMutationLockInput,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return runWithPositionWriteRetry(`positions:${inputs.venue}`, () =>
    tx(pool, async (client: PoolClient) => {
      await acquirePositionMutationLock(client, inputs);
      return fn(client);
    }),
  );
}

function resolveVenueList(inputs: {
  venue?: string;
  venues?: string[];
}): string[] {
  return inputs.venues?.length
    ? Array.from(new Set(inputs.venues))
    : inputs.venue
      ? [inputs.venue]
      : SUPPORTED_POSITION_READ_VENUES;
}

export async function resolvePositionReadScope(
  pool: Pool,
  inputs: PositionReadScopeInput,
): Promise<ResolvedPositionReadScope> {
  const venueList = resolveVenueList(inputs);
  const shouldExpandFunders = !venueList || venueList.includes("polymarket");
  const walletAddresses = shouldExpandFunders
    ? await expandPolymarketWallets(pool, {
        userId: inputs.userId,
        walletAddresses: inputs.walletAddresses,
      })
    : inputs.walletAddresses;

  return { walletAddresses, venueList };
}

export const resolvePositionPnlScope = resolvePositionReadScope;

export async function fetchPositionPnlSummaryForResolvedScope(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddresses: string[];
    venueList?: string[];
  },
): Promise<PositionPnlSummary> {
  if (inputs.walletAddresses.length === 0) {
    return {
      openPositionsCount: 0,
      positionsCount: 0,
      realizedPnlAllTime: 0,
      unrealizedCostBasisCurrent: 0,
      unrealizedPnlCurrent: 0,
      unrealizedPnlPercentCurrent: null,
    };
  }

  let whereClause =
    "where p.user_id = $1 and p.wallet_address = any($2::text[]) and p.position_scope = 'own'";
  const params: PgParams = [inputs.userId, inputs.walletAddresses];
  let paramCount = 2;

  if (inputs.venueList?.length) {
    paramCount += 1;
    whereClause += ` and p.venue = any($${paramCount}::text[])`;
    params.push(inputs.venueList);
  }

  const { rows } = await pool.query<PositionPnlSummaryRow>(
    `
      select
        count(*)::text as positions_count,
        count(*) filter (
          where p.side <> 'FLAT'
            and p.size > 0
            and not (${RESOLVED_MARKET_SQL})
        )::text as open_positions_count,
        coalesce(sum(${EFFECTIVE_PNL_SQL}), 0)::text as total_pnl_all_time,
        coalesce(sum(case
          when p.side <> 'FLAT'
            and p.size > 0
            and m.resolved_outcome is null
            and m.resolved_outcome_pct is null
            then ${UNREALIZED_PNL_COMPONENT_SQL}
          else 0
        end), 0)::text as unrealized_pnl_current,
        coalesce(sum(case
          when p.side <> 'FLAT'
            and p.size > 0
            and m.resolved_outcome is null
            and m.resolved_outcome_pct is null
            and p.average_price is not null
            then p.average_price * p.size
          else 0
        end), 0)::text as unrealized_cost_basis_current
      from positions p
      ${POSITION_MARKET_JOIN_SQL}
      ${whereClause}
    `,
    params,
  );

  const row = rows[0];
  const totalPnlAllTime = parseNumeric(row?.total_pnl_all_time);
  const unrealizedPnlCurrent = parseNumeric(row?.unrealized_pnl_current);
  const unrealizedCostBasisCurrent = parseNumeric(
    row?.unrealized_cost_basis_current,
  );
  const realizedPnlAllTime = totalPnlAllTime - unrealizedPnlCurrent;
  const unrealizedPnlPercentCurrent =
    unrealizedCostBasisCurrent > 0
      ? (unrealizedPnlCurrent / unrealizedCostBasisCurrent) * 100
      : null;

  return {
    openPositionsCount: parseNumeric(row?.open_positions_count),
    positionsCount: parseNumeric(row?.positions_count),
    realizedPnlAllTime,
    unrealizedCostBasisCurrent,
    unrealizedPnlCurrent,
    unrealizedPnlPercentCurrent:
      unrealizedPnlPercentCurrent != null &&
      Number.isFinite(unrealizedPnlPercentCurrent)
        ? unrealizedPnlPercentCurrent
        : null,
  };
}

export async function fetchPositionPnlSummaryForUserWallet(
  pool: Pool,
  inputs: PositionPnlScopeInput,
): Promise<PositionPnlSummary> {
  const scope = await resolvePositionReadScope(pool, inputs);
  return fetchPositionPnlSummaryForResolvedScope(pool, {
    userId: inputs.userId,
    walletAddresses: scope.walletAddresses,
    venueList: scope.venueList,
  });
}

export async function fetchPositionsForUserWallet(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddresses: string[];
    venue?: string;
    venues?: string[];
    includeHidden?: boolean;
    minSize?: number;
  },
): Promise<Position[]> {
  const { walletAddresses, venueList } = await resolvePositionReadScope(
    pool,
    inputs,
  );
  if (walletAddresses.length === 0) return [];

  let whereClause =
    "where p.user_id = $1 and p.wallet_address = any($2::text[]) and p.position_scope = 'own'";
  const params: PgParams = [inputs.userId, walletAddresses];
  let paramCount = 2;

  if (!inputs.includeHidden) {
    whereClause += " and (p.is_hidden is null or p.is_hidden = false)";
  }

  if (inputs.minSize != null) {
    paramCount += 1;
    whereClause += ` and p.size >= $${paramCount}`;
    params.push(inputs.minSize);
  }

  if (venueList?.length) {
    paramCount += 1;
    whereClause += ` and p.venue = any($${paramCount}::text[])`;
    params.push(venueList);
  }

  const { rows } = await pool.query<PositionRow>(
    `
      select
        p.id,
        p.user_id,
        p.wallet_address,
        p.venue,
        p.token_id,
        p.side,
        p.size,
        p.average_price,
        case
          when ${RESOLVED_MARKET_SQL} then 0
          else coalesce(p.unrealized_pnl, 0)
        end::text as unrealized_pnl,
        case
          when ${RESOLVED_MARKET_SQL} then ${EFFECTIVE_PNL_SQL}
          else coalesce(p.realized_pnl, 0)
        end::text as realized_pnl,
        p.is_hidden,
        p.hidden_reason,
        p.hidden_at,
        p.last_updated_at,
        p.created_at,
        p.updated_at
      from positions p
      ${POSITION_MARKET_JOIN_SQL}
      ${whereClause}
      order by
        p.last_updated_at desc nulls last,
        p.created_at desc nulls last,
        p.venue asc,
        p.token_id asc,
        p.wallet_address asc,
        p.id asc
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
    venues?: string[];
    includeHidden?: boolean;
    minSize?: number;
  },
): Promise<Position[]> {
  if (inputs.tokenIds.length === 0) return [];
  const { walletAddresses, venueList } = await resolvePositionReadScope(
    pool,
    inputs,
  );
  const tokenIds = normalizeTokenIdsForLookup(inputs.tokenIds, venueList);
  if (tokenIds.length === 0) return [];
  if (walletAddresses.length === 0) return [];

  let whereClause =
    "where p.user_id = $1 and p.wallet_address = any($2::text[]) and p.position_scope = 'own'";
  const params: PgParams = [inputs.userId, walletAddresses];
  let paramCount = 2;

  paramCount += 1;
  whereClause += ` and p.token_id = any($${paramCount}::text[])`;
  params.push(tokenIds);

  if (!inputs.includeHidden) {
    whereClause += " and (p.is_hidden is null or p.is_hidden = false)";
  }

  if (inputs.minSize != null) {
    paramCount += 1;
    whereClause += ` and p.size >= $${paramCount}`;
    params.push(inputs.minSize);
  }

  if (venueList?.length) {
    paramCount += 1;
    whereClause += ` and p.venue = any($${paramCount}::text[])`;
    params.push(venueList);
  }

  const { rows } = await pool.query<PositionRow>(
    `
      select
        p.id,
        p.user_id,
        p.wallet_address,
        p.venue,
        p.token_id,
        p.side,
        p.size,
        p.average_price,
        case
          when ${RESOLVED_MARKET_SQL} then 0
          else coalesce(p.unrealized_pnl, 0)
        end::text as unrealized_pnl,
        case
          when ${RESOLVED_MARKET_SQL} then ${EFFECTIVE_PNL_SQL}
          else coalesce(p.realized_pnl, 0)
        end::text as realized_pnl,
        p.is_hidden,
        p.hidden_reason,
        p.hidden_at,
        p.last_updated_at,
        p.created_at,
        p.updated_at
      from positions p
      ${POSITION_MARKET_JOIN_SQL}
      ${whereClause}
      order by
        p.last_updated_at desc nulls last,
        p.created_at desc nulls last,
        p.venue asc,
        p.token_id asc,
        p.wallet_address asc,
        p.id asc
    `,
    params,
  );

  return rows.map((row) => mapPositionRow(row));
}

export async function setPositionHidden(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: Position["venue"];
    tokenId: string;
    hidden: boolean;
    reason?: string | null;
  },
): Promise<number> {
  const walletAddresses =
    inputs.venue === "polymarket"
      ? await expandPolymarketWallets(pool, {
          userId: inputs.userId,
          walletAddresses: [inputs.walletAddress],
        })
      : [inputs.walletAddress];
  const exactWalletAddresses = walletAddresses.filter(
    (walletAddress) => !isEthAddress(walletAddress),
  );
  const evmWalletAddresses = walletAddresses
    .filter(isEthAddress)
    .map((walletAddress) => walletAddress.toLowerCase());

  return withPositionMutationLock(
    pool,
    { userId: inputs.userId, venue: inputs.venue },
    async (client) => {
      const result = await client.query<{ id: string }>(
        `
          with target as (
            select id
            from positions p
            where user_id = $3
              and venue = $4
              and token_id = $5
              and position_scope = 'own'
              and (
                p.wallet_address = any($6::text[])
                or lower(p.wallet_address) = any($7::text[])
              )
            order by token_id, id
            for update
          )
          update positions p
          set
            is_hidden = $1,
            hidden_reason = $2,
            hidden_at = case when $1 then now() else null end,
            updated_at = now()
          from target
          where p.id = target.id
          returning p.id::text as id
        `,
        [
          inputs.hidden,
          inputs.hidden ? (inputs.reason ?? "user") : null,
          inputs.userId,
          inputs.venue,
          inputs.tokenId,
          exactWalletAddresses,
          evmWalletAddresses,
        ],
      );

      if (inputs.hidden && (result.rowCount ?? 0) > 0) {
        const dedupeKeys = result.rows.map(
          (row) => `position_resolved:${row.id}`,
        );

        await client.query(
          `
            update notifications n
            set
              read_at = coalesce(n.read_at, now()),
              updated_at = now()
            where n.user_id = $1
              and n.type = 'position_resolved'
              and n.dedupe_key = any($2::text[])
          `,
          [inputs.userId, dedupeKeys],
        );
      }

      return result.rowCount ?? 0;
    },
  );
}

export type WalletTokenBalance = {
  tokenId: string;
  size: string;
  averagePrice?: string | null;
};

type PositionScope = "own" | "followed";

export async function markPositionFlatByIdInTx(
  client: PoolClient,
  inputs: { positionId: string; clearAveragePrice?: boolean },
): Promise<number> {
  const result = await client.query(
    `
      with target as (
        select
          p.id,
          case
            when ${MATERIALIZABLE_RESOLVED_POSITION_SQL}
              then ${EFFECTIVE_PNL_SQL}
            else null
          end as resolved_realized_pnl
        from positions p
        ${POSITION_MARKET_JOIN_SQL}
        where p.id = $1
        order by p.token_id, p.id
        for update of p
      )
      update positions p
      set
        side = 'FLAT',
        size = 0,
        average_price = case
          when $2::boolean then null
          else p.average_price
        end,
        realized_pnl = coalesce(target.resolved_realized_pnl, p.realized_pnl),
        unrealized_pnl = case
          when target.resolved_realized_pnl is not null then 0
          else p.unrealized_pnl
        end,
        last_updated_at = now(),
        updated_at = now()
      from target
      where p.id = target.id
    `,
    [inputs.positionId, inputs.clearAveragePrice === true],
  );

  return result.rowCount ?? 0;
}

async function upsertLongPositionsInTx(
  client: PoolClient,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: Position["venue"];
    positionScope: PositionScope;
    positions: WalletTokenBalance[];
    protectRecentFlatsSec?: number;
  },
): Promise<number> {
  if (inputs.positions.length === 0) return 0;

  const tokenIds = inputs.positions.map((p) => p.tokenId);
  const sizes = inputs.positions.map((p) => p.size);
  const averagePrices = inputs.positions.map((p) => p.averagePrice ?? null);
  const protectRecentFlatsSec =
    inputs.protectRecentFlatsSec != null &&
    Number.isFinite(inputs.protectRecentFlatsSec) &&
    inputs.protectRecentFlatsSec > 0
      ? Math.trunc(inputs.protectRecentFlatsSec)
      : 0;

  const result = await client.query(
    `
      insert into positions (
        id,
        user_id,
        wallet_address,
        venue,
        position_scope,
        token_id,
        side,
        size,
        average_price,
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
        $4,
        v.token_id,
        'LONG',
        v.size::numeric,
        v.average_price,
        0,
        0,
        now(),
        now(),
        now()
      from (
        select token_id, size, average_price
        from unnest($5::text[], $6::text[], $7::numeric[]) as v(token_id, size, average_price)
        order by token_id
      ) as v
      on conflict on constraint positions_user_id_wallet_address_venue_token_id_key
      do update set
        side = 'LONG',
        size = excluded.size,
        average_price = coalesce(excluded.average_price, positions.average_price),
        position_scope = case
          when positions.position_scope = 'own' or excluded.position_scope = 'own'
            then 'own'
          else 'followed'
        end,
        last_updated_at = case
          when positions.side is distinct from 'LONG'
            or positions.size is distinct from excluded.size
            then now()
          else positions.last_updated_at
        end,
        updated_at = now()
      where not (
        $8::int > 0
        and positions.last_updated_at > now() - ($8::int * interval '1 second')
        and (
          (
            positions.side = 'FLAT'
            and positions.size = 0
            and excluded.size > 0
          )
          or (
            positions.side = 'LONG'
            and positions.size > excluded.size
            and excluded.size > 0
          )
        )
      )
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.venue,
      inputs.positionScope,
      tokenIds,
      sizes,
      averagePrices,
      protectRecentFlatsSec,
    ],
  );

  return result.rowCount ?? 0;
}

async function markMissingPositionsFlatInTx(
  client: PoolClient,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: Position["venue"];
    positionScope: PositionScope;
    heldTokenIds: string[];
    tokenIdLike?: string;
    flattenGraceSec?: number;
  },
): Promise<number> {
  const walletClause = isEthAddress(inputs.walletAddress)
    ? "lower(p.wallet_address) = lower($2)"
    : "p.wallet_address = $2";
  let whereClause = `where p.user_id = $1 and ${walletClause} and p.venue = $3`;
  const params: PgParams = [inputs.userId, inputs.walletAddress, inputs.venue];
  let paramCount = 3;

  paramCount += 1;
  whereClause += ` and p.position_scope = $${paramCount}`;
  params.push(inputs.positionScope);

  if (inputs.tokenIdLike) {
    paramCount += 1;
    whereClause += ` and p.token_id like $${paramCount}`;
    params.push(inputs.tokenIdLike);
  }

  paramCount += 1;
  whereClause += ` and not (p.token_id = any($${paramCount}::text[]))`;
  params.push(inputs.heldTokenIds);

  if (
    inputs.flattenGraceSec != null &&
    Number.isFinite(inputs.flattenGraceSec) &&
    inputs.flattenGraceSec > 0
  ) {
    paramCount += 1;
    whereClause += ` and p.last_updated_at < now() - ($${paramCount} * interval '1 second')`;
    params.push(Math.trunc(inputs.flattenGraceSec));
  }

  whereClause += " and (p.side <> 'FLAT' or p.size <> 0)";
  whereClause += " and not (p.is_hidden = true and p.hidden_reason = 'auto_lost')";

  const result = await client.query(
    `
      with target as (
        select
          p.id,
          case
            when ${MATERIALIZABLE_RESOLVED_POSITION_SQL}
              then ${EFFECTIVE_PNL_SQL}
            else null
          end as resolved_realized_pnl
        from positions p
        ${POSITION_MARKET_JOIN_SQL}
        ${whereClause}
        order by p.token_id, p.id
        for update of p
      )
      update positions p
      set
        side = 'FLAT',
        size = 0,
        realized_pnl = coalesce(target.resolved_realized_pnl, p.realized_pnl),
        unrealized_pnl = case
          when target.resolved_realized_pnl is not null then 0
          else p.unrealized_pnl
        end,
        last_updated_at = now(),
        updated_at = now()
      from target
      where p.id = target.id
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
    positionScope?: PositionScope;
    tokenBalances: WalletTokenBalance[];
    tokenIdLike?: string;
    flattenGraceSec?: number;
    protectRecentFlatsSec?: number;
  },
): Promise<SyncWalletPositionsResult> {
  const positionScope: PositionScope = inputs.positionScope ?? "own";
  const filteredTokenBalances = inputs.tokenBalances.filter((balance) => {
    const parsed = Number(balance.size);
    return Number.isFinite(parsed) && parsed >= MIN_POSITION_SIZE;
  });
  const heldTokenIds = sortTokenIds(
    filteredTokenBalances.map((b) => b.tokenId),
  );

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
  const knownTokenBalances = sortTokenBalances(
    filteredTokenBalances.filter((b) => knownSet.has(b.tokenId)),
  );

  const result = await withPositionMutationLock(
    pool,
    { userId: inputs.userId, venue: inputs.venue },
    async (client: PoolClient) => {
      const upsertedPositions = await upsertLongPositionsInTx(client, {
        userId: inputs.userId,
        walletAddress: inputs.walletAddress,
        venue: inputs.venue,
        positionScope,
        positions: knownTokenBalances,
        protectRecentFlatsSec: inputs.protectRecentFlatsSec,
      });

      const flattenedPositions = await markMissingPositionsFlatInTx(client, {
        userId: inputs.userId,
        walletAddress: inputs.walletAddress,
        venue: inputs.venue,
        positionScope,
        heldTokenIds,
        tokenIdLike: inputs.tokenIdLike,
        flattenGraceSec: inputs.flattenGraceSec,
      });

      return { upsertedPositions, flattenedPositions };
    },
  );

  return {
    heldTokens: heldTokenIds.length,
    knownTokens: knownTokenBalances.length,
    upsertedPositions: result.upsertedPositions,
    flattenedPositions: result.flattenedPositions,
  };
}

export async function updatePositionMetrics(
  pool: Pool,
  inputs: PositionMetricsInput,
): Promise<void> {
  if (inputs.metrics.length === 0) return;

  await withPositionMutationLock(
    pool,
    { userId: inputs.userId, venue: inputs.venue },
    async (client) => updatePositionMetricsInTx(client, inputs),
  );
}

export async function updatePositionMetricsInTx(
  client: PoolClient,
  inputs: PositionMetricsInput,
): Promise<void> {
  const metrics = sortPositionMetrics(inputs.metrics);
  if (metrics.length === 0) return;

  const tokenIds = metrics.map((metric) => metric.tokenId);
  const averagePrices = metrics.map((metric) => metric.averagePrice);
  const realizedPnls = metrics.map((metric) => metric.realizedPnl);
  const unrealizedPnls = metrics.map((metric) => metric.unrealizedPnl);

  await client.query(
    `
      with metric_values as (
        select
          token_id,
          average_price,
          realized_pnl,
          unrealized_pnl
        from unnest(
          $1::text[],
          $2::numeric[],
          $3::numeric[],
          $4::numeric[]
        ) as v(token_id, average_price, realized_pnl, unrealized_pnl)
        order by token_id
      ),
      target as (
        select
          p.id,
          v.average_price,
          v.realized_pnl,
          v.unrealized_pnl,
          (${RESOLVED_MARKET_SQL}) as resolved_position
        from positions p
        join metric_values v
          on v.token_id = p.token_id
        ${POSITION_MARKET_JOIN_SQL}
        where p.user_id = $5
          and (p.wallet_address is null or p.wallet_address = $6)
          and p.venue = $7
          and p.position_scope = 'own'
        order by p.token_id, p.id
        for update of p
      )
      update positions p
      set
        average_price = case
          when target.average_price is not null then target.average_price
          when p.size > 0 then p.average_price
          else null
        end,
        realized_pnl = case
          when p.side = 'FLAT'
            and p.size <= 0
            and target.resolved_position
            and coalesce(p.realized_pnl, 0) <> 0
            and coalesce(target.realized_pnl, 0) = 0
            then p.realized_pnl
          else target.realized_pnl
        end,
        unrealized_pnl = target.unrealized_pnl,
        updated_at = now()
      from target
      where p.id = target.id
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
