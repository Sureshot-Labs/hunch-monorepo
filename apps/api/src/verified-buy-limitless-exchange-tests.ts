import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { Interface } from "ethers";
import {
  buildLimitlessClobSubmissionContext,
  resolveLimitlessClobEvidenceIdentity,
} from "./services/limitless-clob-evidence-identity.js";
import {
  observeVerifiedBuySource,
  type VerifiedBuyObserverDependencies,
  type VerifiedBuySourceRow,
} from "./services/verified-buy-observer.js";

const owner = `0x${"1".repeat(40)}`;
const defaultExchange = `0x${"2".repeat(40)}`;
const alternateExchange = `0x${"3".repeat(40)}`;
const position = `0x${"4".repeat(40)}`;
const txHash = `0x${"a".repeat(64)}`;
const unrelatedHash = `0x${"b".repeat(64)}`;
const zeroAddress = `0x${"0".repeat(40)}`;
const signedOrder = {
  salt: "71",
  maker: owner,
  signer: owner,
  taker: zeroAddress,
  tokenId: "123",
  makerAmount: "10000000",
  takerAmount: "1",
  expiration: "0",
  nonce: "0",
  feeRateBps: "0",
  side: 0,
  signatureType: 0,
};
const alternateContext = buildLimitlessClobSubmissionContext(
  alternateExchange,
  signedOrder,
);
const defaultContext = buildLimitlessClobSubmissionContext(
  defaultExchange,
  signedOrder,
);
const fill = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)",
]);
const transfer = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);
const expectedInstrument = {
  venue: "limitless",
  marketId: "limitless:market",
  tokenId: "limitless:123",
  outcome: "YES",
  generation: `8453:${position}:limitless:123`,
  expiry: null,
};

async function observe(
  input: {
    payload?: Record<string, unknown>;
    metadata?: unknown;
    providerOrder?: Record<string, unknown>;
    logExchange?: string;
    logHash?: string;
    logToken?: string;
    providerOrderId?: string;
    providerClientOrderId?: string;
  } = {},
) {
  let providerReads = 0;
  let receiptReads = 0;
  const row: VerifiedBuySourceRow = {
    id: "row",
    user_id: "user",
    venue: "limitless",
    wallet_address: owner,
    order_hash: txHash, // This legacy column is a TX hash, never an EIP-712 hash.
    venue_order_id: "venue-order",
    token_id: "limitless:123",
    side: "BUY",
    order_payload: input.payload ?? {},
    client_order_id: "client-order",
    tx_signature: null,
    market_id: "limitless:market",
    outcome: "YES",
    expiration_time: null,
    market_metadata: input.metadata ?? { venueExchange: alternateExchange },
    input_mint: null,
    output_mint: null,
  };
  const exchange = input.logExchange ?? alternateExchange;
  const deps: VerifiedBuyObserverDependencies = {
    maxEvidenceItems: 10,
    limitlessPositionContract: position,
    limitlessExchangeAddress: defaultExchange,
    solanaCollateralMint: "unused",
    readEvmReceipt: async (chainId, hash) => {
      receiptReads++;
      assert.equal(chainId, 8453);
      assert.equal(hash, txHash);
      return {
        timestamp: "2026-10-08T00:00:00.000Z",
        receipt: {
          hash,
          status: 1,
          logs: [
            {
              address: exchange,
              index: 0,
              ...fill.encodeEventLog("OrderFilled", [
                input.logHash ?? alternateContext.orderHash,
                owner,
                exchange,
                0,
                input.logToken ?? "123",
                10000000,
                20000000,
                100000,
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
                19900000,
              ]),
            },
          ],
        },
      };
    },
    readLimitlessOrder: async () => {
      providerReads++;
      return {
        status: "found",
        clientOrderId: input.providerClientOrderId ?? "client-order",
        orderId: input.providerOrderId ?? "venue-order",
        data: {
          order: {
            order: input.providerOrder ?? {
              orderHash: alternateContext.orderHash,
            },
            execution: { txHash, settlementStatus: "CONFIRMED" },
          },
        },
      };
    },
    readFinalizedSolanaTransaction: async () => null,
    readDflowOrder: async () => null,
    readPolymarketFills: async () => [],
  };
  const db = {
    query: async () => {
      throw new Error(
        "No database reads expected for pure Limitless observation",
      );
    },
  } as unknown as Pick<Pool, "query">;
  const observation = await observeVerifiedBuySource(db, deps, row);
  return { observation, providerReads, receiptReads };
}

async function test(name: string, run: () => Promise<void> | void) {
  await run();
  console.log(`ok - ${name}`);
}

await test("alternate market exchange verifies supplied hash without changing purchase/instrument identity", async () => {
  const { observation, providerReads, receiptReads } = await observe();
  assert.equal(observation.state, "verified");
  if (observation.state !== "verified") throw new Error("Expected verified");
  assert.equal(
    observation.facts.canonicalPurchaseKey,
    "limitless:clob:8453:venue-order",
  );
  assert.deepEqual(observation.facts.instrument, expectedInstrument);
  assert.equal(observation.facts.netShares, "19.9");
  assert.equal(observation.facts.grossNotionalUsd, "10");
  assert.equal(providerReads, 1);
  assert.equal(receiptReads, 1);
});

await test("alternate exchange reconstructs exact EIP-712 hash from provider signed fields", async () => {
  assert.equal(
    (await observe({ providerOrder: signedOrder })).observation.state,
    "verified",
  );
  assert.notEqual(alternateContext.orderHash, defaultContext.orderHash);
});

await test("frozen server signing domain survives metadata drift and missing provider order fields", async () => {
  const payload = {
    ...signedOrder,
    _hunchLimitlessClob: alternateContext,
  };
  for (const stored of [
    payload,
    { submitted: payload, history: {} },
    {
      submitted: {
        _hunchLimitlessClob: alternateContext,
        _hunchSubmitted: signedOrder,
      },
      history: {},
    },
  ]) {
    const { observation } = await observe({
      payload: stored,
      metadata: { venueExchange: defaultExchange },
      providerOrder: {},
    });
    assert.equal(observation.state, "verified");
    if (observation.state === "verified")
      assert.deepEqual(observation.facts.instrument, expectedInstrument);
  }
});

await test("legacy local signed order is preferred to sparse provider payload", async () => {
  for (const payload of [
    signedOrder,
    { order: signedOrder },
    { _hunchSubmitted: { order: signedOrder } },
  ]) {
    assert.equal(
      (await observe({ payload, providerOrder: {} })).observation.state,
      "verified",
    );
  }
});

await test("legacy default exchange remains compatible when market exchange metadata is absent", async () => {
  const { observation } = await observe({
    metadata: {},
    providerOrder: signedOrder,
    logExchange: defaultExchange,
    logHash: defaultContext.orderHash,
  });
  assert.equal(observation.state, "verified");
});

await test("partial historical provider fields do not block exact supplied-hash evidence", async () => {
  assert.equal(
    (
      await observe({
        payload: { order: { salt: signedOrder.salt } },
        providerOrder: {
          salt: signedOrder.salt,
          orderHash: alternateContext.orderHash,
        },
      })
    ).observation.state,
    "verified",
  );
});

await test("legacy missing alternate metadata recovers on the next bounded observation", async () => {
  assert.equal(
    (await observe({ metadata: {}, providerOrder: signedOrder })).observation
      .state,
    "pending",
  );
  const repaired = await observe({
    metadata: { market: { venue: { negRiskExchange: alternateExchange } } },
    providerOrder: signedOrder,
  });
  assert.equal(repaired.observation.state, "verified");
  assert.equal(repaired.providerReads, 1);
  assert.equal(repaired.receiptReads, 1);
});

await test("wrong exchange, order hash, and token logs never verify", async () => {
  for (const input of [
    { logExchange: defaultExchange },
    { logHash: unrelatedHash },
    { logToken: "456" },
  ]) {
    assert.deepEqual((await observe(input)).observation, {
      state: "pending",
      reason: "receipt_exact_fill_unavailable",
    });
  }
});

await test("wrong provider order/client identities never reach receipt parsing", async () => {
  for (const input of [
    { providerOrderId: "other-order" },
    { providerClientOrderId: "other-client" },
  ]) {
    const result = await observe(input);
    assert.equal(result.observation.state, "pending");
    assert.equal(result.receiptReads, 0);
  }
});

await test("provider hashes cannot override the submitted order or frozen domain", async () => {
  for (const providerOrder of [
    { orderHash: unrelatedHash },
    { ...signedOrder, salt: "72", orderHash: alternateContext.orderHash },
  ]) {
    const result = await observe({
      payload: { ...signedOrder, _hunchLimitlessClob: alternateContext },
      providerOrder,
    });
    assert.equal(result.observation.state, "pending");
    assert.equal(result.receiptReads, 0);
  }
});

await test("arbitrary provider/client exchange and domain extras are not trusted", async () => {
  const maliciousOrder = {
    ...signedOrder,
    exchangeAddress: alternateExchange,
    domain: { verifyingContract: alternateExchange },
    _hunchLimitlessClob: alternateContext,
  };
  const result = await observe({
    metadata: { venueExchange: defaultExchange },
    payload: { order: maliciousOrder },
    providerOrder: maliciousOrder,
  });
  assert.equal(result.observation.state, "pending");
});

await test("malformed explicit context cannot silently fall back; repaired exact context verifies", async () => {
  for (const frozen of [
    null,
    { ...alternateContext, chainId: 137 },
    { ...alternateContext, exchangeAddress: "invalid" },
    { ...alternateContext, orderHash: unrelatedHash },
    { ...alternateContext, contextVersion: 2 },
  ]) {
    assert.equal(
      (
        await observe({
          payload: { ...signedOrder, _hunchLimitlessClob: frozen },
        })
      ).observation.state,
      "pending",
    );
  }
  const result = await observe({ metadata: { venueExchange: "invalid" } });
  assert.equal(result.observation.state, "pending");
  assert.equal(result.receiptReads, 0);
  assert.equal((await observe()).observation.state, "verified");
});

await test("pure helper never mistakes the transaction hash for the order identity", () => {
  assert.deepEqual(
    resolveLimitlessClobEvidenceIdentity({
      orderPayload: {
        ...signedOrder,
        _hunchLimitlessClob: alternateContext,
        orderHash: txHash,
      },
      marketMetadata: {},
      legacyExchangeAddress: defaultExchange,
      providerOrder: {},
    }),
    {
      exchangeAddress: alternateExchange,
      orderHash: alternateContext.orderHash,
    },
  );
});
