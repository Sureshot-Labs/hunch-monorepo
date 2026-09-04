#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { polymarketRelayerTransactionHash } from "../../../services/polymarket-deposit-wallet-relayer.js";

const transactionId = "relayer_transaction_12345678";
const transactionHash = `0x${"A".repeat(64)}`;

assert.equal(
  polymarketRelayerTransactionHash(transactionId, {
    transactionID: transactionId,
    state: "STATE_FAILED",
  }),
  null,
  "a provider failure label without a hash is not canonical failure evidence",
);

assert.equal(
  polymarketRelayerTransactionHash(transactionId, {
    transactionID: transactionId,
    transactionHash,
    state: "STATE_CONFIRMED",
  }),
  transactionHash.toLowerCase(),
  "a later exact hash must remain recoverable after an advisory failure state",
);

assert.equal(
  polymarketRelayerTransactionHash(transactionId, {
    transactionID: transactionId,
    transactionHash,
    state: "STATE_FAILED",
  }),
  transactionHash.toLowerCase(),
  "chain receipt inspection must win even when the provider label is failed",
);

assert.equal(
  polymarketRelayerTransactionHash(transactionId, {
    transactionID: "another_transaction_12345678",
    transactionHash,
    state: "STATE_CONFIRMED",
  }),
  null,
);

assert.equal(
  polymarketRelayerTransactionHash(transactionId, {
    transactionID: transactionId,
    transactionHash: "0x1234",
    state: "STATE_CONFIRMED",
  }),
  null,
);

console.log("[polymarket-relayer-transaction-tests] passed");
