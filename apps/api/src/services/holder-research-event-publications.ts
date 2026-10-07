import type { DbQuery } from "../db.js";
import type { HolderResearchAgentOutputV1 } from "../schemas/holder-research.js";

export type EventPublication = {
  event_id: string;
  market_id: string;
  side: string;
  note_id: string | null;
  published_at: string;
  title: string;
  summary: string;
  win_condition: string | null;
  holder_ids: string[];
};
export type EventPublicationHistory = {
  role: "editorial_comparison_only";
  status: "complete" | "partial" | "unavailable" | "disabled";
  hasMore: boolean;
  items: Array<{
    marketId: string;
    side: string;
    title: string;
    summary: string;
    selectedOutcomeCondition: string | null;
    supportingHolderOverlap: number;
  }>;
};

/** One indexed event-target batch, latest state of each distinct market/side. */
export async function loadEventPublications(
  db: DbQuery,
  eventIds: string[],
  asOf: Date,
): Promise<EventPublication[]> {
  if (!eventIds.length) return [];
  return (
    await db.query<EventPublication>(
      `
    select publication_row.*, coalesce(holder_targets.holder_ids, array[]::text[]) as holder_ids
    from unnest($1::text[]) as requested_event(event_id)
    cross join lateral (
      select thesis_row.* from (
        select distinct on (n.source_id, n.direction)
          requested_event.event_id, n.source_id as market_id,
          case n.direction when 'up' then 'YES' else 'NO' end as side,
          n.id::text as note_id, n.created_at::text as published_at,
          n.title, n.description as summary,
          nullif(n.metrics #>> '{sideCopy,winCondition}', '') as win_condition
        from ai_note_targets event_target
        join ai_notes n on n.id = event_target.note_id
        where event_target.target_kind = 'event' and event_target.target_id = requested_event.event_id
          and event_target.created_at >= $2::timestamptz - interval '7 days'
          and n.created_at >= $2::timestamptz - interval '7 days' and n.created_at <= $2::timestamptz
          and n.note_type = 'signal' and n.producer_type = 'holder_research'
          and n.status in ('active','superseded') and n.direction in ('up','down')
        order by n.source_id, n.direction, n.created_at desc, n.id desc
      ) thesis_row order by thesis_row.published_at::timestamptz desc, thesis_row.note_id desc limit 7
    ) publication_row
    left join lateral (
      select array_agg(wallet_target.target_id order by wallet_target.target_id) as holder_ids
      from ai_note_targets wallet_target
      where wallet_target.note_id = publication_row.note_id::uuid and wallet_target.target_kind = 'wallet'
    ) holder_targets on true
  `,
      [[...new Set(eventIds)], asOf.toISOString()],
    )
  ).rows;
}

export function buildEventPublicationHistory(input: {
  enabled: boolean;
  available: boolean;
  eventId: string | null;
  loaded: EventPublication[];
  committed: EventPublication[];
  selectedHolderIds: string[];
}): EventPublicationHistory {
  const rows = [...input.loaded, ...input.committed]
    .filter((row) => row.event_id === input.eventId)
    .sort(
      (a, b) =>
        Date.parse(b.published_at) - Date.parse(a.published_at) ||
        String(b.note_id).localeCompare(String(a.note_id)),
    );
  const latest = new Map<string, EventPublication>();
  for (const row of rows)
    if (!latest.has(`${row.market_id}:${row.side}`))
      latest.set(`${row.market_id}:${row.side}`, row);
  const retained = [...latest.values()].slice(0, 6);
  const overlap = new Set(input.selectedHolderIds);
  return {
    role: "editorial_comparison_only",
    status: !input.enabled
      ? "disabled"
      : !input.available
        ? "unavailable"
        : latest.size > 6 || retained.some((row) => !row.win_condition)
          ? "partial"
          : "complete",
    hasMore: latest.size > 6,
    items: input.enabled
      ? retained.map((row) => ({
          marketId: row.market_id,
          side: row.side,
          title: row.title,
          summary: row.summary,
          selectedOutcomeCondition: row.win_condition,
          supportingHolderOverlap: new Set(
            row.holder_ids.filter((id) => overlap.has(id)),
          ).size,
        }))
      : [],
  };
}

/** History is evidence of a comparison, not a new facts/financial gate. */
export function applyEditorialDuplicate(
  output: HolderResearchAgentOutputV1,
  history: EventPublicationHistory,
): HolderResearchAgentOutputV1 {
  if (
    !output.editorial_duplicate ||
    history.status === "disabled" ||
    !history.items.length
  )
    return output;
  return {
    ...output,
    status: "SKIP",
    public_context: null,
    rationale: `Editorial duplicate: ${output.rationale}`,
  };
}

export function withEventPublicationHistory<T extends Record<string, unknown>>(
  candidateJson: T,
  history?: EventPublicationHistory,
) {
  return history && history.status !== "disabled"
    ? { ...candidateJson, eventPublicationHistory: history }
    : candidateJson;
}
