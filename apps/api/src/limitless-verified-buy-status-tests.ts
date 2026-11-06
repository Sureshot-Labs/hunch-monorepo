import assert from "node:assert/strict";
import { interpretLimitlessVerifiedBuyOrderStatus as interpret } from "./services/limitless-order-status-parser.js";
import { env } from "./env.js";
import {
  fetchLimitlessVerifiedBuyOrderStatus,
  fetchLimitlessOrderStatusBatch,
} from "./services/limitless-order-status.js";

const lookup = { orderId: "provider-order", clientOrderId: "client-order" };
const absent = [
  { index: 0, status: "not_found", orderId: lookup.orderId },
  { index: 1, status: "not_found", clientOrderId: lookup.clientOrderId },
];
const expected = { status: "not_found", ...lookup };
assert.deepEqual(interpret({ results: absent }, lookup), expected);
assert.deepEqual(
  interpret({ results: [...absent].reverse() }, lookup),
  expected,
);
assert.deepEqual(
  interpret({ results: absent.map(({ index, ...result }) => result) }, lookup),
  expected,
);
assert.deepEqual(
  interpret({ results: [absent[0]] }, { orderId: lookup.orderId }),
  { status: "not_found", orderId: lookup.orderId, clientOrderId: null },
);
assert.equal(interpret({ results: [] }, {}), null);
for (const results of [
  [],
  [absent[0]],
  [...absent, absent[1]],
  [null, absent[1]],
  [{ ...absent[0], orderId: "other" }, absent[1]],
  [{ ...absent[0], clientOrderId: "other" }, absent[1]],
  [absent[0], { ...absent[1], orderId: "other" }],
  [absent[0], { ...absent[1], clientOrderId: "other" }],
  [{ ...absent[0], status: "unknown" }, absent[1]],
  [absent[0], { ...absent[1], status: "error" }],
  [{ ...absent[0], index: 1 }, absent[1]],
  [{ ...absent[0], index: 2 }, absent[1]],
  [absent[0], { status: "not_found", clientOrderId: lookup.clientOrderId }],
])
  assert.equal(interpret({ results }, lookup), null);
for (const payload of [
  null,
  [],
  {},
  { results: {} },
  { data: { results: absent } },
])
  assert.equal(interpret(payload, lookup), null);
for (const malformed of [42, {}, [], true, "", "   "]) {
  assert.equal(
    interpret(
      { results: [absent[0], { ...absent[1], orderId: malformed }] },
      lookup,
    ),
    null,
  );
  assert.equal(
    interpret(
      { results: [{ ...absent[0], clientOrderId: malformed }, absent[1]] },
      lookup,
    ),
    null,
  );
}
const found = {
  index: 1,
  status: "found",
  ...lookup,
  data: { order: { order: { id: lookup.orderId } } },
};
assert.deepEqual(interpret({ results: [absent[0], found] }, lookup), found);
assert.deepEqual(interpret({ results: [found] }, lookup), found);
assert.deepEqual(interpret({ results: [null, found] }, lookup), found);
assert.deepEqual(
  interpret({ results: [{ status: "unknown" }, found] }, lookup),
  found,
);
const wrongProvider = { ...found, orderId: "other-provider" };
assert.deepEqual(
  interpret({ results: [absent[0], wrongProvider] }, lookup),
  wrongProvider,
);
const wrongClient = {
  index: 0,
  status: "found",
  orderId: lookup.orderId,
  clientOrderId: "other-client",
};
assert.equal(interpret({ results: [wrongClient, absent[1]] }, lookup), null);
console.log(
  "ok - exact not_found requires complete, correctly echoed lookup results; found/conflicts are not absence",
);

const originalFetch = globalThis.fetch;
const saved = {
  limitlessHmacTokenId: env.limitlessHmacTokenId,
  limitlessHmacSecret: env.limitlessHmacSecret,
  limitlessApiBase: env.limitlessApiBase,
};
let calls = 0;
let status = 200;
let payload: unknown = { results: absent };
try {
  env.limitlessHmacTokenId = "fixture-token";
  env.limitlessHmacSecret = Buffer.from("fixture-secret").toString("base64");
  env.limitlessApiBase = "https://limitless.invalid";
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(
      String(input),
      "https://limitless.invalid/orders/status/batch",
    );
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      items: [
        { orderId: lookup.orderId },
        { clientOrderId: lookup.clientOrderId },
      ],
    });
    assert.ok(new Headers(init?.headers).has("lmts-signature"));
    return Response.json(payload, { status });
  };
  assert.deepEqual(
    await fetchLimitlessVerifiedBuyOrderStatus(lookup),
    expected,
  );
  assert.equal(calls, 1);
  assert.equal(
    (await fetchLimitlessOrderStatusBatch([lookup])).size,
    0,
    "Legacy reconciliation map still omits not_found",
  );
  assert.equal(calls, 2);
  for (const failureStatus of [408, 429, 500]) {
    status = failureStatus;
    payload = { error: "synthetic provider error" };
    const before: number = calls;
    await assert.rejects(
      fetchLimitlessVerifiedBuyOrderStatus(lookup),
      /status batch failed/,
    );
    assert.equal(
      calls,
      before + 1,
      "No rapid retry or conversion of HTTP errors into absence",
    );
  }
  status = 200;
  payload = { results: [] };
  assert.equal(await fetchLimitlessVerifiedBuyOrderStatus(lookup), null);
  const before: number = calls;
  assert.equal(await fetchLimitlessVerifiedBuyOrderStatus({}), null);
  assert.equal(calls, before);
  globalThis.fetch = async () => {
    throw new DOMException("fixture timeout", "TimeoutError");
  };
  await assert.rejects(
    fetchLimitlessVerifiedBuyOrderStatus(lookup),
    /fixture timeout/,
  );
  console.log(
    "ok - verifier status transport is one signed read-only batch, without submit, retries or legacy-map changes",
  );
} finally {
  Object.assign(env, saved);
  globalThis.fetch = originalFetch;
}
