import assert from "node:assert/strict";
import test from "node:test";
import { projectHip4OpenOrders } from "./services/hip4-open-orders.js";
import {
  mapUnifiedOrder,
  type UnifiedOrderRow,
} from "./repos/unified-orders.js";

const wire = {
  coin: "#87751",
  oid: 70,
  side: "B",
  limitPx: "0.4",
  sz: "3.00001",
  origSz: "5",
  timestamp: 1000,
  orderType: "Limit",
  isTrigger: false,
  reduceOnly: false,
};
test("native open order snapshot preserves exact quantities and distinct observation provenance", () => {
  const result = projectHip4OpenOrders(
    "mainnet",
    [wire, { coin: "BTC" }],
    2000,
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].filledQuantity, "1.99999");
  assert.equal(result.items[0].tokenId, "hyperliquid:mainnet:87751");
  const output = mapUnifiedOrder({
    kind: "observed_order",
    id: "native",
    wallet_address: "owner",
    observed_execution: result.items[0],
    updated_at: new Date(2000),
    expires_at: new Date(62000),
  } as UnifiedOrderRow);
  assert.equal(output.kind, "observed_order");
  assert.equal(output.status, "observed_open");
  assert.equal(output.averageFillPrice, null);
  assert.equal(output.actionRef, null);
  assert.equal(output.createdAt, new Date(1000).toISOString());
  assert.equal(
    projectHip4OpenOrders("testnet", [wire], 2000).items[0].marketId,
    "hyperliquid:testnet:outcome:8775",
  );
});
test("partial, duplicate, unsafe or inconsistent open orders are not turned into an authoritative empty list", () => {
  assert.deepEqual(projectHip4OpenOrders("mainnet", [], 2000).items, []);
  for (const rows of [
    [wire, wire],
    [{ ...wire, sz: "6" }],
    [{ ...wire, timestamp: 3000 }],
    [{ ...wire, oid: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...wire, limitPx: "1.1" }],
    [{ ...wire, sz: "1.000001" }],
    [{ ...wire, cloid: "not-a-client-order-id" }],
    [{ coin: wire.coin }],
  ]) {
    assert.throws(() => projectHip4OpenOrders("mainnet", rows, 2000));
  }
});
test("open orders retain normalized exact CLOID while legacy and manual orders remain compatible", () => {
  for (const cloid of [undefined, null, `0x${"AB".repeat(16)}`]) {
    const item = projectHip4OpenOrders("mainnet", [{ ...wire, cloid }], 2000)
      .items[0];
    assert.equal(item.cloid, cloid?.toLowerCase() ?? null);
  }
});
