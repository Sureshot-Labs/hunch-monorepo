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
  fetchAllProbabilityMarketIds: () => Promise<string[]>;
}): Promise<{ eventRows: EventRow[]; marketIds: string[] }> {
  const probabilityMarketIds = new Set<string>();
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
    const batchProbabilityMarketIds = await Promise.all(
      probabilityBatches.map(args.fetchBatchProbabilityMarketIds),
    );
    for (const marketIds of batchProbabilityMarketIds) {
      for (const marketId of marketIds) {
        probabilityMarketIds.add(marketId);
      }
    }

    let marketIds = [...probabilityMarketIds];
    let eventRows = marketIds.length
      ? await args.fetchFilteredEvents(marketIds)
      : [];
    if (
      eventRows.length >= args.requestedLimit ||
      candidateEventRows.length < candidateLimit
    ) {
      return { eventRows, marketIds };
    }

    candidateOffset += candidateEventRows.length;
    if (candidateOffset >= args.maxCandidates) {
      marketIds = await args.fetchAllProbabilityMarketIds();
      eventRows = marketIds.length
        ? await args.fetchFilteredEvents(marketIds)
        : [];
      return { eventRows, marketIds };
    }
  }
}
