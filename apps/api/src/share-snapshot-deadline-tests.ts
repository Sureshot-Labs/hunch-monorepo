#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool, PoolClient } from "@hunch/infra";

import { ShareCreateGuardError } from "./services/share-create-guard.js";
import { createTradePnlShare } from "./services/share-snapshots.js";

type QueryResult = Readonly<{ rows: unknown[] }>;

let resolvePositionQuery!: (result: QueryResult) => void;
let insertAttempted = false;
let committed = false;
let rolledBack = false;
let released = false;

const positionQuery = new Promise<QueryResult>((resolve) => {
  resolvePositionQuery = resolve;
});

const client = {
  query: async (query: unknown): Promise<QueryResult> => {
    const sql =
      typeof query === "string"
        ? query
        : String((query as { text?: unknown })?.text ?? "");
    if (sql === "begin" || sql.includes("set_config('statement_timeout'")) {
      return { rows: [] };
    }
    if (sql.includes("select referral_code from users")) {
      return { rows: [{ referral_code: null }] };
    }
    if (sql.includes("where p.user_id = $1")) return positionQuery;
    if (sql.includes("insert into share_snapshots")) {
      insertAttempted = true;
      return { rows: [] };
    }
    if (sql === "commit") {
      committed = true;
      return { rows: [] };
    }
    if (sql === "rollback") {
      rolledBack = true;
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
  release: () => {
    released = true;
  },
} as unknown as PoolClient;

const pool = {
  connect: async () => client,
} as unknown as Pool;

const deadlineAt = Date.now() + 25;
const creation = createTradePnlShare(
  pool,
  {
    userId: "00000000-0000-4000-8000-000000000001",
    positionId: "00000000-0000-4000-8000-000000000002",
  },
  { deadlineAt, statementTimeoutMs: 900 },
);

await new Promise((resolve) => setTimeout(resolve, 40));
resolvePositionQuery({
  rows: [
    {
      position_id: "00000000-0000-4000-8000-000000000002",
      venue: "limitless",
      token_id: "token-deadline",
      side: "YES",
      size: "1",
      average_price: "0.5",
      realized_pnl: "0",
      unrealized_pnl_effective: "0.5",
      effective_pnl: "0.5",
      last_updated_at: new Date(0),
      created_at: new Date(0),
      updated_at: new Date(0),
      outcome_side: "YES",
      market_id: "limitless:deadline",
      market_title: "Deadline test",
      market_image: null,
      market_status: "active",
      market_close_time: null,
      market_expiration_time: null,
      best_bid_yes: "0.5",
      best_ask_yes: "0.51",
      best_bid_no: "0.49",
      best_ask_no: "0.5",
      last_price: "0.5",
      resolved_outcome: null,
      resolved_outcome_pct: null,
      redemption_status: null,
      event_id: "limitless:event-deadline",
      event_title: "Deadline event",
      event_image: null,
      event_end_time: null,
    },
  ],
});

await assert.rejects(creation, (error: unknown) => {
  assert.ok(error instanceof ShareCreateGuardError);
  assert.equal(error.reason, "request_timeout");
  return true;
});
assert.equal(insertAttempted, false);
assert.equal(committed, false);
assert.equal(rolledBack, true);
assert.equal(released, true);

console.log(
  "[share-snapshot-deadline-tests] ok late query completion rolls back before insert",
);
