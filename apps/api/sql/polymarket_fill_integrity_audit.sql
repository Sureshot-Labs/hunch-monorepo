-- Read-only Polymarket fill integrity audit.
-- Run with:
--   psql "$DATABASE_URL" -f apps/api/sql/polymarket_fill_integrity_audit.sql

\echo 'Duplicate Polymarket order_fills by (order_id, venue_fill_id)'
select
  f.order_id,
  f.venue_fill_id,
  count(*) as row_count,
  array_agg(f.id order by f.created_at asc, f.id asc) as fill_ids,
  sum(f.fill_size) as summed_fill_size,
  min(f.created_at) as first_created_at,
  max(f.created_at) as last_created_at
from order_fills f
join orders o on o.id = f.order_id
where o.venue = 'polymarket'
  and f.venue_fill_id is not null
group by f.order_id, f.venue_fill_id
having count(*) > 1
order by max(f.created_at) desc;

\echo 'Polymarket orders whose aggregate filled_size differs from order_fills'
with agg as (
  select
    f.order_id,
    sum(f.fill_size) as filled_size,
    sum(f.fill_size * f.fill_price) / nullif(sum(f.fill_size), 0) as average_fill_price,
    max(f.filled_at) as filled_at
  from order_fills f
  join orders o on o.id = f.order_id
  where o.venue = 'polymarket'
  group by f.order_id
)
select
  o.id as order_id,
  o.venue_order_id,
  o.status,
  o.size as order_size,
  o.filled_size as stored_filled_size,
  agg.filled_size as computed_filled_size,
  o.average_fill_price as stored_average_fill_price,
  agg.average_fill_price as computed_average_fill_price
from agg
join orders o on o.id = agg.order_id
where abs(coalesce(o.filled_size, 0) - coalesce(agg.filled_size, 0)) > 0.000001
   or (
     o.average_fill_price is not null
     and agg.average_fill_price is not null
     and abs(o.average_fill_price - agg.average_fill_price) > 0.000001
   )
order by o.last_update desc nulls last;

\echo 'Polymarket fills missing volume_events'
select
  o.id as order_id,
  o.venue_order_id,
  f.venue_fill_id,
  f.fill_size,
  f.fill_price,
  f.filled_at
from order_fills f
join orders o on o.id = f.order_id
left join volume_events ve
  on ve.user_id = o.user_id
 and ve.venue = 'polymarket'
 and ve.source_type = 'order'
 and ve.source_id = f.venue_fill_id
where o.venue = 'polymarket'
  and f.venue_fill_id is not null
  and ve.id is null
order by f.filled_at desc;

\echo 'Polymarket builder fills missing venue_fee_accruals'
select
  o.id as order_id,
  o.venue_order_id,
  f.venue_fill_id,
  f.fill_size,
  f.fill_price,
  f.filled_at
from order_fills f
join orders o on o.id = f.order_id
left join venue_fee_accruals a
  on a.order_id = f.order_id
 and a.venue = 'polymarket'
 and a.fee_program = 'builder'
 and a.venue_fill_id = f.venue_fill_id
where o.venue = 'polymarket'
  and f.venue_fill_id is not null
  and jsonb_typeof(o.order_payload) = 'object'
  and o.order_payload ? 'builder'
  and a.id is null
order by f.filled_at desc;
