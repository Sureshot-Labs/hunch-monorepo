-- Self-declaration only: no date of birth or identity document is collected.
ALTER TABLE users ADD COLUMN IF NOT EXISTS adult_confirmed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS adult_confirmation_version smallint;
ALTER TABLE users ADD CONSTRAINT users_adult_confirmation_check CHECK (
  (adult_confirmed_at IS NULL AND adult_confirmation_version IS NULL) OR
  (adult_confirmed_at IS NOT NULL AND adult_confirmation_version = 1)
) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_adult_confirmation_check;
