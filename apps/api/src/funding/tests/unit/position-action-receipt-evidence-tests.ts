import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { StoredPositionAction } from "../../position-actions/position-action-repository.js";
import { createEvmPositionActionReceiptObserver } from "../../position-actions/venue-driver.js";
import { CANONICAL_CTF_ABI } from "../../position-actions/canonical-redemption-evidence.js";
import type { RedemptionPlan } from "../../../services/redemption-plan.js";

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
let logs = [burn(17n), payout("17", raw), payout("70", 0n), credit(raw)];
globalThis.fetch = async () => {
  throw new Error("Network forbidden in receipt fixtures");
};
ethers.JsonRpcProvider.prototype.getTransactionReceipt = async () =>
  ({
    status: 1,
    blockNumber: 100,
    hash,
    logs,
  }) as unknown as ethers.TransactionReceipt;
const observe = createEvmPositionActionReceiptObserver(8453);
const read = (operation: StoredPositionAction) =>
  observe({
    ownerAddress: owner,
    operation,
    conditionalTokensAddress: ctf,
    plan: operation.planSnapshot.plan as RedemptionPlan,
    transactionHash: hash,
  });
try {
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
