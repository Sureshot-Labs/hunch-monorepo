// Dedicated passive sidecar entrypoint in the existing API build artifact.
// Deliberately does not import API env, app bootstrap or financial services.
import { Pool } from "pg";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import { runHip4ReadCycle } from "./services/hip4-indexer.js";
import { readHip4Policy } from "./services/hip4-repository.js";
import { startHip4LiveRuntime } from "./services/hip4-live-runtime.js";
import { createHip4Wakeup } from "./services/hip4-metadata-stream.js";
import { createHip4ReadSchedule } from "./services/hip4-read-scheduling.js";

const argument = (name: string) => process.argv[process.argv.indexOf(name) + 1];
if (
  !process.argv.includes("--database-url") ||
  !process.argv.includes("--expect-database")
)
  throw new Error(
    "Provide explicit --database-url and --expect-database; no ambient DB fallback",
  );
const pool = new Pool({
  connectionString: argument("--database-url"),
  max: 3,
  statement_timeout: 15_000,
});
let stopping = false;
const shutdown = new AbortController();
const wakeup = createHip4Wakeup();
const schedule = createHip4ReadSchedule();
const repairOrder = { priorityNext: true };
let stream: ReturnType<typeof startHip4LiveRuntime> | undefined;
process.on("SIGINT", () => {
  stopping = true;
  shutdown.abort();
});
process.on("SIGTERM", () => {
  stopping = true;
  shutdown.abort();
});
const owner = await pool.connect();
owner.on("error", () => {
  stopping = true;
  shutdown.abort();
  void stream?.close();
});
try {
  const result = await owner.query(
    "select current_database() as database_name",
  );
  if (result.rows[0]?.database_name !== argument("--expect-database"))
    throw new Error("database_target_mismatch");
  // One bounded metadata stream per canary DB; crashes release the session lock.
  const lock = await owner.query(
    "select pg_try_advisory_lock(hashtextextended('hip4-read-worker', 0)) as acquired",
  );
  if (!lock.rows[0].acquired)
    throw new Error("hip4_read_worker_already_running");
  stream = startHip4LiveRuntime(
    pool,
    wakeup.request,
    process.argv.includes("--redis-url")
      ? argument("--redis-url")
      : process.env.REDIS_URL,
    { live: !process.argv.includes("--once") },
  );
  do {
    const start = Date.now();
    // Config errors disable requests, but a repaired policy recovers on the
    // next bounded check. Defaults here schedule retries; they never enable IO.
    let waitMs = DEFAULT_HIP4_READ_POLICY.policyCheckMs;
    let policy = DEFAULT_HIP4_READ_POLICY;
    let configured = false;
    let maintenance = false;
    try {
      const current = await readHip4Policy(pool, "indexer");
      policy = current.policy;
      configured = true;
      maintenance = current.lifecycle.indexerMode === "maintenance";
      const plan = schedule.start(policy, start);
      const result = await runHip4ReadCycle(
        pool,
        undefined,
        async (change) => {
          await stream?.invalidateCanonical(change, policy.requestTimeoutMs);
        },
        {
          repair: plan.repair || maintenance || process.argv.includes("--once"),
          demandedOutcomes: stream?.demandedOutcomes(),
          repairOrder,
        },
      );
      schedule.complete(
        start,
        result.repairAttempted,
        result.failures.some(
          (failure) => failure.reason === "metadata_budget_exhausted",
        ),
      );
      console.log(
        JSON.stringify({
          component: "hip4-read",
          ...result,
          stream: stream?.diagnostics ?? null,
          durationMs: Date.now() - start,
        }),
      );
    } catch {
      if (process.argv.includes("--once")) process.exitCode = 1;
      console.error(
        JSON.stringify({
          component: "hip4-read",
          reason: "cycle_unavailable",
          durationMs: Date.now() - start,
        }),
      );
    }
    if (configured) waitMs = schedule.waitMs(policy, Date.now(), maintenance);
    if (process.argv.includes("--once") || stopping) break;
    // Coalesce stream hints at the bounded catalog cadence. Early hint-driven
    // passes must not consume the capacity reserved for future observations.
    await wakeup.wait(waitMs, waitMs, shutdown.signal);
  } while (!stopping);
} finally {
  await stream?.close();
  owner.release(true); // closes the session and releases its advisory lock
  await pool.end();
}
