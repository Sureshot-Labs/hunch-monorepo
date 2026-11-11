import assert from "node:assert/strict";
import {
  readCanonicalFinalizedBuyReceipt,
  readAnchoredFinalizedBuyReceipt,
  type VerifiedBuyEvmProvider,
} from "./services/verified-buy-evm-receipt.js";
import { EvidenceBudgetExhausted } from "./services/verified-buy.js";
const txHash = `0x${"a".repeat(64)}`,
  blockHash = `0x${"b".repeat(64)}`,
  otherHash = `0x${"c".repeat(64)}`;
const receipt = {
  hash: txHash,
  status: 1,
  blockNumber: 100,
  blockHash,
  logs: [],
};
const block = { hash: blockHash, number: 100, timestamp: 1793994507 };
async function check(
  input: {
    receipt?: typeof receipt | null;
    finalized?: typeof block | null;
    canonical?: typeof block | null;
    budget?: number;
    error?: Error;
  } = {},
) {
  const calls: Array<unknown> = [];
  let reads = 0;
  const provider: VerifiedBuyEvmProvider = {
    getTransactionReceipt: async (hash) => {
      calls.push(["receipt", hash]);
      if (input.error) throw input.error;
      return Object.hasOwn(input, "receipt")
        ? (input.receipt ?? null)
        : receipt;
    },
    getBlock: async (selector) => {
      calls.push(["block", selector]);
      return selector === "finalized"
        ? Object.hasOwn(input, "finalized")
          ? (input.finalized ?? null)
          : { ...block, number: 105 }
        : Object.hasOwn(input, "canonical")
          ? (input.canonical ?? null)
          : block;
    },
  };
  const run = () =>
    readCanonicalFinalizedBuyReceipt(provider, txHash, () => {
      if (reads >= (input.budget ?? 3)) throw new EvidenceBudgetExhausted(1, 0);
      reads++;
    });
  return {
    run,
    runAnchored: () =>
      readAnchoredFinalizedBuyReceipt(
        provider,
        txHash,
        { blockNumber: 100, blockHash },
        () => {
          if (reads >= (input.budget ?? 3))
            throw new EvidenceBudgetExhausted(1, 0);
          reads++;
        },
      ),
    calls,
    get reads() {
      return reads;
    },
  };
}
const good = await check();
assert.deepEqual(await good.run(), {
  canonicalBlock: { number: 100, hash: blockHash },
  receipt: { hash: txHash, status: 1, logs: [] },
  timestamp: "2026-11-06T19:48:27.000Z",
});
assert.deepEqual(good.calls, [
  ["receipt", txHash],
  ["block", "finalized"],
  ["block", 100],
]);
assert.equal(good.reads, 3);
const anchored = await check();
assert.equal((await anchored.runAnchored()).state, "finalized");
assert.equal(anchored.reads, 3);
const anchoredOrphan = await check({
  canonical: { ...block, hash: otherHash },
  budget: 3,
});
assert.equal((await anchoredOrphan.runAnchored()).state, "orphaned");
assert.equal(anchoredOrphan.reads, 3);
const missingOrphan = await check({
  receipt: null,
  canonical: { ...block, hash: otherHash },
  budget: 3,
});
assert.equal((await missingOrphan.runAnchored()).state, "orphaned");
assert.equal(missingOrphan.reads, 2);
for (const input of [
  { receipt: null },
  { receipt: { ...receipt, hash: otherHash } },
  { finalized: null },
  { finalized: { ...block, number: NaN } },
  { receipt: { ...receipt, blockNumber: NaN } },
  { finalized: { ...block, number: 99 } },
  { canonical: null },
  { canonical: { ...block, hash: otherHash } },
  { canonical: { ...block, number: 101 } },
]) {
  const fixture = await check(input);
  assert.equal(await fixture.run(), null);
}
const orphan = await check({ canonical: { ...block, hash: otherHash } });
assert.equal(
  await orphan.run(),
  null,
  "An existing orphan block by receipt hash is not canonical at its height",
);
const reverted = await check({ receipt: { ...receipt, status: 0 } });
assert.equal(
  (await reverted.run())?.receipt.status,
  0,
  "Canonical failed receipt remains available to the normal revocation path",
);
const budget = await check({ budget: 2 });
await assert.rejects(budget.run(), EvidenceBudgetExhausted);
assert.equal(budget.calls.length, 2);
const unavailable = await check({
  error: new Error("fixture RPC unavailable"),
});
await assert.rejects(unavailable.run(), /RPC unavailable/);
console.log(
  "ok - canonical/finalized EVM receipts use height+hash, preserve failed receipts and the existing three-read budget",
);
