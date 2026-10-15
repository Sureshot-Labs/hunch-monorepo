import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import { createHip4AccountClient } from "./services/hip4-client.js";
import {
  interpretHip4ExactOrderStatus as status,
  interpretHip4ExactOrderFills as fills,
  advanceHip4OrderBalanceBarrier as barrier,
  classifyHip4NativeOrderStatus,
} from "./services/hip4-order-evidence.js";
import type { Hip4TradeSigningInput } from "./services/hip4-trade-signing.js";
import { planHip4OrderFillRepair } from "./services/hip4-order-fill-repair.js";
import { advanceHip4FillRepair } from "./services/hip4-account-history.js";

test("native acceptance taxonomy distinguishes cancellation from placement rejection", () => {
  for (const status of [
    "open",
    "filled",
    "canceled",
    "scheduledCancel",
    "delistedCanceled",
    "selfTradeCanceled",
    "outcomeSettledCanceled",
    "internalCancel",
  ])
    assert.equal(classifyHip4NativeOrderStatus(status), "accepted");
  for (const status of [
    "rejected",
    "tickRejected",
    "minTradeNtlRejected",
    "badAloPxRejected",
    "iocCancelRejected",
    "marketOrderNoLiquidityRejected",
    "insufficientSpotBalanceRejected",
    "tooManyOpenOrdersRejected",
  ])
    assert.equal(classifyHip4NativeOrderStatus(status), "rejected");
  assert.equal(classifyHip4NativeOrderStatus("futureCanceled"), "unknown");
});

test("terminal balance barrier is separate from history and cannot survive a contradiction without a new read", () => {
  const first = barrier({
    previous: null,
    exactTerminal: true,
    statusError: null,
    responseAt: 100,
  });
  assert.deepEqual(first, { state: "terminal_observed", responseAt: 100 });
  assert.deepEqual(
    barrier({
      previous: first,
      exactTerminal: true,
      statusError: null,
      responseAt: 200,
    }),
    first,
  );
  assert.deepEqual(
    barrier({
      previous: first,
      exactTerminal: false,
      statusError: "order_not_observed",
      responseAt: 200,
    }),
    first,
  );
  const invalid = barrier({
    previous: first,
    exactTerminal: false,
    statusError: "order_status_regression",
    responseAt: 200,
  });
  assert.deepEqual(invalid, { state: "invalidated", responseAt: 100 });
  assert.deepEqual(
    barrier({
      previous: invalid,
      exactTerminal: false,
      statusError: "order_not_observed",
      responseAt: 300,
    }),
    invalid,
  );
  assert.deepEqual(
    barrier({
      previous: invalid,
      exactTerminal: true,
      statusError: null,
      responseAt: 400,
    }),
    { state: "terminal_observed", responseAt: 400 },
  );
  assert.equal(
    barrier({
      previous: { state: "terminal_observed", responseAt: "100" },
      exactTerminal: false,
      statusError: "order_not_observed",
      responseAt: 300,
    }),
    null,
  );
  assert.equal(
    barrier({
      previous: null,
      exactTerminal: false,
      statusError: null,
      responseAt: 300,
    }),
    null,
  );
});

test("open-order inclusion keeps its first exact read, invalidates contradictions and advances on terminal transition", () => {
  const observe = (
    previous: unknown,
    responseAt: number,
    statusError: string | null = null,
  ) =>
    barrier({
      previous,
      responseAt,
      statusError,
      exactTerminal: false,
      exactOpen: true,
    });
  const first = observe(null, 100);
  assert.deepEqual(first, { state: "accepted_observed", responseAt: 100 });
  assert.deepEqual(observe(first, 200), first);
  assert.deepEqual(observe(first, 200, "order_not_observed"), first);
  const invalid = observe(first, 200, "order_identity_conflict");
  assert.deepEqual(invalid, { state: "invalidated", responseAt: 100 });
  assert.deepEqual(observe(invalid, 300, "order_not_observed"), invalid);
  assert.deepEqual(observe(invalid, 400), {
    state: "accepted_observed",
    responseAt: 400,
  });
  assert.deepEqual(
    barrier({
      previous: first,
      responseAt: 500,
      exactTerminal: true,
      statusError: null,
    }),
    { state: "terminal_observed", responseAt: 500 },
    "completion uses a new barrier, not the earlier acceptance timestamp",
  );
});

test("admitted order fill repair resumes its fixed range beyond the ordinary account lookback", () => {
  const initial = planHip4OrderFillRepair(null, 1000, 9000000000, 4);
  assert.equal(initial.startTime, 1000);
  assert.equal(initial.endTime, 9000000000);
  const page = Array.from({ length: 2000 }, (_, i) => ({
    coin: "OTHER",
    time: 2000 + i,
  }));
  const next = advanceHip4FillRepair(
    initial,
    page,
    new Date(9000000000).toISOString(),
    4,
  );
  assert.equal(next.nextTime, 3999);
  const resumed = planHip4OrderFillRepair(next, 1000, 9000000500, 4);
  assert.equal(resumed.nextTime, 3999);
  assert.equal(resumed.endTime, initial.endTime);
  const exhausted = advanceHip4FillRepair(
    resumed,
    [],
    new Date(9000000500).toISOString(),
    4,
  );
  const replay = planHip4OrderFillRepair(exhausted, 1000, 9000001000, 4);
  assert.equal(
    replay.nextTime,
    1000,
    "provider exhaustion does not rule out late indexing",
  );
  assert.equal(replay.providerRetentionLimited, true);
  assert.equal(
    planHip4OrderFillRepair({ ...next, nextTime: 999 }, 1000, 9000000500, 4)
      .nextTime,
    1000,
  );
});

const address = `0x${"ab".repeat(20)}`;
const cloid = `0x${"cd".repeat(16)}`;
const envelope = (buy = true): Hip4TradeSigningInput => ({
  environment: "mainnet",
  nonce: 1000,
  expiresAfter: 60000,
  vaultAddress: null,
  action: {
    type: "order",
    grouping: "na",
    orders: [
      {
        a: 100014731,
        b: buy,
        p: "0.5",
        s: "4",
        r: false,
        t: { limit: { tif: "Gtc" } },
        c: cloid,
      },
    ],
  },
});
const body = () => ({
  status: "order",
  order: {
    status: "open",
    statusTimestamp: 1200,
    order: {
      coin: "#14731",
      oid: 12345,
      cloid,
      side: "B",
      limitPx: "0.50000",
      sz: "4",
      origSz: "4",
      timestamp: 1100,
      orderType: "Limit",
      reduceOnly: false,
      tif: "Gtc",
      isTrigger: false,
      isPositionTpsl: false,
    },
  },
});
const fill = (tid = 1) => ({
  coin: "#14731",
  oid: 12345,
  cloid,
  side: "B",
  px: "0.49",
  sz: "2",
  time: 1200,
  tid,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"ef".repeat(32)}`,
  crossed: false,
  fee: "0",
  feeToken: "USDC",
});
const interpret = (entries: unknown[], buy = true) =>
  fills({
    envelope: envelope(buy),
    accountAddress: address,
    orderId: "12345",
    fills: entries,
  });

test("native exact status accepts only the frozen coin/cloid/side/size/limit and known OID", () => {
  const result = status({
    envelope: envelope(),
    body: body(),
    knownOrderId: "12345",
  });
  assert.equal(result.kind, "observed");
  if (result.kind !== "observed") return;
  assert.equal(result.terminal, false);
  assert.equal(result.executionQuantityRaw, null);
  for (const patch of [
    { coin: "#14730" },
    { cloid: `0x${"ab".repeat(16)}` },
    { side: "A" },
    { limitPx: "0.51" },
    { origSz: "5" },
    { sz: "5" },
    { reduceOnly: true },
    { tif: "Ioc" },
    { isTrigger: true },
    { isTrigger: "true" },
    { isPositionTpsl: true },
    { oid: 12346 },
  ]) {
    const response = body();
    Object.assign(response.order.order, patch);
    assert.equal(
      status({ envelope: envelope(), body: response, knownOrderId: "12345" })
        .kind,
      "pending",
    );
  }
});
test("cancelled remaining quantity and unknownOid never manufacture filled quantity or no-fill authority", () => {
  for (const state of [
    "canceled",
    "filled",
    "iocCancelRejected",
    "outcomeSettledCanceled",
    "internalCancel",
    "tooManyOpenOrdersRejected",
  ]) {
    const response = body();
    response.order.status = state;
    response.order.order.sz = "0";
    const result = status({
      envelope: envelope(),
      body: response,
      knownOrderId: null,
    });
    assert.equal(result.kind, "observed");
    if (result.kind === "observed") {
      assert.equal(result.terminal, true);
      assert.equal(result.executionQuantityRaw, null);
    }
  }
  for (const response of [
    { status: "unknownOid" },
    {},
    { status: "order", order: { ...body().order, status: "futureStatus" } },
  ])
    assert.equal(
      status({ envelope: envelope(), body: response, knownOrderId: null }).kind,
      "pending",
    );
});
test("native fill replay deduplicates same economic fact, preserving exact P2 projection", () => {
  const result = interpret([
    fill(),
    { ...fill(), px: "0.49000", futureMetadata: "ignored" },
    fill(2),
  ]);
  assert.equal(result.kind, "observed");
  if (result.kind !== "observed") return;
  assert.equal(result.quantityRaw, "400000");
  assert.equal(result.fullQuantityObserved, true);
  assert.equal(result.executions.length, 2);
  assert.equal(result.executions[0].grossNotional, "0.98");
  assert.equal(result.executions[0].netQuoteCash, "-0.98");
  assert.equal(result.historyCoverage, "not_asserted");
});
test("native fills reject conflicts, opposite leg, settlement, excess quantity and adverse price", () => {
  for (const patch of [
    { coin: "#14730" },
    { oid: 1 },
    { side: "A" },
    { cloid: `0x${"00".repeat(16)}` },
    { dir: "Settlement" },
    { sz: "0" },
    { sz: "5" },
    { px: "0.51" },
    { px: "1" },
    { px: "0" },
    { startPosition: "0.000001" },
    { time: 999 },
  ])
    assert.equal(interpret([{ ...fill(), ...patch }]).kind, "pending");
  for (const patch of [
    { fee: "0.01" },
    { px: "0.48" },
    { sz: "1" },
    { startPosition: "1" },
  ])
    assert.equal(interpret([fill(), { ...fill(), ...patch }]).kind, "pending");
});
test("exact status rejects a reused cloid outside the frozen submission time envelope", () => {
  for (const time of [999, 60001]) {
    const response = body();
    response.order.order.timestamp = time;
    response.order.statusTimestamp = time;
    assert.equal(
      status({ envelope: envelope(), body: response, knownOrderId: null }).kind,
      "pending",
    );
  }
});
test("partial/empty history is not complete; unknown denomination remains null and SELL rebate stays signed", () => {
  for (const entries of [[], [fill()]]) {
    const result = interpret(entries);
    assert.equal(result.kind, "observed");
    if (result.kind === "observed") {
      assert.equal(result.fullQuantityObserved, false);
      assert.equal(result.historyCoverage, "not_asserted");
    }
  }
  const unknown = interpret([{ ...fill(), feeToken: "UNKNOWN", fee: "0.01" }]);
  assert.equal(unknown.kind, "observed");
  if (unknown.kind === "observed")
    assert.equal(unknown.executions[0].netQuoteCash, null);
  const sell = interpret(
    [{ ...fill(), side: "A", dir: "Sell", px: "0.6", fee: "-0.00001" }],
    false,
  );
  assert.equal(sell.kind, "observed");
  if (sell.kind === "observed") {
    assert.equal(sell.executions[0].fee, "-0.00001");
    assert.equal(sell.executions[0].netQuoteCash, "1.20001");
  }
  assert.equal(
    interpret([{ ...fill(), side: "A", dir: "Sell", px: "0.4" }], false).kind,
    "pending",
  );
});
test("exact orderStatus uses documented weight 2 and rejects invalid identity before admission", async () => {
  const weights: number[] = [],
    requests: unknown[] = [];
  const client = createHip4AccountClient(
    DEFAULT_HIP4_READ_POLICY,
    async (weight) => {
      weights.push(weight);
      return true;
    },
    async (url, options) => {
      assert.equal(url, "https://api.hyperliquid.xyz/info");
      requests.push(JSON.parse(String(options?.body)));
      return Response.json({ status: "unknownOid" });
    },
  );
  await client({ type: "orderStatus", user: address, oid: cloid });
  await client({ type: "orderStatus", user: address, oid: 12345 });
  assert.deepEqual(weights, [2, 2]);
  assert.deepEqual(requests[0], {
    type: "orderStatus",
    user: address,
    oid: cloid,
  });
  for (const oid of [
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "12345",
    "0x1234",
    "#14731",
  ])
    await assert.rejects(
      client({ type: "orderStatus", user: address, oid }),
      /invalid_response/u,
    );
  assert.equal(weights.length, 2);
});
