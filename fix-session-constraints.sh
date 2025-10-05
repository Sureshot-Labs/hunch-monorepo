#!/bin/bash

# Fix user_sessions constraints directly in the database
# This script removes the composite unique constraint and ensures only session_token is unique

echo "🔧 Fixing user_sessions constraints..."

# Get database URL from .env
source .env

# Apply the fix
psql "$DATABASE_URL" << EOF
-- Remove any composite unique constraints
ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_session_token_user_id_key;

-- Ensure only session_token has a unique constraint
DO \$\$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'user_sessions_session_token_key' 
    AND conrelid = 'user_sessions'::regclass
  ) THEN
    ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_session_token_key UNIQUE (session_token);
  END IF;
END \$\$;

-- Show current constraints
SELECT conname, contype 
FROM pg_constraint 
WHERE conrelid = 'user_sessions'::regclass;

EOF

echo "✅ Constraints fixed!"

