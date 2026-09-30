import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  discoverCanonicalRedemption,
  matchesCanonicalRedemption,
  type RedemptionRecoveryRpc,
} from "../../position-actions/canonical-redemption-recovery.js";
import type { StoredPositionAction } from "../../position-actions/position-action-repository.js";
import {
  parseEmbeddedPositionExecutionKey,
  validateEmbeddedPositionPayload,
} from "../../position-actions/embedded-submission.js";

const owner = "0x0000000000000000000000000000000000000017";
const ctf = "0x00000000000000000000000000000000000000c7";
const collateral = "0x00000000000000000000000000000000000000c1";
const condition = ethers.id("anonymized-historical-condition");
const token =
  106400257701816737046605655379273503282131322801321977195781982291580345036802n;
const raw = 2628726n;
const hash = `0x${"a".repeat(64)}`;
const blockHash = `0x${"b".repeat(64)}`;
const abi = new ethers.Interface([
  "function redeemPositions(address,bytes32,bytes32,uint256[])",
  "event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const data = abi.encodeFunctionData("redeemPositions", [
  collateral,
  ethers.ZeroHash,
  condition,
  [2],
]);
// Historical shape: accepted EntryPoint/bundler execution, exact NO burn and
// USDC payout, but no browser submission report. Addresses/hashes are synthetic.
const operation = {
  id: "10000000-0000-4000-8000-000000000001",
  venueId: "limitless",
  action: "redeem",
  ownerAddress: owner,
  executionAddress: owner,
  executionWalletId: "wallet-owned",
  executionMode: "privy_authorization",
  updatedAt: new Date(),
  planSnapshot: {
    outcome: "NO",
    tokenId: `limitless:${token}`,
    plan: {
      redeemable: true,
      chainId: 8453,
      targetAddress: ctf,
      data,
      payoutTokenAddress: collateral,
      expectedPayoutRaw: raw.toString(),
      yesBalanceRaw: "0",
      noBalanceRaw: raw.toString(),
    },
  },
  normalizedActions: [
    {
      kind: "evm_transaction",
      networkId: "evm:8453",
      senderWalletId: "wallet-owned",
      to: ctf,
      data,
      valueRaw: "0",
      gasLimitRaw: null,
    },
  ],
} as unknown as StoredPositionAction;
const event = (name: string, args: readonly unknown[], address = ctf) => ({
  address,
  ...abi.encodeEventLog(name, args),
});
const payoutLog = event("PayoutRedemption", [
  owner,
  collateral,
  ethers.ZeroHash,
  condition,
  [2],
  raw,
]);
const receipt = {
  succeeded: true,
  blockNumber: 1250,
  blockHash,
  logs: [
    event("TransferSingle", [owner, owner, ethers.ZeroAddress, token, raw]),
    payoutLog,
    event("Transfer", [ctf, owner, raw], collateral),
  ],
};
assert.equal(matchesCanonicalRedemption(operation, ctf, receipt), true);
const siblingToken = token + 1n;
const siblingRaw = 1000000n;
const siblingCondition = ethers.id("bundle-sibling-condition");
const sibling = {
  ...operation,
  planSnapshot: {
    ...operation.planSnapshot,
    tokenId: `limitless:${siblingToken}`,
    plan: {
      ...(operation.planSnapshot.plan as object),
      data: abi.encodeFunctionData("redeemPositions", [
        collateral,
        ethers.ZeroHash,
        siblingCondition,
        [2],
      ]),
      noBalanceRaw: siblingRaw.toString(),
      expectedPayoutRaw: siblingRaw.toString(),
    },
  },
};
const bundledReceipt = {
  ...receipt,
  logs: [
    ...receipt.logs,
    event("TransferSingle", [
      owner,
      owner,
      ethers.ZeroAddress,
      siblingToken,
      siblingRaw,
    ]),
    event("PayoutRedemption", [
      owner,
      collateral,
      ethers.ZeroHash,
      siblingCondition,
      [2],
      siblingRaw,
    ]),
    event("Transfer", [ctf, owner, siblingRaw], collateral),
  ],
};
assert.equal(matchesCanonicalRedemption(operation, ctf, bundledReceipt), true);
assert.equal(matchesCanonicalRedemption(sibling, ctf, bundledReceipt), true);
assert.equal(
  matchesCanonicalRedemption(operation, ctf, {
    ...bundledReceipt,
    logs: bundledReceipt.logs.slice(0, -1),
  }),
  false,
  "one sibling's missing payout cannot be hidden by another redemption",
);
assert.equal(
  matchesCanonicalRedemption(operation, ctf, {
    ...receipt,
    logs: [
      ...receipt.logs.slice(0, -1),
      event("Transfer", [owner, owner, raw], collateral),
    ],
  }),
  false,
  "an unrelated ERC20 credit is not a CTF payout",
);
assert.equal(
  matchesCanonicalRedemption(
    {
      ...operation,
      planSnapshot: { ...operation.planSnapshot, tokenId: token.toString() },
    },
    ctf,
    receipt,
  ),
  true,
);
for (const corrupted of [
  { ...operation, ownerAddress: ctf },
  { ...operation, planSnapshot: { ...operation.planSnapshot, tokenId: "1" } },
  { ...operation, venueId: "polymarket" },
  {
    ...operation,
    planSnapshot: {
      ...operation.planSnapshot,
      tokenId: `limitless:${token}:NO`,
    },
  },
  {
    ...operation,
    planSnapshot: {
      ...operation.planSnapshot,
      plan: {
        ...(operation.planSnapshot.plan as object),
        data: abi.encodeFunctionData("redeemPositions", [
          collateral,
          ethers.ZeroHash,
          ethers.id("other"),
          [2],
        ]),
      },
    },
  },
])
  assert.equal(matchesCanonicalRedemption(corrupted, ctf, receipt), false);
assert.equal(
  matchesCanonicalRedemption(operation, ctf, { ...receipt, succeeded: false }),
  false,
);
assert.equal(
  matchesCanonicalRedemption(operation, ctf, {
    ...receipt,
    logs: receipt.logs.slice(1),
  }),
  false,
);
assert.equal(
  matchesCanonicalRedemption(operation, ctf, {
    ...receipt,
    logs: [...receipt.logs, payoutLog],
  }),
  false,
);

const rpc: RedemptionRecoveryRpc = {
  finalizedBlock: async () => 2000n,
  timestamp: async (block) => 1_000_000n + block,
  logs: async (from, to) =>
    from <= 1250n && to >= 1250n
      ? [
          {
            ...payoutLog,
            transactionHash: hash,
            blockNumber: 1250n,
            blockHash,
          },
        ]
      : [],
  receipt: async () => receipt,
  blockHash: async () => blockHash,
};
const start = new Date(1_001_200 * 1000);
assert.equal(
  await discoverCanonicalRedemption(operation, start, ctf, rpc),
  hash,
);
assert.equal(
  await discoverCanonicalRedemption(operation, start, ctf, {
    ...rpc,
    blockHash: async () => ethers.ZeroHash,
  }),
  null,
);
assert.equal(
  await discoverCanonicalRedemption(operation, start, ctf, {
    ...rpc,
    receipt: async () => null,
  }),
  null,
);
assert.equal(
  await discoverCanonicalRedemption(operation, start, ctf, {
    ...rpc,
    logs: async (from, to, address) =>
      (await rpc.logs(from, to, address)).flatMap((log) => [
        log,
        { ...log, transactionHash: ethers.ZeroHash },
      ]),
  }),
  null,
);
assert.equal(
  await discoverCanonicalRedemption(operation, start, ctf, {
    ...rpc,
    logs: async () => [],
  }),
  null,
);
assert.deepEqual(parseEmbeddedPositionExecutionKey(`${operation.id}:1`), {
  operationId: operation.id,
  attemptNumber: 1,
});
assert.equal(
  parseEmbeddedPositionExecutionKey(`${operation.id}:preclaim`),
  null,
);
assert.equal(
  parseEmbeddedPositionExecutionKey(`${operation.id}:9007199254740993`),
  null,
);
const payload = {
  kind: "ethereum" as const,
  signer: owner,
  chainId: 8453,
  executionMode: "sequential" as const,
  returnOnAccepted: true,
  transactions: [{ to: ctf, data, value: "0", sponsor: true }],
};
validateEmbeddedPositionPayload(operation, payload);
for (const corrupted of [
  { ...payload, signer: ctf },
  { ...payload, chainId: 137 },
  {
    ...payload,
    transactions: payload.transactions.map((transaction) => ({
      ...transaction,
      data: "0x",
    })),
  },
  { ...payload, returnOnAccepted: false },
])
  assert.throws(() => validateEmbeddedPositionPayload(operation, corrupted));
console.log(
  "[canonical-redemption-recovery-tests] exact historical effects, ambiguity, finality and immutable submission scope passed",
);
