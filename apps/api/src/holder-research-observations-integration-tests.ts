// @requires-db

import assert from "node:assert/strict";

import { pool, type DbQuery } from "./db.js";
import {
  loadHolderResearchSupplyHealth,
  pruneHolderResearchCandidateObservations,
  updateHolderResearchObservationStages,
} from "./services/holder-research-observations.js";

const client = await pool.connect();

try {
  await client.query("begin");
  const db: DbQuery = {
    query: client.query.bind(client) as DbQuery["query"],
  };
  const runId = "holder-research-observations-integration";
  const freshThesis = "holder_research:v2:integration-fresh:YES";
  const staleThesis = "holder_research:v2:integration-stale:NO";
  const uncheckedThesis = "holder_research:v2:integration-unchecked:YES";
  const supplyNow = new Date("2099-01-07T12:00:00.000Z");

  await client.query(
    `insert into holder_research_candidate_observations (
       run_id,
       observed_at,
       thesis_key,
       source_market_id,
       side,
       candidate_bucket,
       input_digest,
       feature_version,
       decision_features,
       candidate_rank,
       shadow_score,
       shadow_rank
     ) values
       ($1, $4::timestamptz, $2, 'integration-fresh', 'YES', 'sharp_side', 'fresh', 2,
        '{"version":2,"market":{"priceCheckedAt":"2026-01-01T00:00:00.000Z"},"gates":{"publishEligible":true}}'::jsonb,
        1, 0.8, 1),
       ($1, now() - interval '100 years', $3, 'integration-stale', 'NO',
        'sharp_minority', 'stale', 2,
        '{"version":2,"market":{"priceCheckedAt":"2026-01-01T00:00:00.000Z"},"gates":{"publishEligible":true}}'::jsonb,
        2, 0.4, 2),
       ($1, $4::timestamptz, $5, 'integration-unchecked', 'YES', 'sharp_side',
        'unchecked', 2,
        '{"version":2,"market":{"priceCheckedAt":null},"gates":{"publishEligible":true}}'::jsonb,
        3, 0.3, 3)`,
    [runId, freshThesis, staleThesis, supplyNow.toISOString(), uncheckedThesis],
  );

  const stages = await updateHolderResearchObservationStages(db, {
    runId,
    updates: [
      {
        thesisKey: freshThesis,
        triageAction: "investigate",
        researchVerdict: "supports_holder_side",
        finalVerdict: "publish",
      },
    ],
  });
  assert.equal(stages.updated, 1);

  const { rows: stageRows } = await client.query<{
    final_verdict: string | null;
    research_verdict: string | null;
    triage_action: string | null;
  }>(
    `select triage_action, research_verdict, final_verdict
     from holder_research_candidate_observations
     where run_id = $1 and thesis_key = $2`,
    [runId, freshThesis],
  );
  assert.deepEqual(stageRows[0], {
    triage_action: "investigate",
    research_verdict: "supports_holder_side",
    final_verdict: "publish",
  });

  const supply = await loadHolderResearchSupplyHealth(db, supplyNow);
  assert.ok(supply.days.length === 7);
  assert.equal(supply.days.at(-1)?.candidates, 1);

  const pruned = await pruneHolderResearchCandidateObservations(db, {
    retentionDays: 90,
    limit: 1,
  });
  assert.equal(pruned.deleted, 1);
  const { rows: staleRows } = await client.query<{ count: string }>(
    `select count(*)::text as count
     from holder_research_candidate_observations
     where run_id = $1 and thesis_key = $2`,
    [runId, staleThesis],
  );
  assert.equal(staleRows[0]?.count, "0");

  console.log("[holder-research-observations-integration-tests] passed 7/7");
} finally {
  await client.query("rollback");
  client.release();
}
