#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { buildMapSignalsUserPromptV2 } from "./schemas/ai-map-signals.js";
import { normalizeAiMarketMetrics } from "./services/market-ai-metrics.js";

type TestCase = {
  name: string;
  run: () => void;
};

const tests: TestCase[] = [
  {
    name: "normalizeAiMarketMetrics falls back to total volume for limitless only",
    run: () => {
      assert.deepEqual(
        normalizeAiMarketMetrics({
          venue: "limitless",
          volume24h: 0,
          volumeTotal: 123.45,
          liquidity: 10,
          openInterest: 20,
        }),
        {
          activityVolume: 123.45,
          depthProxy: 10,
          openInterest: 20,
        },
      );

      assert.deepEqual(
        normalizeAiMarketMetrics({
          venue: "kalshi",
          volume24h: 0,
          volumeTotal: 123.45,
          liquidity: 10,
          openInterest: 20,
        }),
        {
          activityVolume: 0,
          depthProxy: 10,
          openInterest: 20,
        },
      );
    },
  },
  {
    name: "normalizeAiMarketMetrics prefers liquidity then open interest for depth proxy",
    run: () => {
      assert.deepEqual(
        normalizeAiMarketMetrics({
          venue: "polymarket",
          volume24h: 50,
          volumeTotal: 100,
          liquidity: 0,
          openInterest: 99,
        }),
        {
          activityVolume: 50,
          depthProxy: 99,
          openInterest: 99,
        },
      );

      assert.deepEqual(
        normalizeAiMarketMetrics({
          venue: "polymarket",
          volume24h: 50,
          volumeTotal: 100,
          liquidity: 0,
          openInterest: 0,
        }),
        {
          activityVolume: 50,
          depthProxy: 0,
          openInterest: null,
        },
      );
    },
  },
  {
    name: "buildMapSignalsUserPromptV2 uses explicit AI-facing market metric names",
    run: () => {
      const prompt = buildMapSignalsUserPromptV2({
        runId: "run-1",
        nodeId: "node-1",
        nodeLabel: "Node",
        level: 1,
        evidenceCount: 1,
        confirmedCount: 1,
        evidence: [
          {
            id: "ev-1",
            headline: "Headline",
            summary: "Summary",
            sourceDomain: "example.com",
            publishedAt: "2026-03-22T00:00:00.000Z",
            confirmation: "confirmed",
            relevance: 0.9,
            confidence: 0.8,
          },
        ],
        candidateMarkets: [
          {
            marketId: "m-1",
            eventId: "e-1",
            eventTitle: "Event",
            marketTitle: "Market",
            venue: "limitless",
            activityVolume: 123.45,
            depthProxy: 67.89,
            openInterest: null,
            affinityScore: 0.77,
            affinityRank: 1,
          },
        ],
      });

      assert.match(prompt, /activity_volume: 123\.45/);
      assert.match(prompt, /depth_proxy: 67\.89/);
      assert.match(prompt, /open_interest: -/);
      assert.doesNotMatch(prompt, /\n {2}score:/);
      assert.doesNotMatch(prompt, /volume_24h:/);
      assert.doesNotMatch(prompt, /\n {2}liquidity:/);
    },
  },
];

let passed = 0;
for (const test of tests) {
  test.run();
  passed += 1;
  console.log(`[ai-map-signals-tests] ok ${test.name}`);
}

console.log(`[ai-map-signals-tests] passed ${passed}/${tests.length}`);
