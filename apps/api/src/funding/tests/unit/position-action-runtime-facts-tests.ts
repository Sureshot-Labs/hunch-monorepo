#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { Interface } from "ethers";

import type { VenueAccountBinding } from "../../domain/types.js";
import {
  buildRedemptionPositionFacts,
  REDEMPTION_POSITION_REQUIRED_CHECKS,
  type RedemptionRuntimeEvidence,
} from "../../position-actions/redemption-runtime-facts.js";
import { OwnerBoundPositionActionExecutor } from "../../preparation/position-action-executor.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const EXPIRES = "2026-07-24T12:01:00.000Z";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const POSITION_ID = "20000000-0000-4000-8000-000000000002";
const CTF = "0x0000000000000000000000000000000000000011";
const OWNER = "0x0000000000000000000000000000000000000022";
const TARGET = "0x0000000000000000000000000000000000000033";

function binding(venueId: "limitless" | "polymarket"): VenueAccountBinding {
  const networkId = venueId === "polymarket" ? "evm:137" : "evm:8453";
  return {
    bindingId: `binding_${venueId}_owner_12345678`,
    venueId,
    controllerWalletId: `wallet_${venueId}_owner_12345678`,
    executionWalletId: `wallet_${venueId}_owner_12345678`,
    accountRef: OWNER,
    settlementLocation: {
      kind: "venue_account",
      locationId: `location_${venueId}_owner_12345678`,
      accountId: USER_ID,
      asset: {
        networkId,
        assetId: "0x0000000000000000000000000000000000000044",
        decimals: 6,
      },
      details: { venueId, address: OWNER },
    },
    signingMode: "web_client",
  };
}

function evidence(
  venueId: "limitless" | "polymarket",
  overrides: Partial<RedemptionRuntimeEvidence> = {},
): RedemptionRuntimeEvidence {
  const ownerBinding = binding(venueId);
  const topology =
    overrides.topology ??
    (venueId === "polymarket" ? "signer" : "external_eoa");
  const topologySupported =
    overrides.topologySupported ??
    (venueId === "polymarket"
      ? ["signer", "deposit_wallet", "safe_1_1", "magic_proxy"].includes(
          topology,
        )
      : ["internal_eoa", "external_eoa"].includes(topology));
  const externalHandoff =
    overrides.externalHandoff ??
    (venueId === "polymarket" && topology !== "signer"
      ? {
          handoffKind: "polymarket_proxy_execute",
          payload: { topology, funder: OWNER },
        }
      : null);
  return {
    conditionalTokensAddress: CTF,
    expiresAt: EXPIRES,
    observedAt: NOW.toISOString(),
    operatorApproved: true,
    ownerBinding,
    ownerMatchesBinding: true,
    plan: {
      ok: true,
      venue: venueId,
      chainId: venueId === "polymarket" ? 137 : 8453,
      redeemable: true,
      reason: "ready",
      reasonMessage: null,
      targetAddress: TARGET,
      data: "0x1234",
      payoutTokenAddress: "0x0000000000000000000000000000000000000055",
      expectedPayoutRaw: "1000000",
      yesBalanceRaw: "1000000",
      noBalanceRaw: "0",
      conditionResolved: true,
      resolvedOutcome: "YES",
      resolvedOutcomePct: 10_000,
    },
    positionRef: POSITION_ID,
    topology,
    topologySupported,
    unsupportedTopologyReason:
      overrides.unsupportedTopologyReason ??
      (topology === "safe_unsupported"
        ? "unsupported_safe_threshold"
        : "unsupported_wallet_topology"),
    externalHandoff,
    venueId,
    walletInternal: false,
    ...overrides,
  };
}

async function prepare(evidenceInput: RedemptionRuntimeEvidence) {
  const facts = buildRedemptionPositionFacts(evidenceInput);
  const executor = new OwnerBoundPositionActionExecutor(
    "redemption-runtime-test-v1",
    REDEMPTION_POSITION_REQUIRED_CHECKS,
    async () => facts,
    async () => ({
      status: "reconcile_required",
      submissionFingerprint: null,
      reasonCodes: ["operation_reconcile_required"],
    }),
    () => NOW,
  );
  const input = {
    accountId: USER_ID,
    action: "redeem" as const,
    venueId: evidenceInput.venueId,
    positionRef: POSITION_ID,
    ownerBindingId: evidenceInput.ownerBinding.bindingId,
  };
  const inspected = await executor.inspect(input);
  const actions = await executor.prepare({
    ...input,
    actionOperationId: "position_action_runtime_test_12345678",
    expectedInspectionRevision: inspected.inspectionRevision,
  });
  return { actions, facts, inspected };
}

async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`[position-action-runtime-facts-tests] ok ${name}`);
}

await test("Limitless redemption materializes one exact owner transaction", async () => {
  const result = await prepare(evidence("limitless"));
  assert.equal(result.inspected.ready, false);
  assert.deepEqual(result.inspected.reasonCodes, ["position_action_required"]);
  assert.equal(result.actions.length, 1);
  const action = result.actions[0];
  assert.equal(action?.kind, "evm_transaction");
  if (action?.kind !== "evm_transaction") throw new Error("wrong action kind");
  assert.equal(action.senderWalletId, binding("limitless").executionWalletId);
  assert.equal(action.to, TARGET);
  assert.equal(action.data, "0x1234");
});

await test("Polymarket Safe keeps approval and redemption inside owner proxy", async () => {
  const approval = new Interface([
    "function setApprovalForAll(address operator,bool approved)",
  ]);
  const result = await prepare(
    evidence("polymarket", {
      topology: "safe_1_1",
      operatorApproved: false,
      plan: {
        ...evidence("polymarket").plan,
        operatorApprovalAddress: TARGET,
        targetAddress: "0x0000000000000000000000000000000000000066",
      },
    }),
  );
  assert.equal(result.actions.length, 2);
  for (const action of result.actions) {
    assert.equal(action.kind, "external_handoff");
    if (action.kind !== "external_handoff") continue;
    assert.equal(action.handoffKind, "polymarket_proxy_execute");
    assert.equal(action.actorWalletId, binding("polymarket").executionWalletId);
    assert.equal(action.payload.funder, OWNER);
  }
  const approvalAction = result.actions[0];
  if (approvalAction?.kind !== "external_handoff") {
    throw new Error("approval did not use owner proxy");
  }
  const calls = approvalAction.payload.calls;
  assert.ok(Array.isArray(calls));
  const first = calls[0] as { data?: string; target?: string };
  assert.equal(first.target, CTF);
  const decoded = approval.decodeFunctionData(
    "setApprovalForAll",
    first.data ?? "0x",
  );
  assert.equal(decoded[0], TARGET);
  assert.equal(decoded[1], true);
});

await test("unsupported topology and RPC uncertainty are fail-closed", async () => {
  const facts = buildRedemptionPositionFacts(
    evidence("polymarket", {
      topology: "safe_unsupported",
      plan: {
        ...evidence("polymarket").plan,
        redeemable: false,
        reason: "preflight_unavailable",
        reasonMessage: "RPC unavailable",
        targetAddress: null,
        data: null,
        conditionResolved: null,
      },
    }),
  );
  const byId = new Map(facts.checks.map((check) => [check.checkId, check]));
  assert.equal(byId.get("topology_supported")?.status, "unavailable");
  assert.equal(
    byId.get("topology_supported")?.reasonCode,
    "unsupported_safe_threshold",
  );
  assert.equal(byId.get("rpc_fresh")?.status, "unavailable");
  assert.equal(byId.get("canonical_redemption_plan")?.actions.length, 0);
});

console.log("[position-action-runtime-facts-tests] complete");
