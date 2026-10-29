import assert from "node:assert/strict";
import {
  contextTestCandidate,
  contextTestNow,
} from "./holder-context-test-fixtures.js";
import {
  buildHolderContextFacts,
  holderContextFactsUnchanged,
  usableHolderContextFacts,
} from "./services/holder-research.js";
import { getIntelPolicyDefaults } from "./services/runtime-policies.js";
import {
  normalizeHolderResearchExternalResearchV2,
  parseHolderResearchExternalResearchV2,
} from "./schemas/holder-research.js";
import { maybeWriteDecisionCache } from "./ai-holder-research-run.js";

const policy = { ...getIntelPolicyDefaults("holder_research"), dryRun: false };
const candidate = contextTestCandidate();
const errorResearch = normalizeHolderResearchExternalResearchV2(
  parseHolderResearchExternalResearchV2({ status: "error", error: "http_403" }),
);
const make = (
  input = candidate,
  extra: Partial<Parameters<typeof buildHolderContextFacts>[0]> = {},
) =>
  buildHolderContextFacts({
    candidate: input,
    policy,
    externalResearch: errorResearch,
    now: contextTestNow,
    ...extra,
  });
const facts = make();
assert.equal(facts.complete, true);
assert.equal(usableHolderContextFacts(facts), true);
assert.equal(
  holderContextFactsUnchanged(
    JSON.parse(JSON.stringify(facts)),
    make(),
    policy,
  ),
  true,
);
const newer = structuredClone(candidate);
newer.market.holders[0].positionSnapshotAt = "2026-10-29T14:00:00Z";
assert.ok(newer.market.livePriceCheck);
newer.market.livePriceCheck.checkedAt = "2026-10-29T14:00:00Z";
assert.equal(
  holderContextFactsUnchanged(
    facts,
    make(newer, { now: new Date("2026-10-29T14:00:00Z") }),
    policy,
  ),
  true,
  "run and snapshot clocks are not new facts",
);
for (const mutate of [
  (c: typeof candidate) => {
    c.market.yesProbability = 0.8;
  },
  (c: typeof candidate) => {
    c.market.holders[0].positionShares = 10_000;
    c.market.holders[0].positionSnapshotAt = "2026-10-29T14:00:00Z";
  },
  (c: typeof candidate) => {
    c.market.sides.NO.sharpHolders += 1;
  },
  (c: typeof candidate) => {
    c.side = "NO";
  },
  (c: typeof candidate) => {
    assert.ok(c.market.livePriceCheck?.tops?.YES);
    c.market.livePriceCheck.tops.YES.tokenId = "999";
  },
  (c: typeof candidate) => {
    c.comparisonPositionsUnavailable = true;
  },
  (c: typeof candidate) => {
    c.market.holders[0].positionShares = null;
  },
  (c: typeof candidate) => {
    c.market.holders[0].identityDisplayName = "Corrected public name";
  },
  (c: typeof candidate) => {
    c.market.holders[0].pnl30dUsd = -50_000;
  },
  (c: typeof candidate) => {
    c.market.holders[0].openPnlUsd = -15_000;
  },
  (c: typeof candidate) => {
    c.market.holders[0].resolvedEdgeSampleCount30d = 45;
  },
]) {
  const changed = structuredClone(candidate);
  mutate(changed);
  assert.equal(
    holderContextFactsUnchanged(facts, make(changed), policy),
    false,
    String(mutate),
  );
}
for (const field of [
  "publicComparisonPositions",
  "publicBaselineNoteId",
  "yesProbability",
  "priceMovementVersion",
  "sides",
  "evidenceHolders",
] as const) {
  const malformed = JSON.parse(JSON.stringify(facts));
  delete malformed.snapshot[field];
  assert.equal(
    holderContextFactsUnchanged(malformed, facts, policy),
    false,
    field,
  );
}
for (const bad of [
  null,
  {},
  { ...facts, complete: false },
  { ...facts, version: 0 },
  { ...facts, copyVersion: "old" },
  { ...facts, observedAt: "bad" },
])
  assert.equal(holderContextFactsUnchanged(bad, facts, policy), false);
const background = [
  {
    sourceUrl: "https://example.com/a",
    publishedAt: "2026-10-29T10:00:00Z",
    title: "Meeting",
    summary: "Talks continue.",
  },
  {
    sourceUrl: "https://example.com/b",
    publishedAt: null,
    title: "Schedule",
    summary: "Meeting has not begun.",
  },
];
const withSources = make(candidate, { backgroundSources: background });
assert.equal(
  holderContextFactsUnchanged(
    withSources,
    make(candidate, {
      backgroundSources: [
        { ...background[0], publishedAt: "2026-10-29T10:00:00.000Z" },
        background[1],
      ],
    }),
    policy,
  ),
  true,
);
assert.equal(
  holderContextFactsUnchanged(
    withSources,
    make(candidate, { backgroundSources: [...background].reverse() }),
    policy,
  ),
  true,
);
assert.equal(
  holderContextFactsUnchanged(
    withSources,
    make(candidate, {
      backgroundSources: [
        { ...background[0], summary: "Meeting has begun." },
        background[1],
      ],
    }),
    policy,
  ),
  false,
);
const recovered = normalizeHolderResearchExternalResearchV2({
  status: "ok",
  verdict: "unknown",
  timing: "unknown",
  summary: "Sources accessible again.",
  citations: [],
  comparableOdds: null,
});
assert.equal(
  holderContextFactsUnchanged(
    facts,
    make(candidate, { externalResearch: recovered }),
    policy,
  ),
  false,
  "provider recovery is reanalyzed",
);
const odds = {
  ...recovered,
  status: "ok" as const,
  comparableOdds: {
    side: "YES" as const,
    probabilityMin: 0.4,
    probabilityMax: 0.6,
    asOf: "2026-10-29T12:00:00Z",
    sources: [
      { title: "A", url: "https://example.com/a" },
      { title: "B", url: "https://example.com/b" },
    ],
  },
};
assert.equal(
  holderContextFactsUnchanged(
    make(candidate, { externalResearch: odds }),
    make(candidate, {
      externalResearch: {
        ...odds,
        comparableOdds: {
          ...odds.comparableOdds,
          sources: [...odds.comparableOdds.sources].reverse(),
        },
      },
    }),
    policy,
  ),
  true,
);
const wrongSide = structuredClone(facts);
wrongSide.snapshot.side = "NO";
wrongSide.snapshot.key = wrongSide.snapshot.key.replace(/YES$/, "NO");
assert.equal(holderContextFactsUnchanged(wrongSide, facts, policy), false);

// The same opposing total can hide a meaningful redistribution. Missing share
// quantities do not block analysis; compare the known marked values instead.
const opposing = structuredClone(candidate);
for (const walletId of ["opposing-a", "opposing-b"]) {
  opposing.market.holders.push({
    ...opposing.market.holders[0],
    walletId,
    side: "NO",
    positionShares: null,
    positionUsd: 20_000,
  });
}
const opposingFacts = make(opposing);
assert.equal(opposingFacts.complete, true);
const redistributed = structuredClone(opposing);
redistributed.market.holders[1].positionUsd = 35_000;
redistributed.market.holders[2].positionUsd = 5_000;
assert.equal(
  holderContextFactsUnchanged(opposingFacts, make(redistributed), policy),
  false,
  "opposing redistribution cannot hide behind unchanged aggregate exposure",
);
const tinyChange = structuredClone(opposing);
tinyChange.market.holders[1].positionUsd += 1;
assert.equal(
  holderContextFactsUnchanged(opposingFacts, make(tinyChange), policy),
  true,
);
const noPositionMap = { ...facts, holderPositionUsd: {} };
assert.equal(holderContextFactsUnchanged(noPositionMap, facts, policy), false);

const stored = new Map<string, string>();
const redis = {
  get: async (k: string) => stored.get(k) ?? null,
  set: async (k: string, v: string) => {
    stored.set(k, v);
  },
  del: async (k: string) => stored.delete(k),
};
const stats = {
  enabled: true,
  status: "ok" as "ok" | "error",
  checked: 0,
  skipped: 0,
  rechecked: 0,
  written: 0,
  errors: 0,
  dryRun: false,
};
const cache = {
  redis,
  policy,
  callModel: true,
  candidate,
  output: { status: "CONTEXT" as const, rationale: "holder_disagreement" },
  decisionCache: stats,
};
for (const failure of [
  { technicalFailure: true },
  { modelMeta: { external_research: { status: "error", error: "http_403" } } },
  {
    modelMeta: {
      external_research: { status: "error", error: "request_timeout" },
    },
  },
]) {
  await maybeWriteDecisionCache(cache);
  assert.equal(stored.size, 1);
  await maybeWriteDecisionCache({ ...cache, ...failure });
  assert.equal(
    stored.size,
    0,
    "old cooldown is cleared, not only new writes suppressed",
  );
}
await maybeWriteDecisionCache({
  ...cache,
  redis: {
    ...redis,
    set: async () => {
      throw new Error("redis unavailable");
    },
  },
});
assert.equal(stats.errors, 1);
await maybeWriteDecisionCache(cache);
assert.equal(stored.size, 1, "Redis recovery works");
console.log(
  "[holder-context-tests] fact clocks/order, meaningful changes, malformed/legacy baselines, source recovery and technical retry passed",
);
