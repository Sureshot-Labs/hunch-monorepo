import { randomUUID } from "node:crypto";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import type { Pool } from "pg";

/** Only called after the integration/fixture runner verifies its disposable DB. */
export async function installHip4TestLifecycle(pool: Pick<Pool, "query">) {
  const id = randomUUID();
  await pool.query(
    "insert into runtime_policies(id,policy_key,effective_at,payload) values($1,'venue_lifecycle',now(),$2)",
    [
      id,
      JSON.stringify({
        ...DEFAULT_VENUE_LIFECYCLE_POLICY,
        venues: {
          ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
          hyperliquid: { lifecycle: "active", indexerMode: "full" },
        },
      }),
    ],
  );
  return {
    id,
    close: () => pool.query("delete from runtime_policies where id=$1", [id]),
  };
}
