/* no-transaction */
-- Supports bounded legacy collision checks without rewriting any username.
create index concurrently if not exists users_social_legacy_handle_lookup_idx
  on users (lower(username)) where username ~ '^[A-Za-z0-9_]+$';
