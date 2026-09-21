export type MarketMapSidebarKind =
  | "trendingNow"
  | "volumeMovers24h"
  | "volumeMoversAbsolute24h"
  | "liquidityMovers24h"
  | "liquidityMoversAbsolute24h"
  | "topMovers24h";

const EVENT_CHANGE24H_CURRENT_VERSION_SQL = `(
  ec.calculation_version = 2
  or (
    ec.calculation_version = 1
    and not exists (
      select 1
      from unified_event_change_24h v2_cache
      where v2_cache.calculation_version = 2
        and v2_cache.change_24h is not null
    )
  )
)`;

export type MarketMapSidebarQualityFloors = {
  minVolumeBase: number;
  minVolumeChangePct: number;
  minVolumeChangeAbs: number;
  minLiquidityBase: number;
  minLiquidityChangePct: number;
  minLiquidityChangeAbs: number;
};

export function emptyMarketMapSidebarQualityFloors(): MarketMapSidebarQualityFloors {
  return {
    minVolumeBase: 0,
    minVolumeChangePct: 0,
    minVolumeChangeAbs: 0,
    minLiquidityBase: 0,
    minLiquidityChangePct: 0,
    minLiquidityChangeAbs: 0,
  };
}

function marketMapSidebarActivePrefilterLimit(limit: number): number {
  return limit <= 0 ? 0 : Math.min(1000, Math.max(limit * 10, limit));
}

function sidebarSqlParts(kind: MarketMapSidebarKind): {
  fromSql: string;
  filterSql: string;
  orderSql: string;
} {
  switch (kind) {
    case "volumeMovers24h":
      return {
        fromSql: `
          from unified_event_activity_metrics_24h eam
          join unified_events e
            on e.id = eam.event_id
           and e.venue = eam.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
           and ${EVENT_CHANGE24H_CURRENT_VERSION_SQL}
        `,
        filterSql: `
          and eam.venue = any($1::text[])
          and eam.volume_valid is true
          and eam.volume_last_24h_change_pct is not null
          and eam.volume_last_24h >= $3::numeric
          and eam.volume_prev_24h >= $3::numeric
          and eam.volume_last_24h_change_pct >= $4::numeric
        `,
        orderSql: `
          eam.volume_last_24h_change_pct desc nulls last,
          eam.volume_last_24h desc nulls last
        `,
      };
    case "volumeMoversAbsolute24h":
      return {
        fromSql: `
          from unified_event_activity_metrics_24h eam
          join unified_events e
            on e.id = eam.event_id
           and e.venue = eam.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
           and ${EVENT_CHANGE24H_CURRENT_VERSION_SQL}
        `,
        filterSql: `
          and eam.venue = any($1::text[])
          and eam.volume_valid is true
          and eam.volume_last_24h_change is not null
          and greatest(
            coalesce(eam.volume_last_24h, 0),
            coalesce(eam.volume_prev_24h, 0)
          ) >= $3::numeric
          and abs(eam.volume_last_24h_change) >= $5::numeric
        `,
        orderSql: `
          abs(eam.volume_last_24h_change) desc nulls last,
          eam.volume_last_24h desc nulls last
        `,
      };
    case "liquidityMovers24h":
      return {
        fromSql: `
          from unified_event_activity_metrics_24h eam
          join unified_events e
            on e.id = eam.event_id
           and e.venue = eam.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
           and ${EVENT_CHANGE24H_CURRENT_VERSION_SQL}
        `,
        filterSql: `
          and eam.venue = any($1::text[])
          and eam.liquidity_valid is true
          and eam.liquidity_change_pct_24h is not null
          and eam.liquidity_now >= $6::numeric
          and eam.liquidity_24h_ago >= $6::numeric
          and eam.liquidity_change_pct_24h >= $7::numeric
        `,
        orderSql: `
          eam.liquidity_change_pct_24h desc nulls last,
          eam.liquidity_now desc nulls last
        `,
      };
    case "liquidityMoversAbsolute24h":
      return {
        fromSql: `
          from unified_event_activity_metrics_24h eam
          join unified_events e
            on e.id = eam.event_id
           and e.venue = eam.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
           and ${EVENT_CHANGE24H_CURRENT_VERSION_SQL}
        `,
        filterSql: `
          and eam.venue = any($1::text[])
          and eam.liquidity_valid is true
          and eam.liquidity_change_24h is not null
          and greatest(
            coalesce(eam.liquidity_now, 0),
            coalesce(eam.liquidity_24h_ago, 0)
          ) >= $6::numeric
          and abs(eam.liquidity_change_24h) >= $8::numeric
        `,
        orderSql: `
          abs(eam.liquidity_change_24h) desc nulls last,
          eam.liquidity_now desc nulls last
        `,
      };
    case "topMovers24h":
      return {
        fromSql: `
          from unified_event_change_24h ec
          join unified_events e
            on e.id = ec.event_id
          left join unified_event_activity_metrics_24h eam
            on eam.event_id = e.id
           and eam.venue = e.venue
        `,
        filterSql: `and ${EVENT_CHANGE24H_CURRENT_VERSION_SQL}
          and ec.change_24h is not null`,
        orderSql: "ec.change_24h desc nulls last",
      };
    case "trendingNow":
    default:
      return {
        fromSql: `
          from unified_events e
          left join unified_event_activity_metrics_24h eam
            on eam.event_id = e.id
           and eam.venue = e.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
           and ${EVENT_CHANGE24H_CURRENT_VERSION_SQL}
        `,
        filterSql: "",
        orderSql: `
          coalesce(
            case when eam.volume_valid is true then eam.volume_last_24h else null end,
            e.volume_24h,
            0
          ) desc
        `,
      };
  }
}

function sidebarRankedOrderSql(kind: MarketMapSidebarKind): string {
  switch (kind) {
    case "volumeMovers24h":
      return `
        re.volume_last_24h_change_pct desc nulls last,
        re.volume_last_24h desc nulls last
      `;
    case "volumeMoversAbsolute24h":
      return `
        abs(re.volume_last_24h_change) desc nulls last,
        re.volume_last_24h desc nulls last
      `;
    case "liquidityMovers24h":
      return `
        re.liquidity_change_pct_24h desc nulls last,
        re.liquidity_now desc nulls last
      `;
    case "liquidityMoversAbsolute24h":
      return `
        abs(re.liquidity_change_24h) desc nulls last,
        re.liquidity_now desc nulls last
      `;
    case "topMovers24h":
      return "re.change_24h desc nulls last";
    case "trendingNow":
    default:
      return "re.score desc";
  }
}

export function buildMarketMapSidebarQuery(params: {
  kind: MarketMapSidebarKind;
  venues: string[];
  limit: number;
  quality: MarketMapSidebarQualityFloors;
}) {
  const { kind, venues, limit, quality } = params;
  const { fromSql, filterSql, orderSql } = sidebarSqlParts(kind);
  const rankedOrderSql = sidebarRankedOrderSql(kind);
  const activePrefilterLimit = marketMapSidebarActivePrefilterLimit(limit);
  return {
    text: `
      with ranked_events as materialized (
        select
          e.id as event_id,
          e.title,
          e.venue::text as venue,
          e.start_date as start_time,
          e.end_date as end_time,
          e.image as event_image,
          e.icon as event_icon,
          coalesce(e.volume_24h, 0) as event_volume_24h,
          coalesce(
            nullif(case when e.liquidity >= 9e16 then null else e.liquidity end, 0),
            0
          ) as event_liquidity,
          coalesce(e.open_interest, 0) as event_open_interest,
          ec.change_24h,
          eam.volume_last_24h,
          eam.volume_prev_24h,
          eam.volume_last_24h_change,
          eam.volume_last_24h_change_pct,
          eam.liquidity_now,
          eam.liquidity_change_24h,
          eam.liquidity_change_pct_24h,
          eam.open_interest_now,
          eam.open_interest_change_24h,
          eam.open_interest_change_pct_24h,
          eam.updated_at,
          coalesce(
            case when eam.volume_valid is true then eam.volume_last_24h else null end,
            e.volume_24h,
            0
          )::double precision as score
        ${fromSql}
        where e.status = 'ACTIVE'
          and e.venue = any($1::text[])
          and (e.end_date is null or e.end_date > now())
          and $3::numeric >= 0
          and $4::numeric >= 0
          and $5::numeric >= 0
          and $6::numeric >= 0
          and $7::numeric >= 0
          and $8::numeric >= 0
          and (
            $3::numeric <= 0
            or coalesce(
              case when eam.volume_valid is true then eam.volume_last_24h else null end,
              e.volume_24h,
              0
            ) >= $3::numeric
          )
          and (
            $6::numeric <= 0
            or coalesce(
              eam.liquidity_now,
              nullif(case when e.liquidity >= 9e16 then null else e.liquidity end, 0),
              0
            ) >= $6::numeric
          )
          ${filterSql}
        order by
          ${orderSql},
          e.id
        limit $9
      )
      select *
      from ranked_events re
      where exists (
        select 1
        from unified_markets m
        where m.event_id = re.event_id
          and m.venue = re.venue
          and m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > now())
          and (m.close_time is null or m.close_time > now())
      )
      order by
        ${rankedOrderSql},
        re.event_id
      limit $2
    `,
    values: [
      venues,
      Math.max(1, Math.trunc(limit)),
      quality.minVolumeBase,
      quality.minVolumeChangePct,
      quality.minVolumeChangeAbs,
      quality.minLiquidityBase,
      quality.minLiquidityChangePct,
      quality.minLiquidityChangeAbs,
      activePrefilterLimit,
    ],
  };
}
