import type { PoolClient } from "pg";

import type { DbQuery } from "../db.js";
import { PrivyService, PrivyUserNotFoundError } from "../privy-service.js";
import { fetchUserFinancialLifecycleSummary } from "./user-financial-lifecycle.js";

type ReconciliationDb = DbQuery & {
  connect: () => Promise<PoolClient>;
};

type PrivyDeletionDependencies = Readonly<{
  deletePrivyUser: (privyUserId: string) => Promise<void>;
}>;

const dependenciesDefault: PrivyDeletionDependencies = {
  deletePrivyUser: (privyUserId) => PrivyService.deleteUser(privyUserId),
};

export type PrivyDeletionReconciliationSummary = Readonly<{
  activeMovement: number;
  busy: number;
  completed: number;
  failed: number;
  hardDeleted: number;
  inspected: number;
  retained: number;
  skipped: number;
}>;

async function isSchemaReady(db: DbQuery): Promise<boolean> {
  const { rows } = await db.query<{ ready: boolean }>(
    `
      select
        to_regclass('public.users') is not null
        and exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'users'
            and column_name = 'privy_deletion_pending'
        ) as ready
    `,
  );
  return rows[0]?.ready === true;
}

async function reconcileOne(
  db: ReconciliationDb,
  userId: string,
  dependencies: PrivyDeletionDependencies,
): Promise<
  "active_movement" | "busy" | "hard_deleted" | "retained" | "skipped"
> {
  const client = await db.connect();
  const lockKey = `privy-user-deletion:${userId}`;
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [lockKey],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return "busy";

    const { rows } = await client.query<{
      privy_deletion_pending: boolean;
      privy_user_id: string | null;
    }>(
      `
        select privy_user_id, privy_deletion_pending
        from users
        where id = $1
        limit 1
      `,
      [userId],
    );
    const user = rows[0];
    if (!user || !user.privy_deletion_pending) return "skipped";
    if (!user.privy_user_id) {
      await client.query(
        `
          update users
          set privy_deletion_pending = false,
              updated_at = now()
          where id = $1
        `,
        [userId],
      );
      return "retained";
    }

    const before = await fetchUserFinancialLifecycleSummary(client, [userId]);
    if (before.activeMovement) return "active_movement";

    try {
      await dependencies.deletePrivyUser(user.privy_user_id);
    } catch (error) {
      if (!(error instanceof PrivyUserNotFoundError)) throw error;
    }

    const after = await fetchUserFinancialLifecycleSummary(client, [userId]);
    if (!after.protectedEvidence) {
      try {
        const deleted = await client.query(
          `
            delete from users
            where id = $1
              and privy_deletion_pending = true
              and privy_user_id = $2
          `,
          [userId, user.privy_user_id],
        );
        if ((deleted.rowCount ?? 0) > 0) return "hard_deleted";
      } catch {
        // A newly introduced protected FK must retain the pseudonymized row.
      }
    }
    await client.query(
      `
        update users
        set privy_user_id = null,
            privy_deletion_pending = false,
            updated_at = now()
        where id = $1
          and privy_deletion_pending = true
          and privy_user_id = $2
      `,
      [userId, user.privy_user_id],
    );
    return "retained";
  } finally {
    if (locked) {
      await client
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        .catch(() => undefined);
    }
    client.release();
  }
}

export async function reconcilePendingPrivyDeletions(
  db: ReconciliationDb,
  input: Readonly<{ limit?: number; userId?: string | null }> = {},
  dependencies: PrivyDeletionDependencies = dependenciesDefault,
): Promise<PrivyDeletionReconciliationSummary> {
  const summary = {
    activeMovement: 0,
    busy: 0,
    completed: 0,
    failed: 0,
    hardDeleted: 0,
    inspected: 0,
    retained: 0,
    skipped: 0,
  };
  if (!(await isSchemaReady(db))) {
    summary.skipped = 1;
    return summary;
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 100);
  const { rows } = await db.query<{ id: string }>(
    `
      select id
      from users
      where privy_deletion_pending = true
        and ($1::uuid is null or id = $1::uuid)
      order by updated_at asc, id asc
      limit $2
    `,
    [input.userId ?? null, limit],
  );
  for (const row of rows) {
    summary.inspected += 1;
    try {
      const result = await reconcileOne(db, row.id, dependencies);
      if (result === "active_movement") summary.activeMovement += 1;
      else if (result === "busy") summary.busy += 1;
      else if (result === "hard_deleted") {
        summary.completed += 1;
        summary.hardDeleted += 1;
      } else if (result === "retained") {
        summary.completed += 1;
        summary.retained += 1;
      } else {
        summary.skipped += 1;
      }
    } catch {
      summary.failed += 1;
      await db
        .query(
          `
            update users
            set updated_at = now()
            where id = $1
              and privy_deletion_pending = true
          `,
          [row.id],
        )
        .catch(() => undefined);
    }
  }
  return summary;
}
