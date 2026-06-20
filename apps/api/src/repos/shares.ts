import type { Pool } from "@hunch/infra";
import {
  EFFECTIVE_PNL_SQL,
  UNREALIZED_PNL_COMPONENT_SQL,
} from "../lib/pnl-sql.js";
import type { DbQuery } from "../db.js";
import type { PgParams } from "../server-types.js";

export type ShareKind = "portfolio_pnl" | "trade_pnl";

export type ShareSnapshotRow = {
  id: string;
  kind: ShareKind;
  user_id: string | null;
  referral_code: string | null;
  snapshot: unknown;
  schema_version: number;
  created_at: Date;
  expires_at: Date | null;
};

export type PositionShareSourceRow = {
  position_id: string;
  venue: string;
  token_id: string;
  side: string;
  size: string;
  average_price: string | null;
  realized_pnl: string | null;
  unrealized_pnl_effective: string | null;
  effective_pnl: string | null;
  last_updated_at: Date;
  created_at: Date;
  updated_at: Date;
  outcome_side: string | null;
  market_id: string | null;
  market_title: string | null;
  market_image: string | null;
  market_status: string | null;
  market_close_time: Date | null;
  market_expiration_time: Date | null;
  best_bid_yes: string | null;
  best_ask_yes: string | null;
  best_bid_no: string | null;
  best_ask_no: string | null;
  last_price: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
  redemption_status: string | null;
  event_id: string | null;
  event_title: string | null;
  event_image: string | null;
  event_end_time: Date | null;
};

const POSITION_MARKET_JOIN_SQL = `
  left join lateral (
    select
      token_market.market_id,
      token_market.outcome_side
    from (
      select
        ut.market_id,
        upper(ut.side) as outcome_side,
        case when ut.venue = p.venue then 0 else 1 end as venue_rank,
        ut.updated_at
      from unified_tokens ut
      where ut.token_id = p.token_id

      union all

      select
        umt.market_id,
        upper(umt.outcome_side) as outcome_side,
        case when umt.venue = p.venue then 0 else 1 end as venue_rank,
        umt.updated_at
      from unified_market_tokens umt
      where umt.token_id = p.token_id
    ) token_market
    where token_market.outcome_side in ('YES', 'NO')
    order by
      token_market.venue_rank asc,
      token_market.updated_at desc nulls last,
      token_market.market_id asc
    limit 1
  ) umt on true
  left join unified_markets m
    on m.id = umt.market_id
  left join unified_events e
    on e.id = m.event_id
  left join lateral (
    select top.best_bid, top.best_ask
    from unified_token_top_latest top
    left join unified_market_tokens ymt
      on ymt.token_id = top.token_id
    where (
        top.token_id = m.token_yes
        or (
          ymt.market_id = m.id
          and ymt.outcome_side = 'YES'
        )
      )
      and top.ts > now() - interval '7 days'
    limit 1
  ) yes_top on true
  left join lateral (
    select top.best_bid, top.best_ask
    from unified_token_top_latest top
    left join unified_market_tokens nmt
      on nmt.token_id = top.token_id
    where (
        top.token_id = m.token_no
        or (
          nmt.market_id = m.id
          and nmt.outcome_side = 'NO'
        )
      )
      and top.ts > now() - interval '7 days'
    limit 1
  ) no_top on true
  left join lateral (
    select top.best_bid, top.best_ask
    from unified_token_top_latest top
    where top.token_id = p.token_id
      and top.ts > now() - interval '7 days'
    limit 1
  ) selected_top on true
`;

const POSITION_SHARE_SELECT_SQL = `
  select
    p.id::text as position_id,
    p.venue,
    p.token_id,
    p.side,
    p.size::text as size,
    p.average_price::text as average_price,
    p.realized_pnl::text as realized_pnl,
    (${UNREALIZED_PNL_COMPONENT_SQL})::text as unrealized_pnl_effective,
    (${EFFECTIVE_PNL_SQL})::text as effective_pnl,
    p.last_updated_at,
    p.created_at,
    p.updated_at,
    umt.outcome_side,
    m.id as market_id,
    m.title as market_title,
    m.image as market_image,
    m.status::text as market_status,
    m.close_time as market_close_time,
    m.expiration_time as market_expiration_time,
    yes_top.best_bid::text as best_bid_yes,
    yes_top.best_ask::text as best_ask_yes,
    no_top.best_bid::text as best_bid_no,
    no_top.best_ask::text as best_ask_no,
    m.last_price::text as last_price,
    m.resolved_outcome,
    m.resolved_outcome_pct::text as resolved_outcome_pct,
    m.redemption_status,
    e.id as event_id,
    e.title as event_title,
    e.image as event_image,
    e.end_date as event_end_time
  from positions p
  ${POSITION_MARKET_JOIN_SQL}
`;

function buildWalletScopeSql(
  params: PgParams,
  walletAddresses: string[] | undefined,
): string {
  if (!walletAddresses?.length) return "";
  params.push(walletAddresses);
  return ` and p.wallet_address = any($${params.length}::text[])`;
}

function resolveVenueScope(inputs: {
  venue?: string;
  venues?: string[];
}): string[] {
  return inputs.venues?.length && inputs.venues.length > 0
    ? Array.from(new Set(inputs.venues))
    : inputs.venue
      ? [inputs.venue]
      : [];
}

export async function insertShareSnapshot(
  pool: DbQuery,
  inputs: {
    id: string;
    kind: ShareKind;
    userId: string;
    referralCode: string | null;
    snapshot: unknown;
    schemaVersion?: number;
  },
): Promise<ShareSnapshotRow> {
  const { rows } = await pool.query<ShareSnapshotRow>(
    `
      insert into share_snapshots (
        id,
        kind,
        user_id,
        referral_code,
        snapshot,
        schema_version
      )
      values ($1, $2, $3, $4, $5::jsonb, $6)
      returning
        id,
        kind,
        user_id,
        referral_code,
        snapshot,
        schema_version,
        created_at,
        expires_at
    `,
    [
      inputs.id,
      inputs.kind,
      inputs.userId,
      inputs.referralCode,
      JSON.stringify(inputs.snapshot),
      inputs.schemaVersion ?? 1,
    ],
  );
  return rows[0];
}

export async function fetchShareSnapshot(
  pool: DbQuery,
  inputs: { id: string; kind?: ShareKind },
): Promise<ShareSnapshotRow | null> {
  const params: PgParams = [inputs.id];
  let kindSql = "";
  if (inputs.kind) {
    params.push(inputs.kind);
    kindSql = ` and kind = $${params.length}`;
  }

  const { rows } = await pool.query<ShareSnapshotRow>(
    `
      select
        id,
        kind,
        user_id,
        referral_code,
        snapshot,
        schema_version,
        created_at,
        expires_at
      from share_snapshots
      where id = $1
        ${kindSql}
        and (expires_at is null or expires_at > now())
      limit 1
    `,
    params,
  );
  return rows[0] ?? null;
}

export async function fetchPositionShareSourceById(
  pool: Pool,
  inputs: {
    userId: string;
    positionId: string;
    walletAddresses?: string[];
    venue?: string;
    venues?: string[];
  },
): Promise<PositionShareSourceRow | null> {
  const params: PgParams = [inputs.userId, inputs.positionId];
  const walletSql = buildWalletScopeSql(params, inputs.walletAddresses);
  const venueList = resolveVenueScope(inputs);
  let venueSql = "";
  if (venueList.length > 0) {
    params.push(venueList);
    venueSql = ` and p.venue = any($${params.length}::text[])`;
  }
  const { rows } = await pool.query<PositionShareSourceRow>(
    `
      ${POSITION_SHARE_SELECT_SQL}
      where p.user_id = $1
        and p.id = $2::uuid
        and p.position_scope = 'own'
        and coalesce(p.is_hidden, false) = false
        ${walletSql}
        ${venueSql}
      limit 1
    `,
    params,
  );
  return rows[0] ?? null;
}

export async function fetchTopPositionShareSource(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddresses: string[];
    venue?: string;
    venues?: string[];
  },
): Promise<PositionShareSourceRow | null> {
  if (inputs.walletAddresses.length === 0) return null;
  const params: PgParams = [inputs.userId, inputs.walletAddresses];
  const whereParts = [
    "p.user_id = $1",
    "p.wallet_address = any($2::text[])",
    "p.position_scope = 'own'",
    "coalesce(p.is_hidden, false) = false",
  ];
  const venueList = resolveVenueScope(inputs);
  if (venueList.length > 0) {
    params.push(venueList);
    whereParts.push(`p.venue = any($${params.length}::text[])`);
  }

  const { rows } = await pool.query<PositionShareSourceRow>(
    `
      ${POSITION_SHARE_SELECT_SQL}
      where ${whereParts.join("\n        and ")}
      order by
        abs(coalesce((${EFFECTIVE_PNL_SQL}), 0)) desc,
        p.last_updated_at desc nulls last,
        p.created_at desc nulls last,
        p.id asc
      limit 1
    `,
    params,
  );
  return rows[0] ?? null;
}
