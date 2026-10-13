import assert from "node:assert/strict";
import {
  assessHolderSideChange,
  holderPublicPositionChanges,
  holderPublicationPromptContext,
  publicHistoryBaselineMatches,
  publicSnapshotPositions,
  type HolderPublicNote,
  type HolderPublicPosition,
} from "./services/holder-research-publication-history.js";
import {
  parseHolderPublicationPolicy,
  validatePendingHolderPublication,
} from "./services/holder-publication-policy.js";
import { classifyMarketTaxonomyFromText } from "./services/market-type-classifier.js";
import { buildSignalBotOpposingView } from "./services/signal-bot-opposing-context.js";
import {
  holderResearchAgentOutputV1Schema,
  holderResearchFinalOutputV2Schema,
  buildHolderResearchSystemPrompt,
  buildHolderResearchSystemPromptV2,
  buildHolderResearchTriageSystemPrompt,
  buildHolderResearchTriageSystemPromptV2,
} from "./schemas/holder-research.js";
import type { SignalBotNote } from "./services/signal-bot-contracts.js";
import { latestHolderComparisonPositions } from "./services/holder-research-publication-history.js";
import {
  buildHolderSideChronologyReport,
  type HolderChronologyRow,
} from "./services/holder-side-chronology-report.js";
import { buildSignalPublicationSnapshot } from "./services/signal-publication-snapshot.js";

const before: HolderPublicPosition = {
  walletId: "holder",
  side: "NO",
  positionShares: 20000,
  observedAt: "2026-10-03T00:00:00Z",
  currentPrice: 0.5,
  strong: true,
};
const after: HolderPublicPosition = {
  ...before,
  positionShares: 40000,
  observedAt: "2026-10-03T06:00:00Z",
};
const baseline: HolderPublicNote = {
  noteId: "00000000-0000-4000-8000-000000000001",
  marketId: "polymarket:3875253",
  side: "YES",
  publishedAt: "2026-10-03T00:31:00Z",
  title: "Rams spread",
  summary: "New lineup information supports Rams.",
  sideLabel: "Rams -3.5",
  priceSnapshot: null,
  decisionSnapshot: { publicComparisonPositions: [before] },
  externalResearch: null,
};
const now = new Date("2026-10-03T06:31:00Z");
assert.equal(
  latestHolderComparisonPositions([after, before])[0].positionShares,
  40000,
);
assert.equal(
  latestHolderComparisonPositions([{ ...after, positionShares: 0 }, before])[0]
    .positionShares,
  0,
);
assert.equal(
  latestHolderComparisonPositions([
    { ...after, positionShares: 0 },
    { ...before, positionShares: null },
  ])[0].positionShares,
  0,
);
const input = {
  enabled: true,
  side: "NO" as const,
  history: { status: "ok" as const, items: [baseline] },
  comparison: {
    baselineNoteId: baseline.noteId,
    kind: "opposing" as const,
    reason: "Material observed increase on the opposite side",
    materialChange: true,
    evidenceIds: [`position:holder:NO:${after.observedAt}`],
  },
  positions: [after],
  minUsd: 5000,
  minPct: 0.25,
  now,
};
assert.equal(assessHolderSideChange(input).allowed, true);
assert.equal(
  assessHolderSideChange({ ...input, comparison: null }).allowed,
  false,
);
assert.equal(
  assessHolderSideChange({
    ...input,
    comparison: { ...input.comparison, baselineNoteId: null },
  }).allowed,
  false,
);
assert.equal(
  assessHolderSideChange({ ...input, enabled: false, comparison: null })
    .allowed,
  true,
);
assert.equal(
  assessHolderSideChange({ ...input, side: "YES", comparison: null }).allowed,
  true,
);
assert.equal(
  assessHolderSideChange({
    ...input,
    history: { status: "unavailable", items: [] },
  }).reason,
  "publication_history_unavailable",
);
assert.equal(
  assessHolderSideChange({
    ...input,
    history: { status: "ok", items: [] },
    comparison: null,
  }).allowed,
  true,
);
for (const current of [
  { ...after, positionShares: 20000, currentPrice: 0.9 }, // repricing
  { ...after, positionShares: null },
  { ...after, strong: false },
  { ...after, walletId: "newly_seen_not_proven_new" },
  { ...after, observedAt: before.observedAt },
  { ...after, observedAt: "2026-10-04T00:00:00Z" },
  { ...after, positionShares: 21000 },
])
  assert.deepEqual(
    holderPublicPositionChanges({
      baseline,
      current: [current],
      minUsd: 5000,
      minPct: 0.25,
      now,
    }),
    [],
  );
assert.equal(
  publicSnapshotPositions({
    publicComparisonPositions: [
      { ...before, positionShares: null, currentPrice: null },
    ],
  })[0]?.positionShares,
  null,
);
assert.equal(
  holderPublicPositionChanges({
    baseline,
    current: [{ ...after, positionShares: 0, strong: false }],
    minUsd: 5000,
    minPct: 0.25,
    now,
  }).length,
  1,
);
assert.equal(
  holderPublicPositionChanges({
    baseline,
    current: [],
    minUsd: 5000,
    minPct: 0.25,
    now,
  }).length,
  0,
);
assert.equal(
  assessHolderSideChange({
    ...input,
    history: {
      status: "ok",
      items: [
        {
          ...baseline,
          decisionSnapshot: { evidenceHolders: [{ positionUsd: 26800 }] },
        },
      ],
    },
  }).allowed,
  false,
);

// Rams: an injury announcement is material; an old story, tracker timestamp or
// opposite tag without exact-contract confirmation is not. No future result used.
const url = "https://example.org/team/lineup";
const research = {
  status: "ok",
  verdict: "supports_holder_side",
  timing: "unknown",
  summary: "Team confirmed a material lineup change at 05:00 UTC.",
  citations: [
    { url, title: "Official lineup", publishedAt: "2026-10-03T05:05:00Z" },
  ],
  comparableOdds: null,
  freshFact: {
    fact: "The team confirmed its starting player will miss this match.",
    sourceUrl: url,
    eventAt: "2026-10-03T05:00:00Z",
    matchesExactContract: true,
    supportsSelectedSide: true,
    trackerUpdateOnly: false,
  },
};
const external = {
  ...input,
  positions: [],
  comparison: { ...input.comparison, evidenceIds: [`external:${url}`] },
  externalResearch: research,
  externalFactEvidence: {
    sourceUrl: url,
    matchesExactContract: true,
    factSupported: true,
    factMaterialToThesis: true,
  },
};
assert.equal(assessHolderSideChange(external).allowed, true);
for (const freshFact of [
  { ...research.freshFact, eventAt: "2026-10-02T05:00:00Z" },
  { ...research.freshFact, trackerUpdateOnly: true },
  { ...research.freshFact, matchesExactContract: false },
  { ...research.freshFact, eventAt: null },
]) {
  assert.equal(
    assessHolderSideChange({
      ...external,
      externalResearch: { ...research, freshFact },
    }).allowed,
    false,
  );
}
assert.equal(
  assessHolderSideChange({
    ...external,
    externalResearch: { ...research, status: "error" },
  }).allowed,
  false,
);
assert.equal(
  assessHolderSideChange({
    ...external,
    externalFactEvidence: {
      ...external.externalFactEvidence,
      factMaterialToThesis: false,
    },
  }).allowed,
  false,
);
assert.equal(
  assessHolderSideChange({ ...input, externalResearch: { status: "error" } })
    .allowed,
  true,
); // internal proof does not require web

// Colts and Senate sweep: preserve YES -> NO -> YES, not distinct(side).
const chronology = [
  baseline,
  {
    ...baseline,
    noteId: "00000000-0000-4000-8000-000000000002",
    side: "NO" as const,
  },
  {
    ...baseline,
    noteId: "00000000-0000-4000-8000-000000000003",
    side: "YES" as const,
  },
];
const context = holderPublicationPromptContext({
  history: { status: "ok", items: chronology },
  positions: [],
  minUsd: 5000,
  minPct: 0.25,
});
assert.deepEqual(
  context.chronology.map((note) => note.side),
  ["YES", "NO", "YES"],
);
assert.equal(context.latestNoteId, baseline.noteId);
assert.equal(publicHistoryBaselineMatches(input.history, input.history), true);
assert.equal(
  publicHistoryBaselineMatches(input.history, {
    status: "ok",
    items: chronology.slice(1),
  }),
  false,
);

const defaults = parseHolderPublicationPolicy({});
assert.equal(defaults.singleGameSportsClusterOnly, true);
assert.equal(defaults.sideChangeRequiresEvidence, true);
assert.equal(
  classifyMarketTaxonomyFromText("nfl season champion", 24).marketType,
  "sports_outright",
);
assert.equal(
  classifyMarketTaxonomyFromText("tennis tournament winner", 24).marketType,
  "sports_outright",
);
assert.equal(
  classifyMarketTaxonomyFromText("tennis match winner player a vs player b", 24)
    .marketType,
  "single_game_sports",
);
const note = {
  marketSegment: "sports_esports_game",
  holderActorMode: "single_holder",
  holderClusterSharpHolders: 1,
  holderClusterSharpUsd: 273500,
  modelMeta: {},
  createdAt: now.toISOString(),
} as SignalBotNote;
const pending = {
  note,
  policy: defaults,
  history: { status: "ok" as const, items: [] },
  side: "YES" as const,
};
assert.equal(validatePendingHolderPublication(pending).allowed, false); // Falcons NO singleton after 1-1
assert.equal(
  validatePendingHolderPublication({
    ...pending,
    note: {
      ...note,
      holderActorMode: "sharp_cluster",
      holderClusterSharpHolders: 2,
    },
  }).allowed,
  true,
);
assert.equal(
  validatePendingHolderPublication({
    ...pending,
    policy: { ...defaults, singleGameSportsClusterOnly: false },
  }).allowed,
  true,
);
assert.equal(
  validatePendingHolderPublication({
    ...pending,
    note: { ...note, marketSegment: "sports_outright" },
  }).allowed,
  true,
);
assert.equal(
  validatePendingHolderPublication({
    ...pending,
    note: { ...note, marketSegment: "politics_geo" },
    side: "NO",
    history: input.history,
  }).allowed,
  false,
); // legacy opposite lacks proof
assert.match(
  buildSignalBotOpposingView("NO", { current: "Commanders", previous: "Colts" })
    .markdown,
  /Commanders vs earlier Colts/,
);
assert.match(
  buildSignalBotOpposingView(
    "NO",
    undefined,
    "The team announced a new injury.",
  ).markdown,
  /What changed: The team announced a new injury/,
);
for (const schema of [
  holderResearchAgentOutputV1Schema,
  holderResearchFinalOutputV2Schema,
]) {
  assert.equal(
    schema.shape.publicationComparison.safeParse(input.comparison).success,
    true,
  );
  assert.equal(
    schema.shape.publicationComparison.safeParse(undefined).success,
    true,
  );
}
for (const prompt of [
  buildHolderResearchSystemPrompt(),
  buildHolderResearchSystemPromptV2(),
  buildHolderResearchTriageSystemPrompt(),
  buildHolderResearchTriageSystemPromptV2(),
]) {
  assert.match(prompt, /publicThesisHistory/);
  assert.match(prompt, /singleGameSportsClusterOnly/);
}
console.log("[holder-publication-history-tests] passed");

const deliveries: HolderChronologyRow[] = ["YES", "NO", "YES", "YES"].map(
  (side, n) => {
    const sentAt = `2026-10-0${n + 1}T12:00:00Z`;
    return {
      noteId: String(n),
      sentAt,
      kind: n === 3 ? "research_update" : "initial",
      marketId: "colts",
      eventId: "event",
      venue: "polymarket",
      side,
      resolvedOutcome: "YES",
      snapshot: buildSignalPublicationSnapshot({
        marketId: "colts",
        venue: "polymarket",
        side: side as "YES" | "NO",
        priceSnapshot: null,
        nativeQuote: { ask: 0.5, asOf: sentAt },
        now: new Date(sentAt),
      }),
      legacyPrice: null,
      holderId: "holder",
    };
  },
);
const report = buildHolderSideChronologyReport(deliveries);
assert.equal(report.sideChanges, 2);
assert.equal(report.returns, 1);
assert.deepEqual(
  report.timeline.map((row) => row.change),
  ["first_in_window", "side_change", "return_to_side", "same_side_repeat"],
);
assert.equal(report.groups[1].averageRoi, 1);
assert.equal(report.byEvent[0].share, 1);
assert.equal(
  buildHolderSideChronologyReport([
    { ...deliveries[0], snapshot: null, legacyPrice: 0.5 },
  ]).groups[0].averageRoi,
  null,
);
assert.equal(
  buildHolderSideChronologyReport([
    { ...deliveries[0], resolvedOutcome: "CANCELLED" },
  ]).groups[0].averageRoi,
  null,
);
const redirectedReport = buildHolderSideChronologyReport([
  {
    ...deliveries[0],
    snapshot: null,
    legacyPrice: 0.5,
    deliveryMarketId: "sibling",
    deliverySide: "NO",
  },
]);
assert.equal(redirectedReport.timeline[0].side, "YES");
assert.equal(redirectedReport.timeline[0].marketId, "colts");
assert.equal(redirectedReport.timeline[0].roi, null);
