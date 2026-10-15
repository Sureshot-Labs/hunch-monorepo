import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";
import {
  BASE_USDC,
  POLYGON_USDC,
  RELAY_DEPOSITORY_V2,
} from "../../../funding-providers/relay/rehearsal.js";
import { EXACT_REFUND_RECEIPTS_CONTRACT } from "../../domain/refund-settlement.js";
import type { NormalizedAction } from "../../domain/types.js";
import { withRelayClientSourceDebitPostcondition } from "../../execution/relay-client-source-debit.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import type { RefundSourceCandidateRow } from "../../reconciliation/relay-refund-source-candidates.js";
import {
  classifyRefundSourceActions as classifyComplete,
  loadRefundSourceActionFacts,
  REFUND_SOURCE_ACTION_FACTS_SQL,
  type RefundSourceActionRow,
} from "../../reconciliation/relay-refund-source-actions.js";

const classifyRefundSourceActions = (
  candidate: RefundSourceCandidateRow,
  rows: readonly RefundSourceActionRow[],
) => classifyComplete(candidate, rows, { complete: true });

const owner = `0x${"ab".repeat(20)}`;
const orderId = `0x${"c".repeat(64)}`;
const abi = new Interface([
  "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
  "function approve(address spender,uint256 amount)",
]);

function fixture(polygon = false) {
  const asset = {
    networkId: polygon ? "evm:137" : "evm:8453",
    assetId: polygon ? POLYGON_USDC : BASE_USDC,
    decimals: 6,
  };
  const userId = "11111111-1111-4111-8111-111111111111";
  const location = {
    kind: "wallet",
    accountId: userId,
    locationId: "source-location",
    asset,
    details: { address: owner },
  };
  const candidate: RefundSourceCandidateRow = {
    operation_id: "22222222-2222-4222-8222-222222222222",
    segment_id: "33333333-3333-4333-8333-333333333333",
    reservation_id: "44444444-4444-4444-8444-444444444444",
    reservation_created_at: "2026-10-14T00:00:00.123456Z",
    user_id: userId,
    operation_user_id: userId,
    location_id: location.locationId,
    network_id: asset.networkId,
    asset_id: asset.assetId,
    asset_decimals: 6,
    raw_amount: "10000000",
    mode: "subtract_available",
    provider_id: "relay",
    source_snapshot: { kind: "owned_location", location },
    quoted_input: { asset, raw: "10000000" },
    refund_location_snapshot: {
      ...location,
      refundEvidenceContract: EXACT_REFUND_RECEIPTS_CONTRACT,
      relayProtocolOrderId: orderId,
    },
    provider_quote_ref_lookup_hmac: "d".repeat(64),
    lookup_key_version: 1,
  };
  const deposit: NormalizedAction = {
    actionId: "offline-fixture:deposit",
    networkId: asset.networkId,
    kind: "evm_transaction",
    senderWalletId: "offline-controller",
    to: RELAY_DEPOSITORY_V2,
    data: abi.encodeFunctionData("depositErc20", [
      owner,
      asset.assetId,
      10000000n,
      orderId,
    ]),
    valueRaw: "0",
    gasLimitRaw: null,
  };
  const approval: NormalizedAction = {
    ...deposit,
    actionId: "offline-fixture:approve",
    to: asset.assetId,
    data: abi.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, 10000000n]),
  };
  const row = (
    action: NormalizedAction,
    stepKind: "approve" | "deposit",
  ): RefundSourceActionRow => ({
    operation_id: candidate.operation_id,
    segment_id:
      candidate.segment_id ?? assert.fail("Fixture route leg missing"),
    step_id: `${stepKind}-step`,
    step_ordinal: stepKind === "approve" ? 0 : 1,
    step_kind: "transaction",
    executor_id: "wallet_profile_evm_v1",
    action_fingerprint: canonicalJsonHash(action),
    normalized_action: action,
    action_validation_result: withRelayClientSourceDebitPostcondition({
      action,
      routeId: polygon
        ? "polygon-usdc-to-hypercore-spot-usdc"
        : "base-usdc-to-hypercore-spot-usdc",
      sourceAmount: { asset, raw: "10000000" },
      actionValidationResult: {
        signerAddress: owner,
        relayStepKind: stepKind,
        relayProtocolOrderId: orderId,
      },
    }),
    attempt_id: null,
    attempt_number: 0,
    synthetic_cancellation: false,
    unreferenced_attempt: true,
    attempt_costs: {},
    attempt_fingerprint: null,
    attempt_executor_id: null,
    attempt_outcome: null,
    broadcast_may_have_occurred: null,
    receipt_status: null,
    receipt_canonical: null,
    receipt_action_match: null,
    receipt_evidence: null,
  });
  return { candidate, deposit, approval, row };
}
function attempted(
  row: RefundSourceActionRow,
  patch: Partial<RefundSourceActionRow> = {},
): RefundSourceActionRow {
  return {
    ...row,
    attempt_id: "offline-attempt",
    attempt_number: 1,
    attempt_fingerprint: row.action_fingerprint,
    attempt_executor_id: row.executor_id,
    attempt_outcome: "started",
    broadcast_may_have_occurred: false,
    ...patch,
  };
}

for (const polygon of [false, true]) {
  test(`${polygon ? "Polygon" : "Base"} exact approval is not a source debit; unstarted deposit is not an external verdict`, () => {
    const f = fixture(polygon);
    const approval = attempted(f.row(f.approval, "approve"), {
      attempt_outcome: "succeeded",
      broadcast_may_have_occurred: true,
      receipt_status: "finalized",
      receipt_canonical: true,
      receipt_action_match: true,
    });
    assert.deepEqual(
      classifyRefundSourceActions(f.candidate, [
        approval,
        f.row(f.deposit, "deposit"),
      ]),
      { kind: "no_live_attempt" },
    );
    assert.deepEqual(classifyRefundSourceActions(f.candidate, [approval]), {
      kind: "invalid",
    });
    assert.deepEqual(classifyRefundSourceActions(f.candidate, []), {
      kind: "invalid",
    });
  });
  test(`${polygon ? "Polygon" : "Base"} all issued attempts count, regardless of cached state or latest failure`, () => {
    const f = fixture(polygon);
    const row = f.row(f.deposit, "deposit");
    for (const outcome of [
      "started",
      "submitted",
      "succeeded",
      "failed",
      "ambiguous",
      "cancelled",
    ]) {
      assert.deepEqual(
        classifyRefundSourceActions(f.candidate, [
          attempted(row, { attempt_outcome: outcome }),
        ]),
        { kind: "possible", stepIds: [row.step_id] },
      );
    }
    const failure = attempted(row, {
      receipt_status: "failed",
      receipt_canonical: true,
      receipt_action_match: true,
      receipt_evidence: { failureFinalized: true },
    });
    assert.deepEqual(classifyRefundSourceActions(f.candidate, [failure]), {
      kind: "no_live_attempt",
    });
    assert.deepEqual(
      classifyRefundSourceActions(f.candidate, [
        attempted(row),
        { ...failure, attempt_id: "later-attempt" },
      ]),
      { kind: "possible", stepIds: [row.step_id] },
    );
    for (const patch of [
      { receipt_canonical: false },
      { receipt_action_match: false },
      { receipt_evidence: {} },
      { receipt_status: "finalized" },
    ]) {
      assert.equal(
        classifyRefundSourceActions(f.candidate, [{ ...failure, ...patch }])
          .kind,
        "possible",
      );
    }
  });
  test(`${polygon ? "Polygon" : "Base"} atomic approval+deposit remains money-moving`, () => {
    const f = fixture(polygon);
    const batch: NormalizedAction = {
      kind: "evm_transaction_batch",
      actionId: "offline-fixture:batch",
      networkId: f.deposit.networkId,
      senderWalletId: "offline-controller",
      calls: [f.approval, f.deposit].map(
        ({ actionId, to, data, valueRaw }) => ({
          actionId,
          to,
          data,
          valueRaw,
        }),
      ),
    };
    const row = attempted(f.row(batch, "deposit"));
    assert.equal(
      classifyRefundSourceActions(f.candidate, [row]).kind,
      "possible",
    );
    const reversed = { ...batch, calls: [...batch.calls].reverse() };
    assert.equal(
      classifyRefundSourceActions(f.candidate, [f.row(reversed, "deposit")])
        .kind,
      "invalid",
    );
  });
}

test("wrong owner/order/asset/calldata/fingerprint/attempt cannot establish absence", () => {
  const f = fixture();
  const row = attempted(f.row(f.deposit, "deposit"));
  const validation = row.action_validation_result as Record<string, unknown>;
  for (const patch of [
    { operation_id: "foreign" },
    { segment_id: "foreign" },
    { executor_id: "relay_evm_v1" },
    { action_fingerprint: "bad" },
    { attempt_fingerprint: "bad" },
    { attempt_executor_id: "wrong" },
    {
      action_validation_result: {
        ...validation,
        signerAddress: `0x${"ef".repeat(20)}`,
      },
    },
    {
      action_validation_result: { ...validation, expectedSourceRaw: "9999999" },
    },
    {
      action_validation_result: {
        ...validation,
        relayProtocolOrderId: `0x${"e".repeat(64)}`,
      },
    },
    {
      action_validation_result: {
        ...validation,
        relayNativeDestination: "hyperliquid:testnet",
      },
    },
  ])
    assert.equal(
      classifyRefundSourceActions(f.candidate, [{ ...row, ...patch }]).kind,
      "invalid",
    );
  for (const patch of [
    { valueRaw: "1" },
    { to: BASE_USDC },
    {
      data: abi.encodeFunctionData("depositErc20", [
        owner,
        BASE_USDC,
        9999999n,
        orderId,
      ]),
    },
    {
      data: abi.encodeFunctionData("depositErc20", [
        owner,
        BASE_USDC,
        10000000n,
        `0x${"e".repeat(64)}`,
      ]),
    },
  ]) {
    assert.equal(
      classifyRefundSourceActions(f.candidate, [
        f.row({ ...f.deposit, ...patch }, "deposit"),
      ]).kind,
      "invalid",
    );
  }
  assert.equal(
    classifyRefundSourceActions(
      { ...f.candidate, operation_user_id: "foreign" },
      [row],
    ).kind,
    "invalid",
  );
  assert.equal(
    classifyRefundSourceActions(f.candidate, [
      row,
      { ...row, step_id: "second-deposit" },
    ]).kind,
    "invalid",
  );
});

test("approval classification requires exact source, amount and spender", () => {
  const f = fixture();
  for (const patch of [
    { valueRaw: "1" },
    { data: abi.encodeFunctionData("approve", [owner, 10000000n]) },
    {
      data: abi.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, 10000001n]),
    },
  ]) {
    assert.equal(
      classifyRefundSourceActions(f.candidate, [
        f.row({ ...f.approval, ...patch }, "approve"),
        f.row(f.deposit, "deposit"),
      ]).kind,
      "invalid",
    );
  }
});

test("page limit and cursor keep all attempt states with an explicit sentinel", async () => {
  const f = fixture();
  const first = attempted(f.row(f.deposit, "deposit"));
  const second = { ...first, attempt_id: "later", attempt_number: 2 };
  let calls = 0;
  const db = {
    query: async (sql: string, args: unknown[]) => {
      calls++;
      assert.equal(sql, REFUND_SOURCE_ACTION_FACTS_SQL);
      assert.deepEqual(args, [
        f.candidate.operation_id,
        f.candidate.segment_id,
        2,
        calls === 1 ? -1 : 1,
        calls === 1 ? 0 : 1,
      ]);
      return { rows: calls === 1 ? [first, second] : [second] };
    },
  };
  const page = await loadRefundSourceActionFacts(db as never, {
    candidate: f.candidate,
    cursor: null,
    limit: 1,
  });
  assert.deepEqual(page, {
    rows: [first],
    nextCursor: { stepOrdinal: 1, attemptNumber: 1 },
  });
  assert.deepEqual(
    classifyComplete(f.candidate, page.rows, { complete: false }),
    { kind: "incomplete" },
  );
  const tail = await loadRefundSourceActionFacts(db as never, {
    candidate: f.candidate,
    cursor: page.nextCursor,
    limit: 1,
  });
  assert.deepEqual(tail, { rows: [second], nextCursor: null });
  for (const limit of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    await assert.rejects(
      loadRefundSourceActionFacts(db as never, {
        candidate: f.candidate,
        cursor: null,
        limit,
      }),
    );
  await assert.rejects(
    loadRefundSourceActionFacts(db as never, {
      candidate: { ...f.candidate, segment_id: null },
      cursor: null,
      limit: 1,
    }),
  );
  await assert.rejects(
    loadRefundSourceActionFacts(db as never, {
      candidate: f.candidate,
      cursor: { stepOrdinal: -1, attemptNumber: 0 },
      limit: 1,
    }),
  );
  assert.equal(calls, 2);
});

test("server synthetic cancellation ignores only its own never-issued attempt", () => {
  const f = fixture();
  const row = attempted(f.row(f.deposit, "deposit"), {
    attempt_outcome: "cancelled",
    synthetic_cancellation: true,
  });
  assert.deepEqual(classifyRefundSourceActions(f.candidate, [row]), {
    kind: "no_live_attempt",
  });
  assert.equal(
    classifyRefundSourceActions(f.candidate, [
      row,
      attempted(f.row(f.deposit, "deposit"), { attempt_id: "earlier-issued" }),
    ]).kind,
    "possible",
  );
  assert.equal(
    classifyRefundSourceActions(f.candidate, [
      { ...row, receipt_status: "observed" },
    ]).kind,
    "possible",
  );
});

test("closed embedded lease proves no admission, unlike client cancellation or admitted send", () => {
  const f = fixture();
  const lease = {
    version: 1,
    phase: "closed",
    signer: owner,
    payer: "privy_sponsor",
    expiresAt: "2026-10-14T00:00:00Z",
  };
  const row = attempted(f.row(f.deposit, "deposit"), {
    attempt_outcome: "cancelled",
    attempt_costs: { embeddedSubmission: lease },
  });
  assert.deepEqual(classifyRefundSourceActions(f.candidate, [row]), {
    kind: "no_live_attempt",
  });
  for (const patch of [
    { phase: "prepared" },
    { phase: "admitted" },
    { requestFingerprint: "f".repeat(64) },
    { admittedAt: "2026-10-14T00:00:00Z" },
    { signer: `0x${"ee".repeat(20)}` },
  ]) {
    assert.equal(
      classifyRefundSourceActions(f.candidate, [
        {
          ...row,
          attempt_costs: { embeddedSubmission: { ...lease, ...patch } },
        },
      ]).kind,
      "possible",
    );
  }
  for (const patch of [
    { unreferenced_attempt: false },
    { broadcast_may_have_occurred: true },
    { receipt_status: "finalized" },
    { attempt_outcome: "submitted" },
  ]) {
    assert.equal(
      classifyRefundSourceActions(f.candidate, [{ ...row, ...patch }]).kind,
      "possible",
    );
  }
});
