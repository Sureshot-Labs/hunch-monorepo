import { pool } from "./db.js";
import { log } from "./log.js";
import { resolvePolymarketCategoryFromRaw } from "./mappers.js";

type Args = {
  batchSize: number;
  dryRun: boolean;
  limit?: number;
};

type UpdateRow = {
  category: string | null;
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
  const out: Args = { batchSize: DEFAULT_BATCH_SIZE, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      out.dryRun = true;
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
  return out;
}

function mergeMarketAndEventRaw(
  marketRaw: unknown,
  eventRaw: unknown,
): Record<string, unknown> {
  const market =
    marketRaw && typeof marketRaw === "object"
      ? (marketRaw as Record<string, unknown>)
      : {};
  const event =
    eventRaw && typeof eventRaw === "object"
      ? (eventRaw as Record<string, unknown>)
      : {};
  return {
    ...event,
    ...market,
    tags: Array.isArray(market.tags) ? market.tags : event.tags,
  };
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
      select id, title, description, category, raw
      from polymarket_events
    `;

    if (cursor !== null) {
      query += ` where id > $${params.push(cursor)} `;
    }

    const remaining =
      typeof limit === "number" ? Math.max(limit - totalExamined, 0) : null;
    if (remaining === 0) break;

    const pageSize =
      remaining == null ? batchSize : Math.min(batchSize, remaining);
    query += ` order by id asc limit $${params.push(pageSize)} `;

    const { rows } = await pool.query<{
      category: string | null;
      description: string | null;
      id: string;
      raw: unknown;
      title: string | null;
    }>(query, params);

    if (!rows.length) break;

    const updates: UpdateRow[] = [];
    for (const row of rows) {
      const nextCategory =
        resolvePolymarketCategoryFromRaw(row.raw, {
          explicitCategory: row.category,
          title: row.title,
          description: row.description,
        }) ?? null;

      if ((row.category ?? null) === nextCategory) continue;
      updates.push({ id: row.id, category: nextCategory });
      if (sampleUpdates.length < SAMPLE_LIMIT) {
        sampleUpdates.push({ id: row.id, category: nextCategory });
      }
    }

    if (!dryRun && updates.length) {
      for (const update of updates) {
        await pool.query(
          `update polymarket_events set category = $2 where id = $1`,
          [update.id, update.category],
        );
        await pool.query(
          `update unified_events set category = $2 where venue = 'polymarket' and venue_event_id = $1`,
          [update.id, update.category],
        );
      }
    }

    totalExamined += rows.length;
    totalUpdates += updates.length;
    cursor = rows.at(-1)?.id ?? null;

    log.info("Polymarket event category backfill batch", {
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
        m.id,
        m.question,
        m.description,
        m.category,
        m.raw,
        e.category as event_category,
        e.raw as event_raw
      from polymarket_markets m
      join polymarket_events e on e.id = m.event_id
    `;

    if (cursor !== null) {
      query += ` where m.id > $${params.push(cursor)} `;
    }

    const remaining =
      typeof limit === "number" ? Math.max(limit - totalExamined, 0) : null;
    if (remaining === 0) break;

    const pageSize =
      remaining == null ? batchSize : Math.min(batchSize, remaining);
    query += ` order by m.id asc limit $${params.push(pageSize)} `;

    const { rows } = await pool.query<{
      category: string | null;
      description: string | null;
      event_category: string | null;
      event_raw: unknown;
      id: string;
      question: string | null;
      raw: unknown;
    }>(query, params);

    if (!rows.length) break;

    const updates: UpdateRow[] = [];
    for (const row of rows) {
      const nextCategory =
        resolvePolymarketCategoryFromRaw(
          mergeMarketAndEventRaw(row.raw, row.event_raw),
          {
            explicitCategory: row.category ?? row.event_category,
            title: row.question,
            description: row.description,
          },
        ) ?? null;

      if ((row.category ?? null) === nextCategory) continue;
      updates.push({ id: row.id, category: nextCategory });
      if (sampleUpdates.length < SAMPLE_LIMIT) {
        sampleUpdates.push({ id: row.id, category: nextCategory });
      }
    }

    if (!dryRun && updates.length) {
      for (const update of updates) {
        await pool.query(
          `update polymarket_markets set category = $2 where id = $1`,
          [update.id, update.category],
        );
        await pool.query(
          `update unified_markets set category = $2 where venue = 'polymarket' and venue_market_id = $1`,
          [update.id, update.category],
        );
      }
    }

    totalExamined += rows.length;
    totalUpdates += updates.length;
    cursor = rows.at(-1)?.id ?? null;

    log.info("Polymarket market category backfill batch", {
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
  const eventSummary = await backfillEvents(args);
  const marketSummary = await backfillMarkets(args);

  log.info("Polymarket category backfill summary", {
    batchSize: args.batchSize,
    dryRun: args.dryRun,
    eventsExamined: eventSummary.totalExamined,
    eventsToUpdate: eventSummary.totalUpdates,
    marketsExamined: marketSummary.totalExamined,
    marketsToUpdate: marketSummary.totalUpdates,
    sampleEventUpdates: eventSummary.sampleUpdates,
    sampleMarketUpdates: marketSummary.sampleUpdates,
  });

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
