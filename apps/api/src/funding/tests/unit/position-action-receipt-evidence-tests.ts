import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { StoredPositionAction } from "../../position-actions/position-action-repository.js";
import { createEvmPositionActionReceiptObserver } from "../../position-actions/venue-driver.js";
import { CANONICAL_CTF_ABI } from "../../position-actions/canonical-redemption-evidence.js";
import type { RedemptionPlan } from "../../../services/redemption-plan.js";
import { fetchEmbeddedEthereumTransactionReceipt } from "../../../services/embedded-ethereum.js";

const ctf = "0x00000000000000000000000000000000000000c7";
const owner = "0x0000000000000000000000000000000000000017";
const collateral = "0x00000000000000000000000000000000000000c1";
const hash = `0x${"a".repeat(64)}`;
const raw = 1_000_000n;
const transferAbi = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const event = (name: string, values: unknown[]) => ({
  address: ctf,
  ...CANONICAL_CTF_ABI.encodeEventLog(name, values),
});
const credit = (value: bigint, from = ctf) => ({
  address: collateral,
  ...transferAbi.encodeEventLog("Transfer", [from, owner, value]),
});
function fixture(token: string): StoredPositionAction {
  return {
    action: "redeem",
    venueId: "limitless",
    ownerAddress: owner,
    createdAt: new Date(1_000_000_000),
    evidenceSnapshot: {},
    planSnapshot: {
      tokenId: `limitless:${token}`,
      outcome: "YES",
      plan: {
        redeemable: true,
        targetAddress: ctf,
        payoutTokenAddress: collateral,
        data: CANONICAL_CTF_ABI.encodeFunctionData("redeemPositions", [
          collateral,
          ethers.ZeroHash,
          ethers.id(`condition-${token}`),
          [1],
        ]),
        expectedPayoutRaw: raw.toString(),
        yesBalanceRaw: raw.toString(),
        noBalanceRaw: "0",
      },
    },
  } as unknown as StoredPositionAction;
}
const a = fixture("17");
const b = fixture("70");
const payout = (token: string, value: bigint) =>
  event("PayoutRedemption", [
    owner,
    collateral,
    ethers.ZeroHash,
    ethers.id(`condition-${token}`),
    [1],
    value,
  ]);
const burn = (token: bigint, amount = raw) =>
  event("TransferSingle", [owner, owner, ethers.ZeroAddress, token, amount]);
const originalReceipt = ethers.JsonRpcProvider.prototype.getTransactionReceipt;
const originalFetch = globalThis.fetch;
const blockHash = ethers.id("position-action-finalized-block");
let finalizedHeight = 100;
let canonicalBlockHash = blockHash;
let failBlockRead = false;
let receiptStatus = 1;
let finalityReads = 0;
let blockTimestamp = 1_000_100;
let logs = [burn(17n), payout("17", raw), payout("70", 0n), credit(raw)];
globalThis.fetch = async (_input, init) => {
  finalityReads += 1;
  const body = JSON.parse(String(init?.body));
  assert.equal(
    body.method,
    "eth_getBlockByNumber",
    "no network allowed outside mocked finality reads",
  );
  if (failBlockRead) throw new Error("Finality fixture read unavailable");
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        number: ethers.toBeHex(
          body.params[0] === "finalized" ? finalizedHeight : 100,
        ),
        hash: canonicalBlockHash,
        timestamp: ethers.toBeHex(blockTimestamp),
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
ethers.JsonRpcProvider.prototype.getTransactionReceipt = async () =>
  ({
    status: receiptStatus,
    blockNumber: 100,
    blockHash,
    hash,
    logs,
  }) as unknown as ethers.TransactionReceipt;
const observe = createEvmPositionActionReceiptObserver(8453);
const read = (operation: StoredPositionAction, submissionStartedAt?: Date) =>
  observe({
    ownerAddress: owner,
    operation,
    submissionStartedAt,
    conditionalTokensAddress: ctf,
    plan: operation.planSnapshot.plan as RedemptionPlan,
    transactionHash: hash,
  });
try {
  failBlockRead = true;
  assert.equal(
    (
      await fetchEmbeddedEthereumTransactionReceipt({
        chainId: 8453,
        txHash: hash,
      })
    )?.succeeded,
    true,
    "other receipt consumers retain their original default behavior",
  );
  assert.equal(
    finalityReads,
    0,
    "finality opt-in must not add reads to unrelated funding/transaction consumers",
  );
  failBlockRead = false;
  finalizedHeight = 99;
  assert.equal(await read(a), null, "mined is not finalized settlement");
  receiptStatus = 0;
  assert.equal(
    await read(a),
    null,
    "a pre-final revert cannot trigger terminal failure/retry",
  );
  finalizedHeight = 100;
  assert.equal(
    (await read(a))?.succeeded,
    false,
    "canonical finalized revert remains a definitive failure",
  );
  receiptStatus = 1;
  finalizedHeight = 101;
  canonicalBlockHash = ethers.id("position-action-orphan-replacement");
  assert.equal(
    await read(a),
    null,
    "an orphaned receipt cannot become terminal",
  );
  failBlockRead = true;
  await assert.rejects(read(a), /Finality fixture read unavailable/);
  failBlockRead = false;
  canonicalBlockHash = blockHash;
  assert.equal(
    (await read(a))?.evidence.finality,
    "finalized",
    "the same operation recovers after RPC/finality evidence is available",
  );
  assert.equal((await read(a))?.evidence.blockHash, blockHash);
  blockTimestamp = 999_999;
  assert.equal(
    (await read(a))?.evidence.receiptPrecedesClaim,
    true,
    "a finalized historical receipt is not this action's success or revert",
  );
  receiptStatus = 0;
  assert.equal(
    (await read(a))?.evidence.receiptPrecedesClaim,
    true,
    "an old revert cannot fail the new action",
  );
  receiptStatus = 1;
  blockTimestamp = 1_000_000;
  assert.equal(
    (await read(a))?.actualPayoutRaw,
    "1000000",
    "whole-second chain precision includes the claim's second",
  );
  const claimedAt = new Date(1_000_100_500);
  assert.equal(
    (await read(a, claimedAt))?.evidence.receiptPrecedesClaim,
    true,
    "new claims use the durable claim time, not earlier action creation",
  );
  blockTimestamp = 1_000_100;
  assert.equal((await read(a, claimedAt))?.actualPayoutRaw, "1000000");
  blockTimestamp = 1_100_000;
  assert.equal(
    (await read(a, claimedAt))?.actualPayoutRaw,
    "1000000",
    "late mining and reporting remain valid, without a maximum age",
  );
  blockTimestamp = 1_000_100;
  assert.equal((await read(a))?.actualPayoutRaw, "1000000");
  assert.equal(
    (await read(b))?.actualPayoutRaw,
    null,
    "a transaction-wide credit cannot complete the other position in a bundle",
  );
  logs = [
    burn(17n),
    payout("17", raw),
    burn(70n),
    payout("70", raw),
    credit(raw * 2n),
  ];
  assert.equal((await read(a))?.actualPayoutRaw, "1000000");
  assert.equal(
    (await read(b))?.actualPayoutRaw,
    "1000000",
    "each valid bundled position receives its own payout, not the total credit",
  );
  logs.push(credit(raw, "0x00000000000000000000000000000000000000d1"));
  assert.equal(
    (await read(a))?.actualPayoutRaw,
    "1000000",
    "unrelated ERC20 credits do not inflate a redemption",
  );
  logs = [payout("17", raw), credit(raw)];
  assert.equal(
    (await read(a))?.actualPayoutRaw,
    null,
    "payout requires the exact frozen token burn",
  );
  logs = [burn(17n, raw * 2n), payout("17", raw * 2n), credit(raw * 2n)];
  assert.equal(
    (await read(a))?.actualPayoutRaw,
    "2000000",
    "same immutable CTF action redeems additional incoming shares and reports actual payout",
  );
  logs = [burn(17n, raw / 2n), payout("17", raw / 2n), credit(raw / 2n)];
  assert.equal(
    (await read(a))?.actualPayoutRaw,
    null,
    "burn/payout below the frozen expectation remains unverified",
  );
  console.log(
    "[position-action-receipt-evidence-tests] real observer: single/bundled identity, zero-payout, missing burn and unrelated credits passed",
  );
} finally {
  ethers.JsonRpcProvider.prototype.getTransactionReceipt = originalReceipt;
  globalThis.fetch = originalFetch;
}
