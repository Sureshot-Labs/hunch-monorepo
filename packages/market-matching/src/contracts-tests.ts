import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  approveContract,
  normalizeContract,
  eligible,
  EXPECTED_MODEL,
  outcomeCandidates,
  parentRuleEvidence,
  type MarketRow,
  type Answer,
} from "./contracts.js";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import {
  decide,
  inferenceEvidence,
  makeRequest,
  type JevResult,
} from "./jev.js";

const answer: Answer = {
  choice: "equivalent",
  confidence: 0.98,
  probabilities: {
    equivalent: 0.99,
    inverse: 0,
    different: 0.01,
    insufficient_information: 0,
  },
};
test("captured parent-rule calibration preserves election/price matches and rejects conflicts", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/parent-rule-calibration.json", import.meta.url),
      "utf8",
    ),
  ) as {
    cases: {
      id: string;
      a: MarketRow;
      b: MarketRow;
      expectedApproval: boolean;
      answer: Answer;
      outcomeAnswers: Record<string, Answer>;
      model: string;
    }[];
  };
  for (const entry of fixture.cases) {
    const gate = approveContract(
      normalizeContract(entry.a),
      normalizeContract(entry.b),
      entry.answer,
      entry.model,
      entry.outcomeAnswers,
    );
    assert.equal(gate.approved, entry.expectedApproval, entry.id);
  }
});
test("captured normalization regressions preserve useful matches and reject unresolved rules", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/normalization-regressions.json", import.meta.url),
      "utf8",
    ),
  ) as {
    cases: {
      note: string;
      expectedApproval: boolean;
      a: MarketRow;
      b: MarketRow;
      result: JevResult;
    }[];
  };
  for (const c of fixture.cases) {
    const gate = approveContract(
      normalizeContract(c.a),
      normalizeContract(c.b),
      c.result.answer,
      c.result.model,
      c.result.outcomeAnswers,
    );
    assert.equal(gate.approved, c.expectedApproval, c.note);
  }
});
export function fixture(
  id = "polymarket:a",
  overrides: Partial<MarketRow> = {},
): MarketRow {
  return {
    id,
    event_id: id + ":event",
    venue: id.split(":")[0],
    title: "Alice",
    event_title: "US presidential election 2028 winner",
    description:
      "YES if the selected candidate wins the 2028 election. On cancellation NO pays 1.",
    event_description: "",
    status: "ACTIVE",
    event_status: "ACTIVE",
    outcomes: ["YES", "NO"],
    metadata: {},
    tokens: [],
    ...overrides,
  };
}

test("binary winner parent complement is redundant but other parent changes remain blockers", () => {
  const rule =
    "This market will resolve to the person who wins the 2028 US Presidential Election. The resolution source is AP. If undecided, use inauguration on January 20, 2029.";
  const parent = rule.replace(
    "Election.",
    "Election. Otherwise, this market will resolve to “No.”",
  );
  const base = fixture("polymarket:winner", {
    description: rule,
    event_description: parent,
  });
  const normalized = normalizeContract(base);
  assert(!normalized.blockers.includes("unresolved_parent_rules"));
  assert.equal(normalized.parentRules, parent);
  assert.equal(inferenceEvidence(normalized).parentRules, rule);
  assert.notEqual(
    normalized.fingerprint,
    normalizeContract({ ...base, event_description: rule }).fingerprint,
  );
  for (const changed of [
    parent.replace("2028", "2024"),
    parent.replace("AP", "NBC"),
    parent.replace("January 20", "January 21"),
    parent.replace("“No.”", "“Yes.”"),
    parent.replace("“No.”", "50-50."),
    parent + " On cancellation, resolve 50-50.",
    parent.replace("Otherwise,", "On cancellation,"),
  ]) {
    const c = normalizeContract({ ...base, event_description: changed });
    assert(c.blockers.includes("unresolved_parent_rules"), changed);
    assert.equal(parentRuleEvidence(c).rules, changed);
  }
  assert(
    normalizeContract({
      ...base,
      outcomes: ["Alice", "Bob"],
    }).blockers.includes("unresolved_parent_rules"),
  );
});

test("event description headings are context, while wrong year and appended rules are material", () => {
  const base = fixture("polymarket:heading", {
    event_title: "What price will Ethereum hit in 2026?",
    event_description: "What price will Ethereum hit before 2027?",
  });
  const c = normalizeContract(base);
  assert(!c.blockers.includes("unresolved_parent_rules"));
  assert.equal(inferenceEvidence(c).parentRules, "");
  for (const parent of [
    "What price will Ethereum hit before 2026?",
    "What price will Ethereum hit in 2026? Resolve using Coinbase.",
    "What price will Bitcoin hit before 2027?",
    "What price will Ethereum hit before January 1, 2027?",
  ])
    assert(
      normalizeContract({
        ...base,
        event_description: parent,
      }).blockers.includes("unresolved_parent_rules"),
      parent,
    );
});
test("policy respects maintenance and unreleased venues", () => {
  assert(eligible(DEFAULT_VENUE_LIFECYCLE_POLICY, "polymarket"));
  assert(eligible(DEFAULT_VENUE_LIFECYCLE_POLICY, "limitless"));
  assert(!eligible(DEFAULT_VENUE_LIFECYCLE_POLICY, "kalshi"));
  assert(!eligible(DEFAULT_VENUE_LIFECYCLE_POLICY, "hyperliquid"));
});
test("fingerprint ignores price but captures parent and token identity", () => {
  const row = fixture();
  const base = normalizeContract(row);
  assert.notEqual(
    base.fingerprint,
    normalizeContract({ ...row, close_time: "2028-11-07T12:00:00Z" })
      .fingerprint,
  );
  assert.equal(
    normalizeContract({ ...row, close_time: "2028-11-07T12:00:00Z" })
      .fingerprint,
    normalizeContract({ ...row, close_time: new Date("2028-11-07T12:00:00Z") })
      .fingerprint,
  );
  assert.equal(
    base.fingerprint,
    normalizeContract({ ...row, best_bid: 0.8, volume_total: 99 }).fingerprint,
  );
  assert.notEqual(
    base.fingerprint,
    normalizeContract({ ...row, event_description: "Different rule" })
      .fingerprint,
  );
  assert.notEqual(
    base.fingerprint,
    normalizeContract({
      ...row,
      tokens: [{ token_id: "new", outcome_side: "YES" }],
    }).fingerprint,
  );
});
test("strict equal contracts have explicit YES and NO mappings", () => {
  const result = approveContract(
    normalizeContract(fixture()),
    normalizeContract(fixture("limitless:a")),
    answer,
    EXPECTED_MODEL,
  );
  assert(result.approved);
  assert.equal(result.mapping.length, 2);
});
test("presentation whitespace preserves exact rules but sources/operators/deadlines remain material", () => {
  const rules =
    "YES if value >= 100 by 11:59 PM ET ( https://example.test/rule ).";
  const a = normalizeContract(
    fixture("limitless:format", { description: rules }),
  );
  const canonical = rules
    .replace("11:59 PM", "11:59PM")
    .replace("( https://example.test/rule )", "(https://example.test/rule)");
  const b = normalizeContract(
    fixture("polymarket:format", {
      description: canonical,
      event_description: rules,
    }),
  );
  assert(approveContract(a, b, answer, EXPECTED_MODEL).approved);
  for (const description of [
    canonical.replace(">=", ">"),
    canonical.replace("example.test", "another.test"),
    canonical.replace("11:59", "11:58"),
  ]) {
    assert(
      !approveContract(
        a,
        normalizeContract(fixture("polymarket:format", { description })),
        answer,
        EXPECTED_MODEL,
      ).approved,
    );
  }
});
test("linked settlement sources survive HTML cleanup and invalidate prior evidence", () => {
  for (const quote of ['"', "'", ""]) {
    const description = `YES if Alice wins according to <a href=${quote}https://source-a.test/result${quote}>official results</a>.`;
    const a = normalizeContract(fixture("polymarket:linked", { description }));
    const changed = normalizeContract(
      fixture("polymarket:linked", {
        description: description.replace("source-a", "source-b"),
      }),
    );
    assert(a.rules[0].includes("https://source-a.test/result"));
    assert.notEqual(a.fingerprint, changed.fingerprint);
    assert(!approveContract(a, changed, answer, EXPECTED_MODEL).approved);
    const incomplete = normalizeContract(
      fixture("polymarket:linked", {
        description: description.replace("</a>", ""),
      }),
    );
    assert(incomplete.rules[0].includes("https://source-a.test/result"));
    assert(
      JSON.stringify(makeRequest("contract", a, changed)).includes(
        "source-b.test",
      ),
    );
  }
});
test("HTML attribute names and quoted values cannot hide the settlement href", () => {
  for (const prefix of [
    ' data-href="https://static.test"',
    ' title="href=https://static.test"',
    " title='href=\"https://static.test\"'",
  ]) {
    const description = `YES according to <a${prefix} href="https://source-a.test">official source</a>.`;
    const a = normalizeContract(
      fixture("polymarket:link-attributes", { description }),
    );
    const b = normalizeContract(
      fixture("polymarket:link-attributes", {
        description: description.replace("source-a", "source-b"),
      }),
    );
    assert(a.rules[0].includes("https://source-a.test"));
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert(!approveContract(a, b, answer, EXPECTED_MODEL).approved);
  }
});
test("explicit one-slot template binds flat questions to child outcomes without dropping context", () => {
  const question = "Will Pacifica launch a token by December 31, 2026?";
  const a = normalizeContract(
    fixture("limitless:flat", { title: question, event_title: question }),
  );
  const child = {
    title: "December 31 2026",
    event_title: "Will Pacifica launch a token by ___ ?",
    metadata: { question: "Will Pacifica launch a token by December 31 2026?" },
  };
  const b = normalizeContract(fixture("polymarket:child", child));
  assert.equal(outcomeCandidates(a, b).length, 2);
  assert(
    approveContract(a, b, answer, EXPECTED_MODEL, {
      outcome_0_0: answer,
      outcome_1_1: answer,
    }).approved,
  );
  for (const patch of [
    { title: "December 31 2025" },
    { event_title: "Will Ostium launch a token by ___ ?" },
    {
      metadata: {
        question: "Will Pacifica launch a token by December 31 2025?",
      },
    },
  ]) {
    assert(
      !approveContract(
        a,
        normalizeContract(fixture("polymarket:child", { ...child, ...patch })),
        answer,
        EXPECTED_MODEL,
      ).approved,
    );
  }
  const generic = (year: string) =>
    normalizeContract(
      fixture(`polymarket:${year}`, {
        event_title: `Election ${year}`,
        metadata: { question: "Will Alice win?" },
      }),
    );
  assert(
    !approveContract(generic("2024"), generic("2028"), answer, EXPECTED_MODEL)
      .approved,
  );
});
test("relative market creation windows require an anchored start, not identical wording", () => {
  const patch = {
    description:
      "YES if the value exceeds 100 between the creation of this market and December 31, 2026.",
  };
  const a = normalizeContract(fixture("limitless:relative", patch));
  assert(a.blockers.includes("implicit_context_requires_review"));
  assert(
    !approveContract(
      a,
      normalizeContract(fixture("polymarket:relative", patch)),
      answer,
      EXPECTED_MODEL,
    ).approved,
  );
});

test("identical descriptions referring to external full rules cannot autoapprove", () => {
  const description =
    "YES if Alice wins. For full rules, see: https://example.test/contract.pdf";
  const a = normalizeContract(fixture("polymarket:external", { description }));
  const b = normalizeContract(fixture("limitless:external", { description }));
  const gate = approveContract(a, b, answer, EXPECTED_MODEL);
  assert.equal(gate.approved, false);
  assert(gate.blockers.includes("external_rules_required"));
});
test("strong outcome answers cannot bypass a weak binary contract decision", () => {
  const result = approveContract(
    normalizeContract(fixture()),
    normalizeContract(fixture("limitless:a")),
    { ...answer, confidence: 0.87 },
    EXPECTED_MODEL,
    { outcome_0_0: answer, outcome_1_1: answer },
  );
  assert.equal(result.approved, false);
  assert(result.blockers.includes("contract_model_gate"));
});
test("different years, election/inauguration, sources, boundaries, missing/parent rules cannot approve", () => {
  for (const patch of [
    { event_title: "US presidential election 2024 winner" },
    { event_title: "2028 inauguration" },
    { description: "YES if selected candidate wins. Different source." },
    { description: "Value > 100" },
    { description: "Value >= 100" },
    { description: "" },
    { event_description: "Different date 2025" },
    { title: "Republican" },
    { title: "Other" },
  ]) {
    assert(
      !approveContract(
        normalizeContract(fixture()),
        normalizeContract(fixture("limitless:a", patch)),
        answer,
        EXPECTED_MODEL,
      ).approved,
    );
  }
});
test("inverse, weak evidence and model drift fail closed", () => {
  const a = normalizeContract(fixture()),
    b = normalizeContract(fixture("limitless:a"));
  assert(
    !approveContract(a, b, { ...answer, choice: "inverse" }, EXPECTED_MODEL)
      .approved,
  );
  assert(
    !approveContract(a, b, { ...answer, confidence: 0.89 }, EXPECTED_MODEL)
      .approved,
  );
  assert(!approveContract(a, b, answer, "new-model").approved);
});
test("named outcome maps to candidate YES, not all NO alternatives", () => {
  const a = normalizeContract(fixture());
  const b = normalizeContract(
    fixture("limitless:group", {
      title: "Winner",
      outcomes: ["Alice", "Bob"],
      tokens: [
        { token_id: "alice", outcome_side: "Alice" },
        { token_id: "bob", outcome_side: "Bob" },
      ],
    }),
  );
  const candidates = outcomeCandidates(a, b);
  assert.equal(candidates.length, 1);
  const result = approveContract(a, b, answer, EXPECTED_MODEL, {
    [candidates[0].key]: answer,
  });
  assert(result.approved);
  assert.equal(result.mapping.length, 1);
  assert.equal(result.mapping[0].left, a.outcomes[0].id);
});
test("multi-outcome array position never supplies stable identity", () => {
  const a = normalizeContract(
    fixture("limitless:multi", { outcomes: ["Alice", "Bob"] }),
  );
  assert(a.blockers.includes("ambiguous_outcome_identity"));
});
test("request contains independent typed outcome checks", () => {
  const a = normalizeContract(fixture()),
    b = normalizeContract(fixture("limitless:a"));
  const payload = makeRequest("contract", a, b);
  assert.equal(Object.keys(payload.questions).length, 3);
});
test("invalid answer keys and malformed probability values rejected", async () => {
  const mock: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        model: EXPECTED_MODEL,
        answers: {
          relation: {
            ...answer,
            type: "choice",
            probabilities: { equivalent: 1 },
          },
        },
        usage: { cost: 0 },
      }),
      { status: 200 },
    );
  await assert.rejects(
    decide("event", {}, {}, "test", mock),
    /invalid_response/,
  );
});
test("rate limits preserve Retry-After and authorization is terminal", async () => {
  await assert.rejects(
    decide(
      "event",
      {},
      {},
      "test",
      async () =>
        new Response("", { status: 429, headers: { "Retry-After": "12" } }),
    ),
    (e: unknown) =>
      e instanceof Error && "retryAfterMs" in e && e.retryAfterMs === 12000,
  );
  await assert.rejects(
    decide(
      "event",
      {},
      {},
      "test",
      async () => new Response("", { status: 401 }),
    ),
    /http_401/,
  );
});
