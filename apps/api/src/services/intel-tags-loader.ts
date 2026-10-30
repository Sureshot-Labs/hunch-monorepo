import type { DbQuery } from "../db.js";
import type { IntelTags } from "../schemas/intel-tags.js";
import {
  classifyIntelTags,
  type IntelTagNote,
  type IntelTagMarket,
} from "./intel-tags.js";
import { parseHolderResearchUpdateV1 } from "./signal-publication-contract.js";

// Only already-selected notes. No feed predicates, ranking or historical position scans here.
export const INTEL_TAG_NOTES_SQL = `
  select note_row.id,note_row.source_id,note_row.note_type,note_row.status,note_row.created_at,
    jsonb_build_object('side',note_row.lineage->'side','decision_snapshot',jsonb_build_object(
      'publicComparisonPositions',note_row.lineage #> '{decision_snapshot,publicComparisonPositions}')) as lineage,
    jsonb_build_object('publicationDecisionV1',note_row.metrics->'publicationDecisionV1',
      'socialInstrumentV1',note_row.metrics->'socialInstrumentV1',
      'holderResearchUpdateV1',note_row.metrics->'holderResearchUpdateV1') as metrics,
    jsonb_build_object('primary_holder_credentials',note_row.model_meta->'primary_holder_credentials',
      'external_research',jsonb_build_object('citations',note_row.model_meta #> '{external_research,citations}')) as model_meta,
    market_row.venue,jsonb_build_object('polymarketProtocol',market_row.metadata->'polymarketProtocol',
      'version',market_row.metadata->'version','resolutionStatus',market_row.metadata->'resolutionStatus',
      'umaResolutionStatus',market_row.metadata->'umaResolutionStatus',
      'umaResolutionStatuses',market_row.metadata->'umaResolutionStatuses') as metadata,market_row.expiration_time,
    market_row.resolved_outcome,market_row.resolved_outcome_pct::text,
    token_row.token_id
  from unnest($1::uuid[]) requested_note(note_id)
  join ai_notes note_row on note_row.id=requested_note.note_id
  left join unified_markets market_row on market_row.id=note_row.source_id
  left join unified_tokens token_row on token_row.token_id=note_row.metrics #>> '{socialInstrumentV1,tokenId}'
    and token_row.market_id=note_row.source_id and token_row.side=note_row.lineage->>'side'
  where note_row.producer_type='holder_research' and note_row.source_kind='market'
`;
export const INTEL_TAG_BASELINES_SQL = `
  select note_row.id,note_row.source_id,note_row.note_type,note_row.status,note_row.created_at,
    jsonb_build_object('side',note_row.lineage->'side','decision_snapshot',jsonb_build_object(
      'publicComparisonPositions',note_row.lineage #> '{decision_snapshot,publicComparisonPositions}')) as lineage,
    jsonb_build_object('publicationDecisionV1',note_row.metrics->'publicationDecisionV1',
      'socialInstrumentV1',note_row.metrics->'socialInstrumentV1') as metrics,'{}'::jsonb as model_meta
  from unnest($1::uuid[]) requested_note(note_id)
  join ai_notes note_row on note_row.id=requested_note.note_id
  where note_row.producer_type='holder_research' and note_row.source_kind='market'
`;
type Row = IntelTagNote & IntelTagMarket;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function loadIntelTags(
  db: DbQuery,
  noteIds: string[],
  options: {
    limitlessPositionContract?: string;
    onError?: (stage: "notes" | "baselines") => void;
  } = {},
): Promise<{ byId: Map<string, IntelTags>; complete: boolean }> {
  const byId = new Map<string, IntelTags>();
  const ids = [...new Set(noteIds)];
  if (!ids.length) return { byId, complete: true };
  let rows: Row[];
  try {
    rows = (await db.query<Row>(INTEL_TAG_NOTES_SQL, [ids])).rows;
  } catch {
    options.onError?.("notes");
    return { byId, complete: false };
  }
  const baselineIds = [
    ...new Set(
      rows.flatMap((row) => {
        const metrics = row.metrics as Record<string, unknown> | null;
        const update = parseHolderResearchUpdateV1(
          metrics?.holderResearchUpdateV1,
        );
        return update && uuid.test(update.baselineNoteId)
          ? [update.baselineNoteId]
          : [];
      }),
    ),
  ];
  let baselines = new Map<string, IntelTagNote>(),
    complete = true;
  if (baselineIds.length) {
    try {
      baselines = new Map(
        (
          await db.query<IntelTagNote>(INTEL_TAG_BASELINES_SQL, [baselineIds])
        ).rows.map((row) => [row.id, row]),
      );
    } catch {
      complete = false;
      options.onError?.("baselines");
    }
  }
  for (const row of rows) {
    const update = parseHolderResearchUpdateV1(
      (row.metrics as Record<string, unknown> | null)?.holderResearchUpdateV1,
    );
    byId.set(
      row.id,
      classifyIntelTags({
        note: row,
        market: row,
        baseline: update ? baselines.get(update.baselineNoteId) : undefined,
        limitlessPositionContract: options.limitlessPositionContract,
      }),
    );
  }
  return { byId, complete };
}
