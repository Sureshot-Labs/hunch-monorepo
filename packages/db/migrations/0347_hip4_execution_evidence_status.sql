-- Precise, recoverable provider contradictions, not a coin-wide verdict.
-- Keep every retained original fact. NULL historical rows have no invented
-- conflict/recheck status and require no backfill or data-dependent assertion.
alter table hip4_account_executions
  add column if not exists provider_evidence_status jsonb;
