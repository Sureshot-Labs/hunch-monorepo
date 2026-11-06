// @integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { Interface } from "ethers";
import { createIntegrationTestPool } from "./test-database-target.js";
import { buildLimitlessClobSubmissionContext } from "./services/limitless-clob-evidence-identity.js";
import {
  createVerifiedBuyObserver,
  type VerifiedBuyObserverDependencies,
} from "./services/verified-buy-observer.js";
import {
  readVerifiedBuy,
  repairVerifiedBuys,
  requestVerifiedBuyRefresh,
} from "./services/verified-buy.js";
import { SocialService } from "./services/social-service.js";

const pool = await createIntegrationTestPool({ max: 1 }),
  client = await pool.connect();
const db = {
  query: (sql: string, params: unknown[] = []) => client.query(sql, params),
} as unknown as Pool;
const userId = randomUUID(),
  orderId = randomUUID(),
  providerOrderId = randomUUID();
const clientOrderId = `fixture-${randomUUID()}`,
  eventId = `receipt-event:${randomUUID()}`,
  marketId = `receipt-market:${randomUUID()}`;
const tokenId = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString(),
  scopedToken = `limitless:${tokenId}`;
const owner = `0x${"1".repeat(40)}`,
  exchange = `0x${"2".repeat(40)}`,
  position = `0x${"3".repeat(40)}`,
  txHash = `0x${"a".repeat(64)}`;
const signed = {
  salt: "7",
  maker: owner,
  signer: owner,
  taker: `0x${"0".repeat(40)}`,
  tokenId,
  makerAmount: "10000000",
  takerAmount: "1",
  expiration: "0",
  nonce: "0",
  feeRateBps: "0",
  side: 0,
  signatureType: 0,
};
const frozen = buildLimitlessClobSubmissionContext(exchange, signed);
const fill = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)",
]);
const transfer = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);
const receipt = {
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
        tokenId,
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
        tokenId,
        11597658,
      ]),
    },
  ],
};
let finalized = false,
  providerReads = 0,
  receiptReads = 0;
const deps: VerifiedBuyObserverDependencies = {
  maxEvidenceItems: 10,
  limitlessPositionContract: position,
  limitlessExchangeAddress: exchange,
  solanaCollateralMint: "unused",
  readLimitlessOrder: async (input) => {
    providerReads++;
    assert.equal(input.providerOrderId, providerOrderId);
    assert.equal(input.clientOrderId, clientOrderId);
    return { status: "not_found", orderId: providerOrderId, clientOrderId };
  },
  readEvmReceipt: async (chain, hash) => {
    receiptReads++;
    assert.equal(chain, 8453);
    assert.equal(hash, txHash);
    return finalized
      ? { receipt, timestamp: "2026-11-06T19:48:27.000Z" }
      : null;
  },
  readFinalizedSolanaTransaction: async () => null,
  readDflowOrder: async () => null,
  readPolymarketFills: async () => [],
};
const policy = {
  batchSize: 1,
  concurrency: 1,
  leaseSeconds: 120,
  retrySeconds: 30,
  verifiedRecheckSeconds: 3600,
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error(
    "No HTTP, RPC, signing or trade submission is allowed in this fixture",
  );
};
try {
  assert.equal(
    Math.floor(
      Number(
        (
          await client.query(
            "select current_setting('server_version_num') as version",
          )
        ).rows[0].version,
      ) / 10000,
    ),
    16,
  );
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout='15s'");
  await client.query("SET LOCAL lock_timeout='2s'");
  for (const table of ["orders", "executions"])
    assert.equal(
      Number(
        (
          await client.query(
            `select count(*) as due_count from ${table} where verified_buy_due_at<=now()`,
          )
        ).rows[0].due_count,
      ),
      0,
      "Disposable test target must have no other due work",
    );
  await client.query(
    "insert into users(id,display_name) values($1,'Receipt fallback fixture')",
    [userId],
  );
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Receipt fixture','ACTIVE')",
    [eventId],
  );
  await client.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes) values($1,'limitless',$1,$2,'Receipt fixture','ACTIVE','binary','[\"Yes\",\"No\"]')",
    [marketId, eventId],
  );
  await client.query(
    "insert into unified_tokens(token_id,venue,market_id,side) values($1,'limitless',$2,'YES')",
    [scopedToken, marketId],
  );
  const payload = {
    submitted: {
      order: signed,
      clientOrderId,
      _hunchLimitlessClob: frozen,
      _hunchUpstream: {
        order: { ...signed, id: providerOrderId },
        execution: { clientOrderId },
      },
    },
    history: {
      orderId: providerOrderId,
      transactionHash: txHash,
      collateralAmount: "9999",
      outcomeTokenAmount: "9999",
    },
  };
  await client.query(
    "insert into orders(id,user_id,venue,side,status,venue_order_id,token_id,wallet_address,order_payload,verified_buy_reason) values($1,$2,'limitless','BUY','filled',$3,$4,$5,$6::jsonb,'provider_order_pending')",
    [
      orderId,
      userId,
      providerOrderId,
      scopedToken,
      owner,
      JSON.stringify(payload),
    ],
  );
  const ref = { kind: "order" as const, id: orderId };
  const service = new SocialService(
    db,
    async () => {
      throw Error("No publication or write requested");
    },
    { limitlessPositionContract: position },
  );
  assert.equal(
    (await service.eligibility(userId, ref)).reason,
    "provider_order_pending",
  );
  const first = await repairVerifiedBuys(db, {
    ...policy,
    observe: createVerifiedBuyObserver(db, deps),
  });
  assert.equal(first.pending, 1);
  assert.equal(
    (await readVerifiedBuy(db, { userId, purchaseRef: ref })).reason,
    "receipt_pending",
  );
  finalized = true;
  await requestVerifiedBuyRefresh(db, { userId, purchaseRef: ref });
  // A fresh observer models worker restart: recovery depends on persisted
  // locators, not memory or a second order/repair-specific production command.
  const second = await repairVerifiedBuys(db, {
    ...policy,
    observe: createVerifiedBuyObserver(db, deps),
  });
  assert.equal(second.verified, 1);
  const stored = await readVerifiedBuy(db, { userId, purchaseRef: ref });
  assert.equal(stored.state, "verified");
  assert.equal(stored.facts?.grossNotionalUsd, "10");
  assert.equal(stored.facts?.netShares, "11.597658");
  const eligibility = await service.eligibility(userId, ref);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.reason, null);
  const orderRow = (
    await client.query(
      "select status,venue_order_id,order_payload,verified_buy_lease_token,verified_buy_lease_until from orders where id=$1",
      [orderId],
    )
  ).rows[0];
  assert.equal(orderRow.status, "filled");
  assert.equal(orderRow.venue_order_id, providerOrderId);
  assert.deepEqual(orderRow.order_payload, payload);
  assert.equal(orderRow.verified_buy_lease_token, null);
  assert.equal(orderRow.verified_buy_lease_until, null);
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as order_count from orders where user_id=$1",
          [userId],
        )
      ).rows[0].order_count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as thesis_count from user_theses where author_id=$1",
          [userId],
        )
      ).rows[0].thesis_count,
    ),
    0,
  );
  assert.equal(providerReads, 2);
  assert.equal(receiptReads, 2);
  await client.query("update unified_markets set status='CLOSED' where id=$1", [
    marketId,
  ]);
  assert.equal(
    (await service.eligibility(userId, ref)).reason,
    "market_closed_or_instrument_changed",
  );
  console.log(
    "ok - PG16 ordinary verifier recovers explicit not_found after finality, persists exact facts, unlocks eligibility without orders/publication, preserves market policy",
  );
} finally {
  globalThis.fetch = originalFetch;
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
