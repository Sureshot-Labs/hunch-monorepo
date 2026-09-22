import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseMapSearchFocus,
  mapSearchFocusQuestionKey,
  normalizeMapSearchFocusQuestions,
  rememberSelectedMapSearchFocus,
  selectMapSearchFocusOptions,
  MAP_SEARCH_FOCUS_MODEL,
} from "./services/map-search-focus.js";
import { buildMarketSignalQuoteContext } from "./services/map-signal-quote-context.js";
import {
  buildMapSearchSystemPromptV2,
  buildMapSearchUserPromptV2,
  MAP_SEARCH_AGENT_OUTPUT_V2_JSON_SCHEMA,
  parseMapSearchAgentOutputV2,
} from "./schemas/ai-map-search.js";
import { buildMapSignalsUserPromptV2 } from "./schemas/ai-map-signals.js";

const questions = [
  "Has the September 24 Trump-Xi meeting been cancelled or postponed?",
  "What new official evidence confirms the two leaders will meet by September 30?",
  "Has a trade-agreement condition changed the probability of the meeting?",
];

function jevReply(choice: string, confidence = 0.8): Response {
  const probabilities = {
    A: 0.025,
    B: 0.025,
    C: 0.025,
    equal: 0.025,
    none: 0.025,
  };
  probabilities[choice as keyof typeof probabilities] = 0.9;
  return new Response(
    JSON.stringify({
      model: MAP_SEARCH_FOCUS_MODEL,
      usage: { cost: 0.00004 },
      answers: {
        focus: { type: "choice", choice, confidence, probabilities },
      },
    }),
  );
}

const baseDecision = {
  apiKey: "fixture",
  options: { marketId: "market-1", questions },
  eventTitle: "Who will Trump meet in September?",
  marketTitle: "Xi Jinping",
  closeTime: "2026-09-30T23:59:00Z",
  priorHeadlines: ["September 24 summit scheduled"],
  priorEvidenceBriefs: [
    "[2026-09-22; confirmed] Summit scheduled — Officials announced a September 24 meeting.",
  ],
};

test("focus candidates stay on exact market and prefer an uncovered contract", () => {
  const suggestions = normalizeMapSearchFocusQuestions(
    [
      { marketId: "wrong", question: questions[0] },
      { marketId: "market-1", question: questions[0] },
      { marketId: "market-1", question: `${questions[0]} ` },
      { marketId: "market-1", question: questions[1] },
      { marketId: "market-2", question: questions[1] },
      { marketId: "market-2", question: questions[2] },
    ],
    new Set(["market-1", "market-2"]),
  );
  assert.equal(suggestions.length, 4);
  assert.deepEqual(
    selectMapSearchFocusOptions({
      suggestions,
      marketIds: ["market-1", "market-2"],
      focusedMarketIds: new Set(["market-1"]),
      askedQuestionKeys: new Set(),
    }),
    { marketId: "market-2", questions: [questions[1], questions[2]] },
  );
  assert.equal(
    selectMapSearchFocusOptions({
      suggestions,
      marketIds: ["market-1"],
      focusedMarketIds: new Set(),
      askedQuestionKeys: new Set([
        mapSearchFocusQuestionKey("market-1", questions[0]),
      ]),
    }),
    null,
  );
});

test("failed or uncertain focus does not mark a market searched, including resume", () => {
  const focusedMarketIds = new Set<string>();
  const askedQuestionKeys = new Set<string>();
  rememberSelectedMapSearchFocus({
    marketId: "market-1",
    selectedQuestion: null,
    focusedMarketIds,
    askedQuestionKeys,
  });
  assert.equal(focusedMarketIds.size, 0);
  assert.equal(askedQuestionKeys.size, 0);
  rememberSelectedMapSearchFocus({
    marketId: "market-1",
    selectedQuestion: questions[0],
    focusedMarketIds,
    askedQuestionKeys,
  });
  assert.deepEqual([...focusedMarketIds], ["market-1"]);
  assert.deepEqual(
    [...askedQuestionKeys],
    [mapSearchFocusQuestionKey("market-1", questions[0])],
  );
});

test("two reversed Jev votes must agree on the same question", async () => {
  const result = await chooseMapSearchFocus({
    ...baseDecision,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        state: {
          A: string;
          B: string;
          C: string;
          exactContract: { tradingCloseTime: string };
          priorDatedEvidence: string[];
        };
      };
      assert.equal(
        body.state.exactContract.tradingCloseTime,
        baseDecision.closeTime,
      );
      assert.deepEqual(
        body.state.priorDatedEvidence,
        baseDecision.priorEvidenceBriefs,
      );
      const label = ["A", "B", "C"].find(
        (key) => body.state[key as keyof typeof body.state] === questions[0],
      );
      return jevReply(label ?? "none");
    },
  });
  assert.equal(result.reason, "selected");
  assert.equal(result.selectedQuestion, questions[0]);
  assert.equal(result.calls, 2);
  assert.equal(result.chargedCostUsd, 0.00008);

  const biased = await chooseMapSearchFocus({
    ...baseDecision,
    fetchImpl: async () => jevReply("A"),
  });
  assert.equal(biased.reason, "disagree");
  assert.equal(biased.selectedQuestion, null);
});

test("uncertain and provider errors fall back, with unknown cost reserved", async () => {
  const uncertain = await chooseMapSearchFocus({
    ...baseDecision,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        state: { A: string; B: string; C: string };
      };
      const label = ["A", "B", "C"].find(
        (key) => body.state[key as keyof typeof body.state] === questions[0],
      );
      return jevReply(label ?? "none", 0.4);
    },
  });
  assert.equal(uncertain.reason, "uncertain");
  assert.equal(uncertain.selectedQuestion, null);

  const failure = await chooseMapSearchFocus({
    ...baseDecision,
    fetchImpl: async () => {
      throw new Error("timeout");
    },
  });
  assert.equal(failure.reason, "provider_error");
  assert.equal(failure.chargedCostUsd, 0.02);
});

test("optional focus questions never invalidate a valid search result", () => {
  const base = {
    version: "map_search_v2",
    status: "NO_EVIDENCE",
    summary: "Nothing new found",
    evidence: [],
  } as const;
  assert.deepEqual(parseMapSearchAgentOutputV2(base).focus_questions, []);
  assert.deepEqual(
    parseMapSearchAgentOutputV2({
      ...base,
      focus_questions: [{ market_id: "wrong", question: "too short" }],
    }).focus_questions,
    [],
  );
  assert.deepEqual(
    parseMapSearchAgentOutputV2({
      ...base,
      focus_questions: [
        { market_id: "market-1", question: questions[0] },
        { market_id: "wrong", question: "too short" },
      ],
    }).focus_questions,
    [{ market_id: "market-1", question: questions[0] }],
  );
  assert.ok(
    !(
      (MAP_SEARCH_AGENT_OUTPUT_V2_JSON_SCHEMA as { required?: string[] })
        .required ?? []
    ).includes("focus_questions"),
  );
});

test("focused prompt starts with exact question but retains other directions", () => {
  const input = {
    runId: "run",
    level: 2,
    nodeId: "node",
    nodeLabel: "September summit",
    nodeRepresentative: "Trump-Xi meeting",
    parentLabel: "Politics",
    siblingLabels: [],
    childLabels: [],
    sampleEventTitles: ["Who will Trump meet in September?"],
    sampleEventMarketTitles: ["Who will Trump meet? | market-1: Xi Jinping"],
    priorHeadlines: ["Meeting scheduled"],
    priorEvidenceBriefs: [
      "[2026-09-22; confirmed] Meeting scheduled — Officials announced the date.",
    ],
    priorFocusedQuestions: [questions[1]],
    focusedQuestion: { marketId: "market-1", question: questions[0] },
    softToolCapThisCall: 3,
    windowHoursForThisCall: 24,
  };
  const config = {
    maxEvidence: 8,
    windowHours: 24,
    recentHoursHint: 4,
    includeWebTool: true,
    includeXTool: true,
    requireDistinctDomains: true,
  };
  const prompt = buildMapSearchUserPromptV2(input, config);
  assert.match(prompt, /First search question for market market-1/);
  assert.match(prompt, /cancelled or postponed/);
  assert.match(prompt, /pivot to other exact contracts/);
  assert.match(prompt, /focus_questions/);
  assert.match(prompt, /Prior dated evidence/);
  assert.match(prompt, /2026-09-22; confirmed/);
  assert.match(prompt, /selected exact question first/);
  assert.doesNotMatch(
    prompt,
    /rank up to 3 candidate directions and pick the best one first/,
  );
  assert.match(prompt, /Trading close is not necessarily/);
  assert.match(prompt, /do not invent missing contract terms/);
  const broadPrompt = buildMapSearchUserPromptV2(
    { ...input, focusedQuestion: null },
    config,
  );
  assert.match(broadPrompt, /rank up to 3 candidate directions/);
  assert.doesNotMatch(broadPrompt, /Search the selected exact question first/);
  assert.match(
    buildMapSearchSystemPromptV2(config),
    /A historically confirmed fact is not automatically current/,
  );
});

test("stale, missing and crossed quotes never reach the signal prompt as prices", () => {
  const now = new Date("2026-09-22T10:00:00.000Z");
  const quote = buildMarketSignalQuoteContext(
    {
      yesBid: 0.99,
      yesAsk: 0.995,
      noBid: 0.005,
      noAsk: 0.01,
      topAsOf: {
        YES: "2026-09-22T09:55:00.000Z",
        NO: "2026-09-22T09:40:00.000Z",
      },
    },
    now,
  );
  assert.equal(quote.yes.status, "fresh");
  assert.equal(quote.no.status, "stale");
  assert.equal(quote.no.bid, null);

  const crossed = buildMarketSignalQuoteContext(
    {
      yesBid: 0.8,
      yesAsk: 0.7,
      noBid: null,
      noAsk: null,
      topAsOf: { YES: "2026-09-22T09:59:00.000Z", NO: null },
    },
    now,
  );
  assert.equal(crossed.yes.status, "invalid");
  assert.equal(crossed.no.status, "missing");

  const inconsistent = buildMarketSignalQuoteContext(
    {
      yesBid: 0.39,
      yesAsk: 0.41,
      noBid: 0.19,
      noAsk: 0.21,
      topAsOf: {
        YES: "2026-09-22T09:59:00.000Z",
        NO: "2026-09-22T09:59:00.000Z",
      },
    },
    now,
  );
  assert.equal(inconsistent.yes.status, "invalid");
  assert.equal(inconsistent.no.status, "invalid");
  assert.equal(inconsistent.yes.bid, null);
  assert.equal(inconsistent.no.ask, null);

  const candidate = {
    marketId: "market-1",
    eventId: "event-1",
    eventTitle: "September meeting",
    marketTitle: "Xi Jinping",
    closeTime: "2026-09-30T23:59:00Z",
    venue: "polymarket",
    activityVolume: 100,
    depthProxy: 100,
    openInterest: 100,
    affinityScore: 0.9,
    contractMatchScore: 0.9,
    affinityRank: 1,
    quoteContext: quote,
  };
  const prompt = buildMapSignalsUserPromptV2({
    runId: "run",
    nodeId: "node",
    nodeLabel: "Politics",
    level: 2,
    evidenceCount: 0,
    confirmedCount: 0,
    evidence: [],
    candidateMarkets: [
      candidate,
      { ...candidate, marketId: "market-2", quoteContext: inconsistent },
    ],
  });
  assert.match(prompt, /yes_bid_ask: 0\.99\/0\.995/);
  assert.match(prompt, /no_bid_ask: unknown/);
  assert.match(prompt, /1%\/99%/);
  assert.match(prompt, /different condition/);
  assert.match(
    prompt,
    /market_id: market-2[\s\S]*yes_bid_ask: unknown[\s\S]*no_bid_ask: unknown/,
  );
});
