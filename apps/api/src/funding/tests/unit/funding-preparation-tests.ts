#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { PreparationInspectionInput } from "../../domain/contracts.js";
import type {
  ActionSummary,
  FundingReasonCode,
  VenueAccountBinding,
} from "../../domain/types.js";
import {
  PreparationContractError,
  type PreparationActionTemplate,
  type PreparationFactCheck,
  type VenuePreparationFacts,
} from "../../preparation/core-adapter.js";
import {
  LIMITLESS_PREPARATION_REQUIREMENTS,
  LimitlessWalletPreparationAdapter,
} from "../../preparation/limitless-adapter.js";
import {
  POLYMARKET_PREPARATION_REQUIREMENTS,
  PolymarketWalletPreparationAdapter,
} from "../../preparation/polymarket-adapter.js";
import { OwnerBoundPositionActionExecutor } from "../../preparation/position-action-executor.js";
import {
  derivePolymarketBeaconDepositWallet,
  derivePolymarketUupsDepositWallet,
} from "../../../services/polymarket-deposit-wallet-derivation.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const EXPIRES = "2026-07-24T12:05:00.000Z";

async function test(
  name: string,
  run: () => Promise<void> | void,
): Promise<void> {
  await run();
  console.log(`[funding-preparation-tests] ok ${name}`);
}

function binding(venueId: "polymarket" | "limitless"): VenueAccountBinding {
  const networkId = venueId === "polymarket" ? "evm:137" : "evm:8453";
  const assetId =
    venueId === "polymarket"
      ? "0x00000000000000000000000000000000000000a1"
      : "0x00000000000000000000000000000000000000b1";
  return {
    bindingId: `binding_${venueId}_12345678`,
    venueId,
    controllerWalletId: `wallet_${venueId}_controller`,
    executionWalletId: `wallet_${venueId}_execution`,
    accountRef: "0x00000000000000000000000000000000000000f1",
    settlementLocation: {
      kind: "venue_account",
      locationId: `location_${venueId}_12345678`,
      accountId: "account_wp6_12345678",
      asset: { networkId, assetId, decimals: 6 },
      details: {
        venueId,
        address: "0x00000000000000000000000000000000000000f1",
      },
    },
    signingMode: "web_client",
  };
}

const actionSummary: ActionSummary = {
  kind: "evm_transaction",
  safeLabel: "Apply exact venue preparation",
  actor: "user",
  valueMoving: false,
  sponsorship: "none",
};

function action(
  exactBinding: VenueAccountBinding,
  actionKey: string,
): PreparationActionTemplate {
  return {
    actionKey,
    action: {
      kind: "evm_transaction",
      networkId: exactBinding.settlementLocation.asset.networkId,
      senderWalletId: exactBinding.executionWalletId,
      to: "0x00000000000000000000000000000000000000c1",
      data: "0x1234",
      valueRaw: "0",
      gasLimitRaw: null,
    },
    summary: actionSummary,
  };
}

function check(
  checkId: string,
  overrides: Partial<PreparationFactCheck> = {},
): PreparationFactCheck {
  return {
    checkId,
    status: "satisfied",
    safeLabel: `${checkId} verified`,
    reasonCode: null,
    actions: [],
    postcondition: {
      kind: checkId,
      safeLabel: `${checkId} remains satisfied`,
    },
    ...overrides,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const polymarketCheckIds = unique(
  Object.values(POLYMARKET_PREPARATION_REQUIREMENTS).flatMap((byClass) =>
    Object.values(byClass).flat(),
  ),
);
const limitlessCheckIds = unique(
  Object.values(LIMITLESS_PREPARATION_REQUIREMENTS).flatMap((byClass) =>
    Object.values(byClass).flat(),
  ),
);

function preparationInput(
  exactBinding: VenueAccountBinding,
  purpose: PreparationInspectionInput["purpose"],
  marketClass: string,
): PreparationInspectionInput {
  return {
    accountId: exactBinding.settlementLocation.accountId,
    binding: exactBinding,
    purpose,
    marketClass,
    marketContextId: "market_context_wp6_12345678",
  };
}

function facts(input: {
  exactBinding: VenueAccountBinding;
  purpose: PreparationInspectionInput["purpose"];
  marketClass: string;
  topology: string;
  checkIds: readonly string[];
  overrides?: Readonly<Record<string, Partial<PreparationFactCheck>>>;
  evidence?: VenuePreparationFacts["evidence"];
}): VenuePreparationFacts {
  return {
    binding: input.exactBinding,
    safeLabel: `${input.exactBinding.venueId} test binding`,
    purpose: input.purpose,
    marketClass: input.marketClass,
    readinessClass: "external_ready",
    executionMode: "web_client",
    topology: input.topology,
    observedAt: NOW.toISOString(),
    expiresAt: EXPIRES,
    evidence: input.evidence ?? {
      credentialStatus: "valid",
      marketContextId: "market_context_wp6_12345678",
      topology: input.topology,
    },
    checks: input.checkIds.map((checkId) =>
      check(checkId, input.overrides?.[checkId]),
    ),
  };
}

await test("Polymarket purpose matrix is complete for every market class", () => {
  for (const purpose of [
    "fund",
    "buy",
    "sell",
    "redeem",
    "withdraw",
  ] as const) {
    for (const marketClass of ["standard", "neg_risk"] as const) {
      assert.ok(
        POLYMARKET_PREPARATION_REQUIREMENTS[purpose][marketClass].length > 0,
      );
    }
  }
});

await test("backend Deposit Wallet derivation matches the current relayer SDK", () => {
  assert.equal(
    derivePolymarketUupsDepositWallet({
      owner: "0x0000000000000000000000000000000000000001",
    }),
    "0x57ffBc34De23124fAeb8387fcd689d314E57aCcD",
  );
  assert.equal(
    derivePolymarketBeaconDepositWallet({
      owner: "0x0000000000000000000000000000000000000001",
      beacon: "0x0000000000000000000000000000000000000002",
    }),
    "0x431B416cdf155D0F975ee479793348e1137A6fF4",
  );
});

await test("Polymarket accepts supported signer, 1/1 Safe, Magic, and Deposit Wallet rows", async () => {
  for (const topology of [
    "signer_eoa",
    "safe_1_of_1",
    "magic_proxy",
    "deposit_wallet",
  ]) {
    for (const purpose of [
      "fund",
      "buy",
      "sell",
      "redeem",
      "withdraw",
    ] as const) {
      const exactBinding = binding("polymarket");
      const input = preparationInput(exactBinding, purpose, "standard");
      const adapter = new PolymarketWalletPreparationAdapter(
        async () =>
          facts({
            exactBinding,
            purpose,
            marketClass: "standard",
            topology,
            checkIds: polymarketCheckIds,
          }),
        () => NOW,
      );
      const result = await adapter.inspect(input);
      assert.equal(result.status, "ready", `${topology}:${purpose}`);
      assert.equal(result.topology, topology);
      assert.equal(result.purpose, purpose);
      assert.equal(result.marketClass, "standard");
      assert.ok(result.evidence.checks.length > 0);
    }
  }
});

await test("Polymarket fails closed for unsupported Safe threshold and RPC uncertainty", async () => {
  const cases: ReadonlyArray<{
    checkId: string;
    reasonCode: FundingReasonCode;
    topology: string;
  }> = [
    {
      checkId: "topology_supported",
      reasonCode: "unsupported_safe_threshold",
      topology: "safe_2_of_3",
    },
    {
      checkId: "rpc_fresh",
      reasonCode: "rpc_unavailable",
      topology: "signer_eoa",
    },
  ];
  for (const row of cases) {
    const exactBinding = binding("polymarket");
    const input = preparationInput(exactBinding, "buy", "standard");
    const adapter = new PolymarketWalletPreparationAdapter(
      async () =>
        facts({
          exactBinding,
          purpose: "buy",
          marketClass: "standard",
          topology: row.topology,
          checkIds: polymarketCheckIds,
          overrides: {
            [row.checkId]: {
              status: "unsupported",
              reasonCode: row.reasonCode,
              postcondition: null,
            },
          },
        }),
      () => NOW,
    );
    const result = await adapter.inspect(input);
    assert.equal(result.status, "unavailable");
    assert.ok(result.reasonCodes.includes(row.reasonCode));
  }
});

await test("Polymarket distinguishes deployable Deposit Wallet from undeployed unsupported funders", async () => {
  const exactBinding = binding("polymarket");
  const input = preparationInput(exactBinding, "fund", "standard");
  const deployAction = action(exactBinding, "deploy-deposit-wallet");
  const deployable = new PolymarketWalletPreparationAdapter(
    async () =>
      facts({
        exactBinding,
        purpose: "fund",
        marketClass: "standard",
        topology: "deposit_wallet",
        checkIds: polymarketCheckIds,
        overrides: {
          wallet_deployed: {
            status: "action_required",
            reasonCode: "wallet_not_deployed",
            actions: [deployAction],
          },
        },
      }),
    () => NOW,
  );
  const inspected = await deployable.inspect(input);
  assert.equal(inspected.status, "setup_required");
  assert.deepEqual(inspected.requiredActions, [actionSummary]);
  const prepared = await deployable.prepare({
    ...input,
    operationId: "operation_wp6_deploy_12345678",
    expectedInspectionRevision: inspected.inspectionRevision,
  });
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]?.kind, "evm_transaction");
  assert.match(prepared[0]?.actionId ?? "", /^action_[a-f0-9]{32}$/);

  const unsupported = new PolymarketWalletPreparationAdapter(
    async () =>
      facts({
        exactBinding,
        purpose: "fund",
        marketClass: "standard",
        topology: "safe_1_of_1",
        checkIds: polymarketCheckIds,
        overrides: {
          wallet_deployed: {
            status: "unavailable",
            reasonCode: "wallet_not_deployed",
            postcondition: null,
          },
        },
      }),
    () => NOW,
  );
  assert.equal((await unsupported.inspect(input)).status, "unavailable");
});

await test("Polymarket stale credentials require the exact reconnect action", async () => {
  const exactBinding = binding("polymarket");
  const input = preparationInput(exactBinding, "buy", "neg_risk");
  const reconnectAction = action(
    exactBinding,
    "refresh-polymarket-credentials",
  );
  const adapter = new PolymarketWalletPreparationAdapter(
    async () =>
      facts({
        exactBinding,
        purpose: "buy",
        marketClass: "neg_risk",
        topology: "signer_eoa",
        checkIds: polymarketCheckIds,
        overrides: {
          credentials_valid: {
            status: "user_action_required",
            reasonCode: "credentials_stale",
            actions: [reconnectAction],
          },
        },
      }),
    () => NOW,
  );
  const result = await adapter.inspect(input);
  assert.equal(result.status, "user_action_required");
  assert.deepEqual(result.reasonCodes, ["credentials_stale"]);
  assert.equal(result.requiredActions.length, 1);
});

await test("normal and neg-risk Polymarket approvals are not interchangeable", async () => {
  const exactBinding = binding("polymarket");
  for (const row of [
    {
      marketClass: "standard",
      purpose: "buy",
      required: "erc20_exchange_allowance",
      foreign: "erc20_neg_risk_exchange_allowance",
    },
    {
      marketClass: "neg_risk",
      purpose: "buy",
      required: "erc20_neg_risk_exchange_allowance",
      foreign: "erc20_exchange_allowance",
    },
    {
      marketClass: "standard",
      purpose: "sell",
      required: "ctf_exchange_approval",
      foreign: "ctf_neg_risk_exchange_approval",
    },
    {
      marketClass: "neg_risk",
      purpose: "sell",
      required: "ctf_neg_risk_exchange_approval",
      foreign: "ctf_exchange_approval",
    },
  ] as const) {
    const input = preparationInput(exactBinding, row.purpose, row.marketClass);
    const adapter = new PolymarketWalletPreparationAdapter(
      async () =>
        facts({
          exactBinding,
          purpose: row.purpose,
          marketClass: row.marketClass,
          topology: "signer_eoa",
          checkIds: polymarketCheckIds.filter(
            (checkId) => checkId !== row.required,
          ),
          overrides: {
            [row.foreign]: { status: "satisfied" },
          },
        }),
      () => NOW,
    );
    const result = await adapter.inspect(input);
    assert.equal(result.status, "unavailable");
    assert.equal(
      result.evidence.checks.find((entry) => entry.checkId === row.required)
        ?.status,
      "unavailable",
    );
  }
});

await test("Limitless CLOB and AMM use separate exact readiness rows", async () => {
  const exactBinding = binding("limitless");
  for (const row of [
    {
      marketClass: "clob",
      purpose: "buy",
      expected: "clob_usdc_allowance",
      forbidden: "amm_usdc_allowance",
    },
    {
      marketClass: "amm",
      purpose: "buy",
      expected: "amm_usdc_allowance",
      forbidden: "clob_usdc_allowance",
    },
    {
      marketClass: "clob_neg_risk",
      purpose: "sell",
      expected: "clob_neg_risk_operator_approval",
      forbidden: "amm_operator_approval",
    },
    {
      marketClass: "amm_neg_risk",
      purpose: "sell",
      expected: "amm_operator_approval",
      forbidden: "clob_neg_risk_operator_approval",
    },
  ] as const) {
    const input = preparationInput(exactBinding, row.purpose, row.marketClass);
    const adapter = new LimitlessWalletPreparationAdapter(
      async () =>
        facts({
          exactBinding,
          purpose: row.purpose,
          marketClass: row.marketClass,
          topology: "external_eoa",
          checkIds: limitlessCheckIds,
        }),
      () => NOW,
    );
    const result = await adapter.inspect(input);
    assert.equal(result.status, "ready");
    const ids = result.evidence.checks.map((entry) => entry.checkId);
    assert.ok(ids.includes(row.expected));
    assert.ok(!ids.includes(row.forbidden));
  }
});

await test("Limitless profile, market, locks, quote, and upstream uncertainty fail closed", async () => {
  const rows: ReadonlyArray<{
    checkId: string;
    reasonCode: FundingReasonCode;
    status: PreparationFactCheck["status"];
  }> = [
    {
      checkId: "partner_profile_valid",
      reasonCode: "venue_profile_foreign",
      status: "unavailable",
    },
    {
      checkId: "market_adapter_resolved",
      reasonCode: "market_evidence_unavailable",
      status: "unavailable",
    },
    {
      checkId: "cash_spendable",
      reasonCode: "locked_funds",
      status: "unavailable",
    },
    {
      checkId: "clob_quote_guard",
      reasonCode: "quote_slippage_exceeded",
      status: "unavailable",
    },
    {
      checkId: "rpc_fresh",
      reasonCode: "rpc_unavailable",
      status: "unavailable",
    },
  ];
  for (const row of rows) {
    const exactBinding = binding("limitless");
    const input = preparationInput(exactBinding, "buy", "clob");
    const adapter = new LimitlessWalletPreparationAdapter(
      async () =>
        facts({
          exactBinding,
          purpose: "buy",
          marketClass: "clob",
          topology: "embedded_eoa",
          checkIds: limitlessCheckIds,
          overrides: {
            [row.checkId]: {
              status: row.status,
              reasonCode: row.reasonCode,
              postcondition: null,
            },
          },
        }),
      () => NOW,
    );
    const result = await adapter.inspect(input);
    assert.equal(result.status, "unavailable");
    assert.ok(result.reasonCodes.includes(row.reasonCode));
  }
});

await test("prepare re-inspects and rejects a changed security revision", async () => {
  const exactBinding = binding("limitless");
  const input = preparationInput(exactBinding, "buy", "amm");
  let allowanceRaw = "0";
  const adapter = new LimitlessWalletPreparationAdapter(
    async () =>
      facts({
        exactBinding,
        purpose: "buy",
        marketClass: "amm",
        topology: "external_eoa",
        checkIds: limitlessCheckIds,
        evidence: { allowanceRaw },
        overrides: {
          amm_usdc_allowance: {
            status: "user_action_required",
            reasonCode: "operator_approval_required",
            actions: [action(exactBinding, "approve-amm-usdc")],
          },
        },
      }),
    () => NOW,
  );
  const inspected = await adapter.inspect(input);
  allowanceRaw = "1";
  await assert.rejects(
    () =>
      adapter.prepare({
        ...input,
        operationId: "operation_wp6_stale_12345678",
        expectedInspectionRevision: inspected.inspectionRevision,
      }),
    (error: unknown) =>
      error instanceof PreparationContractError &&
      error.code === "evidence_stale",
  );
});

await test("inspection revision ignores refresh timestamps but not security facts", async () => {
  const exactBinding = binding("limitless");
  const input = preparationInput(exactBinding, "buy", "amm");
  let observedAt = "2026-07-24T11:59:30.000Z";
  let expiresAt = "2026-07-24T12:04:30.000Z";
  const adapter = new LimitlessWalletPreparationAdapter(
    async () => ({
      ...facts({
        exactBinding,
        purpose: "buy",
        marketClass: "amm",
        topology: "external_eoa",
        checkIds: limitlessCheckIds,
      }),
      observedAt,
      expiresAt,
    }),
    () => NOW,
  );
  const first = await adapter.inspect(input);
  observedAt = "2026-07-24T12:00:00.000Z";
  expiresAt = "2026-07-24T12:05:00.000Z";
  const second = await adapter.inspect(input);
  assert.equal(first.inspectionRevision, second.inspectionRevision);
  assert.deepEqual(
    await adapter.prepare({
      ...input,
      operationId: "operation_wp6_timestamp_12345678",
      expectedInspectionRevision: first.inspectionRevision,
    }),
    [],
  );
});

await test("inspect is side-effect free and prepare only materializes actions", async () => {
  const exactBinding = binding("limitless");
  const input = preparationInput(exactBinding, "buy", "amm");
  let inspections = 0;
  let executions = 0;
  const adapter = new LimitlessWalletPreparationAdapter(
    async () => {
      inspections += 1;
      return facts({
        exactBinding,
        purpose: "buy",
        marketClass: "amm",
        topology: "external_eoa",
        checkIds: limitlessCheckIds,
        overrides: {
          amm_usdc_allowance: {
            status: "user_action_required",
            reasonCode: "operator_approval_required",
            actions: [action(exactBinding, "approve-amm-usdc")],
          },
        },
      });
    },
    () => NOW,
  );
  const inspected = await adapter.inspect(input);
  assert.equal(inspections, 1);
  assert.equal(executions, 0);
  const prepared = await adapter.prepare({
    ...input,
    operationId: "operation_wp6_materialize_12345678",
    expectedInspectionRevision: inspected.inspectionRevision,
  });
  assert.equal(inspections, 2);
  assert.equal(executions, 0);
  assert.equal(prepared.length, 1);
  executions += 1;
  assert.equal(executions, 1);
});

await test("secret-shaped evidence is rejected before crossing the contract", async () => {
  const exactBinding = binding("polymarket");
  const input = preparationInput(exactBinding, "buy", "standard");
  const adapter = new PolymarketWalletPreparationAdapter(
    async () =>
      facts({
        exactBinding,
        purpose: "buy",
        marketClass: "standard",
        topology: "signer_eoa",
        checkIds: polymarketCheckIds,
        evidence: { apiSecret: "must-never-escape" },
      }),
    () => NOW,
  );
  await assert.rejects(
    () => adapter.inspect(input),
    (error: unknown) =>
      error instanceof PreparationContractError &&
      error.code === "evidence_invalid",
  );
});

await test("expired evidence is unavailable and cannot be prepared", async () => {
  const exactBinding = binding("limitless");
  const input = preparationInput(exactBinding, "buy", "clob");
  const expiredClock = () => new Date("2026-07-24T12:06:00.000Z");
  const adapter = new LimitlessWalletPreparationAdapter(
    async () => ({
      ...facts({
        exactBinding,
        purpose: "buy",
        marketClass: "clob",
        topology: "external_eoa",
        checkIds: limitlessCheckIds,
      }),
      expiresAt: EXPIRES,
    }),
    expiredClock,
  );
  const result = await adapter.inspect(input);
  assert.equal(result.status, "unavailable");
  assert.ok(result.reasonCodes.includes("preparation_evidence_stale"));
  await assert.rejects(
    () =>
      adapter.prepare({
        ...input,
        operationId: "operation_wp6_expired_12345678",
        expectedInspectionRevision: result.inspectionRevision,
      }),
    (error: unknown) =>
      error instanceof PreparationContractError &&
      (error.code === "evidence_expired" ||
        error.code === "preparation_unavailable"),
  );
});

await test("position actions stay bound to the stored owner and revalidate before prepare", async () => {
  const ownerBinding = binding("polymarket");
  const inspectionInput = {
    accountId: ownerBinding.settlementLocation.accountId,
    action: "redeem" as const,
    venueId: "polymarket",
    positionRef: "position_wp6_owner_12345678",
    ownerBindingId: ownerBinding.bindingId,
  };
  let balanceRaw = "1000000";
  const executor = new OwnerBoundPositionActionExecutor(
    "polymarket-position-action-v1",
    ["position_owner", "canonical_plan", "redeemable_balance"],
    async () => ({
      action: "redeem",
      venueId: "polymarket",
      positionRef: inspectionInput.positionRef,
      ownerBinding,
      observedAt: NOW.toISOString(),
      expiresAt: EXPIRES,
      evidence: { balanceRaw, planDigest: "plan_wp6_12345678" },
      checks: [
        check("position_owner"),
        check("canonical_plan", {
          status: "user_action_required",
          reasonCode: "operator_approval_required",
          actions: [action(ownerBinding, "redeem-position")],
        }),
        check("redeemable_balance"),
      ],
    }),
    async (input) => ({
      status: "completed",
      submissionFingerprint: input.submissionFingerprint,
      reasonCodes: [],
    }),
    () => NOW,
  );
  const inspected = await executor.inspect(inspectionInput);
  assert.equal(inspected.ready, false);
  assert.equal(inspected.ownerBindingId, ownerBinding.bindingId);
  balanceRaw = "900000";
  await assert.rejects(
    () =>
      executor.prepare({
        ...inspectionInput,
        actionOperationId: "position_action_wp6_12345678",
        expectedInspectionRevision: inspected.inspectionRevision,
      }),
    (error: unknown) =>
      error instanceof PreparationContractError &&
      error.code === "evidence_stale",
  );

  const wrongOwner = {
    ...inspectionInput,
    ownerBindingId: "binding_foreign_owner_12345678",
  };
  await assert.rejects(
    () => executor.inspect(wrongOwner),
    (error: unknown) =>
      error instanceof PreparationContractError &&
      error.code === "binding_mismatch",
  );
});

await test("position reconciliation returns the original submission fingerprint", async () => {
  const ownerBinding = binding("limitless");
  const executor = new OwnerBoundPositionActionExecutor(
    "limitless-position-action-v1",
    ["position_owner"],
    async (input) => ({
      action: input.action,
      venueId: input.venueId,
      positionRef: input.positionRef,
      ownerBinding,
      observedAt: NOW.toISOString(),
      expiresAt: EXPIRES,
      evidence: {},
      checks: [check("position_owner")],
    }),
    async (input) => ({
      status: "completed",
      submissionFingerprint: input.submissionFingerprint,
      reasonCodes: [],
    }),
    () => NOW,
  );
  const result = await executor.reconcile({
    actionOperationId: "position_action_wp6_reconcile_12345678",
    submissionFingerprint: "tx_fingerprint_wp6_12345678",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.submissionFingerprint, "tx_fingerprint_wp6_12345678");
});
