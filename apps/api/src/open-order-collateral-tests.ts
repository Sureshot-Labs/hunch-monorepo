#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";
import {
  computeBuyCollateralLockedRaw,
  fetchOpenOrderCollateralLocks,
} from "./services/open-order-collateral.js";

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("Polymarket BUY signed payload locks maker pUSD", () => {
  assert.equal(
    computeBuyCollateralLockedRaw({
      venue: "polymarket",
      side: "BUY",
      price: "0.5",
      size: "2",
      filledSize: "0",
      orderPayload: {
        makerAmount: "1000000",
        takerAmount: "2000000",
      },
    }),
    1_000_000n,
  );
});

await test("Polymarket partial fill locks only remaining signed pUSD", () => {
  assert.equal(
    computeBuyCollateralLockedRaw({
      venue: "polymarket",
      side: "BUY",
      price: "0.5",
      size: "2",
      filledSize: "0.5",
      orderPayload: {
        makerAmount: "1000000",
        takerAmount: "2000000",
      },
    }),
    750_000n,
  );
});

await test("SELL orders do not lock collateral token amounts", () => {
  assert.equal(
    computeBuyCollateralLockedRaw({
      venue: "polymarket",
      side: "SELL",
      price: "0.5",
      size: "2",
      filledSize: "0",
      orderPayload: {
        makerAmount: "2000000",
        takerAmount: "1000000",
      },
    }),
    0n,
  );
});

await test("Limitless BUY nested signed payload locks Base USDC", () => {
  assert.equal(
    computeBuyCollateralLockedRaw({
      venue: "limitless",
      side: "BUY",
      price: "0.42",
      size: "2",
      filledSize: "0",
      orderPayload: {
        order: {
          makerAmount: "840000",
          takerAmount: "2000000",
        },
      },
    }),
    840_000n,
  );
});

await test("legacy rows without signed payload use remaining size times price", () => {
  assert.equal(
    computeBuyCollateralLockedRaw({
      venue: "limitless",
      side: "BUY",
      price: "0.4",
      size: "2.5",
      filledSize: "0.5",
      orderPayload: null,
    }),
    800_000n,
  );
});

await test("batched helper groups requested wallets in one query", async () => {
  let callCount = 0;
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  const fakePool = {
    query: async (sql: string, params: unknown[]) => {
      callCount += 1;
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [
          {
            venue: "polymarket",
            wallet_key: "0xfunder000000000000000000000000000000000000",
            side: "BUY",
            price: "0.5",
            size: "2",
            filled_size: "0",
            order_payload: {
              makerAmount: "1000000",
              takerAmount: "2000000",
            },
          },
          {
            venue: "limitless",
            wallet_key: "0xwallet000000000000000000000000000000000000",
            side: "BUY",
            price: "0.4",
            size: "2.5",
            filled_size: "0.5",
            order_payload: null,
          },
        ],
      };
    },
  } as unknown as Pool;

  const locks = await fetchOpenOrderCollateralLocks(fakePool, {
    userId: "user-1",
    polymarketWallets: ["0xFunder000000000000000000000000000000000000"],
    limitlessWallets: ["0xWallet000000000000000000000000000000000000"],
  });

  assert.equal(callCount, 1);
  assert.match(capturedSql, /from orders o/i);
  assert.match(capturedSql, /upper\(o\.order_type\) in \('GTC', 'GTD'\)/i);
  assert.match(capturedSql, /upper\(coalesce\(o\.side, ''\)\) = 'BUY'/i);
  assert.deepEqual(capturedParams[0], "user-1");
  assert.deepEqual(capturedParams[2], [
    "0xfunder000000000000000000000000000000000000",
  ]);
  assert.deepEqual(capturedParams[3], [
    "0xwallet000000000000000000000000000000000000",
  ]);
  assert.equal(
    locks.polymarket.get("0xfunder000000000000000000000000000000000000"),
    1_000_000n,
  );
  assert.equal(
    locks.limitless.get("0xwallet000000000000000000000000000000000000"),
    800_000n,
  );
});
