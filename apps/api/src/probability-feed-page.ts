export type ProbabilityFeedEventRow = { id: string };

// Sparse filters return a bounded partial discovery page. Scanning 8k events
// repeats candidate ranking and top-of-book reads long enough to outlive the
// frontend timeout; four 300-event windows stay inside that budget.
export const PROBABILITY_EVENT_PROBE_MAX_CANDIDATES = 1_200;

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
