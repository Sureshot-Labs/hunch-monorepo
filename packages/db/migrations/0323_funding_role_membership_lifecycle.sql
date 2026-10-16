-- Derived sessionless work only; no financial backfill or historical verdict.
-- The authorized user merge restarts only the two selected owners' headers.
create index funding_role_scan_sessionless_owner_idx
  on funding_receive_refund_scans(user_id,event_id)
  where receive_session_id is null and not cleanup_ready;
