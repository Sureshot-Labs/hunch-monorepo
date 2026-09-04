import assert from "node:assert/strict";
import { ethers } from "ethers";
import { observeRelayErc20DestinationReceipts } from "../../reconciliation/relay-destination-receipts.js";
import type { EvmRpcTransactionReceipt } from "../../../services/polygon-rpc.js";

const token = `0x${"11".repeat(20)}`;
const recipient = `0x${"22".repeat(20)}`;
const sender = `0x${"33".repeat(20)}`;
const hash = `0x${"44".repeat(32)}`;
const blockHash = `0x${"55".repeat(32)}`;
const log = {
  address: token,
  logIndex: 3,
  topics: [
    ethers.id("Transfer(address,address,uint256)"),
    ethers.zeroPadValue(sender, 32),
    ethers.zeroPadValue(recipient, 32),
  ],
  data: ethers.zeroPadValue(ethers.toBeHex(504969n), 32),
};
let receipt: EvmRpcTransactionReceipt | null = {
  succeeded: true,
  blockNumber: 100,
  blockHash,
  logs: [log],
};
let head = 101n;
let canonicalHash: string | null = blockHash;
let calls = 0;
const rpc = {
  receipt: async () => {
    calls++;
    return receipt;
  },
  blockNumber: async () => head,
  blockHash: async () => canonicalHash,
};
const input = {
  asset: { networkId: "evm:8453", assetId: token, decimals: 6 },
  destinationAddress: recipient,
  transactionHashes: [hash, hash],
  now: new Date("2026-09-04T22:18:14Z"),
};
const events = await observeRelayErc20DestinationReceipts(input, rpc);
assert.equal(
  calls,
  1,
  "duplicate provider references must not multiply RPC reads/credits",
);
assert.equal(events.length, 1);
assert.equal(events[0]?.rawAmount, "504969");
assert.equal(events[0]?.eventIndex, "3");
assert.equal(events[0]?.transactionHash, hash);
assert.equal(
  (
    await observeRelayErc20DestinationReceipts(
      { ...input, asset: { ...input.asset, networkId: "evm:137" } },
      rpc,
    )
  ).length,
  1,
);
head = 100n;
assert.deepEqual(
  await observeRelayErc20DestinationReceipts(input, rpc),
  [],
  "wait for canonical receive confirmation threshold",
);
head = 101n;
canonicalHash = `0x${"66".repeat(32)}`;
assert.deepEqual(
  await observeRelayErc20DestinationReceipts(input, rpc),
  [],
  "reorged receipt is not a credit",
);
canonicalHash = blockHash;
assert.ok(receipt);
receipt = { ...receipt, succeeded: false };
assert.deepEqual(
  await observeRelayErc20DestinationReceipts(input, rpc),
  [],
  "failed transaction cannot credit",
);
const [topic, from, to] = log.topics;
assert.ok(topic && from && to);
receipt = {
  ...receipt,
  succeeded: true,
  logs: [
    { ...log, address: sender },
    {
      ...log,
      topics: [topic, from, ethers.zeroPadValue(sender, 32)],
    },
    { ...log, data: "0xgarbage" },
    { ...log, logIndex: undefined },
    { ...log, topics: [topic, "0x01", to] },
  ],
};
assert.deepEqual(
  await observeRelayErc20DestinationReceipts(input, rpc),
  [],
  "wrong asset/recipient and malformed logs fail closed",
);
receipt = null;
assert.deepEqual(await observeRelayErc20DestinationReceipts(input, rpc), []);
await assert.rejects(
  observeRelayErc20DestinationReceipts(input, {
    ...rpc,
    receipt: async () => {
      throw new Error("RPC unavailable");
    },
  }),
  /RPC unavailable/,
);
assert.deepEqual(
  await observeRelayErc20DestinationReceipts(
    { ...input, asset: { ...input.asset, networkId: "solana:mainnet" } },
    rpc,
  ),
  [],
  "non-EVM routes retain their existing scanner",
);
