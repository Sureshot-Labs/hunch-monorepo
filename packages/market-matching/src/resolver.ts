import { readMatchingPolicy, approvalRevision } from "./policy.js";
import {
  eligible,
  readPolicy,
  type Contract,
  type EventContract,
} from "./contracts.js";
import { loadContracts, loadEvent, versionId, type Db } from "./store.js";

export type LinkRow = {
  id: string;
  left_id: string;
  right_id: string;
  left_version: string;
  right_version: string;
  evaluation_id: string;
  decision: string;
  disposition: string;
};
export type ResolvedLink = {
  link: LinkRow;
  source: Contract;
  target: Contract;
  outcomes: { sourceOutcomeId: string; targetOutcomeId: string }[];
};
export async function resolveMarketLinks(
  db: Db,
  marketId: string,
  limit = 20,
): Promise<ResolvedLink[]> {
  return resolveApprovedMarketLinks(db, marketId, null, limit);
}
/** Resolve an explicit bounded page together; cluster reads must not perform N+1 snapshot queries. */
export async function resolveMarketLinkIds(
  db: Db,
  ids: string[],
): Promise<ResolvedLink[]> {
  if (!ids.length) return [];
  return resolveApprovedMarketLinks(db, null, ids.slice(0, 100), 100);
}
async function resolveApprovedMarketLinks(
  db: Db,
  marketId: string | null,
  ids: string[] | null,
  limit: number,
): Promise<ResolvedLink[]> {
  const policy = await readPolicy(db);
  const matching = await readMatchingPolicy(db);
  const rows = await db.query<LinkRow>(
    `select ml.* from market_links ml join matching_evaluations evaluation_row on evaluation_row.id=ml.evaluation_id where evaluation_row.policy_version=$3 and ml.disposition='approved' and ml.decision='equivalent' and ${ids ? "ml.id=any($1::text[])" : "(left_id=$1 or right_id=$1)"} order by ml.id limit $2`,
    [
      ids ?? marketId,
      Math.min(100, Math.max(1, limit)),
      approvalRevision(matching),
    ],
  );
  const contracts = await loadContracts(db, [
    ...new Set(rows.rows.flatMap((x) => [x.left_id, x.right_id])),
  ]);
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const mappings = rows.rows.length
    ? await db.query<{
        market_link_id: string;
        left_outcome_id: string;
        right_outcome_id: string;
      }>(
        "select * from market_outcome_links where market_link_id=any($1::text[])",
        [rows.rows.map((x) => x.id)],
      )
    : { rows: [] };
  return rows.rows.flatMap((link) => {
    const a = byId.get(link.left_id),
      b = byId.get(link.right_id);
    if (
      !a ||
      !b ||
      a.id === b.id ||
      (!matching.sameVenueEnabled && a.venue === b.venue) ||
      versionId(a) !== link.left_version ||
      versionId(b) !== link.right_version ||
      [a, b].some(
        (c) =>
          !matching.venues.some((v) => v === c.venue) ||
          !eligible(policy, c.venue) ||
          c.status !== "ACTIVE" ||
          c.eventStatus !== "ACTIVE",
      )
    )
      return [];
    const forward = marketId === null || marketId === a.id;
    const outcomes = mappings.rows
      .filter((x) => x.market_link_id === link.id)
      .map((x) => ({
        sourceOutcomeId: forward ? x.left_outcome_id : x.right_outcome_id,
        targetOutcomeId: forward ? x.right_outcome_id : x.left_outcome_id,
      }));
    if (!outcomes.length) return [];
    return [
      { link, source: forward ? a : b, target: forward ? b : a, outcomes },
    ];
  });
}
export async function resolveEventLinks(db: Db, eventId: string) {
  const policy = await readPolicy(db);
  const matching = await readMatchingPolicy(db);
  const source = await loadEvent(db, eventId);
  if (
    !source ||
    !matching.venues.some((v) => v === source.venue) ||
    !eligible(policy, source.venue) ||
    source.status !== "ACTIVE"
  )
    return { eventId, source: "hunch_matcher" as const, alternatives: [] };
  const { rows } = await db.query<LinkRow>(
    "select el.* from event_links el join matching_evaluations evaluation_row on evaluation_row.id=el.evaluation_id where evaluation_row.policy_version=$2 and el.disposition='approved' and el.decision='same_event' and (left_id=$1 or right_id=$1) order by el.id limit 20",
    [eventId, approvalRevision(matching)],
  );
  const alternatives: {
    event: EventContract;
    coverage: "partial" | "full";
    links: ResolvedLink[];
  }[] = [];
  if (!rows.length)
    return { eventId, source: "hunch_matcher" as const, alternatives };
  const sourceIds = source.children.map((c) => c.id);
  const sourceSet = new Set(sourceIds);
  // Bounded page shared across event alternatives, not one resolver call per child.
  // Truncation may yield partial coverage; it can never prove missing outcomes full.
  const childLinks = await db.query<{ id: string }>(
    "select id from market_links where disposition='approved' and (left_id=any($1::text[]) or right_id=any($1::text[])) order by id limit 100",
    [sourceIds],
  );
  const resolved = (
    await resolveMarketLinkIds(
      db,
      childLinks.rows.map((x) => x.id),
    )
  ).map((link) =>
    sourceSet.has(link.source.id)
      ? link
      : {
          ...link,
          source: link.target,
          target: link.source,
          outcomes: link.outcomes.map((o) => ({
            sourceOutcomeId: o.targetOutcomeId,
            targetOutcomeId: o.sourceOutcomeId,
          })),
        },
  );
  const sourceContracts = await loadContracts(db, sourceIds);
  for (const link of rows) {
    const forward = link.left_id === eventId;
    const target = await loadEvent(db, forward ? link.right_id : link.left_id);
    if (
      !target ||
      target.id === source.id ||
      (!matching.sameVenueEnabled && target.venue === source.venue) ||
      !matching.venues.some((v) => v === target.venue) ||
      !eligible(policy, target.venue) ||
      target.status !== "ACTIVE" ||
      versionId(source) !==
        (forward ? link.left_version : link.right_version) ||
      versionId(target) !== (forward ? link.right_version : link.left_version)
    )
      continue;
    const links = resolved.filter((x) => x.target.eventId === target.id);
    const targetContracts = await loadContracts(
      db,
      target.children.map((c) => c.id),
    );
    const full =
      sourceContracts.length > 0 &&
      targetContracts.length > 0 &&
      sourceContracts.every(
        (c) =>
          c.outcomes.length > 0 &&
          c.outcomes.every((o) =>
            links.some(
              (x) =>
                x.source.id === c.id &&
                x.outcomes.some((m) => m.sourceOutcomeId === o.id),
            ),
          ),
      ) &&
      targetContracts.every(
        (c) =>
          c.outcomes.length > 0 &&
          c.outcomes.every((o) =>
            links.some(
              (x) =>
                x.target.id === c.id &&
                x.outcomes.some((m) => m.targetOutcomeId === o.id),
            ),
          ),
      );
    alternatives.push({
      event: target,
      coverage: full ? "full" : "partial",
      links,
    });
  }
  return { eventId, source: "hunch_matcher" as const, alternatives };
}
