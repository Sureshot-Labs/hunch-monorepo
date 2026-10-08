import { pool } from "./db.js";
import { resolveSocialPolicy } from "./services/social-policy.js";
import { queueVerifiedBuyBackfillPage } from "./services/verified-buy-backfill.js";

// One bounded page per invocation. Persist the printed resume key in an ops
// runner if desired; absence of --execute is always a read-only preflight.
const args = process.argv.slice(2);
const kind = args.find((value) => value.startsWith("--kind="))?.slice(7);
const afterId =
  args.find((value) => value.startsWith("--after="))?.slice(8) ?? null;
if (
  (kind !== "order" && kind !== "execution") ||
  (afterId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      afterId,
    ))
) {
  console.error(
    "Usage: verified-buy-backfill --kind=order|execution [--after=<uuid>] [--execute]",
  );
  process.exitCode = 1;
} else {
  try {
    const { policy, revision } = await resolveSocialPolicy(pool);
    const result = await queueVerifiedBuyBackfillPage(pool, {
      kind,
      afterId,
      batchSize: policy.repairBatchSize,
      execute: args.includes("--execute"),
    });
    console.log(
      JSON.stringify({
        kind,
        execute: args.includes("--execute"),
        policyRevision: revision,
        ...result,
      }),
    );
  } catch {
    console.error(
      "Verified-buy backfill failed; no credentials or provider data were logged.",
    );
    process.exitCode = 1;
  }
}
await pool.end();
