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

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
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
    else 'CLOSED'::unified_status
  end
`;

const inactiveSourceSql = `
  (
    pm.archived is true
    or pm.closed is true
    or pm.active is false
    or pm.accepting_orders is false
  )
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
          and um.status = 'ACTIVE'::unified_status
          and ${inactiveSourceSql}
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
        and um.status = 'ACTIVE'::unified_status
        and ($1::text is null or um.id > $1)
        and ${inactiveSourceSql}
      order by um.id
      limit $2
    `,
    [after, limit],
  );
  return rows;
}

async function updateRows(
  db: DbQuery,
  rowsToUpdate: StatusRow[],
): Promise<StatusRow[]> {
  if (rowsToUpdate.length === 0) return [];

  const { rows } = await db.query<StatusRow>(
    `
      update unified_markets um
      set
        status = input.target_status::unified_status,
        resolved_outcome = case
          when input.target_status::unified_status = 'ACTIVE'::unified_status then null
          else um.resolved_outcome
        end,
        resolved_outcome_pct = case
          when input.target_status::unified_status = 'ACTIVE'::unified_status then null
          else um.resolved_outcome_pct
        end,
        updated_at_db = now()
      from jsonb_to_recordset($1::jsonb) as input(
        id text,
        current_status text,
        target_status text
      )
      where um.id = input.id
        and um.status = input.current_status::unified_status
      returning
        um.id,
        input.current_status::unified_status as current_status,
        input.target_status::unified_status as target_status
    `,
    [JSON.stringify(rowsToUpdate)],
  );
  return rows;
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const batch = parsePositiveInt("batch", 5000);
  const updateBatch = Math.min(batch, parsePositiveInt("update-batch", 250));
  const limit = parseOptionalPositiveInt("limit");
  const delayMs = parseNonNegativeInt("delay", 0);
  const startAfter = parseArgValue("after");
  const includePlan = (dryRun || hasFlag("plan")) && !hasFlag("skip-plan");

  const startedAt = Date.now();
  console.log("[polymarket:status-refresh] start", {
    dryRun,
    batch,
    updateBatch: dryRun ? null : updateBatch,
    limit,
    delayMs,
    startAfter,
    includePlan,
  });

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '120s'");

    if (includePlan) {
      const plan = await loadPlan(client);
      console.log("[polymarket:status-refresh] plan", plan);
    } else {
      console.log("[polymarket:status-refresh] plan skipped");
    }

    let lastId: string | null = startAfter;
    let processed = 0;
    let updated = 0;
    let pages = 0;
    const transitions = new Map<string, number>();

    while (true) {
      const remaining = limit == null ? null : limit - processed;
      if (remaining != null && remaining <= 0) break;
      const pageLimit = remaining == null ? batch : Math.min(batch, remaining);
      const candidates = await loadDryRunPage(client, lastId, pageLimit);
      if (candidates.length === 0) break;

      const rows: StatusRow[] = [];
      if (dryRun) {
        rows.push(...candidates);
      } else {
        for (const chunk of chunkRows(candidates, updateBatch)) {
          rows.push(...(await updateRows(client, chunk)));
        }
      }

      pages += 1;
      processed += candidates.length;
      updated += dryRun ? 0 : rows.length;
      lastId = candidates.reduce(
        (max, row) => (max == null || row.id > max ? row.id : max),
        lastId,
      );

      for (const row of rows) {
        increment(transitions, `${row.current_status}->${row.target_status}`);
      }

      if (!dryRun && rows.length !== candidates.length) {
        console.warn("[polymarket:status-refresh] batch partial update", {
          page: pages,
          candidates: candidates.length,
          updated: rows.length,
        });
      }

      console.log("[polymarket:status-refresh] batch", {
        page: pages,
        candidates: candidates.length,
        updated: dryRun ? null : rows.length,
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
      updated: dryRun ? null : updated,
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
