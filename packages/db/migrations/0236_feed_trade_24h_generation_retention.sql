-- Keep the feed trade caches as complete atomic generations. The original
-- refresh functions only upserted rows, so markets and events that no longer
-- had trades in the rolling window retained their old volume forever.

create or replace function refresh_unified_market_trade_24h()
returns void
language plpgsql
as $$
declare
  refresh_generation timestamptz := clock_timestamp();
begin
  insert into unified_market_trade_24h (
    market_id,
    volume_24h,
    vwap,
    trades,
    updated_at
  )
  select
    market_token.market_id,
    sum(last_trade.volume) as volume_24h,
    case
      when sum(last_trade.volume) is null or sum(last_trade.volume) = 0
        then null
      else sum(last_trade.vwap * last_trade.volume) / sum(last_trade.volume)
    end as vwap,
    sum(last_trade.trades)::bigint as trades,
    refresh_generation
  from unified_last_trade_1h last_trade
  join unified_market_tokens market_token
    on market_token.token_id = last_trade.token_id
  where last_trade.bucket >= refresh_generation - interval '24 hours'
  group by market_token.market_id
  on conflict (market_id) do update
    set volume_24h = excluded.volume_24h,
        vwap = excluded.vwap,
        trades = excluded.trades,
        updated_at = excluded.updated_at;

  delete from unified_market_trade_24h cached_market
  where cached_market.updated_at < refresh_generation;
end
$$;

create or replace function refresh_unified_event_trade_24h()
returns void
language plpgsql
as $$
declare
  refresh_generation timestamptz := clock_timestamp();
  market_refresh_generation timestamptz;
begin
  select max(cached_market.updated_at)
  into market_refresh_generation
  from unified_market_trade_24h cached_market;

  insert into unified_event_trade_24h (
    event_id,
    volume_24h,
    updated_at
  )
  select
    unified_event.id,
    sum(cached_market.volume_24h) as volume_24h,
    refresh_generation
  from unified_market_trade_24h cached_market
  join unified_markets unified_market
    on unified_market.id = cached_market.market_id
  join unified_events unified_event
    on unified_event.id = unified_market.event_id
  where cached_market.updated_at = market_refresh_generation
    and unified_market.status = 'ACTIVE'
    and unified_event.status = 'ACTIVE'
    and unified_market.venue <> 'limitless'
    and (
      unified_market.expiration_time is null
      or unified_market.expiration_time > refresh_generation
    )
    and (
      unified_market.close_time is null
      or unified_market.close_time > refresh_generation
    )
    and (
      unified_event.end_date is null
      or unified_event.end_date > refresh_generation
    )
  group by unified_event.id
  on conflict (event_id) do update
    set volume_24h = excluded.volume_24h,
        updated_at = excluded.updated_at;

  delete from unified_event_trade_24h cached_event
  where cached_event.updated_at < refresh_generation;
end
$$;
