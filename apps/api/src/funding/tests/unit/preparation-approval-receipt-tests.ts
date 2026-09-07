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
      await verifyPreparationApprovalReceipts(
        run,
        [wallet],
        async () => evidence,
      ),
      true,
    );
  }
});

test("approval recovery rejects missing, failed, reorged and foreign evidence", async () => {
  const { run, evidence } = fixture();
  const originalReceipt = evidence.receipt;
  const originalTransaction = evidence.transaction;
  assert.ok(originalReceipt);
  assert.ok(originalTransaction);
  for (const receipt of [
    null,
    { ...originalReceipt, succeeded: false },
    { ...originalReceipt, canonicalBlockHash: `0x${"cd".repeat(32)}` },
    { ...originalReceipt, logs: [] },
    {
      ...originalReceipt,
      logs: [...originalReceipt.logs, ...originalReceipt.logs],
    },
  ]) {
    assert.equal(
      await verifyPreparationApprovalReceipts(run, [wallet], async () => ({
        ...evidence,
        receipt,
      })),
      false,
    );
  }
  assert.equal(
    await verifyPreparationApprovalReceipts(
      run,
      [{ ...wallet, id: "another" }],
      async () => evidence,
    ),
    false,
  );
  assert.equal(
    await verifyPreparationApprovalReceipts(run, [wallet], async () => ({
      ...evidence,
      transaction: { ...originalTransaction, value: 1n },
    })),
    false,
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
    await verifyPreparationApprovalReceipts(
      accepted,
      [wallet],
      async (network, input) => {
        assert.equal(network, "evm:8453");
        assert.equal(input, reference);
        return evidence;
      },
    ),
    true,
  );
  assert.equal(
    await verifyPreparationApprovalReceipts(accepted, [wallet], async () => ({
      transaction: null,
      receipt: null,
    })),
    false,
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
      await verifyPreparationApprovalReceipts(changed, [wallet], async () => {
        throw Error("must not read");
      }),
      false,
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
