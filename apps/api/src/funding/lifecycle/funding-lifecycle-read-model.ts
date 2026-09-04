import type { Pool, PoolClient } from "@hunch/infra";

import {
  fetchFundingOperationForUser,
  listFundingOperationsForUser,
  type FundingOperationRow,
} from "../persistence/funding-operation-repository.js";
import {
  deriveFundingLifecycle,
  type FundingLifecycleFacts,
  type FundingLifecycleProjection,
} from "./funding-lifecycle-projector.js";
import {
  loadFundingLifecycleFactsForOperationInTransaction,
  loadFundingLifecycleFactsForOperationsInTransaction,
} from "./funding-lifecycle-facts-repository.js";

type LifecycleReadDb = Pick<Pool | PoolClient, "query">;

/**
 * Combines immutable operation identity/accounting fields with the current
 * lifecycle projection. The stored status fields are a write-through response
 * cache only; callers that need to present or act on current lifecycle state
 * must use this read model instead of the raw operation row.
 */
export type ProjectedFundingOperation = Readonly<{
  operation: FundingOperationRow;
  lifecycle: FundingLifecycleProjection;
}>;

export type ProjectedFundingLifecycle = Readonly<{
  facts: FundingLifecycleFacts;
  lifecycle: FundingLifecycleProjection;
}>;

export type FundingLifecycleOperationProjection = Readonly<{
  facts: FundingLifecycleFacts;
  lifecycle: FundingLifecycleProjection;
  operationId: string;
}>;

/**
 * Shared unscoped fact-to-projection boundary for internal workers. Callers
 * must still apply their own user/authorization predicate before acting on the
 * returned operation ID; this function only prevents cache state from being a
 * lifecycle input.
 */
export async function loadFundingLifecycleProjectionForOperation(
  db: LifecycleReadDb,
  input: Readonly<{ now?: Date; operationId: string }>,
): Promise<ProjectedFundingLifecycle | null> {
  const facts = await loadFundingLifecycleFactsForOperationInTransaction(db, {
    operationId: input.operationId,
    now: input.now ?? new Date(),
  });
  return facts ? { facts, lifecycle: deriveFundingLifecycle(facts) } : null;
}

/**
 * Safety-only account lifecycle reads (merge and deletion) must inspect every
 * operation's facts. A materialized terminal cache is deliberately not a
 * shortcut here: a stale terminal value must never permit deleting or merging
 * a user with money still in flight.
 *
 * A caller can pass one transaction client, so the shared fact loader keeps
 * its set queries serial. It still projects every operation from the same
 * bounded fact boundary instead of trusting a terminal cache or issuing an
 * N+1 query sequence in a destructive workflow.
 */
export async function listFundingLifecycleProjectionsForUsers(
  db: LifecycleReadDb,
  input: Readonly<{ now?: Date; userIds: readonly string[] }>,
): Promise<readonly FundingLifecycleOperationProjection[]> {
  if (input.userIds.length === 0) return [];
  const operationResult = await db.query<{ id: string }>(
    `select operation_row.id::text as id
       from funding_operations operation_row
      where operation_row.user_id = any($1::uuid[])
      order by operation_row.created_at asc, operation_row.id asc`,
    [Array.from(input.userIds)],
  );
  const now = input.now ?? new Date();
  const factsByOperation =
    await loadFundingLifecycleFactsForOperationsInTransaction(db, {
      now,
      operationIds: operationResult.rows.map((row) => row.id),
    });
  const projections: FundingLifecycleOperationProjection[] = [];
  for (const row of operationResult.rows) {
    const facts = factsByOperation.get(row.id);
    if (!facts) {
      throw new Error(
        `funding operation ${row.id} disappeared during lifecycle read`,
      );
    }
    projections.push({
      facts,
      lifecycle: deriveFundingLifecycle(facts),
      operationId: row.id,
    });
  }
  return projections;
}

function withFundingLifecycleProjection(
  operation: FundingOperationRow,
  lifecycle: FundingLifecycleProjection,
): FundingOperationRow {
  return {
    ...operation,
    errorCode: lifecycle.errorCode,
    progressStage: lifecycle.progressStage,
    recoveryMode: lifecycle.recoveryMode,
    status: lifecycle.status,
  };
}

export async function loadProjectedFundingOperationForUser(
  db: LifecycleReadDb,
  input: Readonly<{ now?: Date; operationId: string; userId: string }>,
): Promise<ProjectedFundingOperation | null> {
  const operation = await fetchFundingOperationForUser(db, input);
  if (!operation) return null;
  const projected = await loadFundingLifecycleProjectionForOperation(db, {
    operationId: operation.id,
    now: input.now,
  });
  if (!projected) return null;
  return {
    operation: withFundingLifecycleProjection(operation, projected.lifecycle),
    lifecycle: projected.lifecycle,
  };
}

export async function listProjectedFundingOperationsForUser(
  db: LifecycleReadDb,
  input: Readonly<{
    beforeCreatedAt?: Date | null;
    limit: number;
    now?: Date;
    userId: string;
  }>,
): Promise<readonly ProjectedFundingOperation[]> {
  const operations = await listFundingOperationsForUser(db, input);
  const now = input.now ?? new Date();
  const factsByOperation =
    await loadFundingLifecycleFactsForOperationsInTransaction(db, {
      now,
      operationIds: operations.map((operation) => operation.id),
    });
  // This accepts either Pool or PoolClient. The fact loader uses a bounded,
  // serial sequence of set queries, so it remains transaction-safe without
  // turning one history page into a per-operation N+1.
  const projectedOperations: ProjectedFundingOperation[] = [];
  for (const operation of operations) {
    const facts = factsByOperation.get(operation.id);
    if (!facts) {
      throw new Error(
        `funding operation ${operation.id} disappeared during lifecycle read`,
      );
    }
    const lifecycle = deriveFundingLifecycle(facts);
    projectedOperations.push({
      operation: withFundingLifecycleProjection(operation, lifecycle),
      lifecycle,
    });
  }
  return projectedOperations;
}
