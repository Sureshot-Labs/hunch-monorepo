import type { EmbeddingSource, EmbeddingKind } from "./contracts.js";

/** Narrow, sidecar-safe interface: callers own their pool and timeouts. */
export type EmbeddingDb = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

const eligibility = {
  market: "entity.status = 'ACTIVE' and entity.venue = any($1::text[])",
  event: `entity.status = 'ACTIVE' and entity.venue = any($1::text[])
    and exists (select 1 from unified_markets child
      where child.event_id = entity.id and child.status = 'ACTIVE'
        and child.venue = any($1::text[]))`,
};
const table = { market: "unified_markets", event: "unified_events" };

/** The cursor follows scanned rows, not matches. An empty eligible page is not EOF. */
export async function readEmbeddingSourcePage(
  db: EmbeddingDb,
  kind: EmbeddingKind,
  after: string | null,
  venues: string[],
  limit = 500,
): Promise<{ ids: string[]; after: string | null; done: boolean }> {
  if (!venues.length) return { ids: [], after, done: true };
  const pageSize = Math.min(500, Math.max(1, limit));
  const { rows } = await db.query(
    // MATERIALIZED prevents the planner from moving eligibility below LIMIT.
    // Separate first/resume shapes keep the keyset predicate indexable even in
    // a generic prepared plan. No scan of an unbounded ineligible prefix.
    `with embedding_page as materialized (
      select id, status, venue from ${table[kind]}
      ${after === null ? "" : "where id > $3::text"}
      order by id limit $2
    ) select entity.id, (${eligibility[kind]}) as eligible
    from embedding_page entity order by entity.id`,
    after === null ? [venues, pageSize] : [venues, pageSize, after],
  );
  return {
    ids: rows
      .filter((row) => row.eligible === true)
      .map((row) => String(row.id)),
    after: rows.length ? String(rows[rows.length - 1].id) : after,
    done: rows.length < pageSize,
  };
}

export async function countEmbeddingSources(
  db: EmbeddingDb,
  venues: string[],
  options: {
    signal?: AbortSignal;
    onProgress?: (counts: Record<EmbeddingKind, number>) => void;
  } = {},
) {
  const result = { event: 0, market: 0 };
  for (const kind of ["event", "market"] as const) {
    let after: string | null = null;
    for (;;) {
      options.signal?.throwIfAborted();
      const page = await readEmbeddingSourcePage(db, kind, after, venues);
      result[kind] += page.ids.length;
      options.onProgress?.({ ...result });
      if (page.done) break;
      after = page.after;
      // CLI preview is read-only, but must not run a tight unthrottled DB sweep.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return result;
}

function optional(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}
function strings(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* Plain text is not a JSON array. */
    }
  }
  return undefined;
}

/** Hydrate from canonical rows, including terminal state; never trust queued snapshots. */
export async function loadEmbeddingSources(
  db: EmbeddingDb,
  kind: EmbeddingKind,
  ids: string[],
  venues: string[],
): Promise<EmbeddingSource[]> {
  if (!ids.length) return [];
  const sql =
    kind === "market"
      ? `select entity.id, entity.venue, entity.status, entity.title,
        entity.description, entity.category, entity.outcomes, entity.market_type,
        parent.title as event_title, (${eligibility.market}) as eligible
       from unified_markets entity left join unified_events parent on parent.id=entity.event_id
       where entity.id=any($2::text[])`
      : `select entity.id, entity.venue, entity.status, entity.title,
        entity.description, entity.category, (${eligibility.event}) as eligible,
        array(select distinct child.title from unified_markets child
          where child.event_id=entity.id and child.status='ACTIVE'
            and child.venue=any($1::text[])
          order by child.title limit 32) as top_markets
       from unified_events entity where entity.id=any($2::text[])`;
  const { rows } = await db.query(sql, [venues, [...new Set(ids)]]);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return [...new Set(ids)].map((id) => {
    const row = byId.get(id);
    return {
      kind,
      id,
      venue: String(row?.venue ?? ""),
      status: String(row?.status ?? "MISSING"),
      title: String(row?.title ?? ""),
      eventTitle: optional(row?.event_title),
      description: optional(row?.description),
      category: optional(row?.category),
      marketType: optional(row?.market_type),
      outcomes: strings(row?.outcomes),
      topMarkets: strings(row?.top_markets),
      eligible: row?.eligible === true,
    };
  });
}
