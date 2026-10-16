-- The same physical-event checkpoint may be advanced by an existing provider
-- reconciliation job before any receive session exists. These nullable fields
-- record provenance, not financial authority. No new queue or backfill.
alter table funding_receive_refund_scans
  alter column receive_session_id drop not null,
  alter column variant_id drop not null,
  add constraint funding_role_scan_session_pair check (
    (receive_session_id is null) = (variant_id is null)
  );
