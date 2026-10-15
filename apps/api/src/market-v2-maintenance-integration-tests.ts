// @api-integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  buildPolymarketSourceRepair,
  resolvePolymarketGammaOutcome,
} from "./services/market-resolution-outcomes.js";
import { normalizeGammaLifecycle } from "@hunch/shared";

const db = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/polymarket/v2-public-20261015.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const readSource = (name: string) =>
  readFileSync(new URL(name, import.meta.url), "utf8");
try {
  // Execute the actual SQL literals used by both CLIs, not a second SQL implementation.
  for (const cli of [
    "market-active-status-repair.ts",
    "market-resolution-outcome-repair.ts",
  ]) {
    const source = readSource(cli);
    const materialize = source.match(
      /`\s*(create temp table tmp_market_(?:active_status|resolution_outcome)_repair on commit drop as[\s\S]*?)`/u,
    )?.[1];
    assert.ok(materialize);
    const updateStatements = [
      ...source.matchAll(
        /`\s*(update (?:unified_markets m|polymarket_markets pm)[\s\S]*?)`/gu,
      ),
    ].map((match) => {
      assert.ok(match[1]);
      return match[1];
    });
    assert.ok(updateStatements.length >= 3);
    for (const resolutionStatus of ["inactive", "resolved"]) {
      for (const outcomePrices of ['["1","0"]', '["0.5","0.5"]']) {
        await db.query("begin");
        try {
          const raw = {
            ...fixture.markets[0],
            id: `gamma-maintenance-${randomUUID()}`,
            closed: true,
            resolutionStatus,
            outcomePrices,
          };
          const marketId = `polymarket:${raw.id}`;
          const eventId = `event-${raw.id}`;
          // Own transactional fixture: this test must work independently of
          // the indexer integration suite on any explicitly verified test DB.
          await db.query(
            "insert into polymarket_events (id,title,raw) values ($1,'V2 maintenance fixture','{}')",
            [eventId],
          );
          await db.query(
            "insert into unified_events (id,venue,venue_event_id,title,status) values ($1,'polymarket',$2,'V2 maintenance fixture','ACTIVE')",
            [`polymarket:${eventId}`, eventId],
          );
          await db.query(
            "insert into polymarket_markets (id,event_id,question,raw) values ($1,$2,$3,$4::jsonb)",
            [raw.id, eventId, raw.question, JSON.stringify(raw)],
          );
          await db.query(
            "insert into unified_markets (id,venue,venue_market_id,event_id,title,status,market_type) values ($1,'polymarket',$2,$3,$4,'ACTIVE','binary')",
            [marketId, raw.id, `polymarket:${eventId}`, raw.question],
          );
          await db.query(
            'update unified_markets set status=$2::unified_status, resolved_outcome=null, resolved_outcome_pct=null, metadata=\'{"version":"v2","resolutionStatus":"active","preserve":42}\'::jsonb where id=$1',
            [marketId, cli.includes("active-status") ? "ACTIVE" : "CLOSED"],
          );
          await db.query(
            "update polymarket_markets set raw = raw || '{\"preserveOptional\":42}'::jsonb where id=$1",
            [raw.id],
          );
          const outcome = resolvePolymarketGammaOutcome(raw);
          const payload = [
            {
              market_id: marketId,
              venue: "polymarket",
              venue_market_id: raw.id,
              event_id: `polymarket:${eventId}`,
              current_status: "ACTIVE",
              target_status: normalizeGammaLifecycle(raw).status,
              resolved_outcome: outcome.resolvedOutcome,
              resolved_outcome_pct: outcome.resolvedOutcomePct,
              polymarket_source: buildPolymarketSourceRepair(raw),
            },
          ];
          await db.query(materialize, [JSON.stringify(payload)]);
          // Active repair writes status first; its outcome statement requires it.
          const ordered = cli.includes("active-status")
            ? [...updateStatements].sort(
                (a, b) =>
                  Number(b.includes("set status = r.target_status")) -
                  Number(a.includes("set status = r.target_status")),
              )
            : updateStatements;
          for (const sql of ordered) await db.query(sql);
          const row = (
            await db.query(
              "select status, resolved_outcome, metadata from unified_markets where id=$1",
              [marketId],
            )
          ).rows[0];
          assert.equal(
            row.status,
            resolutionStatus === "resolved" ? "SETTLED" : "CLOSED",
          );
          assert.equal(row.resolved_outcome, outcome.resolvedOutcome);
          assert.equal(row.metadata.resolutionStatus, resolutionStatus);
          assert.equal(row.metadata.preserve, 42);
          const sourceRow = (
            await db.query("select raw from polymarket_markets where id=$1", [
              raw.id,
            ])
          ).rows[0];
          assert.equal(sourceRow.raw.preserveOptional, 42);
          assert.deepEqual(sourceRow.raw.positionIds, raw.positionIds);
        } finally {
          await db.query("rollback");
        }
      }
    }
  }
  const route = readSource("routes/hunches.ts");
  const columns = route.match(/const HUNCH_COLUMNS = `([\s\S]*?)`;/u)?.[1];
  const joins = route.match(/const HUNCH_JOINS = `([\s\S]*?)`;/u)?.[1];
  assert.ok(columns && joins);
  await db.query(`select ${columns} from ai_notes n ${joins} where n.id=$1`, [
    "a8d5e80e-93bd-4f21-ab9a-bd8711aeda0c",
  ]);
  console.log(
    "ok - PG16 both maintenance SQL paths, metadata preservation, V2 settled without winner and Hunch projection",
  );
} finally {
  await db.end();
}
