#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  applyClobBookUpdate,
  buildClobBookSnapshot,
  createClobBookState,
  getClobBookTop,
} from "./clobBook.js";
import {
  deriveLimitlessClobSiblingTop,
  isLimitlessTopUsable,
  LimitlessClobDirectTopTracker,
} from "./clobComplement.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("partial ask update does not replace the existing CLOB book", () => {
  const book = createClobBookState();

  applyClobBookUpdate(book, {
    bids: [{ price: 0.07, size: 570352732 }],
    asks: [
      { price: 0.406, size: 241000000 },
      { price: 0.85, size: 266666000 },
    ],
  });

  const topAfterPartial = applyClobBookUpdate(book, {
    asks: [{ price: 0.85, size: 266666000 }],
  });

  assert.equal(topAfterPartial.bestBid, 0.07);
  assert.equal(topAfterPartial.bestAsk, 0.406);
});

test("zero-size updates remove CLOB levels before computing top", () => {
  const book = createClobBookState();

  applyClobBookUpdate(book, {
    bids: [
      { price: 0.07, size: 10 },
      { price: 0.05, size: 20 },
    ],
    asks: [
      { price: 0.406, size: 30 },
      { price: 0.85, size: 40 },
    ],
  });

  const top = applyClobBookUpdate(book, {
    bids: [{ price: 0.07, size: 0 }],
    asks: [{ price: 0.406, size: 0 }],
  });

  assert.equal(top.bestBid, 0.05);
  assert.equal(top.bestAsk, 0.85);
});

test("book snapshot is sorted and capped", () => {
  const book = createClobBookState();

  applyClobBookUpdate(book, {
    bids: [
      { price: 0.2, size: 2 },
      { price: 0.4, size: 4 },
      { price: 0.1, size: 1 },
    ],
    asks: [
      { price: 0.8, size: 8 },
      { price: 0.6, size: 6 },
      { price: 0.7, size: 7 },
    ],
  });

  assert.deepEqual(getClobBookTop(book), { bestBid: 0.4, bestAsk: 0.6 });
  assert.deepEqual(buildClobBookSnapshot("limitless:token", book, "123", 2), {
    token_id: "limitless:token",
    bids: [
      { price: 0.4, size: 4, side: "BUY" },
      { price: 0.2, size: 2, side: "BUY" },
    ],
    asks: [
      { price: 0.6, size: 6, side: "SELL" },
      { price: 0.7, size: 7, side: "SELL" },
    ],
    timestamp: "123",
  });
});

test("YES direct top derives complementary NO top", () => {
  assert.deepEqual(
    deriveLimitlessClobSiblingTop({
      directTokenId: "limitless:yes",
      pair: { yesTokenId: "limitless:yes", noTokenId: "limitless:no" },
      bestBid: 0.2,
      bestAsk: 0.3,
    }),
    { tokenId: "limitless:no", bestBid: 0.7, bestAsk: 0.8 },
  );
});

test("NO direct top derives complementary YES top", () => {
  assert.deepEqual(
    deriveLimitlessClobSiblingTop({
      directTokenId: "limitless:no",
      pair: { yesTokenId: "limitless:yes", noTokenId: "limitless:no" },
      bestBid: 0.4,
      bestAsk: 0.55,
    }),
    { tokenId: "limitless:yes", bestBid: 0.44999999999999996, bestAsk: 0.6 },
  );
});

test("missing direct bid or ask derives only computable sibling side", () => {
  assert.deepEqual(
    deriveLimitlessClobSiblingTop({
      directTokenId: "yes",
      pair: { yesTokenId: "yes", noTokenId: "no" },
      bestBid: null,
      bestAsk: 0.72,
    }),
    { tokenId: "limitless:no", bestBid: 0.28, bestAsk: null },
  );

  assert.deepEqual(
    deriveLimitlessClobSiblingTop({
      directTokenId: "yes",
      pair: { yesTokenId: "yes", noTokenId: "no" },
      bestBid: 0.31,
      bestAsk: null,
    }),
    { tokenId: "limitless:no", bestBid: null, bestAsk: 0.69 },
  );
});

test("invalid direct top skips sibling derivation", () => {
  assert.equal(isLimitlessTopUsable(0.8, 0.2), false);
  assert.equal(isLimitlessTopUsable(0.2, 0.8), true);
  assert.equal(isLimitlessTopUsable(null, 0.8), true);
  assert.equal(isLimitlessTopUsable(1.2, null), false);

  assert.equal(
    deriveLimitlessClobSiblingTop({
      directTokenId: "limitless:yes",
      pair: { yesTokenId: "limitless:yes", noTokenId: "limitless:no" },
      bestBid: 0.8,
      bestAsk: 0.2,
    }),
    null,
  );

  assert.equal(
    deriveLimitlessClobSiblingTop({
      directTokenId: "limitless:other",
      pair: { yesTokenId: "limitless:yes", noTokenId: "limitless:no" },
      bestBid: 0.2,
      bestAsk: 0.3,
    }),
    null,
  );
});

test("recent direct sibling top blocks derived overwrite", () => {
  const tracker = new LimitlessClobDirectTopTracker();
  tracker.markDirectTop("limitless:no", 1_000);

  assert.equal(tracker.shouldSkipDerivedTop("limitless:no", 30_000), true);
  assert.equal(tracker.shouldSkipDerivedTop("limitless:no", 61_000), false);
});

test("derived sibling check does not mark direct top", () => {
  const tracker = new LimitlessClobDirectTopTracker();

  assert.equal(tracker.shouldSkipDerivedTop("limitless:no", 30_000), false);
  assert.equal(tracker.shouldSkipDerivedTop("limitless:no", 31_000), false);

  tracker.markDirectTop("limitless:no", 32_000);
  assert.equal(tracker.shouldSkipDerivedTop("limitless:no", 33_000), true);
});
