delete from venue_fee_backfill_attempts b
where exists (
  select 1
  from venue_fee_accruals a
  where a.venue = b.venue
    and a.fee_program = b.fee_program
    and a.order_id = b.order_id
);
