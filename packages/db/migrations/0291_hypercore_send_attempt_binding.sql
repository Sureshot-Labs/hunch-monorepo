-- Additive exact native send binding for common cancellation/lifecycle reads.
-- No historical mutations, receipt fabrication or broadened attempt transitions.
create function funding_native_send_attempt_bound(
  candidate_step_id uuid, candidate_fingerprint text, candidate_executor text,
  candidate_submission jsonb
) returns boolean language sql stable as $$
  select coalesce(
    candidate_executor='relay_hypercore_native_v1'
    and candidate_submission->>'stage'='send_asset'
    and exists (
      select 1 from funding_operation_steps send_step
      join hyperliquid_nonce_claims nonce_claim
        on nonce_claim.funding_step_id=send_step.id
       and nonce_claim.action_fingerprint=send_step.action_fingerprint
      join funding_operation_steps auth_step
        on auth_step.id=send_step.depends_on_step_id
       and auth_step.operation_id=send_step.operation_id
       and auth_step.segment_id=send_step.segment_id
      where send_step.id=candidate_step_id
        and send_step.action_fingerprint=candidate_fingerprint
        and send_step.executor_id=candidate_executor
        and send_step.step_kind='external_handoff'
        and send_step.normalized_action->>'networkId'='hyperliquid:mainnet'
        and send_step.normalized_action->>'kind'='external_handoff'
        and send_step.normalized_action->>'handoffKind'='relay_hypercore_send_asset_v1'
        and send_step.action_validation_result->>'validatorId'=candidate_executor
        and send_step.action_validation_result->>'nativeStage'='send_asset'
        and send_step.action_validation_result->'valueMoving'='true'::jsonb
        and send_step.action_validation_result->>'nativePairFingerprint'=candidate_submission->>'pairFingerprint'
        and send_step.action_validation_result->>'nativeNonce'=candidate_submission->>'nonce'
        and send_step.normalized_action#>>'{payload,expiresAt}'=candidate_submission->>'expiresAt'
        and funding_native_auth_attempt_bound(auth_step.id,auth_step.action_fingerprint,auth_step.executor_id,
          candidate_submission || '{"stage":"nonce_mapping"}'::jsonb)
    ), false)
$$;
