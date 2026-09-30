import assert from "node:assert/strict";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ethers } from "ethers";
import {
  finalizedSolanaCredit,
  ownedErc20SourceDebit,
  parseLegacyDebridgeDestination,
  sameSolanaSwapMessage,
  sumSuccessfulNativeTraceTo,
  type LegacyDebridgeRow,
} from "../../legacy/debridge-evidence-reconciler.js";
import { matchesOrphanPolymarketOrder } from "../../reconciliation/polymarket-orphan-attempt-reconciler.js";
import type { PolymarketOpenOrder } from "../../../services/polymarket-clob-l2.js";

const id = `0x${"a".repeat(64)}`,
  source = `0x${"b".repeat(64)}`,
  destination = `0x${"c".repeat(64)}`;
const owner = `0x${"1".repeat(40)}`,
  recipient = `0x${"2".repeat(40)}`,
  tokenIn = `0x${"3".repeat(40)}`,
  tokenOut = `0x${"4".repeat(40)}`;
const wrap = (stringValue: string) => ({ stringValue });
const row = {
  id: "synthetic-row",
  user_id: "synthetic-user",
  swap_type: "cross_chain",
  status: "submitted",
  src_chain_id: "137",
  dst_chain_id: "8453",
  src_token: tokenIn,
  dst_token: tokenOut,
  amount_in: "2278340",
  min_amount_out: null,
  tx_hash_src: source,
  order_id: `0x${"d".repeat(64)}`,
  metadata: { senderAddress: owner, recipientAddress: recipient },
} satisfies LegacyDebridgeRow;
// Historical response shape: quote ID differs from source-discovered ID;
// preswap changes token, and executed output is 1994268, not quoted 2000000.
const payload = {
  orderId: wrap(id),
  createdSrcEventMetadata: { transactionHash: wrap(source) },
  giveOfferWithMetadata: {
    chainId: wrap("137"),
    tokenAddress: wrap(tokenOut),
    amount: wrap("2273770"),
  },
  preswapData: { inTokenAddress: wrap(tokenIn), inAmount: wrap("2278340") },
  takeOfferWithMetadata: {
    chainId: wrap("8453"),
    tokenAddress: wrap(tokenOut),
    amount: wrap("1994268"),
  },
  actualFulfillAmount: wrap("1994268"),
  receiverDst: wrap(recipient),
  fulfilledDstEventMetadata: { transactionHash: wrap(destination) },
  state: "ClaimedUnlock",
  externalCallState: "NoExtCall",
};
assert.equal(
  parseLegacyDebridgeDestination(row, payload, id)?.amountRaw,
  "1994268",
);
const transferAbi = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const debitLog = (from: string, value: bigint) => ({
  address: tokenIn,
  ...transferAbi.encodeEventLog("Transfer", [from, recipient, value]),
});
assert.deepEqual(
  ownedErc20SourceDebit(
    [debitLog(owner, 2278340n)],
    [owner, owner.toUpperCase()],
    tokenIn,
  ),
  { owner, raw: "2278340" },
);
assert.equal(
  ownedErc20SourceDebit([debitLog(owner, 2278340n)], [recipient], tokenIn),
  null,
);
assert.equal(
  ownedErc20SourceDebit(
    [debitLog(owner, 2278340n), debitLog(recipient, 1n)],
    [owner, recipient],
    tokenIn,
  ),
  null,
);
for (const changed of [
  { ...payload, orderId: wrap(row.order_id) },
  { ...payload, receiverDst: wrap(owner) },
  {
    ...payload,
    createdSrcEventMetadata: { transactionHash: wrap(destination) },
  },
  { ...payload, actualFulfillAmount: { bigIntegerValue: 1994268 } },
  { ...payload, state: "Created" },
  { ...payload, externalCallState: "Failed" },
  { ...payload, preswapData: { ...payload.preswapData, inAmount: wrap("1") } },
])
  assert.equal(parseLegacyDebridgeDestination(row, changed, id), null);

const same = {
  ...row,
  swap_type: "same_chain",
  dst_chain_id: "137",
  dst_token: ethers.ZeroAddress,
  amount_in: "45555",
  metadata: { senderAddress: owner, recipientAddress: owner },
};
const swapPayload = {
  transactionHash: wrap(source),
  chainId: wrap("137"),
  sender: wrap(owner),
  recipient: wrap(owner),
  tokenIn: { tokenAddress: wrap(tokenIn), amount: wrap("45555") },
  tokenOut: {
    tokenAddress: wrap(ethers.ZeroAddress),
    amount: {
      stringValue: "508667387629200707",
      bigIntegerValue: 508667387629200700,
    },
  },
};
assert.equal(
  parseLegacyDebridgeDestination(same, swapPayload, null)?.amountRaw,
  "508667387629200707",
);
assert.equal(
  sumSuccessfulNativeTraceTo(
    {
      type: "CALL",
      value: "0x0",
      calls: [
        { type: "CALL", to: owner, value: "0x10" },
        { type: "DELEGATECALL", to: owner, value: "0x10" },
      ],
    },
    owner,
  ),
  16n,
);
assert.equal(
  sumSuccessfulNativeTraceTo(
    { type: "CALL", error: "reverted", to: owner, value: "0x10" },
    owner,
  ),
  null,
);
assert.equal(
  sumSuccessfulNativeTraceTo(
    { type: "CALL", to: owner, value: "wrong" },
    owner,
  ),
  null,
);

const solOwner = Keypair.generate().publicKey;
const solMint = Keypair.generate().publicKey.toBase58();
const sol = {
  slot: 42,
  transaction: {
    message: { accountKeys: [{ pubkey: solOwner.toBase58(), signer: true }] },
  },
  meta: {
    err: null,
    preBalances: [1000000],
    postBalances: [2000000],
    preTokenBalances: [],
    postTokenBalances: [
      {
        accountIndex: 0,
        owner: solOwner.toBase58(),
        mint: solMint,
        uiTokenAmount: { amount: "935461", decimals: 6 },
      },
    ],
  },
};
assert.equal(
  finalizedSolanaCredit(sol, solOwner.toBase58(), solMint),
  "935461",
);
assert.equal(
  finalizedSolanaCredit(
    sol,
    solOwner.toBase58(),
    "11111111111111111111111111111111",
  ),
  "1000000",
);
assert.equal(
  finalizedSolanaCredit(
    { ...sol, meta: { ...sol.meta, err: { failed: true } } },
    solOwner.toBase58(),
    solMint,
  ),
  null,
);
assert.equal(
  finalizedSolanaCredit(sol, Keypair.generate().publicKey.toBase58(), solMint),
  null,
);
const transaction = (lamports: number, blockhash: string) =>
  Buffer.from(
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: solOwner,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: solOwner,
            toPubkey: solOwner,
            lamports,
          }),
        ],
      }).compileToV0Message(),
    ).serialize(),
  ).toString("base64");
const first = transaction(100, Keypair.generate().publicKey.toBase58());
assert.equal(
  sameSolanaSwapMessage(
    first,
    transaction(100, Keypair.generate().publicKey.toBase58()),
  ),
  true,
);
assert.equal(
  sameSolanaSwapMessage(
    first,
    transaction(101, Keypair.generate().publicKey.toBase58()),
  ),
  false,
);
assert.equal(sameSolanaSwapMessage(first, "broken"), false);

const scope = {
  owner,
  signer: owner,
  tokenId:
    "50862799703982327636174441241062907649998751737045006653560124656563256528691",
  spendRaw: "1049962",
};
const order = {
  id,
  makerAddress: owner,
  assetId: scope.tokenId,
  side: "BUY",
  price: "0.5",
  originalSize: "2",
} as PolymarketOpenOrder;
assert.equal(matchesOrphanPolymarketOrder(id, scope, order), true);
for (const wrong of [
  { ...order, id: source },
  { ...order, makerAddress: recipient },
  { ...order, assetId: "1" },
  { ...order, side: "SELL" },
  { ...order, originalSize: "3" },
  { ...order, price: "NaN" },
])
  assert.equal(matchesOrphanPolymarketOrder(id, scope, wrong), false);
console.log(
  "[legacy-debridge-evidence-tests] historical DTO precision, source/owner identity, canonical credit, trace and immutable Solana messages passed",
);
