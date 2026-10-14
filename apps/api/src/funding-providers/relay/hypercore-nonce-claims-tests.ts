import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PoolClient } from "@hunch/infra";
import { hypercorePlanTestFixture } from "./hypercore-plan-test-fixture.js";
import { buildRelayPlanningQuote } from "./operation-plan.js";
import {
  claimHyperliquidFundingNonceInTransaction,
  HyperliquidNonceConflictError,
} from "../../funding/execution/hyperliquid-nonce-claims.js";
import { canonicalJsonHash } from "../../funding/persistence/canonical.js";

async function fixture() {
  const input = hypercorePlanTestFixture().input;
  const plan = (await buildRelayPlanningQuote(input)).commitPlan;
  const ids = [randomUUID(), randomUUID()];
  const operationId = randomUUID(),
    segmentId = randomUUID();
  const rows = plan.steps.map((step) => ({
    id: ids[step.ordinal],
    operation_id: operationId,
    segment_id: segmentId,
    depends_on_step_id: step.ordinal ? ids[0] : null,
    step_kind: step.stepKind,
    executor_id: step.executorId,
    action_fingerprint: step.actionFingerprint,
    normalized_action: { ...structuredClone(step.normalizedAction) },
    action_validation_result: {
      ...structuredClone(step.actionValidationResult),
    },
  }));
  const auth = rows[0],
    send = rows[1];
  assert.ok(auth && send && send.id);
  return { auth, send, rows, sendId: send.id };
}

function database(
  rows: unknown[],
  mode: "insert" | "replay" | "conflict" = "insert",
) {
  const writes: unknown[][] = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("from funding_operation_steps native_step"))
        return { rows };
      if (sql.includes("insert into hyperliquid_nonce_claims")) {
        writes.push(params);
        return { rowCount: mode === "insert" ? 1 : 0 };
      }
      if (sql.includes("from hyperliquid_nonce_claims where funding_step_id"))
        return { rows: mode === "replay" ? [{ matches: true }] : [] };
      throw new Error("unexpected query");
    },
  } as unknown as Pick<PoolClient, "query">;
  return { client, writes };
}

test("nonce claim persists native signer/nonce once; exact own replay is allowed", async () => {
  for (const mode of ["insert", "replay"] as const) {
    const value = await fixture();
    const db = database(value.rows, mode);
    await claimHyperliquidFundingNonceInTransaction(db.client, value.sendId);
    assert.equal(db.writes.length, 1);
    assert.equal(db.writes[0]?.[0], "mainnet");
    assert.equal(
      db.writes[0]?.[1],
      String(value.send.action_validation_result.signerAddress).toLowerCase(),
    );
    assert.equal(db.writes[0]?.[3], value.send.action_fingerprint);
    assert.equal(db.writes[0]?.[4], value.sendId);
  }
});
test("nonce ownership conflict is typed and never overwrites a claim", async () => {
  const value = await fixture(),
    db = database(value.rows, "conflict");
  await assert.rejects(
    claimHyperliquidFundingNonceInTransaction(db.client, value.sendId),
    HyperliquidNonceConflictError,
  );
  assert.equal(db.writes.length, 1);
});

type Value = Awaited<ReturnType<typeof fixture>>;
for (const [label, change] of [
  ["missing authorization", (v: Value) => v.rows.splice(0, 1)],
  [
    "foreign operation",
    (v: Value) => {
      v.auth.operation_id = randomUUID();
    },
  ],
  [
    "foreign segment",
    (v: Value) => {
      v.auth.segment_id = randomUUID();
    },
  ],
  [
    "wrong step kind",
    (v: Value) => {
      v.auth.step_kind = "transaction";
    },
  ],
  [
    "wrong executor",
    (v: Value) => {
      v.send.executor_id = "wallet_profile_evm_v1";
    },
  ],
  [
    "wrong environment",
    (v: Value) => {
      v.send.action_validation_result.nativeEnvironment = "testnet";
    },
  ],
  [
    "wrong stage",
    (v: Value) => {
      v.send.action_validation_result.nativeStage = "nonce_mapping";
    },
  ],
  [
    "money flag",
    (v: Value) => {
      v.auth.action_validation_result.valueMoving = true;
    },
  ],
  [
    "owner",
    (v: Value) => {
      v.send.action_validation_result.signerAddress = `0x${"a".repeat(40)}`;
    },
  ],
  [
    "nonce",
    (v: Value) => {
      v.send.action_validation_result.nativeNonce = 1;
    },
  ],
  [
    "pair digest",
    (v: Value) => {
      v.auth.action_validation_result.nativePairFingerprint = "a".repeat(64);
    },
  ],
  [
    "action digest",
    (v: Value) => {
      v.send.action_fingerprint = "a".repeat(64);
    },
  ],
  [
    "actor mismatch with coherent hash",
    (v: Value) => {
      v.send.normalized_action.actorWalletId = randomUUID();
      v.send.action_fingerprint = canonicalJsonHash(v.send.normalized_action);
    },
  ],
  [
    "network mismatch with coherent hash",
    (v: Value) => {
      v.send.normalized_action.networkId = "evm:999";
      v.send.action_fingerprint = canonicalJsonHash(v.send.normalized_action);
    },
  ],
] as const) {
  test(`nonce claim rejects ${label} before writing`, async () => {
    const value = await fixture();
    change(value);
    const db = database(value.rows);
    await assert.rejects(
      claimHyperliquidFundingNonceInTransaction(db.client, value.sendId),
    );
    assert.equal(db.writes.length, 0);
  });
}
