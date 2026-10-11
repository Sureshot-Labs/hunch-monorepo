#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { Interface } from "ethers";
import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";

import type { UserWallet } from "../../../auth.js";
import { env } from "../../../env.js";
import type {
  PreparationActionTemplate,
  VenuePreparationFacts,
} from "../../preparation/core-adapter.js";
import {
  createLimitlessRuntimeActionMaterializer,
  createPolymarketRuntimeActionMaterializer,
} from "../../preparation/runtime-actions.js";
import type { VenueAccountBinding } from "../../domain/types.js";
import { fundingSidecarRuntimeConfig } from "../../runtime/sidecar-runtime-config.js";

const OBSERVED_AT = "2026-07-24T12:00:00.000Z";
const erc20Interface = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

async function test(
  name: string,
  run: () => void | Promise<void>,
): Promise<void> {
  await run();
  console.log(`[funding-runtime-actions-tests] ok ${name}`);
}

function wallet(internal: boolean): UserWallet {
  return {
    id: "wallet-row-runtime-actions",
    userId: "account_runtime_actions_12345678",
    walletAddress: "0x00000000000000000000000000000000000000e1",
    walletType: "ethereum",
    name: null,
    isPrimary: true,
    isVerified: true,
    privyWalletId: internal ? "privy_runtime_actions_12345678" : null,
    walletSource: internal ? "embedded" : "external",
    isInternalWallet: internal,
    privyProfileUpdatedAt: new Date(OBSERVED_AT),
    createdAt: new Date(OBSERVED_AT),
    updatedAt: new Date(OBSERVED_AT),
  };
}

function binding(venue: "limitless" | "polymarket"): VenueAccountBinding {
  const networkId = venue === "polymarket" ? "evm:137" : "evm:8453";
  return {
    bindingId: `binding_${venue}_actions_12345678`,
    venueId: venue,
    controllerWalletId: `wallet_${venue}_actions_12345678`,
    executionWalletId: `wallet_${venue}_actions_12345678`,
    accountRef: "0x00000000000000000000000000000000000000f1",
    settlementLocation: {
      kind: "venue_account",
      locationId: `location_${venue}_actions_12345678`,
      accountId: "account_runtime_actions_12345678",
      asset: {
        networkId,
        assetId:
          venue === "polymarket"
            ? env.polymarketUsdcAddress
            : env.limitlessUsdcAddress,
        decimals: 6,
      },
      details: {
        venueId: venue,
        address: "0x00000000000000000000000000000000000000f1",
      },
    },
    signingMode: "privy_authorization",
  };
}

function facts(exactBinding: VenueAccountBinding): VenuePreparationFacts {
  return {
    binding: exactBinding,
    safeLabel: "Runtime action test",
    purpose: "buy",
    marketClass: exactBinding.venueId === "polymarket" ? "standard" : "clob",
    readinessClass: "internal_managed",
    executionMode: "privy_authorization",
    topology: exactBinding.venueId === "polymarket" ? "signer" : "internal_eoa",
    observedAt: OBSERVED_AT,
    expiresAt: "2026-07-24T12:01:00.000Z",
    evidence: {},
    checks: [],
  };
}

function requirement(
  actionKey: string,
  kind: PreparationActionTemplate["summary"]["kind"],
): PreparationActionTemplate {
  return {
    actionKey,
    action: null,
    summary: {
      kind,
      safeLabel: actionKey,
      actor: "user",
      valueMoving: false,
      sponsorship: "none",
    },
  } as PreparationActionTemplate;
}

function materializerInput(
  exactBinding: VenueAccountBinding,
  requiredActions: readonly PreparationActionTemplate[],
) {
  return {
    request: {
      accountId: exactBinding.settlementLocation.accountId,
      binding: exactBinding,
      purpose: "buy" as const,
      marketClass: exactBinding.venueId === "polymarket" ? "standard" : "clob",
      marketContextId: "market_runtime_actions_12345678",
      operationId: "operation_runtime_actions_12345678",
      expectedInspectionRevision: "inspection_runtime_actions_12345678",
    },
    facts: facts(exactBinding),
    inspectionRevision: "inspection_runtime_actions_12345678",
    requiredChecks: [],
    requiredActions,
  };
}

await test("Polymarket connect preparation is deterministic and contains no secret", async () => {
  const exactBinding = binding("polymarket");
  const materialize = createPolymarketRuntimeActionMaterializer({
    wallet: wallet(true),
    topology: "signer",
    funder: exactBinding.accountRef,
    redemptionOperator: null,
  });
  const input = materializerInput(exactBinding, [
    requirement("connect-polymarket", "signature"),
  ]);
  const first = await materialize(input);
  const second = await materialize(input);
  assert.deepEqual(first, second);
  assert.equal(first[0]?.action?.kind, "signature");
  const encoded = JSON.stringify(first);
  assert.doesNotMatch(encoded, /apiSecret|privateKey|authorizationSignature/i);
  assert.match(encoded, /polymarket-connect/i);
});

await test("V2 actions target canonical pUSD/V3 and PM/V3 or Router across wallet envelopes", async () => {
  const exactBinding = binding("polymarket");
  const erc1155 = new Interface([
    "function setApprovalForAll(address operator,bool approved)",
  ]);
  const cases = [
    {
      check: "erc20_v3_exchange_allowance",
      token: POLYMARKET_PROTOCOL_CONTRACTS.collateral,
      spender: POLYMARKET_PROTOCOL_CONTRACTS.exchangeV3,
      erc20: true,
    },
    {
      check: "position_manager_v3_approval",
      token: POLYMARKET_PROTOCOL_CONTRACTS.positionManager,
      spender: POLYMARKET_PROTOCOL_CONTRACTS.exchangeV3,
      erc20: false,
    },
    {
      check: "redemption_operator_approval",
      token: POLYMARKET_PROTOCOL_CONTRACTS.positionManager,
      spender: POLYMARKET_PROTOCOL_CONTRACTS.router,
      erc20: false,
    },
  ];
  for (const topology of [
    "signer",
    "deposit_wallet",
    "safe_1_1",
    "magic_proxy",
  ] as const) {
    const materialize = createPolymarketRuntimeActionMaterializer({
      wallet: wallet(true),
      topology,
      funder: exactBinding.accountRef,
      redemptionOperator: POLYMARKET_PROTOCOL_CONTRACTS.router,
    });
    for (const row of cases) {
      const [result] = await materialize(
        materializerInput(exactBinding, [
          requirement(
            `approve-${row.check}`,
            topology === "signer" ? "evm_transaction" : "external_handoff",
          ),
        ]),
      );
      const action = result?.action;
      assert.ok(action);
      const call =
        action.kind === "evm_transaction"
          ? { target: action.to, data: action.data }
          : action.kind === "external_handoff"
            ? (
                action.payload.calls as Array<{ target: string; data: string }>
              )[0]
            : null;
      assert.ok(call);
      assert.equal(call.target, row.token);
      const decoded = (row.erc20 ? erc20Interface : erc1155).decodeFunctionData(
        row.erc20 ? "approve" : "setApprovalForAll",
        call.data,
      );
      assert.equal(decoded[0].toLowerCase(), row.spender.toLowerCase());
      assert.equal(decoded[1], row.erc20 ? (1n << 256n) - 1n : true);
      // DepositWallet remains a relayer handoff, never a sponsored direct call.
      if (topology === "deposit_wallet")
        assert.equal(action.kind, "external_handoff");
    }
  }
});

await test("Polymarket signer and contract approvals preserve distinct execution envelopes", async () => {
  const exactBinding = binding("polymarket");
  const signerMaterializer = createPolymarketRuntimeActionMaterializer({
    wallet: wallet(false),
    topology: "signer",
    funder: wallet(false).walletAddress,
    redemptionOperator: null,
  });
  const signer = await signerMaterializer(
    materializerInput(exactBinding, [
      requirement("approve-erc20_exchange_allowance", "evm_transaction"),
    ]),
  );
  assert.equal(signer[0]?.action?.kind, "evm_transaction");
  if (signer[0]?.action?.kind === "evm_transaction") {
    assert.equal(
      signer[0].action.to.toLowerCase(),
      env.polymarketUsdcAddress.toLowerCase(),
    );
    assert.match(signer[0].action.data, /^0x[0-9a-f]+$/i);
  }

  const proxyMaterializer = createPolymarketRuntimeActionMaterializer({
    wallet: wallet(true),
    topology: "deposit_wallet",
    funder: exactBinding.accountRef,
    redemptionOperator: null,
  });
  const proxy = await proxyMaterializer(
    materializerInput(exactBinding, [
      requirement("approve-erc20_exchange_allowance", "external_handoff"),
    ]),
  );
  assert.equal(proxy[0]?.action?.kind, "external_handoff");
  if (proxy[0]?.action?.kind === "external_handoff") {
    assert.equal(proxy[0].action.handoffKind, "polymarket_proxy_execute");
  }
});

await test("Polymarket Funding Router approvals are controller-signer transactions", async () => {
  // This materializer intentionally reads the sidecar-safe frozen config.
  // In the aggregate test runner that module may be loaded before API env.ts;
  // do not assert against a different, later-loaded configuration snapshot.
  if (!fundingSidecarRuntimeConfig.polymarketFundingRouterAddress) return;
  const exactBinding = binding("polymarket");
  const materialize = createPolymarketRuntimeActionMaterializer({
    wallet: wallet(true),
    topology: "deposit_wallet",
    funder: exactBinding.accountRef,
    redemptionOperator: null,
  });
  const actions = await materialize(
    materializerInput(exactBinding, [
      requirement("approve-funding-router-signer-pusd", "evm_transaction"),
      requirement("approve-funding-router-signer-usdce", "evm_transaction"),
    ]),
  );
  assert.equal(actions[0]?.action?.kind, "evm_transaction");
  assert.equal(actions[1]?.action?.kind, "evm_transaction");
  if (actions[0]?.action?.kind === "evm_transaction") {
    assert.equal(
      actions[0].action.to.toLowerCase(),
      fundingSidecarRuntimeConfig.polymarketPusdAddress.toLowerCase(),
    );
  }
  if (actions[1]?.action?.kind === "evm_transaction") {
    assert.equal(
      actions[1].action.to.toLowerCase(),
      fundingSidecarRuntimeConfig.polymarketUsdceAddress.toLowerCase(),
    );
  }
});

await test("Limitless connect and CLOB approval use the exact market exchange", async () => {
  const exactBinding = binding("limitless");
  const marketExchange = "0x00000000000000000000000000000000000000a1";
  let signingMessageReads = 0;
  const materialize = createLimitlessRuntimeActionMaterializer({
    wallet: wallet(true),
    adapterAddress: null,
    ammAddress: null,
    clobAddress: marketExchange,
    fetchSigningMessage: async () => {
      signingMessageReads += 1;
      return "Sign in to Limitless";
    },
  });
  const actions = await materialize(
    materializerInput(exactBinding, [
      requirement("connect-limitless", "signature"),
      requirement("approve-clob_usdc_allowance", "evm_transaction"),
    ]),
  );
  assert.equal(signingMessageReads, 1);
  assert.equal(actions[0]?.action?.kind, "signature");
  assert.equal(actions[1]?.action?.kind, "evm_transaction");
  if (actions[1]?.action?.kind === "evm_transaction") {
    assert.equal(
      actions[1].action.to.toLowerCase(),
      env.limitlessUsdcAddress.toLowerCase(),
    );
    const decoded = erc20Interface.decodeFunctionData(
      "approve",
      actions[1].action.data,
    );
    assert.equal(String(decoded[0]).toLowerCase(), marketExchange);
  }
});

await test("Limitless legacy CLOB approval retains the configured fallback", async () => {
  const exactBinding = binding("limitless");
  const materialize = createLimitlessRuntimeActionMaterializer({
    wallet: wallet(true),
    adapterAddress: null,
    ammAddress: null,
  });
  const actions = await materialize(
    materializerInput(exactBinding, [
      requirement("approve-clob_usdc_allowance", "evm_transaction"),
    ]),
  );
  assert.equal(actions[0]?.action?.kind, "evm_transaction");
  if (actions[0]?.action?.kind === "evm_transaction") {
    const decoded = erc20Interface.decodeFunctionData(
      "approve",
      actions[0].action.data,
    );
    assert.equal(
      String(decoded[0]).toLowerCase(),
      fundingSidecarRuntimeConfig.limitlessClobAddress.toLowerCase(),
    );
  }
});

console.log("[funding-runtime-actions-tests] complete");
