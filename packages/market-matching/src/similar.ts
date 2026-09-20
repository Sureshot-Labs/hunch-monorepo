import {
  eligible,
  EXPECTED_MODEL,
  outcomeCandidates,
  readPolicy,
  type Answer,
} from "./contracts.js";
import { approvalRevision, readMatchingPolicy } from "./policy.js";
import { loadContracts, loadEvent, versionId, type Db } from "./store.js";
import type { LinkRow } from "./resolver.js";

/** Reorder existing embedding candidates only. Scores, membership and exact links stay intact. */
export async function boostRelatedMarkets<T extends { id: string }>(
  db: Db,
  marketId: string,
  items: T[],
): Promise<T[]> {
  if (!items.length || process.env.MATCHING_SIMILAR_ENABLED === "false")
    return items;
  const matching = await readMatchingPolicy(db);
  if (!matching.similarEnabled) return items;
  const lifecycle = await readPolicy(db);
  const [source] = await loadContracts(db, [marketId]);
  const allowed = (c: { venue: string; status: string }) =>
    matching.venues.some((v) => v === c.venue) &&
    eligible(lifecycle, c.venue) &&
    c.status === "ACTIVE";
  if (!source || !allowed(source) || source.eventStatus !== "ACTIVE")
    return items;
  const { rows } = await db.query<
    LinkRow & {
      response_payload: { answers?: { relation?: Answer } };
    }
  >(
    `select el.*, evaluation_row.response_payload
     from event_links el join matching_evaluations evaluation_row on evaluation_row.id=el.evaluation_id
     where el.decision='related' and evaluation_row.decision='related'
       and evaluation_row.policy_version=$3 and evaluation_row.model=$4
       and (el.left_id=$1 or el.right_id=$1)
       and exists (select 1 from unified_markets candidate_market
         where candidate_market.id=any($2::text[])
           and candidate_market.event_id=case when el.left_id=$1 then el.right_id else el.left_id end)
     order by el.id limit 3`,
    [
      source.eventId,
      items.slice(0, 200).map((x) => x.id),
      approvalRevision(matching),
      EXPECTED_MODEL,
    ],
  );
  if (!rows.length) return items;
  const sourceEvent = await loadEvent(db, source.eventId);
  if (!sourceEvent || !allowed(sourceEvent)) return items;
  const relatedChildren = new Set<string>();
  for (const link of rows) {
    const answer = link.response_payload?.answers?.relation;
    if (
      !answer ||
      answer.choice !== "related" ||
      !(answer.probabilities?.related >= matching.eventProbability) ||
      !(answer.confidence >= matching.eventConfidence)
    )
      continue;
    const forward = link.left_id === source.eventId;
    if (
      versionId(sourceEvent) !==
      (forward ? link.left_version : link.right_version)
    )
      continue;
    const target = await loadEvent(db, forward ? link.right_id : link.left_id);
    if (
      !target ||
      target.id === source.eventId ||
      (!matching.sameVenueEnabled && target.venue === source.venue) ||
      !allowed(target) ||
      versionId(target) !== (forward ? link.right_version : link.left_version)
    )
      continue;
    for (const child of target.children) relatedChildren.add(child.id);
  }
  const candidates = await loadContracts(
    db,
    items
      .slice(0, 200)
      .filter((x) => relatedChildren.has(x.id))
      .map((x) => x.id),
  );
  const compatible = new Set(
    candidates
      .filter(
        (c) =>
          allowed(c) &&
          c.eventStatus === "ACTIVE" &&
          outcomeCandidates(source, c).length > 0,
      )
      .map((c) => c.id),
  );
  const boosted = items.filter((x) => compatible.has(x.id)).slice(0, 3);
  const boostedIds = new Set(boosted.map((x) => x.id));
  return [...boosted, ...items.filter((x) => !boostedIds.has(x.id))];
}
