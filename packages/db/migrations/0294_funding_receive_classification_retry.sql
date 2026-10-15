-- Scheduling metadata only. Historical transfers are neither reallocated nor
-- assigned an inferred owner by this migration.
alter table funding_receive_canonical_events
  add column classification_receive_session_id uuid
    references funding_receive_sessions(id) on delete restrict,
  add column classification_variant_id text,
  add column classification_retry_at timestamptz,
  add column classification_lease_token uuid;
