import assert from "node:assert/strict";
import { test } from "node:test";
import { id, zeroPadValue, toBeHex } from "ethers";
import { HYPERCORE_MAINNET_USDC } from "../../domain/hypercore-identity.js";
import {
  inspectEvmRefundCanonicality,
  inspectNativeRefundCanonicality,
  type RefundCanonicalTarget,
} from "../../reconciliation/relay-refund-canonical-proof.js";
import { exactRefundWatchPending } from "../../reconciliation/relay-refund-watch-state.js";
import {
  pollFundingReconciliationEvidence,
  fundingReconciliationBatchLimit,
} from "../../reconciliation/funding-reducer.js";
import { Hip4ReadError } from "../../../services/hip4-client.js";

const now = new Date("2026-10-14T12:00:00Z");
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const target: RefundCanonicalTarget = {
  asset: {
    networkId: "evm:8453",
    assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
  },
  txHash: hash("1"),
  eventIndex: "7",
  rawAmount: "4000000",
  fromAddress: `0x${"ab".repeat(20)}`,
  toAddress: `0x${"cd".repeat(20)}`,
  ledgerHeight: "123",
  blockHash: hash("2"),
  nativeDex: null,
  nativeLedgerTime: null,
  nativeTransaction: null,
};
const receipt = {
  succeeded: true,
  blockNumber: 123,
  blockHash: hash("2"),
  logs: [
    {
      address: target.asset.assetId,
      logIndex: 7,
      data: zeroPadValue(toBeHex(4000000), 32),
      topics: [
        id("Transfer(address,address,uint256)"),
        zeroPadValue(target.fromAddress, 32),
        zeroPadValue(target.toAddress, 32),
      ],
    },
  ],
};
const rpc = {
  receipt: async () => receipt,
  head: async () => 200n,
  block: async () => hash("2"),
};

test("canonical refund proof reuses exact log identity; empty/error/lagging RPC is not a reorg", async () => {
  assert.deepEqual(await inspectEvmRefundCanonicality(target, now, rpc), {
    kind: "canonical",
    ledgerHeight: "123",
    blockHash: hash("2"),
  });
  for (const overrides of [
    { receipt: async () => null },
    {
      receipt: async () => {
        throw new Error("secret RPC URL");
      },
    },
    { head: async () => 123n },
    { block: async () => null },
    { receipt: async () => ({ ...receipt, logs: [] }) },
    {
      receipt: async () => ({
        ...receipt,
        logs: [
          { ...receipt.logs[0], data: zeroPadValue(toBeHex(5000000), 32) },
        ],
      }),
    },
  ]) {
    const proof = await inspectEvmRefundCanonicality(target, now, {
      ...rpc,
      ...overrides,
    });
    assert.equal(proof.kind, "pending");
    assert.ok(!JSON.stringify(proof).includes("secret"));
  }
});
test("known refund proof runs before slow source/Relay refresh consumes the lease", async (context) => {
  let clock = 0;
  context.mock.method(Date, "now", () => clock);
  const stages: string[] = [];
  await pollFundingReconciliationEvidence({
    operationId: "00000000-0000-4000-8000-000000000001",
    state: { status: "refunded", stage: "terminal" },
    terminalReceiptWatch: true,
    terminalRelayRefundWatch: true,
    now,
    deadlineMs: 30_000,
    progressToken: "00000000-0000-4000-8000-000000000099",
    refundCanonicalPoll: async (_operationId, observedAt, budget) => {
      stages.push("known-refund");
      assert.equal(budget?.deadlineMs, 30_000);
      assert.equal(
        budget?.progressToken,
        "00000000-0000-4000-8000-000000000099",
      );
      assert.ok(budget);
      assert.equal(
        (
          await inspectEvmRefundCanonicality(
            target,
            observedAt,
            rpc,
            budget.deadlineMs,
          )
        ).kind,
        "canonical",
      );
      return { checked: 1 };
    },
    receiptPoll: async () => {
      stages.push("source");
      clock += 60_000;
      throw new Error("source timeout");
    },
    providerPoll: async () => {
      stages.push("provider");
      clock += 60_000;
      throw new Error("Relay timeout");
    },
    destinationPoll: async () => {
      stages.push("replacement");
      return { destinationsPolled: 0, destinationSatisfied: false };
    },
  });
  assert.deepEqual(stages, [
    "known-refund",
    "source",
    "provider",
    "replacement",
  ]);
});
test("canonical watcher reuses bounded reconciliation batch limits", () => {
  assert.deepEqual(
    [undefined, 1, 0, 25.9, 5000, NaN].map(fundingReconciliationBatchLimit),
    [25, 1, 1, 25, 100, 25],
  );
});
test("changed finalized anchor invalidates; exact remine restores only matching economic event", async () => {
  assert.deepEqual(
    await inspectEvmRefundCanonicality(target, now, {
      ...rpc,
      block: async () => hash("3"),
      receipt: async () => null,
    }),
    { kind: "reorged" },
  );
  const remine = {
    ...rpc,
    block: async () => hash("3"),
    receipt: async () => ({
      ...receipt,
      blockNumber: 130,
      blockHash: hash("3"),
    }),
  };
  assert.deepEqual(await inspectEvmRefundCanonicality(target, now, remine), {
    kind: "canonical",
    ledgerHeight: "130",
    blockHash: hash("3"),
  });
  for (const patch of [
    { eventIndex: "8" },
    { rawAmount: "1" },
    { fromAddress: `0x${"ef".repeat(20)}` },
    { asset: { ...target.asset, assetId: `0x${"12".repeat(20)}` } },
  ])
    assert.equal(
      (await inspectEvmRefundCanonicality({ ...target, ...patch }, now, remine))
        .kind,
      "reorged",
    );
  assert.equal(
    (
      await inspectEvmRefundCanonicality(target, now, {
        ...rpc,
        receipt: remine.receipt,
      })
    ).kind,
    "pending",
    "old block still canonical cannot authorize another inclusion",
  );
});
test("native watch uses fresh exact-second ledger, not stored evidence or absent-page inference", async () => {
  const native: RefundCanonicalTarget = {
    ...target,
    asset: HYPERCORE_MAINNET_USDC,
    rawAmount: "400000000",
    eventIndex: "hypercore:send:destination_credit",
    ledgerHeight: null,
    blockHash: null,
    nativeDex: "spot",
    nativeLedgerTime: now.getTime(),
    nativeTransaction: {
      txHash: target.txHash,
      chainId: 1337,
      status: "success",
      block: 123,
      data: {
        hash: target.txHash,
        error: null,
        user: target.fromAddress,
        action: {
          type: "sendAsset",
          hyperliquidChain: "Mainnet",
          destination: target.toAddress,
          sourceDex: "",
          destinationDex: "spot",
          token: `USDC:${HYPERCORE_MAINNET_USDC.assetId}`,
          amount: "4",
          fromSubAccount: "",
          nonce: now.getTime(),
        },
      },
    },
  };
  const ledger = {
    hash: native.txHash,
    time: now.getTime(),
    delta: {
      type: "send",
      user: native.fromAddress,
      destination: native.toAddress,
      sourceDex: "",
      destinationDex: "spot",
      token: "USDC",
      amount: "4",
      usdcValue: "4",
      fee: "0",
      nativeTokenFee: "0",
      feeToken: "USDC",
      nonce: now.getTime(),
    },
  };
  const proof = await inspectNativeRefundCanonicality(
    native,
    async (owner, start, end) => {
      assert.equal(owner, native.toAddress);
      assert.equal(start, now.getTime());
      assert.equal(end - start, 999);
      return [ledger];
    },
  );
  assert.deepEqual(proof, {
    kind: "canonical",
    ledgerHeight: null,
    blockHash: null,
  });
  assert.deepEqual(
    await inspectNativeRefundCanonicality(native, async () => {
      throw new Hip4ReadError("budget_exhausted");
    }),
    { kind: "pending", reason: "refund_watch_budget_exhausted" },
  );
  for (const read of [
    async () => [],
    async () => {
      throw new Error("private");
    },
    async () => [{ ...ledger, delta: { ...ledger.delta, amount: "5" } }],
    async () => Array(2001).fill(ledger),
  ])
    assert.equal(
      (await inspectNativeRefundCanonicality(native, read)).kind,
      "pending",
    );
});
test("pending page state is scheduling only, versioned and clearable", () => {
  assert.equal(exactRefundWatchPending({}), false);
  assert.equal(
    exactRefundWatchPending({
      exactRefundCanonicalWatch: { version: 1, pending: true },
    }),
    true,
  );
  assert.equal(
    exactRefundWatchPending({
      exactRefundCanonicalWatch: {
        version: 1,
        afterId: "00000000-0000-0000-0000-000000000001",
      },
    }),
    true,
  );
  assert.equal(
    exactRefundWatchPending({
      exactRefundCanonicalWatch: { version: 1, pending: false, afterId: null },
    }),
    false,
  );
  assert.equal(
    exactRefundWatchPending({
      exactRefundCanonicalWatch: { version: 2, pending: true },
    }),
    false,
  );
});
