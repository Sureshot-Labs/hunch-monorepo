#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  applyClobBookUpdate,
  buildClobBookSnapshot,
  createClobBookState,
  getClobBookTop,
} from "./clobBook.js";

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
