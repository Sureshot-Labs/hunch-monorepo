import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  limitlessAmmOrderBodySchema,
  limitlessOrderBodySchema,
} from "../../../schemas/limitless-private.js";
import { polymarketPlaceOrderBodySchema } from "../../../schemas/polymarket-private.js";

const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const RESERVATION_ID = "00000000-0000-4000-8000-000000000002";
const TRADE_ATTEMPT_ID = "00000000-0000-4000-8000-000000000003";
const ADDRESS = "0x0000000000000000000000000000000000000001";
const TX_HASH = `0x${"a".repeat(64)}`;

const polymarketOrder = {
  salt: "1",
  maker: ADDRESS,
  signer: ADDRESS,
  tokenId: "1",
  makerAmount: "1000000",
  takerAmount: "1000000",
  expiration: "0",
  side: "0",
  signatureType: "0",
  signature: "0x1234",
  timestamp: "1",
  metadata: `0x${"0".repeat(64)}`,
  builder: `0x${"1".repeat(64)}`,
};

const limitlessOrder = {
  salt: "1",
  maker: ADDRESS,
  signer: ADDRESS,
  tokenId: "1",
  makerAmount: "1000000",
  takerAmount: "1",
  expiration: "1",
  nonce: "0",
  side: "0",
  signatureType: "0",
  signature: "0x1234",
};

assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order: polymarketOrder,
    fundingOperationId: OPERATION_ID,
  }).success,
  false,
);
assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order: polymarketOrder,
    orderType: "FAK",
  }).success,
  true,
);
assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order: polymarketOrder,
    orderType: "FAK",
    postOnly: true,
  }).success,
  false,
);
assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order: polymarketOrder,
    fundingOperationId: OPERATION_ID,
    fundingReservationId: RESERVATION_ID,
  }).success,
  true,
);
assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order: polymarketOrder,
    orderType: "GTC",
    postOnly: true,
  }).success,
  true,
);
assert.equal(
  polymarketPlaceOrderBodySchema.safeParse({
    order: polymarketOrder,
    orderType: "FOK",
    postOnly: true,
  }).success,
  false,
);

assert.equal(
  limitlessOrderBodySchema.safeParse({
    order: limitlessOrder,
    orderType: "FOK",
    marketSlug: "market-one",
    fundingReservationId: RESERVATION_ID,
  }).success,
  false,
);
assert.equal(
  limitlessOrderBodySchema.safeParse({
    order: limitlessOrder,
    orderType: "FOK",
    marketSlug: "market-one",
    fundingOperationId: OPERATION_ID,
    fundingReservationId: RESERVATION_ID,
  }).success,
  true,
);
assert.equal(
  limitlessOrderBodySchema.safeParse({
    order: limitlessOrder,
    orderType: "GTC",
    postOnly: true,
    marketSlug: "market-one",
  }).success,
  true,
);
assert.equal(
  limitlessOrderBodySchema.safeParse({
    order: limitlessOrder,
    orderType: "FOK",
    postOnly: true,
    marketSlug: "market-one",
  }).success,
  false,
);

assert.equal(
  limitlessAmmOrderBodySchema.safeParse({
    tokenId: "limitless:1",
    side: "BUY",
    size: 1,
    txHash: TX_HASH,
    fundingOperationId: OPERATION_ID,
  }).success,
  false,
);
assert.equal(
  limitlessAmmOrderBodySchema.safeParse({
    tokenId: "limitless:1",
    side: "BUY",
    size: 1,
    txHash: TX_HASH,
    fundingOperationId: OPERATION_ID,
    fundingReservationId: RESERVATION_ID,
    fundingTradeAttemptId: TRADE_ATTEMPT_ID,
  }).success,
  true,
);

const limitlessExecutionSource = readFileSync(
  new URL(
    "../../../services/limitless-trading-execution-service.ts",
    import.meta.url,
  ),
  "utf8",
);
assert.match(
  limitlessExecutionSource,
  /input\.body\.postOnly === true \? \{ postOnly: true \} : \{\}/,
  "Limitless GTC postOnly must reach the venue payload",
);
assert.match(
  limitlessExecutionSource,
  /venueId: "limitless",[\s\S]*?raw: makerAmount\.toString\(\)/,
  "Limitless BUY reservations must stay bounded by signed makerAmount without a synthetic USDC fee buffer",
);
assert.match(
  limitlessExecutionSource,
  /canonicalFingerprint = canonicalJsonHash\(\{[\s\S]*?orderType: input\.body\.orderType,[\s\S]*?postOnly: input\.body\.postOnly === true,/,
  "postOnly must be part of the exact funded Limitless trade identity",
);

console.log(
  "[trade-funding-link-schema-tests] funding linkage and limit-order contracts passed",
);
