-- No-op migration used to verify deploy-time migrations after the sanitized
-- Secrets Manager env rollout.
DO $$
BEGIN
  NULL;
END $$;
