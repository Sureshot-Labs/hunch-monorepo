import assert from "node:assert/strict";
import test from "node:test";
import {
  orderReadRouteSchemas,
  ordersReadResponseSchema,
} from "./schemas/orders.js";
import { zVenue } from "./schemas/common.js";
import {
  mapUnifiedOrder,
  type UnifiedOrderRow,
} from "./repos/unified-orders.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";

test("shared History accepts legacy nullable venue/date and retains error metadata", () => {
  const routes = orderReadRouteSchemas({ defaultLimit: 7, maxLimit: 19 });
  assert.equal(routes["/orders"].querystring.parse({}).limit, 7);
  assert.equal(routes["/orders"].querystring.parse({ limit: 100 }).limit, 19);
  assert.equal(
    routes["/orders"].querystring.parse({
      venue: "hyperliquid",
      type: "execution",
    }).type,
    "execution",
  );
  assert.equal(zVenue.safeParse("hyperliquid").success, false);
  const order = mapUnifiedOrder({
    id: "legacy",
    kind: "order",
    venue: null,
    created_at: new Date(0),
  } as unknown as UnifiedOrderRow);
  const output = ordersReadResponseSchema.parse({
    orders: [order],
    pagination: { total: 1, limit: 7, offset: 0, hasMore: false },
  });
  assert.equal(output.orders[0].venue, null);
  assert.equal(output.orders[0].createdAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(
    routes["/orders"].response[400].parse({
      error: "Bad Request",
      code: "validation",
      message: "details",
    }),
    { error: "Bad Request", code: "validation", message: "details" },
  );
});
test("observed fills preserve exact financial facts without inventing order size or authority", () => {
  const facts = projectHip4Execution("mainnet", `0x${"1".repeat(40)}`, {
    coin: "#87751",
    px: "0",
    sz: "2.12345",
    side: "A",
    time: 123,
    dir: "Settlement",
    startPosition: "2.12345",
    closedPnl: "-1.12345678",
    hash: `0x${"2".repeat(64)}`,
    oid: 7,
    tid: 9,
    crossed: false,
    fee: "-0.00000001",
    feeToken: "USDC",
  });
  const row = {
    id: `hyperliquid:${facts.id}`,
    kind: "execution",
    observed_execution: facts,
    wallet_address: `0x${"1".repeat(40)}`,
  } as UnifiedOrderRow;
  const mapped = mapUnifiedOrder(row);
  assert.ok("execution" in mapped && mapped.execution);
  assert.deepEqual(mapped.execution, facts);
  assert.equal(mapped.size, null);
  assert.equal(mapped.status, "observed");
  assert.equal(mapped.actionRef, null);
  assert.equal(mapped.outcome, "NO");
  assert.equal(mapped.averageFillPrice, 0);
  assert.throws(
    () =>
      mapUnifiedOrder({
        ...row,
        observed_execution: {
          ...facts,
          marketId: "hyperliquid:testnet:outcome:8775",
        },
      }),
    /identity_conflict/,
  );
});
