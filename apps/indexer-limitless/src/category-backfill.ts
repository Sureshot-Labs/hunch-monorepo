import { pool } from "./db.js";
import { log } from "./log.js";
import { resolveLimitlessCategory } from "./mappers.js";

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

async function applyUnifiedEventUpdates(updates: UpdateRow[]) {
  if (!updates.length) return;
  await pool.query(
    `
      update unified_events ue
      set category = x.category
      from jsonb_to_recordset($1::jsonb) as x(id text, category text)
      where ue.venue = 'limitless'
        and ue.venue_event_id = x.id
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
      where um.venue = 'limitless'
        and um.venue_market_id = x.id
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
      select
        le.id,
        le.title,
        le.description,
        le.categories,
        le.tags,
        ue.category as unified_category
      from limitless_events le
      left join unified_events ue
        on ue.venue = 'limitless'
       and ue.venue_event_id = le.id
    `;

    if (cursor !== null) {
      query += ` where le.id > $${params.push(cursor)} `;
    }

    const remaining =
      typeof limit === "number" ? Math.max(limit - totalExamined, 0) : null;
    if (remaining === 0) break;

    const pageSize =
      remaining == null ? batchSize : Math.min(batchSize, remaining);
    query += ` order by le.id asc limit $${params.push(pageSize)} `;

    const { rows } = await pool.query<{
      categories: string[] | null;
      description: string | null;
      id: string;
      tags: string[] | null;
      title: string | null;
      unified_category: string | null;
    }>(query, params);

    if (!rows.length) break;

    const updates: UpdateRow[] = [];
    for (const row of rows) {
      const nextCategory = resolveLimitlessCategory({
        categories: row.categories,
        tags: row.tags,
        title: row.title,
        description: row.description,
      });

      if (!row.unified_category) continue;
      if (row.unified_category === nextCategory) continue;

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

    log.info("Limitless event category backfill batch", {
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
        lm.id,
        lm.title,
        lm.description,
        lm.categories,
        lm.tags,
        le.title as event_title,
        le.description as event_description,
        le.categories as event_categories,
        le.tags as event_tags,
        um.category as unified_category
      from limitless_markets lm
      join limitless_events le on le.id = lm.event_id
      left join unified_markets um
        on um.venue = 'limitless'
       and um.venue_market_id = lm.id
    `;

    if (cursor !== null) {
      query += ` where lm.id > $${params.push(cursor)} `;
    }

    const remaining =
      typeof limit === "number" ? Math.max(limit - totalExamined, 0) : null;
    if (remaining === 0) break;

    const pageSize =
      remaining == null ? batchSize : Math.min(batchSize, remaining);
    query += ` order by lm.id asc limit $${params.push(pageSize)} `;

    const { rows } = await pool.query<{
      categories: string[] | null;
      description: string | null;
      event_categories: string[] | null;
      event_description: string | null;
      event_tags: string[] | null;
      event_title: string | null;
      id: string;
      tags: string[] | null;
      title: string | null;
      unified_category: string | null;
    }>(query, params);

    if (!rows.length) break;

    const updates: UpdateRow[] = [];
    for (const row of rows) {
      const nextCategory = resolveLimitlessCategory({
        categories: row.categories,
        tags: row.tags,
        title: row.title,
        description: row.description,
        fallbackCategories: row.event_categories,
        fallbackTags: row.event_tags,
        fallbackTitle: row.event_title,
        fallbackDescription: row.event_description,
      });

      if (!row.unified_category) continue;
      if (row.unified_category === nextCategory) continue;

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

    log.info("Limitless market category backfill batch", {
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
      log.info("Limitless event category backfill complete", events);
    }

    if (runMarkets) {
      const markets = await backfillMarkets(args);
      log.info("Limitless market category backfill complete", markets);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  log.err("Limitless category backfill failed", error);
  process.exitCode = 1;
});
