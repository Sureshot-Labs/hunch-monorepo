-- Store auth session tokens as SHA-256 hash at rest.
-- Compatibility strategy:
-- - keep legacy session_token column for a short migration window,
-- - all new writes should use session_token_hash,
-- - drop legacy token index/constraint and relax NOT NULL.

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS session_token_hash text;

UPDATE user_sessions
SET
  session_token_hash = encode(
    digest(COALESCE(session_token, gen_random_uuid()::text), 'sha256'),
    'hex'
  ),
  is_active = CASE WHEN session_token IS NULL THEN false ELSE is_active END
WHERE session_token_hash IS NULL;

ALTER TABLE user_sessions
  ALTER COLUMN session_token_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_token_hash_unique
  ON user_sessions(session_token_hash);

DROP INDEX IF EXISTS idx_user_sessions_token;
ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_session_token_key;
ALTER TABLE user_sessions ALTER COLUMN session_token DROP NOT NULL;

-- Reduce plaintext footprint immediately for sessions that are already invalid.
UPDATE user_sessions
SET session_token = NULL
WHERE session_token IS NOT NULL
  AND (is_active = false OR expires_at <= now());
