import { pool } from "./db.js";
import { log } from "./log.js";
import {
  resolveDflowEventCategory,
  resolveDflowMarketCategory,
} from "./mappers.js";

type Args = {
  batchSize: number;
  dryRun: boolean;
  eventsOnly: boolean;
  limit?: number;
  marketsOnly: boolean;
};

type UpdateRow = {
  category: string;
  id: string;
};

type BackfillSummary = {
  sampleUpdates: UpdateRow[];
  totalExamined: number;
  totalUpdates: number;
};

const DEFAULT_BATCH_SIZE = 500;
const SAMPLE_LIMIT = 5;

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    batchSize: DEFAULT_BATCH_SIZE,
    dryRun: false,
    eventsOnly: false,
    marketsOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--events-only") {
      out.eventsOnly = true;
      continue;
    }
    if (arg === "--markets-only") {
      out.marketsOnly = true;
      continue;
    }
    if (arg === "--limit") {
      const parsed = parsePositiveInt(argv[i + 1]);
      if (parsed) out.limit = parsed;
      if (argv[i + 1]) i += 1;
      continue;
    }
    if (arg === "--batch") {
      const parsed = parsePositiveInt(argv[i + 1]);
      if (parsed) out.batchSize = parsed;
      if (argv[i + 1]) i += 1;
    }
  }

  if (out.eventsOnly && out.marketsOnly) {
    throw new Error("Use only one of --events-only or --markets-only");
  }

  return out;
}

function toMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readSeriesCategory(metadata: unknown): string | null {
  const record = toMetadata(metadata);
  return typeof record.seriesCategory === "string" ? record.seriesCategory : null;
}

function readSeriesTags(metadata: unknown): string[] | null {
  const record = toMetadata(metadata);
  if (!Array.isArray(record.seriesTags)) return null;
  const tags = record.seriesTags.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return tags.length ? tags : null;
}

async function applyUnifiedEventUpdates(updates: UpdateRow[]) {
  if (!updates.length) return;
  await pool.query(
    `
      update unified_events ue
      set category = x.category
      from jsonb_to_recordset($1::jsonb) as x(id text, category text)
      where ue.venue = 'kalshi'
        and ue.id = x.id
        and ue.category is distinct from x.category
    `,
    [JSON.stringify(updates)],
  );
}

async function applyUnifiedMarketUpdates(updates: UpdateRow[]) {
  if (!updates.length) return;
  await pool.query(
    `
      update unified_markets um
      set category = x.category
      from jsonb_to_recordset($1::jsonb) as x(id text, category text)
      where um.venue = 'kalshi'
        and um.id = x.id
        and um.category is distinct from x.category
    `,
    [JSON.stringify(updates)],
  );
}

async function backfillEvents({
  batchSize,
  dryRun,
  limit,
}: Args): Promise<BackfillSummary> {
  let cursor: string | null = null;
  let totalExamined = 0;
  let totalUpdates = 0;
  const sampleUpdates: UpdateRow[] = [];

  while (true) {
    const params: unknown[] = [];
    let query = `
      select id, category, metadata
      from unified_events
      where venue = 'kalshi'
    `;

    if (cursor !== null) {
      query += ` and id > $${params.push(cursor)} `;
    }

    const remaining =
      typeof limit === "number" ? Math.max(limit - totalExamined, 0) : null;
    if (remaining === 0) break;

    const pageSize =
      remaining == null ? batchSize : Math.min(batchSize, remaining);
    query += ` order by id asc limit $${params.push(pageSize)} `;

    const { rows } = await pool.query<{
      category: string | null;
      id: string;
      metadata: unknown;
    }>(query, params);

    if (!rows.length) break;

    const updates: UpdateRow[] = [];
    for (const row of rows) {
      const nextCategory = resolveDflowEventCategory({
        eventCategory: row.category,
        seriesCategory: readSeriesCategory(row.metadata),
        seriesTags: readSeriesTags(row.metadata),
      });

      if (row.category === nextCategory) continue;
      updates.push({ id: row.id, category: nextCategory });
      if (sampleUpdates.length < SAMPLE_LIMIT) {
        sampleUpdates.push({ id: row.id, category: nextCategory });
      }
    }

    if (!dryRun && updates.length) {
      await pool.query("begin");
      try {
        await applyUnifiedEventUpdates(updates);
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback");
        throw error;
      }
    }

    totalExamined += rows.length;
    totalUpdates += updates.length;
    cursor = rows.at(-1)?.id ?? null;

    log.info("DFlow event category backfill batch", {
      batchExamined: rows.length,
      batchUpdates: updates.length,
      dryRun,
      totalExamined,
      totalUpdates,
    });
  }

  return { sampleUpdates, totalExamined, totalUpdates };
}

async function backfillMarkets({
  batchSize,
  dryRun,
  limit,
}: Args): Promise<BackfillSummary> {
  let cursor: string | null = null;
  let totalExamined = 0;
  let totalUpdates = 0;
  const sampleUpdates: UpdateRow[] = [];

  while (true) {
    const params: unknown[] = [];
    let query = `
      select
        um.id,
        um.category,
        ue.category as event_category,
        ue.metadata as event_metadata
      from unified_markets um
      join unified_events ue on ue.id = um.event_id
      where um.venue = 'kalshi'
    `;

    if (cursor !== null) {
      query += ` and um.id > $${params.push(cursor)} `;
    }

    const remaining =
      typeof limit === "number" ? Math.max(limit - totalExamined, 0) : null;
    if (remaining === 0) break;

    const pageSize =
      remaining == null ? batchSize : Math.min(batchSize, remaining);
    query += ` order by um.id asc limit $${params.push(pageSize)} `;

    const { rows } = await pool.query<{
      category: string | null;
      event_category: string | null;
      event_metadata: unknown;
      id: string;
    }>(query, params);

    if (!rows.length) break;

    const updates: UpdateRow[] = [];
    for (const row of rows) {
      const normalizedEventCategory = resolveDflowEventCategory({
        eventCategory: row.event_category,
        seriesCategory: readSeriesCategory(row.event_metadata),
        seriesTags: readSeriesTags(row.event_metadata),
      });
      const nextCategory = resolveDflowMarketCategory({
        marketCategory: row.category,
        eventCategory: normalizedEventCategory,
      });

      if (row.category === nextCategory) continue;
      updates.push({ id: row.id, category: nextCategory });
      if (sampleUpdates.length < SAMPLE_LIMIT) {
        sampleUpdates.push({ id: row.id, category: nextCategory });
      }
    }

    if (!dryRun && updates.length) {
      await pool.query("begin");
      try {
        await applyUnifiedMarketUpdates(updates);
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback");
        throw error;
      }
    }

    totalExamined += rows.length;
    totalUpdates += updates.length;
    cursor = rows.at(-1)?.id ?? null;

    log.info("DFlow market category backfill batch", {
      batchExamined: rows.length,
      batchUpdates: updates.length,
      dryRun,
      totalExamined,
      totalUpdates,
    });
  }

  return { sampleUpdates, totalExamined, totalUpdates };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runEvents = !args.marketsOnly;
  const runMarkets = !args.eventsOnly;

  try {
    if (runEvents) {
      const events = await backfillEvents(args);
      log.info("DFlow event category backfill complete", events);
    }

    if (runMarkets) {
      const markets = await backfillMarkets(args);
      log.info("DFlow market category backfill complete", markets);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  log.err("DFlow category backfill failed", error);
  process.exitCode = 1;
});
