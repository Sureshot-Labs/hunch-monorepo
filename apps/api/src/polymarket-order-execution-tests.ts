#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POLYMARKET_UNCONFIRMED_STATUS,
  canApplyPolymarketNoFillTerminalStatus,
  resolvePolymarketStoredFillSyncStatus,
  resolvePolymarketTerminalReconcileStatus,
  resolvePolymarketUnconfirmedReconcileDecision,
  resolvePolymarketUnconfirmedStatus,
  summarizePolymarketClobOrderExecution,
  summarizePolymarketOnchainOrderExecution,
  summarizePolymarketV2OnchainOrderExecution,
} from "./services/polymarket-order-execution.js";
import {
  buildNotificationPayload,
  buildOrderNotification,
} from "./services/notifications.js";

type TestCase = {
  name: string;
  run: () => void;
};

const apiSrcDir = dirname(fileURLToPath(import.meta.url));

function readApiSourceFile(...pathParts: string[]): string {
  return readFileSync(resolve(apiSrcDir, ...pathParts), "utf8");
}

const tests: TestCase[] = [
  {
    name: "summarize execution marks maker fill when remaining drops",
    run: () => {
      const summary = summarizePolymarketOnchainOrderExecution({
        makerAmount: 1_000_000n,
        remaining: 250_000n,
        isFilledOrCancelled: false,
      });
      assert.equal(summary.makerFilled, 750_000n);
      assert.equal(summary.hasExecution, true);
    },
  },
  {
    name: "v2 default empty status does not imply execution",
    run: () => {
      const summary = summarizePolymarketV2OnchainOrderExecution({
        makerAmount: 1_000_000n,
        filled: false,
        remaining: 0n,
      });
      assert.equal(summary.makerFilled, 0n);
      assert.equal(summary.remaining, 1_000_000n);
      assert.equal(summary.hasExecution, false);
    },
  },
  {
    name: "clob order status requires actual matched size or trades",
    run: () => {
      const summary = summarizePolymarketClobOrderExecution({
        associateTrades: [],
        sizeMatched: "0",
        status: "matched",
      });
      assert.equal(summary.hasExecution, false);
      assert.equal(summary.statusHint, null);
    },
  },
  {
    name: "clob order status detects positive matched size",
    run: () => {
      const summary = summarizePolymarketClobOrderExecution({
        associateTrades: [],
        sizeMatched: "2.22",
        status: "matched",
      });
      assert.equal(summary.hasExecution, true);
      assert.equal(summary.statusHint, "matched");
    },
  },
  {
    name: "clob order status preserves explicit cancelled without fill",
    run: () => {
      const summary = summarizePolymarketClobOrderExecution({
        associateTrades: [],
        sizeMatched: "0",
        status: "cancelled",
      });
      assert.equal(summary.hasExecution, false);
      assert.equal(summary.statusHint, "cancelled");
    },
  },
  {
    name: "terminal reconcile ignores matched hint without execution",
    run: () => {
      const summary = summarizePolymarketV2OnchainOrderExecution({
        makerAmount: 1_000_000n,
        filled: false,
        remaining: 0n,
      });
      const status = resolvePolymarketTerminalReconcileStatus({
        statusHint: "matched",
        hasStoredFill: false,
        executionSummary: summary,
      });
      assert.equal(status, "unmatched");
    },
  },
  {
    name: "terminal reconcile keeps matched when execution exists",
    run: () => {
      const status = resolvePolymarketTerminalReconcileStatus({
        statusHint: "matched",
        hasStoredFill: false,
        executionSummary: { hasExecution: true },
      });
      assert.equal(status, "matched");
    },
  },
  {
    name: "terminal reconcile keeps matched when stored fill exists",
    run: () => {
      const status = resolvePolymarketTerminalReconcileStatus({
        statusHint: "cancelled",
        hasStoredFill: true,
        executionSummary: null,
      });
      assert.equal(status, "matched");
    },
  },
  {
    name: "terminal reconcile closes partial fill as cancelled with close evidence",
    run: () => {
      const status = resolvePolymarketTerminalReconcileStatus({
        statusHint: "cancelled",
        hasStoredFill: true,
        storedFillKind: "partial",
        executionSummary: null,
      });
      assert.equal(status, "cancelled");
    },
  },
  {
    name: "terminal reconcile closes partial fill as expired with expired evidence",
    run: () => {
      const status = resolvePolymarketTerminalReconcileStatus({
        statusHint: null,
        hasStoredFill: true,
        storedFillKind: "partial",
        executionSummary: null,
        noFillStatus: "expired",
      });
      assert.equal(status, "expired");
    },
  },
  {
    name: "terminal reconcile does not close partial fill without terminal evidence",
    run: () => {
      const status = resolvePolymarketTerminalReconcileStatus({
        statusHint: null,
        hasStoredFill: true,
        storedFillKind: "partial",
        executionSummary: null,
      });
      assert.equal(status, null);
    },
  },
  {
    name: "terminal reconcile respects explicit cancelled no-fill hint",
    run: () => {
      const status = resolvePolymarketTerminalReconcileStatus({
        statusHint: "cancelled",
        hasStoredFill: false,
        executionSummary: { hasExecution: false },
      });
      assert.equal(status, "cancelled");
    },
  },
  {
    name: "terminal reconcile maps explicit expired no-fill status",
    run: () => {
      const status = resolvePolymarketTerminalReconcileStatus({
        statusHint: null,
        hasStoredFill: false,
        executionSummary: { hasExecution: false },
        noFillStatus: "expired",
      });
      assert.equal(status, "expired");
    },
  },
  {
    name: "stored fill sync promotes unconfirmed FOK fill to matched",
    run: () => {
      const status = resolvePolymarketStoredFillSyncStatus({
        currentStatus: POLYMARKET_UNCONFIRMED_STATUS,
        orderType: "FOK",
        filledSize: "1.23",
        orderSize: "1.23",
      });
      assert.equal(status, "matched");
    },
  },
  {
    name: "stored fill sync keeps unconfirmed when no fill exists",
    run: () => {
      const status = resolvePolymarketStoredFillSyncStatus({
        currentStatus: POLYMARKET_UNCONFIRMED_STATUS,
        orderType: "FOK",
        filledSize: "0",
        orderSize: "1.23",
      });
      assert.equal(status, POLYMARKET_UNCONFIRMED_STATUS);
    },
  },
  {
    name: "stored fill sync promotes previous terminal no-fill status when fill exists",
    run: () => {
      for (const currentStatus of [
        "cancelled",
        "expired",
        "unmatched",
        POLYMARKET_UNCONFIRMED_STATUS,
      ]) {
        const status = resolvePolymarketStoredFillSyncStatus({
          currentStatus,
          orderType: "FOK",
          filledSize: "1.23",
          orderSize: "1.23",
        });
        assert.equal(status, "matched");
      }
    },
  },
  {
    name: "stored fill sync preserves cancelled partial fills",
    run: () => {
      const status = resolvePolymarketStoredFillSyncStatus({
        currentStatus: "cancelled",
        cancelledAt: "2026-05-28T12:00:00.000Z",
        orderType: "GTC",
        filledSize: "1.23",
        orderSize: "5",
      });
      assert.equal(status, "cancelled");
    },
  },
  {
    name: "no-fill terminal reconcile is blocked by matched status",
    run: () => {
      assert.equal(
        canApplyPolymarketNoFillTerminalStatus({
          currentStatus: "matched",
          hasPositiveFillRows: false,
        }),
        false,
      );
    },
  },
  {
    name: "no-fill terminal reconcile is blocked by terminal fill statuses",
    run: () => {
      for (const currentStatus of ["filled", "partially_filled"]) {
        assert.equal(
          canApplyPolymarketNoFillTerminalStatus({
            currentStatus,
            hasPositiveFillRows: false,
          }),
          false,
        );
      }
    },
  },
  {
    name: "no-fill terminal reconcile is blocked by positive fill rows",
    run: () => {
      assert.equal(
        canApplyPolymarketNoFillTerminalStatus({
          currentStatus: POLYMARKET_UNCONFIRMED_STATUS,
          hasPositiveFillRows: true,
        }),
        false,
      );
    },
  },
  {
    name: "no-fill terminal reconcile is blocked by terminal no-fill statuses",
    run: () => {
      for (const currentStatus of [
        "cancelled",
        "expired",
        "unmatched",
        "rejected",
      ]) {
        assert.equal(
          canApplyPolymarketNoFillTerminalStatus({
            currentStatus,
            hasPositiveFillRows: false,
          }),
          false,
        );
      }
    },
  },
  {
    name: "no-fill terminal reconcile can update unconfirmed no-fill orders",
    run: () => {
      assert.equal(
        canApplyPolymarketNoFillTerminalStatus({
          currentStatus: POLYMARKET_UNCONFIRMED_STATUS,
          hasPositiveFillRows: false,
        }),
        true,
      );
    },
  },
  {
    name: "unmatched order notification is not submitted or filled",
    run: () => {
      const notification = buildOrderNotification({
        userId: "user-1",
        venue: "polymarket",
        status: "unmatched",
        side: "BUY",
        size: 10,
        price: 0.5,
        orderId: "order-1",
      });
      assert.equal(notification.type, "order_failed");
      assert.equal(notification.title, "Order not filled");
      assert.equal(notification.severity, "warning");
    },
  },
  {
    name: "expired order notification is terminal and readable",
    run: () => {
      const notification = buildOrderNotification({
        userId: "user-1",
        venue: "polymarket",
        status: "expired",
        side: "BUY",
        size: 10,
        price: 0.5,
        orderId: "order-1",
      });
      assert.equal(notification.type, "order_failed");
      assert.equal(notification.title, "Order expired");
      assert.equal(notification.severity, "warning");
    },
  },
  {
    name: "order notification does not render null price text",
    run: () => {
      const notification = buildOrderNotification({
        userId: "user-1",
        venue: "polymarket",
        status: "matched",
        side: "SELL",
        size: 0,
        price: "null",
        orderId: "order-1",
      });
      assert.equal(notification.type, "order_filled");
      assert.equal(notification.title, "Order filled");
      assert.equal(notification.body, "Polymarket SELL");
      const data = notification.data as { size: number | null; price: number | null };
      assert.equal(data.size, null);
      assert.equal(data.price, null);
    },
  },
  {
    name: "order notification formats numeric string size and price",
    run: () => {
      const notification = buildOrderNotification({
        userId: "user-1",
        venue: "polymarket",
        status: "matched",
        side: "SELL",
        size: "2.22",
        price: "0.43",
        orderId: "order-1",
      });
      assert.equal(notification.type, "order_filled");
      assert.equal(notification.body, "Polymarket SELL 2.22 @ $0.43");
      const data = notification.data as { size: number | null; price: number | null };
      assert.equal(data.size, 2.22);
      assert.equal(data.price, 0.43);
    },
  },
  {
    name: "order notification formats price when size is zero",
    run: () => {
      const notification = buildOrderNotification({
        userId: "user-1",
        venue: "polymarket",
        status: "matched",
        side: "SELL",
        size: "0",
        price: "0.89",
        orderId: "order-1",
      });
      assert.equal(notification.type, "order_filled");
      assert.equal(notification.body, "Polymarket SELL @ $0.89");
      const data = notification.data as { size: number | null; price: number | null };
      assert.equal(data.size, null);
      assert.equal(data.price, 0.89);
    },
  },
  {
    name: "legacy order notification payload repairs null price body",
    run: () => {
      const createdAt = new Date("2026-05-28T12:00:00.000Z");
      const payload = buildNotificationPayload({
        id: "notification-1",
        type: "order_filled",
        title: "Order filled",
        body: "Polymarket BUY @ null",
        severity: "success",
        data: {
          venue: "polymarket",
          status: "matched",
          side: "BUY",
          size: "2.22",
          price: "0.43",
          orderId: "order-1",
        },
        read_at: null,
        created_at: createdAt,
      });
      assert.equal(payload.body, "Polymarket BUY 2.22 @ $0.43");
    },
  },
  {
    name: "legacy order notification payload repairs null price with zero size",
    run: () => {
      const createdAt = new Date("2026-05-28T12:00:00.000Z");
      const payload = buildNotificationPayload({
        id: "notification-1",
        type: "order_filled",
        title: "Order filled",
        body: "Polymarket SELL @ null",
        severity: "success",
        data: {
          venue: "polymarket",
          status: "matched",
          side: "SELL",
          size: "0",
          price: "0.89",
          orderId: "order-1",
        },
        read_at: null,
        created_at: createdAt,
      });
      assert.equal(payload.body, "Polymarket SELL @ $0.89");
    },
  },
  {
    name: "unconfirmed stays unconfirmed when order is still live",
    run: () => {
      const resolution = resolvePolymarketUnconfirmedStatus({
        hasExecution: false,
        isFilledOrCancelled: false,
      });
      assert.equal(resolution, POLYMARKET_UNCONFIRMED_STATUS);
    },
  },
  {
    name: "unconfirmed resolves to unmatched when cancelled with no fill",
    run: () => {
      const resolution = resolvePolymarketUnconfirmedStatus({
        hasExecution: false,
        isFilledOrCancelled: true,
      });
      assert.equal(resolution, "unmatched");
    },
  },
  {
    name: "unconfirmed execution requests fill sync instead of direct matched",
    run: () => {
      const decision = resolvePolymarketUnconfirmedReconcileDecision({
        hasExecution: true,
        isFilledOrCancelled: true,
      });
      assert.equal(decision, "sync_for_fill");
    },
  },
  {
    name: "legacy unconfirmed status keeps execution pending for fill sync",
    run: () => {
      const resolution = resolvePolymarketUnconfirmedStatus({
        hasExecution: true,
        isFilledOrCancelled: true,
      });
      assert.equal(resolution, POLYMARKET_UNCONFIRMED_STATUS);
    },
  },
  {
    name: "fill sync insert has database duplicate safety net",
    run: () => {
      const source = readApiSourceFile("services", "positions-sync.ts");
      assert.match(source, /on conflict do nothing/);
      assert.match(source, /returning order_id, venue_fill_id/);
      assert.match(source, /persistedFillKeys/);
    },
  },
  {
    name: "fill sync repairs replayed persisted fills",
    run: () => {
      const source = readApiSourceFile("services", "positions-sync.ts");
      assert.match(source, /persistedCandidateFills/);
      assert.match(source, /join order_fills f/);
      assert.match(source, /persistedBuilderFeeAccruals/);
      assert.match(source, /insertVolumeEventsWithMultiplierInTx/);
    },
  },
  {
    name: "plain not found cancel reasons enter closed-order reconcile",
    run: () => {
      const source = readApiSourceFile("routes", "polymarket-private.ts");
      assert.match(source, /normalized\.includes\("not found"\)/);
    },
  },
  {
    name: "fill dedupe migration creates a concurrent partial unique index",
    run: () => {
      const source = readApiSourceFile(
        "..",
        "..",
        "..",
        "packages",
        "db",
        "migrations",
        "0155_order_fills_dedupe_index.sql",
      ).toLowerCase();
      assert.match(source, /\/\* no-transaction \*\//);
      assert.match(source, /create unique index concurrently/);
      assert.match(source, /on order_fills\(order_id, venue_fill_id\)/);
      assert.match(source, /where venue_fill_id is not null/);
    },
  },
];

let passed = 0;
for (const test of tests) {
  test.run();
  passed += 1;
  console.log(`[polymarket-order-execution-tests] ok ${test.name}`);
}

console.log(
  `[polymarket-order-execution-tests] passed ${passed}/${tests.length}`,
);
