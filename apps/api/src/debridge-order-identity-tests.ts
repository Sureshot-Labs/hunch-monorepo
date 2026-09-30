import assert from "node:assert/strict";
import {
  extractDebridgeOrderIds,
  uniqueDebridgeSourceOrderId,
} from "./services/debridge-order-identity.js";

const actual = `0x${"a".repeat(64)}`;
const stale = `0x${"b".repeat(64)}`;
// Anonymized historical Stats DTO. Its actual stringValue differs from the
// well-formed ID retained from a pre-submission quote.
const dto = {
  orderIds: [
    {
      stringValue: actual,
      bytesValue: "base64-byte-representation",
      bigIntegerValue: null,
    },
  ],
};
assert.deepEqual(extractDebridgeOrderIds(dto), [actual]);
assert.equal(uniqueDebridgeSourceOrderId(dto), actual);
assert.notEqual(uniqueDebridgeSourceOrderId(dto), stale);
assert.deepEqual(
  extractDebridgeOrderIds({
    orderIds: [actual.toUpperCase().replace("0X", "0x"), actual],
  }),
  [actual],
);
assert.equal(uniqueDebridgeSourceOrderId({ orderIds: [actual, stale] }), null);
assert.equal(
  uniqueDebridgeSourceOrderId({
    orderIds: [
      actual,
      { stringValue: stale, bytesValue: `0x${"c".repeat(64)}` },
    ],
  }),
  null,
);
assert.equal(
  uniqueDebridgeSourceOrderId({ orderIds: [actual, { id: stale }] }),
  null,
);
assert.deepEqual(
  extractDebridgeOrderIds({
    orderIds: [{ stringValue: actual, bytesValue: stale }],
  }),
  [],
);
for (const payload of [
  null,
  {},
  { orderIds: [] },
  { orderIds: ["not-an-id", { id: actual }, { stringValue: "../../orders" }] },
]) {
  assert.deepEqual(extractDebridgeOrderIds(payload), []);
}
console.log(
  "[debridge-order-identity-tests] DTO identity, legacy strings, conflict and ambiguity passed",
);
