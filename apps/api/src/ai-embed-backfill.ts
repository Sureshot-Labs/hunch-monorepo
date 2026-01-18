import {
  buildTopMarketsText,
  createRedisClient,
  enqueueEmbedItems,
  ensureRedis,
} from "@hunch/infra";
import type { EmbedQueueItem } from "@hunch/infra";
import { pool } from "./db.js";
import { env } from "./env.js";

type VenueFilter = string[];

type BackfillOptions = {
  venues: VenueFilter;
  batchSize: number;
  limit?: number;
  dryRun: boolean;
  includeMarkets: boolean;
  includeEvents: boolean;
};

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const asInt = Math.trunc(n);
  return asInt > 0 ? asInt : undefined;
}

function parseVenues(value: string | undefined): VenueFilter {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function resolveOptions(args: string[]): BackfillOptions {
  const venues = parseVenues(parseFlag(args, "--venue"));
  const limit = parsePositiveInt(parseFlag(args, "--limit"));
  const batchSize = parsePositiveInt(parseFlag(args, "--batch-size")) ?? 1000;
  const dryRun = hasFlag(args, "--dry-run");
  const onlyMarkets = hasFlag(args, "--markets");
  const onlyEvents = hasFlag(args, "--events");
  const includeMarkets = onlyMarkets || !onlyEvents;
  const includeEvents = onlyEvents || !onlyMarkets;

  return { venues, batchSize, limit, dryRun, includeMarkets, includeEvents };
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:embed:backfill -- [options]

Options:
  --venue <venue[,venue]>  Limit to venues (polymarket,limitless,kalshi,dflow)
  --limit <n>              Max items per entity type (default: unlimited)
  --batch-size <n>         Batch size (default: 1000)
  --markets                Only backfill markets
  --events                 Only backfill events
  --dry-run                Print counts without enqueueing
  --help                   Show this help
`);
}

async function backfillMarkets(
  redis: ReturnType<typeof createRedisClient>,
  options: BackfillOptions,
): Promise<number> {
  let total = 0;
  let cursorTs: Date | null = null;
  let cursorId: string | null = null;
  const sortExpr =
    "coalesce(m.updated_at, m.created_at, m.updated_at_db, m.created_at_db)";

  while (true) {
    const remaining =
      options.limit != null ? Math.max(options.limit - total, 0) : undefined;
    if (remaining === 0) break;
    const pageSize =
      remaining != null ? Math.min(options.batchSize, remaining) : options.batchSize;

    const params: Array<string | Date | string[] | number> = [pageSize];
    let where = "m.status = 'ACTIVE'";
    if (options.venues.length) {
      params.push(options.venues);
      where += ` and m.venue = any($${params.length})`;
    }
    if (cursorTs && cursorId) {
      const startIndex = params.length + 1;
      params.push(cursorTs, cursorId);
      where += ` and (${sortExpr}, m.id) < ($${startIndex}, $${startIndex + 1})`;
    }

    const sql = `
      select
        m.id,
        m.venue,
        m.status,
        m.title as market_title,
        e.title as event_title,
        m.description,
        m.category,
        m.outcomes,
        m.market_type,
        ${sortExpr} as sort_ts
      from unified_markets m
      left join unified_events e on e.id = m.event_id
      where ${where}
      order by ${sortExpr} desc, m.id desc
      limit $1;
    `;
    const { rows } = await pool.query(sql, params);
    if (rows.length === 0) break;

    const items: EmbedQueueItem[] = rows.map((row) => ({
      entity_type: "market",
      market_id: row.id,
      venue: row.venue,
      status: row.status,
      market_title: row.market_title,
      event_title: row.event_title,
      description: row.description,
      category: row.category,
      outcomes: row.outcomes,
      market_type: row.market_type,
      updated_at: row.sort_ts,
      source: "backfill",
    }));

    if (!options.dryRun) {
      await enqueueEmbedItems(redis, items);
    }

    total += items.length;
    const lastRow = rows[rows.length - 1];
    const nextCursorTs =
      lastRow.sort_ts ?? lastRow.updated_at ?? lastRow.created_at ?? null;
    if (
      cursorId &&
      cursorTs &&
      nextCursorTs &&
      cursorId === lastRow.id &&
      cursorTs.getTime() === nextCursorTs.getTime()
    ) {
      console.warn(
        "[backfill] markets cursor stalled; stopping to avoid loop",
        { cursorId, cursorTs },
      );
      break;
    }
    cursorTs = nextCursorTs;
    cursorId = lastRow.id;
    console.log(`[backfill] markets batch=${items.length} total=${total}`);
  }

  return total;
}

async function backfillEvents(
  redis: ReturnType<typeof createRedisClient>,
  options: BackfillOptions,
): Promise<number> {
  let total = 0;
  let cursorTs: Date | null = null;
  let cursorId: string | null = null;
  const sortExpr =
    "coalesce(e.updated_at, e.created_at, e.updated_at_db, e.created_at_db)";

  while (true) {
    const remaining =
      options.limit != null ? Math.max(options.limit - total, 0) : undefined;
    if (remaining === 0) break;
    const pageSize =
      remaining != null ? Math.min(options.batchSize, remaining) : options.batchSize;

    const params: Array<string | Date | string[] | number> = [pageSize];
    let where = "e.status = 'ACTIVE'";
    if (options.venues.length) {
      params.push(options.venues);
      where += ` and e.venue = any($${params.length})`;
    }
    if (cursorTs && cursorId) {
      const startIndex = params.length + 1;
      params.push(cursorTs, cursorId);
      where += ` and (${sortExpr}, e.id) < ($${startIndex}, $${startIndex + 1})`;
    }

    const sql = `
      select
        e.id,
        e.venue,
        e.status,
        e.title as event_title,
        e.description,
        e.category,
        ${sortExpr} as sort_ts
      from unified_events e
      where ${where}
      order by ${sortExpr} desc, e.id desc
      limit $1;
    `;
    const { rows } = await pool.query(sql, params);
    if (rows.length === 0) break;

    const eventIds = rows.map((row) => row.id);
    const marketRows = await pool.query(
      `
      select
        event_id,
        title,
        volume_24h,
        volume_total,
        liquidity,
        open_interest
      from unified_markets
      where event_id = any($1)
        and status = 'ACTIVE'
      `,
      [eventIds],
    );
    const marketsByEvent = new Map<
      string,
      Array<{
        title?: string | null;
        volume_24h?: number | null;
        volume_total?: number | null;
        liquidity?: number | null;
        open_interest?: number | null;
      }>
    >();
    for (const row of marketRows.rows) {
      const list = marketsByEvent.get(row.event_id) ?? [];
      list.push(row);
      marketsByEvent.set(row.event_id, list);
    }

    const items: EmbedQueueItem[] = rows.map((row) => {
      const topMarkets = buildTopMarketsText(
        marketsByEvent.get(row.id) ?? [],
        row.event_title,
      );
      return {
        entity_type: "event",
        event_id: row.id,
        venue: row.venue,
        status: row.status,
        event_title: row.event_title,
        top_markets: topMarkets,
        description: row.description,
        category: row.category,
        updated_at: row.sort_ts,
        source: "backfill",
      };
    });

    if (!options.dryRun) {
      await enqueueEmbedItems(redis, items);
    }

    total += items.length;
    const lastRow = rows[rows.length - 1];
    const nextCursorTs =
      lastRow.sort_ts ?? lastRow.updated_at ?? lastRow.created_at ?? null;
    if (
      cursorId &&
      cursorTs &&
      nextCursorTs &&
      cursorId === lastRow.id &&
      cursorTs.getTime() === nextCursorTs.getTime()
    ) {
      console.warn(
        "[backfill] events cursor stalled; stopping to avoid loop",
        { cursorId, cursorTs },
      );
      break;
    }
    cursorTs = nextCursorTs;
    cursorId = lastRow.id;
    console.log(`[backfill] events batch=${items.length} total=${total}`);
  }

  return total;
}

async function run() {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--help")) {
    printHelp();
    return;
  }

  if (!env.redisUrl) {
    throw new Error("[backfill] REDIS_URL is required");
  }

  const options = resolveOptions(args);
  const redis = createRedisClient({ url: env.redisUrl });
  await ensureRedis(redis);

  console.log("[backfill] starting", {
    venues: options.venues.length ? options.venues : "all",
    batchSize: options.batchSize,
    limit: options.limit ?? "unlimited",
    dryRun: options.dryRun,
    includeMarkets: options.includeMarkets,
    includeEvents: options.includeEvents,
  });

  let marketsTotal = 0;
  let eventsTotal = 0;
  if (options.includeMarkets) {
    marketsTotal = await backfillMarkets(redis, options);
  }
  if (options.includeEvents) {
    eventsTotal = await backfillEvents(redis, options);
  }

  console.log("[backfill] done", {
    markets: marketsTotal,
    events: eventsTotal,
    dryRun: options.dryRun,
  });

  await redis.quit();
  await pool.end();
}

run().catch((err) => {
  console.error("[backfill] failed", err);
  process.exit(1);
});
