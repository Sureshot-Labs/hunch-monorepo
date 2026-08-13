-- Permit one durable, monotonic evidence-recovery lease marker while keeping
-- every provider-boundary field immutable. The generic updated_at trigger is
-- not sufficient as a first-claim marker because it is also touched by the
-- initial provider-boundary transition.

create or replace function funding_guard_attempt_update()
returns trigger
language plpgsql
as $$
declare
  provider_reference_resolved boolean;
  provider_failure_resolved boolean;
  provider_evidence_recovery_leased boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'funding operation attempts are append-only'
      using errcode = '23514';
  end if;
  if (
    new.step_id,
    new.attempt_number,
    new.canonical_action_fingerprint,
    new.executor_id,
    new.started_at,
    new.created_at
  ) is distinct from (
    old.step_id,
    old.attempt_number,
    old.canonical_action_fingerprint,
    old.executor_id,
    old.started_at,
    old.created_at
  ) then
    raise exception 'funding operation attempt identity is immutable'
      using errcode = '23514';
  end if;

  provider_reference_resolved :=
    old.outcome = 'ambiguous'
    and old.broadcast_may_have_occurred
    and old.reference_kind = 'provider_receipt'
    and old.receipt_ref_ciphertext is not null
    and old.receipt_ref_lookup_hmac is not null
    and old.lookup_key_version is not null
    and new.outcome = 'ambiguous'
    and new.broadcast_may_have_occurred
    and new.reference_kind = 'transaction'
    and new.receipt_ref_ciphertext is not null
    and new.receipt_ref_lookup_hmac is not null
    and new.lookup_key_version is not null
    and new.actual_costs = old.actual_costs
    and new.finished_at = old.finished_at;

  provider_failure_resolved :=
    old.outcome = 'ambiguous'
    and old.broadcast_may_have_occurred
    and old.reference_kind = 'provider_receipt'
    and old.receipt_ref_ciphertext is not null
    and old.receipt_ref_lookup_hmac is not null
    and old.lookup_key_version is not null
    and new.outcome = 'failed'
    and not new.broadcast_may_have_occurred
    and new.reference_kind is null
    and new.receipt_ref_ciphertext is null
    and new.receipt_ref_lookup_hmac is null
    and new.lookup_key_version is null
    and new.finished_at = old.finished_at;

  provider_evidence_recovery_leased :=
    old.outcome = 'ambiguous'
    and old.broadcast_may_have_occurred
    and old.reference_kind = 'provider_receipt'
    and old.receipt_ref_ciphertext is not null
    and old.receipt_ref_lookup_hmac is not null
    and old.lookup_key_version is not null
    and not (old.actual_costs ? 'providerEvidenceRecoveryClaimedAt')
    and jsonb_typeof(
      new.actual_costs -> 'providerEvidenceRecoveryClaimedAt'
    ) = 'string'
    and new.actual_costs = old.actual_costs || jsonb_build_object(
      'providerEvidenceRecoveryClaimedAt',
      new.actual_costs -> 'providerEvidenceRecoveryClaimedAt'
    )
    and (
      new.outcome,
      new.broadcast_may_have_occurred,
      new.reference_kind,
      new.receipt_ref_ciphertext,
      new.receipt_ref_lookup_hmac,
      new.lookup_key_version,
      new.finished_at
    ) is not distinct from (
      old.outcome,
      old.broadcast_may_have_occurred,
      old.reference_kind,
      old.receipt_ref_ciphertext,
      old.receipt_ref_lookup_hmac,
      old.lookup_key_version,
      old.finished_at
    );

  if provider_reference_resolved
    or provider_failure_resolved
    or provider_evidence_recovery_leased then
    return new;
  end if;

  if old.outcome <> 'started' and (
    new.outcome,
    new.broadcast_may_have_occurred,
    new.reference_kind,
    new.receipt_ref_lookup_hmac,
    new.lookup_key_version,
    new.actual_costs,
    new.finished_at
  ) is distinct from (
    old.outcome,
    old.broadcast_may_have_occurred,
    old.reference_kind,
    old.receipt_ref_lookup_hmac,
    old.lookup_key_version,
    old.actual_costs,
    old.finished_at
  ) then
    raise exception 'finished funding operation attempt cannot be rewritten'
      using errcode = '23514';
  end if;
  if old.outcome <> 'started'
    and new.receipt_ref_ciphertext is distinct from old.receipt_ref_ciphertext
    and new.receipt_ref_ciphertext is not null then
    raise exception 'attempt receipt ciphertext cannot be rewritten or restored'
      using errcode = '23514';
  end if;
  if old.outcome = 'started' and new.outcome = 'started' and (
    new.broadcast_may_have_occurred,
    new.reference_kind,
    new.receipt_ref_ciphertext,
    new.receipt_ref_lookup_hmac,
    new.lookup_key_version,
    new.actual_costs,
    new.finished_at
  ) is distinct from (
    old.broadcast_may_have_occurred,
    old.reference_kind,
    old.receipt_ref_ciphertext,
    old.receipt_ref_lookup_hmac,
    old.lookup_key_version,
    old.actual_costs,
    old.finished_at
  ) then
    raise exception 'started funding operation attempt cannot record terminal evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
