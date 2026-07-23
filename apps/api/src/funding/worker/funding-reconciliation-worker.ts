import type { Pool } from "@hunch/infra";

import {
  runFundingReconciliationBatch,
  type FundingReconciliationBatchOptions,
  type FundingReconciliationBatchResult,
} from "../reconciliation/funding-reducer.js";

export type FundingReconciliationJobResult =
  | FundingReconciliationBatchResult
  | Readonly<{
      skipped: true;
      skipReason: "funding_schema_not_ready";
      claimed: 0;
      completed: 0;
      requeued: 0;
      failed: 0;
      deadLettered: 0;
      operationIds: readonly [];
    }>;

export async function isFundingReconciliationSchemaReady(
  pool: Pick<Pool, "query">,
): Promise<boolean> {
  const { rows } = await pool.query<{ ready: boolean }>(
    `
      select
        to_regclass('public.funding_operations') is not null
        and to_regclass('public.funding_observations') is not null
        and to_regclass('public.funding_reconciliation_jobs') is not null
        as ready
    `,
  );
  return rows[0]?.ready === true;
}

export async function runFundingReconciliationJob(
  pool: Pool,
  options: FundingReconciliationBatchOptions,
): Promise<FundingReconciliationJobResult> {
  if (!(await isFundingReconciliationSchemaReady(pool))) {
    return {
      skipped: true,
      skipReason: "funding_schema_not_ready",
      claimed: 0,
      completed: 0,
      requeued: 0,
      failed: 0,
      deadLettered: 0,
      operationIds: [],
    };
  }
  return runFundingReconciliationBatch(pool, options);
}

export type {
  FundingReconciliationBatchOptions,
  FundingReconciliationBatchResult,
};
