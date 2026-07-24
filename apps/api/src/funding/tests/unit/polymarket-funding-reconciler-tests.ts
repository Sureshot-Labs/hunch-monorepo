#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";

import {
  PolymarketFundingPostconditionDriver,
  type PolymarketFundingPostconditionTarget,
} from "../../preparation/polymarket-funding-reconciler.js";
import {
  pollFundingPostconditions,
  type FundingPostconditionDriver,
} from "../../preparation/postcondition-driver.js";
import { buildPolymarketFundingPlan } from "../../../services/polymarket-funding-router.js";

const ROUTER = "0x00000000000000000000000000000000000000d1";
const DEPOSIT = "0x00000000000000000000000000000000000000d2";
const SIGNER = "0x00000000000000000000000000000000000000d3";
const TX_HASH = `0x${"12".repeat(32)}`;
const plan = buildPolymarketFundingPlan({
  signer: SIGNER,
  depositWallet: DEPOSIT,
  routerAddress: ROUTER,
  routerNonce: 7n,
  requiredRaw: 5_000_000n,
  depositPusdRaw: 1_500_000n,
  depositLockedRaw: 500_000n,
  depositUsdceRaw: 1_000_000n,
  depositRouterUsdceAllowanceRaw: 1_000_000n,
  signerPusdRaw: 1_500_000n,
  signerUsdceRaw: 1_500_000n,
  routerPusdAllowanceRaw: 1_500_000n,
  routerUsdceAllowanceRaw: 1_500_000n,
  fundingCapRaw: 4_000_000n,
});
assert.ok(plan);

const target: PolymarketFundingPostconditionTarget = {
  operationId: "operation_pm_postcondition_12345678",
  userId: "user_pm_postcondition_12345678",
  stepId: "step_pm_postcondition_12345678",
  attemptId: "attempt_pm_postcondition_12345678",
  stepState: "submitted",
  binding: {
    bindingId: "binding_pm_postcondition_12345678",
    venueId: "polymarket",
    controllerWalletId: "wallet_pm_postcondition_12345678",
    executionWalletId: "wallet_pm_postcondition_12345678",
    accountRef: DEPOSIT,
    settlementLocation: {
      kind: "venue_account",
      locationId: "location_pm_postcondition_12345678",
      accountId: "user_pm_postcondition_12345678",
      asset: {
        networkId: "evm:137",
        assetId: "0x00000000000000000000000000000000000000a1",
        decimals: 6,
      },
      details: { address: DEPOSIT },
    },
    signingMode: "privy_authorization",
  },
  plan,
  before: {
    routerNonceRaw: "7",
    depositPusdRaw: "1500000",
    clobPusdRaw: "1500000",
    observedAt: "2026-07-24T12:00:00.000Z",
  },
  destinationAsset: {
    networkId: "evm:137",
    assetId: "0x00000000000000000000000000000000000000a1",
    decimals: 6,
  },
  signerAddress: SIGNER,
  receiptRefCiphertext: `encrypted:${TX_HASH}`,
  receiptRefLookupHmac: `fingerprint:${TX_HASH}`,
  lookupKeyVersion: 1,
  ledgerHeight: "123",
  blockHash: `0x${"34".repeat(32)}`,
  finalizedAt: new Date("2026-07-24T12:00:04.000Z"),
};

const persisted: unknown[] = [];
const driver = new PolymarketFundingPostconditionDriver(
  {
    keyVersion: 1,
    decrypt: (value) => value.slice("encrypted:".length),
    fingerprint: (value) => `fingerprint:${value}`,
  },
  {
    loadTarget: async () => target,
    observe: async () => ({
      routerNonceRaw: "8",
      depositPusdRaw: "5500000",
      clobPusdRaw: "5500000",
      observedAt: "2026-07-24T12:00:05.000Z",
    }),
    persistSatisfied: async (_pool, input) => {
      persisted.push(input);
    },
  },
);
const pool = {} as Pool;
assert.deepEqual(
  await driver.pollOperation(
    pool,
    target.operationId,
    new Date("2026-07-24T12:00:06.000Z"),
  ),
  { postconditionsPolled: 1 },
);
assert.equal(persisted.length, 1);
assert.equal(
  (
    persisted[0] as Readonly<{
      expectedDepositPusdRaw: string;
      transactionHash: string;
    }>
  ).expectedDepositPusdRaw,
  "5500000",
);
assert.equal(
  (
    persisted[0] as Readonly<{
      expectedDepositPusdRaw: string;
      transactionHash: string;
    }>
  ).transactionHash,
  TX_HASH,
);

let secondDriverPolled = 0;
const independentDriver: FundingPostconditionDriver = {
  driverId: "fake_future_venue_postcondition_v1",
  pollOperation: async () => {
    secondDriverPolled += 1;
    return { postconditionsPolled: 2 };
  },
};
assert.deepEqual(
  await pollFundingPostconditions(
    [driver, independentDriver],
    pool,
    target.operationId,
    new Date("2026-07-24T12:00:07.000Z"),
  ),
  { postconditionsPolled: 3 },
);
assert.equal(secondDriverPolled, 1);

const badReference = new PolymarketFundingPostconditionDriver(
  {
    keyVersion: 1,
    decrypt: () => TX_HASH,
    fingerprint: () => "wrong-fingerprint",
  },
  { loadTarget: async () => target },
);
await assert.rejects(
  () => badReference.pollOperation(pool, target.operationId),
  /integrity check failed/,
);

console.log(
  "[polymarket-funding-reconciler-tests] exact receipt integrity, nonce/balance/CLOB postconditions, persistence handoff, and driver composition passed",
);
