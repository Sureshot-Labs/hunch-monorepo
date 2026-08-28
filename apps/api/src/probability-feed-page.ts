export type ProbabilityFeedEventRow = { id: string };

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
