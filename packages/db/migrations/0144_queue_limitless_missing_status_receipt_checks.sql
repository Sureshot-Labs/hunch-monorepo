update venue_fee_backfill_attempts b
set status = 'retry',
    reason = 'Limitless order status not found; queued for onchain receipt check',
    attempts = 0,
    next_attempt_at = now(),
    updated_at = now()
from orders o
where o.id = b.order_id
  and b.venue = 'limitless'
  and b.fee_program = 'venue_share'
  and b.status in ('retry', 'skipped', 'failed')
  and (
    b.reason like 'Limitless order status not found%'
    or b.reason like 'Limitless fee was contract-denominated%'
  )
  and o.status = 'filled'
  and o.order_hash ~* '^0x[0-9a-f]{64}$'
  and not exists (
    select 1
    from venue_fee_accruals a
    where a.venue = b.venue
      and a.fee_program = b.fee_program
      and a.order_id = b.order_id
  );
