-- Add CSRF tokens to user sessions for double-submit protection.

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS csrf_token text NOT NULL
  DEFAULT encode(gen_random_bytes(32), 'hex');
