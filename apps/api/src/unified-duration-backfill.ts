import {
  deriveExactWindowDurationMinutes,
  deriveLimitlessDurationMinutes,
  deriveMarketDurationMinutes,
  derivePolymarketDurationMinutes,
} from "@hunch/db";
import { pool } from "./db.js";

const VALID_VENUES = new Set(["polymarket", "limitless", "kalshi"]);
const VALID_STATUSES = new Set(["ACTIVE", "CLOSED", "SETTLED", "ARCHIVED"]);

type BackfillTable = "events" | "markets";

type BackfillOptions = {
  dryRun: boolean;
  batch: number;
  limit: number | null;
  venue: string | null;
  status: string | null;
  after: string | null;
};

type EventBackfillRow = {
  id: string;
  venue: string;
  duration_minutes: number | null;
  series_key: string | null;
  start_date: Date | null;
  end_date: Date | null;
  stable_slug: string | null;
  raw_slug: string | null;
  title: string | null;
};

type MarketBackfillRow = {
  id: string;
  venue: string;
  duration_minutes: number | null;
  series_key: string | null;
  open_time: Date | null;
  close_time: Date | null;
  stable_slug: string | null;
  raw_slug: string | null;
  slug: string | null;
  title: string | null;
  event_stable_slug: string | null;
  event_raw_slug: string | null;
  event_title: string | null;
};

type DurationUpdateRow = {
  id: string;
  duration_minutes: number | null;
};

function parseArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  if (!arg) return null;
  return arg.slice(prefix.length).trim();
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = parseArgValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function parseLimit(): number | null {
  const raw = parseArgValue("limit");
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return value;
}

function parseTable(): BackfillTable | "all" {
  const raw = parseArgValue("table")?.toLowerCase();
  if (!raw) return "all";
  if (raw === "events" || raw === "markets" || raw === "all") return raw;
  throw new Error("--table must be events, markets, or all");
}

function parseVenue(): string | null {
  const raw = parseArgValue("venue")?.toLowerCase() ?? null;
  if (!raw) return null;
  if (!VALID_VENUES.has(raw)) {
    throw new Error("--venue must be polymarket, limitless, or kalshi");
  }
  return raw;
}

function parseStatus(): string | null {
  const raw = parseArgValue("status")?.toUpperCase() ?? "ACTIVE";
  if (raw === "ALL") return null;
  if (!VALID_STATUSES.has(raw)) {
    throw new Error(
      "--status must be ACTIVE, CLOSED, SETTLED, ARCHIVED, or all",
    );
  }
  return raw;
}

function buildFilters(
  options: Pick<BackfillOptions, "venue" | "status" | "after">,
  alias: string,
) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (options.after) clauses.push(`${alias}.id > ${add(options.after)}`);
  if (options.venue) clauses.push(`${alias}.venue = ${add(options.venue)}`);
  if (options.status) clauses.push(`${alias}.status = ${add(options.status)}`);

  return {
    whereSql: clauses.length ? `where ${clauses.join(" and ")}` : "",
    values,
    add,
  };
}

function deriveEventDuration(row: EventBackfillRow): number | null {
  if (row.venue === "polymarket") {
    return derivePolymarketDurationMinutes(row.series_key);
  }
  if (row.venue === "limitless") {
    return deriveLimitlessDurationMinutes({
      stableSlug: row.stable_slug,
      slug: row.raw_slug,
      title: row.title,
    });
  }
  if (row.venue === "kalshi") {
    return deriveExactWindowDurationMinutes({
      openTime: row.start_date,
      closeTime: row.end_date,
    });
  }
  return null;
}

function deriveMarketDuration(row: MarketBackfillRow): number | null {
  const duration = deriveMarketDurationMinutes({
    venue: row.venue,
    seriesKey: row.series_key,
    stableSlug: row.stable_slug,
    slug: row.raw_slug ?? row.slug,
    title: row.title,
    openTime: row.open_time,
    closeTime: row.close_time,
  });
  if (duration != null || row.venue !== "limitless") return duration;

  return deriveLimitlessDurationMinutes({
    stableSlug: row.event_stable_slug,
    slug: row.event_raw_slug,
    title: row.event_title,
  });
}

async function fetchEventBatch(
  after: string | null,
  options: BackfillOptions,
): Promise<EventBackfillRow[]> {
  const filters = buildFilters({ ...options, after }, "e");
  const limitParam = filters.add(options.batch);
  const result = await pool.query<EventBackfillRow>(
    `
      select
        e.id,
        e.venue,
        e.duration_minutes,
        e.series_key,
        e.start_date,
        e.end_date,
        lm.raw->>'stableSlug' as stable_slug,
        lm.slug as raw_slug,
        e.title
      from unified_events e
      left join limitless_markets lm
        on e.venue = 'limitless'
       and lm.id = e.venue_event_id
      ${filters.whereSql}
      order by e.id
      limit ${limitParam}
    `,
    filters.values,
  );
  return result.rows;
}

async function fetchMarketBatch(
  after: string | null,
  options: BackfillOptions,
): Promise<MarketBackfillRow[]> {
  const filters = buildFilters({ ...options, after }, "m");
  const limitParam = filters.add(options.batch);
  const result = await pool.query<MarketBackfillRow>(
    `
      select
        m.id,
        m.venue,
        m.duration_minutes,
        e.series_key,
        m.open_time,
        m.close_time,
        lm.raw->>'stableSlug' as stable_slug,
        lm.slug as raw_slug,
        m.slug,
        m.title,
        le.raw->>'stableSlug' as event_stable_slug,
        le.slug as event_raw_slug,
        e.title as event_title
      from unified_markets m
      left join unified_events e on e.id = m.event_id
      left join limitless_markets lm
        on m.venue = 'limitless'
       and lm.id = m.venue_market_id
      left join limitless_events le
        on m.venue = 'limitless'
       and le.id = e.venue_event_id
      ${filters.whereSql}
      order by m.id
      limit ${limitParam}
    `,
    filters.values,
  );
  return result.rows;
}

async function applyUpdates(
  table: BackfillTable,
  updates: DurationUpdateRow[],
) {
  if (updates.length === 0) return 0;
  const tableName = table === "events" ? "unified_events" : "unified_markets";
  const result = await pool.query(
    `
      with input as (
        select *
        from jsonb_to_recordset($1::jsonb) as x(
          id text,
          duration_minutes integer
        )
      )
      update ${tableName} target
      set duration_minutes = input.duration_minutes,
          updated_at_db = now()
      from input
      where target.id = input.id
        and target.duration_minutes is distinct from input.duration_minutes
    `,
    [JSON.stringify(updates)],
  );
  return result.rowCount ?? 0;
}

async function runBackfillTable(
  table: BackfillTable,
  options: BackfillOptions,
) {
  let after = options.after;
  let processed = 0;
  let changed = 0;
  let updated = 0;
  let pages = 0;

  while (true) {
    const remaining = options.limit == null ? null : options.limit - processed;
    if (remaining != null && remaining <= 0) break;
    const batchOptions = {
      ...options,
      batch:
        remaining == null ? options.batch : Math.min(options.batch, remaining),
    };
    const rows =
      table === "events"
        ? await fetchEventBatch(after, batchOptions)
        : await fetchMarketBatch(after, batchOptions);
    if (rows.length === 0) break;

    pages += 1;
    processed += rows.length;
    after = rows[rows.length - 1]?.id ?? after;

    const updates: DurationUpdateRow[] = [];
    for (const row of rows) {
      const duration =
        table === "events"
          ? deriveEventDuration(row as EventBackfillRow)
          : deriveMarketDuration(row as MarketBackfillRow);
      if (row.duration_minutes === duration) continue;
      updates.push({ id: row.id, duration_minutes: duration });
    }

    changed += updates.length;
    if (!options.dryRun) {
      updated += await applyUpdates(table, updates);
    }

    console.log(
      JSON.stringify({
        table,
        page: pages,
        processed,
        changed,
        updated,
        lastId: after,
        dryRun: options.dryRun,
      }),
    );
  }

  return { table, pages, processed, changed, updated, lastId: after };
}

async function main() {
  const options: BackfillOptions = {
    dryRun: hasFlag("dry-run"),
    batch: parsePositiveInt("batch", 1000),
    limit: parseLimit(),
    venue: parseVenue(),
    status: parseStatus(),
    after: parseArgValue("after"),
  };
  const table = parseTable();
  const tables: BackfillTable[] =
    table === "all" ? ["events", "markets"] : [table];

  const startedAt = Date.now();
  const results = [];
  for (const target of tables) {
    results.push(await runBackfillTable(target, options));
  }

  console.log(
    JSON.stringify({
      ok: true,
      durationMs: Date.now() - startedAt,
      options,
      results,
    }),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
