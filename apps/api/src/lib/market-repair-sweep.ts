export type RepairCursor = { terminalAt: string; marketId: string };

export function repairCursorKey(venues: string[], cutoffDays: number): string {
  return `market:active-status-repair:cursor:v1:${[...venues].sort().join(",") || "all"}:${cutoffDays}`;
}

export function parseRepairCursor(raw: string | null): RepairCursor | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as RepairCursor;
  if (
    !value ||
    typeof value.terminalAt !== "string" ||
    !Number.isFinite(Date.parse(value.terminalAt)) ||
    typeof value.marketId !== "string" ||
    !value.marketId
  ) {
    throw new Error(
      "Invalid market repair cursor; inspect it before resetting",
    );
  }
  // Keep PostgreSQL's timestamp string: Date.toISOString loses microseconds.
  return { terminalAt: value.terminalAt, marketId: value.marketId };
}

/** One bounded pass. API failures are revisited next sweep, never a head-of-line block. */
export async function runRepairSweep<
  T extends { market_id: string; cursor_terminal_at: string },
>(options: {
  cursor: RepairCursor | null;
  limit: number;
  batchSize: number;
  load: (cursor: RepairCursor | null, limit: number) => Promise<T[]>;
  process: (rows: T[]) => Promise<void>;
  checkpoint: (cursor: RepairCursor | null) => Promise<void>;
}) {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    !Number.isSafeInteger(options.batchSize) ||
    options.batchSize < 1
  ) {
    throw new Error("Repair limit and batch size must be positive integers");
  }
  let cursor = options.cursor;
  let processed = 0;
  while (processed < options.limit) {
    const size = Math.min(options.batchSize, options.limit - processed);
    const rows = await options.load(cursor, size);
    if (!rows.length) {
      await options.checkpoint(null);
      return { processed, complete: true, cursor: null };
    }
    const last = rows[rows.length - 1];
    const next = {
      terminalAt: last.cursor_terminal_at,
      marketId: last.market_id,
    };
    if (
      cursor?.terminalAt === next.terminalAt &&
      cursor.marketId === next.marketId
    ) {
      throw new Error("Market repair cursor did not advance");
    }
    await options.process(rows);
    await options.checkpoint(next);
    cursor = next;
    processed += rows.length;
    if (rows.length < size) {
      await options.checkpoint(null);
      return { processed, complete: true, cursor: null };
    }
  }
  return { processed, complete: false, cursor };
}

// Limit each disjoint branch before merging, avoiding an unbounded materialized
// candidate set on every page. $2 is fixed at run start, not recomputed per page.
export const MARKET_REPAIR_CANDIDATES_SQL = `
  with raw_candidates as (
    (select m.id as market_id, m.venue::text as venue, m.venue_market_id,
            m.slug, m.event_id, m.title, m.close_time as terminal_at
     from unified_markets m
     where m.status = 'ACTIVE'::unified_status
       and ($1::text[] is null or m.venue = any($1::text[]))
       and m.venue in ('polymarket', 'limitless', 'kalshi')
       and m.venue_market_id is not null
       and m.close_time < $2::timestamptz
       and ($4::timestamptz is null or (m.close_time, m.id) > ($4::timestamptz, $5::text))
     order by m.close_time, m.id limit $3::int)
    union all
    (select m.id, m.venue::text, m.venue_market_id,
            m.slug, m.event_id, m.title, m.expiration_time
     from unified_markets m
     where m.status = 'ACTIVE'::unified_status
       and ($1::text[] is null or m.venue = any($1::text[]))
       and m.venue in ('polymarket', 'limitless', 'kalshi')
       and m.venue_market_id is not null
       and m.close_time is null and m.expiration_time < $2::timestamptz
       and ($4::timestamptz is null or (m.expiration_time, m.id) > ($4::timestamptz, $5::text))
     order by m.expiration_time, m.id limit $3::int)
    union all
    (select m.id, m.venue::text, m.venue_market_id,
            m.slug, m.event_id, m.title, e.end_date
     from unified_markets m join unified_events e on e.id = m.event_id
     where m.status = 'ACTIVE'::unified_status
       and ($1::text[] is null or m.venue = any($1::text[]))
       and m.venue in ('polymarket', 'limitless', 'kalshi')
       and m.venue_market_id is not null
       and m.close_time is null and m.expiration_time is null
       and e.end_date < $2::timestamptz
       and ($4::timestamptz is null or (e.end_date, m.id) > ($4::timestamptz, $5::text))
     order by e.end_date, m.id limit $3::int)
  )
  select *, terminal_at::text as cursor_terminal_at from raw_candidates
  order by terminal_at, market_id limit $3::int
`;
