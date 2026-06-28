export const POSITION_MARKET_JOIN_SQL = `
  left join lateral (
    select
      token_market.market_id,
      token_market.outcome_side
    from (
      select
        ut.market_id,
        upper(ut.side) as outcome_side,
        case when ut.venue = p.venue then 0 else 1 end as venue_rank,
        token_lookup.lookup_rank,
        ut.updated_at,
        0 as source_rank
      from (
        select p.token_id as token_id, 0 as lookup_rank
        union all
        select substring(p.token_id from 11), 1
        where p.venue = 'limitless'
          and p.token_id like 'limitless:%'
        union all
        select 'limitless:' || p.token_id, 1
        where p.venue = 'limitless'
          and p.token_id not like '%:%'
      ) token_lookup
      join unified_tokens ut
        on ut.token_id = token_lookup.token_id

      union all

      select
        umt.market_id,
        upper(umt.outcome_side) as outcome_side,
        case when umt.venue = p.venue then 0 else 1 end as venue_rank,
        token_lookup.lookup_rank,
        umt.updated_at,
        1 as source_rank
      from (
        select p.token_id as token_id, 0 as lookup_rank
        union all
        select substring(p.token_id from 11), 1
        where p.venue = 'limitless'
          and p.token_id like 'limitless:%'
        union all
        select 'limitless:' || p.token_id, 1
        where p.venue = 'limitless'
          and p.token_id not like '%:%'
      ) token_lookup
      join unified_market_tokens umt
        on umt.token_id = token_lookup.token_id

      union all

      select
        m_yes.id as market_id,
        'YES' as outcome_side,
        case when m_yes.venue = p.venue then 0 else 1 end as venue_rank,
        token_lookup.lookup_rank,
        m_yes.updated_at,
        2 as source_rank
      from (
        select p.token_id as token_id, 0 as lookup_rank
        union all
        select substring(p.token_id from 11), 1
        where p.venue = 'limitless'
          and p.token_id like 'limitless:%'
        union all
        select 'limitless:' || p.token_id, 1
        where p.venue = 'limitless'
          and p.token_id not like '%:%'
      ) token_lookup
      join unified_markets m_yes
        on m_yes.token_yes = token_lookup.token_id

      union all

      select
        m_no.id as market_id,
        'NO' as outcome_side,
        case when m_no.venue = p.venue then 0 else 1 end as venue_rank,
        token_lookup.lookup_rank,
        m_no.updated_at,
        2 as source_rank
      from (
        select p.token_id as token_id, 0 as lookup_rank
        union all
        select substring(p.token_id from 11), 1
        where p.venue = 'limitless'
          and p.token_id like 'limitless:%'
        union all
        select 'limitless:' || p.token_id, 1
        where p.venue = 'limitless'
          and p.token_id not like '%:%'
      ) token_lookup
      join unified_markets m_no
        on m_no.token_no = token_lookup.token_id
    ) token_market
    where token_market.outcome_side in ('YES', 'NO')
    order by
      token_market.lookup_rank asc,
      token_market.venue_rank asc,
      token_market.updated_at desc nulls last,
      token_market.source_rank asc,
      token_market.market_id asc
    limit 1
  ) umt on true
  left join unified_markets m
    on m.id = umt.market_id
  left join unified_market_tokens market_token_yes
    on market_token_yes.market_id = m.id
   and market_token_yes.outcome_side = 'YES'
  left join lateral (
    select
      case
        when m.venue = 'polymarket' and m.clob_token_ids is not null
          then (m.clob_token_ids::jsonb->>0)
        else coalesce(m.token_yes, market_token_yes.token_id)
      end as token_yes
  ) market_tokens on true
  left join lateral (
    select best_bid, best_ask
    from unified_token_top_latest
    where token_id = market_tokens.token_yes
      and ts > now() - interval '7 days'
    limit 1
  ) yes_top on true
  left join lateral (
    select best_bid, best_ask
    from unified_token_top_latest
    where token_id = p.token_id
      and ts > now() - interval '7 days'
    limit 1
  ) selected_top on true
`;

export const RESOLVED_MARKET_SQL = `
  (
    upper(coalesce(m.resolved_outcome, '')) in ('YES', 'NO')
    or m.resolved_outcome_pct is not null
  )
`;

export const UNREALIZED_PNL_COMPONENT_SQL = `
  case
    when p.side <> 'FLAT' and p.size > 0 then
      coalesce(
        case
          when p.average_price is not null
           and umt.outcome_side in ('YES', 'NO')
           and upper(coalesce(m.resolved_outcome, '')) in ('YES', 'NO')
            then (
              case
                when upper(m.resolved_outcome) = 'YES' and umt.outcome_side = 'YES' then 1::numeric
                when upper(m.resolved_outcome) = 'NO' and umt.outcome_side = 'NO' then 1::numeric
                else 0::numeric
              end * p.size
            ) - (p.average_price * p.size)
          when p.average_price is not null
           and umt.outcome_side in ('YES', 'NO')
           and m.resolved_outcome_pct is not null
            then (
              case
                when umt.outcome_side = 'YES'
                  then least(greatest(m.resolved_outcome_pct::numeric / 10000.0, 0::numeric), 1::numeric)
                else 1::numeric - least(greatest(m.resolved_outcome_pct::numeric / 10000.0, 0::numeric), 1::numeric)
              end * p.size
            ) - (p.average_price * p.size)
          when p.average_price is not null
           and umt.outcome_side in ('YES', 'NO')
           and upper(coalesce(m.status::text, '')) not in ('CLOSED', 'SETTLED')
            then (
              case
                when umt.outcome_side = 'YES' then selected_top.best_bid
                when umt.outcome_side = 'NO' then coalesce(
                  selected_top.best_bid,
                  case
                    when yes_top.best_ask is not null then 1::numeric - yes_top.best_ask
                    else null
                  end,
                  selected_top.best_ask,
                  case
                    when yes_top.best_bid is not null then 1::numeric - yes_top.best_bid
                    else null
                  end
                )
                else null
              end * p.size
            ) - (p.average_price * p.size)
          else null
        end,
        p.unrealized_pnl,
        0
      )
    else 0
  end
`;

export const EFFECTIVE_PNL_SQL = `
  coalesce(p.realized_pnl, 0) + (${UNREALIZED_PNL_COMPONENT_SQL})
`;
