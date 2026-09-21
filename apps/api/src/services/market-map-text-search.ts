import type { MarketMapNode, MarketMapEventSummary } from "./market-map.js";

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export type MapSearchDocument = {
  eventId: string;
  title: string;
  venue: string;
  leafNodeId: string;
  nodeIds: string[];
  text: string;
};

/** Build once per snapshot, not once per keystroke. No live prices or SQL. */
export function buildMapSearchDocuments(
  nodes: MarketMapNode[],
  eventsByLeaf: ReadonlyMap<string, MarketMapEventSummary[]>,
): MapSearchDocument[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const documents: MapSearchDocument[] = [];
  const seen = new Set<string>();
  for (const [leafNodeId, events] of eventsByLeaf) {
    const nodeIds: string[] = [];
    const labels: string[] = [];
    let node = byId.get(leafNodeId);
    while (node && !nodeIds.includes(node.id)) {
      nodeIds.push(node.id);
      labels.push(node.label, node.labelRepresentative, node.labelAi ?? "");
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    for (const event of events) {
      const key = `${event.venue}:${event.eventId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      documents.push({
        eventId: event.eventId,
        title: event.title,
        venue: event.venue,
        leafNodeId,
        nodeIds,
        text: normalize(
          [event.title, event.representativeMarketTitle ?? "", ...labels].join(
            " ",
          ),
        ),
      });
    }
  }
  return documents;
}

export function searchMapDocuments(
  documents: readonly MapSearchDocument[],
  q: string,
  venues: readonly string[],
  limit: number,
  offset = 0,
) {
  const terms = normalize(q).split(" ").filter(Boolean);
  const allowed = new Set(venues);
  const matches = terms.length
    ? documents.filter(
        (doc) =>
          allowed.has(doc.venue) &&
          terms.every((term) => doc.text.includes(term)),
      )
    : [];
  const nodes = new Map<string, number>();
  for (const doc of matches)
    for (const id of doc.nodeIds) nodes.set(id, (nodes.get(id) ?? 0) + 1);
  return {
    total: matches.length,
    nodes: [...nodes].map(([id, matchedEventCount]) => ({
      id,
      matchedEventCount,
    })),
    items: matches
      .slice(offset, offset + limit)
      .map(({ text: _text, ...item }) => item),
  };
}
