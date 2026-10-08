import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Pool } from "@hunch/infra";
import {
  factsFromEvidence,
  rawDecimal,
  readVerifiedBuy,
  repairVerifiedBuys,
  type VerifiedPurchaseEvidence,
} from "./services/verified-buy.js";
import {
  combinePurchaseEvidence,
  parseEvmClobBuyEvidence,
  parseSolanaBuyEvidence,
} from "./services/verified-buy-evidence.js";
import { verifySocialSolanaSubmission } from "./services/social-signed-solana.js";
import { buildSocialInstrument } from "./services/social-instrument.js";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";
import { socialSourceRefSchema } from "./schemas/social-trade.js";
import { requireSameInstrument } from "./services/social-copy.js";
import type { PreparedTrade } from "./services/trading-types.js";
import {
  observeVerifiedBuySource,
  terminalZeroFill,
  type VerifiedBuyObserverDependencies,
  type VerifiedBuySourceRow,
} from "./services/verified-buy-observer.js";

const owner = `0x${"1".repeat(40)}`,
  exchange = `0x${"2".repeat(40)}`,
  position = `0x${"3".repeat(40)}`;
const hash = `0x${"a".repeat(64)}`,
  txHash = `0x${"b".repeat(64)}`;
const instrument = {
  venue: "polymarket" as const,
  marketId: "polymarket:1",
  tokenId: "123",
  outcome: "YES" as const,
  generation: `137:${position}:v2`,
  expiry: null,
};
const base: VerifiedPurchaseEvidence = {
  canonicalPurchaseKey: `polymarket:137:${exchange}:${hash}`,
  instrument,
  owner,
  notionalRaw: 10000000n,
  grossSharesRaw: 20000000n,
  netSharesRaw: 19900000n,
  collateralDecimals: 6,
  shareDecimals: 6,
  feesUsdRaw: null,
  purchasedAt: "2026-10-08T00:00:00.000Z",
  evidenceIds: [`${txHash}:0`],
};
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, run: () => void | Promise<void>) =>
  tests.push([name, run]);
test("exact decimals retain large balances and unknown fees", () => {
  const facts = factsFromEvidence(base);
  assert.equal(facts.grossNotionalUsd, "10");
  assert.equal(facts.entryPrice, "0.5");
  assert.equal(facts.netShares, "19.9");
  assert.equal(facts.feesUsd, null);
  assert.equal(
    rawDecimal(9007199254740993000001n, 6),
    "9007199254740993.000001",
  );
  assert.equal(
    facts.evidenceRevision,
    factsFromEvidence(base, new Date(0)).evidenceRevision,
  );
});
test("partial executions combine once and do not change purchase identity", () => {
  const combined = combinePurchaseEvidence([
    base,
    { ...base, notionalRaw: 999999n, evidenceIds: [`${txHash}:1`] },
  ]);
  assert.equal(combined?.grossNotionalUsd, "10.999999");
  assert.equal(combined?.canonicalPurchaseKey, base.canonicalPurchaseKey);
  assert.equal(combinePurchaseEvidence([base, base]), null);
  assert.equal(
    combinePurchaseEvidence([
      base,
      { ...base, canonicalPurchaseKey: "another", evidenceIds: ["second"] },
    ]),
    null,
  );
});
const fill = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)",
]);
const transfer = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);
const zero = `0x${"0".repeat(64)}`;
const fillLog = (orderHash = hash, index = 0) => ({
  address: exchange,
  index,
  ...fill.encodeEventLog("OrderFilled", [
    orderHash,
    owner,
    exchange,
    0,
    123,
    10000000,
    20000000,
    100000,
    zero,
    zero,
  ]),
});
const tokenLog = {
  address: position,
  index: 1,
  ...transfer.encodeEventLog("TransferSingle", [
    exchange,
    exchange,
    owner,
    123,
    19900000,
  ]),
};
const args = {
  txHash,
  owner,
  orderHash: hash,
  exchangeAddress: exchange,
  positionContract: position,
  tokenId: "123",
  chainId: 137,
  instrument,
  purchasedAt: base.purchasedAt,
};
test("CLOB proof binds exact order hash and actual net received shares", () => {
  const evidence = parseEvmClobBuyEvidence({
    ...args,
    receipt: { hash: txHash, status: 1, logs: [fillLog(), tokenLog] },
  });
  assert.equal(evidence?.notionalRaw, 10000000n);
  assert.equal(evidence?.netSharesRaw, 19900000n);
  assert.equal(
    parseEvmClobBuyEvidence({
      ...args,
      receipt: { hash: txHash, status: 0, logs: [fillLog(), tokenLog] },
    }),
    null,
  );
  assert.equal(
    parseEvmClobBuyEvidence({
      ...args,
      orderHash: zero,
      receipt: { hash: txHash, status: 1, logs: [fillLog(), tokenLog] },
    }),
    null,
  );
  assert.equal(
    parseEvmClobBuyEvidence({
      ...args,
      owner: exchange,
      receipt: { hash: txHash, status: 1, logs: [fillLog(), tokenLog] },
    }),
    null,
  );
});
test("receipt wallet delta never allocates two same-token orders heuristically", () => {
  assert.equal(
    parseEvmClobBuyEvidence({
      ...args,
      receipt: {
        hash: txHash,
        status: 1,
        logs: [fillLog(), tokenLog, fillLog(zero, 2)],
      },
    }),
    null,
  );
});
test("a buy combined with a same-token sell/transfer never invents net acquired shares", () => {
  const outgoing = {
    address: position,
    index: 2,
    ...transfer.encodeEventLog("TransferSingle", [
      exchange,
      owner,
      exchange,
      123,
      1000000,
    ]),
  };
  assert.equal(
    parseEvmClobBuyEvidence({
      ...args,
      receipt: {
        hash: txHash,
        status: 1,
        logs: [fillLog(), tokenLog, outgoing],
      },
    }),
    null,
  );
});
test("Solana provider quantities are corroborated by finalized owner deltas", () => {
  const balance = (mint: string, amount: string) => ({
    accountIndex: mint === "usd" ? 0 : 1,
    mint,
    owner: "owner",
    uiTokenAmount: { amount, decimals: 6 },
  });
  const transaction = {
    blockTime: 1791417600,
    transaction: {
      signatures: ["signature"],
      message: { accountKeys: [{ pubkey: "owner", signer: true }] },
    },
    meta: {
      err: null,
      preTokenBalances: [balance("usd", "10010000"), balance("outcome", "0")],
      postTokenBalances: [balance("usd", "0"), balance("outcome", "19900000")],
    },
  };
  const input = {
    transaction,
    signature: "signature",
    initiatingSignature: "signature",
    owner: "owner",
    collateralMint: "usd",
    outcomeMint: "outcome",
    instrument: { ...instrument, venue: "kalshi" as const },
  };
  assert.equal(parseSolanaBuyEvidence(input), null);
  const evidence = parseSolanaBuyEvidence({
    ...input,
    grossNotionalRaw: 10000000n,
    grossSharesRaw: 20000000n,
  });
  assert.equal(evidence?.feesUsdRaw, 10000n);
  assert.equal(evidence?.netSharesRaw, 19900000n);
  assert.equal(
    parseSolanaBuyEvidence({
      ...input,
      owner: "another",
      grossNotionalRaw: 10000000n,
      grossSharesRaw: 20000000n,
    }),
    null,
  );
});
test("signed transaction must preserve prepared message and valid owner signature", () => {
  const key = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: key.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const prepared = Buffer.from(transaction.serialize()).toString("base64");
  transaction.sign([key]);
  const signed = Buffer.from(transaction.serialize()).toString("base64");
  assert.ok(
    verifySocialSolanaSubmission({
      preparedTransaction: prepared,
      signedTransaction: signed,
      owner: key.publicKey.toBase58(),
    }).signature,
  );
  assert.throws(() =>
    verifySocialSolanaSubmission({
      preparedTransaction: prepared,
      signedTransaction: prepared,
      owner: key.publicKey.toBase58(),
    }),
  );
  assert.throws(() =>
    verifySocialSolanaSubmission({
      preparedTransaction: prepared,
      signedTransaction: signed,
      owner: Keypair.generate().publicKey.toBase58(),
    }),
  );
});
test("legacy fulfilled rows and malformed facts are never publication proof", async () => {
  const db = {
    query: async () => ({
      rows: [
        {
          verified_buy_state: "verified",
          verified_buy_facts: { status: "fulfilled", amount: 999 },
          verified_buy_reason: null,
        },
      ],
    }),
  } as unknown as Pick<Pool, "query">;
  assert.equal(
    (
      await readVerifiedBuy(db, {
        userId: "u",
        purchaseRef: { kind: "execution", id: "i" },
      })
    ).state,
    "pending",
  );
});
test("lost lease does not apply stale publication or Copy projections", async () => {
  let claims = 0,
    stored = 0;
  const db = {
    query: async (sql: string) => ({
      rows:
        sql.includes("with due_purchase") && claims++ === 0
          ? [
              {
                id: "i",
                user_id: "u",
                verified_buy_lease_token: "lease",
                verified_buy_attempts: 1,
              },
            ]
          : [],
    }),
  } as unknown as Pick<Pool, "query">;
  const result = await repairVerifiedBuys(db, {
    batchSize: 1,
    leaseSeconds: 60,
    retrySeconds: 30,
    verifiedRecheckSeconds: 300,
    observe: async () => ({
      state: "verified",
      facts: factsFromEvidence(base),
    }),
    onStored: async () => {
      stored++;
    },
  });
  assert.equal(result.leaseLost, 1);
  assert.equal(stored, 0);
});
test("publication freezes explicit generation, never infers legacy metadata", () => {
  assert.equal(
    buildSocialInstrument({
      marketId: "polymarket:1",
      venue: "polymarket",
      outcome: "YES",
      tokenId: "123",
      expiry: null,
      metadata: {},
    }),
    null,
  );
  const protocol = resolvePolymarketMarketAssets({
    version: "v1",
    conditionId: zero,
    clobTokenIds: ["123", "456"],
    outcomes: ["Yes", "No"],
    negRisk: false,
  });
  assert.equal(
    buildSocialInstrument({
      marketId: "polymarket:1",
      venue: "polymarket",
      outcome: "YES",
      tokenId: "123",
      expiry: null,
      metadata: { polymarketProtocol: protocol },
    })?.tokenId,
    "123",
  );
  assert.equal(
    buildSocialInstrument({
      marketId: "polymarket:1",
      venue: "polymarket",
      outcome: "NO",
      tokenId: "123",
      expiry: null,
      metadata: { polymarketProtocol: protocol },
    }),
    null,
  );
  assert.equal(
    socialSourceRefSchema.safeParse({ kind: "context", id: "x" }).success,
    false,
  );
});
test("Copy rejects changed Limitless ledger generation while preserving exact one", () => {
  const copied = {
    ...instrument,
    venue: "limitless" as const,
    tokenId: "limitless:123",
    generation: `8453:${position}:limitless:123`,
  };
  const prepared = {
    intent: {
      action: "BUY",
      venue: "limitless",
      target: {
        marketId: copied.marketId,
        tokenId: copied.tokenId,
        outcome: "YES",
      },
    },
  } as PreparedTrade;
  assert.doesNotThrow(() =>
    requireSameInstrument(prepared, copied, {
      limitlessPositionContract: position,
    }),
  );
  assert.throws(
    () =>
      requireSameInstrument(prepared, copied, {
        limitlessPositionContract: exchange,
      }),
    /copy_generation_mismatch/,
  );
});
const partialTxHash = `0x${"c".repeat(64)}`;
const polymarketContext = buildPolymarketAssetContext(
  instrument.marketId,
  resolvePolymarketMarketAssets({
    version: "v1",
    conditionId: zero,
    clobTokenIds: ["123", "456"],
    outcomes: ["Yes", "No"],
    negRisk: false,
  }),
  "123",
);
const polymarketFill = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)",
]);
function polymarketReceipt(receiptHash: string, notionalRaw = 10000000n) {
  return {
    hash: receiptHash,
    status: 1,
    logs: [
      {
        address: polymarketContext.exchangeAddress,
        index: 0,
        ...polymarketFill.encodeEventLog("OrderFilled", [
          hash,
          owner,
          polymarketContext.exchangeAddress,
          0,
          123,
          notionalRaw,
          notionalRaw * 2n,
          100000,
        ]),
      },
      {
        address: polymarketContext.positionContract,
        index: 1,
        ...transfer.encodeEventLog("TransferSingle", [
          polymarketContext.exchangeAddress,
          polymarketContext.exchangeAddress,
          owner,
          123,
          notionalRaw * 2n - 100000n,
        ]),
      },
    ],
  };
}
type PolymarketFill = Awaited<
  ReturnType<VerifiedBuyObserverDependencies["readPolymarketFills"]>
>[number];
const confirmedFill = (receiptHash: string): PolymarketFill => ({
  provider_tx_hash: receiptHash,
  provider_status: "CONFIRMED",
});
async function observePolymarketFixture(
  fills: PolymarketFill[],
  receipts: Record<string, unknown>,
) {
  const receiptReads: string[] = [];
  const db = {
    query: async (sql: string) => {
      assert.match(sql, /from order_fills/);
      return { rows: fills };
    },
  } as unknown as Pick<Pool, "query">;
  const row: VerifiedBuySourceRow = {
    id: "polymarket-row",
    user_id: "user",
    venue: "polymarket",
    wallet_address: owner,
    order_hash: hash,
    venue_order_id: hash,
    token_id: "123",
    side: "BUY",
    order_payload: { assetContext: polymarketContext },
    client_order_id: null,
    tx_signature: null,
    market_id: instrument.marketId,
    outcome: "YES",
    expiration_time: null,
    market_metadata: {},
    input_mint: null,
    output_mint: null,
  };
  const deps: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: 10,
    limitlessPositionContract: position,
    limitlessExchangeAddress: exchange,
    solanaCollateralMint: "usd",
    readEvmReceipt: async (chainId, receiptHash) => {
      assert.equal(chainId, 137);
      assert.ok(
        Object.hasOwn(receipts, receiptHash),
        "Unexpected receipt read",
      );
      receiptReads.push(receiptHash);
      return receipts[receiptHash] === null
        ? null
        : { receipt: receipts[receiptHash], timestamp: base.purchasedAt };
    },
    readPolymarketFills: async () => fills,
    readLimitlessOrder: async () => null,
    readDflowOrder: async () => null,
    readFinalizedSolanaTransaction: async () => null,
  };
  return {
    observation: await observeVerifiedBuySource(db, deps, row),
    receiptReads,
  };
}
test("Polymarket successful fills survive another provider-failed attempt", async () => {
  for (const failedHash of [null, partialTxHash]) {
    const { observation, receiptReads } = await observePolymarketFixture(
      [
        confirmedFill(txHash),
        { provider_tx_hash: failedHash, provider_status: "FAILED" },
      ],
      { [txHash]: polymarketReceipt(txHash) },
    );
    assert.equal(observation.state, "verified");
    if (observation.state !== "verified")
      throw new Error("Expected proven partial buy");
    assert.equal(observation.facts.grossNotionalUsd, "10");
    assert.equal(observation.facts.grossShares, "20");
    assert.equal(observation.facts.netShares, "19.9");
    assert.deepEqual(observation.facts.evidenceIds, [`137:${txHash}:0`]);
    assert.deepEqual(receiptReads, [txHash]);
  }
});
test("Polymarket finalized reverted fills do not revoke successful fills", async () => {
  const fills = [confirmedFill(txHash), confirmedFill(partialTxHash)];
  for (const orderedFills of [fills, [...fills].reverse()]) {
    const { observation } = await observePolymarketFixture(orderedFills, {
      [txHash]: polymarketReceipt(txHash),
      [partialTxHash]: { hash: partialTxHash, status: "0x0", logs: [] },
    });
    assert.equal(observation.state, "verified");
    if (observation.state !== "verified")
      throw new Error("Expected proven partial buy");
    assert.equal(observation.facts.grossNotionalUsd, "10");
    assert.equal(observation.facts.netShares, "19.9");
    assert.deepEqual(observation.facts.evidenceIds, [`137:${txHash}:0`]);
  }
});
test("Polymarket all failed attempts revoke without treating status as purchase proof", async () => {
  assert.deepEqual(
    (
      await observePolymarketFixture(
        [
          { provider_tx_hash: null, provider_status: "FAILED" },
          { provider_tx_hash: txHash, provider_status: "failed" },
        ],
        {},
      )
    ).observation,
    { state: "revoked", reason: "provider_fill_failed" },
  );
  for (const secondFill of [
    confirmedFill(partialTxHash),
    {
      provider_tx_hash: null,
      provider_status: "FAILED",
    },
  ]) {
    assert.deepEqual(
      (
        await observePolymarketFixture([confirmedFill(txHash), secondFill], {
          [txHash]: { hash: txHash, status: 0, logs: [] },
          [partialTxHash]: { hash: partialTxHash, status: 0, logs: [] },
        })
      ).observation,
      { state: "revoked", reason: "finalized_receipt_failed" },
    );
  }
});
test("Polymarket lost partial-fill proof corrects facts and revision below publication minimum", async () => {
  const full = (
    await observePolymarketFixture(
      [confirmedFill(txHash), confirmedFill(partialTxHash)],
      {
        [txHash]: polymarketReceipt(txHash, 6000000n),
        [partialTxHash]: polymarketReceipt(partialTxHash),
      },
    )
  ).observation;
  assert.equal(full.state, "verified");
  if (full.state !== "verified") throw new Error("Expected complete buy proof");
  assert.equal(full.facts.grossNotionalUsd, "16");
  for (const secondFill of [
    confirmedFill(partialTxHash),
    {
      provider_tx_hash: partialTxHash,
      provider_status: "FAILED",
    },
  ]) {
    const partial = (
      await observePolymarketFixture([confirmedFill(txHash), secondFill], {
        [txHash]: polymarketReceipt(txHash, 6000000n),
        [partialTxHash]: { hash: partialTxHash, status: 0, logs: [] },
      })
    ).observation;
    assert.equal(partial.state, "verified");
    if (partial.state !== "verified")
      throw new Error("Expected remaining buy proof");
    assert.equal(partial.facts.grossNotionalUsd, "6");
    assert.equal(partial.facts.grossShares, "12");
    assert.equal(partial.facts.netShares, "11.9");
    assert.equal(
      partial.facts.canonicalPurchaseKey,
      full.facts.canonicalPurchaseKey,
    );
    assert.notEqual(
      partial.facts.evidenceRevision,
      full.facts.evidenceRevision,
    );
    assert.deepEqual(partial.facts.evidenceIds, [`137:${txHash}:0`]);
  }
});
test("Polymarket incomplete partial-fill evidence stays pending alongside proven fills", async () => {
  for (const [secondFill, secondReceipt, reason] of [
    [
      { provider_tx_hash: null, provider_status: "CONFIRMED" },
      null,
      "fill_transaction_identity_missing",
    ],
    [
      { provider_tx_hash: partialTxHash, provider_status: "MINED" },
      null,
      "provider_settlement_pending",
    ],
    [confirmedFill(partialTxHash), null, "receipt_pending"],
    [
      confirmedFill(partialTxHash),
      { hash: partialTxHash, status: 1, logs: [] },
      "receipt_exact_fill_unavailable",
    ],
    [
      confirmedFill(partialTxHash),
      { hash: txHash, status: 0, logs: [] },
      "receipt_exact_fill_unavailable",
    ],
  ] as const) {
    assert.deepEqual(
      (
        await observePolymarketFixture([confirmedFill(txHash), secondFill], {
          [txHash]: polymarketReceipt(txHash),
          [partialTxHash]: secondReceipt,
        })
      ).observation,
      { state: "pending", reason },
    );
  }
  assert.deepEqual(
    (
      await observePolymarketFixture(
        [
          { provider_tx_hash: null, provider_status: "FAILED" },
          { provider_tx_hash: partialTxHash, provider_status: "MINED" },
        ],
        {},
      )
    ).observation,
    { state: "pending", reason: "provider_settlement_pending" },
  );
});
test("provider confirmed status cannot override a finalized reverted receipt", async () => {
  const deps: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: 10,
    limitlessPositionContract: position,
    limitlessExchangeAddress: exchange,
    solanaCollateralMint: "usd",
    readEvmReceipt: async () => ({
      receipt: { hash: txHash, status: 0, logs: [] },
      timestamp: base.purchasedAt,
    }),
    readLimitlessOrder: async () => ({
      status: "found",
      clientOrderId: "client",
      orderId: "order",
      data: {
        order: {
          order: { orderHash: hash },
          execution: { txHash, settlementStatus: "CONFIRMED" },
        },
      },
    }),
    readDflowOrder: async () => null,
    readPolymarketFills: async () => [],
    readFinalizedSolanaTransaction: async () => null,
  };
  const row: VerifiedBuySourceRow = {
    id: "row",
    user_id: "user",
    venue: "limitless",
    wallet_address: owner,
    order_hash: null,
    venue_order_id: "order",
    token_id: "limitless:123",
    side: "BUY",
    order_payload: {},
    client_order_id: "client",
    tx_signature: null,
    market_id: "limitless:market",
    outcome: "YES",
    expiration_time: null,
    market_metadata: {},
    input_mint: null,
    output_mint: null,
  };
  const db = { query: async () => ({ rows: [] }) } as unknown as Pick<
    Pool,
    "query"
  >;
  assert.equal(
    (await observeVerifiedBuySource(db, deps, row)).state,
    "revoked",
  );
  assert.equal(
    (
      await observeVerifiedBuySource(
        db,
        { ...deps, readEvmReceipt: async () => null },
        row,
      )
    ).state,
    "pending",
  );
  assert.equal(
    (
      await observeVerifiedBuySource(
        db,
        {
          ...deps,
          readLimitlessOrder: async () => ({
            status: "found",
            clientOrderId: "client",
            orderId: "order",
            data: { order: { execution: { settlementStatus: "FAILED" } } },
          }),
        },
        row,
      )
    ).state,
    "revoked",
  );
});
test("authoritative zero fills terminate; canceled partial/missing results do not", () => {
  assert.equal(
    terminalZeroFill({
      status: "CANCELLED",
      filledQuantity: "0.000",
      evidenceCount: 0,
    }),
    true,
  );
  assert.equal(
    terminalZeroFill({
      status: "CANCELLED",
      filledQuantity: "0.1",
      evidenceCount: 0,
    }),
    false,
  );
  assert.equal(
    terminalZeroFill({
      status: "CANCELLED",
      filledQuantity: null,
      evidenceCount: 0,
    }),
    false,
  );
  assert.equal(
    terminalZeroFill({
      status: "CANCELLED",
      filledQuantity: "0",
      evidenceCount: 1,
    }),
    false,
  );
  assert.equal(
    terminalZeroFill({ status: "OPEN", filledQuantity: "0", evidenceCount: 0 }),
    false,
  );
});
test("Limitless status envelope proves zero fills; partial/missing evidence stays pending", async () => {
  const db = { query: async () => ({ rows: [] }) } as unknown as Pick<
    Pool,
    "query"
  >;
  const row: VerifiedBuySourceRow = {
    id: "row",
    user_id: "u",
    venue: "limitless",
    wallet_address: owner,
    order_hash: null,
    venue_order_id: "order",
    token_id: "limitless:123",
    side: "BUY",
    order_payload: {},
    client_order_id: "client",
    tx_signature: null,
    market_id: "limitless:m",
    outcome: "YES",
    expiration_time: null,
    market_metadata: {},
    input_mint: null,
    output_mint: null,
  };
  const response = (quantity: string | null, matches: unknown = []) => ({
    status: "found",
    clientOrderId: "client",
    orderId: "order",
    data: {
      order: {
        order: { orderHash: hash, status: "cancelled" },
        execution: {
          matched: false,
          totalsRaw: { contractsGross: quantity, usdGross: "0" },
        },
        makerMatches: matches,
      },
    },
  });
  const deps: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: 10,
    limitlessPositionContract: position,
    limitlessExchangeAddress: exchange,
    solanaCollateralMint: "usd",
    readEvmReceipt: async () => {
      throw new Error("Zero-fill must not read nonexistent receipt");
    },
    readPolymarketFills: async () => [],
    readDflowOrder: async () => null,
    readFinalizedSolanaTransaction: async () => null,
    readLimitlessOrder: async () => response("0"),
  };
  assert.deepEqual(await observeVerifiedBuySource(db, deps, row), {
    state: "revoked",
    reason: "provider_terminal_zero_fill",
  });
  for (const payload of [response("1"), response(null), response("0", null)])
    assert.equal(
      (
        await observeVerifiedBuySource(
          db,
          { ...deps, readLimitlessOrder: async () => payload },
          row,
        )
      ).state,
      "pending",
    );
  assert.deepEqual(
    await observeVerifiedBuySource(db, deps, { ...row, venue: "kalshi" }),
    { state: "pending", reason: "dflow_evidence_unsupported" },
  );
});
for (const [name, run] of tests) {
  await run();
  console.log(`✓ ${name}`);
}
console.log(`Verified buy: ${tests.length} checks passed`);
