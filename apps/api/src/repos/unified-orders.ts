import type { Pool } from "@hunch/infra";
import { hip4Identity, parseHip4Coin } from "@hunch/shared";
import { hip4AccountExecutionSchema } from "../schemas/hip4-account.js";
import { hip4OpenOrderSchema } from "../services/hip4-open-orders.js";
import { nativeHip4OrderReadSchema } from "../schemas/orders.js";
import {
  HIP4_NATIVE_ORDER_READ_JOINS,
  HIP4_NATIVE_ORDER_FILLED_SIZE,
  HIP4_NATIVE_ORDER_READ_FACTS,
  HIP4_OBSERVED_ORDER_NOT_NATIVE,
} from "./hip4-native-order-read.js";
import type { PgParams } from "../server-types.js";
import {
  polymarketOrderBindingJoinSql,
  polymarketOrderMarketIdSql,
  polymarketOrderOutcomeSideSql,
} from "../lib/polymarket-order-ledger-sql.js";

const ORDER_MARKET_ID_SQL = polymarketOrderMarketIdSql("o", "ut.market_id");
const ORDER_MARKET_JOIN_SQL = `
  ${polymarketOrderBindingJoinSql("o")}
  left join unified_tokens ut on ut.token_id = o.token_id and ut.venue = o.venue
`;

export type UnifiedOrderRow = {
  id: string;
  kind: "order" | "swap" | "execution" | "observed_order";
  observed_execution?: unknown;
  native_order?: unknown;
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
  error_message: string | null;
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
  walletAddresses?: string[];
  q?: string;
  venue?: string;
  status?: string | string[];
  openOnly?: boolean;
  marketId?: string;
  marketIds?: string[];
  tokenId?: string;
  from?: Date | string;
  to?: Date | string;
  // Server-only effective accountRead capability. Never a client parameter.
  includeObservedHip4?: boolean;
  hip4OpenOrderMaxAgeMs?: number;
};

type FetchUnifiedOrdersInputs = FilterInputs & {
  type?: "order" | "swap" | "execution";
  limit: number;
  offset: number;
};

type FilterParams = {
  params: PgParams;
  walletIndex?: number;
  venueIndex?: number;
  statusIndex?: number;
  marketListIndex?: number;
  tokenIndex?: number;
  fromIndex?: number;
  toIndex?: number;
  qIndex?: number;
  openOrderAgeIndex?: number;
};

const escapeSqlLikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, "\\$&");

const buildFilterParams = (inputs: FilterInputs): FilterParams => {
  const params: PgParams = [inputs.userId];
  let paramCount = 1;
  let walletIndex: number | undefined;
  let venueIndex: number | undefined;
  let statusIndex: number | undefined;

  const walletAddresses = inputs.walletAddresses?.filter(Boolean);
  if (walletAddresses?.length) {
    paramCount += 1;
    walletIndex = paramCount;
    params.push(
      walletAddresses.map((address) => {
        const trimmed = address.trim();
        return /^0x/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
      }),
    );
  }

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

  let fromIndex: number | undefined;
  if (inputs.from) {
    paramCount += 1;
    fromIndex = paramCount;
    params.push(
      inputs.from instanceof Date ? inputs.from : new Date(inputs.from),
    );
  }

  let toIndex: number | undefined;
  if (inputs.to) {
    paramCount += 1;
    toIndex = paramCount;
    params.push(inputs.to instanceof Date ? inputs.to : new Date(inputs.to));
  }

  let qIndex: number | undefined;
  const q = inputs.q?.trim();
  if (q) {
    paramCount += 1;
    qIndex = paramCount;
    params.push(`%${escapeSqlLikePattern(q)}%`);
  }

  let openOrderAgeIndex: number | undefined;
  if (inputs.hip4OpenOrderMaxAgeMs != null) {
    openOrderAgeIndex = ++paramCount;
    params.push(inputs.hip4OpenOrderMaxAgeMs);
  }

  return {
    params,
    walletIndex,
    venueIndex,
    statusIndex,
    marketListIndex,
    tokenIndex,
    fromIndex,
    toIndex,
    qIndex,
    openOrderAgeIndex,
  };
};

const buildWhereClause = (
  alias: string,
  filterParams: FilterParams,
  includeSigner: boolean,
  columns: {
    market?: string;
    token?: string;
    createdAt?: string;
    status?: string;
  } = {},
): string => {
  const normalizedWalletExpr = `case when ${alias}.wallet_address like '0x%' then lower(${alias}.wallet_address) else ${alias}.wallet_address end`;
  const normalizedSignerExpr = `case when ${alias}.signer_address like '0x%' then lower(${alias}.signer_address) else ${alias}.signer_address end`;
  const conditions = [`${alias}.user_id = $1`];

  if (filterParams.walletIndex) {
    const walletClause = includeSigner
      ? `((${alias}.wallet_address is not null and ${normalizedWalletExpr} = ANY($${filterParams.walletIndex}::text[])) or (${alias}.signer_address is not null and ${normalizedSignerExpr} = ANY($${filterParams.walletIndex}::text[])))`
      : `(${alias}.wallet_address is null or ${normalizedWalletExpr} = ANY($${filterParams.walletIndex}::text[]))`;
    conditions.push(walletClause);
  }

  if (filterParams.venueIndex) {
    conditions.push(`${alias}.venue = $${filterParams.venueIndex}`);
  }

  if (filterParams.statusIndex) {
    conditions.push(
      `${columns.status ?? `${alias}.status`} = ANY($${filterParams.statusIndex}::text[])`,
    );
  }

  if (filterParams.marketListIndex && columns.market) {
    conditions.push(
      `${columns.market} = ANY($${filterParams.marketListIndex}::text[])`,
    );
  }

  if (filterParams.tokenIndex && columns.token) {
    conditions.push(`${columns.token} = $${filterParams.tokenIndex}`);
  }

  if (filterParams.fromIndex && columns.createdAt) {
    conditions.push(
      `${columns.createdAt} >= $${filterParams.fromIndex}::timestamptz`,
    );
  }

  if (filterParams.toIndex && columns.createdAt) {
    conditions.push(
      `${columns.createdAt} <= $${filterParams.toIndex}::timestamptz`,
    );
  }

  if (filterParams.qIndex && columns.market) {
    conditions.push(`
      exists (
        select 1
        from unified_markets search_market
        left join unified_events search_event
          on search_event.id = search_market.event_id
        where search_market.id = ${columns.market}
          and (
            coalesce(search_market.title, '') ilike $${filterParams.qIndex} escape '\\'
            or coalesce(search_event.title, '') ilike $${filterParams.qIndex} escape '\\'
            or coalesce(search_market.outcomes::text, '') ilike $${filterParams.qIndex} escape '\\'
            or coalesce(search_market.id, '') ilike $${filterParams.qIndex} escape '\\'
            or coalesce(search_market.event_id, '') ilike $${filterParams.qIndex} escape '\\'
          )
      )
    `);
  }

  return `where ${conditions.join(" and ")}`;
};

const toNumber = (value: string | null): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const mapUnifiedOrder = (row: UnifiedOrderRow) => {
  if (row.kind === "observed_order") {
    const facts = hip4OpenOrderSchema.parse(row.observed_execution);
    const parsed = parseHip4Coin(facts.coin);
    const identity = hip4Identity("mainnet", parsed.outcome);
    if (
      facts.marketId !== identity.marketId ||
      facts.tokenId !== identity.sides[parsed.sideIndex].tokenId
    )
      throw new Error("observed_order_identity_conflict");
    if (!row.updated_at || !row.expires_at)
      throw new Error("observed_order_missing_provenance");
    return {
      id: row.id,
      kind: "observed_order" as const,
      venue: "hyperliquid" as const,
      walletAddress: row.wallet_address,
      venueOrderId: facts.orderId,
      tokenId: facts.tokenId,
      outcome: parsed.sideIndex === 0 ? "YES" : "NO",
      side: facts.side === "B" ? "BUY" : "SELL",
      orderType: facts.orderType,
      price: toNumber(facts.price),
      size: toNumber(facts.originalQuantity),
      filledSize: toNumber(facts.filledQuantity),
      averageFillPrice: null,
      status: "observed_open",
      statusReason: null,
      createdAt: new Date(facts.time).toISOString(),
      updatedAt: row.updated_at,
      expiresAt: null,
      cancelledAt: null,
      filledAt: null,
      unifiedMarketId: facts.marketId,
      actionRef: null,
      observedOrder: {
        ...facts,
        observedAt: row.updated_at.toISOString(),
        validUntil: row.expires_at.toISOString(),
      },
    };
  }
  if (row.kind === "execution") {
    const facts = hip4AccountExecutionSchema.parse(row.observed_execution);
    const parsed = parseHip4Coin(facts.coin);
    const identity = hip4Identity("mainnet", parsed.outcome);
    if (identity.marketId !== facts.marketId)
      throw new Error("observed_execution_identity_conflict");
    return {
      id: row.id,
      kind: "execution" as const,
      venue: "hyperliquid" as const,
      walletAddress: row.wallet_address,
      venueOrderId: facts.orderId,
      tokenId: identity.sides[parsed.sideIndex].tokenId,
      side:
        facts.kind === "Buy" ? "BUY" : facts.kind === "Sell" ? "SELL" : null,
      outcome: parsed.sideIndex === 0 ? "YES" : "NO",
      orderType: null,
      // No inference of original order size, remaining size or order status.
      size: null,
      price: null,
      filledSize: toNumber(facts.quantity),
      averageFillPrice: toNumber(facts.price),
      status: "observed",
      statusReason: null,
      createdAt: new Date(facts.time).toISOString(),
      filledAt: new Date(facts.time).toISOString(),
      updatedAt: null,
      expiresAt: null,
      cancelledAt: null,
      unifiedMarketId: facts.marketId,
      txSignature: facts.transactionHash,
      execution: facts,
      actionRef: null,
    };
  }
  return {
    id: row.id,
    kind: row.kind,
    venue: row.venue,
    walletAddress: row.wallet_address,
    venueOrderId: row.venue_order_id,
    tokenId: row.token_id,
    side: row.side,
    outcome: row.outcome,
    orderType: row.order_type,
    price: toNumber(row.price),
    size: toNumber(row.size),
    status: row.status,
    statusReason: row.error_message,
    filledSize: toNumber(row.filled_size),
    averageFillPrice: toNumber(row.average_fill_price),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    filledAt: row.filled_at,
    cancelledAt: row.cancelled_at,
    unifiedMarketId: row.unified_market_id,
    inputMint: row.input_mint,
    outputMint: row.output_mint,
    amountIn: toNumber(row.amount_in),
    amountOut: toNumber(row.amount_out),
    inputDecimals: toNumber(row.input_decimals),
    outputDecimals: toNumber(row.output_decimals),
    txSignature: row.tx_signature,
    ...(row.native_order == null
      ? {}
      : {
          nativeOrder: nativeHip4OrderReadSchema.parse(row.native_order),
        }),
  };
};

export async function fetchUnifiedMarketIdsByEventId(
  pool: Pool,
  eventId: string | undefined,
): Promise<string[]> {
  if (!eventId) return [];
  const { rows } = await pool.query<{ id: string }>(
    `
      select id
      from unified_markets
      where event_id = $1
    `,
    [eventId],
  );
  return rows.map((row) => row.id);
}

const orderReadProjection = (native = false): string => `
  select
    o.id::text as id,
    'order'::text as kind,
    o.venue,
    o.wallet_address,
    o.venue_order_id,
    o.token_id,
    o.side,
    o.resolved_outcome_side as outcome,
    o.order_type,
    o.price::text as price,
    o.size::text as size,
    ${native ? "o.read_status as status" : "o.status"},
    ${native ? "o.observed_filled_size" : "o.filled_size"}::text as filled_size,
    o.average_fill_price::text as average_fill_price,
    o.error_message,
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
    null::text as tx_signature,
    null::jsonb as observed_execution,
    ${native ? "o.native_order" : "null::jsonb as native_order"}
`;
const buildOrdersSelect = (whereClause: string): string => `
  ${orderReadProjection()}
  from (
    select
      o.*,
      ${ORDER_MARKET_ID_SQL} as market_id,
      case when o.venue = 'polymarket' then ${polymarketOrderOutcomeSideSql("o", "upper(ut.side)")} else null end as resolved_outcome_side,
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
    ${ORDER_MARKET_JOIN_SQL}
    ${whereClause}
  ) o
  where o.row_rank = 1
`;

const buildNativeOrdersSelect = (whereClause: string): string => `
  ${orderReadProjection(true)}
  from (
    select o.*,native_action.canonical_market_id as market_id,
      case when right(native_action.token_id,1)='0' then 'YES' else 'NO' end as resolved_outcome_side,
      native_state.display_status as read_status,
      ${HIP4_NATIVE_ORDER_FILLED_SIZE} as observed_filled_size,
      ${HIP4_NATIVE_ORDER_READ_FACTS} as native_order
    from orders o ${HIP4_NATIVE_ORDER_READ_JOINS}
    ${whereClause} and o.venue='hyperliquid' and native_action.environment='mainnet'
  ) o
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
    null::text as error_message,
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
    e.tx_signature,
    null::jsonb as observed_execution,
    null::jsonb as native_order
  from executions e
  ${whereClause}
`;

// The immutable provider journal is read in place, not copied into mutable
// Hunch orders. Current verified ownership, active user and exact environment
// remain necessary even for previously captured records.
const buildObservedHip4Select = (
  filters: FilterParams,
  pageBound?: string,
  openOrders = false,
): string => {
  if (!filters.walletIndex)
    throw new Error("observed_execution_wallet_scope_required");
  const conditions = [
    "e.environment='mainnet'",
    `e.account_address=any($${filters.walletIndex}::text[])`,
    `exists (select 1 from user_wallets wallet_row
      join users owner_row on owner_row.id=wallet_row.user_id and owner_row.is_active
      where wallet_row.user_id=$1 and wallet_row.is_verified
        and wallet_row.wallet_type='ethereum'
        and lower(wallet_row.wallet_address)=e.account_address)`,
  ];
  if (openOrders) conditions.push(HIP4_OBSERVED_ORDER_NOT_NATIVE);
  if (filters.venueIndex)
    conditions.push(`$${filters.venueIndex}::text='hyperliquid'`);
  if (filters.statusIndex)
    conditions.push(
      `'${openOrders ? "open" : "observed"}'=any($${filters.statusIndex}::text[])`,
    );
  if (filters.marketListIndex)
    conditions.push(
      `e.canonical_market_id=any($${filters.marketListIndex}::text[])`,
    );
  if (filters.tokenIndex)
    conditions.push(
      `('hyperliquid:mainnet:' || substring(e.coin from 2))=$${filters.tokenIndex}`,
    );
  if (filters.fromIndex)
    conditions.push(
      `e.time_ms>=extract(epoch from $${filters.fromIndex}::timestamptz)*1000`,
    );
  if (filters.toIndex)
    conditions.push(
      `e.time_ms<=extract(epoch from $${filters.toIndex}::timestamptz)*1000`,
    );
  if (filters.qIndex)
    conditions.push(`exists (
    select 1 from unified_markets search_market
    left join unified_events search_event on search_event.id=search_market.event_id
    where search_market.id=e.canonical_market_id and (
      coalesce(search_market.title,'') ilike $${filters.qIndex} escape '\\'
      or coalesce(search_event.title,'') ilike $${filters.qIndex} escape '\\'
      or coalesce(search_market.outcomes::text,'') ilike $${filters.qIndex} escape '\\'
      or search_market.id ilike $${filters.qIndex} escape '\\'
      or search_market.event_id ilike $${filters.qIndex} escape '\\'))`);
  // At most offset+limit candidates per verified owner can contribute to the
  // global page. Order by raw indexed time before materializing the union.
  // Count retains its exact legacy meaning; it is not a page-size estimate.
  if (openOrders && !filters.openOrderAgeIndex)
    throw new Error("observed_order_freshness_required");
  const nativeSource = openOrders
    ? `(with snapshot_scope as materialized (
    select snapshot_row.environment, snapshot_row.account_address,
      snapshot_row.history->'openOrders'->'items' as items,
      (snapshot_row.history->'openOrders'->>'observedAt')::timestamptz as observation_time
    from hip4_account_snapshots snapshot_row
    where snapshot_row.environment='mainnet'
      and snapshot_row.account_address=any($${filters.walletIndex}::text[])
      and exists (select 1 from user_wallets wallet_row join users owner_row on owner_row.id=wallet_row.user_id and owner_row.is_active
        where wallet_row.user_id=$1 and wallet_row.is_verified and wallet_row.wallet_type='ethereum'
          and lower(wallet_row.wallet_address)=snapshot_row.account_address)
      and snapshot_row.history->'openOrders'->>'version'='1'
      and (snapshot_row.history->'openOrders'->>'observedAt')::timestamptz<=statement_timestamp()
      and (snapshot_row.history->'openOrders'->>'observedAt')::timestamptz
        > statement_timestamp()-$${filters.openOrderAgeIndex} * interval '1 millisecond')
    select snapshot_row.environment, snapshot_row.account_address,
    (order_item->>'time')::bigint as time_ms, order_item->>'coin' as coin,
    order_item->>'orderId' as oid, order_item->>'marketId' as canonical_market_id,
    order_item || jsonb_build_object('id',snapshot_row.account_address || ':' || (order_item->>'orderId')) as execution,
    snapshot_row.observation_time,
    snapshot_row.observation_time + $${filters.openOrderAgeIndex} * interval '1 millisecond' as valid_until
    from snapshot_scope snapshot_row
    cross join lateral jsonb_array_elements(case when jsonb_typeof(snapshot_row.items)='array'
      then snapshot_row.items else '[]'::jsonb end) order_item)`
    : "hip4_account_executions";
  const source = pageBound
    ? `(select selected_fill.* from (
    select distinct lower(wallet_row.wallet_address) as account_address
    from user_wallets wallet_row join users owner_row
      on owner_row.id=wallet_row.user_id and owner_row.is_active
    where wallet_row.user_id=$1 and wallet_row.is_verified and wallet_row.wallet_type='ethereum'
      and lower(wallet_row.wallet_address)=any($${filters.walletIndex}::text[])
    ) owned_scope cross join lateral (
      select e.* from ${nativeSource} e
      where e.account_address=owned_scope.account_address and ${conditions.join(" and ")}
      order by e.time_ms desc, (e.execution->>'id') desc limit ${pageBound}
    ) selected_fill) e`
    : `${nativeSource} e where ${conditions.join(" and ")}`;
  return `select
    '${openOrders ? "hyperliquid:order:" : "hyperliquid:"}' || (e.execution->>'id') as id,
    '${openOrders ? "observed_order" : "execution"}'::text as kind, 'hyperliquid'::text as venue,
    e.account_address as wallet_address, e.oid::text as venue_order_id,
    'hyperliquid:mainnet:' || substring(e.coin from 2) as token_id,
    null::text as side, null::text as outcome, null::text as order_type,
    null::text as price, null::text as size, '${openOrders ? "observed_open" : "observed"}'::text as status,
    null::text as filled_size, null::text as average_fill_price,
    null::text as error_message, ${openOrders ? "e.valid_until" : "null::timestamptz"} as expires_at,
    to_timestamp(e.time_ms::double precision/1000) as created_at,
    ${openOrders ? "e.observation_time" : "null::timestamptz"} as updated_at, null::timestamptz as filled_at,
    null::timestamptz as cancelled_at, e.canonical_market_id as unified_market_id,
    null::text as input_mint, null::text as output_mint,
    null::text as amount_in, null::text as amount_out,
    null::text as input_decimals, null::text as output_decimals,
    null::text as tx_signature, ${openOrders ? "e.execution - 'id'" : "e.execution"} as observed_execution,
    null::jsonb as native_order
    from ${source}`;
};

export async function fetchUnifiedOrders(
  pool: Pool,
  inputs: FetchUnifiedOrdersInputs,
): Promise<{ rows: UnifiedOrderRow[]; total: number }> {
  const includeOrders =
    inputs.venue !== "hyperliquid" &&
    inputs.type !== "swap" &&
    inputs.type !== "execution";
  const includeNativeOrders =
    (!inputs.venue || inputs.venue === "hyperliquid") &&
    inputs.type !== "swap" &&
    inputs.type !== "execution";
  const includeSwaps =
    inputs.venue !== "hyperliquid" &&
    inputs.type !== "order" &&
    inputs.type !== "execution" &&
    !inputs.tokenId;
  const includeObserved =
    inputs.includeObservedHip4 === true &&
    (inputs.openOnly
      ? inputs.hip4OpenOrderMaxAgeMs != null
      : !inputs.type || inputs.type === "execution") &&
    (!inputs.venue || inputs.venue === "hyperliquid") &&
    (inputs.openOnly ||
      !inputs.status ||
      (Array.isArray(inputs.status)
        ? inputs.status.includes("observed")
        : inputs.status === "observed")) &&
    !!inputs.walletAddresses?.length;

  if (
    !includeOrders &&
    !includeNativeOrders &&
    !includeSwaps &&
    !includeObserved
  ) {
    return { rows: [], total: 0 };
  }

  const filterParams = buildFilterParams(inputs);
  const baseOrderWhere =
    buildWhereClause("o", filterParams, true, {
      market: ORDER_MARKET_ID_SQL,
      token: "o.token_id",
      createdAt: "coalesce(o.posted_at, o.last_update)",
    }) + " and o.venue is distinct from 'hyperliquid'";
  const orderWhere = inputs.openOnly
    ? `${baseOrderWhere} and o.cancelled_at is null and (o.size is null or o.filled_size is null or o.filled_size < o.size) and lower(coalesce(o.status, '')) in ('pending', 'submitted', 'live', 'partially_filled', 'delayed', 'unconfirmed', 'open') and not (lower(coalesce(o.venue, '')) = 'limitless' and upper(coalesce(o.order_type, '')) = 'FOK')`
    : baseOrderWhere;
  const execWhere = buildWhereClause("e", filterParams, false, {
    market: "e.unified_market_id",
    createdAt: "e.created_at",
  });

  const selects: string[] = [];
  if (includeOrders) selects.push(buildOrdersSelect(orderWhere));
  if (includeNativeOrders) {
    const nativeWhere = buildWhereClause("o", filterParams, true, {
      market: "native_action.canonical_market_id",
      token: "o.token_id",
      createdAt: "coalesce(o.posted_at,o.last_update)",
      status: "native_state.display_status",
    });
    selects.push(
      buildNativeOrdersSelect(
        nativeWhere +
          (inputs.openOnly
            ? " and not native_terminal.terminal_confirmed and native_submission.state<>'rejected' and lower(coalesce(native_state.display_status,'')) in ('pending','submitted','live','partially_filled','delayed','unconfirmed','open')"
            : ""),
      ),
    );
  }
  if (includeSwaps) selects.push(buildExecutionsSelect(execWhere));
  const countSelects = [...selects];
  if (includeObserved)
    countSelects.push(
      buildObservedHip4Select(filterParams, undefined, inputs.openOnly),
    );

  const params = [...filterParams.params];
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;
  params.push(inputs.limit, inputs.offset);
  if (includeObserved)
    selects.push(
      buildObservedHip4Select(
        filterParams,
        `$${limitIndex}::int + $${offsetIndex}::int`,
        inputs.openOnly,
      ),
    );
  const unionSql = selects.join(" union all ");

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
        ${countSelects.join(" union all ")}
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
  const orderWhere =
    buildWhereClause("o", filterParams, true, {
      market: ORDER_MARKET_ID_SQL,
      token: "o.token_id",
      createdAt: "coalesce(o.posted_at, o.last_update)",
    }) + " and o.venue is distinct from 'hyperliquid'";
  const execWhere = buildWhereClause("e", filterParams, false);
  const nativeWhere = buildWhereClause("o", filterParams, true, {
    market: "native_action.canonical_market_id",
    token: "o.token_id",
    createdAt: "coalesce(o.posted_at,o.last_update)",
    status: "native_state.display_status",
  });

  const params = [...filterParams.params];
  const idIndex = params.length + 1;
  params.push(inputs.id);
  // Observed IDs share this endpoint but are not UUIDs. Do not cast those, or
  // cast the indexed column to text and scan the owner's full native history.
  const nativeIdWhere =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      inputs.id,
    )
      ? `o.id=$${idIndex}::uuid`
      : "false";

  const { rows } = await pool.query<UnifiedOrderRow>(
    `
      with combined as (
        ${buildOrdersSelect(orderWhere)} and o.id::text = $${idIndex}
        union all
        ${buildNativeOrdersSelect(`${nativeWhere} and ${nativeIdWhere}`)}
        union all
        ${buildExecutionsSelect(execWhere)} and e.id::text = $${idIndex}
        ${inputs.includeObservedHip4 && filterParams.walletIndex ? `union all ${buildObservedHip4Select(filterParams)} and ('hyperliquid:' || (e.execution->>'id'))=$${idIndex}` : ""}
        ${inputs.includeObservedHip4 && filterParams.walletIndex && filterParams.openOrderAgeIndex ? `union all ${buildObservedHip4Select(filterParams, undefined, true)} and ('hyperliquid:order:' || (e.execution->>'id'))=$${idIndex}` : ""}
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
