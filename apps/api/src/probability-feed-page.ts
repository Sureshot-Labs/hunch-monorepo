export type ProbabilityFeedEventRow = { id: string };

// Sparse filters return a bounded partial discovery page. Scanning 8k events
// repeats candidate ranking and top-of-book reads long enough to outlive the
// frontend timeout; cap every policy at the same 1.2k-event budget.
export const PROBABILITY_EVENT_PROBE_MAX_CANDIDATES = 1_200;
const PROBABILITY_EVENT_PROBE_WINDOW = 300;
const PROBABILITY_EVENT_SELECTIVE_PROBE_WINDOW = 1_200;
const PROBABILITY_EVENT_PROBE_BATCH = 100;
const PROBABILITY_EVENT_SELECTIVE_PROBE_BATCH = 300;

// Market probability discovery is deliberately one bounded rank window.
// Re-ranking a second window scans the same large market relations again and
// turns sparse 80/95 pages into deterministic timeouts. A partial page from
// the first window is preferable to a 504 that discards its useful results.
export const PROBABILITY_MARKET_PROBE_WINDOW = 1_200;
export const PROBABILITY_MARKET_PROBE_BATCH = PROBABILITY_MARKET_PROBE_WINDOW;
export const PROBABILITY_MARKET_PROBE_MAX_CANDIDATES =
  PROBABILITY_MARKET_PROBE_WINDOW;

export function resolveProbabilityEventProbePolicy(
  minProbability: number | undefined,
  maxProbability: number | undefined,
  requestedOffset = 0,
): { candidateWindowSize: number; probabilityBatchSize: number } {
  const selectiveFilter =
    (minProbability != null && minProbability >= 0.7) ||
    (maxProbability != null && maxProbability <= 0.3);
  if (!selectiveFilter) {
    return {
      candidateWindowSize: PROBABILITY_EVENT_PROBE_WINDOW,
      probabilityBatchSize: PROBABILITY_EVENT_PROBE_BATCH,
    };
  }

  const extremeFilter =
    (minProbability != null && minProbability >= 0.9) ||
    (maxProbability != null && maxProbability <= 0.1);
  const deepSelectivePage =
    requestedOffset > 0 &&
    ((minProbability != null && minProbability >= 0.8) ||
      (maxProbability != null && maxProbability <= 0.2));
  return {
    candidateWindowSize: PROBABILITY_EVENT_SELECTIVE_PROBE_WINDOW,
    // Extreme filters usually exhaust the full bounded window. Mapping it in
    // one query avoids four sequential mapping/filter rounds. Deep pages of
    // 80/20 filters need enough matches to satisfy the SQL offset and have the
    // same failure mode. First pages retain 300-row early exit behavior.
    probabilityBatchSize:
      extremeFilter || deepSelectivePage
        ? PROBABILITY_EVENT_SELECTIVE_PROBE_WINDOW
        : PROBABILITY_EVENT_SELECTIVE_PROBE_BATCH,
  };
}

export async function fetchProbabilityFeedMarketPage(args: {
  requestedLimit: number;
  requestedOffset: number;
  candidateWindowSize: number;
  probabilityBatchSize: number;
  maxCandidates: number;
  fetchCandidateMarketIds: (input: {
    limit: number;
    offset: number;
  }) => Promise<{
    marketIds: string[];
    scannedCandidateCount: number;
  } | null>;
  fetchBatchProbabilityMarketIds: (
    candidateMarketIds: string[],
  ) => Promise<string[]>;
}): Promise<{ marketIds: string[] } | null> {
  const qualifiedMarketIds: string[] = [];
  const seenQualifiedMarketIds = new Set<string>();
  const pageTarget = args.requestedOffset + args.requestedLimit;
  let candidateOffset = 0;

  while (candidateOffset < args.maxCandidates) {
    const candidateLimit = Math.min(
      args.candidateWindowSize,
      args.maxCandidates - candidateOffset,
    );
    const candidatePage = await args.fetchCandidateMarketIds({
      limit: candidateLimit,
      offset: candidateOffset,
    });
    if (candidatePage == null) return null;
    const candidateMarketIds = candidatePage.marketIds;

    for (
      let batchOffset = 0;
      batchOffset < candidateMarketIds.length;
      batchOffset += args.probabilityBatchSize
    ) {
      const candidateBatch = candidateMarketIds.slice(
        batchOffset,
        batchOffset + args.probabilityBatchSize,
      );
      const qualifiedBatch = new Set(
        await args.fetchBatchProbabilityMarketIds(candidateBatch),
      );
      for (const marketId of candidateBatch) {
        if (
          !qualifiedBatch.has(marketId) ||
          seenQualifiedMarketIds.has(marketId)
        ) {
          continue;
        }
        seenQualifiedMarketIds.add(marketId);
        qualifiedMarketIds.push(marketId);
      }
      if (qualifiedMarketIds.length >= pageTarget) {
        return {
          marketIds: qualifiedMarketIds.slice(args.requestedOffset, pageTarget),
        };
      }
    }

    if (candidatePage.scannedCandidateCount < candidateLimit) break;
    if (candidatePage.scannedCandidateCount <= 0) break;
    candidateOffset += candidatePage.scannedCandidateCount;
  }

  return {
    marketIds: qualifiedMarketIds.slice(args.requestedOffset, pageTarget),
  };
}

export async function fetchProbabilityFeedEventPage<
  EventRow extends ProbabilityFeedEventRow,
>(args: {
  requestedLimit: number;
  candidateWindowSize: number;
  probabilityBatchSize: number;
  maxCandidates: number;
  fetchCandidateEvents: (input: {
    limit: number;
    offset: number;
  }) => Promise<EventRow[]>;
  fetchBatchProbabilityMarketIds: (
    candidateEventIds: string[],
  ) => Promise<string[]>;
  fetchFilteredEvents: (marketIds: string[]) => Promise<EventRow[]>;
}): Promise<{ eventRows: EventRow[]; marketIds: string[] }> {
  const probabilityMarketIds = new Set<string>();
  let latestEventRows: EventRow[] = [];
  let candidateOffset = 0;

  for (;;) {
    const candidateLimit = Math.min(
      args.candidateWindowSize,
      args.maxCandidates - candidateOffset,
    );
    const candidateEventRows = await args.fetchCandidateEvents({
      limit: candidateLimit,
      offset: candidateOffset,
    });
    const candidateEventIds = candidateEventRows.map((row) => row.id);
    const probabilityBatches: string[][] = [];
    for (
      let batchOffset = 0;
      batchOffset < candidateEventIds.length;
      batchOffset += args.probabilityBatchSize
    ) {
      probabilityBatches.push(
        candidateEventIds.slice(
          batchOffset,
          batchOffset + args.probabilityBatchSize,
        ),
      );
    }
    for (const candidateEventBatch of probabilityBatches) {
      const marketIds =
        await args.fetchBatchProbabilityMarketIds(candidateEventBatch);
      for (const marketId of marketIds) {
        probabilityMarketIds.add(marketId);
      }

      const accumulatedMarketIds = [...probabilityMarketIds];
      latestEventRows = accumulatedMarketIds.length
        ? await args.fetchFilteredEvents(accumulatedMarketIds)
        : [];
      if (latestEventRows.length >= args.requestedLimit) {
        return { eventRows: latestEventRows, marketIds: accumulatedMarketIds };
      }
    }

    const marketIds = [...probabilityMarketIds];
    if (candidateEventRows.length < candidateLimit) {
      return { eventRows: latestEventRows, marketIds };
    }

    candidateOffset += candidateEventRows.length;
    if (candidateOffset >= args.maxCandidates) {
      // This is deliberately a bounded discovery scan. Falling back to the
      // full market universe reads gigabytes and deterministically turns a
      // sparse probability page into a timeout instead of a partial page.
      return { eventRows: latestEventRows, marketIds };
    }
  }
}
