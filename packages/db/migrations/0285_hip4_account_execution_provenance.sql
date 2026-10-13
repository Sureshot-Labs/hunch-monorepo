-- Preserve original fill evidence for later accounting/attribution. Nullable
-- columns keep older writers compatible and do not invent historical evidence.
ALTER TABLE hip4_account_executions
  ADD COLUMN IF NOT EXISTS provider_fill jsonb,
  ADD COLUMN IF NOT EXISTS provider_fingerprint text;
