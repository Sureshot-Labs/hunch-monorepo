-- An EntryPoint transaction may settle distinct owners/positions in one bundle.
-- Keep provider references unique, but scope canonical EVM hashes to the
-- redemption identity. Each new index is a relaxation of the existing index;
-- historical rows need no cleanup or data-dependent rollout assertion.
create unique index position_action_operations_provider_reference_unique
  on position_action_operations (venue_id, submission_fingerprint)
  where submission_fingerprint is not null
    and submission_fingerprint !~* '^0x[0-9a-f]{64}$';

create unique index position_action_operations_evm_reference_identity_unique
  on position_action_operations (
    venue_id,
    submission_fingerprint,
    lower(owner_address),
    (coalesce(regexp_replace(plan_snapshot->>'tokenId', '^limitless:', ''), ''))
  )
  where submission_fingerprint ~* '^0x[0-9a-f]{64}$';

drop index position_action_operations_submission_unique;
