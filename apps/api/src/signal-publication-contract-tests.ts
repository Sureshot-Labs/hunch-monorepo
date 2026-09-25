import assert from "node:assert/strict";
import { resolveSignalBotResearchDelta } from "./services/signal-bot-research-update.js";
import {
  buildHolderResearchUpdateV1,
  parseHolderResearchUpdateV1,
  type HolderResearchUpdateSnapshot,
  type SignalPriceSnapshotV1,
} from "./services/signal-publication-contract.js";

const baselineAsOf = "2026-09-24T10:00:00.000Z";
const currentPrice: SignalPriceSnapshotV1 = {
  asOf: "2026-09-25T10:00:00.000Z",
  displayPrice: 0.5,
  displayPriceSource: "midpoint",
  displaySide: "YES",
  marketId: "test-market",
  NO: { ask: 0.51, bid: 0.49, mark: 0.5 },
  YES: { ask: 0.51, bid: 0.49, mark: 0.5 },
  venue: "polymarket",
  version: 1,
};
const snapshot: HolderResearchUpdateSnapshot = {
  evidenceHolders: [{ positionUsd: 5_000, side: "YES", walletId: "holder-1" }],
  sides: {
    YES: { sharpHolders: 1, usd: 5_000, wallets: 1 },
    NO: { sharpHolders: 0, usd: 0, wallets: 0 },
  },
  yesProbability: 0.5,
};
const base = {
  baselineAsOf,
  baselineNoteId: "baseline-note",
  current: snapshot,
  currentPrice,
  holderWalletId: "holder-1",
  materiality: {
    minMeaningfulHolderPctDelta: 0.1,
    minMeaningfulHolderUsdDelta: 1_000,
    minMeaningfulOddsDelta: 0.02,
    minMeaningfulSidePctDelta: 0.1,
    minMeaningfulSideUsdDelta: 1_000,
    strongPriceMoveCents: 5,
  },
  previous: snapshot,
  selectedSide: "YES" as const,
  thesisKey: "test-market:YES",
};
const externalResearch = {
  status: "ok",
  verdict: "supports_opposite_side",
  timing: "unknown",
  summary: "A new exact-contract event challenges the selected thesis.",
  citations: [
    {
      title: "Official decision",
      url: "https://example.com/decision",
      publishedAt: "2026-09-24T13:00:00.000Z",
    },
  ],
  freshFact: {
    fact: "The committee rejected the proposal on September 24.",
    sourceUrl: "https://example.com/decision",
    eventAt: "2026-09-24T12:00:00.000Z",
    matchesExactContract: true,
    supportsSelectedSide: false,
    trackerUpdateOnly: false,
  },
};
const externalFactEvidence = {
  sourceUrl: "https://example.com/decision",
  matchesExactContract: true,
  factSupported: true,
  factMaterialToThesis: true,
};

const tests = [
  {
    name: "opposing holder 0→1 is a selected-thesis update, not selected-side support",
    run() {
      const update = buildHolderResearchUpdateV1({
        ...base,
        current: {
          ...snapshot,
          sides: {
            ...snapshot.sides,
            NO: { sharpHolders: 1, usd: 900, wallets: 1 },
          },
        },
      });
      assert.ok(update.ok);
      assert.deepEqual(update.value.primaryReason, {
        after: 1,
        asOf: currentPrice.asOf,
        before: 0,
        delta: 1,
        direction: "increased",
        kind: "opposing_wallet_confluence_changed",
        observedSide: "NO",
        side: "YES",
        unit: "wallets",
      });
      assert.equal(update.value.ctaIntent, "open_market");
      assert.equal(
        resolveSignalBotResearchDelta(
          {
            holderResearchUpdateV1: update.value,
            revisionKind: "research_update",
            decisionSnapshot: snapshot,
            previousDecisionSnapshot: snapshot,
            holderWalletId: "holder-1",
          },
          "YES",
        )?.kind,
        "opposing_wallet_count_change",
      );
      assert.deepEqual(parseHolderResearchUpdateV1(update.value), update.value);
      assert.equal(
        parseHolderResearchUpdateV1({ ...update.value, selectedSide: "NO" }),
        null,
      );
      assert.equal(
        parseHolderResearchUpdateV1({ ...update.value, ctaIntent: "buy" }),
        null,
      );
      assert.equal(
        parseHolderResearchUpdateV1({
          ...update.value,
          primaryReason: { ...update.value.primaryReason, observedSide: "YES" },
        }),
        null,
      );
    },
  },
  {
    name: "unchanged observations on both sides produce no update",
    run() {
      assert.deepEqual(buildHolderResearchUpdateV1(base), {
        ok: false,
        reason: "no_meaningful_delta",
      });
    },
  },
  {
    name: "opposing exposure and non-representative selected exposure are renderable",
    run() {
      for (const [side, kind] of [
        ["NO", "opposing_position_increased"],
        ["YES", "position_increased"],
      ] as const) {
        const update = buildHolderResearchUpdateV1({
          ...base,
          current: {
            ...snapshot,
            sides: {
              ...snapshot.sides,
              [side]: {
                ...snapshot.sides[side],
                usd: snapshot.sides[side].usd + 2_000,
              },
            },
          },
        });
        assert.ok(update.ok);
        assert.equal(update.value.primaryReason.kind, kind);
        if (update.value.primaryReason.kind === "position_increased")
          assert.equal(
            update.value.primaryReason.scope,
            "selected_side_cluster",
          );
        assert.ok(parseHolderResearchUpdateV1(update.value));
      }
    },
  },
  {
    name: "new verified adverse fact can update a thesis without a buy CTA",
    run() {
      const update = buildHolderResearchUpdateV1({
        ...base,
        externalResearch,
        externalFactEvidence,
      });
      assert.ok(update.ok);
      assert.equal(update.value.primaryReason.kind, "new_external_fact");
      assert.equal(
        resolveSignalBotResearchDelta(
          {
            holderResearchUpdateV1: update.value,
            revisionKind: "research_update",
            decisionSnapshot: snapshot,
            previousDecisionSnapshot: snapshot,
            holderWalletId: "holder-1",
          },
          "YES",
        )?.kind,
        "new_external_fact",
      );
      assert.equal(update.value.ctaIntent, "open_market");
      assert.deepEqual(parseHolderResearchUpdateV1(update.value), update.value);
      assert.equal(
        parseHolderResearchUpdateV1({
          ...update.value,
          baselineAsOf: currentPrice.asOf,
        }),
        null,
      );
      assert.equal(
        parseHolderResearchUpdateV1({
          ...update.value,
          primaryReason: {
            ...update.value.primaryReason,
            sourceUrl: "javascript:alert(1)",
          },
        }),
        null,
      );
    },
  },
  {
    name: "a fact after the quote is evaluated at publication time without changing quote freshness",
    run() {
      const earlierQuote = {
        ...currentPrice,
        asOf: "2026-09-24T11:00:00.000Z",
      };
      const update = buildHolderResearchUpdateV1({
        ...base,
        currentPrice: earlierQuote,
        evaluatedAt: "2026-09-25T10:00:00.000Z",
        externalResearch,
        externalFactEvidence,
      });
      assert.ok(update.ok);
      assert.equal(update.value.changedAt, "2026-09-25T10:00:00.000Z");
      assert.deepEqual(parseHolderResearchUpdateV1(update.value), update.value);
    },
  },
  {
    name: "new URLs, new crawl dates and rewording cannot recycle an old event",
    run() {
      for (const fact of [
        externalResearch.freshFact.fact,
        "A restated report about the same committee decision.",
      ]) {
        const result = buildHolderResearchUpdateV1({
          ...base,
          externalFactEvidence,
          externalResearch: {
            ...externalResearch,
            freshFact: {
              ...externalResearch.freshFact,
              fact,
              eventAt: baselineAsOf,
            },
          },
        });
        assert.deepEqual(result, { ok: false, reason: "no_meaningful_delta" });
      }
      const repeated = buildHolderResearchUpdateV1({
        ...base,
        externalResearch,
        externalFactEvidence,
        previousExternalResearch: {
          freshFact: {
            fact: "THE COMMITTEE REJECTED THE PROPOSAL ON SEPTEMBER 24!",
            sourceUrl: "https://other.example/old",
          },
        },
      });
      assert.deepEqual(repeated, { ok: false, reason: "no_meaningful_delta" });
      const next = buildHolderResearchUpdateV1({
        ...base,
        baselineAsOf: currentPrice.asOf,
        externalResearch,
        externalFactEvidence,
      });
      assert.deepEqual(next, { ok: false, reason: "no_meaningful_delta" });
    },
  },
  {
    name: "malformed and unsupported external facts do not create deltas",
    run() {
      for (const mutation of [
        { eventAt: "not-a-date" },
        { eventAt: "2026-09-26T12:00:00.000Z" },
        { sourceUrl: "https://example.com/uncited" },
        { trackerUpdateOnly: true },
        { matchesExactContract: false },
        { eventAt: null },
        { unsupported: true },
      ]) {
        const result = buildHolderResearchUpdateV1({
          ...base,
          externalFactEvidence,
          externalResearch: {
            ...externalResearch,
            freshFact: { ...externalResearch.freshFact, ...mutation },
          },
        });
        assert.deepEqual(result, { ok: false, reason: "no_meaningful_delta" });
      }
      for (const confirmation of [
        null,
        { ...externalFactEvidence, factMaterialToThesis: false },
        { ...externalFactEvidence, factSupported: false },
      ]) {
        assert.deepEqual(
          buildHolderResearchUpdateV1({
            ...base,
            externalResearch,
            externalFactEvidence: confirmation,
          }),
          { ok: false, reason: "no_meaningful_delta" },
        );
      }
      const invalidCount = buildHolderResearchUpdateV1({
        ...base,
        current: {
          ...snapshot,
          sides: {
            ...snapshot.sides,
            NO: { sharpHolders: -1, usd: 0, wallets: 0 },
          },
        },
      });
      assert.deepEqual(invalidCount, {
        ok: false,
        reason: "non_renderable_delta",
      });
    },
  },
];

for (const test of tests) {
  try {
    test.run();
  } catch (error) {
    console.error(`[signal-publication-contract-tests] failed: ${test.name}`);
    throw error;
  }
}
console.log(
  `[signal-publication-contract-tests] passed ${tests.length}/${tests.length}`,
);
