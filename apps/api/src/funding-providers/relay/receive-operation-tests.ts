import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import { stableWalletOpaqueId } from "../../account-value/canonical.js";
import type { FundingReceiveReceiptRoutingTarget } from "../../funding/persistence/funding-receive-session-repository.js";
import { fundingPolicyRevision } from "../../funding/policies/funding-policy.js";
import type { FundingIntentPolicy } from "../../funding/policies/funding-policy-v2.js";
import { isRelayPinnedStableAsset, RELAY_PINNED_ASSETS } from "./mappings.js";
import { createRelayReceiveReceiptDispositionResolver } from "./receive-operation.js";
import { createRelayReferenceCodec } from "./reference-codec.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const USER_WALLET_ID = "00000000-0000-4000-8000-000000000002";
const ADDRESS = "0x00000000000000000000000000000000000000a1";
const SOURCE = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonUsdc,
  decimals: 6,
} as const;
const DESTINATION = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonPusd,
  decimals: 6,
} as const;
const POLICY = {
  version: 2,
  venues: ["polymarket"],
  receive: { assets: ["polygon:usdc"], privy: false },
  paused: false,
} as const satisfies FundingIntentPolicy;

function target(): FundingReceiveReceiptRoutingTarget {
  const walletId = stableWalletOpaqueId({
    walletType: "ethereum",
    networkId: SOURCE.networkId,
    address: ADDRESS,
  });
  const sourceLocationId = "location_source_12345678";
  return {
    receipt: {
      receiptId: "00000000-0000-4000-8000-000000000003",
      receiveSessionId: "00000000-0000-4000-8000-000000000004",
      variantId: "ingress_variant_12345678",
      asset: SOURCE,
      destinationAddress: ADDRESS,
      rawAmount: "1000000",
      observationRevision: "observation_revision_12345678",
      ledgerHeight: "123",
      observedAt: "2026-08-12T10:00:00.000Z",
      status: "observed",
      handling: "automatic_conversion",
      childFundingOperationId: null,
    },
    receiptDestinationLocationId: sourceLocationId,
    receiptVariantSnapshot: {
      variantId: "ingress_variant_12345678",
      networkId: SOURCE.networkId,
      asset: SOURCE,
      destinationAddress: ADDRESS,
      destinationLocationId: sourceLocationId,
      baselineRaw: "0",
      baselineRevision: "baseline_revision_12345678",
      observation: {
        adapterId: "owned_wallet_liquid_balances_v1",
        payload: {
          routeId: "polygon-usdc-to-polygon-pusd",
          balanceKey: `${SOURCE.networkId}:${SOURCE.assetId}:6`,
          sourceComponentId: "asset_component_12345678",
          walletExecutionProfile: {
            walletId,
            controllerWalletRef: USER_WALLET_ID,
            networkId: SOURCE.networkId,
            address: ADDRESS,
            source: "embedded",
            signingModes: ["web_client", "privy_authorization"],
            serverWalletRef: "privy_wallet_12345678",
            sponsorshipPolicyIds: ["privy_user_authorized_evm_sponsorship_v1"],
            evmAtomicBatchMode: "privy_wallet_send_calls",
          },
        },
      },
      completion: { kind: "child_funding_operation" },
    },
    userId: USER_ID,
    ownerChannel: "web",
    venueId: "polymarket",
    destinationOptionId: "destination_option_12345678",
    venueBindingOptionId: "venue_binding_option_12345678",
    destinationAsset: DESTINATION,
    destinationTargetSnapshot: {
      kind: "owned_location",
      location: {
        kind: "venue_account",
        locationId: "location_destination_12345678",
        accountId: USER_ID,
        asset: DESTINATION,
        details: { address: ADDRESS, venueId: "polymarket" },
      },
    },
    venueBindingSnapshot: {
      venueBindingOptionId: "venue_binding_option_12345678",
      safeLabel: "Polymarket",
      readinessClass: "internal_managed",
      preparationPurpose: "fund",
      marketClass: null,
      topology: "embedded",
      inspectionRevision: "inspection_revision_12345678",
      selectable: true,
      reasonCodes: [],
    },
    automationPolicy: {
      stableConversion: "automatic_within_caps",
      volatileConversion: "review_required",
      maximumFeeUsd: "10",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 2,
    policyRevision: fundingPolicyRevision(POLICY),
    ownershipRevision: "ownership_revision_12345678",
    telegramAccountId: null,
    telegramAutomationPolicy: null,
    telegramFundingAuthorizationId: null,
    telegramFundingConsentFingerprint: null,
    telegramFundingConsentId: null,
    telegramUserId: null,
    childOperationStatus: null,
    childOperationRecoveryMode: null,
    childExecutorId: null,
    childBroadcastMayHaveOccurred: false,
    childHasUnfinishedAttempt: false,
    routingAttemptCount: 0,
    routingDisposition: "pending",
  };
}

const resolve = createRelayReceiveReceiptDispositionResolver({
  client: {
    apiKey: "relay-test-secret",
    fetchImpl: async () => {
      throw new Error("evidence-only test must not quote Relay");
    },
  },
  referenceCodec: createRelayReferenceCodec({
    encryptionKey: Buffer.alloc(32, 7),
    lookupHmacKey: "relay-test-lookup-key",
    keyVersion: 1,
  }),
  subjectLookupHmacKey: "subject-test-lookup-key",
  subjectLookupKeyVersion: 1,
});

const accepted = resolve(target());
assert.equal(accepted.kind, "automatic_execution");
assert.ok(accepted.kind === "automatic_execution" && accepted.execution);
assert.deepEqual(accepted.execution.outsidePolicyReview, {
  version: 1,
  kind: "convert",
  label: "Convert to pUSD",
  confirmation: "fresh_quote",
});

const reviewTarget = target();
const review = resolve({
  ...reviewTarget,
  receipt: {
    ...reviewTarget.receipt,
    handling: "review_required",
    status: "review_required",
  },
});
assert.deepEqual(
  review.kind === "review_required" ? review.continuation : null,
  {
    version: 1,
    kind: "convert",
    label: "Convert to pUSD",
    confirmation: "fresh_quote",
  },
  "Relay prepares the same review continuation for a web receipt",
);
assert.equal(
  isRelayPinnedStableAsset({
    ...DESTINATION,
    assetId: DESTINATION.assetId.toUpperCase(),
  }),
  false,
  "malformed EVM-looking assets must not be classified by case folding",
);

const checksumCase = target();
const checksumAccepted = resolve({
  ...checksumCase,
  receipt: {
    ...checksumCase.receipt,
    destinationAddress: `${ADDRESS.slice(0, -2)}A1`,
  },
});
assert.equal(checksumAccepted.kind, "automatic_execution");

let queryCount = 0;
const db = {
  query: async (sql: string) => {
    queryCount += 1;
    if (sql.includes("from runtime_policies")) {
      return { rows: [{ payload: POLICY }], rowCount: 1 };
    }
    if (sql.includes("from users app_user")) {
      return { rows: [{ id: USER_WALLET_ID }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
} as unknown as Pool;
assert.deepEqual(await accepted.execution.decision(db, target()), {
  kind: "allowed",
});
assert.equal(queryCount, 2);

const malformedEvm = target();
const malformedEvmCase = {
  ...malformedEvm,
  receipt: {
    ...malformedEvm.receipt,
    destinationAddress: ADDRESS.toUpperCase(),
  },
};
assert.deepEqual(resolve(malformedEvmCase), {
  kind: "hard_invalid",
  reasonCode: "receipt_quote_plan_invalid",
});

console.log(
  "[relay-receive-operation-tests] frozen route/profile evidence and current policy/wallet guards passed",
);
