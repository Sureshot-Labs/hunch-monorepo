import type { Pool } from "@hunch/infra";
import type { PgParams } from "../server-types.js";

export type UnifiedOrderRow = {
  id: string;
  kind: "order" | "swap";
  venue: string;
  wallet_address: string | null;
  venue_order_id: string | null;
  token_id: string | null;
  side: string | null;
  outcome: string | null;
  order_type: string | null;
  price: string | null;
  size: string | null;
  status: string | null;
  filled_size: string | null;
  average_fill_price: string | null;
  expires_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  filled_at: Date | null;
  cancelled_at: Date | null;
  unified_market_id: string | null;
  input_mint: string | null;
  output_mint: string | null;
  amount_in: string | null;
  amount_out: string | null;
  input_decimals: string | null;
  output_decimals: string | null;
  tx_signature: string | null;
};

type FilterInputs = {
  userId: string;
  walletAddresses: string[];
  venue?: string;
  status?: string | string[];
  openOnly?: boolean;
  marketId?: string;
  marketIds?: string[];
  tokenId?: string;
};

type FetchUnifiedOrdersInputs = FilterInputs & {
  type?: "order" | "swap";
  limit: number;
  offset: number;
};

type FilterParams = {
  params: PgParams;
  venueIndex?: number;
  statusIndex?: number;
  marketListIndex?: number;
  tokenIndex?: number;
};

const buildFilterParams = (inputs: FilterInputs): FilterParams => {
  const params: PgParams = [inputs.userId, inputs.walletAddresses];
  let paramCount = 2;
  let venueIndex: number | undefined;
  let statusIndex: number | undefined;

  if (inputs.venue) {
    paramCount += 1;
    venueIndex = paramCount;
    params.push(inputs.venue);
  }

  const statusList = Array.isArray(inputs.status)
    ? inputs.status.filter(Boolean)
    : typeof inputs.status === "string" && inputs.status.trim()
      ? [inputs.status.trim()]
      : undefined;
  if (statusList?.length) {
    paramCount += 1;
    statusIndex = paramCount;
    params.push(statusList);
  }

  const normalizedMarketIds = inputs.marketIds?.length
    ? inputs.marketIds
    : inputs.marketId
      ? [inputs.marketId]
      : undefined;
  let marketListIndex: number | undefined;
  if (normalizedMarketIds?.length) {
    paramCount += 1;
    marketListIndex = paramCount;
    params.push(normalizedMarketIds);
  }

  let tokenIndex: number | undefined;
  if (inputs.tokenId) {
    paramCount += 1;
    tokenIndex = paramCount;
    params.push(inputs.tokenId);
  }

  return { params, venueIndex, statusIndex, marketListIndex, tokenIndex };
};

const buildWhereClause = (
  alias: string,
  filterParams: FilterParams,
  includeSigner: boolean,
  columns: { market?: string; token?: string } = {},
): string => {
  const normalizedWalletExpr = `case when ${alias}.wallet_address like '0x%' then lower(${alias}.wallet_address) else ${alias}.wallet_address end`;
  const normalizedSignerExpr = `case when ${alias}.signer_address like '0x%' then lower(${alias}.signer_address) else ${alias}.signer_address end`;
  const walletClause = includeSigner
    ? `((${alias}.wallet_address is not null and ${normalizedWalletExpr} = ANY($2::text[])) or (${alias}.wallet_address is null and ${normalizedSignerExpr} = ANY($2::text[])))`
    : `(${alias}.wallet_address is null or ${normalizedWalletExpr} = ANY($2::text[]))`;
  const conditions = [`${alias}.user_id = $1`, walletClause];

  if (filterParams.venueIndex) {
    conditions.push(`${alias}.venue = $${filterParams.venueIndex}`);
  }

  if (filterParams.statusIndex) {
    conditions.push(`${alias}.status = ANY($${filterParams.statusIndex}::text[])`);
  }

  if (filterParams.marketListIndex && columns.market) {
    conditions.push(
      `${columns.market} = ANY($${filterParams.marketListIndex}::text[])`,
    );
  }

  if (filterParams.tokenIndex && columns.token) {
    conditions.push(`${columns.token} = $${filterParams.tokenIndex}`);
  }

  return `where ${conditions.join(" and ")}`;
};

const buildOrdersSelect = (whereClause: string): string => `
  select
    o.id::text as id,
    'order'::text as kind,
    o.venue,
    o.wallet_address,
    o.venue_order_id,
    o.token_id,
    o.side,
    null::text as outcome,
    o.order_type,
    o.price::text as price,
    o.size::text as size,
    o.status,
    o.filled_size::text as filled_size,
    o.average_fill_price::text as average_fill_price,
    o.expires_at,
    o.posted_at as created_at,
    o.last_update as updated_at,
    o.filled_at,
    o.cancelled_at,
    o.market_id as unified_market_id,
    null::text as input_mint,
    null::text as output_mint,
    null::text as amount_in,
    null::text as amount_out,
    null::text as input_decimals,
    null::text as output_decimals,
    null::text as tx_signature
  from (
    select
      o.*,
      ut.market_id,
      row_number() over (
        partition by o.user_id, o.venue, o.venue_order_id
        order by
          (o.price is not null)::int desc,
          (o.size is not null)::int desc,
          (o.order_payload is not null)::int desc,
          posted_at desc nulls last,
          id desc
      ) as row_rank
    from orders o
    left join unified_tokens ut
      on ut.token_id = o.token_id
      and ut.venue = o.venue
    ${whereClause}
  ) o
  where o.row_rank = 1
`;

const buildExecutionsSelect = (whereClause: string): string => `
  select
    e.id::text as id,
    'swap'::text as kind,
    e.venue,
    e.wallet_address,
    e.venue_order_id,
    null::text as token_id,
    e.side,
    e.outcome,
    null::text as order_type,
    null::text as price,
    null::text as size,
    e.status,
    null::text as filled_size,
    null::text as average_fill_price,
    null::timestamptz as expires_at,
    e.created_at,
    e.updated_at,
    null::timestamptz as filled_at,
    null::timestamptz as cancelled_at,
    e.unified_market_id,
    e.input_mint,
    e.output_mint,
    e.amount_in::text as amount_in,
    e.amount_out::text as amount_out,
    e.input_decimals::text as input_decimals,
    e.output_decimals::text as output_decimals,
    e.tx_signature
  from executions e
  ${whereClause}
`;

export async function fetchUnifiedOrders(
  pool: Pool,
  inputs: FetchUnifiedOrdersInputs,
): Promise<{ rows: UnifiedOrderRow[]; total: number }> {
  const includeOrders = inputs.type !== "swap";
  const includeSwaps = inputs.type !== "order" && !inputs.tokenId;

  if (!includeOrders && !includeSwaps) {
    return { rows: [], total: 0 };
  }

  const filterParams = buildFilterParams(inputs);
  const baseOrderWhere = buildWhereClause("o", filterParams, true, {
    market: "ut.market_id",
    token: "o.token_id",
  });
  const orderWhere = inputs.openOnly
    ? `${baseOrderWhere} and o.cancelled_at is null and (o.size is null or o.filled_size is null or o.filled_size < o.size) and coalesce(o.order_type, '') not in ('FOK', 'FAK')`
    : baseOrderWhere;
  const execWhere = buildWhereClause("e", filterParams, false, {
    market: "e.unified_market_id",
  });

  const selects: string[] = [];
  if (includeOrders) selects.push(buildOrdersSelect(orderWhere));
  if (includeSwaps) selects.push(buildExecutionsSelect(execWhere));

  const unionSql =
    selects.length === 1 ? selects[0] : selects.join(" union all ");

  const params = [...filterParams.params];
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;
  params.push(inputs.limit, inputs.offset);

  const { rows } = await pool.query<UnifiedOrderRow>(
    `
      with combined as (
        ${unionSql}
      )
      select *
      from combined
      order by created_at desc nulls last, id desc
      limit $${limitIndex} offset $${offsetIndex}
    `,
    params,
  );

  const countResult = await pool.query<{ total: string }>(
    `
      with combined as (
        ${unionSql}
      )
      select count(*) as total
      from combined
    `,
    filterParams.params,
  );

  return {
    rows,
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

export async function fetchUnifiedOrderById(
  pool: Pool,
  inputs: FilterInputs & { id: string },
): Promise<UnifiedOrderRow | null> {
  const filterParams = buildFilterParams(inputs);
  const orderWhere = buildWhereClause("o", filterParams, true);
  const execWhere = buildWhereClause("e", filterParams, false);

  const params = [...filterParams.params];
  const idIndex = params.length + 1;
  params.push(inputs.id);

  const { rows } = await pool.query<UnifiedOrderRow>(
    `
      with combined as (
        ${buildOrdersSelect(orderWhere)} and o.id::text = $${idIndex}
        union all
        ${buildExecutionsSelect(execWhere)} and e.id::text = $${idIndex}
      )
      select *
      from combined
      order by created_at desc nulls last, id desc
      limit 1
    `,
    params,
  );

  return rows[0] ?? null;
}
