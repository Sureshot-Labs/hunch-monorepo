import type { Pool, PoolClient, QueryConfig } from "pg";
import { FUNDING_POLICY_KEY } from "../funding/policies/funding-policy.js";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-sidecar.js";

export function assertHip4ObservationDeadline(deadlineMs?: number): void {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs)
    throw new Error("hip4_optional_observation_expired");
}

/** Ordinary repair retains its lock order/wait semantics. Optional post-submit
 * observation must instead leave contended ownership to the normal observer. */
export async function lockHip4ObservationOwner(
  db: Pick<PoolClient, "query">,
  userId: string,
  deadlineMs?: number,
): Promise<boolean> {
  assertHip4ObservationDeadline(deadlineMs);
  if (deadlineMs === undefined) {
    await lockFundingPolicyForTransaction(db);
    return (
      (await db.query("select id from users where id=$1 for update", [userId]))
        .rowCount === 1
    );
  }
  const locked = await db.query<{ locked: boolean }>(
    "select pg_try_advisory_xact_lock(hashtext($1)) as locked",
    [FUNDING_POLICY_KEY],
  );
  if (!locked.rows[0]?.locked)
    throw new Error("hip4_optional_observation_busy");
  assertHip4ObservationDeadline(deadlineMs);
  return (
    (
      await db.query("select id from users where id=$1 for update nowait", [
        userId,
      ])
    ).rowCount === 1
  );
}

/** One existing observer promise, not a second observer/retry. Its own scoped
 * DB/transport deadlines prevent late continuation after this response race. */
export async function waitHip4OptionalObservation(
  observation: Promise<unknown>,
  deadlineMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      observation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadlineMs - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fast-path-only facade. No connection is retained across provider IO. Late
 * pool acquisitions are released without queries. SET LOCAL timeouts disappear
 * at commit/rollback; each query gets the remaining absolute budget, including
 * persistence/cleanup, rather than a fresh per-statement three seconds. */
export function hip4OptionalObservationPool(
  pool: Pool,
  deadlineMs: number,
): Pool {
  const acquire = async (): Promise<PoolClient> => {
    assertHip4ObservationDeadline(deadlineMs);
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const pending = pool.connect().then((client) => {
      if (expired || Date.now() >= deadlineMs) {
        client.release();
        throw new Error("hip4_optional_observation_expired");
      }
      return client;
    });
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              expired = true;
              reject(new Error("hip4_optional_observation_expired"));
            },
            Math.max(0, deadlineMs - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const bounded = (client: PoolClient): PoolClient => {
    let released = false;
    const release = (discard?: boolean | Error) => {
      if (released) return;
      released = true;
      client.release(discard);
    };
    const perform = async (
      query: string | QueryConfig,
      values?: unknown[],
      timeoutMs = Math.max(1, deadlineMs - Date.now()),
    ) => {
      if (released) throw new Error("hip4_optional_connection_closed");
      const configured = {
        ...(typeof query === "string" ? { text: query, values } : query),
        query_timeout: timeoutMs,
      };
      try {
        return await client.query(configured);
      } catch (error) {
        // A client timeout does not itself cancel server work. Destroy this
        // optional connection so abandoned work cannot occupy a pool slot or
        // later commit after the deadline. Other SQL errors can roll back.
        if (error instanceof Error && error.message === "Query read timeout")
          release(true);
        throw error;
      }
    };
    return new Proxy(client, {
      get(target, property) {
        if (property === "release") return release;
        if (property !== "query") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (query: string | QueryConfig, values?: unknown[]) => {
          const text = typeof query === "string" ? query : query.text;
          // Cleanup must remain possible after expiry/statement cancellation.
          if (/^\s*rollback\b/iu.test(text)) return perform(query, values, 100);
          assertHip4ObservationDeadline(deadlineMs);
          if (!/^\s*begin\b/iu.test(text)) {
            const remaining = Math.max(1, deadlineMs - Date.now());
            await perform(
              "select set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
              [`${remaining}ms`, `${Math.min(50, remaining)}ms`],
            );
            assertHip4ObservationDeadline(deadlineMs);
          }
          return perform(query, values);
        };
      },
    });
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") return async () => bounded(await acquire());
      if (property === "query")
        return async (query: string | QueryConfig, values?: unknown[]) => {
          const client = bounded(await acquire());
          try {
            await client.query("begin");
            const result = await client.query(query, values);
            await client.query("commit");
            return result;
          } catch (error) {
            await client.query("rollback");
            throw error;
          } finally {
            client.release();
          }
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
