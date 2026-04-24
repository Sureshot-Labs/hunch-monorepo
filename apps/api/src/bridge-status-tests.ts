#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  canonicalizeBridgeOrderStatus,
  getBridgeNotificationStatus,
  isTerminalBridgeOrderStatus,
} from "./services/bridge-status.js";
import { buildBridgeNotification } from "./services/notifications.js";

assert.equal(canonicalizeBridgeOrderStatus("filled"), "fulfilled");
assert.equal(canonicalizeBridgeOrderStatus("Fulfilled"), "fulfilled");
assert.equal(canonicalizeBridgeOrderStatus("SentUnlock"), "fulfilled");
assert.equal(canonicalizeBridgeOrderStatus("ClaimedUnlock"), "fulfilled");
assert.equal(getBridgeNotificationStatus("filled"), "completed");

assert.equal(canonicalizeBridgeOrderStatus("refunded"), "refunded");
assert.equal(canonicalizeBridgeOrderStatus("canceled"), "refunded");
assert.equal(canonicalizeBridgeOrderStatus("ClaimedOrderCancel"), "refunded");
assert.equal(getBridgeNotificationStatus("refunded"), "refunded");
assert.equal(isTerminalBridgeOrderStatus("refunded"), true);

assert.equal(canonicalizeBridgeOrderStatus("OrderCancelled"), "submitted");
assert.equal(canonicalizeBridgeOrderStatus("SentOrderCancel"), "submitted");
assert.equal(getBridgeNotificationStatus("OrderCancelled"), null);
assert.equal(isTerminalBridgeOrderStatus("OrderCancelled"), false);

assert.equal(getBridgeNotificationStatus("expired"), "failed");
assert.equal(getBridgeNotificationStatus("failed"), "failed");

const refunded = buildBridgeNotification({
  userId: "user-1",
  provider: "across",
  status: "refunded",
  srcChainId: "137",
  dstChainId: "8453",
  bridgeOrderId: "order-1",
  txHash: "0xabc",
});

assert.equal(refunded.type, "bridge_refunded");
assert.equal(refunded.title, "Bridge refunded");
assert.equal(refunded.severity, "warning");

console.log("[bridge-status-tests] ok");
