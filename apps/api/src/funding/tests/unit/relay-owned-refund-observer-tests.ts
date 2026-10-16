import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import {
  RelayOwnedRefundObserver,
  relayOwnedRefundEventMatches,
} from "../../reconciliation/relay-owned-refund-observer.js";

test("expired or invalid existing owned-refund job budget starts no SQL or provider reads", async () => {
  let calls = 0;
  const fail = async () => {
    calls++;
    throw Error("expired work performed IO");
  };
  const pool = { query: fail, connect: fail } as unknown as Pool;
  const observer = new RelayOwnedRefundObserver(
    {
      fingerprint: () => {
        calls++;
        throw Error("expired work fingerprinted");
      },
    },
    { blockNumber: fail, transferLogs: fail },
  );
  for (const deadlineMs of [
    Date.now() - 1,
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.deepEqual(
      await observer.pollOperation(pool, "unused", new Date(), {
        work: { progressToken: "unused", deadlineMs, limit: 1 },
      }),
      {
        refundsPolled: 0,
        refundSatisfied: false,
        pendingReason: "role_work_budget_exhausted",
      },
    );
  }
  assert.equal(calls, 0);
});

test("owned EVM refund reference aliases preserve exact amount/source fence and non-EVM identity", () => {
  const transactionHash = `0X${"aB".repeat(32)}`;
  const walletAddress = `0x${"66".repeat(20)}`;
  const asset = {
    networkId: "evm:8453",
    assetId: `0x${"77".repeat(20)}`,
    decimals: 6,
  };
  const input = {
    event: {
      variant: {
        variantId: "fixture",
        networkId: asset.networkId,
        asset,
        destinationAddress: walletAddress,
        destinationLocationId: "fixture",
        baselineRaw: "0",
        baselineRevision: "fixture",
        observation: { adapterId: "fixture", payload: {} },
        completion: { kind: "child_funding_operation" as const },
      },
      transactionHash,
      eventIndex: "0",
      blockNumber: "2",
      blockHash: `0x${"88".repeat(32)}`,
      sourceAddress: `0x${"55".repeat(20)}`,
      destinationAddress: walletAddress,
      rawAmount: "10",
      observedAt: new Date().toISOString(),
    },
    expectedRaw: "10",
    sourceBlock: "1",
    sourceEventIndex: "0",
    walletAddress,
    transactionReferenceFingerprints: [transactionHash.toLowerCase()],
    fingerprint: (reference: string) => reference,
  };
  assert.equal(relayOwnedRefundEventMatches(input), true);
  assert.equal(
    relayOwnedRefundEventMatches({
      ...input,
      transactionReferenceFingerprints: [transactionHash],
    }),
    true,
  );
  assert.equal(
    relayOwnedRefundEventMatches({ ...input, expectedRaw: "11" }),
    false,
  );
  assert.equal(
    relayOwnedRefundEventMatches({ ...input, sourceBlock: "3" }),
    false,
  );
  assert.equal(
    relayOwnedRefundEventMatches({
      ...input,
      networkId: "hyperliquid:mainnet",
    }),
    false,
  );
  assert.equal(
    relayOwnedRefundEventMatches({
      ...input,
      event: { ...input.event, transactionHash: "MalformedCase" },
      transactionReferenceFingerprints: ["malformedcase"],
    }),
    false,
  );
});
