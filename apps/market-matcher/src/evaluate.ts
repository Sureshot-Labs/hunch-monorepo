import { readFile } from "node:fs/promises";
import { decide, type EntityKind } from "@hunch/market-matching";

// Explicit, bounded paid evaluation; no database or production worker imports.
type Case = {
  id: string;
  kind: EntityKind;
  expected: string;
  expectedOutcomes?: Record<string, string>;
  a: unknown;
  b: unknown;
};
const file = process.argv[2];
if (!file) throw new Error("Supply a fixture JSON path");
const fixture = JSON.parse(await readFile(file, "utf8")) as { cases: Case[] };
if (
  !Array.isArray(fixture.cases) ||
  fixture.cases.length > 100 ||
  fixture.cases.some(
    (c) => !["event", "contract"].includes(c.kind) || !c.id || !c.expected,
  )
)
  throw new Error("Invalid or oversized evaluation fixture");
if (process.env.MATCHING_EVAL_ENABLED !== "true") {
  console.log(
    JSON.stringify({
      dryRun: true,
      cases: fixture.cases.length,
      maxRequests: 100,
      requires: "MATCHING_EVAL_ENABLED=true; OPENROUTER_API_KEY",
      retrievalRecall: "not_measured_by_this_fixture",
    }),
  );
} else {
  const counts = {
    event: { scored: 0, correct: 0, falseLinks: 0 },
    contract: { scored: 0, correct: 0, falseLinks: 0 },
    outcome: { scored: 0, correct: 0, falseLinks: 0 },
  };
  let cost = 0;
  for (const c of fixture.cases) {
    if (cost >= 1) throw new Error("Evaluation budget exhausted");
    const result = await decide(
      c.kind,
      c.a,
      c.b,
      process.env.OPENROUTER_API_KEY ?? "",
    );
    cost += result.cost;
    const metric = counts[c.kind];
    metric.scored++;
    metric.correct += Number(c.expected === result.answer.choice);
    metric.falseLinks += Number(
      ["same_event", "equivalent", "inverse"].includes(result.answer.choice) &&
        result.answer.choice !== c.expected,
    );
    for (const [key, expected] of Object.entries(c.expectedOutcomes ?? {})) {
      const actual = result.outcomeAnswers?.[key]?.choice;
      counts.outcome.scored++;
      counts.outcome.correct += Number(actual === expected);
      counts.outcome.falseLinks += Number(
        actual !== expected &&
          (actual === "equivalent" || actual === "inverse"),
      );
    }
    console.log(
      JSON.stringify({
        id: c.id,
        expected: c.expected,
        response: result.response,
        cost: result.cost,
      }),
    );
  }
  console.log(
    JSON.stringify({
      counts,
      cost,
      retrievalRecall: "not_measured_by_this_fixture",
    }),
  );
}
