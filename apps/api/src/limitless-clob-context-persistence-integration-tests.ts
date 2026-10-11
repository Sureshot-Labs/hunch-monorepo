// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import {
  hasPositionDeltaApplied,
  storeOrder,
  updateOrderFromHistory,
  type StoreOrderInput,
} from "./repos/orders-repo.js";
import {
  buildLimitlessClobSubmissionContext,
  limitlessClobFrozenContext,
  limitlessClobSubmittedOrder,
  resolveLimitlessClobEvidenceIdentity,
} from "./services/limitless-clob-evidence-identity.js";
import { createIntegrationTestPool } from "./test-database-target.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const userId = randomUUID();
const owner = `0x${"1".repeat(40)}`;
const exchange = `0x${"2".repeat(40)}`;
const otherExchange = `0x${"3".repeat(40)}`;
const txHash = `0x${"a".repeat(64)}`;
const marker = "2026-10-08T00:00:00.000Z";
const signedOrder = {
  salt: "71",
  maker: owner,
  signer: owner,
  taker: `0x${"0".repeat(40)}`,
  tokenId: "123",
  makerAmount: "10000000",
  takerAmount: "20000000",
  expiration: "0",
  nonce: "0",
  feeRateBps: "0",
  side: 0,
  signatureType: 0,
  signature: "0xsigned",
  source: "server-prepared",
  clientOrderId: "local-client-order",
};
const context = buildLimitlessClobSubmissionContext(exchange, signedOrder);
const baseInput: StoreOrderInput = {
  userId,
  walletAddress: owner,
  venue: "limitless",
  venueOrderId: `context:${randomUUID()}`,
  tokenId: "limitless:123",
  side: "BUY",
  orderType: "FOK",
  price: 0.5,
  size: 20,
  status: "submitted",
  errorMessage: null,
  rawError: null,
  orderHash: txHash,
  fundingRecoveryMode: "explicit_only",
};
const calls: { sql: string; values: unknown[] }[] = [];
let transactionDepth = 0;
const session = {
  query: async (sql: string, values: unknown[] = []) => {
    if (sql.toLowerCase() === "begin")
      return client.query(`savepoint clob_context_${++transactionDepth}`);
    if (sql.toLowerCase() === "commit")
      return client.query(
        `release savepoint clob_context_${transactionDepth--}`,
      );
    if (sql.toLowerCase() === "rollback") {
      const result = await client.query(
        `rollback to savepoint clob_context_${transactionDepth}`,
      );
      await client.query(
        `release savepoint clob_context_${transactionDepth--}`,
      );
      return result;
    }
    calls.push({ sql, values });
    return client.query(sql, values);
  },
  release: () => {},
};
const db = {
  query: session.query,
  connect: async () => session,
} as unknown as Pool;
async function readOrder(id: string) {
  const result = await client.query<{
    order_payload: Record<string, unknown> | null;
    order_hash: string | null;
    verified_buy_facts: Record<string, unknown> | null;
    token_id: string;
    price: string | null;
    size: string | null;
    status: string;
    client_order_id: string | null;
  }>(
    `select order_payload,order_hash,verified_buy_facts,token_id,price,size,status,
      coalesce(order_payload->>'clientOrderId',order_payload->'submitted'->>'clientOrderId',
        order_payload->'_hunchSubmitted'->>'clientOrderId') as client_order_id
     from orders where id=$1`,
    [id],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}
function assertFrozen(
  payload: Record<string, unknown> | null,
): asserts payload is Record<string, unknown> {
  assert.ok(payload);
  assert.deepEqual(limitlessClobFrozenContext(payload), context);
  assert.deepEqual(limitlessClobSubmittedOrder(payload), signedOrder);
  assert.deepEqual(
    resolveLimitlessClobEvidenceIdentity({
      orderPayload: payload,
      marketMetadata: { venueExchange: otherExchange },
      legacyExchangeAddress: otherExchange,
      providerOrder: { orderHash: context.orderHash },
    }),
    { exchangeAddress: exchange, orderHash: context.orderHash },
  );
}
async function applyHistory(id: string) {
  await updateOrderFromHistory(db, {
    id,
    status: "filled",
    price: 0.5,
    size: 20,
    filledAt: new Date(marker),
    lastUpdate: new Date(marker),
    orderHash: txHash,
    orderPayload: {
      source: "foo",
      _hunchLimitlessClob: { spoof: "root" },
      submitted: { _hunchLimitlessClob: { spoof: "submitted" } },
      _hunchUpstream: {
        data: { order: { _hunchLimitlessClob: { spoof: "provider" } } },
      },
      keep: "upstream history",
    },
  });
}
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const walkPlan = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(walkPlan),
];

try {
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
    "This fixture targets PostgreSQL 16",
  );
  await client.query("begin");
  await client.query("set local statement_timeout='120s'");
  await client.query("set local lock_timeout='5s'");
  await client.query(
    "insert into users(id,display_name) values($1,'CLOB context fixture')",
    [userId],
  );
  await client.query(
    `insert into orders(user_id,venue,venue_order_id,status)
     select $1,'limitless',$2||sequence_row::text,'submitted'
     from generate_series(1,50000) sequence_row`,
    [userId, `unrelated:${randomUUID()}:`],
  );
  await client.query("analyze orders");

  const fresh = await storeOrder(db, {
    ...baseInput,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: context,
  });
  assert.equal(fresh.kind, "stored");
  assertFrozen((await readOrder(fresh.order.id)).order_payload);
  const frozenBeforeRetry = await readOrder(fresh.order.id);
  assert.equal(
    (
      await storeOrder(db, {
        ...baseInput,
        orderPayload: signedOrder,
        limitlessClobSubmissionContext: context,
      })
    ).kind,
    "exists",
  );
  assert.deepEqual(await readOrder(fresh.order.id), frozenBeforeRetry);
  console.log(
    "ok - PG16 fresh trusted insert and identical retry preserve frozen order",
  );

  const raceInput = {
    ...baseInput,
    venueOrderId: `history-first:${randomUUID()}`,
  };
  const historyPayload = {
    source: "foo",
    upstreamId: "provider-history",
    payload: { _hunchPositionDeltaAppliedAt: marker, keep: "nested marker" },
    _hunchLimitlessClob: { spoof: "root" },
    submitted: {
      order: {
        ...signedOrder,
        salt: "provider-value",
        _hunchLimitlessClob: context,
      },
    },
  };
  const race = await storeOrder(db, {
    ...raceInput,
    orderPayload: historyPayload,
  });
  const beforeEnrichment = await readOrder(race.order.id);
  assert.ok(beforeEnrichment.order_payload);
  assert.equal(
    limitlessClobFrozenContext(beforeEnrichment.order_payload),
    undefined,
  );
  assert.equal(
    "_hunchLimitlessClob" in
      ((beforeEnrichment.order_payload.submitted as Record<string, unknown>)
        .order as Record<string, unknown>),
    false,
  );
  const canonicalFacts = {
    canonicalPurchaseKey: `limitless:clob:8453:${raceInput.venueOrderId}`,
    instrument: {
      venue: "limitless",
      tokenId: "limitless:123",
      generation: "original-generation",
      outcome: "YES",
    },
  };
  await client.query(
    "update orders set verified_buy_facts=$2::jsonb where id=$1",
    [race.order.id, JSON.stringify(canonicalFacts)],
  );
  const enriched = await storeOrder(db, {
    ...raceInput,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: context,
  });
  assert.equal(enriched.kind, "exists");
  assert.equal(enriched.order.position_delta_applied, true);
  const raceRow = await readOrder(race.order.id);
  assertFrozen(raceRow.order_payload);
  assert.equal(raceRow.client_order_id, signedOrder.clientOrderId);
  assert.equal(raceRow.order_payload.source, "foo");
  assert.equal(raceRow.order_payload.upstreamId, "provider-history");
  assert.deepEqual(raceRow.order_payload.payload, historyPayload.payload);
  assert.deepEqual(raceRow.verified_buy_facts, canonicalFacts);
  assert.equal(
    raceRow.order_hash,
    txHash,
    "legacy transaction hash must not become EIP-712 hash",
  );
  console.log(
    "ok - PG16 history-first enrichment preserves provider data, markers, canonical facts and exact client identity",
  );

  await applyHistory(race.order.id);
  await applyHistory(race.order.id);
  const afterHistory = await readOrder(race.order.id);
  assertFrozen(afterHistory.order_payload);
  assert.equal(afterHistory.client_order_id, signedOrder.clientOrderId);
  assert.equal(hasPositionDeltaApplied(afterHistory.order_payload), true);
  assert.deepEqual(
    (afterHistory.order_payload.submitted as Record<string, unknown>).payload,
    historyPayload.payload,
  );
  assert.deepEqual(afterHistory.order_payload.history, {
    source: "foo",
    submitted: {},
    _hunchUpstream: { data: { order: {} } },
    keep: "upstream history",
  });
  assert.deepEqual(afterHistory.verified_buy_facts, canonicalFacts);
  assert.equal(afterHistory.token_id, "limitless:123");
  assertFrozen(
    (
      await readOrder(
        (
          await storeOrder(db, {
            ...raceInput,
            orderPayload: signedOrder,
            limitlessClobSubmissionContext: context,
          })
        ).order.id,
      )
    ).order_payload,
  );
  console.log(
    "ok - PG16 history wrapping and repeated sync retain signed identity without accepting provider context",
  );

  await client.query("update orders set price=null,size=null where id=$1", [
    race.order.id,
  ]);
  const beforeConflict = await readOrder(race.order.id);
  const callCount = calls.length;
  await assert.rejects(
    storeOrder(db, {
      ...raceInput,
      orderPayload: signedOrder,
      limitlessClobSubmissionContext: buildLimitlessClobSubmissionContext(
        otherExchange,
        signedOrder,
      ),
    }),
    /conflicts with its stored/,
  );
  assert.deepEqual(await readOrder(race.order.id), beforeConflict);
  assert.equal(
    calls
      .slice(callCount)
      .some((call) => /^\s*(insert|update)\b/i.test(call.sql)),
    false,
  );
  await assert.rejects(
    storeOrder(db, {
      ...baseInput,
      venueOrderId: `invalid:${randomUUID()}`,
      orderPayload: { ...signedOrder, salt: "72" },
      limitlessClobSubmissionContext: context,
    }),
    /does not match signed order/,
  );
  console.log(
    "ok - PG16 conflicting context rolls back before enrichment; invalid local signed hash is rejected",
  );

  const emptyInput = {
    ...baseInput,
    venueOrderId: `empty:${randomUUID()}`,
    orderPayload: null,
  };
  const empty = await storeOrder(db, emptyInput);
  await storeOrder(db, {
    ...emptyInput,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: context,
  });
  assertFrozen((await readOrder(empty.order.id)).order_payload);
  const historyOnly = await storeOrder(db, {
    ...emptyInput,
    venueOrderId: `history-only:${randomUUID()}`,
  });
  await applyHistory(historyOnly.order.id);
  const historyOnlyPayload = (await readOrder(historyOnly.order.id))
    .order_payload;
  assert.ok(historyOnlyPayload);
  assert.equal(limitlessClobFrozenContext(historyOnlyPayload), undefined);
  console.log(
    "ok - PG16 empty-payload enrichment and history-only update enforce separate trust paths",
  );

  // Execute every repository SQL branch above, then plan each emitted DML form
  // without executing it again. Point updates must remain primary-key lookups.
  const statements = new Map<string, unknown[]>();
  for (const call of calls)
    if (/^\s*(insert into orders|update orders)/i.test(call.sql))
      statements.set(call.sql, call.values);
  for (const [sql, values] of statements) {
    const explained = await client.query(
      `explain (format json) ${sql}`,
      values,
    );
    const nodes = walkPlan(explained.rows[0]["QUERY PLAN"][0].Plan);
    if (/^\s*update/i.test(sql))
      assert.ok(nodes.some((node) => node["Index Name"] === "orders_pkey"));
  }
  const explainedRead = await client.query(
    "explain (analyze,buffers,format json) select order_payload from orders where id=$1",
    [race.order.id],
  );
  const planResult = explainedRead.rows[0]["QUERY PLAN"][0];
  assert.equal(planResult.Plan["Index Name"], "orders_pkey");
  assert.equal(planResult.Plan["Actual Rows"], 1);
  console.log(
    JSON.stringify({
      sqlFormsExecutedAndPlanned: statements.size,
      unrelatedOrders: 50000,
      pointReadIndex: planResult.Plan["Index Name"],
      actualRows: planResult.Plan["Actual Rows"],
      sharedHitBlocks: planResult.Plan["Shared Hit Blocks"],
      executionMs: planResult["Execution Time"],
    }),
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
