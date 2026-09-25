// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "./integration-test-database-guard.js";
import { pool } from "./db.js";
import {
  attachHolderResearchCandidateHistory,
  buildHolderResearchDecisionSnapshot,
  buildHolderResearchNoteKey,
  persistHolderResearchNotes,
  type HolderResearchCandidate,
  type HolderResearchPersistDecision,
  type HolderResearchSide,
} from "./services/holder-research.js";
import { parseHolderResearchUpdateV1 } from "./services/signal-publication-contract.js";
import { getIntelPolicyDefaults } from "./services/runtime-policies.js";

const runId = `holder-publication-integration:${randomUUID()}`;
const policy = {
  ...getIntelPolicyDefaults("holder_research"),
  noteCooldownHours: 1,
};
const now = new Date();
const ago = (hours: number) =>
  new Date(now.getTime() - hours * 3_600_000).toISOString();
const side = (value: "YES" | "NO"): HolderResearchSide => ({
  side: value,
  usd: 20_000,
  wallets: 2,
  openPnlUsd: null,
  sharpHolders: 1,
  sharpUsd: 20_000,
  bestEdge: 0.15,
  bestZScore: 3,
  bestSampleCount: 40,
  bestResolvedStakeUsd: 30_000,
  bestTrades30d: 60,
});
function candidate(suffix: string): HolderResearchCandidate {
  const id = `${runId}:${suffix}`;
  return {
    key: id,
    thesisKey: `holder_research:v2:${id}:YES`,
    inputDigest: "unchanged-position-digest",
    bucket: "sharp_side",
    score: 0.9,
    side: "YES",
    direction: "up",
    signalType: "update",
    reasons: [],
    evidence: [],
    cooldownUntil: null,
    meaningfulDeltaReasons: [],
    market: {
      marketId: id,
      eventId: null,
      venue: "polymarket",
      marketTitle: "Will the scheduled meeting happen?",
      marketSlug: null,
      marketDescription:
        "Official confirmation of the meeting by the stated deadline.",
      outcomes: ["Yes", "No"],
      eventTitle: "Diplomatic meeting",
      eventSlug: null,
      eventDescription: null,
      seriesKey: null,
      seriesTitle: null,
      resolutionSource: null,
      category: "Politics",
      closeTime: null,
      expirationTime: null,
      yesProbability: 0.5,
      volume24h: null,
      liquidity: null,
      marketMovementContext: {
        yesProbabilityNow: 0.5,
        yesDeltaProbability24h: null,
        volume24h: null,
        volumeChange24h: null,
        volumeChangePct24h: null,
        liquidity: null,
        liquidityChange24h: null,
        liquidityChangePct24h: null,
        openInterestChange24h: null,
        openInterestChangePct24h: null,
        updatedAt: null,
        previousDecisionYesProbability: null,
        yesChangeSincePreviousDecision: null,
        previousDecisionCheckedAt: null,
      },
      livePriceCheck: {
        blockersBySide: { YES: [], NO: [] },
        checkedAt: now.toISOString(),
        fresh: true,
        sideBuyPrices: { YES: 0.51, NO: 0.51 },
        tokenIds: ["fixture-yes", "fixture-no"],
        yesProbability: 0.5,
        tops: {
          YES: {
            ask: 0.51,
            bid: 0.49,
            asOf: now.toISOString(),
            tokenId: "fixture-yes",
          },
          NO: {
            ask: 0.51,
            bid: 0.49,
            asOf: now.toISOString(),
            tokenId: "fixture-no",
          },
        },
      },
      sides: { YES: side("YES"), NO: side("NO") },
      holders: [],
      recentActivityUsd: 0,
      recentActivityAt: null,
      crossMarketWalletCount: 0,
      previousNote: null,
    },
  };
}
function decision(
  input: HolderResearchCandidate,
): HolderResearchPersistDecision {
  return {
    candidate: input,
    modelMeta: {},
    output: {
      version: "holder_research_v1",
      status: "PUBLISH",
      bucket: input.bucket,
      confidence: 0.7,
      signal_type: "update",
      direction: "up",
      headline: "Meeting thesis has new evidence",
      summary:
        "Fresh evidence changes the meeting thesis while opposing holders remain a caveat.",
      rationale: "The thesis survives a material change.",
      execution_priority: "normal",
      execution_priority_reason: "",
      evidence_ids: ["fixture"],
      caveats: [],
    },
  };
}
const client = await pool.connect();
async function seed(input: HolderResearchCandidate) {
  const { rows } = await client.query<{ id: string }>(
    `insert into ai_notes (note_key,note_type,status,title,description,producer_type,producer_run_id,
      source_kind,source_id,lineage,model_meta,created_at)
     values ($1,'signal','active','Previous meeting thesis','Previous published reasoning.',
       'holder_research',$2,'market',$3,$4::jsonb,'{}'::jsonb,$5::timestamptz) returning id`,
    [
      buildHolderResearchNoteKey(input),
      runId,
      input.market.marketId,
      JSON.stringify({
        thesis_key: input.thesisKey,
        side: "YES",
        decision_snapshot: buildHolderResearchDecisionSnapshot(input),
      }),
      ago(48),
    ],
  );
  const seededNote = rows[0];
  assert.ok(seededNote);
  await client.query(
    `insert into ai_note_targets (note_id,target_kind,target_id,target_meta)
    values ($1,'market',$2,'{"side":"YES"}'::jsonb)`,
    [seededNote.id, input.market.marketId],
  );
  return seededNote.id;
}
try {
  const opposing = candidate("opposing");
  await seed(opposing);
  const unchanged = await persistHolderResearchNotes(client, {
    runnerRunId: runId,
    policy,
    decisions: [decision(opposing)],
  });
  assert.equal(unchanged.rejectedByReason.no_meaningful_delta, 1);
  opposing.market.sides.NO.sharpHolders = 2;
  opposing.meaningfulDeltaReasons = ["sharp_holder_count_changed:NO"];
  const otherClient = await pool.connect();
  try {
    const attempts = await Promise.all(
      [client, otherClient].map((connection) =>
        persistHolderResearchNotes(connection, {
          runnerRunId: runId,
          policy,
          decisions: [decision(opposing)],
        }),
      ),
    );
    assert.equal(
      attempts.reduce((sum, item) => sum + item.persisted, 0),
      1,
    );
    assert.equal(
      attempts.reduce((sum, item) => sum + item.skippedExisting, 0),
      1,
    );
  } finally {
    otherClient.release();
  }

  const external = candidate("external");
  await seed(external);
  const report = decision(external);
  report.modelMeta.external_research = {
    status: "ok",
    verdict: "supports_opposite_side",
    timing: "unknown",
    summary: "New meeting delay announced.",
    comparableOdds: null,
    citations: [
      {
        title: "Official meeting notice",
        url: "https://example.com/meeting",
        publishedAt: ago(10),
      },
    ],
    freshFact: {
      fact: "The delegation postponed travel until the day before the meeting.",
      sourceUrl: "https://example.com/meeting",
      eventAt: ago(12),
      matchesExactContract: true,
      supportsSelectedSide: false,
      trackerUpdateOnly: false,
    },
  };
  report.output.updateEvidence = {
    sourceUrl: "https://example.com/meeting",
    matchesExactContract: true,
    factSupported: true,
    factMaterialToThesis: true,
  };
  const saved = await persistHolderResearchNotes(client, {
    runnerRunId: runId,
    policy,
    decisions: [report],
  });
  assert.equal(saved.persisted, 1);
  const { rows: notes } = await client.query<{
    note_key: string;
    metrics: unknown;
  }>(
    `select note_key,metrics from ai_notes where producer_run_id=$1 and source_id=$2 and status='active'`,
    [runId, external.market.marketId],
  );
  assert.equal(notes.length, 1);
  const savedNote = notes[0];
  assert.ok(savedNote);
  assert.notEqual(savedNote.note_key, buildHolderResearchNoteKey(external));
  const update = parseHolderResearchUpdateV1(
    (savedNote.metrics as Record<string, unknown>).holderResearchUpdateV1,
  );
  assert.equal(update?.primaryReason.kind, "new_external_fact");
  const [hydrated] = await attachHolderResearchCandidateHistory(
    client,
    [external],
    policy,
  );
  assert.equal(hydrated?.market.previousNote?.summary, report.output.summary);
  assert.equal(
    hydrated?.market.previousNote?.externalResearch?.freshFact?.fact,
    (report.modelMeta.external_research as { freshFact: { fact: string } })
      .freshFact.fact,
  );
  const repeated = await persistHolderResearchNotes(client, {
    runnerRunId: runId,
    policy,
    decisions: [report],
  });
  assert.equal(repeated.skippedExisting, 1);
  console.log(
    "[holder-research-publication-integration-tests] passed actual PG history/baseline SQL, opposite change, external-only unchanged digest, cooldown and concurrent thesis-lock publication",
  );
} finally {
  await client.query("delete from ai_notes where producer_run_id=$1", [runId]);
  client.release();
}
