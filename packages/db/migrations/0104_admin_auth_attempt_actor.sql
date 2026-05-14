ALTER TABLE admin_auth_attempts
  ADD COLUMN IF NOT EXISTS actor_admin_id uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_email text,
  ADD COLUMN IF NOT EXISTS actor_role text CHECK (actor_role IS NULL OR actor_role IN ('admin', 'sadmin'));

CREATE INDEX IF NOT EXISTS idx_admin_auth_attempts_actor_created
  ON admin_auth_attempts (actor_admin_id, created_at DESC)
  WHERE actor_admin_id IS NOT NULL;
