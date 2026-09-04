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
import { loadFundingLifecycleFactsForOperationInTransaction } from "./funding-lifecycle-facts-repository.js";

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

async function requireFundingLifecycleProjection(
  db: LifecycleReadDb,
  input: Readonly<{ now: Date; operationId: string }>,
): Promise<ProjectedFundingLifecycle> {
  const projected = await loadFundingLifecycleProjectionForOperation(db, input);
  if (!projected) {
    throw new Error(
      `funding operation ${input.operationId} disappeared during lifecycle read`,
    );
  }
  return projected;
}

/**
 * Safety-only account lifecycle reads (merge and deletion) must inspect every
 * operation's facts. A materialized terminal cache is deliberately not a
 * shortcut here: a stale terminal value must never permit deleting or merging
 * a user with money still in flight.
 *
 * This is intentionally a serial read, rather than a hot-path listing
 * primitive. A caller can pass one transaction client, and pg must not receive
 * concurrent queries on that client. Keeping the fact loader as the sole
 * derivation boundary is more important than a clever duplicate aggregate
 * query for these rare, destructive workflows.
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
  const projections: FundingLifecycleOperationProjection[] = [];
  for (const row of operationResult.rows) {
    const projected = await requireFundingLifecycleProjection(db, {
      operationId: row.id,
      now,
    });
    projections.push({
      facts: projected.facts,
      lifecycle: projected.lifecycle,
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
  // This accepts either Pool or PoolClient. Keep it serial so a caller can
  // safely pass a transaction client without concurrent pg queries.
  const projectedOperations: ProjectedFundingOperation[] = [];
  for (const operation of operations) {
    const projected = await requireFundingLifecycleProjection(db, {
      operationId: operation.id,
      now,
    });
    projectedOperations.push({
      operation: withFundingLifecycleProjection(operation, projected.lifecycle),
      lifecycle: projected.lifecycle,
    });
  }
  return projectedOperations;
}
