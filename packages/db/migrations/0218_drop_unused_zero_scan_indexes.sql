/* no-transaction */

SET statement_timeout = 0;

-- These indexes had zero scans, tuples read, and tuples fetched in mature
-- production statistics. Current query shapes use more selective indexes or
-- filter-and-sort plans instead. Use concurrent, idempotent drops so a partial
-- migration can be retried safely.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_wallet_position_snapshots_wallet_market_time;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_active_event_volume_liquidity;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_open_interest;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_volume_total;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_liquidity;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_active_volume24h;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_active_liquidity;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_market_ledger;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_category_lower;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_category;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_event_id_active;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_status_active;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_wallets_last_seen;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_wallet_activity_hourly_wallet_market_time;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_wallet_activity_baseline_window;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_markets_volume;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_markets_liquidity;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_markets_closed;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_markets_accepting_orders;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_markets_active;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_markets_category;
