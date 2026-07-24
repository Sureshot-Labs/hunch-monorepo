import assert from "node:assert/strict";

import {
  limitlessAmmOrderBodySchema,
  limitlessOrderBodySchema,
} from "../../../schemas/limitless-private.js";
import { polymarketPlaceOrderBodySchema } from "../../../schemas/polymarket-private.js";

const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const RESERVATION_ID = "00000000-0000-4000-8000-000000000002";
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
    fundingOperationId: OPERATION_ID,
    fundingReservationId: RESERVATION_ID,
  }).success,
  true,
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
  }).success,
  true,
);

console.log(
  "[trade-funding-link-schema-tests] paired opaque funding linkage passed",
);
