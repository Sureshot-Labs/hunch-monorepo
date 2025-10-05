-- Phase 2: Multi-Venue Support Migration
-- This migration adds support for multiple venues (Kalshi, Limitless) in addition to Polymarket

-- Rename existing table to support multiple venues
ALTER TABLE user_polymarket_credentials RENAME TO user_venue_credentials;

-- Add venue column
ALTER TABLE user_venue_credentials ADD COLUMN venue text NOT NULL DEFAULT 'polymarket';

-- Add additional_data column for venue-specific data
ALTER TABLE user_venue_credentials ADD COLUMN additional_data jsonb;

-- Update the unique constraint to include venue
ALTER TABLE user_venue_credentials DROP CONSTRAINT user_polymarket_credentials_user_id_wallet_address_key;
ALTER TABLE user_venue_credentials ADD CONSTRAINT user_venue_credentials_user_id_wallet_address_venue_key UNIQUE (user_id, wallet_address, venue);

-- Add check constraint for venue values
ALTER TABLE user_venue_credentials ADD CONSTRAINT user_venue_credentials_venue_check CHECK (venue IN ('polymarket', 'kalshi', 'limitless'));

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
CREATE TRIGGER update_venue_creds_updated_at BEFORE UPDATE ON user_venue_credentials FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

