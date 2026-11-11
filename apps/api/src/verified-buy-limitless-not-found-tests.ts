import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { Interface } from "ethers";
import { buildLimitlessClobSubmissionContext } from "./services/limitless-clob-evidence-identity.js";
import {
  observeVerifiedBuySource,
  type VerifiedBuyObserverDependencies,
  type VerifiedBuySourceRow,
} from "./services/verified-buy-observer.js";
import { EvidenceBudgetExhausted } from "./services/verified-buy.js";
import {
  readAnchoredFinalizedBuyReceipt,
  type VerifiedBuyEvmProvider,
} from "./services/verified-buy-evm-receipt.js";
import {
  LIMITLESS_RECEIPT_SEARCH_KEY,
  limitlessReceiptSearchIdentity,
} from "./services/verified-buy-limitless-discovery.js";

const owner = `0x${"1".repeat(40)}`,
  exchange = `0x${"2".repeat(40)}`,
  position = `0x${"3".repeat(40)}`;
const other = `0x${"4".repeat(40)}`,
  txHash = `0x${"a".repeat(64)}`,
  otherHash = `0x${"b".repeat(64)}`;
const order = {
  salt: "7",
  maker: owner,
  signer: owner,
  taker: `0x${"0".repeat(40)}`,
  tokenId: "123",
  makerAmount: "10000000",
  takerAmount: "1",
  expiration: "0",
  nonce: "0",
  feeRateBps: "0",
  side: 0,
  signatureType: 0,
};
const frozen = buildLimitlessClobSubmissionContext(exchange, order);
const fill = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)",
]);
const transfer = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);
const payload = () => ({
  submitted: {
    order: { ...order },
    clientOrderId: "client-order",
    _hunchLimitlessClob: { ...frozen },
    _hunchUpstream: {
      order: { ...order, id: "provider-order" },
      execution: { clientOrderId: "client-order" },
    },
  },
  history: {
    orderId: "provider-order",
    transactionHash: txHash,
    collateralAmount: "999999",
    outcomeTokenAmount: "999999",
  },
});
const receipt = () => ({
  hash: txHash,
  status: 1,
  logs: [
    {
      address: exchange,
      index: 0,
      ...fill.encodeEventLog("OrderFilled", [
        frozen.orderHash,
        owner,
        exchange,
        0,
        123,
        10000000,
        11695903,
        0,
      ]),
    },
    {
      address: position,
      index: 1,
      ...transfer.encodeEventLog("TransferSingle", [
        exchange,
        exchange,
        owner,
        123,
        11597658,
      ]),
    },
  ],
});
const row = (): VerifiedBuySourceRow => ({
  id: "row",
  user_id: "user",
  venue: "limitless",
  wallet_address: owner,
  order_hash: otherHash,
  venue_order_id: "provider-order",
  token_id: "limitless:123",
  side: "BUY",
  order_payload: payload(),
  client_order_id: "client-order",
  tx_signature: null,
  market_id: "market",
  outcome: "YES",
  expiration_time: null,
  market_metadata: { venueExchange: exchange },
  input_mint: null,
  output_mint: null,
});
const absent = () => ({
  status: "not_found",
  orderId: "provider-order",
  clientOrderId: "client-order",
});
type Options = {
  row?: VerifiedBuySourceRow;
  status?: unknown;
  receipt?: unknown | null;
  readError?: Error;
  budget?: number;
  discover?: VerifiedBuyObserverDependencies["discoverLimitlessTransactions"];
  receiptObservation?: VerifiedBuyObserverDependencies["readLimitlessReceipt"];
  anchoredProvider?: VerifiedBuyEvmProvider;
  sharedBudget?: number;
  receiptHash?: string;
  receiptBlock?: { number: number; hash: string };
};
async function observe(options: Options = {}) {
  let available = options.sharedBudget ?? Number.POSITIVE_INFINITY;
  const consume = () => {
    if (available <= 0) throw new EvidenceBudgetExhausted(1, 0);
    available--;
  };
  let providerReads = 0,
    receiptReads = 0,
    reserved = 0;
  const deps: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: 10,
    limitlessPositionContract: position,
    limitlessExchangeAddress: exchange,
    discoverLimitlessTransactions: options.discover,
    readLimitlessReceipt: options.anchoredProvider
      ? (hash, anchor, anchorOnly) =>
          readAnchoredFinalizedBuyReceipt(
            options.anchoredProvider as VerifiedBuyEvmProvider,
            hash,
            anchor,
            consume,
            { anchorOnly: anchorOnly === true },
          )
      : options.receiptObservation,
    solanaCollateralMint: "unused",
    assertEvidenceBudget: (needed) => {
      reserved += needed;
      if (needed > (options.budget ?? 100))
        throw new EvidenceBudgetExhausted(needed, options.budget ?? 100);
      if (needed > available)
        throw new EvidenceBudgetExhausted(needed, available);
    },
    readLimitlessOrder: async () => {
      consume();
      providerReads++;
      if (options.readError) throw options.readError;
      return Object.hasOwn(options, "status") ? options.status : absent();
    },
    readEvmReceipt: async (chain, hash) => {
      receiptReads++;
      assert.equal(chain, 8453);
      assert.equal(hash, options.receiptHash ?? txHash);
      return options.receipt === null
        ? null
        : {
            receipt: options.receipt ?? receipt(),
            timestamp: "2026-11-06T19:48:27.000Z",
            canonicalBlock: options.receiptBlock,
          };
    },
    readFinalizedSolanaTransaction: async () => {
      throw Error("Unexpected Solana read");
    },
    readDflowOrder: async () => {
      throw Error("Unexpected DFlow read");
    },
    readPolymarketFills: async () => {
      throw Error("Unexpected Polymarket read");
    },
  };
  const db = {
    query: async () => {
      throw Error("Pure observation must not write/query DB");
    },
  } as unknown as Pick<Pool, "query">;
  const result = await observeVerifiedBuySource(db, deps, options.row ?? row());
  return { result, providerReads, receiptReads, reserved };
}
let checks = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  checks++;
  console.log("ok - " + name);
}
await test("not_found recovers exact signed receipt, with net fees and no history-amount authority", async () => {
  const observed = await observe();
  assert.equal(observed.result.state, "verified");
  if (observed.result.state !== "verified") throw Error("Expected verified");
  assert.equal(
    observed.result.facts.canonicalPurchaseKey,
    "limitless:clob:8453:provider-order",
  );
  assert.equal(observed.result.facts.grossNotionalUsd, "10");
  assert.equal(observed.result.facts.grossShares, "11.695903");
  assert.equal(observed.result.facts.netShares, "11.597658");
  assert.equal(observed.result.facts.purchasedAt, "2026-11-06T19:48:27.000Z");
  assert.equal(observed.providerReads, 1);
  assert.equal(observed.receiptReads, 1);
  assert.equal(observed.reserved, 3);
});
await test("null, malformed, timeout and found-but-wrong identities never authorize fallback", async () => {
  for (const status of [
    null,
    {},
    { status: "unknown" },
    { status: "not_found", orderId: "other", clientOrderId: "client-order" },
    { status: "not_found", orderId: "provider-order", clientOrderId: "other" },
    { status: "found", orderId: "provider-order", clientOrderId: "other" },
    { status: "found", orderId: "other", clientOrderId: "client-order" },
  ]) {
    const observed = await observe({ status });
    assert.equal(observed.result.state, "pending");
    assert.equal(observed.receiptReads, 0);
  }
  await assert.rejects(
    observe({ readError: new DOMException("timeout", "TimeoutError") }),
    /timeout/,
  );
});
await test("receipt absence/nonfinality stays retryable and available evidence recovers without a new order", async () => {
  const first = await observe({ receipt: null });
  assert.deepEqual(first.result, {
    state: "pending",
    reason: "receipt_pending",
  });
  assert.equal((await observe()).result.state, "verified");
});
await test("insufficient shared provider budget does not start receipt RPC", async () => {
  await assert.rejects(observe({ budget: 2 }), EvidenceBudgetExhausted);
});
await test("wrong receipt hash, failed receipt, exchange, owner, order, token and position contract never verify", async () => {
  const wrongOwnerReceipt = receipt();
  wrongOwnerReceipt.logs[0] = {
    address: exchange,
    index: 0,
    ...fill.encodeEventLog("OrderFilled", [
      frozen.orderHash,
      other,
      exchange,
      0,
      123,
      10000000,
      11695903,
      0,
    ]),
  };
  const wrongOrderReceipt = receipt();
  wrongOrderReceipt.logs[0] = {
    address: exchange,
    index: 0,
    ...fill.encodeEventLog("OrderFilled", [
      otherHash,
      owner,
      exchange,
      0,
      123,
      10000000,
      11695903,
      0,
    ]),
  };
  const wrongTokenReceipt = receipt();
  wrongTokenReceipt.logs[0] = {
    address: exchange,
    index: 0,
    ...fill.encodeEventLog("OrderFilled", [
      frozen.orderHash,
      owner,
      exchange,
      0,
      456,
      10000000,
      11695903,
      0,
    ]),
  };
  for (const candidate of [
    { ...receipt(), hash: otherHash },
    { ...receipt(), status: 0 },
    wrongOwnerReceipt,
    wrongOrderReceipt,
    wrongTokenReceipt,
    {
      ...receipt(),
      logs: receipt().logs.map((log) => ({ ...log, address: other })),
    },
    {
      ...receipt(),
      logs: receipt().logs.map((log, index) =>
        index === 1 ? { ...log, address: other } : log,
      ),
    },
    { ...receipt(), logs: [] },
  ])
    assert.equal(
      (await observe({ receipt: candidate })).result.state,
      "pending",
    );
});
await test("local signed identity, chain generation and canonical provider refs cannot conflict", async () => {
  for (const mutate of [
    (value: ReturnType<typeof payload>) => {
      value.submitted.order.salt = "8";
    },
    (value: ReturnType<typeof payload>) => {
      value.submitted.order.maker = other;
    },
    (value: ReturnType<typeof payload>) => {
      value.submitted.order.tokenId = "456";
    },
    (value: ReturnType<typeof payload>) => {
      value.submitted.order.side = 1;
    },
    (value: ReturnType<typeof payload>) => {
      value.submitted._hunchLimitlessClob.chainId = 137 as 8453;
    },
    (value: ReturnType<typeof payload>) => {
      value.submitted._hunchLimitlessClob.orderHash = otherHash;
    },
    (value: ReturnType<typeof payload>) => {
      value.submitted._hunchUpstream.order.id = "other";
    },
    (value: ReturnType<typeof payload>) => {
      value.submitted._hunchUpstream.order.salt = "8";
    },
    (value: ReturnType<typeof payload>) => {
      Object.assign(value.submitted._hunchUpstream.order, {
        salt: "8",
        maker: null,
      });
    },
    (value: ReturnType<typeof payload>) => {
      Object.assign(value.submitted._hunchUpstream.order, {
        orderHash: frozen.orderHash,
        hash: otherHash,
      });
    },
    (value: ReturnType<typeof payload>) => {
      Object.assign(value.submitted, {
        _hunchUpstream: {
          status: "found",
          orderId: "provider-order",
          clientOrderId: "other",
          data: { order: { order, execution: {} } },
        },
      });
    },
    (value: ReturnType<typeof payload>) => {
      Object.assign(value.submitted, {
        _hunchUpstream: {
          status: "found",
          orderId: "provider-order",
          client_order_id: "other",
          data: { order: { order, execution: {} } },
        },
      });
    },
    (value: ReturnType<typeof payload>) => {
      Object.assign(value.submitted._hunchUpstream.order, {
        orderHash: otherHash,
      });
    },
    (value: ReturnType<typeof payload>) => {
      Object.assign(value.submitted._hunchUpstream.execution, {
        orderId: "other",
      });
    },
    (value: ReturnType<typeof payload>) => {
      Object.assign(value.history, { clientOrderId: "other" });
    },
    (value: ReturnType<typeof payload>) => {
      Object.assign(value.history, { client_order_id: "other" });
    },
    (value: ReturnType<typeof payload>) => {
      Object.assign(value.history, { order: { id: "other" } });
    },
    (value: ReturnType<typeof payload>) => {
      value.submitted._hunchUpstream.execution.clientOrderId = "other";
    },
    (value: ReturnType<typeof payload>) => {
      value.history.orderId = "other";
    },
  ]) {
    const value = payload();
    mutate(value);
    const current = row();
    current.order_payload = value;
    const observed = await observe({ row: current });
    assert.equal(observed.result.state, "pending");
    assert.equal(observed.receiptReads, 0);
  }
});
await test("existing history ID and transaction aliases recover without provider snapshots", async () => {
  const source = payload().submitted;
  const submitted = {
    order: source.order,
    clientOrderId: source.clientOrderId,
    _hunchLimitlessClob: source._hunchLimitlessClob,
  };
  for (const txField of ["transactionHash", "txHash", "tx_hash"]) {
    for (const idField of [
      "orderId",
      "order_id",
      "venueOrderId",
      "venue_order_id",
    ]) {
      const current = {
        ...row(),
        order_payload: {
          submitted,
          history: { [idField]: "provider-order", [txField]: txHash },
        },
      };
      assert.equal(
        (await observe({ row: current })).result.state,
        "verified",
        `${idField}/${txField}`,
      );
    }
    for (const idField of ["id", "orderId", "order_id"]) {
      const current = {
        ...row(),
        order_payload: {
          submitted,
          history: {
            order: {
              [idField]: "provider-order",
              client_order_id: "client-order",
            },
            [txField]: txHash,
          },
        },
      };
      assert.equal(
        (await observe({ row: current })).result.state,
        "verified",
        `nested ${idField}/${txField}`,
      );
    }
  }
});
await test("partial provider null fields do not hide conflicts or block matching local signed proof", async () => {
  const current = {
    ...row(),
    order_payload: {
      ...payload(),
      submitted: {
        ...payload().submitted,
        _hunchUpstream: {
          order: { id: "provider-order", salt: order.salt, maker: null },
          execution: { clientOrderId: "client-order" },
        },
      },
    },
  };
  assert.equal((await observe({ row: current })).result.state, "verified");
});
await test("malformed stored cross-identities and conflicting transaction aliases stay pending", async () => {
  for (const value of [42, {}, [], true]) {
    const current = {
      ...row(),
      order_payload: {
        ...payload(),
        history: { ...payload().history, clientOrderId: value },
      },
    };
    const result = await observe({ row: current });
    assert.equal(result.result.state, "pending");
    assert.equal(result.receiptReads, 0);
  }
  const current = {
    ...row(),
    order_payload: {
      ...payload(),
      history: { ...payload().history, txHash: otherHash },
    },
  };
  assert.equal((await observe({ row: current })).result.state, "pending");
});
await test("missing optional client id still recovers from exact provider identity, not a client placeholder", async () => {
  assert.equal(
    (
      await observe({
        row: { ...row(), client_order_id: null },
        status: {
          status: "not_found",
          orderId: "provider-order",
          clientOrderId: null,
        },
      })
    ).result.state,
    "verified",
  );
  const result = await observe({
    row: { ...row(), venue_order_id: "client:client-order" },
    status: {
      status: "not_found",
      orderId: "client:client-order",
      clientOrderId: "client-order",
    },
  });
  assert.equal(result.result.state, "pending");
  assert.equal(result.receiptReads, 0);
});
await test("column order_hash is not a transaction locator, nor are filled/history amounts proof", async () => {
  for (const current of [
    { ...row(), order_payload: {} },
    {
      ...row(),
      order_payload: {
        history: { orderId: "provider-order", transactionHash: txHash },
      },
    },
    {
      ...row(),
      order_payload: {
        submitted: payload().submitted,
        history: { orderId: "provider-order", transactionHash: "bad" },
      },
    },
  ]) {
    const observed = await observe({ row: current });
    assert.equal(observed.result.state, "pending");
    assert.equal(observed.receiptReads, 0);
  }
});
await test("conflicting named transaction locators do not select an arbitrary receipt", async () => {
  const value = payload();
  Object.assign(value.submitted._hunchUpstream.execution, {
    txHash: otherHash,
  });
  const observed = await observe({ row: { ...row(), order_payload: value } });
  assert.equal(observed.result.state, "pending");
  assert.equal(observed.receiptReads, 0);
});
await test("server upstream tx locator and legacy signed payload recover without history or new snapshots", async () => {
  const value = payload();
  Object.assign(value.submitted._hunchUpstream.execution, { txHash });
  const current = row();
  current.order_payload = { ...value.submitted };
  assert.equal((await observe({ row: current })).result.state, "verified");
  const { _hunchLimitlessClob, ...legacy } = value.submitted;
  current.order_payload = { submitted: legacy, history: value.history };
  assert.equal((await observe({ row: current })).result.state, "verified");
});
await test("found terminal failures and zero-fill remain authoritative, not receipt fallbacks", async () => {
  for (const execution of [
    { settlementStatus: "FAILED" },
    { settlementStatus: "REVERTED" },
  ]) {
    const observed = await observe({
      status: {
        status: "found",
        orderId: "provider-order",
        clientOrderId: "client-order",
        data: {
          order: { order: { ...order, id: "provider-order" }, execution },
        },
      },
    });
    assert.equal(observed.result.state, "revoked");
    assert.equal(observed.receiptReads, 0);
  }
});
await test("a newly failed canonical receipt invalidates its own previous proof, not an unrelated purchase", async () => {
  const previous = await observe();
  assert.equal(previous.result.state, "verified");
  if (previous.result.state !== "verified") throw Error("Expected proof");
  const current = { ...row(), verified_buy_facts: previous.result.facts };
  const invalid = await observe({
    row: current,
    receipt: { ...receipt(), status: 0 },
  });
  assert.equal(invalid.result.state, "revoked");
  assert.deepEqual(
    invalid.result.invalidatedEvidenceIds,
    previous.result.facts.evidenceIds,
  );
  const foreign = await observe({
    row: {
      ...current,
      verified_buy_facts: { ...previous.result.facts, owner: other },
    },
    receipt: { ...receipt(), status: 0 },
  });
  assert.equal(foreign.result.state, "pending");
});
await test("conflicting provider identity and non-FOK orders never start chain discovery", async () => {
  const current = {
    ...row(),
    order_payload: { ...payload(), history: undefined },
    posted_at: new Date("2026-11-11T12:32:06Z"),
    order_type: "FOK",
  };
  const discover = async () => {
    throw Error("Unexpected discovery");
  };
  assert.equal(
    (
      await observe({
        row: current,
        status: { ...absent(), clientOrderId: "wrong" },
        discover,
      })
    ).result.state,
    "pending",
  );
  assert.equal(
    (await observe({ row: { ...current, order_type: "GTC" }, discover })).result
      .state,
    "pending",
  );
});
await test("orphaned persisted locator resumes discovery and recovers replacement receipt after restart", async () => {
  const previous = await observe();
  assert.equal(previous.result.state, "verified");
  const postedAt = "2026-11-11T12:32:06.000Z";
  const identity = {
    exchangeAddress: exchange,
    orderHash: frozen.orderHash,
    providerOrderId: "provider-order",
    owner,
    tokenId: "limitless:123",
    generation: previous.result.facts.instrument.generation,
    postedAt,
    checkpoint: null,
  };
  const checkpoint = {
    version: 1 as const,
    identityKey: limitlessReceiptSearchIdentity(identity),
    phase: "scan" as const,
    targetBlock: 2000,
    lowerBlock: 100,
    upperBlock: 100,
    nextBlock: 2001,
    transactions: [txHash],
    anchorChecks: [] as string[],
    anchors: {
      [txHash]: { blockNumber: 1000, blockHash: `0x${"c".repeat(64)}` },
    },
  };
  const current = {
    ...row(),
    order_type: "FOK",
    posted_at: new Date(postedAt),
    order_payload: {
      ...payload(),
      history: undefined,
      [LIMITLESS_RECEIPT_SEARCH_KEY]: checkpoint,
    },
    verified_buy_facts: previous.result.facts,
  };
  const unavailable = await observe({
    row: current,
    receipt: null,
    receiptObservation: async () => ({ state: "pending" }),
  });
  assert.equal(unavailable.result.state, "pending");
  assert.deepEqual(
    unavailable.result.limitlessReceiptSearch?.transactions,
    [txHash],
    "RPC absence is not canonical failure",
  );
  const orphaned = await observe({
    row: current,
    receipt: null,
    sharedBudget: 4,
    anchoredProvider: {
      getBlock: async (value) => ({
        number: typeof value === "number" ? value : 2001,
        hash: `0x${"d".repeat(64)}`,
        timestamp: Date.parse(postedAt) / 1000,
      }),
      getTransactionReceipt: async () => {
        return {
          ...receipt(),
          blockNumber: 1000,
          blockHash: checkpoint.anchors[txHash].blockHash,
        };
      },
    },
  });
  assert.equal(orphaned.result.state, "revoked");
  assert.deepEqual(orphaned.result.limitlessReceiptSearch?.transactions, []);
  assert.equal(orphaned.result.limitlessReceiptSearch?.nextBlock, 1000);
  assert.deepEqual(
    orphaned.result.invalidatedEvidenceIds,
    previous.result.facts.evidenceIds,
  );
  const reincluded = await observe({
    row: current,
    sharedBudget: 4,
    anchoredProvider: {
      getTransactionReceipt: async () => ({
        ...receipt(),
        status: 0,
        logs: [],
        blockNumber: 1001,
        blockHash: `0x${"d".repeat(64)}`,
      }),
      getBlock: async (value) => ({
        number: typeof value === "number" ? value : 2010,
        hash: `0x${"d".repeat(64)}`,
        timestamp: Date.parse(postedAt) / 1000,
      }),
    },
  });
  assert.equal(reincluded.result.state, "revoked");
  assert.equal(
    reincluded.result.limitlessReceiptSearch?.nextBlock,
    1000,
    "A canonically re-included FAILED transaction must rewind to its original anchor",
  );
  assert.deepEqual(
    reincluded.result.invalidatedEvidenceIds,
    previous.result.facts.evidenceIds,
  );
  const staleProvider: VerifiedBuyEvmProvider = {
    getTransactionReceipt: async () => ({
      ...receipt(),
      blockNumber: 1001,
      blockHash: checkpoint.anchors[txHash].blockHash,
    }),
    getBlock: async (value) => ({
      number: typeof value === "number" ? value : 2010,
      hash: `0x${"d".repeat(64)}`,
      timestamp: Date.parse(postedAt) / 1000,
    }),
  };
  const differentHeight = await observe({
    row: current,
    sharedBudget: 4,
    anchoredProvider: staleProvider,
  });
  assert.equal(differentHeight.result.state, "pending");
  assert.deepEqual(
    differentHeight.result.limitlessReceiptSearch?.anchorChecks,
    [txHash],
  );
  const resumedAnchor = await observe({
    row: {
      ...current,
      order_payload: {
        ...current.order_payload,
        [LIMITLESS_RECEIPT_SEARCH_KEY]:
          differentHeight.result.limitlessReceiptSearch,
      },
    },
    sharedBudget: 4,
    anchoredProvider: staleProvider,
  });
  assert.equal(resumedAnchor.result.state, "revoked");
  assert.deepEqual(
    resumedAnchor.result.invalidatedEvidenceIds,
    previous.result.facts.evidenceIds,
  );
  assert.equal(resumedAnchor.result.limitlessReceiptSearch?.phase, "restart");
  const wrongReceipt = receipt();
  wrongReceipt.logs[0] = {
    ...(wrongReceipt.logs[0] as (typeof wrongReceipt.logs)[0]),
    address: other,
  };
  const rejected = await observe({ row: current, receipt: wrongReceipt });
  assert.equal(rejected.result.state, "pending");
  assert.equal(
    rejected.result.limitlessReceiptSearch?.nextBlock,
    2001,
    "A canonically unsuitable candidate must not rewind to the same page forever",
  );
  let searches = 0;
  const recovered = await observe({
    row: {
      ...current,
      order_payload: {
        ...current.order_payload,
        [LIMITLESS_RECEIPT_SEARCH_KEY]: orphaned.result.limitlessReceiptSearch,
      },
    },
    receiptHash: otherHash,
    receipt: { ...receipt(), hash: otherHash },
    discover: async (searchInput) => {
      searches++;
      assert.equal(
        (searchInput.checkpoint as typeof checkpoint).nextBlock,
        1000,
      );
      return {
        reads: 1,
        checkpoint: {
          ...checkpoint,
          transactions: [otherHash],
          anchors: {
            [otherHash]: {
              blockNumber: 1000,
              blockHash: `0x${"d".repeat(64)}`,
            },
          },
        },
      };
    },
  });
  assert.equal(searches, 1);
  assert.equal(recovered.result.state, "verified");
  assert.ok(
    recovered.result.facts.evidenceIds.every((value) =>
      value.includes(otherHash),
    ),
  );
  const moved = await observe({
    row: current,
    receiptBlock: { number: 1001, hash: `0x${"e".repeat(64)}` },
  });
  assert.equal(moved.result.state, "verified");
  assert.deepEqual(
    moved.result.limitlessReceiptSearch?.anchors[txHash],
    { blockNumber: 1001, blockHash: `0x${"e".repeat(64)}` },
    "A re-included transaction must refresh its canonical anchor",
  );
});
console.log(
  `Limitless not_found receipt fallback: ${checks} grouped checks passed`,
);
