import { pool } from "./db.js";
import { hasCliFlag as hasFlag, readPositiveInt } from "./lib/cli-args.js";

type Args = {
  dryRun: boolean;
  limit: number;
  retentionDays: number;
  statementTimeoutSec: number;
};

const DEFAULT_RETENTION_DAYS = 395;
const DEFAULT_LIMIT = 50_000;
const RETENTION_LOCK_KEY_1 = 4208;
const RETENTION_LOCK_KEY_2 = 1;

function parseArgs(argvInput: string[]): Args {
  const argv = argvInput.filter((arg) => arg !== "--");
  const positiveIntOptions = {
    invalid: "fallback" as const,
    splitCommas: false,
  };
  return {
    dryRun: hasFlag(argv, "dry-run"),
    limit: readPositiveInt(argv, "limit", DEFAULT_LIMIT, positiveIntOptions),
    retentionDays: readPositiveInt(
      argv,
      "retention-days",
      DEFAULT_RETENTION_DAYS,
      positiveIntOptions,
    ),
    statementTimeoutSec: readPositiveInt(
      argv,
      "statement-timeout-sec",
      120,
      positiveIntOptions,
    ),
  };
}

async function countEligibleRows(args: Args): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from (
        select 1
        from analytics_server_events
        where created_at < now() - make_interval(days => $1::int)
        order by created_at asc
        limit $2
      ) s
    `,
    [args.retentionDays, args.limit],
  );
  return Number(rows[0]?.count ?? 0);
}

async function cleanupAnalyticsServerEvents(args: Args): Promise<number> {
  const { rows } = await pool.query<{ deleted: string }>(
    `
      select cleanup_analytics_server_events(
        make_interval(days => $1::int),
        $2
      )::text as deleted
    `,
    [args.retentionDays, args.limit],
  );
  return Number(rows[0]?.deleted ?? 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const { rows: lockRows } = await pool.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1::int, $2::int) as locked",
    [RETENTION_LOCK_KEY_1, RETENTION_LOCK_KEY_2],
  );
  if (!lockRows[0]?.locked) {
    console.log("[analytics:retention] skipped: another cleanup is running");
    await pool.end();
    return;
  }

  try {
    await pool.query("select set_config('statement_timeout', $1, false)", [
      `${args.statementTimeoutSec}s`,
    ]);

    console.log("[analytics:retention] start", {
      dryRun: args.dryRun,
      limit: args.limit,
      retentionDays: args.retentionDays,
      statementTimeoutSec: args.statementTimeoutSec,
    });

    const eligibleRows = await countEligibleRows(args);
    console.log("[analytics:retention] eligible", {
      rows: eligibleRows,
      limited: eligibleRows >= args.limit,
    });

    if (args.dryRun) {
      console.log("[analytics:retention] dry-run complete");
      return;
    }

    const deletedRows = await cleanupAnalyticsServerEvents(args);
    console.log("[analytics:retention] done", {
      deletedRows,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    await pool
      .query("select pg_advisory_unlock($1::int, $2::int)", [
        RETENTION_LOCK_KEY_1,
        RETENTION_LOCK_KEY_2,
      ])
      .catch(() => {});
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error("[analytics:retention] failed", error);
  await pool.end().catch(() => {});
  process.exit(1);
});
