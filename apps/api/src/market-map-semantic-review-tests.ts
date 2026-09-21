import assert from "node:assert/strict";
import {
  applyRelocations,
  buildRelocationCandidates,
  buildSemanticGroups,
  cosine,
  parseRelocationDecision,
  representativeExamples,
  reviewSemanticGroups,
  SEMANTIC_REVIEW_MODEL,
  semanticLeaves,
  type SemanticGroup,
  type SemanticPoint,
} from "./services/market-map-semantic-review.js";

const point = (
  eventId: string,
  vector: number[],
  title = eventId,
): SemanticPoint => ({ eventId, title, vector });
const input = () => [
  {
    points: [
      point("earnings", [1, 0], "Nike earnings"),
      point("social", [0, 1], "Video views"),
      point("social2", [0, 1], "Video views tomorrow"),
    ],
    children: [],
  },
  { points: [point("micron", [1, 0], "Micron earnings")], children: [] },
];
const payload = (choice = "B", confidence = 0.95, cost: unknown = 0.00003) => ({
  model: SEMANTIC_REVIEW_MODEL,
  answers: {
    decision: {
      type: "choice",
      choice,
      confidence,
      probabilities: {
        A: choice === "A" ? 0.97 : 0.01,
        B: choice === "B" ? 0.97 : 0.01,
        neither: 0.01,
        equal: 0.01,
      },
    },
  },
  usage: { cost },
});
const reply = (value: unknown) => new Response(JSON.stringify(value));
assert.equal(cosine([1, 0], [4, 0]), 1);
assert.equal(cosine([0, 0], [1, 0]), 0);
assert.equal(cosine([], [1]), 0);
assert.deepEqual(representativeExamples([], 8), []);
assert.deepEqual(representativeExamples(input()[0].points, 0), []);
const diverse = representativeExamples(input()[0].points, 2);
assert.ok(diverse.some((p) => p.eventId === "earnings"));
assert.deepEqual(
  diverse,
  representativeExamples([...input()[0].points].reverse(), 2),
);
const candidates = buildRelocationCandidates(
  input().map((g) => g.points),
  200,
);
assert.equal(candidates[0].point.eventId, "earnings");
assert.equal(candidates[0].to, 1);
assert.ok(!candidates[0].state.A.includes("Nike earnings"));
assert.ok(candidates.every((c) => c.from !== 1)); // Singleton has no peer evidence.
assert.equal(
  buildRelocationCandidates(
    input().map((g) => g.points),
    1,
  ).length,
  1,
);
assert.deepEqual(Object.keys(candidates[0].state), ["candidate", "A", "B"]); // No label/geometry leakage.
assert.deepEqual(parseRelocationDecision(payload()), {
  choice: "B",
  confidence: 0.95,
});
for (const bad of [
  null,
  {},
  { ...payload(), model: "another-model" },
  payload("unknown"),
  payload("B", NaN),
  payload("B", 1.1),
])
  assert.equal(parseRelocationDecision(bad), null);
const rounded = payload("A", 0.05);
rounded.answers.decision.probabilities = {
  A: 0.27999999999999997,
  B: 0.18,
  neither: 0.28,
  equal: 0.26,
};
assert.ok(parseRelocationDecision(rounded));
const badSum = payload();
badSum.answers.decision.probabilities.A = 0.5;
assert.equal(parseRelocationDecision(badSum), null);

const reviewed = input();
let calls = 0;
const summary = await reviewSemanticGroups(reviewed, {
  apiKey: "test",
  maxPairs: 1,
  budgetUsd: 0.1,
  fetchImpl: async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    calls++;
    assert.equal(request.model, "typesafe/jev-1.13");
    assert.ok(options?.signal);
    if (calls === 1) assert.ok(request.state.B.includes("Micron earnings"));
    else assert.ok(request.state.A.includes("Micron earnings"));
    return reply(payload(calls === 1 ? "B" : "A"));
  },
});
assert.equal(calls, 2);
assert.equal(summary.moved, 1);
assert.equal(summary.chargedCostUsd, 0.00006);
assert.deepEqual(
  reviewed[1].points.map((p) => p.eventId),
  ["micron", "earnings"],
);
assert.deepEqual(
  reviewed
    .flatMap((g) => g.points)
    .map((p) => p.eventId)
    .sort(),
  input()
    .flatMap((g) => g.points)
    .map((p) => p.eventId)
    .sort(),
);

for (const answers of [
  ["B", "B"],
  ["A", "A"],
  ["equal", "equal"],
]) {
  let count = 0;
  const result = await reviewSemanticGroups(input(), {
    apiKey: "test",
    maxPairs: 1,
    budgetUsd: 0.1,
    fetchImpl: async () => reply(payload(answers[count++])),
  });
  assert.equal(result.moved, 0);
}
const low = await reviewSemanticGroups(input(), {
  apiKey: "test",
  maxPairs: 1,
  budgetUsd: 0.1,
  fetchImpl: async () => reply(payload("B", 0.79)),
});
assert.equal(low.attempted, 1);
assert.equal(low.moved, 0);
for (const config of [
  { apiKey: "", maxPairs: 1, budgetUsd: 0.1 },
  { apiKey: "x", maxPairs: 0, budgetUsd: 0.1 },
  { apiKey: "x", maxPairs: 1, budgetUsd: 0 },
]) {
  assert.equal(
    (
      await reviewSemanticGroups(input(), {
        ...config,
        fetchImpl: async () => {
          throw Error("must not call");
        },
      })
    ).attempted,
    0,
  );
}
for (const status of [401, 402, 403, 429, 502]) {
  const result = await reviewSemanticGroups(input(), {
    apiKey: "test",
    maxPairs: 200,
    budgetUsd: 0.1,
    fetchImpl: async () => new Response("secret error body", { status }),
  });
  assert.equal(result.stopped, `http_${status}`);
  assert.equal(result.moved, 0);
  assert.ok(result.attempted <= 4);
  assert.equal(result.chargedCostUsd, result.attempted * 0.01);
}
const timeout = await reviewSemanticGroups(input(), {
  apiKey: "test",
  maxPairs: 1,
  budgetUsd: 0.1,
  fetchImpl: async () => {
    throw Error("private credentials");
  },
});
assert.equal(timeout.stopped, "provider_error");
assert.equal(timeout.chargedCostUsd, 0.01);
const budget = await reviewSemanticGroups(input(), {
  apiKey: "test",
  maxPairs: 200,
  budgetUsd: 0.005,
  fetchImpl: async () => {
    throw Error("must not call");
  },
});
assert.equal(budget.stopped, "budget");
assert.equal(budget.attempted, 0);
const missingCost = await reviewSemanticGroups(input(), {
  apiKey: "test",
  maxPairs: 1,
  budgetUsd: 0.1,
  fetchImpl: async () => reply(payload("A", 0.9, null)),
});
assert.equal(missingCost.chargedCostUsd, 0.01);
assert.equal(missingCost.providerReportedCostCalls, 0);
const malformed = await reviewSemanticGroups(input(), {
  apiKey: "test",
  maxPairs: 1,
  budgetUsd: 0.1,
  fetchImpl: async () => reply({ model: SEMANTIC_REVIEW_MODEL }),
});
assert.equal(malformed.invalidResponses, 1);
assert.equal(malformed.stopped, null);
assert.equal(malformed.moved, 0);
const changedModel = await reviewSemanticGroups(input(), {
  apiKey: "test",
  maxPairs: 1,
  budgetUsd: 0.1,
  fetchImpl: async () => reply({ ...payload(), model: "new-model" }),
});
assert.equal(changedModel.stopped, "model_changed");

// Rebuild ancestors from actual leaves, without losing or duplicating events.
const leaves = input();
const roots: SemanticGroup<SemanticPoint>[] = [
  { points: [...leaves[0].points], children: [leaves[0]] },
  { points: [...leaves[1].points], children: [leaves[1]] },
];
const proposed = buildRelocationCandidates(
  leaves.map((g) => g.points),
  1,
);
assert.equal(applyRelocations(roots, [...proposed, ...proposed]).length, 1);
assert.deepEqual(
  roots[1].points.map((p) => p.eventId),
  ["micron", "earnings"],
);
assert.equal(semanticLeaves(roots).flatMap((g) => g.points).length, 4);
const drafted = buildSemanticGroups(
  input().flatMap((g) => g.points),
  3,
  [2, 2, 2],
  (points) =>
    points.length > 1 ? [points.slice(0, 1), points.slice(1)] : [points],
);
assert.equal(semanticLeaves(drafted).flatMap((g) => g.points).length, 4);
console.log("market map semantic review tests passed");
