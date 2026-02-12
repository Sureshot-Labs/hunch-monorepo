-- Distinguish personal portfolio rows from followed-wallet rows in positions.

ALTER TABLE positions
ADD COLUMN IF NOT EXISTS position_scope text NOT NULL DEFAULT 'own';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'positions_position_scope_check'
  ) THEN
    ALTER TABLE positions
      ADD CONSTRAINT positions_position_scope_check
      CHECK (position_scope IN ('own', 'followed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_positions_user_scope
  ON positions(user_id, position_scope);

CREATE INDEX IF NOT EXISTS idx_positions_user_scope_wallet_venue
  ON positions(user_id, position_scope, wallet_address, venue);
