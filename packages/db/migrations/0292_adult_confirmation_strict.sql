/* online-validation */
-- SQL CHECK accepts UNKNOWN. Require a non-null version explicitly.
ALTER TABLE users ADD CONSTRAINT users_adult_confirmation_strict_check CHECK (
  (adult_confirmed_at IS NULL AND adult_confirmation_version IS NULL) OR
  (adult_confirmed_at IS NOT NULL AND adult_confirmation_version IS NOT NULL AND adult_confirmation_version = 1)
) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_adult_confirmation_strict_check;
