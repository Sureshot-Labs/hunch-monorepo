import { pool, type DbQuery } from "./db.js";

type Status = "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";

type StatusRow = {
  id: string;
  current_status: Status;
  target_status: Status;
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
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInt(name: string): number | null {
  const raw = parseArgValue(name);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(name: string, fallback: number): number {
  const raw = parseArgValue(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function mapToObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

const targetStatusSql = `
  case
    when pm.archived is true then 'ARCHIVED'::unified_status
    when pm.closed is true
      or pm.active is false
      or pm.accepting_orders is false
      then 'CLOSED'::unified_status
    else 'ACTIVE'::unified_status
  end
`;

async function loadPlan(db: DbQuery) {
  const { rows } = await db.query<{
    current_status: Status;
    target_status: Status;
    total: string;
  }>(
    `
      with mismatches as (
        select
          um.status as current_status,
          ${targetStatusSql} as target_status
        from unified_markets um
        join polymarket_markets pm
          on pm.id = um.venue_market_id
        where um.venue = 'polymarket'
          and um.status not in ('SETTLED'::unified_status, 'ARCHIVED'::unified_status)
          and um.status is distinct from ${targetStatusSql}
      )
      select current_status, target_status, count(*)::text as total
      from mismatches
      group by current_status, target_status
      order by current_status, target_status
    `,
  );

  return rows.map((row) => ({
    currentStatus: row.current_status,
    targetStatus: row.target_status,
    total: Number(row.total),
  }));
}

async function loadDryRunPage(
  db: DbQuery,
  after: string | null,
  limit: number,
): Promise<StatusRow[]> {
  const { rows } = await db.query<StatusRow>(
    `
      select
        um.id,
        um.status as current_status,
        ${targetStatusSql} as target_status
      from unified_markets um
      join polymarket_markets pm
        on pm.id = um.venue_market_id
      where um.venue = 'polymarket'
        and um.status not in ('SETTLED'::unified_status, 'ARCHIVED'::unified_status)
        and ($1::text is null or um.id > $1)
        and um.status is distinct from ${targetStatusSql}
      order by um.id
      limit $2
    `,
    [after, limit],
  );
  return rows;
}

async function updatePage(
  db: DbQuery,
  after: string | null,
  limit: number,
): Promise<StatusRow[]> {
  const { rows } = await db.query<StatusRow>(
    `
      with candidates as (
        select
          um.id,
          um.status as current_status,
          ${targetStatusSql} as target_status
        from unified_markets um
        join polymarket_markets pm
          on pm.id = um.venue_market_id
        where um.venue = 'polymarket'
          and um.status not in ('SETTLED'::unified_status, 'ARCHIVED'::unified_status)
          and ($1::text is null or um.id > $1)
          and um.status is distinct from ${targetStatusSql}
        order by um.id
        limit $2
      )
      update unified_markets um
      set
        status = candidates.target_status,
        resolved_outcome = case
          when candidates.target_status = 'ACTIVE'::unified_status then null
          else um.resolved_outcome
        end,
        resolved_outcome_pct = case
          when candidates.target_status = 'ACTIVE'::unified_status then null
          else um.resolved_outcome_pct
        end,
        updated_at_db = now()
      from candidates
      where um.id = candidates.id
      returning
        um.id,
        candidates.current_status,
        candidates.target_status
    `,
    [after, limit],
  );
  return rows;
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const batch = parsePositiveInt("batch", 5000);
  const limit = parseOptionalPositiveInt("limit");
  const delayMs = parseNonNegativeInt("delay", 0);
  const startAfter = parseArgValue("after");

  const startedAt = Date.now();
  console.log("[polymarket:status-refresh] start", {
    dryRun,
    batch,
    limit,
    delayMs,
    startAfter,
  });

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '120s'");

    const plan = await loadPlan(client);
    console.log("[polymarket:status-refresh] plan", plan);

    let lastId: string | null = startAfter;
    let processed = 0;
    let pages = 0;
    const transitions = new Map<string, number>();

    while (true) {
      const remaining = limit == null ? null : limit - processed;
      if (remaining != null && remaining <= 0) break;
      const pageLimit = remaining == null ? batch : Math.min(batch, remaining);
      const rows = dryRun
        ? await loadDryRunPage(client, lastId, pageLimit)
        : await updatePage(client, lastId, pageLimit);
      if (rows.length === 0) break;

      pages += 1;
      processed += rows.length;
      lastId = rows.reduce(
        (max, row) => (max == null || row.id > max ? row.id : max),
        lastId,
      );

      for (const row of rows) {
        increment(transitions, `${row.current_status}->${row.target_status}`);
      }

      console.log("[polymarket:status-refresh] batch", {
        page: pages,
        rows: rows.length,
        processed,
        lastId,
      });

      if (delayMs > 0) await sleep(delayMs);
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    console.log("[polymarket:status-refresh] done", {
      dryRun,
      pages,
      processed,
      transitions: mapToObject(transitions),
      lastId,
      elapsedSec,
    });
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error("[polymarket:status-refresh] failed", error);
    process.exitCode = 1;
  })
  .finally(() => {
    return pool.end();
  });
