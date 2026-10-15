/* no-transaction */
-- Bound source enumeration before provider/envelope filters. All states and
-- assets are included so a released or misbound reservation cannot disappear.
-- No historical rows are rewritten. The existing plan-shape constraint owns
-- the one-source-input-per-route-leg invariant.
create index concurrently if not exists balance_reservations_refund_source_page_idx
  on balance_reservations (user_id, created_at desc, id desc)
  where economic_role='source_input';
