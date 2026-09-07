import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";

export type StandaloneReconciliationKind = "preparation" | "position_action";
export type StandaloneReconciliationLease = Readonly<{
  kind: StandaloneReconciliationKind;
  id: string;
  userId: string;
  leaseToken: string;
}>;

const TABLES = {
  preparation: "funding_preparation_runs",
  position_action: "position_action_operations",
} as const;

const CANDIDATES = {
  preparation: "candidate_row.status in ('submitted', 'ambiguous')",
  position_action: `candidate_row.action = 'redeem' and (
    candidate_row.status in ('submitting', 'submitted', 'confirmed')
    or (candidate_row.status = 'reconcile_required' and (
      candidate_row.submission_fingerprint is not null
      or candidate_row.last_error_code is distinct from
        'position_action_submission_reference_missing'
    ))
    or (candidate_row.status = 'completed' and exists (
      select 1 from position_action_effects pending_effect
       where pending_effect.action_operation_id = candidate_row.id
         and pending_effect.status <> 'completed'
         and pending_effect.next_attempt_at <= $1
    ))
  )`,
} as const;

/** Static table names only. These leases never grant submission authority. */
export async function claimStandaloneReconciliation(
  db: Pick<Pool, "query">,
  input: Readonly<{
    kind: StandaloneReconciliationKind;
    limit: number;
    now: Date;
    leaseMs: number;
  }>,
): Promise<readonly StandaloneReconciliationLease[]> {
  const table = TABLES[input.kind];
  const leaseToken = randomUUID();
  const result = await db.query<{ id: string; user_id: string }>(
    `with candidate_rows as (
       select candidate_row.id
         from ${table} candidate_row
        where ${CANDIDATES[input.kind]}
          and candidate_row.reconciliation_next_attempt_at <= $1
          and (candidate_row.reconciliation_lease_until is null
            or candidate_row.reconciliation_lease_until <= $1)
        order by candidate_row.reconciliation_next_attempt_at, candidate_row.id
        limit $2
        for update skip locked
     )
     update ${table} target_row
        set reconciliation_lease_token = $3,
            reconciliation_lease_until = $4
       from candidate_rows
      where target_row.id = candidate_rows.id
      returning target_row.id, target_row.user_id`,
    [
      input.now,
      Math.max(1, Math.min(25, Math.trunc(input.limit))),
      leaseToken,
      new Date(input.now.getTime() + input.leaseMs),
    ],
  );
  return result.rows.map((row) => ({
    kind: input.kind,
    id: row.id,
    userId: row.user_id,
    leaseToken,
  }));
}

export async function finishStandaloneReconciliation(
  db: Pick<Pool, "query">,
  input: Readonly<{
    lease: StandaloneReconciliationLease;
    retryAt: Date;
  }>,
): Promise<boolean> {
  const result = await db.query(
    `update ${TABLES[input.lease.kind]}
        set reconciliation_next_attempt_at = $3,
            reconciliation_lease_until = null,
            reconciliation_lease_token = null
      where id = $1 and reconciliation_lease_token = $2`,
    [input.lease.id, input.lease.leaseToken, input.retryAt],
  );
  return result.rowCount === 1;
}

export async function standaloneReconciliationSchemaReady(
  db: Pick<Pool, "query">,
): Promise<boolean> {
  const result = await db.query<{ ready: boolean }>(
    `select count(*) = 6 as ready
       from information_schema.columns
      where table_schema = 'public'
        and table_name in ('funding_preparation_runs', 'position_action_operations')
        and column_name in ('reconciliation_next_attempt_at',
          'reconciliation_lease_until', 'reconciliation_lease_token')`,
  );
  return result.rows[0]?.ready === true;
}
