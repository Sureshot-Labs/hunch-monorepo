-- Add DFlow execution fields to unified_markets (for Kalshi via Solana).
-- These fields are required to build DFlow swap/quote requests later.

DO $$
BEGIN
  IF to_regclass('public.unified_markets') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'unified_markets'
        AND column_name = 'market_ledger'
    ) THEN
      ALTER TABLE unified_markets ADD COLUMN market_ledger text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'unified_markets'
        AND column_name = 'settlement_mint'
    ) THEN
      ALTER TABLE unified_markets ADD COLUMN settlement_mint text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'unified_markets'
        AND column_name = 'is_initialized'
    ) THEN
      ALTER TABLE unified_markets ADD COLUMN is_initialized boolean;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'unified_markets'
        AND column_name = 'redemption_status'
    ) THEN
      ALTER TABLE unified_markets ADD COLUMN redemption_status text;
    END IF;

    -- Optional indexes for execution lookups.
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_unified_markets_settlement_mint ON unified_markets(settlement_mint) WHERE settlement_mint IS NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_unified_markets_market_ledger ON unified_markets(market_ledger) WHERE market_ledger IS NOT NULL';
  END IF;
END $$;
