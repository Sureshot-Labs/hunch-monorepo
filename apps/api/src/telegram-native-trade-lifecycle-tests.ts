import assert from "node:assert/strict";
import { test } from "node:test";
import {
  telegramNativeLifecycleAmount,
  telegramNativeLifecycleOrderState,
  telegramNativeLifecycleSnapshot,
  telegramNativeLifecycleText,
  type TelegramNativeLifecycle,
} from "./services/telegram-native-trade-lifecycle.js";

const snapshot: TelegramNativeLifecycle = {
  quantity: "7",
  debitCapRaw: "123456789",
  side: "BUY",
  submissionBoundaryCrossed: true,
  order: {
    status: "cancelled",
    terminal: true,
    nativeOrder: {
      submissionState: "submission_started",
      nativeStatus: "canceled",
      terminalConfirmed: true,
      terminalObservedAt: "2026-10-16T12:00:00Z",
      filledQuantity: "3",
      fullQuantityObserved: false,
      executionSummary: {
        version: 1,
        source: "hyperliquid_user_fills",
        quantity: "3",
        grossNotional: "1.11223344",
        fee: null,
        feeToken: null,
        netQuoteCash: null,
        executionCount: 1,
        fullQuantityObserved: false,
      },
      fillHistoryCoverage: "not_asserted",
    },
  },
};
const render = (nativeTrade: TelegramNativeLifecycle, state: string) =>
  telegramNativeLifecycleText({
    nativeTrade,
    state,
    marketTitle: "A [market]",
    sideLabel: "NO",
  });

test("native lifecycle keeps partial IOC cancellation distinct from no submission", () => {
  assert.equal(telegramNativeLifecycleOrderState(snapshot), "cancelled");
  const text = render(snapshot, "cancelled");
  assert.match(text, /Order closed/u);
  assert.match(text, /Recorded contracts filled.*3/u);
  assert.match(text, /Recorded fee.*Unavailable/u);
  assert.match(text, /complete fill history is not asserted/u);
  assert.doesNotMatch(
    text,
    /No order was submitted|successfully|before order submission/u,
  );
  assert.equal(telegramNativeLifecycleAmount(snapshot), "1.23456789");
});

test("native SELL uses outcome5 and never the legacy USD6 shares conversion", () => {
  const sell = { ...snapshot, side: "SELL" as const, debitCapRaw: "700000" };
  assert.equal(telegramNativeLifecycleAmount(sell), "7.0");
  assert.match(render(sell, "cancelled"), /Maximum contracts sold.*7\\\.0/u);
  assert.doesNotMatch(render(sell, "cancelled"), /0\\\.7 shares|7\\\.0 USDC/u);
});

test("official filled status alone, stale full flags and unknown history are not full execution", () => {
  assert.ok(snapshot.order);
  const order = { ...snapshot.order, status: "filled" };
  assert.equal(
    telegramNativeLifecycleOrderState({ ...snapshot, order }),
    "confirming_trade",
  );
  assert.equal(
    telegramNativeLifecycleOrderState({
      ...snapshot,
      order: {
        ...order,
        nativeOrder: {
          ...order.nativeOrder,
          fullQuantityObserved: true,
          executionSummary: null,
        },
      },
    }),
    "confirming_trade",
  );
  assert.equal(
    telegramNativeLifecycleOrderState({ ...snapshot, order: null }),
    "confirming_trade",
  );
  const unknown = {
    ...snapshot,
    order: {
      ...snapshot.order,
      nativeOrder: {
        ...snapshot.order.nativeOrder,
        filledQuantity: null,
        executionSummary: null,
      },
    },
  };
  assert.match(
    render(unknown, "cancelled"),
    /Recorded contracts filled.*Not yet available/u,
  );
  assert.doesNotMatch(render(unknown, "cancelled"), /No order was submitted/u);
});

test("full current canonical summary and official terminal result together finish the card", () => {
  assert.ok(snapshot.order?.nativeOrder.executionSummary);
  const complete = {
    ...snapshot,
    order: {
      ...snapshot.order,
      status: "filled",
      nativeOrder: {
        ...snapshot.order.nativeOrder,
        fullQuantityObserved: true,
        executionSummary: {
          ...snapshot.order.nativeOrder.executionSummary,
          fullQuantityObserved: true,
        },
      },
    },
  };
  assert.equal(telegramNativeLifecycleOrderState(complete), "filled");
  assert.match(render(complete, "filled"), /full order quantity is confirmed/u);
  assert.equal(
    telegramNativeLifecycleOrderState({
      ...complete,
      order: { ...complete.order, terminal: false },
    }),
    "confirming_trade",
  );
});

test("a genuine before-submit cancellation does not manufacture execution or fill facts", () => {
  const unsubmitted = {
    ...snapshot,
    submissionBoundaryCrossed: false,
    order: null,
  };
  assert.equal(telegramNativeLifecycleOrderState(unsubmitted), null);
  assert.match(
    render(unsubmitted, "cancelled"),
    /cancelled before order submission/u,
  );
  assert.doesNotMatch(
    render(unsubmitted, "cancelled"),
    /Recorded contracts filled/u,
  );
  const missing = telegramNativeLifecycleSnapshot({
    action: "buy",
    result: {},
    orderId: null,
    submitStartedAt: null,
    order: null,
  });
  assert.equal(missing.quantity, null);
  assert.equal(telegramNativeLifecycleAmount(missing), null);
  assert.match(render(unsubmitted, "quote_expired"), /Quote expired/u);
  assert.match(
    render(unsubmitted, "quote_expired"),
    /expired before order submission/u,
  );
  assert.doesNotMatch(
    render(unsubmitted, "quote_expired"),
    /checking the original order|Do not submit a replacement/u,
  );
});
