-- Additive protocol support; no historical writes or data-dependent rollout guards.
-- Bound only to the immutable native pair and its already-owned nonce.
create function funding_native_auth_attempt_bound(
  candidate_step_id uuid, candidate_fingerprint text, candidate_executor text,
  candidate_submission jsonb
) returns boolean language sql stable as $$
  select coalesce(
    candidate_executor = 'relay_hypercore_native_v1'
    and candidate_submission ->> 'version' = '1'
    and candidate_submission ->> 'stage' = 'nonce_mapping'
    and exists (
      select 1 from funding_operation_steps auth_step
      join hyperliquid_nonce_claims nonce_claim
        on nonce_claim.environment = 'mainnet'
       and nonce_claim.signer_address = candidate_submission ->> 'signer'
       and nonce_claim.nonce = case
         when candidate_submission ->> 'nonce' ~ '^(0|[1-9][0-9]{0,15})$'
         then (candidate_submission ->> 'nonce')::bigint
         else null end
      join funding_operation_steps send_step
        on send_step.id = nonce_claim.funding_step_id
       and send_step.depends_on_step_id = auth_step.id
       and send_step.operation_id = auth_step.operation_id
       and send_step.segment_id = auth_step.segment_id
       and send_step.action_fingerprint = nonce_claim.action_fingerprint
      where auth_step.id = candidate_step_id
        and auth_step.executor_id = candidate_executor
        and auth_step.action_fingerprint = candidate_fingerprint
        and auth_step.step_kind = 'signature'
        and auth_step.normalized_action ->> 'networkId' = 'hyperliquid:mainnet'
        and auth_step.normalized_action ->> 'kind' = 'external_handoff'
        and auth_step.normalized_action ->> 'handoffKind' = 'relay_hypercore_nonce_mapping_v1'
        and auth_step.action_validation_result ->> 'validatorId' = candidate_executor
        and auth_step.action_validation_result ->> 'nativeStage' = 'nonce_mapping'
        and auth_step.action_validation_result -> 'valueMoving' = 'false'::jsonb
        and auth_step.action_validation_result ->> 'nativeEnvironment' = 'mainnet'
        and auth_step.action_validation_result ->> 'nativePairFingerprint' = candidate_submission ->> 'pairFingerprint'
        and auth_step.action_validation_result ->> 'nativeNonce' = candidate_submission ->> 'nonce'
        and lower(auth_step.action_validation_result ->> 'signerAddress') = candidate_submission ->> 'signer'
        and auth_step.normalized_action #>> '{payload,expiresAt}' = candidate_submission ->> 'expiresAt'
        and send_step.executor_id = candidate_executor
        and send_step.step_kind = 'external_handoff'
        and send_step.normalized_action ->> 'handoffKind' = 'relay_hypercore_send_asset_v1'
    ), false)
$$;

create or replace function funding_guard_attempt_update()
returns trigger
language plpgsql
as $$
declare
  provider_reference_resolved boolean;
  provider_failure_resolved boolean;
  provider_evidence_recovery_leased boolean;
  bounded_retry_fact_recorded boolean;
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

  -- An interrupted client may first acknowledge uncertainty and only later
  -- obtain the original submission reference. This is not a new attempt.
  if old.outcome = 'ambiguous'
    and old.broadcast_may_have_occurred
    and old.reference_kind is null
    and old.receipt_ref_ciphertext is null
    and old.receipt_ref_lookup_hmac is null
    and old.lookup_key_version is null
    and new.outcome in ('ambiguous', 'submitted')
    and new.broadcast_may_have_occurred
    and new.reference_kind is not null
    and new.receipt_ref_ciphertext is not null
    and new.receipt_ref_lookup_hmac is not null
    and new.lookup_key_version is not null
    and new.finished_at = old.finished_at then
    return new;
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

  bounded_retry_fact_recorded :=
    old.outcome <> 'started'
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
    )
    and exists (
      select 1
      from funding_operation_steps retry_step
      join telegram_funding_authorization_reservations retry_reservation
        on retry_reservation.funding_operation_id = retry_step.operation_id
        or retry_reservation.cleanup_operation_id = retry_step.operation_id
      join telegram_funding_authorizations funding_authorization
        on funding_authorization.id = retry_reservation.authorization_id
       and funding_authorization.profile_id = retry_step.executor_id
      where retry_step.id = old.step_id
        and old.attempt_number = 1
        and not exists (
          select 1 from funding_operation_step_attempts newer_attempt
          where newer_attempt.step_id = old.step_id
            and newer_attempt.attempt_number > old.attempt_number
        )
        and (
          (
            retry_step.action_validation_result ->> 'relayStepKind'
              in ('approve', 'deposit')
            and retry_reservation.funding_operation_id = retry_step.operation_id
            and retry_reservation.status = 'reserved'
            and old.outcome = 'failed'
            and not old.broadcast_may_have_occurred
            and coalesce(old.actual_costs ->> 'reasonCode', '') not in (
              'delegated_action_invalid', 'delegated_authority_invalid',
              'delegated_profile_invalid', 'delegated_profile_unavailable',
              'delegated_quote_expired', 'delegated_route_changed',
              'funding_policy_changed'
            )
            and old.actual_costs ->> 'retryableProviderFailure' is distinct from 'true'
            and new.actual_costs = old.actual_costs || '{"retryableProviderFailure":true}'::jsonb
          )
          or (
            retry_step.action_validation_result ->> 'relayStepKind' = 'cleanup'
            and retry_reservation.cleanup_operation_id = retry_step.operation_id
            and retry_reservation.status = 'cleanup_required'
            and old.outcome in ('submitted', 'ambiguous')
            and old.broadcast_may_have_occurred
            and old.actual_costs ->> 'retryableAfterReorg' is distinct from 'true'
            and new.actual_costs = old.actual_costs || '{"retryableAfterReorg":true}'::jsonb
            and exists (
              select 1 from funding_step_receipt_observations retry_receipt
              where retry_receipt.attempt_id = old.id
                and retry_receipt.status = 'reorged'
                and not retry_receipt.canonical
                and retry_receipt.reorged_at <= clock_timestamp() - interval '15 minutes'
            )
          )
        )
    );

  if provider_reference_resolved
    or provider_failure_resolved
    or provider_evidence_recovery_leased
    or bounded_retry_fact_recorded then
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
  -- A nonce mapping only registers authorization; it cannot send assets.
  -- Permit exactly one server admission metadata transition, with no receipt,
  -- money ambiguity or change to the prepared identity/deadline.
  if old.outcome = 'started' and new.outcome = 'started'
    and not old.broadcast_may_have_occurred and not new.broadcast_may_have_occurred
    and old.reference_kind is null and new.reference_kind is null
    and old.receipt_ref_ciphertext is null and new.receipt_ref_ciphertext is null
    and old.receipt_ref_lookup_hmac is null and new.receipt_ref_lookup_hmac is null
    and old.lookup_key_version is null and new.lookup_key_version is null
    and old.finished_at is null and new.finished_at is null
    and old.actual_costs #>> '{nativeSubmission,phase}' = 'prepared'
    and new.actual_costs #>> '{nativeSubmission,phase}' = 'admitted'
    and jsonb_typeof(new.actual_costs #> '{nativeSubmission,admittedAt}') = 'string'
    and new.actual_costs #>> '{nativeSubmission,requestFingerprint}' ~ '^[a-f0-9]{64}$'
    and new.actual_costs = jsonb_set(old.actual_costs, '{nativeSubmission}',
      old.actual_costs -> 'nativeSubmission' || jsonb_build_object(
        'phase', 'admitted',
        'admittedAt', new.actual_costs #> '{nativeSubmission,admittedAt}',
        'requestFingerprint', new.actual_costs #> '{nativeSubmission,requestFingerprint}'
      ))
    and funding_native_auth_attempt_bound(old.step_id, old.canonical_action_fingerprint,
      old.executor_id, old.actual_costs -> 'nativeSubmission')
  then
    return new;
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
