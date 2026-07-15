// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "./db.js";

const client = await pool.connect();
try {
  await client.query("begin");
  const suffix = crypto.randomUUID();
  const eventId = `limitless:resolution-event:${suffix}`;
  const marketId = `limitless:resolution-market:${suffix}`;
  await client.query(
    `
      insert into unified_events (
        id, venue, venue_event_id, title, status, created_at, updated_at
      )
      values ($1, 'limitless', $1, 'Resolution trigger test', 'ACTIVE', now(), now())
    `,
    [eventId],
  );
  await client.query(
    `
      insert into unified_markets (
        id, venue, venue_market_id, event_id, title, status, market_type,
        created_at, updated_at
      )
      values ($1, 'limitless', $1, $2, 'Resolution trigger test', 'ACTIVE', 'binary', now(), now())
    `,
    [marketId, eventId],
  );
  const unresolved = await client.query<{
    resolution_observed_at: Date | null;
  }>(`select resolution_observed_at from unified_markets where id = $1`, [
    marketId,
  ]);
  assert.equal(unresolved.rows[0]?.resolution_observed_at, null);

  await client.query(
    `update unified_markets set resolved_outcome = 'YES' where id = $1`,
    [marketId],
  );
  const first = await client.query<{ resolution_observed_at: Date | null }>(
    `select resolution_observed_at from unified_markets where id = $1`,
    [marketId],
  );
  assert.ok(first.rows[0]?.resolution_observed_at);

  await client.query(
    `update unified_markets set resolved_outcome = 'NO' where id = $1`,
    [marketId],
  );
  const second = await client.query<{ resolution_observed_at: Date | null }>(
    `select resolution_observed_at from unified_markets where id = $1`,
    [marketId],
  );
  assert.equal(
    second.rows[0]?.resolution_observed_at?.toISOString(),
    first.rows[0]?.resolution_observed_at?.toISOString(),
  );

  await client.query("rollback");
  console.log("ok - resolution transition timestamp is first-write-only");
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
}
