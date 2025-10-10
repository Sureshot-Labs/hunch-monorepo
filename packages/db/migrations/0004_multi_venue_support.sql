-- Phase 2: Multi-Venue Support Migration
-- This migration adds support for multiple venues (Kalshi, Limitless) in addition to Polymarket

-- Rename existing table to support multiple venues (if it exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_polymarket_credentials') THEN
        ALTER TABLE user_polymarket_credentials RENAME TO user_venue_credentials;
    END IF;
END $$;

-- Add venue column (if it doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_venue_credentials' AND column_name = 'venue') THEN
        ALTER TABLE user_venue_credentials ADD COLUMN venue text NOT NULL DEFAULT 'polymarket';
    END IF;
END $$;

-- Add additional_data column for venue-specific data (if it doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_venue_credentials' AND column_name = 'additional_data') THEN
        ALTER TABLE user_venue_credentials ADD COLUMN additional_data jsonb;
    END IF;
END $$;

-- Update the unique constraint to include venue
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'user_polymarket_credentials_user_id_wallet_address_key') THEN
        ALTER TABLE user_venue_credentials DROP CONSTRAINT user_polymarket_credentials_user_id_wallet_address_key;
    END IF;
END $$;
-- Add unique constraint (if it doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'user_venue_credentials_user_id_wallet_address_venue_key') THEN
        ALTER TABLE user_venue_credentials ADD CONSTRAINT user_venue_credentials_user_id_wallet_address_venue_key UNIQUE (user_id, wallet_address, venue);
    END IF;
END $$;

-- Add check constraint for venue values (if it doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'user_venue_credentials_venue_check') THEN
        ALTER TABLE user_venue_credentials ADD CONSTRAINT user_venue_credentials_venue_check CHECK (venue IN ('polymarket', 'kalshi', 'limitless'));
    END IF;
END $$;

-- Update indexes
DROP INDEX IF EXISTS idx_polymarket_creds_user_id;
DROP INDEX IF EXISTS idx_polymarket_creds_wallet;
DROP INDEX IF EXISTS idx_polymarket_creds_active;

CREATE INDEX IF NOT EXISTS idx_venue_creds_user_id ON user_venue_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_venue_creds_wallet ON user_venue_credentials(wallet_address);
CREATE INDEX IF NOT EXISTS idx_venue_creds_venue ON user_venue_credentials(venue);
CREATE INDEX IF NOT EXISTS idx_venue_creds_active ON user_venue_credentials(is_active);

-- Update trigger name
DROP TRIGGER IF EXISTS update_polymarket_creds_updated_at ON user_venue_credentials;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'update_venue_creds_updated_at') THEN
        CREATE TRIGGER update_venue_creds_updated_at BEFORE UPDATE ON user_venue_credentials FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

