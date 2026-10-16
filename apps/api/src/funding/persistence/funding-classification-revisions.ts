import type { PoolClient } from "@hunch/infra";

type Database = Pick<PoolClient, "query">;
export type FundingClassificationRevision = Readonly<{
  operationId: string;
  userId: string;
  revision: string;
}>;

export class FundingClassificationChangedError extends Error {
  constructor() {
    super("Funding classification facts changed; restart affected candidate");
    this.name = "FundingClassificationChangedError";
  }
}

export const FUNDING_CLASSIFICATION_REVISION_SQL = `
select coalesce(revision_row.revision,0)::text as revision
from funding_operations operation_row
left join funding_classification_revisions revision_row on revision_row.operation_id=operation_row.id
where operation_row.id=$1::uuid and operation_row.user_id=$2::uuid`;

export const FUNDING_CLASSIFICATION_CURRENT_SET_SQL = `select not exists(
  select 1 from jsonb_array_elements($1::jsonb) expected_fact
  left join lateral (
    select operation_row.user_id,coalesce(revision_row.revision,0)::text as revision
    from funding_operations operation_row
    left join funding_classification_revisions revision_row on revision_row.operation_id=operation_row.id
    where operation_row.id=(expected_fact->>'operationId')::uuid offset 0
  ) current_fact on true
  where current_fact.user_id is distinct from (expected_fact->>'userId')::uuid
    or current_fact.revision is distinct from expected_fact->>'revision'
) as facts_match`;

/** Retry/liveness hint only, never a replacement for O/membership/F. An old
 * completed summary must return to the ordinary page rotation after a failed
 * fence, rather than retrying its stale positive decision forever. No fresh
 * revision is grafted onto its classification: a mismatch rejects that result. */
export async function fundingClassificationRevisionsAreCurrent(
  db: Database,
  expected: readonly FundingClassificationRevision[],
): Promise<boolean> {
  const { rows } = await db.query<{ facts_match: boolean }>(
    FUNDING_CLASSIFICATION_CURRENT_SET_SQL,
    [JSON.stringify(expected)],
  );
  return rows[0]?.facts_match === true;
}

/** Missing facts revision is zero; a missing/deleted/foreign operation is NOT.
 * This is consistency evidence, never proof of a source debit or externality. */
export async function readFundingClassificationRevision(
  db: Database,
  input: Pick<FundingClassificationRevision, "operationId" | "userId">,
): Promise<FundingClassificationRevision | null> {
  const { rows } = await db.query<{ revision: string }>(
    FUNDING_CLASSIFICATION_REVISION_SQL,
    [input.operationId, input.userId],
  );
  return rows[0] ? { ...input, revision: rows[0].revision } : null;
}

/** Every bounded page uses the SAME expected revision. A changed candidate is
 * restarted, not the immutable source-membership enumeration. Call only with
 * committed input (no speculative writes on this connection). A successful page
 * is not allocation authority: all dependencies still need the final fence. */
export async function readFundingClassificationPage<T>(
  db: Database,
  expected: FundingClassificationRevision,
  readPage: (db: Database) => Promise<T>,
): Promise<T> {
  const check = async () => {
    const current = await readFundingClassificationRevision(db, expected);
    if (current?.revision !== expected.revision)
      throw new FundingClassificationChangedError();
  };
  await check();
  const page = await readPage(db);
  await check();
  return page;
}

/** Acquire only AFTER the entire canonical event lock set. Must precede DB-only
 * publication effects. Owner/existence is checked separately from tombstones. */
export async function lockFundingClassificationOperations(
  db: Database,
  expected: readonly FundingClassificationRevision[],
  // Unsupported legacy receive protocols retain their existing classification
  // semantics, but their effect owners must share this same sorted O lock set.
  // Do not invent a facts revision for a classification that never captured it.
  additionalOwners: readonly Pick<
    FundingClassificationRevision,
    "operationId" | "userId"
  >[] = [],
): Promise<void> {
  const unique = new Map<string, FundingClassificationRevision>();
  for (const item of expected) {
    const previous = unique.get(item.operationId);
    if (
      previous &&
      (previous.userId !== item.userId || previous.revision !== item.revision)
    )
      throw new FundingClassificationChangedError();
    unique.set(item.operationId, item);
  }
  const owners = new Map([...unique].map(([id, facts]) => [id, facts.userId]));
  for (const item of additionalOwners) {
    const previous = owners.get(item.operationId);
    if (previous !== undefined && previous !== item.userId)
      throw new FundingClassificationChangedError();
    owners.set(item.operationId, item.userId);
  }
  const { rows } = await db.query<{ id: string; user_id: string }>(
    `select id,user_id from funding_operations
     where id=any($1::uuid[]) order by id for update`,
    [[...owners.keys()]],
  );
  if (
    rows.length !== owners.size ||
    rows.some((row) => owners.get(row.id) !== row.user_id)
  )
    throw new FundingClassificationChangedError();
}

/** Owns transaction completion: there must be NO intervening writes or external
 * IO between the fence and COMMIT. Caller has begun a transaction, locked E -> O
 * with lockFundingClassificationOperations and finished DB-only effects.
 * Do not use inside infra.tx(), or SET CONSTRAINTS ALL IMMEDIATE during writes.
 * A mismatch rolls back every speculative effect. Retry via the existing job;
 * never broadcast/continue a financial action from an unsuccessful transaction.
 * The deferred trigger applies this transaction's own revisions at commit. */
export async function commitFundingClassificationTransaction(
  db: Database,
  expected: readonly FundingClassificationRevision[],
): Promise<void> {
  try {
    const { rows } = await db.query<{ current: boolean }>(
      "select funding_classification_fence($1::jsonb) as current",
      [JSON.stringify(expected)],
    );
    if (rows[0]?.current !== true)
      throw new FundingClassificationChangedError();
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
