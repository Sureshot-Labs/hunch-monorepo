import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  findSafeFundingExecution,
  safeFundingExecutionOutcome,
} from "../../execution/safe-funding-receipt.js";
import {
  evaluatePolymarketDepositWalletHandoffReceipt,
  inspectEvmTarget,
} from "../../execution/step-receipt-reconciler.js";
import { safeFundingTransactionReference } from "../../execution/safe-funding-submission-contract.js";
import type {
  FundingStepReceiptTarget,
  FundingStepReceiptEvidence,
  FundingStepReceiptObservation,
} from "../../persistence/funding-step-receipt-repository.js";

const safe = `0x${"11".repeat(20)}`;
const recipient = `0x${"22".repeat(20)}`;
const token = `0x${"33".repeat(20)}`;
const safeHash = `0x${"aa".repeat(32)}`;
const chainHash = `0x${"bb".repeat(32)}`;
const blockHash = `0x${"cc".repeat(32)}`;
const iface = new ethers.Interface([
  "event ExecutionSuccess(bytes32 txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 txHash,uint256 payment)",
]);
const erc20 = new ethers.Interface([
  "function transfer(address,uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const safeLog = (success: boolean, hash = safeHash) => ({
  address: safe,
  ...iface.encodeEventLog(success ? "ExecutionSuccess" : "ExecutionFailure", [
    hash,
    0,
  ]),
  transactionHash: chainHash,
  blockNumber: 990n,
  blockHash,
  logIndex: 1,
});
const transferLog = {
  address: token,
  ...erc20.encodeEventLog("Transfer", [safe, recipient, 12n]),
  logIndex: 0,
};
assert.equal(
  safeFundingExecutionOutcome([safeLog(true)], safe, safeHash),
  "success",
);
assert.equal(
  safeFundingExecutionOutcome([safeLog(false)], safe, safeHash),
  "failure",
);
assert.equal(
  safeFundingExecutionOutcome([safeLog(true)], recipient, safeHash),
  null,
);
assert.equal(
  safeFundingExecutionOutcome([safeLog(true, chainHash)], safe, safeHash),
  null,
);
assert.equal(
  safeFundingExecutionOutcome([safeLog(true), safeLog(false)], safe, safeHash),
  null,
);

const data = erc20.encodeFunctionData("transfer", [recipient, 12n]);
const action = {
  kind: "external_handoff" as const,
  actionId: "safe_action",
  networkId: "evm:137",
  actorWalletId: "wallet",
  handoffKind: "polymarket_safe_transfer",
  payload: {
    topology: "safe",
    token,
    funder: safe,
    recipient,
    amountRaw: "12",
    calls: [{ target: token, data, value: "0" }],
  },
};
const validation = {
  tokenAddress: token,
  funderAddress: safe,
  recipientAddress: recipient,
  signerAddress: recipient,
  amountRaw: "12",
  transferData: data,
  executionEnvelope: "polymarket_safe_to_controller_v1",
};
const receipt = {
  succeeded: true,
  blockNumber: 990,
  blockHash,
  canonicalBlockHash: blockHash,
  confirmations: 12,
  logs: [transferLog, safeLog(true)],
};
const evaluation = {
  action,
  actionValidationResult: validation,
  transaction: {
    chainId: 137n,
    from: recipient,
    to: safe,
    data: "0x",
    value: 0n,
  },
  receipt,
  previous: null,
  safeTransaction: { safe, transactionHash: safeHash },
};
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt(evaluation).status,
  "finalized",
);
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    ...evaluation,
    receipt: { ...receipt, logs: [safeLog(true)] },
  }).status,
  "mismatch",
  "Safe success alone never proves the exact ERC20 receipt",
);
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    ...evaluation,
    receipt: { ...receipt, logs: [transferLog] },
  }).status,
  "pending",
  "unrelated matching amount is not the exact signed Safe action",
);
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    ...evaluation,
    receipt: { ...receipt, logs: [safeLog(false)] },
  }).status,
  "failed",
);
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    ...evaluation,
    receipt: { ...receipt, confirmations: 1, logs: [safeLog(false)] },
  }).status,
  "confirmed",
  "Safe failure obeys the existing stronger failure finality policy",
);
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    ...evaluation,
    receipt: { ...receipt, canonicalBlockHash: null, logs: [safeLog(false)] },
  }).status,
  "pending",
);
assert.equal(
  evaluatePolymarketDepositWalletHandoffReceipt({
    ...evaluation,
    receipt: {
      ...receipt,
      canonicalBlockHash: chainHash,
      logs: [safeLog(false)],
    },
  }).status,
  "reorged",
);

const scanInput = {
  safe,
  safeTransactionHash: safeHash,
  attemptStartedAt: new Date(1_000_000),
  rpcUrl: "https://invalid.local",
  timeoutMs: 2000,
};
const scanned: [bigint, bigint][] = [];
const scanner = {
  fetchBlockNumber: async () => 1000n,
  fetchBlockTimestamp: async () => 999n,
  fetchLogs: async (input: { fromBlock: bigint; toBlock: bigint }) => {
    scanned.push([input.fromBlock, input.toBlock]);
    return [safeLog(true)];
  },
};
const found = await findSafeFundingExecution(scanInput, scanner);
assert.equal(
  found.transactionHash,
  chainHash,
  "lost HTTP response can discover exact Safe event without a provider ID",
);
assert.ok(
  scanned.length <= 2 && scanned.every(([from, to]) => to - from < 64n),
);
const late = await findSafeFundingExecution(
  { ...scanInput, attemptStartedAt: new Date(0) },
  scanner,
);
assert.equal(
  late.transactionHash,
  chainHash,
  "late execution is not excluded by the legacy transfer attribution deadline",
);
const absent = await findSafeFundingExecution(scanInput, {
  ...scanner,
  fetchLogs: async () => [],
});
assert.equal(absent.transactionHash, null);
assert.equal(absent.conflictingTransactions, false);
assert.equal(absent.evidence.safeExecutionScanHistoryCovered, true);
const limitedRanges: [bigint, bigint][] = [];
const limited = await findSafeFundingExecution(scanInput, {
  ...scanner,
  fetchBlockTimestamp: async () => 2000n,
  fetchLogs: async (input) => {
    limitedRanges.push([input.fromBlock, input.toBlock]);
    if (input.toBlock - input.fromBlock + 1n > 10n)
      throw new Error("up to a 10 block range");
    return [];
  },
});
assert.equal(
  limited.evidence.safeExecutionScanOldestBlock,
  "981",
  "range-cap retry never claims unqueried history as scanned",
);
const resumed = await findSafeFundingExecution(
  { ...scanInput, previousEvidence: limited.evidence },
  {
    ...scanner,
    fetchBlockTimestamp: async () => 2000n,
    fetchLogs: async () => [],
  },
);
assert.equal(resumed.evidence.safeExecutionScanOldestBlock, "873");

for (const eventBlock of [970n, 1015n]) {
  let previousEvidence:
    | Awaited<ReturnType<typeof findSafeFundingExecution>>["evidence"]
    | undefined;
  let discovered: string | null = null;
  let oldest: bigint | null = null;
  for (let poll = 0; poll < 8 && !discovered; poll++) {
    const liveTip = 1000n + BigInt(poll) * 30n;
    let reads = 0;
    const result = await findSafeFundingExecution(
      {
        ...scanInput,
        attemptStartedAt: new Date(900_000),
        previousEvidence,
      },
      {
        fetchBlockNumber: async () => liveTip,
        fetchBlockTimestamp: async ({ blockNumber }) => blockNumber,
        fetchLogs: async ({ fromBlock, toBlock }) => {
          reads++;
          if (toBlock - fromBlock + 1n > 10n)
            throw new Error("up to a 10 block range");
          return fromBlock <= eventBlock && eventBlock <= toBlock
            ? [{ ...safeLog(true), blockNumber: eventBlock }]
            : [];
        },
      },
    );
    assert.ok(
      reads <= 6,
      "three windows each allow at most one provider-cap retry",
    );
    const nextOldest = BigInt(
      String(result.evidence.safeExecutionScanOldestBlock),
    );
    assert.ok(
      oldest === null || nextOldest <= oldest,
      "moving tip never resets historical cursor forward",
    );
    oldest = nextOldest;
    previousEvidence = result.evidence;
    discovered = result.transactionHash;
  }
  assert.equal(
    discovered,
    chainHash,
    `tip advancing 30 blocks per poll with 10-block cap still discovers fixed block ${eventBlock}`,
  );
}

const target: FundingStepReceiptTarget = {
  userId: "user",
  operationId: "operation",
  stepId: "step",
  segmentId: null,
  attemptId: "attempt",
  attemptStartedAt: scanInput.attemptStartedAt,
  stepKind: "external_handoff",
  payerRequirement: "provider",
  networkId: "evm:137",
  action,
  actionValidationResult: validation,
  receiptRefCiphertext: "encrypted-safe",
  receiptRefLookupHmac: "hmac",
  lookupKeyVersion: 1,
  referenceKind: "external_handoff",
  previousReceipt: null,
};
const originalFetch = globalThis.fetch;
const rpcMethods: string[] = [];
let receiptAvailable = true;
let transactionAvailable = true;
globalThis.fetch = (async (_url, init) => {
  const request = JSON.parse(String(init?.body));
  rpcMethods.push(request.method);
  const results: Record<string, unknown> = {
    eth_getTransactionByHash: {
      chainId: "0x89",
      from: recipient,
      to: safe,
      input: "0x",
      value: "0x0",
    },
    eth_getTransactionReceipt: {
      status: "0x1",
      blockNumber: "0x3de",
      blockHash,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        logIndex: `0x${log.logIndex.toString(16)}`,
      })),
    },
    eth_blockNumber: "0x3f5",
    eth_getBlockByNumber: { hash: blockHash, timestamp: "0x3e7" },
  };
  assert.ok(
    Object.hasOwn(results, request.method),
    `unexpected RPC ${request.method}`,
  );
  if (!receiptAvailable) results.eth_getTransactionReceipt = null;
  if (!transactionAvailable) results.eth_getTransactionByHash = null;
  return Response.json({
    jsonrpc: "2.0",
    id: request.id,
    result: results[request.method],
  });
}) as typeof fetch;
try {
  const inspected = await inspectEvmTarget(
    target,
    safeFundingTransactionReference(safe, safeHash),
    undefined,
    {
      findTransactionScan: async () => {
        throw new Error("Legacy amount scan must not run");
      },
      resolveReference: async () => {
        throw new Error("No provider response available");
      },
      findSafeExecution: async () => found,
    },
  );
  assert.equal(inspected.status, "finalized");
  assert.equal(inspected.evidence.transactionHash, chainHash);
  assert.equal(inspected.evidence.exactTransferObserved, true);
  assert.ok(rpcMethods.includes("eth_getTransactionReceipt"));
  const unavailableScan = await inspectEvmTarget(
    { ...target, safeSubmissionProviderReference: chainHash },
    safeFundingTransactionReference(safe, safeHash),
    undefined,
    {
      findTransactionScan: async () => null,
      resolveReference: async (reference) => ({
        kind: "transaction",
        reference,
      }),
      findSafeExecution: async () => {
        throw new Error("Log discovery unavailable");
      },
    },
  );
  assert.equal(
    unavailableScan.status,
    "finalized",
    "known provider hash still gets canonical exact event validation during discovery outage",
  );
  const asObservation = (
    result: FundingStepReceiptEvidence,
  ): FundingStepReceiptObservation => ({
    ...result,
    operationId: target.operationId,
    stepId: target.stepId,
    attemptId: target.attemptId,
    networkId: target.networkId,
    firstSeenAt: new Date(),
    observedAt: new Date(),
    finalizedAt: null,
    reorgedAt: null,
  });
  receiptAvailable = false;
  const discoveredWithoutReceipt = await inspectEvmTarget(
    target,
    safeFundingTransactionReference(safe, safeHash),
    undefined,
    {
      findTransactionScan: async () => null,
      resolveReference: async () => {
        throw new Error("Provider response lost");
      },
      findSafeExecution: async () => ({
        ...found,
        evidence: { ...found.evidence, safeExecutionScanOldestBlock: "850" },
      }),
    },
  );
  assert.equal(discoveredWithoutReceipt.status, "pending");
  assert.equal(
    discoveredWithoutReceipt.evidence.safeExecutionCandidateTransactionHash,
    chainHash,
  );
  assert.equal(
    discoveredWithoutReceipt.evidence.transactionHash,
    undefined,
    "candidate is not an authoritative receipt binding",
  );
  transactionAvailable = false;
  const stillUnavailable = await inspectEvmTarget(
    { ...target, previousReceipt: asObservation(discoveredWithoutReceipt) },
    safeFundingTransactionReference(safe, safeHash),
    undefined,
    {
      findTransactionScan: async () => null,
      resolveReference: async () => {
        throw new Error("Provider response lost");
      },
      findSafeExecution: async () => ({
        transactionHash: null,
        conflictingTransactions: false,
        evidence: {
          safeExecutionScanOldestBlock: "786",
          safeExecutionScanNewestBlock: "1000",
        },
      }),
    },
  );
  assert.equal(stillUnavailable.status, "pending");
  assert.equal(
    stillUnavailable.evidence.safeExecutionCandidateTransactionHash,
    chainHash,
    "empty advanced scan and absent transaction retain the independent candidate",
  );
  assert.equal(stillUnavailable.evidence.transactionHash, undefined);
  receiptAvailable = true;
  transactionAvailable = true;
  const recoveredCandidate = await inspectEvmTarget(
    { ...target, previousReceipt: asObservation(stillUnavailable) },
    safeFundingTransactionReference(safe, safeHash),
    undefined,
    {
      findTransactionScan: async () => null,
      resolveReference: async () => {
        throw new Error("Provider response lost");
      },
      findSafeExecution: async () => {
        throw new Error("Discovery temporarily unavailable");
      },
    },
  );
  assert.equal(recoveredCandidate.status, "finalized");
  assert.equal(recoveredCandidate.evidence.transactionHash, chainHash);
  assert.equal(
    recoveredCandidate.evidence.exactTransferObserved,
    true,
    "only canonical exact Safe event plus ERC20 transfer settles retained candidate",
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log("safe funding receipt tests passed");
