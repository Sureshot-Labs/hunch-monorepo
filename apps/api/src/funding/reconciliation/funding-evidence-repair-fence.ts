import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "@hunch/infra";

type Fence = Readonly<{
  operationId: string;
  jobId: string;
  leaseOwner: string;
  leaseToken: string;
  /** null fences a live/legacy observation against the first repair request. */
  generation: number | null;
  now: () => Date;
}>;
const repairFence = new AsyncLocalStorage<Fence>();

export function fundingEvidenceRepairTime(fallback?: Date): Date {
  return repairFence.getStore()?.now() ?? fallback ?? new Date();
}

export class FundingEvidenceRepairFenceLost extends Error {
  constructor() {
    super("evidence repair apply fence is no longer owned");
    this.name = "FundingEvidenceRepairFenceLost";
  }
}

export function isFundingEvidenceRepairFenceLost(error: unknown): boolean {
  return (
    error instanceof FundingEvidenceRepairFenceLost ||
    (error instanceof AggregateError &&
      error.errors.some(isFundingEvidenceRepairFenceLost))
  );
}

/** Carries authority, never database locks, across acquisition I/O. */
export function withFundingEvidenceRepairFence<T>(
  fence: Fence,
  work: () => Promise<T>,
): Promise<T> {
  return repairFence.run(fence, work);
}

/** Provider polls and webhooks share this order even outside repair context.
 * Otherwise a webhook holding its request row could wait for the repair job
 * while a fenced repair held that job and waited for the same request row. */
export async function lockFundingEvidenceRepairApplyOrder(
  client: Pick<PoolClient, "query">,
  operationId: string,
): Promise<void> {
  await client.query(
    `select id from telegram_trade_intents where funding_operation_id=$1 order by id for update`,
    [operationId],
  );
  await client.query(
    `select id from funding_operations where id=$1 for update`,
    [operationId],
  );
  await client.query(
    `select id from funding_reconciliation_jobs where operation_id=$1 for update`,
    [operationId],
  );
}

/** Called at the start of a short apply transaction, before financial row locks
 * or writes. Calls outside a scoped observation have no global fallback. */
export async function assertFundingEvidenceRepairFence(
  client: Pick<PoolClient, "query">,
  operationId?: string,
): Promise<void> {
  const fence = repairFence.getStore();
  if (!fence) return;
  if (operationId !== undefined && operationId !== fence.operationId)
    throw new FundingEvidenceRepairFenceLost();
  await client.query(
    `select id from telegram_trade_intents where funding_operation_id=$1 order by id for update`,
    [fence.operationId],
  );
  const operation = await client.query<{
    generation: number | string | null;
    format_version: number | string | null;
    has_repair_state: boolean;
  }>(
    `select support_metadata->'evidenceRepairV1'->>'generation' as generation,
       support_metadata->'evidenceRepairV1'->>'formatVersion' as format_version,
       support_metadata ? 'evidenceRepairV1' as has_repair_state
       from funding_operations where id=$1 for update`,
    [fence.operationId],
  );
  const row = operation.rows[0];
  if (
    !row ||
    (fence.generation === null
      ? row.has_repair_state
      : String(row.generation) !== String(fence.generation) ||
        String(row.format_version) !== "1")
  )
    throw new FundingEvidenceRepairFenceLost();
  const owned = await client.query(
    `select id from funding_reconciliation_jobs where id=$1 and operation_id=$2
       and status='leased' and lease_owner=$3 and lease_token=$4 and lease_until>$5 for update`,
    [
      fence.jobId,
      fence.operationId,
      fence.leaseOwner,
      fence.leaseToken,
      fence.now(),
    ],
  );
  if (owned.rowCount !== 1) throw new FundingEvidenceRepairFenceLost();
}
