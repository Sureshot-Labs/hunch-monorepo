-- Fix user_sessions constraints
-- Remove any composite unique constraints and keep only the session_token unique constraint

-- Drop the composite unique constraint if it exists
ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_session_token_user_id_key;

-- Ensure only session_token has a unique constraint
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'user_sessions_session_token_key' 
    AND conrelid = 'user_sessions'::regclass
  ) THEN
    ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_session_token_key UNIQUE (session_token);
  END IF;
END $$;

