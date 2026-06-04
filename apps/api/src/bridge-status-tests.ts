#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  canonicalizeBridgeOrderStatus,
  getBridgeNotificationStatus,
  isTerminalBridgeOrderStatus,
} from "./services/bridge-status.js";
import {
  buildBridgeNotification,
  buildRewardNotification,
} from "./services/notifications.js";
import { bridgeRouteTestExports } from "./routes/bridge.js";

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

const staleSubmittedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
const recentSubmittedAt = new Date(Date.now() - 60 * 1000).toISOString();

assert.equal(
  bridgeRouteTestExports.shouldFailMissingSolanaSourceTx({
    chainId: "7565164",
    sourceStatus: null,
    sourceTxSubmittedAt: recentSubmittedAt,
  }),
  false,
);
assert.equal(
  bridgeRouteTestExports.shouldFailMissingSolanaSourceTx({
    chainId: "7565164",
    sourceStatus: null,
    sourceTxSubmittedAt: staleSubmittedAt,
  }),
  true,
);
assert.equal(
  bridgeRouteTestExports.shouldFailMissingSolanaSourceTx({
    chainId: "7565164",
    sourceStatus: null,
    sourceTxSubmittedAt: null,
  }),
  false,
);
assert.equal(
  bridgeRouteTestExports.readBridgeSourceTxSubmittedAt({
    sourceTxSubmittedAt: staleSubmittedAt,
  }),
  staleSubmittedAt,
);

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
assert.equal(refunded.body, "Across Polygon → Base");
assert.equal(refunded.severity, "warning");

const sameChain = buildBridgeNotification({
  userId: "user-1",
  provider: "debridge",
  status: "completed",
  srcChainId: "137",
  dstChainId: "137",
  bridgeOrderId: "order-2",
  txHash: "0xdef",
});

assert.equal(sameChain.body, "deBridge Polygon → Polygon");

const solanaReward = buildRewardNotification({
  userId: "user-1",
  status: "failed",
  amountUsd: 0.01,
  chainId: "solana",
  claimId: "claim-1",
  walletAddress: "wallet-1",
});

assert.equal(solanaReward.body, "$0.01 on Solana");

console.log("[bridge-status-tests] ok");
