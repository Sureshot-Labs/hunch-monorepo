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
  event: MarketMapEventSummary;
};

/** Cache by snapshot entity, not by arbitrary user input. Concurrent searches share work. */
export async function hydrateMapSearchDocuments(
  documents: readonly MapSearchDocument[],
  cache: Map<string, Promise<MarketMapEventSummary | null>>,
  hydrate: (
    events: MarketMapEventSummary[],
  ) => Promise<MarketMapEventSummary[]>,
): Promise<MapSearchDocument[]> {
  const key = (doc: MapSearchDocument) => `${doc.venue}:${doc.eventId}`;
  const missing = documents.filter((doc) => !cache.has(key(doc)));
  if (missing.length) {
    const hydration = hydrate(missing.map((doc) => doc.event)).then(
      (events) =>
        new Map(
          events.map((event) => [`${event.venue}:${event.eventId}`, event]),
        ),
    );
    for (const doc of missing) {
      const id = key(doc);
      const promise = hydration.then((events) => events.get(id) ?? null);
      cache.set(id, promise);
    }
  }
  try {
    const hydrated = await Promise.all(
      documents.map(async (doc) => {
        const event = await cache.get(key(doc));
        return event ? { ...doc, event } : null;
      }),
    );
    return hydrated.filter((doc): doc is MapSearchDocument => doc != null);
  } catch (error) {
    for (const doc of missing) cache.delete(key(doc));
    throw error;
  }
}

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
      // A hidden representative title is not the theme's name: matching it
      // would incorrectly include every sibling event in that theme.
      labels.push(node.label);
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
        event,
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
      .map(({ text: _text, event: _event, ...item }) => item),
  };
}

/** A filtered snapshot, not a new hierarchy. Counts and weights exclude hidden events. */
export function buildMapSearchView(
  nodes: readonly MarketMapNode[],
  documents: readonly MapSearchDocument[],
  q: string,
  venues: readonly string[],
) {
  const result = searchMapDocuments(documents, q, venues, documents.length);
  const matched = new Set(
    result.items.map((item) => `${item.venue}:${item.eventId}`),
  );
  const selected = documents.filter((doc) =>
    matched.has(`${doc.venue}:${doc.eventId}`),
  );
  const eventsByNode = new Map<string, MarketMapEventSummary[]>();
  for (const doc of selected) {
    for (const id of doc.nodeIds) {
      const events = eventsByNode.get(id) ?? [];
      events.push(doc.event);
      eventsByNode.set(id, events);
    }
  }
  return {
    events: selected.map((doc) => ({ ...doc.event, nodeIds: doc.nodeIds })),
    nodes: nodes
      .filter((node) => eventsByNode.has(node.id))
      .map((node) => {
        const events = eventsByNode.get(node.id) ?? [];
        const hero = events.reduce((best, event) =>
          event.volume24h > best.volume24h ? event : best,
        );
        const venueBreakdown: MarketMapNode["venueBreakdown"] = {};
        for (const event of events) {
          const metrics = venueBreakdown[event.venue] ?? {
            eventCount: 0,
            sumVolume24h: 0,
            sumLiquidity: 0,
            sumOpenInterest: 0,
          };
          metrics.eventCount++;
          metrics.sumVolume24h += event.volume24h;
          metrics.sumLiquidity += event.liquidity;
          metrics.sumOpenInterest += event.openInterest;
          venueBreakdown[event.venue] = metrics;
        }
        const signals = events.flatMap(
          (event) =>
            event.signalsPreview ?? (event.topSignal ? [event.topSignal] : []),
        );
        const eventIds = new Set(events.map((event) => event.eventId));
        const marketIds = new Set(
          events.flatMap((event) => [
            event.representativeMarketId,
            ...(event.marketsPreview ?? []).map((market) => market.marketId),
          ]),
        );
        const directSignals = (
          node.signalsPreview ?? (node.topSignal ? [node.topSignal] : [])
        ).filter((signal) => {
          if (signal.targetVenue && !venueBreakdown[signal.targetVenue])
            return false;
          if (signal.targetEventId) return eventIds.has(signal.targetEventId);
          if (signal.targetMarketId)
            return marketIds.has(signal.targetMarketId);
          return true;
        });
        const uniqueSignals = [
          ...new Map(
            [...directSignals, ...signals].map((signal) => [
              JSON.stringify([
                signal.title,
                signal.createdAt,
                signal.targetMarketId,
                signal.targetEventId,
              ]),
              signal,
            ]),
          ).values(),
        ];
        return {
          ...node,
          childIds: node.childIds.filter((id) => eventsByNode.has(id)),
          eventCount: events.length,
          sumVolume24h: events.reduce((sum, event) => sum + event.volume24h, 0),
          sumLiquidity: events.reduce((sum, event) => sum + event.liquidity, 0),
          sumOpenInterest: events.reduce(
            (sum, event) => sum + event.openInterest,
            0,
          ),
          venueBreakdown,
          venueCount: Object.keys(venueBreakdown).length,
          dominantVenue: hero.venue,
          sampleEventIds: events.map((event) => event.eventId),
          heroEventId: hero.eventId,
          heroMarketId: hero.representativeMarketId,
          heroImage: hero.image,
          heroIcon: hero.icon,
          childrenPreview: [],
          eventsPreview: events.slice(0, 12),
          signalCountDirect: directSignals.length,
          signalCountSubtree: Math.max(
            uniqueSignals.length,
            events.reduce((sum, event) => sum + (event.signalCount ?? 0), 0),
          ),
          topSignal: uniqueSignals[0] ?? null,
          signalsPreview: uniqueSignals.slice(0, 3),
        };
      }),
  };
}
