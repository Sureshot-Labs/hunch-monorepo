-- Finalize session-token hardening by removing plaintext token storage.
-- Safe to run once app code reads/writes via session_token_hash.

DO $$
DECLARE
  has_session_token_hash boolean;
  has_session_token boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_sessions'
      AND column_name = 'session_token_hash'
  )
  INTO has_session_token_hash;

  IF NOT has_session_token_hash THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_sessions'
      AND column_name = 'session_token'
  )
  INTO has_session_token;

  IF has_session_token THEN
    UPDATE user_sessions
    SET session_token_hash = encode(
      digest(COALESCE(session_token, gen_random_uuid()::text), 'sha256'),
      'hex'
    )
    WHERE session_token_hash IS NULL;
  ELSE
    UPDATE user_sessions
    SET session_token_hash = encode(digest(gen_random_uuid()::text, 'sha256'), 'hex')
    WHERE session_token_hash IS NULL;
  END IF;

  ALTER TABLE user_sessions
    ALTER COLUMN session_token_hash SET NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_token_hash_unique
    ON user_sessions(session_token_hash);
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_sessions'
      AND column_name = 'session_token'
  ) THEN
    UPDATE user_sessions
    SET session_token = NULL
    WHERE session_token IS NOT NULL;

    DROP INDEX IF EXISTS idx_user_sessions_token;
    ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_session_token_key;
    ALTER TABLE user_sessions DROP COLUMN session_token;
  END IF;
END $$;
