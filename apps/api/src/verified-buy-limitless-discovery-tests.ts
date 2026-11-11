import assert from "node:assert/strict";
import { id } from "ethers";
import {
  discoverLimitlessBuyTransactions,
  readLimitlessReceiptSearch,
  limitlessReceiptSearchIdentity,
  LIMITLESS_RECEIPT_SEARCH_READS,
  LIMITLESS_RECEIPT_SEARCH_BLOCKS,
  type LimitlessReceiptSearchInput,
  type LimitlessReceiptSearchProvider,
} from "./services/verified-buy-limitless-discovery.js";

const input: LimitlessReceiptSearchInput = {
  exchangeAddress: `0x${"2".repeat(40)}`,
  orderHash: `0x${"a".repeat(64)}`,
  providerOrderId: "provider-order",
  owner: `0x${"1".repeat(40)}`,
  tokenId: "limitless:123",
  generation: "8453:position:123",
  postedAt: "2026-11-11T12:32:00Z",
  checkpoint: null,
};
const transactionHash = `0x${"b".repeat(64)}`;
const topic = id(
  "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)",
);
const created = Date.parse(input.postedAt) / 1000;
let finalizedNumber = 56_000_000;
const time = (number: number) =>
  created - 3_600 + Math.floor((number - 55_980_000) / 5);
let calls = 0,
  pages = 0,
  failLogs = false,
  empty = false;
const provider: LimitlessReceiptSearchProvider = {
  getBlock: async (value) => {
    calls++;
    const number = value === "finalized" ? finalizedNumber : value;
    return { number, timestamp: time(number) };
  },
  getLogs: async (filter) => {
    calls++;
    pages++;
    assert.equal(filter.address, input.exchangeAddress);
    assert.deepEqual(filter.topics[1], input.orderHash);
    assert.ok(
      filter.toBlock - filter.fromBlock + 1 <= LIMITLESS_RECEIPT_SEARCH_BLOCKS,
    );
    if (failLogs) throw Error("temporary RPC failure");
    const blockNumber = 55_999_000;
    return !empty &&
      filter.fromBlock <= blockNumber &&
      filter.toBlock >= blockNumber
      ? [0, 1].map(() => ({
          address: input.exchangeAddress,
          topics: [topic, input.orderHash],
          transactionHash,
          blockNumber,
          blockHash: `0x${"c".repeat(64)}`,
        }))
      : [];
  },
};
let checkpoint: unknown = null;
let completed = false;
for (let pass = 0; pass < 12; pass++) {
  const before = calls;
  let charged = 0;
  const result = await discoverLimitlessBuyTransactions(
    provider,
    { ...input, checkpoint },
    () => {
      charged++;
    },
  );
  assert.equal(result.failure, undefined);
  assert.equal(result.reads, charged);
  assert.equal(calls - before, charged);
  assert.ok(charged <= LIMITLESS_RECEIPT_SEARCH_READS);
  checkpoint = JSON.parse(JSON.stringify(result.checkpoint)); // process restart
  if (result.checkpoint.transactions.length) {
    assert.deepEqual(result.checkpoint.transactions, [transactionHash]);
    completed = true;
    break;
  }
}
assert.equal(completed, true);
const located = await discoverLimitlessBuyTransactions(
  provider,
  { ...input, checkpoint },
  () => {
    throw Error("Known locator must not rescan");
  },
);
assert.equal(located.reads, 0);
assert.ok(pages > 0);
for (const changed of [
  { owner: `0x${"3".repeat(40)}` },
  { tokenId: "limitless:456" },
  { generation: "another-generation" },
  { providerOrderId: "other-order" },
  { exchangeAddress: `0x${"4".repeat(40)}` },
  { orderHash: `0x${"c".repeat(64)}` },
])
  assert.equal(
    readLimitlessReceiptSearch({ ...input, ...changed, checkpoint }),
    null,
  );
assert.equal(
  readLimitlessReceiptSearch({
    ...input,
    checkpoint: { ...located.checkpoint, nextBlock: finalizedNumber + 2 },
  }),
  null,
);
assert.equal(
  readLimitlessReceiptSearch({
    ...input,
    checkpoint: {
      ...located.checkpoint,
      transactions: [transactionHash, transactionHash],
    },
  }),
  null,
);

// A network failure retains every successfully completed block page.
checkpoint = { ...located.checkpoint, transactions: [], nextBlock: 55_990_000 };
failLogs = true;
const failed = await discoverLimitlessBuyTransactions(
  provider,
  { ...input, checkpoint },
  () => {},
);
assert.ok(failed.failure);
assert.equal(failed.checkpoint.nextBlock, 55_990_000);
failLogs = false;
empty = true;
const caughtUp = await discoverLimitlessBuyTransactions(
  provider,
  { ...input, checkpoint },
  () => {},
);
assert.equal(caughtUp.checkpoint.nextBlock, finalizedNumber + 1);
const previous = caughtUp.checkpoint.nextBlock;
finalizedNumber += 12_000;
const resumed = await discoverLimitlessBuyTransactions(
  provider,
  { ...input, checkpoint: caughtUp.checkpoint },
  () => {},
);
assert.equal(resumed.checkpoint.nextBlock, finalizedNumber + 1);
assert.ok(resumed.checkpoint.nextBlock > previous);
finalizedNumber -= 5_000;
await assert.rejects(
  discoverLimitlessBuyTransactions(
    provider,
    { ...input, checkpoint: resumed.checkpoint },
    () => {},
  ),
  /regressed/,
);
await assert.rejects(
  discoverLimitlessBuyTransactions(
    provider,
    { ...input, postedAt: "bad" },
    () => {},
  ),
  /identity/,
);
assert.equal(limitlessReceiptSearchIdentity(input).length, 64);
// A valid small shared request budget must still make durable progress. It
// cannot be rejected just because this pass cannot afford the six-read cap.
finalizedNumber = 56_000_000;
empty = false;
checkpoint = null;
const smallInput = {
  ...input,
  postedAt: new Date(Date.parse(input.postedAt) - 3_600_000).toISOString(),
};
const pagesBefore = pages;
for (let pass = 0; pass < 60; pass++) {
  const before = calls;
  const result = await discoverLimitlessBuyTransactions(
    provider,
    { ...smallInput, checkpoint },
    () => {},
    { maxReads: 1 },
  );
  assert.equal(result.failure, undefined);
  assert.ok(calls - before <= 1);
  checkpoint = result.checkpoint;
  if (result.checkpoint.transactions.length) break;
}
assert.deepEqual(
  readLimitlessReceiptSearch({ ...smallInput, checkpoint })?.transactions,
  [transactionHash],
);
assert.ok(pages - pagesBefore >= 2);
const restart = await discoverLimitlessBuyTransactions(
  provider,
  {
    ...input,
    checkpoint: { ...located.checkpoint, phase: "restart", transactions: [] },
  },
  () => {},
  { maxReads: 1 },
);
assert.equal(restart.checkpoint.phase, "locate");
assert.equal(restart.checkpoint.lowerBlock, 0);
assert.equal(restart.checkpoint.targetBlock, finalizedNumber);
console.log(
  "ok - bounded exact-hash discovery, restart checkpoints, scoping, retry, catch-up and finalized regression",
);
