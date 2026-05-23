/* no-transaction */

set lock_timeout = '5min';
set statement_timeout = 0;

create index concurrently if not exists idx_venue_fee_accruals_order_hash
  on venue_fee_accruals(order_hash)
  where order_hash is not null;

create index concurrently if not exists idx_venue_fee_accruals_venue_order
  on venue_fee_accruals(venue, venue_order_id)
  where venue_order_id is not null;

create index concurrently if not exists idx_venue_fee_accruals_wallet_recent
  on venue_fee_accruals(lower(wallet_address), filled_at desc, id desc)
  where wallet_address is not null;

create index concurrently if not exists idx_venue_fee_accruals_signer_recent
  on venue_fee_accruals(lower(signer_address), filled_at desc, id desc)
  where signer_address is not null;

create index concurrently if not exists idx_fee_events_source_id
  on fee_events(source_id);

create index concurrently if not exists idx_fee_events_venue_status_created
  on fee_events(venue, status, created_at desc, id desc);

create index concurrently if not exists idx_fee_events_wallet_recent
  on fee_events(lower(wallet_address), created_at desc, id desc)
  where wallet_address is not null;

create index concurrently if not exists idx_reward_claims_chain_status_created
  on reward_claims(chain_id, status, created_at desc, id desc);

create index concurrently if not exists idx_reward_claims_wallet_recent
  on reward_claims(lower(wallet_address), created_at desc, id desc);

create index concurrently if not exists idx_venue_fee_backfill_attempts_status_next
  on venue_fee_backfill_attempts(venue, fee_program, status, next_attempt_at, id);

reset lock_timeout;
reset statement_timeout;
