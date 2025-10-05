-- Phase 2: Authentication & User Management Migration
-- This migration adds user authentication, wallet management, and Polymarket API credentials

-- User authentication and management
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  username text UNIQUE,
  display_name text,
  avatar_url text,
  is_active boolean DEFAULT true,
  is_verified boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_login_at timestamptz
);

-- User wallets and blockchain addresses
CREATE TABLE IF NOT EXISTS user_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  wallet_type text NOT NULL DEFAULT 'ethereum', -- ethereum, polygon, etc.
  is_primary boolean DEFAULT false,
  is_verified boolean DEFAULT false,
  verification_signature text, -- Signature used for verification
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, wallet_address)
);

-- Venue API credentials per user (supports Polymarket, Kalshi, Limitless, etc.)
CREATE TABLE IF NOT EXISTS user_venue_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  venue text NOT NULL CHECK (venue IN ('polymarket', 'kalshi', 'limitless')),
  api_key text NOT NULL,
  api_secret text NOT NULL,
  additional_data jsonb, -- For venue-specific data (e.g., Kalshi username)
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE(user_id, wallet_address, venue),
  FOREIGN KEY (user_id, wallet_address) REFERENCES user_wallets(user_id, wallet_address)
);

-- User trading preferences and limits
CREATE TABLE IF NOT EXISTS user_trading_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_position_size numeric DEFAULT 1000,
  max_order_size numeric DEFAULT 100,
  max_daily_volume numeric DEFAULT 5000,
  risk_tolerance text DEFAULT 'conservative', -- conservative, moderate, aggressive
  auto_cancel_orders boolean DEFAULT true,
  email_notifications boolean DEFAULT true,
  push_notifications boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- User sessions for JWT token management
CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token text NOT NULL UNIQUE,
  wallet_address text NOT NULL,
  ip_address text,
  user_agent text,
  is_active boolean DEFAULT true,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now()
);

-- User authentication attempts and security
CREATE TABLE IF NOT EXISTS user_auth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  attempt_type text NOT NULL, -- login, verification, etc.
  success boolean NOT NULL,
  ip_address text,
  user_agent text,
  error_message text,
  created_at timestamptz DEFAULT now()
);

-- User trading statistics
CREATE TABLE IF NOT EXISTS user_trading_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_volume numeric DEFAULT 0,
  total_trades integer DEFAULT 0,
  successful_trades integer DEFAULT 0,
  failed_trades integer DEFAULT 0,
  total_pnl numeric DEFAULT 0,
  last_trade_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id ON user_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_user_wallets_address ON user_wallets(wallet_address);
CREATE INDEX IF NOT EXISTS idx_user_wallets_primary ON user_wallets(user_id, is_primary) WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_venue_creds_user_id ON user_venue_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_venue_creds_wallet ON user_venue_credentials(wallet_address);
CREATE INDEX IF NOT EXISTS idx_venue_creds_venue ON user_venue_credentials(venue);
CREATE INDEX IF NOT EXISTS idx_venue_creds_active ON user_venue_credentials(is_active);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active ON user_sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_wallet ON user_auth_attempts(wallet_address);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_created ON user_auth_attempts(created_at);

CREATE INDEX IF NOT EXISTS idx_trading_stats_user_id ON user_trading_stats(user_id);

-- Triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_wallets_updated_at BEFORE UPDATE ON user_wallets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_venue_creds_updated_at BEFORE UPDATE ON user_venue_credentials FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_trading_prefs_updated_at BEFORE UPDATE ON user_trading_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_trading_stats_updated_at BEFORE UPDATE ON user_trading_stats FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
