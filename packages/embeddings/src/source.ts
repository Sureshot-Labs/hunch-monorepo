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

const timeColumns = {
  market: ["expiration_time", "close_time"],
  event: ["end_date"],
};
type SourceCursor = {
  version: 3;
  venue: string;
  keys: (string | null)[] | null;
};

/** Existing ACTIVE venue/time indexes; ID breaks ties within a time group only. */
export async function readEmbeddingSourcePage(
  db: EmbeddingDb,
  kind: EmbeddingKind,
  after: string | null,
  venues: string[],
  limit = 500,
): Promise<{ ids: string[]; after: string | null; done: boolean }> {
  if (!venues.length) return { ids: [], after, done: true };
  const allowed = [...new Set(venues)].sort();
  const cursor: SourceCursor =
    after === null
      ? { version: 3, venue: allowed[0], keys: null }
      : JSON.parse(after);
  const columns = [...timeColumns[kind], "id"];
  if (
    !cursor ||
    cursor.version !== 3 ||
    !allowed.includes(cursor.venue) ||
    (cursor.keys !== null &&
      (!Array.isArray(cursor.keys) ||
        cursor.keys.length !== columns.length ||
        cursor.keys.some((key) => key !== null && typeof key !== "string") ||
        typeof cursor.keys.at(-1) !== "string"))
  )
    throw new Error("embedding_source_cursor_invalid");
  const pageSize = Math.min(500, Math.max(1, limit));
  const values: unknown[] = [allowed, pageSize, cursor.venue];
  const branches: string[] = [];
  const prefix: string[] = [];
  const order = columns.map((column) => `${column} asc nulls last`).join(", ");
  const branch = (
    conditions: string[],
  ) => `(select ${columns.join(", ")} from ${table[kind]}
    where status = 'ACTIVE' and venue = $3::text
      ${conditions.length ? `and ${conditions.join(" and ")}` : ""}
    order by ${order} limit $2)`;
  const keys = cursor.keys;
  if (keys === null) branches.push(branch([]));
  else
    columns.forEach((column, index) => {
      const key = keys[index];
      if (key === null) prefix.push(`${column} is null`);
      else {
        values.push(key);
        const parameter = `$${values.length}::${column === "id" ? "text" : "timestamptz"}`;
        branches.push(branch([...prefix, `${column} > ${parameter}`]));
        if (column !== "id")
          branches.push(branch([...prefix, `${column} is null`]));
        prefix.push(`${column} = ${parameter}`);
      }
    });
  const { rows } = await db.query(
    // Disjoint seek branches avoid OR/coalesce rescans of the venue prefix.
    // EXISTS runs after LIMIT so an orphan event page still makes progress.
    `with embedding_page as materialized (
      select * from (${branches.join(" union all ")}) source_row
      where $3::text = any($1::text[])
      order by ${order} limit $2
    ) select entity.id, ${timeColumns[kind].map((column, index) => `entity.${column}::text as cursor_time_${index}`).join(", ")}, (${
      kind === "market"
        ? "true"
        : `exists (select 1 from unified_markets child
      where child.event_id = entity.id and child.status = 'ACTIVE'
        and child.venue = any($1::text[]))`
    }) as eligible
    from embedding_page entity order by ${order}`,
    values,
  );
  const nextVenue = allowed[allowed.indexOf(cursor.venue) + 1];
  const last = rows.at(-1);
  const nextCursor: SourceCursor =
    rows.length < pageSize && nextVenue
      ? { version: 3, venue: nextVenue, keys: null }
      : {
          ...cursor,
          keys: last
            ? [
                ...timeColumns[kind].map((_, index) =>
                  last[`cursor_time_${index}`] == null
                    ? null
                    : String(last[`cursor_time_${index}`]),
                ),
                String(last.id),
              ]
            : cursor.keys,
        };
  return {
    ids: rows
      .filter((row) => row.eligible === true)
      .map((row) => String(row.id)),
    after: JSON.stringify(nextCursor),
    done: rows.length < pageSize && !nextVenue,
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
