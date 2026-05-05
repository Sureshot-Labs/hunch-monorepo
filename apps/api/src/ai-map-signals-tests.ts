#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { buildMapSignalsUserPromptV2 } from "./schemas/ai-map-signals.js";
import { normalizeAiMarketMetrics } from "./services/market-ai-metrics.js";
import {
  scoreSignalMarketContractMatch,
  scoreSignalTargetAnchorAlignment,
} from "./services/map-signal-market-match.js";

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
            closeTime: "2026-03-22T23:59:00.000Z",
            venue: "limitless",
            activityVolume: 123.45,
            depthProxy: 67.89,
            openInterest: null,
            affinityScore: 0.77,
            contractMatchScore: 0.66,
            affinityRank: 1,
          },
        ],
      });

      assert.match(prompt, /close_time: 2026-03-22T23:59:00\.000Z/);
      assert.match(prompt, /activity_volume: 123\.45/);
      assert.match(prompt, /depth_proxy: 67\.89/);
      assert.match(prompt, /open_interest: -/);
      assert.match(prompt, /contract_match: 0\.660000/);
      assert.doesNotMatch(prompt, /\n {2}score:/);
      assert.doesNotMatch(prompt, /volume_24h:/);
      assert.doesNotMatch(prompt, /\n {2}liquidity:/);
    },
  },
  {
    name: "scoreSignalMarketContractMatch prefers closer threshold numbers",
    run: () => {
      const referenceTime = new Date("2026-03-26T18:16:00.000Z");
      const evidenceText =
        "MARA sold $1.1B in Bitcoin as BTC broke below $70k, adding pressure on BTC staying above the threshold today.";

      const closeMatch = scoreSignalMarketContractMatch({
        evidenceText,
        eventTitle: "Bitcoin price by end of day?",
        marketTitle: "$70,000 or above",
        closeTime: "2026-03-26T23:59:00.000Z",
        referenceTime,
      });
      const farMatch = scoreSignalMarketContractMatch({
        evidenceText,
        eventTitle: "Bitcoin price by end of day?",
        marketTitle: "$75,000 or above",
        closeTime: "2026-03-26T23:59:00.000Z",
        referenceTime,
      });

      assert.ok(closeMatch > farMatch, `${closeMatch} should be > ${farMatch}`);
    },
  },
  {
    name: "scoreSignalMarketContractMatch prefers matching time windows",
    run: () => {
      const referenceTime = new Date("2026-03-26T18:16:00.000Z");
      const evidenceText = "This matters for today's threshold market.";

      const todayMatch = scoreSignalMarketContractMatch({
        evidenceText,
        eventTitle: "Bitcoin price by end of day?",
        marketTitle: "$68,200 or above",
        closeTime: "2026-03-26T23:59:00.000Z",
        referenceTime,
      });
      const nextMonthMatch = scoreSignalMarketContractMatch({
        evidenceText,
        eventTitle: "Bitcoin price in April?",
        marketTitle: "$68,200 or above",
        closeTime: "2026-04-30T23:59:00.000Z",
        referenceTime,
      });

      assert.ok(
        todayMatch > nextMonthMatch,
        `${todayMatch} should be > ${nextMonthMatch}`,
      );
    },
  },
  {
    name: "scoreSignalMarketContractMatch penalizes opposite comparators",
    run: () => {
      const evidenceText =
        "Selling pressure weakens odds of Bitcoin staying above $70k.";

      const aboveMatch = scoreSignalMarketContractMatch({
        evidenceText,
        eventTitle: "Bitcoin price by end of day?",
        marketTitle: "$70,000 or above",
      });
      const belowMatch = scoreSignalMarketContractMatch({
        evidenceText,
        eventTitle: "Bitcoin price by end of day?",
        marketTitle: "$70,000 or below",
      });

      assert.ok(
        aboveMatch > belowMatch,
        `${aboveMatch} should be > ${belowMatch}`,
      );
    },
  },
  {
    name: "scoreSignalTargetAnchorAlignment catches cross-entity election mismatches",
    run: () => {
      const aligned = scoreSignalTargetAnchorAlignment({
        evidenceText:
          "Flavio Bolsonaro now leads Lula in a new Brazil poll, tightening the 2026 race.",
        eventTitle: "Brazil presidential election 2026",
        marketTitle: "Flavio Bolsonaro",
      });
      const misaligned = scoreSignalTargetAnchorAlignment({
        evidenceText:
          "Flavio Bolsonaro now leads Lula in a new Brazil poll, tightening the 2026 race.",
        eventTitle: "2028 Republican nominee",
        marketTitle: "J.D. Vance",
      });

      assert.ok(aligned.hasStrongEvidenceAnchors);
      assert.ok(aligned.overlap.includes("bolsonaro"));
      assert.ok(misaligned.hasStrongEvidenceAnchors);
      assert.equal(misaligned.overlap.length, 0);
      assert.ok(
        aligned.score > misaligned.score,
        `${aligned.score} should be > ${misaligned.score}`,
      );
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
