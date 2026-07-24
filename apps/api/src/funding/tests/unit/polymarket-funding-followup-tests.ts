#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { VenueAccountBinding } from "../../domain/types.js";
import {
  buildPolymarketFundingFollowupAction,
  verifyPolymarketFundingPostconditions,
} from "../../preparation/polymarket-funding-followup.js";
import { PreparationContractError } from "../../preparation/core-adapter.js";
import { buildPolymarketFundingPlan } from "../../../services/polymarket-funding-router.js";

const ROUTER = "0x00000000000000000000000000000000000000d1";
const DEPOSIT = "0x00000000000000000000000000000000000000d2";
const SIGNER = "0x00000000000000000000000000000000000000d3";

function binding(): VenueAccountBinding {
  return {
    bindingId: "binding_polymarket_followup_12345678",
    venueId: "polymarket",
    controllerWalletId: "wallet_polymarket_followup_12345678",
    executionWalletId: "wallet_polymarket_followup_12345678",
    accountRef: DEPOSIT,
    settlementLocation: {
      kind: "venue_account",
      locationId: "location_polymarket_followup_12345678",
      accountId: "account_polymarket_followup_12345678",
      asset: {
        networkId: "evm:137",
        assetId: "0x00000000000000000000000000000000000000a1",
        decimals: 6,
      },
      details: {
        venueId: "polymarket",
        address: DEPOSIT,
      },
    },
    signingMode: "privy_authorization",
  };
}

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
  signerPusdRaw: 2_000_000n,
  signerLockedRaw: 500_000n,
  signerUsdceRaw: 1_500_000n,
  routerPusdAllowanceRaw: 2_000_000n,
  routerUsdceAllowanceRaw: 2_000_000n,
  fundingCapRaw: 4_000_000n,
});
assert.ok(plan);

const action = buildPolymarketFundingFollowupAction({
  binding: binding(),
  canonicalRouterAddress: ROUTER,
  inspectionRevision: "inspection_followup_12345678",
  operationId: "operation_followup_12345678",
  plan,
});
assert.equal(action.kind, "evm_transaction");
assert.equal(action.to.toLowerCase(), ROUTER.toLowerCase());
assert.equal(action.senderWalletId, binding().executionWalletId);

const satisfied = verifyPolymarketFundingPostconditions({
  binding: binding(),
  canonicalRouterAddress: ROUTER,
  plan,
  receipt: "success",
  before: {
    routerNonceRaw: "7",
    depositPusdRaw: "1500000",
    clobPusdRaw: "1500000",
    observedAt: "2026-07-24T12:00:00.000Z",
  },
  after: {
    routerNonceRaw: "8",
    depositPusdRaw: "5500000",
    clobPusdRaw: "5500000",
    observedAt: "2026-07-24T12:00:05.000Z",
  },
});
assert.equal(satisfied.status, "satisfied");
assert.equal(satisfied.expectedDepositPusdRaw, "5500000");

const invisible = verifyPolymarketFundingPostconditions({
  binding: binding(),
  canonicalRouterAddress: ROUTER,
  plan,
  receipt: "success",
  before: {
    routerNonceRaw: "7",
    depositPusdRaw: "1500000",
    clobPusdRaw: "1500000",
    observedAt: "2026-07-24T12:00:00.000Z",
  },
  after: {
    routerNonceRaw: "8",
    depositPusdRaw: "5500000",
    clobPusdRaw: null,
    observedAt: "2026-07-24T12:00:05.000Z",
  },
});
assert.equal(invisible.status, "unavailable");
assert.deepEqual(invisible.reasonCodes, ["clob_collateral_not_visible"]);

const stale = verifyPolymarketFundingPostconditions({
  binding: binding(),
  canonicalRouterAddress: ROUTER,
  plan,
  receipt: "success",
  before: {
    routerNonceRaw: "8",
    depositPusdRaw: "1500000",
    clobPusdRaw: "1500000",
    observedAt: "2026-07-24T12:00:00.000Z",
  },
  after: null,
});
assert.equal(stale.status, "unavailable");
assert.deepEqual(stale.reasonCodes, ["preparation_evidence_stale"]);

const ambiguous = verifyPolymarketFundingPostconditions({
  binding: binding(),
  canonicalRouterAddress: ROUTER,
  plan,
  receipt: "ambiguous",
  before: {
    routerNonceRaw: "7",
    depositPusdRaw: "1500000",
    clobPusdRaw: "1500000",
    observedAt: "2026-07-24T12:00:00.000Z",
  },
  after: null,
});
assert.equal(ambiguous.status, "reconcile_required");

await assert.rejects(
  async () =>
    buildPolymarketFundingFollowupAction({
      binding: { ...binding(), accountRef: SIGNER },
      canonicalRouterAddress: ROUTER,
      inspectionRevision: "inspection_followup_12345678",
      operationId: "operation_followup_12345678",
      plan,
    }),
  (error: unknown) =>
    error instanceof PreparationContractError &&
    error.code === "binding_mismatch",
);

console.log(
  "[polymarket-funding-followup-tests] ok exact action, stale nonce, ambiguous receipt, and CLOB visibility",
);
