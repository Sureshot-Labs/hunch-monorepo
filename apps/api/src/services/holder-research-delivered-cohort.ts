import type { DbQuery } from "../db.js";
import type { HolderResearchPerformanceNoteRow } from "./holder-research-performance.js";

type SourceMessageRow = { note_id: string; id: string; cursor_at: string };
const SOURCE_PAGE_SIZE = 512;

/** Page the indexed delivery source; history lookups only touch exact note IDs.
 * A later recipient must not move an initial publication into a newer window.
 */
export async function loadDeliveredHolderResearchCohort(
  db: DbQuery,
  input: {
    start: Date;
    end: Date;
    limit: number;
    activeOnly?: boolean;
    directionalOnly?: boolean;
    minConfidence?: number | null;
    loadFirstDeliveries: (
      noteIds: string[],
    ) => Promise<HolderResearchPerformanceNoteRow[]>;
  },
): Promise<{ rows: HolderResearchPerformanceNoteRow[]; truncated: boolean }> {
  let cursor: SourceMessageRow | undefined;
  const checked = new Set<string>();
  const byObservation = new Map<string, HolderResearchPerformanceNoteRow>();
  const compare = (
    a: HolderResearchPerformanceNoteRow,
    b: HolderResearchPerformanceNoteRow,
  ) =>
    Date.parse(String(b.published_at)) - Date.parse(String(a.published_at)) ||
    String(b.published_at).localeCompare(String(a.published_at)) ||
    b.note_id.localeCompare(a.note_id) ||
    a.market_id.localeCompare(b.market_id) ||
    String(a.frozen_side).localeCompare(String(b.frozen_side));
  for (;;) {
    const { rows: page } = await db.query<SourceMessageRow>(
      `select sbm.id, sbm.note_id, sbm.sent_at::text as cursor_at
       from signal_bot_messages sbm
       where sbm.message_kind = 'initial'
         and sbm.sent_at >= $1::timestamptz and sbm.sent_at < $2::timestamptz
         and ($3::timestamptz is null or (sbm.sent_at, sbm.id) < ($3::timestamptz, $4::uuid))
       order by sbm.sent_at desc, sbm.id desc
       limit $5::int`,
      [
        input.start.toISOString(),
        input.end.toISOString(),
        cursor?.cursor_at ?? null,
        cursor?.id ?? null,
        SOURCE_PAGE_SIZE,
      ],
    );
    if (page.length === 0) break;
    const noteIds = [...new Set(page.map((row) => row.note_id))].filter(
      (id) => !checked.has(id),
    );
    for (const id of noteIds) checked.add(id);
    if (noteIds.length) {
      for (const row of await input.loadFirstDeliveries(noteIds)) {
        const at = Date.parse(String(row.published_at));
        if (at < input.start.getTime() || at >= input.end.getTime()) continue;
        byObservation.set(
          row.observation_id ??
            `${row.note_id}:${row.market_id}:${row.frozen_side}`,
          row,
        );
      }
    }
    cursor = page[page.length - 1];
    const ordered = [...byObservation.values()].sort(compare);
    // Unread source messages cannot have a first delivery later than themselves.
    // Use a strict timestamp frontier: equal-time ties must be paged completely.
    if (
      ordered.length > input.limit &&
      Date.parse(cursor.cursor_at) <
        Date.parse(String(ordered[input.limit].published_at))
    )
      break;
    if (page.length < SOURCE_PAGE_SIZE) break;
  }
  const ordered = [...byObservation.values()].sort(compare);
  return {
    rows: ordered.slice(0, input.limit),
    truncated: ordered.length > input.limit,
  };
}
