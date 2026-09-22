import type { PoolClient } from "@hunch/infra";

/** Only negotiated register-before-broadcast clients may receive this lease. */
export type SolanaPreparation = Readonly<{
  version: 1;
  expiresAt: string;
}>;

export function isExpiredSolanaPreparation(value: unknown, now: Date): boolean {
  if (!value || typeof value !== "object") return false;
  const lease = value as Record<string, unknown>;
  return (
    lease.version === 1 &&
    typeof lease.expiresAt === "string" &&
    Number.isFinite(Date.parse(lease.expiresAt)) &&
    Date.parse(lease.expiresAt) <= now.getTime()
  );
}

/** Caller holds the operation lock, also used by signed-transaction registration.
 * Registration wins => never close it. Closure wins => registration rejects the
 * terminal attempt, so the negotiated client cannot broadcast a late signature.
 * Legacy attempts deliberately cannot be inferred from signing context alone.
 */
export async function closeExpiredSolanaPreparationsInTransaction(
  client: PoolClient,
  operationId: string,
  now: Date,
): Promise<boolean> {
  const result = await client.query<{
    id: string;
    actual_costs: Record<string, unknown>;
  }>(
    `select attempt_row.id, attempt_row.actual_costs
       from funding_operation_steps step_row
       join funding_operation_step_attempts attempt_row on attempt_row.step_id=step_row.id
      where step_row.operation_id=$1
        and step_row.executor_id='wallet_profile_svm_v1'
        and step_row.normalized_action->>'kind'='svm_transaction'
        and attempt_row.outcome='started'
        and not attempt_row.broadcast_may_have_occurred
        and attempt_row.reference_kind is null
        and attempt_row.receipt_ref_ciphertext is null
        and attempt_row.receipt_ref_lookup_hmac is null
        and attempt_row.actual_costs ? 'solanaPreparation'
        and not (attempt_row.actual_costs ? 'verifiedSolanaSubmission')
      order by step_row.ordinal,attempt_row.attempt_number
      for update of step_row,attempt_row`,
    [operationId],
  );
  let changed = false;
  for (const row of result.rows) {
    if (!isExpiredSolanaPreparation(row.actual_costs.solanaPreparation, now))
      continue;
    await client.query(
      `update funding_operation_step_attempts
          set outcome='cancelled',finished_at=$2,
              actual_costs=actual_costs || $3::jsonb
        where id=$1`,
      [row.id, now, { reasonCode: "solana_pre_submit_lease_expired" }],
    );
    changed = true;
  }
  return changed;
}
