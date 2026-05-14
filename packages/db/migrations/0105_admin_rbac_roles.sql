ALTER TABLE admin_accounts
  DROP CONSTRAINT IF EXISTS admin_accounts_role_check;

ALTER TABLE admin_accounts
  ADD CONSTRAINT admin_accounts_role_check
  CHECK (role IS NULL OR role IN ('sadmin', 'admin', 'viewer', 'analyst'));

ALTER TABLE admin_auth_attempts
  DROP CONSTRAINT IF EXISTS admin_auth_attempts_actor_role_check;

ALTER TABLE admin_auth_attempts
  ADD CONSTRAINT admin_auth_attempts_actor_role_check
  CHECK (actor_role IS NULL OR actor_role IN ('sadmin', 'admin', 'viewer', 'analyst'));
