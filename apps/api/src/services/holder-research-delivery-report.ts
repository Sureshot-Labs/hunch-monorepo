import type { DbQuery } from "../db.js";

export const HOLDER_DELIVERY_ACTIVITY_SQL = `
  with report_threads as materialized (
    select distinct source_message.chat_id, source_message.thread_root_note_id
    from signal_bot_messages source_message
    where source_message.note_id = any($1::uuid[])
  )
  select msg.message_kind, coalesce(msg.metrics->>'status','sent') as delivery_status,
    count(*)::int as deliveries, count(distinct msg.note_id)::int as notes
  from report_threads
  join signal_bot_messages msg on msg.chat_id = report_threads.chat_id
    and msg.thread_root_note_id = report_threads.thread_root_note_id
  where msg.sent_at >= $2::timestamptz and msg.sent_at < $3::timestamptz
  group by msg.message_kind, coalesce(msg.metrics->>'status','sent')
`;

/** Activity of the report's delivery threads, not a count of bets. Resolve
 * thread identities once so an initial + its update cannot double-count a
 * thread across batches. The audit already caps its exact note set at 10,000. */
export async function loadHolderDeliveryActivity(
  db: DbQuery,
  input: {
    noteIds: string[];
    from: Date;
    to: Date;
  },
) {
  const ids = [...new Set(input.noteIds)];
  const groups = new Map<
    string,
    { kind: string; status: string; deliveries: number; notes: number }
  >();
  if (ids.length) {
    const { rows } = await db.query<{
      message_kind: string;
      delivery_status: string;
      deliveries: number;
      notes: number;
    }>(HOLDER_DELIVERY_ACTIVITY_SQL, [
      ids,
      input.from.toISOString(),
      input.to.toISOString(),
    ]);
    for (const row of rows) {
      const key = `${row.message_kind}:${row.delivery_status}`;
      const group = groups.get(key) ?? {
        kind: row.message_kind,
        status: row.delivery_status,
        deliveries: 0,
        notes: 0,
      };
      group.deliveries += Number(row.deliveries);
      group.notes += Number(row.notes);
      groups.set(key, group);
    }
  }
  return {
    scope: "report_delivery_threads" as const,
    rows: [...groups.values()].sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.status.localeCompare(b.status),
    ),
  };
}
