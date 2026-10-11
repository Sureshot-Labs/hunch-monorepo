import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  storeOrder,
  updateOrderFromHistory,
  type StoreOrderInput,
} from "./repos/orders-repo.js";
import {
  buildLimitlessClobSubmissionContext,
  limitlessClobFrozenContext,
  limitlessClobSubmittedOrder,
} from "./services/limitless-clob-evidence-identity.js";

const owner = `0x${"1".repeat(40)}`;
const exchange = `0x${"2".repeat(40)}`;
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
  clientOrderId: "local-client-order",
};
const context = buildLimitlessClobSubmissionContext(exchange, signedOrder);
const baseInput: StoreOrderInput = {
  userId: "1844db1a-b1a0-4f93-b12c-5c5ea960687e",
  walletAddress: owner,
  venue: "limitless",
  venueOrderId: "venue-order",
  tokenId: "limitless:123",
  side: "BUY",
  orderType: "FOK",
  price: 0.5,
  size: 20,
  status: "submitted",
  errorMessage: null,
  rawError: null,
  fundingRecoveryMode: "explicit_only",
};
function fixture(existingPayload?: unknown) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/insert into orders/i.test(sql))
      return {
        rows: [
          { id: "row", venue_order_id: "venue-order", status: "submitted" },
        ],
        rowCount: 1,
      };
    if (/from orders/i.test(sql) && existingPayload !== undefined)
      return {
        rows: [
          {
            id: "row",
            token_id: "limitless:123",
            wallet_address: owner,
            status: "submitted",
            order_payload: existingPayload,
          },
        ],
        rowCount: 1,
      };
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Pool;
  return { pool, calls };
}
async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`ok - ${name}`);
}

await test("untrusted source and nested wrappers cannot create frozen context", async () => {
  const { pool, calls } = fixture();
  const unrelated = { _hunchLimitlessClob: "unrelated application data" };
  const payload = {
    source: "foo",
    _hunchLimitlessClob: context,
    _hunchPositionDeltaAppliedAt: "marker",
    unrelated,
    submitted: {
      _hunchLimitlessClob: context,
      _hunchSubmitted: { _hunchLimitlessClob: context, ...signedOrder },
      payload: { _hunchLimitlessClob: context, keep: "yes" },
    },
    _hunchUpstream: { data: { order: { _hunchLimitlessClob: context } } },
  };
  await storeOrder(pool, { ...baseInput, orderPayload: payload });
  const insert = calls.find((call) => /insert into orders/i.test(call.sql));
  assert.ok(insert);
  const stored = insert.params[13] as typeof payload;
  assert.equal(limitlessClobFrozenContext(stored), undefined);
  assert.equal("_hunchLimitlessClob" in stored.submitted.payload, false);
  assert.deepEqual(stored._hunchUpstream, { data: { order: {} } });
  assert.equal(stored.source, "foo");
  assert.equal(stored._hunchPositionDeltaAppliedAt, "marker");
  assert.equal(stored.unrelated, unrelated);
  assert.deepEqual(payload._hunchLimitlessClob, context, "do not mutate input");
});

await test("only explicit matching server context freezes the exact local signed order", async () => {
  const { pool, calls } = fixture();
  await storeOrder(pool, {
    ...baseInput,
    orderPayload: { ...signedOrder, _hunchLimitlessClob: { spoof: true } },
    limitlessClobSubmissionContext: context,
  });
  const insert = calls.find((call) => /insert into orders/i.test(call.sql));
  assert.ok(insert);
  const stored = insert.params[13] as Record<string, unknown>;
  assert.deepEqual(limitlessClobFrozenContext(stored), context);
  assert.deepEqual(limitlessClobSubmittedOrder(stored), signedOrder);
});

await test("hash mismatch and non-Limitless provenance reject before data writes", async () => {
  for (const input of [
    { ...baseInput, orderPayload: { ...signedOrder, salt: "72" } },
    { ...baseInput, orderPayload: signedOrder, venue: "polymarket" },
  ]) {
    const { pool, calls } = fixture();
    await assert.rejects(
      storeOrder(pool, {
        ...input,
        limitlessClobSubmissionContext: context,
      }),
      /Limitless/,
    );
    assert.equal(
      calls.some((call) => /insert|update/i.test(call.sql)),
      false,
    );
    assert.equal(calls.at(-1)?.sql, "ROLLBACK");
  }
});

await test("history input is sanitized even when it calls itself submitted", async () => {
  const { pool, calls } = fixture();
  await updateOrderFromHistory(pool, {
    id: "row",
    status: "filled",
    price: 0.5,
    size: 20,
    filledAt: null,
    lastUpdate: null,
    orderHash: null,
    orderPayload: {
      _hunchLimitlessClob: context,
      submitted: { _hunchLimitlessClob: context, order: signedOrder },
      source: "foo",
    },
  });
  assert.ok(calls[0]);
  assert.deepEqual(JSON.parse(calls[0].params[8] as string), {
    submitted: { order: signedOrder },
    source: "foo",
  });
});

await test("conflicting frozen context rejects before an otherwise-needed order update", async () => {
  const frozen = {
    _hunchLimitlessClob: context,
    _hunchSubmitted: signedOrder,
  };
  const { pool, calls } = fixture({
    submitted: frozen,
    history: { source: "provider" },
  });
  await assert.rejects(
    storeOrder(pool, {
      ...baseInput,
      orderPayload: signedOrder,
      limitlessClobSubmissionContext: buildLimitlessClobSubmissionContext(
        `0x${"3".repeat(40)}`,
        signedOrder,
      ),
    }),
    /conflicts with its stored/,
  );
  assert.equal(
    calls.some((call) => /^(insert|update)/i.test(call.sql.trim())),
    false,
  );
  assert.equal(calls.at(-1)?.sql, "ROLLBACK");
});

await test("history-first client identity conflict rejects and the exact identity can retry", async () => {
  const { pool, calls } = fixture({
    clientOrderId: signedOrder.clientOrderId,
    source: "provider-history",
  });
  await assert.rejects(
    storeOrder(pool, {
      ...baseInput,
      orderPayload: { ...signedOrder, clientOrderId: "different-client-order" },
      limitlessClobSubmissionContext: context,
    }),
    /conflicts with its stored client order ID/,
  );
  assert.equal(
    calls.some((call) => /^\s*(insert|update)\b/i.test(call.sql)),
    false,
  );
  const result = await storeOrder(pool, {
    ...baseInput,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: context,
  });
  assert.equal(result.kind, "exists");
  assert.equal(calls.at(-1)?.sql, "COMMIT");
  assert.ok(calls.some((call) => /^\s*update orders/i.test(call.sql)));
});
