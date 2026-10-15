/** Exact server-created cancellation marker. A client failed/cancelled report,
 * expiry or terminal operation is NOT proof that an issued action never ran.
 * Callers must additionally bind the attempt to its step and require no receipt.
 * Aliases are code-owned and constrained, never supplied by a request. */
export function fundingSyntheticUnissuedAttemptSql(
  attemptAlias: "attempt" | "attempt_row",
): string {
  return `(${attemptAlias}.outcome='cancelled'
    and not ${attemptAlias}.broadcast_may_have_occurred
    and ${attemptAlias}.actual_costs='{"reasonCode":"cancelled_after_safe_evidence"}'::jsonb
    and ${attemptAlias}.reference_kind is null
    and ${attemptAlias}.receipt_ref_ciphertext is null
    and ${attemptAlias}.receipt_ref_lookup_hmac is null
    and ${attemptAlias}.lookup_key_version is null
    and ${attemptAlias}.started_at=${attemptAlias}.finished_at)`;
}

/** Exact server-owned never-issued proofs for the receive handoff reader.
 * Applied BEFORE its candidate sentinel so harmless history cannot starve a
 * later issued attempt. A receipt/reference always defeats this exclusion.
 * Aliases here are fixed by the owning query, not caller/request controlled.
 */
export function fundingNeverIssuedHandoffSql(): string {
  return `(receipt.id is null
    and attempt.canonical_action_fingerprint=step.action_fingerprint
    and attempt.executor_id=step.executor_id
    and (${fundingSyntheticUnissuedAttemptSql("attempt")}
      or (step.normalized_action->>'handoffKind'='polymarket_safe_transfer'
        and step.executor_id='polymarket_safe_relayer_v1'
        and attempt.outcome in ('failed','cancelled')
        and not attempt.broadcast_may_have_occurred
        and attempt.reference_kind is null
        and attempt.receipt_ref_ciphertext is null
        and attempt.receipt_ref_lookup_hmac is null
        and attempt.lookup_key_version is null
        and attempt.actual_costs->'safeSubmission'->'version'='1'::jsonb
        and attempt.actual_costs->'safeSubmission'->>'phase'='closed'
        and attempt.actual_costs->'safeSubmission'->>'expiresAt'
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        and pg_input_is_valid(attempt.actual_costs->'safeSubmission'->>'expiresAt','timestamp with time zone')
        and not ((attempt.actual_costs->'safeSubmission') ?|
          array['admittedAt','requestFingerprint','safeNonce','safeTransactionHash']))))`;
}
