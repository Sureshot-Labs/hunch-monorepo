-- PostgreSQL CHECK accepts UNKNOWN. Require all debit fields together rather
-- than relying on a nullable range/regex expression. Existing rows are not a
-- rollout assertion; new/updated submissions enforce the structural invariant.
alter table hip4_order_submissions add constraint hip4_submission_complete_debit_check
  check (num_nonnulls(debit_asset_id,debit_decimals,debit_raw) in (0,3)) not valid;
