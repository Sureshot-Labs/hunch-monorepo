import type { PoolClient } from "pg";
import { pool } from "./db.js";

type Args = {
  confirmDelete: boolean;
  cutoffDays: number;
  execute: boolean;
  json: boolean;
  limit: number;
  sampleLimit: number;
  statementTimeoutSec: number;
  venues: string[];
};

type SummaryRow = {
  section: string;
  venue: string | null;
  label: string;
  markets: string | null;
  events: string | null;
  oldest_terminal_at: Date | null;
  newest_terminal_at: Date | null;
};

type SampleRow = {
  venue: string;
  source_market_id: string;
  source_event_id: string;
  terminal_at: Date;
  title: string;
};

type CountRow = {
  label: string;
  rows: string;
};

const DEFAULT_CUTOFF_DAYS = 90;
const DEFAULT_LIMIT = 50_000;
const DEFAULT_SAMPLE_LIMIT = 20;
const ALLOWED_VENUES = new Set(["polymarket", "limitless"]);

function readValues(argv: string[], name: string): string[] {
  const key = `--${name}`;
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(`${key}=`)) {
      const value = arg.slice(key.length + 1).trim();
      if (value.length) values.push(value);
      continue;
    }
    if (arg === key) {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) {
        values.push(value.trim());
        index += 1;
      }
    }
  }

  return values.flatMap((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function readPositiveInt(
  argv: string[],
  name: string,
  fallback: number,
): number {
  const raw = readValues(argv, name)[0];
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return Math.trunc(parsed);
}

function normalizeVenues(values: string[]): string[] {
  const venues = values.map((entry) => entry.toLowerCase());
  const unknown = venues.filter((entry) => !ALLOWED_VENUES.has(entry));
  if (unknown.length > 0) {
    throw new Error(`Unknown venue value(s): ${unknown.join(", ")}`);
  }
  return [...new Set(venues)];
}

function parseArgs(argvInput: string[]): Args {
  const argv = argvInput.filter((arg) => arg !== "--");
  return {
    confirmDelete: hasFlag(argv, "confirm-delete"),
    cutoffDays:
      readValues(argv, "cutoff-days")[0] !== undefined
        ? readPositiveInt(argv, "cutoff-days", DEFAULT_CUTOFF_DAYS)
        : readPositiveInt(argv, "retention-days", DEFAULT_CUTOFF_DAYS),
    execute: hasFlag(argv, "execute"),
    json: hasFlag(argv, "json"),
    limit: readPositiveInt(argv, "limit", DEFAULT_LIMIT),
    sampleLimit: readPositiveInt(argv, "sample", DEFAULT_SAMPLE_LIMIT),
    statementTimeoutSec: readPositiveInt(argv, "statement-timeout-sec", 180),
    venues: normalizeVenues([
      ...readValues(argv, "venue"),
      ...readValues(argv, "venues"),
    ]),
  };
}

function printUsage(): void {
  console.log(`Usage:
  pnpm -C hunch-monorepo -F api run market:source-retention -- [options]

Options:
  --cutoff-days <days>          Source market terminal age threshold. Default: ${DEFAULT_CUTOFF_DAYS}
  --limit <count>               Bounded source market candidate size. Default: ${DEFAULT_LIMIT}
  --sample <count>              Sample row count. Default: ${DEFAULT_SAMPLE_LIMIT}
  --venue <venue[,venue]>       Optional venue filter: polymarket, limitless. Repeatable.
  --statement-timeout-sec <sec> Query timeout. Default: 180
  --json                        Emit one JSON report.
  --execute                     Delete selected rows. Requires --confirm-delete.
  --confirm-delete              Required together with --execute.
  --help                        Show this message.

Selection rule:
  source market has no matching unified_markets row
  source terminal_at older than cutoff
  source events are deleted only when no source markets and no unified event remain

Dry-run is the default. Delete mode recomputes the same set inside a write
transaction and only runs when both --execute and --confirm-delete are present.`);
}

function assertExecutionFlags(args: Args): void {
  if (args.execute === args.confirmDelete) return;

  throw new Error(
    "Source retention deletion requires both --execute and --confirm-delete. Omit both flags for dry-run.",
  );
}

function queryParams(args: Args): Array<number | string[] | null> {
  return [
    args.venues.length > 0 ? args.venues : null,
    args.cutoffDays,
    args.limit,
  ];
}

const sourceCandidateCte = `
  with source_candidates as materialized (
    select
      'polymarket'::text as venue,
      pm.id as source_market_id,
      pm.event_id as source_event_id,
      pm.end_date as terminal_at,
      pm.question as title
    from polymarket_markets pm
    left join unified_markets um
      on um.venue = 'polymarket'
      and um.venue_market_id = pm.id
    where ($1::text[] is null or 'polymarket' = any($1::text[]))
      and um.id is null
      and pm.end_date is not null
      and pm.end_date < now() - make_interval(days => $2::int)
    union all
    select
      'polymarket'::text as venue,
      pm.id as source_market_id,
      pm.event_id as source_event_id,
      pe.end_date as terminal_at,
      pm.question as title
    from polymarket_markets pm
    join polymarket_events pe on pe.id = pm.event_id
    left join unified_markets um
      on um.venue = 'polymarket'
      and um.venue_market_id = pm.id
    where ($1::text[] is null or 'polymarket' = any($1::text[]))
      and um.id is null
      and pm.end_date is null
      and pe.end_date is not null
      and pe.end_date < now() - make_interval(days => $2::int)
    union all
    select
      'limitless'::text as venue,
      lm.id as source_market_id,
      lm.event_id as source_event_id,
      to_timestamp(lm.expiration_timestamp / 1000.0) as terminal_at,
      lm.title
    from limitless_markets lm
    left join unified_markets um
      on um.venue = 'limitless'
      and um.venue_market_id = lm.id
    where ($1::text[] is null or 'limitless' = any($1::text[]))
      and um.id is null
      and lm.expiration_timestamp is not null
      and lm.expiration_timestamp < floor(extract(epoch from now() - make_interval(days => $2::int)) * 1000)::bigint
    union all
    select
      'limitless'::text as venue,
      lm.id as source_market_id,
      lm.event_id as source_event_id,
      to_timestamp(le.expiration_timestamp / 1000.0) as terminal_at,
      lm.title
    from limitless_markets lm
    join limitless_events le on le.id = lm.event_id
    left join unified_markets um
      on um.venue = 'limitless'
      and um.venue_market_id = lm.id
    where ($1::text[] is null or 'limitless' = any($1::text[]))
      and um.id is null
      and lm.expiration_timestamp is null
      and le.expiration_timestamp is not null
      and le.expiration_timestamp < floor(extract(epoch from now() - make_interval(days => $2::int)) * 1000)::bigint
  ),
  bounded_candidates as materialized (
    select *
    from source_candidates
    order by terminal_at asc, venue asc, source_market_id asc
    limit $3::int
  ),
  touched_events as materialized (
    select distinct venue, source_event_id
    from bounded_candidates
  ),
  orphan_events_if_deleted as materialized (
    select e.venue, e.source_event_id
    from touched_events e
    where (
        e.venue = 'polymarket'
        and not exists (
          select 1
          from polymarket_markets pm
          where pm.event_id = e.source_event_id
            and not exists (
              select 1
              from bounded_candidates c
              where c.venue = 'polymarket'
                and c.source_market_id = pm.id
            )
        )
        and not exists (
          select 1
          from unified_events ue
          where ue.venue = 'polymarket'
            and ue.venue_event_id = e.source_event_id
        )
      )
      or (
        e.venue = 'limitless'
        and not exists (
          select 1
          from limitless_markets lm
          where lm.event_id = e.source_event_id
            and not exists (
              select 1
              from bounded_candidates c
              where c.venue = 'limitless'
                and c.source_market_id = lm.id
            )
        )
        and not exists (
          select 1
          from unified_events ue
          where ue.venue = 'limitless'
            and ue.venue_event_id = e.source_event_id
        )
      )
  )
`;

function dateToString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function logSection(title: string): void {
  console.log(`\n[market:source-retention] ${title}`);
}

async function querySummary(
  client: PoolClient,
  args: Args,
): Promise<SummaryRow[]> {
  const { rows } = await client.query<SummaryRow>(
    `
      ${sourceCandidateCte}
      select
        'source_market_total' as section,
        null::text as venue,
        'all' as label,
        count(*)::text as markets,
        null::text as events,
        min(terminal_at) as oldest_terminal_at,
        max(terminal_at) as newest_terminal_at
      from bounded_candidates
      union all
      select
        'source_market_by_venue' as section,
        venue,
        'all' as label,
        count(*)::text as markets,
        null::text as events,
        min(terminal_at) as oldest_terminal_at,
        max(terminal_at) as newest_terminal_at
      from bounded_candidates
      group by venue
      union all
      select
        'source_events_touched' as section,
        venue,
        'all' as label,
        null::text as markets,
        count(*)::text as events,
        null::timestamptz as oldest_terminal_at,
        null::timestamptz as newest_terminal_at
      from touched_events
      group by venue
      union all
      select
        'source_events_orphan_if_deleted' as section,
        venue,
        'all' as label,
        null::text as markets,
        count(*)::text as events,
        null::timestamptz as oldest_terminal_at,
        null::timestamptz as newest_terminal_at
      from orphan_events_if_deleted
      group by venue
      order by section, venue nulls first
    `,
    queryParams(args),
  );
  return rows;
}

async function querySamples(
  client: PoolClient,
  args: Args,
): Promise<SampleRow[]> {
  const { rows } = await client.query<SampleRow>(
    `
      ${sourceCandidateCte}
      select
        venue,
        source_market_id,
        source_event_id,
        terminal_at,
        title
      from bounded_candidates
      order by terminal_at asc, venue asc, source_market_id asc
      limit $4::int
    `,
    [...queryParams(args), args.sampleLimit],
  );
  return rows;
}

async function countTempRows(
  client: PoolClient,
  label: string,
  tableName: string,
): Promise<CountRow> {
  const { rows } = await client.query<{ rows: string }>(
    `select count(*)::text as rows from ${tableName}`,
  );
  return { label, rows: rows[0]?.rows ?? "0" };
}

async function deleteAndCount(
  client: PoolClient,
  label: string,
  deleteSql: string,
): Promise<CountRow> {
  const { rows } = await client.query<{ rows: string }>(
    `
      with deleted as (
        ${deleteSql}
        returning 1
      )
      select count(*)::text as rows from deleted
    `,
  );
  return { label, rows: rows[0]?.rows ?? "0" };
}

async function materializeDeletionSet(
  client: PoolClient,
  args: Args,
): Promise<CountRow[]> {
  await client.query(
    `
      create temp table tmp_market_source_retention_markets on commit drop as
      ${sourceCandidateCte}
      select *
      from bounded_candidates
    `,
    queryParams(args),
  );

  await client.query(
    `
      create temp table tmp_market_source_retention_events on commit drop as
      select distinct venue, source_event_id
      from tmp_market_source_retention_markets
    `,
  );

  return [
    await countTempRows(
      client,
      "source_markets",
      "tmp_market_source_retention_markets",
    ),
    await countTempRows(
      client,
      "source_events_touched",
      "tmp_market_source_retention_events",
    ),
  ];
}

async function runSourceMarketDeletes(client: PoolClient): Promise<CountRow[]> {
  return [
    await deleteAndCount(
      client,
      "polymarket_markets",
      `
        delete from polymarket_markets pm
        using tmp_market_source_retention_markets r
        where r.venue = 'polymarket'
          and pm.id = r.source_market_id
      `,
    ),
    await deleteAndCount(
      client,
      "limitless_markets",
      `
        delete from limitless_markets lm
        using tmp_market_source_retention_markets r
        where r.venue = 'limitless'
          and lm.id = r.source_market_id
      `,
    ),
  ];
}

async function materializeOrphanSourceEvents(
  client: PoolClient,
): Promise<CountRow> {
  await client.query(
    `
      create temp table tmp_market_source_retention_orphan_events on commit drop as
      select distinct e.venue, e.source_event_id
      from tmp_market_source_retention_events e
      where (
          e.venue = 'polymarket'
          and not exists (
            select 1 from polymarket_markets pm where pm.event_id = e.source_event_id
          )
          and not exists (
            select 1
            from unified_events ue
            where ue.venue = 'polymarket'
              and ue.venue_event_id = e.source_event_id
          )
        )
        or (
          e.venue = 'limitless'
          and not exists (
            select 1 from limitless_markets lm where lm.event_id = e.source_event_id
          )
          and not exists (
            select 1
            from unified_events ue
            where ue.venue = 'limitless'
              and ue.venue_event_id = e.source_event_id
          )
        )
    `,
  );

  return countTempRows(
    client,
    "source_orphan_events",
    "tmp_market_source_retention_orphan_events",
  );
}

async function runSourceEventDeletes(client: PoolClient): Promise<CountRow[]> {
  return [
    await deleteAndCount(
      client,
      "polymarket_events",
      `
        delete from polymarket_events pe
        using tmp_market_source_retention_orphan_events r
        where r.venue = 'polymarket'
          and pe.id = r.source_event_id
      `,
    ),
    await deleteAndCount(
      client,
      "limitless_events",
      `
        delete from limitless_events le
        using tmp_market_source_retention_orphan_events r
        where r.venue = 'limitless'
          and le.id = r.source_event_id
      `,
    ),
  ];
}

async function queryPostDeleteValidation(
  client: PoolClient,
): Promise<CountRow[]> {
  const { rows } = await client.query<CountRow>(
    `
      select 'remaining_polymarket_markets' as label, count(*)::text as rows
      from polymarket_markets pm
      join tmp_market_source_retention_markets r
        on r.venue = 'polymarket'
        and r.source_market_id = pm.id
      union all
      select 'remaining_limitless_markets' as label, count(*)::text as rows
      from limitless_markets lm
      join tmp_market_source_retention_markets r
        on r.venue = 'limitless'
        and r.source_market_id = lm.id
      union all
      select 'remaining_polymarket_orphan_events' as label, count(*)::text as rows
      from polymarket_events pe
      join tmp_market_source_retention_orphan_events r
        on r.venue = 'polymarket'
        and r.source_event_id = pe.id
      union all
      select 'remaining_limitless_orphan_events' as label, count(*)::text as rows
      from limitless_events le
      join tmp_market_source_retention_orphan_events r
        on r.venue = 'limitless'
        and r.source_event_id = le.id
    `,
  );

  const failures = rows.filter((row) => Number(row.rows) > 0);
  if (failures.length > 0) {
    throw new Error(
      `Source retention post-validation failed ${JSON.stringify(failures)}`,
    );
  }

  return rows;
}

async function buildReport(args: Args) {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${args.statementTimeoutSec}s`,
    ]);
    const summary = await querySummary(client, args);
    const samples = await querySamples(client, args);
    await client.query("commit");
    return { args, summary, samples };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function executeDeletion(args: Args) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${args.statementTimeoutSec}s`,
    ]);
    const lockResult = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock(hashtext('market_source_retention_delete')) as locked",
    );
    if (!lockResult.rows[0]?.locked) {
      throw new Error("Source retention aborted: another cleanup is running");
    }

    const selectionCounts = await materializeDeletionSet(client, args);
    const marketDeleteCounts = await runSourceMarketDeletes(client);
    const orphanEventCount = await materializeOrphanSourceEvents(client);
    const eventDeleteCounts = await runSourceEventDeletes(client);
    const postDeleteValidation = await queryPostDeleteValidation(client);

    await client.query("commit");
    return {
      args,
      selectionCounts,
      deleteCounts: [
        ...marketDeleteCounts,
        orphanEventCount,
        ...eventDeleteCounts,
      ],
      postDeleteValidation,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function formatSummaryRow(row: SummaryRow): Record<string, string | null> {
  return {
    section: row.section,
    venue: row.venue,
    label: row.label,
    markets: row.markets,
    events: row.events,
    oldest: dateToString(row.oldest_terminal_at),
    newest: dateToString(row.newest_terminal_at),
  };
}

function formatSampleRow(row: SampleRow): Record<string, string | null> {
  return {
    venue: row.venue,
    sourceMarketId: row.source_market_id,
    sourceEventId: row.source_event_id,
    terminalAt: dateToString(row.terminal_at),
    title: row.title,
  };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (hasFlag(rawArgs, "help")) {
    printUsage();
    return;
  }

  const args = parseArgs(rawArgs);
  assertExecutionFlags(args);
  const startedAt = Date.now();

  if (args.execute) {
    const result = await executeDeletion(args);
    if (args.json) {
      console.log(
        JSON.stringify(
          { ...result, durationMs: Date.now() - startedAt },
          null,
          2,
        ),
      );
      return;
    }

    console.log("[market:source-retention] execute delete", {
      cutoffDays: args.cutoffDays,
      limit: args.limit,
      venues: args.venues.length > 0 ? args.venues : "all",
      statementTimeoutSec: args.statementTimeoutSec,
    });
    logSection("selection counts");
    console.table(result.selectionCounts);
    logSection("delete counts");
    console.table(result.deleteCounts);
    logSection("post-delete validation");
    console.table(result.postDeleteValidation);
    console.log("[market:source-retention] done", {
      durationMs: Date.now() - startedAt,
      readOnly: false,
    });
    return;
  }

  const report = await buildReport(args);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          args: report.args,
          durationMs: Date.now() - startedAt,
          summary: report.summary.map(formatSummaryRow),
          samples: report.samples.map(formatSampleRow),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("[market:source-retention] selector-only dry run", {
    cutoffDays: args.cutoffDays,
    limit: args.limit,
    sampleLimit: args.sampleLimit,
    venues: args.venues.length > 0 ? args.venues : "all",
    statementTimeoutSec: args.statementTimeoutSec,
  });
  logSection("summary");
  console.table(report.summary.map(formatSummaryRow));
  logSection("samples");
  console.table(report.samples.map(formatSampleRow));
  console.log("[market:source-retention] done", {
    durationMs: Date.now() - startedAt,
    readOnly: true,
  });
}

main()
  .catch((error) => {
    console.error("[market:source-retention] failed", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
