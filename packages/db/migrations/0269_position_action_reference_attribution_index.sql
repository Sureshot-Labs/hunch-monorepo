-- Global, case-insensitive reference attribution. Non-unique: existing
-- provider/settlement identity indexes retain their enforcement semantics.
create index position_action_operations_reference_attribution_idx
  on position_action_operations (lower(submission_fingerprint))
  where submission_fingerprint is not null;
