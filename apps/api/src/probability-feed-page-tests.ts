import assert from "node:assert/strict";

import { fetchProbabilityFeedEventPage } from "./probability-feed-page.js";

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
    fetchAllProbabilityMarketIds: async () => {
      assert.fail("full-universe fallback must not run for a full page");
    },
  });

  assert.deepEqual(candidateCalls, [{ limit: 300, offset: 0 }]);
  assert.equal(probabilityBatches.length, 3);
  assert.ok(probabilityBatches.every((eventIds) => eventIds.length === 100));
  assert.equal(probabilityBatches[0]?.at(0), "event-0");
  assert.equal(probabilityBatches[1]?.at(0), "event-100");
  assert.equal(probabilityBatches[2]?.at(0), "event-200");
  assert.equal(maxActiveProbabilityBatches, 3);
  assert.deepEqual(filteredMarketIds, [["market-1", "market-2", "market-3"]]);
  assert.equal(result.eventRows.length, 50);
}
console.log("ok - probability feed scans bounded ranked event batches");

{
  let fullUniverseCalls = 0;
  const result = await fetchProbabilityFeedEventPage({
    requestedLimit: 3,
    candidateWindowSize: 2,
    probabilityBatchSize: 1,
    maxCandidates: 2,
    fetchCandidateEvents: async () => [{ id: "event-1" }, { id: "event-2" }],
    fetchBatchProbabilityMarketIds: async () => [],
    fetchFilteredEvents: async (marketIds) =>
      marketIds.map((marketId) => ({ id: `event-for-${marketId}` })),
    fetchAllProbabilityMarketIds: async () => {
      fullUniverseCalls += 1;
      return ["market-1", "market-2", "market-3"];
    },
  });

  assert.equal(fullUniverseCalls, 1);
  assert.deepEqual(result.marketIds, ["market-1", "market-2", "market-3"]);
  assert.equal(result.eventRows.length, 3);
}
console.log("ok - probability feed preserves exact fallback at the scan cap");
