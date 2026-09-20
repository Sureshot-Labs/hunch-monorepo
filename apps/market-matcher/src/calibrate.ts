import { readFile, writeFile, appendFile } from "node:fs/promises";
import {
  approveContract,
  decide,
  eventApproved,
  hash,
  makeRequest,
  type Contract,
  type EntityKind,
  type PromptVariant,
} from "@hunch/market-matching";

type CalibrationCase = {
  id: string;
  group: string;
  split: "development" | "holdout";
  kind: EntityKind;
  expected: string;
  expectedOutcomes?: Record<string, string>;
  origin: string;
  a?: Contract;
  b?: Contract;
  inputA: unknown;
  inputB: unknown;
};
// Local, append-only evaluation. No database imports, no automatic retries.
// A reviewed plan fixes the exact payloads before any credits are spent.
const [
  command,
  fixturePath,
  output,
  variant = "baseline",
  split = "development",
  orientation = "forward",
] = process.argv.slice(2);
if (
  !fixturePath ||
  !output ||
  !["plan", "run", "report"].includes(command) ||
  !["baseline", "evidence", "outcomes"].includes(variant) ||
  !["development", "holdout"].includes(split) ||
  !["forward", "swapped"].includes(orientation)
)
  throw new Error(
    "Usage: calibrate plan|run|report fixture.json output-prefix baseline|evidence|outcomes development|holdout [forward|swapped]",
  );
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  cases: CalibrationCase[];
};
if (
  !Array.isArray(fixture.cases) ||
  fixture.cases.length > 200 ||
  new Set(fixture.cases.map((c) => c.id)).size !== fixture.cases.length
)
  throw new Error("Invalid calibration fixture");
const grouped = new Map<string, Set<string>>();
for (const c of fixture.cases) {
  const splits = grouped.get(c.group) ?? new Set<string>();
  splits.add(c.split);
  grouped.set(c.group, splits);
}
if ([...grouped.values()].some((s) => s.size > 1))
  throw new Error("Group leaks across calibration split");
const cases = fixture.cases.filter((c) => c.split === split);
const jobs = cases.map((c) => {
  const reverse = orientation === "swapped";
  return {
    ...c,
    a: reverse ? c.b : c.a,
    b: reverse ? c.a : c.b,
    expectedOutcomes: reverse
      ? Object.fromEntries(
          Object.entries(c.expectedOutcomes ?? {}).map(([k, v]) => {
            const [, left, right] = k.split("_");
            return [`outcome_${right}_${left}`, v];
          }),
        )
      : c.expectedOutcomes,
    inputA: reverse ? c.inputB : c.inputA,
    inputB: reverse ? c.inputA : c.inputB,
  };
});
const payloads = jobs.map((c) =>
  makeRequest(c.kind, c.inputA, c.inputB, variant as PromptVariant),
);
const manifest = {
  fixtureHash: hash(fixture),
  variant,
  split,
  orientation,
  maxRequests: jobs.length,
  budgetUsd: 0.25,
  jobs: jobs.map((c, i) => ({ ...c, request: payloads[i] })),
};
if (
  !jobs.length ||
  jobs.length > 100 ||
  payloads.some((p) => Buffer.byteLength(JSON.stringify(p)) > 90_000)
)
  throw new Error("Calibration scope outside bounds");
if (command === "plan") {
  await writeFile(`${output}.plan.json`, JSON.stringify(manifest, null, 2), {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      fixtureHash: manifest.fixtureHash,
      variant,
      split,
      orientation,
      requests: jobs.length,
      budgetUsd: manifest.budgetUsd,
    }),
  );
} else if (command === "run") {
  const plan = JSON.parse(await readFile(`${output}.plan.json`, "utf8"));
  if (hash(plan) !== hash(manifest))
    throw new Error("Plan changed; review a new plan before inference");
  if (!process.env.OPENROUTER_API_KEY)
    throw new Error("OPENROUTER_API_KEY required");
  await writeFile(`${output}.results.jsonl`, "", { flag: "wx" });
  let spent = 0;
  for (const c of jobs) {
    if (spent + 0.01 > manifest.budgetUsd)
      throw new Error("Calibration budget exhausted");
    try {
      const result = await decide(
        c.kind,
        c.inputA,
        c.inputB,
        process.env.OPENROUTER_API_KEY,
        fetch,
        15000,
        variant as PromptVariant,
      );
      spent += result.cost;
      const gate =
        c.kind === "event"
          ? { approved: eventApproved(result), blockers: [] }
          : c.a && c.b
            ? approveContract(
                c.a,
                c.b,
                result.answer,
                result.model,
                result.outcomeAnswers,
              )
            : null;
      await appendFile(
        `${output}.results.jsonl`,
        JSON.stringify({
          id: c.id,
          kind: c.kind,
          expected: c.expected,
          expectedOutcomes: c.expectedOutcomes,
          origin: c.origin,
          gate,
          ...result,
        }) + "\n",
      );
      if (result.cost > 0.01) throw new Error("cost_drift");
    } catch (error) {
      await appendFile(
        `${output}.results.jsonl`,
        JSON.stringify({
          id: c.id,
          error: error instanceof Error ? error.name : "unknown",
          uncertainChargeUsd: 0.01,
        }) + "\n",
      );
      throw new Error(
        "Calibration stopped; inspect saved results before any retry",
      );
    }
  }
  console.log(JSON.stringify({ completed: jobs.length, spentUsd: spent }));
} else {
  const results = (await readFile(`${output}.results.jsonl`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const metrics = Object.fromEntries(
    ["event", "contract", "outcome"].map((kind) => [
      kind,
      {
        scored: 0,
        correct: 0,
        predictedLinks: 0,
        falsePredictedLinks: 0,
        approved: 0,
        falseApproved: 0,
      },
    ]),
  );
  const blockers: Record<string, number> = {};
  for (const r of results) {
    if (r.error) continue;
    const m = metrics[r.kind];
    if (
      [
        "equivalent",
        "different",
        "inverse",
        "insufficient_information",
        "same_event",
        "related",
      ].includes(r.expected)
    ) {
      m.scored++;
      m.correct += Number(r.answer.choice === r.expected);
      const linked = ["same_event", "equivalent", "inverse"].includes(
        r.answer.choice,
      );
      m.predictedLinks += Number(linked);
      m.falsePredictedLinks += Number(linked && r.answer.choice !== r.expected);
      m.approved += Number(r.gate?.approved);
      const fixtureCase = jobs.find((c) => c.id === r.id);
      const partial =
        fixtureCase?.a?.outcomes.some((o) => o.side === null) ||
        fixtureCase?.b?.outcomes.some((o) => o.side === null);
      const supportedMapping =
        partial &&
        fixtureCase?.a &&
        fixtureCase?.b &&
        r.gate?.mapping?.every((mapping: { left: string; right: string }) => {
          const i = fixtureCase.a?.outcomes.findIndex(
            (o) => o.id === mapping.left,
          );
          const j = fixtureCase.b?.outcomes.findIndex(
            (o) => o.id === mapping.right,
          );
          return r.expectedOutcomes?.[`outcome_${i}_${j}`] === "equivalent";
        });
      m.falseApproved += Number(
        r.gate?.approved &&
          (partial
            ? !supportedMapping
            : !["same_event", "equivalent"].includes(r.expected)),
      );
    }
    for (const b of r.gate?.blockers ?? [])
      blockers[b] = (blockers[b] ?? 0) + 1;
    for (const [key, expected] of Object.entries(r.expectedOutcomes ?? {})) {
      const actual = r.outcomeAnswers?.[key]?.choice;
      const m = metrics.outcome;
      m.scored++;
      m.correct += Number(actual === expected);
      const linked = actual === "equivalent" || actual === "inverse";
      m.predictedLinks += Number(linked);
      m.falsePredictedLinks += Number(linked && actual !== expected);
      const fixtureCase = jobs.find((c) => c.id === r.id);
      const [, left, right] = key.split("_");
      const approved = Boolean(
        r.gate?.approved &&
        r.gate.mapping?.some(
          (mapping: { left: string; right: string }) =>
            mapping.left === fixtureCase?.a?.outcomes[Number(left)]?.id &&
            mapping.right === fixtureCase?.b?.outcomes[Number(right)]?.id,
        ),
      );
      m.approved += Number(approved);
      m.falseApproved += Number(approved && expected !== "equivalent");
    }
  }
  const report = {
    fixtureHash: manifest.fixtureHash,
    variant,
    split,
    orientation,
    planned: jobs.length,
    completed: results.filter((r) => !r.error).length,
    errors: results.filter((r) => r.error).length,
    metrics,
    blockers,
    spentUsd: results.reduce(
      (sum, r) => sum + (r.cost ?? r.uncertainChargeUsd ?? 0),
      0,
    ),
    labelScope:
      "Provisional supplied-text labels; not independently adjudicated settlement equivalence",
    retrievalRecall: "not measured by decision fixture",
  };
  await writeFile(`${output}.summary.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
