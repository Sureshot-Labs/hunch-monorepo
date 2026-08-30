/* no-transaction */

SET statement_timeout = 0;
SET lock_timeout = '5s';

-- Dedicated Timescale maintenance migration. These parent hypertable indexes
-- had zero observed scans and are not compression, retention, uniqueness, or
-- constraint dependencies. Timescale propagates the parent drop to its chunk
-- indexes. Do not add CONCURRENTLY: the installed Timescale version does not
-- support PostgreSQL concurrent index operations on hypertables.
--
-- Run this file separately from ordinary concurrent drops. Immediately before
-- execution, verify that no compression/refresh/retention job is active and
-- that no long transaction holds a conflicting lock. The short lock timeout
-- makes a busy system fail safely instead of waiting indefinitely.
-- This migration also assumes raw Timescale history is queried by token_id or
-- time range, not by venue across all tokens. Do not execute it if venue-wide
-- raw book/trade history is a supported or planned access pattern.
DROP INDEX IF EXISTS public.idx_unified_book_top_venue;
DROP INDEX IF EXISTS public.idx_unified_last_trade_venue;

RESET lock_timeout;
RESET statement_timeout;
