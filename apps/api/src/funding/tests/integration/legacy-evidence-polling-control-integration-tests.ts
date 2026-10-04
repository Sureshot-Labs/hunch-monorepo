// @requires-db
import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { legacyEvidencePollingPausedSql } from "../../legacy/evidence-polling-control.js";
import { claimLegacyDebridgeEvidence } from "../../legacy/debridge-evidence-reconciler.js";
import { claimAmbiguousPolymarketTradeAttemptsForReconciliation } from "../../persistence/funding-trade-attempt-repository.js";

const db = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=10000",
});
const recordId = "57e72ba3-4637-4a27-8e3f-30d3187e0def";
const marker = {
  version: 1,
  state: "paused",
  kind: "polymarket_orphan_attempt",
  recordId,
};
const fixtures = [
  ["no metadata", null, false],
  [
    "ordinary metadata",
    { consumerResolution: "released_to_venue_cash" },
    false,
  ],
  ["malformed scalar", "paused", false],
  ["exact historical pause", { legacyEvidencePolling: marker }, true],
  [
    "wrong record",
    { legacyEvidencePolling: { ...marker, recordId: "other" } },
    false,
  ],
  [
    "wrong kind",
    { legacyEvidencePolling: { ...marker, kind: "legacy_debridge" } },
    false,
  ],
  [
    "wrong version",
    { legacyEvidencePolling: { ...marker, version: 2 } },
    false,
  ],
  [
    "string version",
    { legacyEvidencePolling: { ...marker, version: "1" } },
    false,
  ],
  ["resumed", { legacyEvidencePolling: { ...marker, state: "active" } }, false],
  [
    "missing ID",
    {
      legacyEvidencePolling: { version: 1, state: "paused", kind: marker.kind },
    },
    false,
  ],
  [
    "audit details",
    { legacyEvidencePolling: { ...marker, reason: "historical_unknown" } },
    true,
  ],
] as const;
try {
  await db.query("begin read only");
  for (const [name, metadata, expected] of fixtures) {
    const result = await db.query<{ paused: boolean }>(
      `select ${legacyEvidencePollingPausedSql("$1::jsonb", "$2::text", "polymarket_orphan_attempt")} as paused`,
      [JSON.stringify(metadata), recordId],
    );
    assert.equal(result.rows[0]?.paused, expected, name);
  }
  // Recovery is explicit and immediately eligible, without a fake financial
  // result, an infinite lease, or a new housekeeping delay.
  for (const kind of [
    "polymarket_orphan_attempt",
    "legacy_debridge",
  ] as const) {
    const result = await db.query<{ paused: boolean; resumed: boolean }>(
      `with fixture_rows as (
        select $1::jsonb as metadata, $2::text as record_id
      ) select ${legacyEvidencePollingPausedSql("metadata", "record_id", kind)} as paused,
        ${legacyEvidencePollingPausedSql("jsonb_set(metadata, '{legacyEvidencePolling,state}', '\"active\"'::jsonb)", "record_id", kind)} as resumed
        from fixture_rows`,
      [
        JSON.stringify({ legacyEvidencePolling: { ...marker, kind } }),
        recordId,
      ],
    );
    assert.deepEqual(result.rows[0], { paused: true, resumed: false });
  }
  // Execute the actual candidate filters on PostgreSQL, using CTE fixtures to
  // shadow production tables. No rows, leases or reservations are written.
  const queries: string[] = [];
  const captureDb = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool;
  const now = new Date("2026-10-04T18:00:00Z");
  await claimAmbiguousPolymarketTradeAttemptsForReconciliation(captureDb, now);
  await claimLegacyDebridgeEvidence(captureDb, now);
  const fixtureId = "eea63c47-a8a7-45d7-93ad-1ac92babc8dd";
  const secondId = "31c73ec6-78f4-4674-b7ee-94d0f4e7486a";
  const polymarketFixture = `with funding_trade_attempts as (
    select fixture_rows.id::uuid, '${recordId}'::uuid as user_id,
      '${recordId}'::uuid as operation_id, 'polymarket_clob' as execution_path,
      'ambiguous' as state, true as broadcast_may_have_occurred,
      '0x' || repeat('a', 64) as external_reference,
      '2026-08-30T18:00:00Z'::timestamptz as claim_lease_until
    from (values ('${recordId}'), ('${fixtureId}')) fixture_rows(id)
  ), funding_operations as (
    select '${recordId}'::uuid as id, '${recordId}'::uuid as user_id,
      $2::jsonb as support_metadata
  ), orders as (
    select null::uuid as user_id, null::uuid as funding_trade_attempt_id,
      'polymarket' as venue where false
  ) `;
  for (const state of ["paused", "active"] as const) {
    const result = await db.query<{ id: string }>(
      polymarketFixture + queries[0],
      [now, JSON.stringify({ legacyEvidencePolling: { ...marker, state } })],
    );
    assert.deepEqual(
      result.rows.map((row) => row.id).sort(),
      (state === "paused" ? [fixtureId] : [recordId, fixtureId]).sort(),
      "pausing one attempt does not starve another attempt on the same operation/user",
    );
  }
  let claimUpdateSql = "";
  const captureClient = {
    release() {},
    query: async (sql: string) => {
      if (sql.startsWith("update funding_trade_attempts")) {
        claimUpdateSql = sql;
        return { rows: [] };
      }
      if (sql.includes("select operation_id, reservation_id"))
        return { rows: [{ operation_id: recordId, reservation_id: recordId }] };
      if (
        sql.includes("from funding_operations") ||
        sql.includes("from balance_reservations")
      )
        return { rows: [{ id: recordId }] };
      if (
        sql.includes("from funding_trade_attempts") &&
        sql.includes("for update")
      )
        return {
          rows: [
            {
              id: recordId,
              user_id: recordId,
              execution_path: "polymarket_clob",
              state: "ambiguous",
              broadcast_may_have_occurred: true,
              external_reference: `0x${"a".repeat(64)}`,
              claim_lease_until: new Date("2026-08-30T18:00:00Z"),
            },
          ],
        };
      return { rows: [] };
    },
  };
  await claimAmbiguousPolymarketTradeAttemptsForReconciliation(
    {
      query: async () => ({ rows: [{ id: recordId, user_id: recordId }] }),
      connect: async () => captureClient,
    } as unknown as Pool,
    now,
  );
  assert.ok(claimUpdateSql.includes("legacyEvidencePolling"));
  const underLockFilter = claimUpdateSql.slice(
    claimUpdateSql.indexOf("where id = $1"),
    claimUpdateSql.indexOf("returning"),
  );
  for (const state of ["paused", "active"] as const) {
    const result = await db.query<{ id: string }>(
      polymarketFixture.replace("$2::jsonb", "$4::jsonb") +
        "select funding_trade_attempts.id from funding_trade_attempts " +
        underLockFilter,
      [
        recordId,
        recordId,
        now,
        JSON.stringify({ legacyEvidencePolling: { ...marker, state } }),
      ],
    );
    assert.equal(
      result.rows.length,
      state === "paused" ? 0 : 1,
      "a pause applied after candidate selection is rechecked before the lease update",
    );
  }
  const bridgeCandidateMatch = queries[1]?.match(
    /^with candidate_rows as \(([\s\S]+)\) update bridge_orders/,
  );
  assert.ok(bridgeCandidateMatch?.[1]);
  const bridgeCandidateSql = bridgeCandidateMatch[1].replace(
    "for update skip locked",
    "",
  );
  const bridgeFixture = `with bridge_orders as (
    select fixture_rows.id::uuid, 'debridge' as provider, 'submitted' as status,
      'historical-source' as tx_hash_src, 'debridge_same_chain_v1' as adapter_version,
      '2026-04-19T18:00:00Z'::timestamptz as updated_at,
      case when fixture_rows.id = '${fixtureId}' then $2::jsonb else '{}'::jsonb end as metadata
    from (values ('${fixtureId}'), ('${secondId}')) fixture_rows(id)
  ) `;
  for (const state of ["paused", "active"] as const) {
    const result = await db.query<{ id: string }>(
      bridgeFixture + bridgeCandidateSql,
      [
        now.toISOString(),
        JSON.stringify({
          legacyEvidencePolling: {
            ...marker,
            kind: "legacy_debridge",
            recordId: fixtureId,
            state,
          },
        }),
      ],
    );
    assert.deepEqual(
      result.rows.map((row) => row.id).sort(),
      (state === "paused" ? [secondId] : [secondId, fixtureId]).sort(),
      "old same-chain and cross-chain shapes remain eligible unless explicitly paused",
    );
  }
  console.log(
    "[legacy-evidence-polling-control-integration-tests] 19 PostgreSQL pause/scope/resume and actual candidate/under-lock-filter cases passed",
  );
} finally {
  await db.query("rollback").catch(() => undefined);
  await db.end();
}
