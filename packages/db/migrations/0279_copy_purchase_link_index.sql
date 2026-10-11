/* no-transaction */
-- Identity-only link recovery rotates unresolved rows by oldest update, not
-- repair_due_at. Keep its bounded selector independent of evidence retries.
create index concurrently if not exists copy_attributions_pending_link_idx
  on copy_attributions (updated_at, id)
  where copier_user_id is not null and state='pending' and order_id is null and execution_id is null;
