import type { IntelTagNote, IntelTagMarket } from "./services/intel-tags.js";
import { HOLDER_RESEARCH_PUBLICATION_DECISION_V1 } from "./services/signal-publication-contract.js";

export const intelFixtureContract =
  "0x1111111111111111111111111111111111111111";
export const intelFixtureWallet = "00000000-0000-4000-8000-000000000091";
export const intelFixtureBefore = "2026-10-28T12:00:00.000Z";
export const intelFixtureAfter = "2026-10-29T12:00:00.000Z";
export function intelTagFixture(): {
  note: IntelTagNote;
  baseline: IntelTagNote;
  market: IntelTagMarket;
  limitlessPositionContract: string;
} {
  const source = "https://example.org/official-update";
  const snapshot = (shares: number, at: string) => ({
    publicComparisonPositions: [
      {
        walletId: intelFixtureWallet,
        side: "NO",
        positionShares: shares,
        currentPrice: 0.5,
        observedAt: at,
        strong: true,
      },
    ],
  });
  const instrument = {
    marketId: "limitless:intel-tag-fixture",
    venue: "limitless",
    tokenId: "intel-tag-no",
    outcome: "NO",
    generation: `8453:${intelFixtureContract}:intel-tag-no`,
    expiry: null,
  };
  const baseline: IntelTagNote = {
    id: "00000000-0000-4000-8000-000000000001",
    source_id: instrument.marketId,
    note_type: "signal",
    status: "superseded",
    created_at: intelFixtureBefore,
    lineage: {
      side: "NO",
      decision_snapshot: snapshot(20000, intelFixtureBefore),
    },
    metrics: {
      publicationDecisionV1: HOLDER_RESEARCH_PUBLICATION_DECISION_V1,
      socialInstrumentV1: instrument,
    },
    model_meta: {},
  };
  const position = {
    kind: "position_increased",
    before: 10000,
    after: 20000,
    delta: 10000,
    side: "NO",
    unit: "usd",
    scope: "representative_wallet",
    walletId: intelFixtureWallet,
    asOf: intelFixtureAfter,
  };
  const note: IntelTagNote = {
    ...baseline,
    id: "00000000-0000-4000-8000-000000000002",
    status: "active",
    created_at: intelFixtureAfter,
    lineage: {
      side: "NO",
      decision_snapshot: snapshot(40000, intelFixtureAfter),
    },
    metrics: {
      ...(baseline.metrics as object),
      holderResearchUpdateV1: {
        version: 1,
        baselineNoteId: baseline.id,
        baselineAsOf: intelFixtureBefore,
        changedAt: intelFixtureAfter,
        fingerprint: "fixture",
        selectedSide: "NO",
        ctaIntent: "buy",
        materialityPolicy: {
          version: 1,
          revision: "fixture",
          thresholds: {
            minMeaningfulHolderUsdDelta: 5000,
            minMeaningfulHolderPctDelta: 0.25,
          },
        },
        primaryReason: position,
        reasons: [
          position,
          {
            kind: "price_moved_with_thesis",
            before: 0.5,
            after: 0.6,
            delta: 0.1,
            side: "NO",
            unit: "probability",
            asOf: intelFixtureAfter,
          },
          {
            kind: "new_external_fact",
            side: "NO",
            fact: "Official result updated",
            asOf: intelFixtureAfter,
            eventAt: "2026-10-29T10:00:00.000Z",
            sourcePublishedAt: "2026-10-29T10:05:00.000Z",
            sourceTitle: "Official update",
            sourceUrl: source,
          },
        ],
      },
    },
    model_meta: {
      private_debug: "must not leak",
      primary_holder_credentials: {
        side: "NO",
        mode: "single_holder",
        primaryHolder: { walletId: intelFixtureWallet, side: "NO" },
      },
      external_research: {
        citations: [
          {
            url: source,
            title: "Official update",
            publishedAt: "2026-10-29T10:05:00.000Z",
          },
        ],
      },
    },
  };
  return {
    note,
    baseline,
    market: {
      venue: "limitless",
      token_id: instrument.tokenId,
      metadata: {},
      expiration_time: null,
      resolved_outcome: "NO",
      resolved_outcome_pct: null,
    },
    limitlessPositionContract: intelFixtureContract,
  };
}
