// Dedicated passive sidecar entrypoint in the existing API build artifact.
// Deliberately does not import API env, app bootstrap or financial services.
import { Pool } from "pg";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import { runHip4ReadCycle } from "./services/hip4-indexer.js";
import { readHip4Policy } from "./services/hip4-repository.js";
import {
  createHip4Wakeup,
  watchHip4Metadata,
} from "./services/hip4-metadata-stream.js";

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
  max: 2,
  statement_timeout: 15_000,
});
let stopping = false;
const shutdown = new AbortController();
const wakeup = createHip4Wakeup();
let stream: ReturnType<typeof watchHip4Metadata> | undefined;
let streamRevision: string | undefined;
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
  stream?.close();
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
  do {
    const start = Date.now();
    // Config errors disable requests, but a repaired policy recovers on the
    // next bounded check. Defaults here schedule retries; they never enable IO.
    let pollMs = DEFAULT_HIP4_READ_POLICY.pollMs;
    let minRefreshMs = DEFAULT_HIP4_READ_POLICY.minRefreshMs;
    try {
      const { policy, revision } = await readHip4Policy(pool);
      pollMs = policy.pollMs;
      minRefreshMs = policy.minRefreshMs;
      if (streamRevision !== revision && !process.argv.includes("--once")) {
        stream?.close();
        stream = watchHip4Metadata(policy, wakeup.request);
        streamRevision = revision;
      }
      console.log(
        JSON.stringify({
          component: "hip4-read",
          ...(await runHip4ReadCycle(pool)),
          stream: stream?.diagnostics ?? null,
          durationMs: Date.now() - start,
        }),
      );
    } catch {
      stream?.close();
      stream = undefined;
      streamRevision = undefined;
      if (process.argv.includes("--once")) process.exitCode = 1;
      console.error(
        JSON.stringify({
          component: "hip4-read",
          reason: "cycle_unavailable",
          durationMs: Date.now() - start,
        }),
      );
    }
    if (process.argv.includes("--once") || stopping) break;
    await wakeup.wait(Math.min(minRefreshMs, pollMs), pollMs, shutdown.signal);
  } while (!stopping);
} finally {
  stream?.close();
  owner.release(true); // closes the session and releases its advisory lock
  await pool.end();
}
