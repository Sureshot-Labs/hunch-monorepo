import type { DbQuery } from "../db.js";
import { readFrozenPublicationEntry } from "./signal-publication-snapshot.js";

/** Same exact delivery-thread cohort as the existing audit. No market scan. */
export const HOLDER_SIDE_CHRONOLOGY_SQL = `
  with report_threads as materialized (
    select distinct chat_id, thread_root_note_id from signal_bot_messages
    where note_id = any($1::uuid[])
  ), report_notes as materialized (
    select distinct msg.note_id from report_threads
    join signal_bot_messages msg using(chat_id,thread_root_note_id)
    where msg.sent_at >= $2::timestamptz and msg.sent_at < $3::timestamptz
      and msg.message_kind in ('initial','research_update')
  )
  select n.id::text as "noteId", delivery_row.sent_at::text as "sentAt",
    delivery_row.message_kind as kind, market_row.id as "marketId",
    market_row.event_id as "eventId", market_row.venue,
    market_row.resolved_outcome as "resolvedOutcome",
    case n.direction when 'up' then 'YES' when 'down' then 'NO' end as side,
    coalesce(nullif(delivery_row.metrics#>>'{publicationSnapshotV1,marketId}',''),
      nullif(delivery_row.metrics#>>'{delivery,view,target,marketId}',''),n.source_id) as "deliveryMarketId",
    upper(coalesce(nullif(delivery_row.metrics#>>'{publicationSnapshotV1,side}',''),
      nullif(delivery_row.metrics#>>'{delivery,view,target,side}',''),
      case n.direction when 'up' then 'YES' when 'down' then 'NO' end)) as "deliverySide",
    delivery_row.metrics->'publicationSnapshotV1' as snapshot,
    delivery_row.metrics#>>'{delivery,view,target,price}' as "legacyPrice",
    n.model_meta#>>'{primary_holder_credentials,primaryHolder,walletId}' as "holderId"
  from report_notes join ai_notes n on n.id=report_notes.note_id
  cross join lateral (
    select msg.sent_at,msg.message_kind,msg.metrics
    from signal_bot_messages msg where msg.note_id=n.id
      and msg.message_kind in ('initial','research_update')
      and msg.telegram_message_id is not null
      and coalesce(msg.metrics->>'status','sent')='sent'
      and coalesce(msg.metrics->>'contentProfile','')<>'x_editorial_draft_v1'
    order by msg.sent_at,msg.id limit 1
  ) delivery_row
  join unified_markets market_row on market_row.id=n.source_id
  where n.producer_type='holder_research' and n.note_type='signal'
    and delivery_row.sent_at >= $2::timestamptz and delivery_row.sent_at < $3::timestamptz
  order by delivery_row.sent_at,n.id
`;

export type HolderChronologyRow = {
  noteId: string;
  sentAt: string;
  kind: string;
  marketId: string;
  eventId: string | null;
  venue: string;
  side: string | null;
  deliveryMarketId?: string | null;
  deliverySide?: string | null;
  resolvedOutcome: string | null;
  snapshot: unknown;
  legacyPrice: unknown;
  holderId: string | null;
};

export function buildHolderSideChronologyReport(rows: HolderChronologyRow[]) {
  const ordered = [
    ...new Map(
      [...rows]
        .sort(
          (a, b) =>
            Date.parse(a.sentAt) - Date.parse(b.sentAt) ||
            a.noteId.localeCompare(b.noteId),
        )
        .map((row) => [row.noteId, row]),
    ).values(),
  ];
  const previous = new Map<string, { side: string; seen: Set<string> }>();
  const eventCounts = new Map<string, number>();
  const holderCounts = new Map<string, number>();
  const timeline = ordered.flatMap((row) => {
    if (row.side !== "YES" && row.side !== "NO") return [];
    const prior = previous.get(row.marketId);
    const change = !prior
      ? "first_in_window"
      : prior.side === row.side
        ? "same_side_repeat"
        : prior.seen.has(row.side)
          ? "return_to_side"
          : "side_change";
    const seen = prior?.seen ?? new Set<string>();
    seen.add(row.side);
    previous.set(row.marketId, { side: row.side, seen });
    if (row.eventId)
      eventCounts.set(row.eventId, (eventCounts.get(row.eventId) ?? 0) + 1);
    if (row.holderId)
      holderCounts.set(row.holderId, (holderCounts.get(row.holderId) ?? 0) + 1);
    const entry = readFrozenPublicationEntry({
      snapshot: row.snapshot,
      legacyPrice:
        (!row.deliveryMarketId || row.deliveryMarketId === row.marketId) &&
        (!row.deliverySide || row.deliverySide === row.side)
          ? row.legacyPrice
          : null,
      marketId: row.marketId,
      venue: row.venue,
      side: row.side,
      sentAt: row.sentAt,
    });
    const resolution = row.resolvedOutcome?.toUpperCase();
    const outcome =
      resolution === "YES" || resolution === "NO"
        ? resolution === row.side
          ? "win"
          : "loss"
        : "unresolved_or_unknown";
    // Legacy display and current/terminal prices never enter exact ROI.
    const roi =
      entry.quality === "quoted_ask" &&
      entry.price != null &&
      outcome !== "unresolved_or_unknown"
        ? outcome === "win"
          ? 1 / entry.price - 1
          : -1
        : null;
    return [
      {
        noteId: row.noteId,
        marketId: row.marketId,
        eventId: row.eventId,
        holderId: row.holderId,
        sentAt: row.sentAt,
        kind: row.kind,
        deliveryMarketId: row.deliveryMarketId ?? row.marketId,
        deliverySide: row.deliverySide ?? row.side,
        side: row.side,
        change,
        outcome,
        entryPrice: entry.price,
        entryQuality: entry.quality,
        roi,
      },
    ];
  });
  const groups = [
    "first_in_window",
    "same_side_repeat",
    "side_change",
    "return_to_side",
  ].map((kind) => {
    const sample = timeline.filter((row) => row.change === kind);
    const priced = sample.flatMap((row) => (row.roi == null ? [] : [row.roi]));
    return {
      kind,
      notes: sample.length,
      wins: sample.filter((row) => row.outcome === "win").length,
      losses: sample.filter((row) => row.outcome === "loss").length,
      exactPricedResolved: priced.length,
      averageRoi: priced.length
        ? priced.reduce((sum, roi) => sum + roi, 0) / priced.length
        : null,
    };
  });
  const concentration = (counts: Map<string, number>) =>
    [...counts]
      .map(([id, notes]) => ({
        id,
        notes,
        share: timeline.length ? notes / timeline.length : 0,
      }))
      .sort((a, b) => b.notes - a.notes || a.id.localeCompare(b.id));
  return {
    scope: "report_delivery_threads_within_window",
    interpretation:
      "Source-thesis publications, not independent trades. First means first observed in this window, not first ever. Same-side repeats include legitimate updates. ROI uses only a matching exact-contract delivery quote; redirected CTA prices are excluded. Hypothetical $1 per resolved publication, before costs; correlated and opposite signals are not an executable portfolio.",
    notes: timeline.length,
    markets: previous.size,
    sideChanges: timeline.filter(
      (row) => row.change === "side_change" || row.change === "return_to_side",
    ).length,
    returns: timeline.filter((row) => row.change === "return_to_side").length,
    groups,
    byEvent: concentration(eventCounts),
    byPrimaryHolder: concentration(holderCounts),
    missingEvent: timeline.filter((row) => !row.eventId).length,
    missingPrimaryHolder: timeline.filter((row) => !row.holderId).length,
    timeline,
  };
}

export async function loadHolderSideChronologyReport(
  db: DbQuery,
  input: { noteIds: string[]; from: Date; to: Date },
) {
  const ids = [...new Set(input.noteIds)];
  const rows = ids.length
    ? (
        await db.query<HolderChronologyRow>(HOLDER_SIDE_CHRONOLOGY_SQL, [
          ids,
          input.from.toISOString(),
          input.to.toISOString(),
        ])
      ).rows
    : [];
  return buildHolderSideChronologyReport(rows);
}
