import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tx } from "@hunch/infra";
import type { Pool, PoolClient } from "@hunch/infra";
import {
  FundingMergeConflictError,
  mergeUsersById,
} from "../../admin-merge-user-core.js";
import { createOrReuseFundingReceiveSession } from "../persistence/funding-receive-session-repository.js";

function latch<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function capture<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** Disposable PG16 only. Existing session FK and merge's user lock must order
 * source ownership changes before/after the immutable receive binding. No new
 * membership epoch or financial locks are required by these supported paths. */
export async function verifyReceiveSourceMembershipPg(
  pool: Pool,
  sessionInput: (
    userId: string,
  ) => Parameters<typeof createOrReuseFundingReceiveSession>[1],
) {
  const waitBlocked = async (pid: number) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        (
          await pool.query<{ blocked: boolean }>(
            "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
            [pid],
          )
        ).rows[0].blocked
      )
        return;
    }
    assert.fail("expected real PostgreSQL user/FK lock contention");
  };
  for (const sessionFirst of [true, false]) {
    for (const sessionOwner of ["source", "target"] as const) {
      for (const keepSource of sessionFirst ? [false] : [false, true]) {
        const ids = (
          await pool.query<{ id: string }>(
            "insert into users(email,is_active,is_verified) values($1,true,true),($2,true,true) returning id",
            [
              `receive-merge-source-${randomUUID()}@example.com`,
              `receive-merge-target-${randomUUID()}@example.com`,
            ],
          )
        ).rows.map((row) => row.id);
        const [sourceId, targetId] = ids;
        const ownerId = sessionOwner === "source" ? sourceId : targetId;
        const held = latch<void>();
        const release = latch<void>();
        const mergePid = latch<number>();
        const sessionPid = latch<number>();
        const mergeDb = Object.create(pool) as Pool;
        // pg.Pool.query uses the callback overload of connect internally. Bind
        // reads to the real pool; only merge's explicit async connect is wrapped.
        mergeDb.query = pool.query.bind(pool);
        mergeDb.connect = (async () => {
          const db = await pool.connect();
          mergePid.resolve(
            (await db.query("select pg_backend_pid() as pid")).rows[0].pid,
          );
          return new Proxy(db, {
            get(target, key) {
              if (key === "query")
                return async (...args: unknown[]) => {
                  const result = await Reflect.apply(
                    target.query,
                    target,
                    args,
                  );
                  if (
                    !sessionFirst &&
                    typeof args[0] === "string" &&
                    /from users\s+where id = any\(\$1::uuid\[\]\)\s+order by id\s+for update/.test(
                      args[0],
                    )
                  ) {
                    held.resolve();
                    await release.promise;
                  }
                  return result;
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as PoolClient;
        }) as Pool["connect"];
        const open = () =>
          createOrReuseFundingReceiveSession(
            pool,
            sessionInput(ownerId),
            async () => {
              if (sessionFirst) {
                held.resolve();
                await release.promise;
              }
            },
            async (db) => {
              sessionPid.resolve(
                (await db.query("select pg_backend_pid() as pid")).rows[0].pid,
              );
            },
          );
        const merge = () =>
          mergeUsersById(
            sourceId,
            targetId,
            { dryRun: false, keepSource },
            mergeDb,
          );
        let opening:
          | ReturnType<typeof capture<Awaited<ReturnType<typeof open>>>>
          | undefined;
        let merging:
          | ReturnType<typeof capture<Awaited<ReturnType<typeof merge>>>>
          | undefined;
        try {
          const first = sessionFirst
            ? (opening = capture(open()))
            : (merging = capture(merge()));
          await Promise.race([
            held.promise,
            first.then((result) => {
              if (!result.ok) throw result.error;
              assert.fail(
                "first writer finished without reaching its production lock boundary",
              );
            }),
          ]);
          if (sessionFirst) merging = capture(merge());
          else opening = capture(open());
          await waitBlocked(
            await (sessionFirst ? mergePid.promise : sessionPid.promise),
          );
          release.resolve();
          assert.ok(opening && merging);
          const [opened, merged] = await Promise.all([opening, merging]);
          if (sessionFirst) {
            assert.equal(opened.ok, true);
            assert.equal(merged.ok, false);
            if (merged.ok) assert.fail("receive evidence must reject merge");
            assert.ok(merged.error instanceof FundingMergeConflictError);
            assert.ok(merged.error.conflicts.receiveEvidence > 0);
            assert.equal(
              (
                await pool.query(
                  "select count(*)::int as total from users where id=any($1::uuid[])",
                  [ids],
                )
              ).rows[0].total,
              2,
            );
          } else {
            assert.equal(merged.ok, true);
            if (sessionOwner === "source" && !keepSource) {
              assert.equal(opened.ok, false);
              if (opened.ok)
                assert.fail("deleted source cannot own a receive session");
              assert.equal((opened.error as { code?: string }).code, "23503");
            } else {
              assert.equal(opened.ok, true);
              assert.equal(opened.value.snapshot.userId, ownerId);
            }
            assert.equal(
              (
                await pool.query(
                  "select count(*)::int as total from users where id=$1",
                  [sourceId],
                )
              ).rows[0].total,
              keepSource ? 1 : 0,
            );
          }
          console.log(
            `PASS receive/merge ${sessionFirst ? "session-first" : "merge-first"}, ${sessionOwner}, keepSource=${keepSource}: real FK/user-lock serialization`,
          );
        } finally {
          release.resolve();
          await Promise.all([opening, merging]);
          // Exact synthetic fixture cleanup, not a production deletion path.
          await tx(pool, async (db) => {
            await db.query("set local session_replication_role=replica");
            await db.query(
              "delete from funding_receive_sessions where user_id=any($1::uuid[])",
              [ids],
            );
            await db.query("delete from users where id=any($1::uuid[])", [ids]);
          });
        }
      }
    }
  }
}
