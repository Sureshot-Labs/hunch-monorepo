import type { Pool, PoolClient } from "@hunch/infra";
import { createHash } from "node:crypto";

/** A deterministic derived-work item under ONE existing job lease. Not a new
 * lease, financial nonce or authority. Last-token suppression is not a durable
 * seen-set: an older replay may advance derived work again. The per-invocation
 * page cap/deadline still apply; exact E/O/U/F gates all monetary effects. */
export function fundingEvidencePageToken(input: {
  progressToken: string;
  eventFingerprint: string;
  pageOrdinal: number;
}): string {
  if (!Number.isSafeInteger(input.pageOrdinal) || input.pageOrdinal < 0)
    throw new Error("Invalid funding evidence page ordinal");
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        "funding-role-page-v1",
        input.progressToken,
        input.eventFingerprint,
        input.pageOrdinal,
      ]),
    )
    .digest("hex");
  // RFC 9562 custom (v8) UUID; its digest contains no wallet/provider payload.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class FundingEvidenceBudgetExpiredError extends Error {
  constructor() {
    super("Funding evidence work reached its existing job deadline");
    this.name = "FundingEvidenceBudgetExpiredError";
  }
}

/** Existing worker split: provider inspection uses half the remaining lease,
 * leaving the same lease's other half for persistence/reduction. Not a timer,
 * policy threshold, second lease or authority to execute anything. */
export function fundingEvidenceReadDeadline(
  deadlineMs: number,
  now = Date.now(),
): number {
  if (!Number.isFinite(deadlineMs))
    throw new FundingEvidenceBudgetExpiredError();
  return now + Math.max(0, (deadlineMs - now) / 2);
}

/** The caller has already begun READ COMMITTED. Transaction-local limits never
 * leak to a later borrower. PostgreSQL 16 has per-statement/lock limits, not an
 * absolute transaction deadline, so refresh the remaining budget per query. */
export async function setFundingEvidenceQueryBudget(
  db: Pick<PoolClient, "query">,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<void> {
  const remainingMs = Math.ceil(deadlineMs - now());
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0)
    throw new FundingEvidenceBudgetExpiredError();
  // PostgreSQL's millisecond GUC representation is a signed int32. This is a
  // protocol bound, not a product timeout or a replacement for runtime policy.
  const timeout = String(Math.min(remainingMs, 2_147_483_647));
  await db.query(
    "select set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
    [timeout],
  );
}

/** Use ONLY after raw BEGIN + SET TRANSACTION and before the final F/COMMIT.
 * Cleanup and the fence/COMMIT pair must use the original client. In particular
 * an expired wrapper must never prevent ROLLBACK or insert SQL after final F. */
export function fundingEvidenceBudgetClient(
  db: PoolClient,
  deadlineMs: number,
  now: () => number = Date.now,
): PoolClient {
  return new Proxy(db, {
    get(target, key) {
      if (key === "query")
        return async (sql: string, values?: unknown[]) => {
          await setFundingEvidenceQueryBudget(target, deadlineMs, now);
          return target.query(sql, values);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Short DB-only evidence reads/admission, never provider IO. Use a dedicated
 * transaction so the job's shrinking statement/lock limits do not leak through
 * the pool or keep a budget-row lock while a transport is running. */
export async function withFundingEvidenceReadBudget<T>(
  pool: Pool,
  deadlineMs: number,
  read: (db: PoolClient) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs)
    throw new FundingEvidenceBudgetExpiredError();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await read(fundingEvidenceBudgetClient(client, deadlineMs));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
