-- No-op migration used to verify deploy-time migrations run correctly while
-- HUNCH_SECRETS_MODE=optional is enabled.
DO $$
BEGIN
  NULL;
END $$;
