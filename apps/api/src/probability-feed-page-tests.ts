import assert from "node:assert/strict";

import {
  fetchProbabilityFeedEventPage,
  fetchProbabilityFeedMarketPage,
  PROBABILITY_EVENT_PROBE_MAX_CANDIDATES,
} from "./probability-feed-page.js";

{
  const candidateCalls: Array<{ limit: number; offset: number }> = [];
  const probabilityBatches: string[][] = [];
  const result = await fetchProbabilityFeedMarketPage({
    requestedLimit: 2,
    requestedOffset: 1,
    candidateWindowSize: 4,
    probabilityBatchSize: 2,
    maxCandidates: 8,
    fetchCandidateMarketIds: async (input) => {
      candidateCalls.push(input);
      return {
        marketIds: Array.from(
          { length: input.limit },
          (_, index) => `market-${input.offset + index}`,
        ),
        scannedCandidateCount: input.limit,
      };
    },
    fetchBatchProbabilityMarketIds: async (marketIds) => {
      probabilityBatches.push(marketIds);
      return marketIds.filter((marketId) => Number(marketId.split("-")[1]) % 2);
    },
  });

  assert.deepEqual(candidateCalls, [
    { limit: 4, offset: 0 },
    { limit: 4, offset: 4 },
  ]);
  assert.deepEqual(probabilityBatches, [
    ["market-0", "market-1"],
    ["market-2", "market-3"],
    ["market-4", "market-5"],
  ]);
  assert.deepEqual(result, { marketIds: ["market-3", "market-5"] });
}
console.log("ok - probability market page preserves ranked order and offset");

{
  let probabilityCalls = 0;
  const result = await fetchProbabilityFeedMarketPage({
    requestedLimit: 25,
    requestedOffset: 0,
    candidateWindowSize: 300,
    probabilityBatchSize: 300,
    maxCandidates: 8_000,
    fetchCandidateMarketIds: async () => null,
    fetchBatchProbabilityMarketIds: async () => {
      probabilityCalls += 1;
      return [];
    },
  });

  assert.equal(result, null);
  assert.equal(probabilityCalls, 0);
}
console.log(
  "ok - unsupported probability market ranking falls back explicitly",
);

{
  const candidateCalls: Array<{ limit: number; offset: number }> = [];
  const result = await fetchProbabilityFeedMarketPage({
    requestedLimit: 2,
    requestedOffset: 0,
    candidateWindowSize: 4,
    probabilityBatchSize: 2,
    maxCandidates: 8,
    fetchCandidateMarketIds: async (input) => {
      candidateCalls.push(input);
      return {
        marketIds: input.offset === 0 ? ["market-1"] : ["market-5", "market-7"],
        scannedCandidateCount: input.limit,
      };
    },
    fetchBatchProbabilityMarketIds: async (marketIds) => marketIds,
  });

  assert.deepEqual(candidateCalls, [
    { limit: 4, offset: 0 },
    { limit: 4, offset: 4 },
  ]);
  assert.deepEqual(result, { marketIds: ["market-1", "market-5"] });
}
console.log("ok - probability market page advances by raw scanned candidates");

{
  const candidateCalls: Array<{ limit: number; offset: number }> = [];
  const probabilityBatches: string[][] = [];
  const filteredMarketIds: string[][] = [];
  let activeProbabilityBatches = 0;
  let maxActiveProbabilityBatches = 0;

  const result = await fetchProbabilityFeedEventPage({
    requestedLimit: 50,
    candidateWindowSize: 300,
    probabilityBatchSize: 100,
    maxCandidates: 8_000,
    fetchCandidateEvents: async (input) => {
      candidateCalls.push(input);
      return Array.from({ length: input.limit }, (_, index) => ({
        id: `event-${input.offset + index}`,
      }));
    },
    fetchBatchProbabilityMarketIds: async (eventIds) => {
      activeProbabilityBatches += 1;
      maxActiveProbabilityBatches = Math.max(
        maxActiveProbabilityBatches,
        activeProbabilityBatches,
      );
      probabilityBatches.push(eventIds);
      const batchNumber = probabilityBatches.length;
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeProbabilityBatches -= 1;
      return [`market-${batchNumber}`];
    },
    fetchFilteredEvents: async (marketIds) => {
      filteredMarketIds.push([...marketIds]);
      const count = marketIds.length < 3 ? 22 : 50;
      return Array.from({ length: count }, (_, index) => ({
        id: `filtered-event-${index}`,
      }));
    },
  });

  assert.deepEqual(candidateCalls, [{ limit: 300, offset: 0 }]);
  assert.equal(probabilityBatches.length, 3);
  assert.ok(probabilityBatches.every((eventIds) => eventIds.length === 100));
  assert.equal(probabilityBatches[0]?.at(0), "event-0");
  assert.equal(probabilityBatches[1]?.at(0), "event-100");
  assert.equal(probabilityBatches[2]?.at(0), "event-200");
  assert.equal(maxActiveProbabilityBatches, 1);
  assert.deepEqual(filteredMarketIds, [
    ["market-1"],
    ["market-1", "market-2"],
    ["market-1", "market-2", "market-3"],
  ]);
  assert.equal(result.eventRows.length, 50);
}
console.log("ok - probability feed scans bounded ranked event batches");

{
  const result = await fetchProbabilityFeedEventPage({
    requestedLimit: 3,
    candidateWindowSize: 2,
    probabilityBatchSize: 1,
    maxCandidates: 2,
    fetchCandidateEvents: async () => [{ id: "event-1" }, { id: "event-2" }],
    fetchBatchProbabilityMarketIds: async (eventIds) =>
      eventIds.map((eventId) => `market-for-${eventId}`),
    fetchFilteredEvents: async (marketIds) =>
      marketIds.map((marketId) => ({ id: `event-for-${marketId}` })),
  });

  assert.deepEqual(result.marketIds, [
    "market-for-event-1",
    "market-for-event-2",
  ]);
  assert.equal(result.eventRows.length, 2);
}
console.log("ok - probability feed stays bounded at the scan cap");

{
  const candidateCalls: Array<{ limit: number; offset: number }> = [];
  const result = await fetchProbabilityFeedEventPage({
    requestedLimit: 25,
    candidateWindowSize: 300,
    probabilityBatchSize: 300,
    maxCandidates: PROBABILITY_EVENT_PROBE_MAX_CANDIDATES,
    fetchCandidateEvents: async (input) => {
      candidateCalls.push(input);
      return Array.from({ length: input.limit }, (_, index) => ({
        id: `event-${input.offset + index}`,
      }));
    },
    fetchBatchProbabilityMarketIds: async () => [],
    fetchFilteredEvents: async () => [],
  });

  assert.deepEqual(candidateCalls, [
    { limit: 300, offset: 0 },
    { limit: 300, offset: 300 },
    { limit: 300, offset: 600 },
    { limit: 300, offset: 900 },
  ]);
  assert.deepEqual(result, { eventRows: [], marketIds: [] });
}
console.log(
  "ok - production event probability policy stops after four windows",
);
