#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { PreparationInspectionInput } from "../../domain/contracts.js";
import type { VenueAccountBinding } from "../../domain/types.js";
import { LimitlessWalletPreparationAdapter } from "../../preparation/limitless-adapter.js";
import { PolymarketWalletPreparationAdapter } from "../../preparation/polymarket-adapter.js";
import {
  buildLimitlessRuntimeFacts,
  buildPolymarketRuntimeFacts,
  type LimitlessRuntimeEvidence,
  type PolymarketRuntimeEvidence,
} from "../../preparation/runtime-facts.js";
import type { PreparationActionTemplate } from "../../preparation/core-adapter.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const OBSERVED_AT = NOW.toISOString();
const EXPIRES_AT = new Date(NOW.getTime() + 60_000).toISOString();

async function test(
  name: string,
  run: () => void | Promise<void>,
): Promise<void> {
  await run();
  console.log(`[funding-runtime-facts-tests] ok ${name}`);
}

function binding(venueId: "limitless" | "polymarket"): VenueAccountBinding {
  const networkId = venueId === "polymarket" ? "evm:137" : "evm:8453";
  return {
    bindingId: `binding_${venueId}_runtime_12345678`,
    venueId,
    controllerWalletId: `wallet_${venueId}_controller_12345678`,
    executionWalletId: `wallet_${venueId}_controller_12345678`,
    accountRef: "0x00000000000000000000000000000000000000f1",
    settlementLocation: {
      kind: "venue_account",
      locationId: `location_${venueId}_runtime_12345678`,
      accountId: "account_runtime_12345678",
      asset: {
        networkId,
        assetId:
          venueId === "polymarket"
            ? "0x00000000000000000000000000000000000000a1"
            : "0x00000000000000000000000000000000000000b1",
        decimals: 6,
      },
      details: {
        venueId,
        accountRef: "0x00000000000000000000000000000000000000f1",
        controllerWalletId: `wallet_${venueId}_controller_12345678`,
        address: "0x00000000000000000000000000000000000000f1",
      },
    },
    signingMode: "privy_authorization",
  };
}

function input(
  exactBinding: VenueAccountBinding,
  purpose: PreparationInspectionInput["purpose"],
  marketClass: string | null,
): PreparationInspectionInput {
  return {
    accountId: exactBinding.settlementLocation.accountId,
    binding: exactBinding,
    purpose,
    marketClass,
    marketContextId:
      purpose === "buy" || purpose === "sell" || purpose === "redeem"
        ? "market_runtime_12345678"
        : null,
  };
}

function polymarketEvidence(
  overrides: Partial<PolymarketRuntimeEvidence> = {},
): PolymarketRuntimeEvidence {
  const exactBinding = overrides.binding ?? binding("polymarket");
  return {
    binding: exactBinding,
    wallet: {
      source: "embedded",
      internal: true,
      privyWalletId: "privy_wallet_runtime_12345678",
      profileObservedAt: OBSERVED_AT,
    },
    topology: "deposit_wallet",
    executionMode: "venue_relayer",
    rpcAvailable: true,
    walletDeployed: true,
    ownerVerified: true,
    credentials: {
      present: true,
      boundToExactWallet: true,
      verified: true,
      observedAt: OBSERVED_AT,
      stale: false,
    },
    market: {
      resolved: true,
      orderable: true,
      adapterResolved: true,
      exchangeResolved: true,
      quoteGuardAvailable: true,
      safeMarketRef: "market_runtime_12345678",
    },
    position: {
      ownerMatchesBinding: true,
      balanceRaw: "1000000",
      lockedRaw: "0",
      conditionResolved: true,
      canonicalPlanAvailable: true,
      operatorApproved: true,
    },
    withdrawal: {
      assetSupported: true,
      recipientValid: true,
      callValidated: true,
    },
    collateralObserved: true,
    collateralRaw: "1000000",
    collateralLockedRaw: "0",
    fundingRouter: {
      canonical: true,
      configured: true,
      routerAddress: "0x00000000000000000000000000000000000000d1",
      nonceRaw: "7",
      depositUsdceAllowanceRaw: "1000000",
      pUsdAllowanceRaw: "1000000",
      usdceAllowanceRaw: "1000000",
    },
    clobCollateralVisible: true,
    standardExchangeAllowance: true,
    negRiskExchangeAllowance: true,
    negRiskAdapterAllowance: true,
    standardExchangeApproval: true,
    negRiskExchangeApproval: true,
    negRiskAdapterApproval: true,
    observedAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT,
    safeEvidence: {
      signer: "0x00000000000000000000000000000000000000e1",
      funder: exactBinding.accountRef,
      collateralRaw: "1000000",
    },
    ...overrides,
  };
}

function limitlessEvidence(
  overrides: Partial<LimitlessRuntimeEvidence> = {},
): LimitlessRuntimeEvidence {
  const exactBinding = overrides.binding ?? binding("limitless");
  return {
    binding: exactBinding,
    wallet: {
      source: "embedded",
      internal: true,
      privyWalletId: "privy_wallet_runtime_12345678",
      profileObservedAt: OBSERVED_AT,
    },
    topology: "internal_eoa",
    executionMode: "privy_authorization",
    rpcAvailable: true,
    ownerVerified: true,
    credentials: {
      present: true,
      boundToExactWallet: true,
      verified: true,
      observedAt: OBSERVED_AT,
      stale: false,
    },
    market: {
      resolved: true,
      orderable: true,
      adapterResolved: true,
      exchangeResolved: true,
      quoteGuardAvailable: true,
      safeMarketRef: "market_runtime_12345678",
    },
    position: {
      ownerMatchesBinding: true,
      balanceRaw: "1000000",
      lockedRaw: "0",
      conditionResolved: true,
      canonicalPlanAvailable: true,
      operatorApproved: true,
    },
    withdrawal: {
      assetSupported: true,
      recipientValid: true,
      callValidated: true,
    },
    cashObserved: true,
    cashRaw: "1000000",
    cashLockedRaw: "0",
    clobAllowance: true,
    negRiskClobAllowance: true,
    ammAllowance: true,
    clobApproval: true,
    negRiskClobApproval: true,
    ammApproval: true,
    marketAdapterApproval: true,
    observedAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT,
    safeEvidence: {
      wallet: exactBinding.accountRef,
      cashRaw: "1000000",
    },
    ...overrides,
  };
}

await test("Polymarket runtime facts produce ready rows for every purpose", async () => {
  for (const purpose of [
    "fund",
    "buy",
    "sell",
    "redeem",
    "withdraw",
  ] as const) {
    for (const marketClass of ["standard", "neg_risk"] as const) {
      const exactBinding = binding("polymarket");
      const exactInput = input(
        exactBinding,
        purpose,
        purpose === "fund" || purpose === "withdraw" ? null : marketClass,
      );
      const adapter = new PolymarketWalletPreparationAdapter(
        async (request) =>
          buildPolymarketRuntimeFacts(
            request,
            polymarketEvidence({ binding: exactBinding }),
          ),
        () => NOW,
      );
      const result = await adapter.inspect(exactInput);
      assert.equal(result.status, "ready", `${purpose}:${marketClass}`);
    }
  }
});

await test("unknown wallet authority fails closed", async () => {
  const exactBinding = binding("polymarket");
  const exactInput = input(exactBinding, "fund", null);
  const adapter = new PolymarketWalletPreparationAdapter(
    async (request) =>
      buildPolymarketRuntimeFacts(
        request,
        polymarketEvidence({
          binding: exactBinding,
          wallet: {
            source: "unknown",
            internal: false,
            privyWalletId: null,
            profileObservedAt: null,
          },
        }),
      ),
    () => NOW,
  );
  const result = await adapter.inspect(exactInput);
  assert.equal(result.status, "unavailable");
  assert.equal(result.readinessClass, "external_view_only");
  assert.ok(result.reasonCodes.includes("wallet_unavailable"));
});

await test("deferred actions are materialized only after revision revalidation", async () => {
  const exactBinding = binding("polymarket");
  const exactInput = input(exactBinding, "buy", "standard");
  let materializations = 0;
  const evidence = polymarketEvidence({
    binding: exactBinding,
    credentials: {
      present: false,
      boundToExactWallet: false,
      verified: false,
      observedAt: null,
      stale: false,
    },
    standardExchangeAllowance: false,
  });
  const adapter = new PolymarketWalletPreparationAdapter(
    async (request) => buildPolymarketRuntimeFacts(request, evidence),
    () => NOW,
    async ({ requiredActions }) => {
      materializations += 1;
      return requiredActions.map((requirement): PreparationActionTemplate => {
        if (requirement.summary.kind === "signature") {
          return {
            ...requirement,
            action: {
              kind: "signature" as const,
              networkId: exactBinding.settlementLocation.asset.networkId,
              signerWalletId: exactBinding.executionWalletId,
              payloadKind: "personal_message" as const,
              payload: { message: "bounded preparation request" },
            },
          };
        }
        if (requirement.summary.kind === "external_handoff") {
          return {
            ...requirement,
            action: {
              kind: "external_handoff",
              networkId: exactBinding.settlementLocation.asset.networkId,
              actorWalletId: exactBinding.executionWalletId,
              handoffKind: "polymarket_proxy_execute",
              payload: { calls: [] },
            },
          };
        }
        assert.equal(requirement.summary.kind, "evm_transaction");
        return {
          ...requirement,
          action: {
            kind: "evm_transaction",
            networkId: exactBinding.settlementLocation.asset.networkId,
            senderWalletId: exactBinding.executionWalletId,
            to: "0x00000000000000000000000000000000000000c1",
            data: "0x1234",
            valueRaw: "0",
            gasLimitRaw: null,
          },
        };
      });
    },
  );
  const inspected = await adapter.inspect(exactInput);
  assert.equal(materializations, 0);
  assert.equal(inspected.status, "setup_required");
  const actions = await adapter.prepare({
    ...exactInput,
    operationId: "operation_runtime_12345678",
    expectedInspectionRevision: inspected.inspectionRevision,
  });
  assert.equal(materializations, 1);
  assert.equal(actions.length, 2);
  assert.ok(actions.every((action) => action.actionId.startsWith("action_")));
});

await test("Limitless fund readiness does not imply CLOB or AMM readiness", async () => {
  const exactBinding = binding("limitless");
  const evidence = limitlessEvidence({
    binding: exactBinding,
    credentials: {
      present: false,
      boundToExactWallet: false,
      verified: false,
      observedAt: null,
      stale: false,
    },
    clobAllowance: false,
    ammAllowance: false,
  });
  const adapter = new LimitlessWalletPreparationAdapter(
    async (request) => buildLimitlessRuntimeFacts(request, evidence),
    () => NOW,
  );
  const fund = await adapter.inspect(input(exactBinding, "fund", null));
  const clobBuy = await adapter.inspect(input(exactBinding, "buy", "clob"));
  const ammBuy = await adapter.inspect(input(exactBinding, "buy", "amm"));
  assert.equal(fund.status, "ready");
  assert.equal(clobBuy.status, "setup_required");
  assert.equal(ammBuy.status, "setup_required");
  assert.ok(clobBuy.reasonCodes.includes("venue_profile_missing"));
  assert.ok(ammBuy.reasonCodes.includes("operator_approval_required"));
});

await test("Limitless CLOB and AMM approval evidence is not interchangeable", async () => {
  const exactBinding = binding("limitless");
  const evidence = limitlessEvidence({
    binding: exactBinding,
    clobAllowance: true,
    ammAllowance: false,
  });
  const adapter = new LimitlessWalletPreparationAdapter(
    async (request) => buildLimitlessRuntimeFacts(request, evidence),
    () => NOW,
  );
  const clob = await adapter.inspect(input(exactBinding, "buy", "clob"));
  const amm = await adapter.inspect(input(exactBinding, "buy", "amm"));
  assert.equal(clob.status, "ready");
  assert.equal(amm.status, "setup_required");
});

console.log("[funding-runtime-facts-tests] complete");
