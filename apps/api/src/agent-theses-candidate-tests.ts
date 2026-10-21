import assert from "node:assert/strict";
import { agentFixtureAuthors } from "./fixtures/agent-theses-authors.js";
import { agentScreenFixture } from "./fixtures/agent-theses-screening.js";
import { DEFAULT_AGENT_THESES_POLICY } from "./services/agent-theses-policy.js";
import {
  screenAgentCandidates,
  selectAgentCandidate,
  writeAgentThesis,
  AGENT_ENTRY_RULES,
  AGENT_WRITER_MAX_REQUEST_BYTES,
  type AgentModelClient,
} from "./services/agent-theses-model.js";
import { researchAgent } from "./services/agent-theses-research.js";
import {
  selectAgentShortlist,
  agentMarketCondition,
  type AgentCandidate,
} from "./services/agent-theses-context.js";

const now = new Date("2026-10-21T18:16:52.116Z");
assert.equal(
  agentMarketCondition(null, {
    rulesPrimary: "Exact settlement",
    rulesSecondary: "Void exceptions",
    earlyCloseCondition: "May close early",
  }),
  "Exact settlement\n\nVoid exceptions\n\nMay close early",
);
assert.equal(
  agentMarketCondition(
    "Exact settlement",
    JSON.stringify({
      rules_primary: "Exact settlement",
      rules_secondary: "Extra rule",
    }),
  ),
  "Exact settlement\n\nExtra rule",
);
assert.equal(agentMarketCondition(null, null), "");
// Public titles/quotes from the read-only production sample. Conditions below
// are explicit TEST summaries, not verbatim full settlement rules. No live LLM.
function candidate(
  id: string,
  title: string,
  ask: string,
  eventTitle = title,
): AgentCandidate {
  return {
    marketId: id,
    title,
    eventTitle,
    category: "politics",
    condition: `Fixture: ${title} at the stated deadline.`,
    closesAt: "2026-10-27T23:59:00Z",
    sides: [
      {
        label: "Yes",
        ask,
        quoteAsOf: now.toISOString(),
        instrument: {
          venue: "limitless",
          marketId: id,
          outcome: "YES",
          tokenId: `${id}:YES`,
        } as AgentCandidate["sides"][number]["instrument"],
      },
    ],
    sources: [
      {
        id: `market:${id}`,
        kind: "market",
        title,
        excerpt: "Contract-grounded subjective opinion is allowed.",
        url: null,
        asOf: now.toISOString(),
      },
    ],
  };
}
const hormuz = candidate("polymarket:5568259", "No Hormuz Agreement", "0.954");
const backup = candidate(
  "polymarket:2109956",
  "Israeli election results in a hung parliament?",
  "0.37",
);
const bitcoin = candidate(
  "polymarket:701496",
  "↑ 100,000",
  "0.27",
  "What price will Bitcoin hit in 2026?",
);
const base = {
  author: agentFixtureAuthors[0],
  policy: DEFAULT_AGENT_THESES_POLICY,
  history: [],
  candidates: [hormuz, backup, bitcoin],
  now,
};
const publish = (c: AgentCandidate, maximum: string) => ({
  decision: "publish",
  marketId: c.marketId,
  outcome: "YES",
  body: "An opinion grounded in the supplied contract.",
  sourceIds: [c.sources[0].id],
  counterargument: "The outcome remains uncertain.",
  maxEntryPrice: maximum,
  changeReason: null,
});
const response = (value: unknown) => ({
  choices: [
    { message: { content: JSON.stringify(value) }, finish_reason: "stop" },
  ],
});
let draft = "";
await assert.rejects(
  writeAgentThesis({
    ...base,
    angle: "mechanism",
    model: async () => response(publish(hormuz, "0.90")),
    onDraftText: async (text) => {
      draft = text;
    },
  }),
  /writer_entry_above_observed_ask/,
);
assert.ok(
  draft,
  "bad model output retains a visible draft, not a valid paper entry",
);
let writes = 0;
const alternative = await writeAgentThesis({
  ...base,
  angle: "mechanism",
  model: async (call) => {
    writes++;
    const body = call.body as { messages: Array<{ content: string }> };
    assert.ok(body.messages[0].content.includes(AGENT_ENTRY_RULES));
    assert.ok(!body.messages[0].content.includes("Write the thesis even when"));
    const supplied = JSON.parse(body.messages[1].content);
    assert.equal(supplied.candidates[0].sides[0].ask, "0.954");
    assert.equal(supplied.candidates[1].sides[0].ask, "0.37");
    return response(publish(backup, "0.37"));
  },
});
assert.equal(alternative.decision, "publish");
assert.equal(writes, 1);
assert.equal((alternative as { marketId: string }).marketId, backup.marketId);
// Decimal boundary, including a sub-float difference, is enforced server-side.
await assert.rejects(
  writeAgentThesis({
    ...base,
    candidates: [candidate("precise", "Exact", "0.370000000000000001")],
    angle: "mechanism",
    model: async () =>
      response(
        publish(candidate("precise", "Exact", "0.370000000000000001"), "0.37"),
      ),
  }),
  /writer_entry_above_observed_ask/,
);
const screened = await screenAgentCandidates({
  ...base,
  model: async (call) => {
    const body = call.body as {
      state: {
        candidates: Record<
          string,
          {
            condition: string;
            conditionIsExcerpt: boolean;
            outcomes: Array<{ ask: string }>;
          }
        >;
      };
    };
    assert.equal(body.state.candidates.c0.outcomes[0].ask, "0.954");
    assert.equal(body.state.candidates.c0.conditionIsExcerpt, false);
    return agentScreenFixture(call.body, (label) =>
      label === "c0"
        ? "entry_not_acceptable"
        : label === "c2"
          ? "off_topic"
          : "usable",
    );
  },
});
assert.deepEqual(
  screened.map((c) => c.decision),
  ["entry_not_acceptable", "usable", "off_topic"],
);
// Rich multilingual contexts must be split, not silently bypass screening or
// lose trailing settlement clauses / news after the first four sources.
const richCandidates = Array.from({ length: 24 }, (_, i) => ({
  ...backup,
  marketId: `rich:${i}`,
  condition: `${"Условие. ".repeat(500)}FINAL_CLAUSE`,
  sources: Array.from({ length: 8 }, (_, j) => ({
    ...backup.sources[0],
    id: `source:${i}:${j}`,
    kind: j > 3 ? ("external_summary" as const) : ("market" as const),
    excerpt: `${"Доступные материалы. ".repeat(50)}${j}`,
  })),
}));
let screeningCalls = 0;
const richScreen = await screenAgentCandidates({
  ...base,
  candidates: richCandidates,
  model: async (call) => {
    screeningCalls++;
    assert.ok(
      Buffer.byteLength(JSON.stringify(call.body)) <=
        AGENT_WRITER_MAX_REQUEST_BYTES,
    );
    const state = (
      call.body as {
        state: {
          candidates: Record<
            string,
            {
              condition: string;
              background: Array<{ id: string; excerptIsTruncated: boolean }>;
            }
          >;
        };
      }
    ).state;
    for (const c of Object.values(state.candidates)) {
      assert.ok(c.condition.endsWith("FINAL_CLAUSE"));
      assert.equal(c.background.length, 8);
      assert.ok(c.background[7].id.endsWith(":7"));
      assert.equal(c.background[7].excerptIsTruncated, true);
    }
    return agentScreenFixture(call.body);
  },
});
assert.ok(screeningCalls > 1 && screeningCalls <= 24);
assert.deepEqual(
  richScreen.map((c) => c.marketId),
  richCandidates.map((c) => c.marketId),
);
await assert.rejects(
  screenAgentCandidates({
    ...base,
    candidates: [
      { ...backup, condition: "x".repeat(AGENT_WRITER_MAX_REQUEST_BYTES) },
    ],
    model: async () => {
      throw new Error("must_not_spend_before_size_preflight");
    },
  }),
  /jev_context_too_large/,
);
await assert.rejects(
  screenAgentCandidates({
    ...base,
    model: async (call) => {
      const r = agentScreenFixture(call.body);
      assert.ok(r);
      delete r.answers.screen_c1;
      return r;
    },
  }),
  /jev_invalid_choice/,
);
const selectedResponse = (count: number) => ({
  model: DEFAULT_AGENT_THESES_POLICY.jevModel,
  answers: {
    market: {
      type: "choice",
      choice: "c0",
      confidence: 0.6,
      probabilities: Object.fromEntries([
        ...Array.from({ length: count }, (_, i) => [
          `c${i}`,
          i === 0 ? (count === 1 ? 1 : 0.6) : i === count - 1 ? 0.3 : 0.1,
        ]),
        ["none", 0],
      ]),
    },
    angle: {
      type: "choice",
      choice: "mechanism",
      confidence: 1,
      probabilities: { mechanism: 1, countercase: 0, change: 0 },
    },
  },
});
const ranked = await selectAgentCandidate({
  ...base,
  model: async () => selectedResponse(3),
});
assert.equal(
  ranked.alternatives?.[0].marketId,
  bitcoin.marketId,
  "backups follow validated Jev scores, not input order",
);

for (const scenario of [
  "mixed",
  "all_rejected",
  "screen_error",
  "budget",
  "lease",
] as const) {
  const stages: string[] = [];
  const report: Record<string, unknown> = {};
  const run = researchAgent({
    ...base,
    db: { query: async () => ({ rows: [] }) } as unknown as Parameters<
      typeof researchAgent
    >[0]["db"],
    redis: {
      zmScore: async () => [null, null, null],
      zRange: async () => [],
      get: async () => null,
    } as unknown as Parameters<typeof researchAgent>[0]["redis"],
    revision: "fixture",
    freshMarketIds: [],
    now: () => now,
    report,
    recent: [],
    assertLease: async () => {},
    onConsidered: async () => {},
    onProgress: async () => {},
    model: (async (call) => {
      stages.push(call.stage);
      const screen = agentScreenFixture(call.body, (label) =>
        scenario === "all_rejected" || label !== "c1"
          ? "entry_not_acceptable"
          : "usable",
      );
      if (screen) {
        if (scenario === "screen_error") throw new Error("model_http_429");
        if (scenario === "budget") throw new Error("agent_budget_exhausted");
        if (scenario === "lease") throw new Error("agent_lease_lost");
        return screen;
      }
      if (call.stage === "jev") {
        const supplied = (
          call.body as {
            state: { candidates: Record<string, { marketId: string }> };
          }
        ).state.candidates;
        if (scenario === "mixed")
          assert.deepEqual(
            Object.values(supplied).map((c) => c.marketId),
            [backup.marketId],
          );
        return selectedResponse(Object.keys(supplied).length);
      }
      const body = JSON.parse(
        (call.body as { messages: Array<{ content: string }> }).messages[1]
          .content,
      );
      if (scenario === "mixed") assert.equal(body.candidates.length, 1);
      return response(publish(backup, "0.40"));
    }) as AgentModelClient,
  });
  if (scenario === "budget" || scenario === "lease") {
    await assert.rejects(
      run,
      scenario === "budget" ? /agent_budget_exhausted/ : /agent_lease_lost/,
    );
    assert.deepEqual(stages, ["jev"]);
  } else {
    const result = await run;
    if (scenario === "all_rejected") {
      assert.equal(result, null);
      assert.equal(report.status, "jev_screened_out");
      assert.deepEqual(
        stages,
        ["jev"],
        "no writer or selector charge after a successful all-reject screen",
      );
    } else {
      assert.equal(result?.candidate.marketId, backup.marketId);
      assert.deepEqual(stages, ["jev", "jev", "writer"]);
      if (scenario === "screen_error")
        assert.equal(report.screeningFallback, "model_http_429");
    }
  }
}

const ladder = Array.from({ length: 40 }, (_, i) => ({
  ...bitcoin,
  marketId: `btc:${i}`,
  title: `Bitcoin threshold ${i}`,
  category: "crypto",
}));
const otherCrypto = Array.from({ length: 20 }, (_, i) => ({
  ...bitcoin,
  marketId: `crypto:${i}`,
  eventTitle: `Crypto protocol ${i}`,
  category: "crypto",
}));
const unrelated = Array.from({ length: 10 }, (_, i) => ({
  ...hormuz,
  marketId: `politics:${i}`,
}));
const pool = [...ladder, ...otherCrypto, ...unrelated];
const shortlist = selectAgentShortlist(
  pool,
  unrelated.map((c) => c.marketId),
  pool.map(() => null),
  24,
  "crypto",
  [...ladder, ...otherCrypto].map((c) => c.marketId),
);
assert.equal(shortlist.filter((c) => c.category === "crypto").length, 23);
assert.ok(
  shortlist.slice(0, 12).filter((c) => c.marketId.startsWith("crypto:"))
    .length >= 10,
  "a price ladder cannot consume the entire interest quota",
);
assert.equal(shortlist.length, 24);
assert.equal(new Set(shortlist.map((c) => c.marketId)).size, 24);
console.log(
  "Agent candidate screening, observed-ask/backup contract, diverse shortlist and safe failure paths passed (mock models).",
);
