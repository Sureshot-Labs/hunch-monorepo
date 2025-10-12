-- Drop legacy events and markets tables
-- This migration removes the old events and markets tables in favor of unified_events and unified_markets

-- Drop dependent tables first
DROP TABLE IF EXISTS book_top CASCADE;
DROP TABLE IF EXISTS last_trade CASCADE;
DROP TABLE IF EXISTS tokens CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS trades CASCADE;

-- Drop the main tables
DROP TABLE IF EXISTS markets CASCADE;
DROP TABLE IF EXISTS events CASCADE;

-- Note: venues table is kept as it may still be referenced elsewhere
-- Note: idempotency table is kept as it's used for API operations
