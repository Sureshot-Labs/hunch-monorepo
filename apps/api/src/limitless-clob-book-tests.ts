#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  limitlessClobLevelsForToken,
  parseLimitlessClobBook,
  quoteLimitlessClobDepth,
  type LimitlessClobBook,
} from "./services/limitless-clob-book.js";
import {
  extractLimitlessExecutionFill,
  isLimitlessFokUnmatchedMessage,
  parseLimitlessOrderResult,
} from "./services/limitless-order-result.js";
import {
  clearLimitlessClobQuoteCacheForTests,
  quoteLimitlessClobMarket,
} from "./services/limitless-clob-quote.js";

function test(name: string, run: () => void): void {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function asyncTest(
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const book: LimitlessClobBook = {
  asks: [
    { price: 0.4, size: 2 },
    { price: 0.5, size: 3 },
  ],
  bids: [
    { price: 0.35, size: 4 },
    { price: 0.3, size: 5 },
  ],
  minOrderNotionalUsd: 100,
  tokenId: "111",
};

test("parser accepts nested Limitless orderbooks", () => {
  assert.deepEqual(
    parseLimitlessClobBook({
      data: {
        tokenId: "111",
        minSize: "100000000",
        asks: [{ price: "0.4", size: "2000000" }],
        bids: [{ price: "0.35", size: "4000000" }],
      },
    }),
    {
      asks: [{ price: 0.4, size: 2 }],
      bids: [{ price: 0.35, size: 4 }],
      minOrderNotionalUsd: 100,
      tokenId: "111",
    },
  );
});

test("direct and sibling BUY/SELL orientation is symmetric", () => {
  assert.deepEqual(
    limitlessClobLevelsForToken({ book, side: "BUY", tokenId: "111" }),
    book.asks,
  );
  assert.deepEqual(
    limitlessClobLevelsForToken({ book, side: "SELL", tokenId: "111" }),
    book.bids,
  );
  assert.deepEqual(
    limitlessClobLevelsForToken({ book, side: "BUY", tokenId: "222" }),
    [
      { price: 0.65, size: 4 },
      { price: 0.7, size: 5 },
    ],
  );
  assert.deepEqual(
    limitlessClobLevelsForToken({ book, side: "SELL", tokenId: "222" }),
    [
      { price: 0.6, size: 2 },
      { price: 0.5, size: 3 },
    ],
  );
});

test("USD quote walks levels and reports average/worst prices", () => {
  const quote = quoteLimitlessClobDepth({
    amountUsd: 1.3,
    book,
    side: "BUY",
    tokenId: "111",
  });
  assert.equal(quote.status, "ready");
  if (quote.status !== "ready") return;
  assert.equal(quote.executableShares, 3);
  assert.ok(Math.abs(quote.averagePrice - 1.3 / 3) < 1e-9);
  assert.equal(quote.worstPrice, 0.5);
});

test("FOK depth does not apply the resting-order minimum notional", () => {
  assert.equal(
    quoteLimitlessClobDepth({
      amountUsd: 0.5,
      book,
      side: "BUY",
      tokenId: "111",
    }).status,
    "ready",
  );
});

test("live sibling-token FOK uses normalized depth and ignores cached price caps", () => {
  const liveBook = parseLimitlessClobBook({
    bids: [
      { price: 0.524, size: 100_000_000 },
      { price: 0.51, size: 50_000_000 },
    ],
    asks: [{ price: 0.583, size: 100_000_000 }],
    minSize: "100000000",
    tokenId: "111",
  });
  assert.ok(liveBook);
  assert.equal(liveBook.minOrderNotionalUsd, 100);
  assert.equal(liveBook.bids[0]?.size, 100);

  const quote = quoteLimitlessClobDepth({
    amountUsd: 1,
    book: liveBook,
    side: "BUY",
    tokenId: "222",
  });
  assert.equal(quote.status, "ready");
  if (quote.status !== "ready") return;
  assert.ok(Math.abs(quote.worstPrice - 0.476) < 1e-9);
  assert.ok(Math.abs(quote.executableShares - 1 / 0.476) < 1e-9);
});

test("quote distinguishes depth and price-filtered liquidity", () => {
  assert.equal(
    quoteLimitlessClobDepth({
      amountShares: 6,
      book,
      side: "BUY",
      tokenId: "111",
    }).status,
    "insufficient_depth",
  );
  assert.equal(
    quoteLimitlessClobDepth({
      amountShares: 1,
      book,
      limitPrice: 0.3,
      side: "BUY",
      tokenId: "111",
    }).status,
    "no_liquidity",
  );
});

test("HTTP 200 nested matched=false is an explicit no-fill", () => {
  const result = parseLimitlessOrderResult({
    data: {
      order: { id: "order-1", status: "submitted" },
      execution: { matched: false, settlementStatus: "DELAYED" },
    },
  });
  assert.equal(result.explicitNoFill, true);
  assert.equal(result.venueOrderId, "order-1");
});

test("matched=true with delayed settlement remains non-terminal", () => {
  const result = parseLimitlessOrderResult({
    order: { id: "order-2", status: "submitted" },
    execution: { matched: true, settlementStatus: "DELAYED" },
  });
  assert.equal(result.explicitNoFill, false);
  assert.equal(result.matched, true);
  assert.equal(result.status, "submitted");
  assert.equal(result.terminalFill, false);
});

test("matched and mined SELL is a terminal fill with execution totals", () => {
  const payload = {
    order: {
      id: "a379469e-0cc7-49a0-82bb-ce1b7eec32e2",
      orderType: "FOK",
      price: null,
      side: 1,
      tokenId:
        "94819275819328150956931124399999073677069293590947057684678725986599263139044",
    },
    execution: {
      matched: true,
      settlementStatus: "MINED",
      totalsRaw: {
        contractsGross: "2280000",
        usdFee: "11862",
        usdGross: "841320",
        usdNet: "829458",
      },
      txHash:
        "0xe5c4b0014f4839c835362b376bc60d1930164e9ffef3a78d0492bfd59abe9c02",
    },
  };
  const result = parseLimitlessOrderResult(payload);
  assert.equal(result.status, "filled");
  assert.equal(result.terminalFill, true);
  assert.equal(result.settlementStatus, "mined");
  assert.equal(
    result.txHash,
    "0xe5c4b0014f4839c835362b376bc60d1930164e9ffef3a78d0492bfd59abe9c02",
  );
  assert.deepEqual(extractLimitlessExecutionFill(payload), {
    averagePrice: 0.369,
    notionalUsd: 0.84132,
    shares: 2.28,
  });
});

test("non-2xx unmatched message is recognized", () => {
  assert.equal(
    isLimitlessFokUnmatchedMessage("Market order unmatched: order abc"),
    true,
  );
});

await asyncTest(
  "live quote timeout fails closed at three seconds",
  async () => {
    clearLimitlessClobQuoteCacheForTests();
    let timeoutMs: number | null = null;
    const result = await quoteLimitlessClobMarket(
      {
        amountUsd: 1,
        side: "BUY",
        slug: "test-market",
        tokenId: "111",
      },
      {
        requestOrderbook: async (request) => {
          timeoutMs = request.timeoutMs;
          throw new Error("request timed out");
        },
      },
    );
    assert.equal(timeoutMs, 3_000);
    assert.deepEqual(result, { status: "unavailable", asOf: null });
  },
);
