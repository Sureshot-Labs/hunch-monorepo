#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { computePolymarketOrderHashV2 } from "./services/polymarket-order-hash.js";

const METADATA =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const BUILDER =
  "0x0383467ec0c0a88fe7030bf324e02425af407431d6f3182a2a1d0c307e9091f8";
const DEPOSIT_WALLET = "0xBC3575b73dC7C620837585AdD1828644174Bc4Ea";

const cases = [
  {
    name: "neg-risk V2 order",
    exchangeAddress: "0xe2222d279d744050d28e00520010520000310F59",
    expected:
      "0xd99e839bef90920b088b7be654b85713a3211d66a1ea290f9397cb434c3e285d",
    order: {
      salt: "1785173978223",
      maker: DEPOSIT_WALLET,
      signer: DEPOSIT_WALLET,
      tokenId:
        "54533043819946592547517511176940999955633860128497669742211153063842200957669",
      makerAmount: "12820000",
      takerAmount: "2474260",
      side: 1,
      signatureType: 3,
      timestamp: "1785173122758",
      metadata: METADATA,
      builder: BUILDER,
    },
  },
  {
    name: "standard V2 order",
    exchangeAddress: "0xE111180000d2663C0091e4f400237545B87B996B",
    expected:
      "0x3ab3fd8cf6776304163e210e7793bd477d4c37b00454eb583b02691f6e4b5033",
    order: {
      salt: "1785105321928",
      maker: DEPOSIT_WALLET,
      signer: DEPOSIT_WALLET,
      tokenId:
        "55115078421062885512539156303747803058407616201213034911037320915726138659123",
      makerAmount: "4760000",
      takerAmount: "904400",
      side: 1,
      signatureType: 3,
      timestamp: "1785105190067",
      metadata: METADATA,
      builder: BUILDER,
    },
  },
] as const;

let passed = 0;
for (const test of cases) {
  assert.equal(
    computePolymarketOrderHashV2({
      exchangeAddress: test.exchangeAddress,
      order: test.order,
    }),
    test.expected,
  );
  passed += 1;
  console.log(`[polymarket-order-hash-tests] ok ${test.name}`);
}

console.log(`[polymarket-order-hash-tests] passed ${passed}/${cases.length}`);
