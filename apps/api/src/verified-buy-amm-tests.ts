import assert from "node:assert/strict";
import { Interface } from "ethers";
import type { Pool } from "@hunch/infra";
import {
  observeVerifiedBuySource,
  type VerifiedBuySourceRow,
  type VerifiedBuyObserverDependencies,
} from "./services/verified-buy-observer.js";

const owner = `0x${"1".repeat(40)}`,
  market = `0x${"2".repeat(40)}`,
  position = `0x${"3".repeat(40)}`,
  txHash = `0x${"a".repeat(64)}`;
const amm = new Interface([
  "event FPMMBuy(address indexed buyer,uint256 investmentAmount,uint256 feeAmount,uint256 indexed outcomeIndex,uint256 outcomeTokensBought)",
]);
const transfer = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);
const receipt = {
  hash: txHash,
  status: 1,
  logs: [
    {
      address: market,
      index: 0,
      ...amm.encodeEventLog("FPMMBuy", [owner, 10000000, 100000, 0, 20000000]),
    },
    {
      address: position,
      index: 1,
      ...transfer.encodeEventLog("TransferSingle", [
        market,
        market,
        owner,
        123,
        20000000,
      ]),
    },
  ],
};
const source: VerifiedBuySourceRow = {
  id: "row",
  user_id: "user",
  venue: "limitless",
  wallet_address: owner,
  order_hash: null,
  venue_order_id: `amm:${txHash}:fixture`,
  token_id: "limitless:123",
  side: "BUY",
  order_payload: {},
  client_order_id: null,
  tx_signature: null,
  market_id: "limitless:market",
  outcome: "YES",
  expiration_time: null,
  market_metadata: { address: market, tradeType: "amm" },
  input_mint: null,
  output_mint: null,
};
const db = {
  query: async () => {
    throw Error("Unexpected database query");
  },
} as unknown as Pick<Pool, "query">;
const deps: VerifiedBuyObserverDependencies = {
  maxEvidenceItems: 10,
  limitlessPositionContract: position,
  limitlessExchangeAddress: market,
  solanaCollateralMint: "usd",
  readEvmReceipt: async (chainId, hash) => {
    assert.equal(chainId, 8453);
    assert.equal(hash, txHash);
    return { receipt, timestamp: "2026-04-19T12:01:41.000Z" };
  },
  readPolymarketFills: async () => {
    throw Error("Unexpected provider read");
  },
  readLimitlessOrder: async () => {
    throw Error("Unexpected provider read");
  },
  readDflowOrder: async () => {
    throw Error("Unexpected provider read");
  },
  readFinalizedSolanaTransaction: async () => {
    throw Error("Unexpected RPC read");
  },
};
for (const alias of [
  "address",
  "marketAddress",
  "market_address",
  "ammAddress",
  "amm_address",
]) {
  const result = await observeVerifiedBuySource(db, deps, {
    ...source,
    market_metadata: { [alias]: market },
  });
  assert.equal(result.state, "verified");
  if (result.state === "verified") {
    assert.equal(result.facts.grossNotionalUsd, "9.9");
    assert.equal(result.facts.netShares, "20");
    assert.equal(result.facts.feesUsd, "0.1");
  }
}
assert.equal(
  (
    await observeVerifiedBuySource(db, deps, {
      ...source,
      market_metadata: {},
      order_payload: { marketAddress: market },
    })
  ).state,
  "verified",
);
assert.deepEqual(
  await observeVerifiedBuySource(db, deps, {
    ...source,
    market_metadata: { address: "malformed" },
    order_payload: { marketAddress: market },
  }),
  { state: "pending", reason: "amm_contract_missing" },
);
for (const row of [
  { ...source, wallet_address: market },
  { ...source, token_id: "limitless:456" },
  { ...source, outcome: "NO" },
  { ...source, market_metadata: { address: owner, marketAddress: market } },
])
  assert.deepEqual(await observeVerifiedBuySource(db, deps, row), {
    state: "pending",
    reason: "amm_exact_fill_unavailable",
  });
assert.equal(
  (
    await observeVerifiedBuySource(
      db,
      { ...deps, limitlessPositionContract: owner },
      source,
    )
  ).state,
  "pending",
);
assert.deepEqual(
  await observeVerifiedBuySource(
    db,
    { ...deps, readEvmReceipt: async () => null },
    source,
  ),
  { state: "pending", reason: "receipt_pending" },
);
assert.deepEqual(
  await observeVerifiedBuySource(
    db,
    {
      ...deps,
      readEvmReceipt: async () => ({
        receipt: { ...receipt, status: 0 },
        timestamp: "2026-04-19T12:01:41.000Z",
      }),
    },
    source,
  ),
  { state: "revoked", reason: "finalized_receipt_failed" },
);
assert.deepEqual(
  await observeVerifiedBuySource(db, deps, { ...source, side: "SELL" }),
  { state: "pending", reason: "purchase_identity_missing" },
);
console.log(
  "ok - AMM alias recovery retains exact contract, owner, outcome, token, quantities, fees, generation reader and canonical receipt requirements",
);
