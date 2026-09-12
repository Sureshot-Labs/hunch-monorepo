import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import type { UserWallet } from "../../../auth.js";
import { stableWalletOpaqueId } from "../../../account-value/canonical.js";
import {
  verifyPreparationApprovalReceipts,
  type PreparationReceiptReader,
} from "../../preparation/approval-receipt.js";
import type { FundingPreparationRun } from "../../persistence/funding-preparation-run-repository.js";

const owner = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const spender = "0x3333333333333333333333333333333333333333";
const hash = `0x${"ab".repeat(32)}`;
const iface = new ethers.Interface([
  "function approve(address spender,uint256 amount)",
  "function setApprovalForAll(address operator,bool approved)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
  "event ApprovalForAll(address indexed account,address indexed operator,bool approved)",
]);
const wallet = {
  id: "controller",
  walletType: "ethereum",
  isVerified: true,
  walletAddress: owner,
} as UserWallet;
async function status(
  run: FundingPreparationRun,
  wallets: readonly UserWallet[],
  read: PreparationReceiptReader,
) {
  return (
    (await verifyPreparationApprovalReceipts(run, wallets, read))?.[0]
      ?.status ?? null
  );
}
function fixture(operator = false) {
  const data = iface.encodeFunctionData(
    operator ? "setApprovalForAll" : "approve",
    [spender, operator ? true : 99n],
  );
  const event = iface.encodeEventLog(operator ? "ApprovalForAll" : "Approval", [
    owner,
    spender,
    operator ? true : 99n,
  ]);
  const run: FundingPreparationRun = {
    runId: "run",
    userId: "user",
    requestFingerprint: hash,
    inspectionRevision: hash,
    expiresAt: new Date(0),
    resolvedAt: null,
    replayed: false,
    controllerWalletRef: "controller",
    status: "submitted",
    // Already-settled market must have no bearing on historical execution.
    request: {
      marketContextId: "settled-market",
      venueBindingOptionId: "binding",
      purpose: "buy",
      marketClass: "clob",
      positionActionRef: null,
      controllerWalletRef: "controller",
      expectedInspectionRevision: hash,
    },
    actions: [
      {
        actionId: "approval",
        ordinal: 0,
        actionFingerprint: hash,
        report: null,
        reportedAt: new Date(0),
        resolvedAt: null,
        state: "submitted",
        broadcastMayHaveOccurred: true,
        transactionReference: hash,
        action: {
          actionId: "approval",
          kind: "evm_transaction",
          networkId: "evm:8453",
          to: token,
          data,
          valueRaw: "0",
          gasLimitRaw: null,
          senderWalletId: stableWalletOpaqueId({
            walletType: "ethereum",
            networkId: "evm:8453",
            address: owner,
          }),
        },
      },
    ],
  };
  const evidence: Awaited<ReturnType<PreparationReceiptReader>> = {
    transaction: { chainId: 8453n, from: owner, to: token, data, value: 0n },
    receipt: {
      succeeded: true,
      blockNumber: 1,
      blockHash: hash,
      canonicalBlockHash: hash,
      confirmations: 100,
      logs: [{ address: token, data: event.data, topics: event.topics }],
    },
  };
  return { run, evidence };
}

test("settled-market ERC20 and operator approvals resolve from exact receipts", async () => {
  for (const operator of [false, true]) {
    const { run, evidence } = fixture(operator);
    assert.equal(
      await status(run, [wallet], async () => evidence),
      "succeeded",
    );
  }
});

test("approval recovery separates pending from reorged and foreign evidence", async () => {
  const { run, evidence } = fixture();
  const originalReceipt = evidence.receipt;
  const originalTransaction = evidence.transaction;
  assert.ok(originalReceipt);
  assert.ok(originalTransaction);
  for (const receipt of [
    { ...originalReceipt, canonicalBlockHash: `0x${"cd".repeat(32)}` },
    { ...originalReceipt, logs: [] },
    {
      ...originalReceipt,
      logs: [...originalReceipt.logs, ...originalReceipt.logs],
    },
  ]) {
    assert.equal(
      await status(run, [wallet], async () => ({
        ...evidence,
        receipt,
      })),
      "unknown",
    );
  }
  assert.equal(
    await status(run, [{ ...wallet, id: "another" }], async () => evidence),
    "unknown",
  );
  assert.equal(
    await status(run, [wallet], async () => ({
      ...evidence,
      transaction: { ...originalTransaction, value: 1n },
    })),
    "unknown",
  );
});

test("Privy references are resolved before checking exact approval receipts", async () => {
  const { run, evidence } = fixture();
  const reference = "privy-transaction-v1:accepted-id";
  const attempt = run.actions[0];
  assert.ok(attempt);
  const accepted = {
    ...run,
    actions: [{ ...attempt, transactionReference: reference }],
  };
  assert.equal(
    await status(accepted, [wallet], async (network, input) => {
      assert.equal(network, "evm:8453");
      assert.equal(input, reference);
      return evidence;
    }),
    "succeeded",
  );
  assert.equal(
    await status(accepted, [wallet], async () => ({
      transaction: null,
      receipt: null,
    })),
    "pending",
  );
});

test("no reference, unsubmitted actions and unknown calldata cannot be marked succeeded", async () => {
  const { run, evidence } = fixture();
  const attempt = run.actions[0];
  assert.ok(attempt);
  for (const patch of [
    { transactionReference: null },
    { state: "action_required" as const },
    { broadcastMayHaveOccurred: false },
  ]) {
    const changed = { ...run, actions: [{ ...attempt, ...patch }] };
    assert.equal(
      await status(changed, [wallet], async () => {
        throw Error("must not read");
      }),
      "unknown",
    );
  }
  const action = attempt.action;
  assert.equal(
    await verifyPreparationApprovalReceipts(
      {
        ...run,
        actions: [
          {
            ...attempt,
            action: { ...action, data: "0x12345678" } as typeof action,
          },
        ],
      },
      [wallet],
      async () => evidence,
    ),
    null,
  );
});

test("only finalized exact canonical reverts become failed, without approval events", async () => {
  const { run, evidence } = fixture();
  assert.ok(evidence.receipt);
  assert.ok(evidence.transaction);
  const originalTransaction = evidence.transaction;
  const failed = { ...evidence.receipt, succeeded: false, logs: [] };
  for (const [receipt, expected] of [
    [null, "pending"],
    [failed, "failed"],
    [{ ...failed, confirmations: 1 }, "pending"],
    [{ ...failed, canonicalBlockHash: null }, "pending"],
    [{ ...failed, canonicalBlockHash: `0x${"cd".repeat(32)}` }, "unknown"],
  ] as const) {
    assert.equal(
      await status(run, [wallet], async () => ({ ...evidence, receipt })),
      expected,
    );
  }
  assert.equal(
    await status(run, [wallet], async () => ({
      transaction: { ...originalTransaction, value: 1n },
      receipt: failed,
    })),
    "unknown",
  );
  assert.equal(
    await status(run, [wallet], async () => {
      throw new Error("RPC lost");
    }),
    "unknown",
  );
  const outcomes = await verifyPreparationApprovalReceipts(
    run,
    [wallet],
    async () => ({ ...evidence, receipt: failed }),
  );
  const outcome = outcomes?.[0];
  assert.ok(outcome?.status === "failed");
  assert.equal(outcome.evidence.failureFinalized, true);
  assert.equal(outcome.evidence.transactionReference, hash);
  assert.equal(outcome.evidence.blockHash, hash);
});

test("unknown sibling does not hide a proven reverted approval", async () => {
  const { run, evidence } = fixture();
  assert.ok(evidence.receipt);
  const originalReceipt = evidence.receipt;
  const firstAttempt = run.actions[0];
  assert.ok(firstAttempt);
  const mixed = {
    ...run,
    actions: [
      {
        ...firstAttempt,
        actionId: "unknown",
        transactionReference: `0x${"cd".repeat(32)}`,
      },
      firstAttempt,
    ],
  };
  const outcomes = await verifyPreparationApprovalReceipts(
    mixed,
    [wallet],
    async (_, reference) => {
      if (reference !== hash) throw new Error("RPC unavailable");
      return {
        ...evidence,
        receipt: { ...originalReceipt, succeeded: false, logs: [] },
      };
    },
  );
  assert.deepEqual(
    outcomes?.map(({ actionId, status }) => ({ actionId, status })),
    [
      { actionId: "unknown", status: "unknown" },
      { actionId: "approval", status: "failed" },
    ],
  );
});
