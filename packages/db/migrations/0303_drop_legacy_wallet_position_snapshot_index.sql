/* no-transaction */

-- The venue-first covering index serves Following as well as position history.
-- This legacy partial index is separate from all constraints and unique keys.
SET lock_timeout = '15s';
SET statement_timeout = '2min';
DROP INDEX CONCURRENTLY IF EXISTS public.idx_wallet_position_snapshots_wallet_market_side_time_pos;
RESET statement_timeout;
RESET lock_timeout;
