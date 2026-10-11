// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ethers, Interface } from "ethers";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
  POLYMARKET_PROTOCOL_CONTRACTS as C,
} from "@hunch/shared";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { PositionActionRuntimeService } from "../../position-actions/runtime-service.js";
import {
  createEvmPositionActionReceiptObserver,
  type PositionActionVenueDriver,
} from "../../position-actions/venue-driver.js";
import {
  createOrReplayPositionAction,
  claimPositionActionSubmission,
  recordPositionActionSubmission,
  fetchPositionActionForUser,
  quarantinePreClaimPositionActionReference,
  type StoredPositionAction,
} from "../../position-actions/position-action-repository.js";
import { buildReadyRedemptionPlan } from "../../../services/redemption-plan.js";
import {
  POLYMARKET_V2_ROUTER_ABI as R,
  POLYMARKET_V2_POSITION_ABI as P,
  POLYMARKET_V2_MODULE_ABI as M,
} from "../../../services/polymarket-v2-redemption-plan.js";
import { polymarketV2RedemptionIdentity } from "../../position-actions/polymarket-v2-redemption-evidence.js";

const db = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=15000",
});
const userId = randomUUID();
const owner = "0x0000000000000000000000000000000000000017";
let hash = ethers.id(`v2-redemption-fixture:${userId}`);
const historicalHash = hash;
const originalReceipt = ethers.JsonRpcProvider.prototype.getTransactionReceipt;
const originalFetch = globalThis.fetch;
const ERC20 = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const event = (
  abi: Interface,
  address: string,
  name: string,
  values: unknown[],
) => ({ address, ...abi.encodeEventLog(name, values) });
const unused = (): never => {
  throw new Error("Unexpected preparation in receipt fixture");
};
const driver: PositionActionVenueDriver = {
  adapterId: "fixture-poly-v2",
  venueId: "polymarket",
  buildMarketContext: unused,
  buildPlan: async () => unused(),
  inspectOperatorApproval: async () => unused(),
  resolveExecutionProfile: unused,
  conditionalTokensAddress: () => C.conditionalTokens,
  observeReceipt: createEvmPositionActionReceiptObserver(137),
  refreshPositions: async () => {}, // The fresh balance includes a separate later fill.
};
const runtime = new PositionActionRuntimeService(
  db,
  () => new Date(),
  [driver],
  null,
);
const operations: StoredPositionAction[] = [];
try {
  await db.query(
    "insert into users(id,email,is_active,is_verified) values($1,$2,true,true)",
    [userId, `poly-v2-redemption-${userId}@example.com`],
  );
  for (const base of [1n, 2n]) {
    const condition = (1n << 248n) | (base << 120n);
    const protocol = resolvePolymarketMarketAssets({
      version: "v2",
      conditionId: ethers.toBeHex(condition, 32),
      positionIds: [condition.toString(), (condition | 1n).toString()],
      outcomes: ["Yes", "No"],
      negRisk: false,
    });
    const asset = buildPolymarketAssetContext(
      "polymarket:redemption-runtime-fixture",
      protocol,
      protocol.assets[base === 1n ? 0 : 1],
    );
    const amount = 1_000_000n;
    const plan = buildReadyRedemptionPlan({
      venue: "polymarket",
      chainId: 137,
      targetAddress: C.router,
      data: R.encodeFunctionData("redeem", [
        asset.conditionId.slice(0, -2),
        asset.outcomeIndex,
        amount,
      ]),
      executionKind: "protocol_router",
      assetContext: asset,
      positionContract: C.positionManager,
      moduleAddress: C.binaryModule,
      redeemAmountRaw: amount.toString(),
      payoutTokenAddress: C.collateral,
      expectedPayoutRaw: base === 1n ? amount.toString() : "0",
      yesBalanceRaw: base === 1n ? amount.toString() : "0",
      noBalanceRaw: base === 2n ? amount.toString() : "0",
      conditionResolved: true,
    });
    const position = (
      await db.query<{ id: string }>(
        `insert into positions(user_id,venue,token_id,wallet_address,side,size,position_contract,asset_context)
      values($1,'polymarket',$2,$3,'LONG',1,$4,$5::jsonb) returning id`,
        [
          userId,
          asset.assetId,
          owner,
          C.positionManager.toLowerCase(),
          JSON.stringify(asset),
        ],
      )
    ).rows[0];
    assert.ok(position);
    const created = await createOrReplayPositionAction(db, {
      userId,
      marketId: null,
      venueId: "polymarket",
      action: "redeem",
      positionRef: position.id,
      ownerBindingId: `v2-binding-${base}-12345678`,
      ownerAddress: owner,
      executionWalletId: "owned-v2-runtime-wallet",
      executionAddress: owner,
      executionMode: "privy_authorization",
      inspectionRevision: `inspection-v2-${base}-12345678`,
      actionDigest: ethers.id(`poly-v2-runtime-${base}`).slice(2),
      idempotencyKey: randomUUID(),
      status: "awaiting_user",
      planSnapshot: {
        tokenId: asset.assetId,
        positionContract: C.positionManager.toLowerCase(),
        assetContext: asset,
        outcome: asset.outcomeIndex === 0 ? "YES" : "NO",
        plan: JSON.parse(JSON.stringify(plan)),
      },
      evidenceSnapshot: {},
      normalizedActions: [],
      postconditions: [],
    });
    operations.push(created.operation);
    await claimPositionActionSubmission(db, {
      userId,
      operationId: created.operation.id,
      canonicalActionFingerprint: "b".repeat(64),
      executorId: "fixture-v2-runtime",
    });
    await recordPositionActionSubmission(db, {
      userId,
      operationId: created.operation.id,
      attemptNumber: 1,
      outcome: "submitted",
      submissionFingerprint: hash,
      errorCode: null,
    });
  }
  const claimedTimes = await db.query<{
    action_operation_id: string;
    started_at: Date;
  }>(
    "select action_operation_id, started_at from position_action_attempts where action_operation_id=any($1::uuid[]) order by action_operation_id",
    [operations.map((operation) => operation.id)],
  );
  let receiptLogs = operations.flatMap((operation) => {
    const identity = polymarketV2RedemptionIdentity(operation);
    assert.ok(identity);
    return [
      event(P, C.positionManager, "TransferSingle", [
        C.router,
        owner,
        C.binaryModule,
        identity.positionId,
        identity.amount,
      ]),
      event(P, C.positionManager, "TransferSingle", [
        C.binaryModule,
        C.binaryModule,
        ethers.ZeroAddress,
        identity.positionId,
        identity.amount,
      ]),
      event(M, C.binaryModule, "PositionRedeemed", [
        C.router,
        identity.positionId,
        owner,
        identity.amount,
        identity.payout,
      ]),
      event(R, C.router, "RouterPositionRedeemed", [
        owner,
        identity.positionId,
        identity.amount,
      ]),
    ];
  });
  receiptLogs.push(
    event(ERC20, C.collateral, "Transfer", [
      ethers.ZeroAddress,
      owner,
      1_000_000n,
    ]),
  );
  let receiptBlockNumber = 100;
  let receiptBlockHash = ethers.id("v2-initial-block");
  let finalizedHeight = 99;
  let canonicalBlockHash = receiptBlockHash;
  let receiptMissing = false;
  let failedFinalityRead = false;
  let receiptTimestamp = Math.floor(Date.now() / 1000) + 1;
  let automaticRecovery = false;
  let claimSeconds = receiptTimestamp;
  const historicalBlockHash = ethers.id("v2-historical-block");
  ethers.JsonRpcProvider.prototype.getTransactionReceipt = async () =>
    receiptMissing
      ? null
      : ({
          status: 1,
          blockNumber: receiptBlockNumber,
          blockHash: receiptBlockHash,
          hash,
          logs: receiptLogs,
        } as unknown as ethers.TransactionReceipt);
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (failedFinalityRead) throw new Error("Finality fixture unavailable");
    let result: unknown;
    if (body.method === "eth_getBlockByNumber") {
      const number =
        body.params[0] === "finalized"
          ? finalizedHeight
          : Number(BigInt(body.params[0]));
      result = {
        number: ethers.toBeHex(number),
        hash:
          automaticRecovery && number === 100
            ? historicalBlockHash
            : canonicalBlockHash,
        timestamp: ethers.toBeHex(
          automaticRecovery
            ? Math.max(0, claimSeconds - 101 + number)
            : receiptTimestamp,
        ),
      };
    } else if (automaticRecovery && body.method === "eth_getLogs") {
      const range = body.params[0];
      const from = Number(BigInt(range.fromBlock));
      const to = Number(BigInt(range.toBlock));
      result = [100, 101]
        .filter((number) => from <= number && number <= to)
        .flatMap((number) =>
          receiptLogs
            .filter((log) => log.address === C.router)
            .map((log, index) => ({
              ...log,
              transactionHash: number === 100 ? historicalHash : hash,
              blockNumber: ethers.toBeHex(number),
              blockHash:
                number === 100 ? historicalBlockHash : canonicalBlockHash,
              logIndex: ethers.toBeHex(index),
              removed: false,
            })),
        );
    } else if (
      automaticRecovery &&
      body.method === "eth_getTransactionReceipt"
    ) {
      const old = body.params[0] === historicalHash;
      assert.ok(old || body.params[0] === hash);
      result = {
        status: "0x1",
        blockNumber: old ? "0x64" : "0x65",
        blockHash: old ? historicalBlockHash : canonicalBlockHash,
        logs: receiptLogs.map((log, index) => ({
          ...log,
          logIndex: ethers.toBeHex(index),
        })),
      };
    } else {
      assert.fail(`Unexpected RPC method ${body.method}; no network permitted`);
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const first = operations[0];
  const second = operations[1];
  assert.ok(first && second);
  for (const operation of operations) {
    assert.equal(
      (await runtime.reconcile(userId, operation.id)).status,
      "in_progress",
      "known-hash mined receipts remain pending before finality, including zero payout",
    );
    assert.notEqual(
      (
        await fetchPositionActionForUser(db, {
          userId,
          operationId: operation.id,
        })
      )?.status,
      "completed",
    );
  }
  receiptMissing = true;
  assert.equal(
    (await runtime.reconcile(userId, first.id)).status,
    "in_progress",
    "a dropped receipt cannot settle the operation",
  );
  receiptMissing = false;
  finalizedHeight = 101;
  canonicalBlockHash = ethers.id("v2-reorg-canonical-block");
  assert.equal(
    (await runtime.reconcile(userId, first.id)).status,
    "in_progress",
    "orphaned block identity stays reconcilable without another send",
  );
  failedFinalityRead = true;
  await assert.rejects(
    runtime.reconcile(userId, first.id),
    /Finality fixture unavailable/,
  );
  failedFinalityRead = false;
  assert.equal(
    Number(
      (
        await db.query("select count(*) from notifications where user_id=$1", [
          userId,
        ])
      ).rows[0]?.count,
    ),
    0,
    "no completion notification is emitted from pre-final/orphan/RPC-unknown evidence",
  );
  receiptBlockNumber = 101;
  receiptBlockHash = canonicalBlockHash;
  const fullReceipt = receiptLogs;
  receiptLogs = fullReceipt.filter((_, index) => index !== 1);
  assert.equal(
    (await runtime.reconcile(userId, first.id)).status,
    "reconcile_required",
    "generic credit cannot substitute for module burn",
  );
  receiptLogs = fullReceipt;
  receiptTimestamp = 946684800;
  for (const operation of operations) {
    assert.equal(
      (await runtime.reconcile(userId, operation.id)).status,
      "reconcile_required",
      "a finalized historical matching receipt cannot complete a newly claimed positive/zero action",
    );
    const quarantined = await fetchPositionActionForUser(db, {
      userId,
      operationId: operation.id,
    });
    assert.ok(quarantined?.broadcastMayHaveOccurred);
    assert.equal(quarantined.submissionFingerprint, null);
    assert.equal(quarantined.receiptStatus, "unknown");
    assert.equal(
      (await runtime.claimSubmission(userId, operation.id)).claimed,
      false,
      "quarantine never authorizes another wallet dispatch",
    );
    const lateCancellation = await runtime.reportSubmission(userId, {
      operationId: operation.id,
      attemptNumber: 1,
      outcome: "not_broadcast",
      submissionFingerprint: null,
      errorCode: null,
    });
    assert.ok(lateCancellation.broadcastMayHaveOccurred);
    assert.equal(lateCancellation.submissionFingerprint, null);
  }
  assert.equal(
    Number(
      (
        await db.query("select count(*) from notifications where user_id=$1", [
          userId,
        ])
      ).rows[0]?.count,
    ),
    0,
  );
  const claimRows = await db.query<{ started_at: Date }>(
    "select started_at from position_action_attempts where action_operation_id=any($1::uuid[])",
    [operations.map((operation) => operation.id)],
  );
  claimSeconds = Math.max(
    ...claimRows.rows.map((row) => Math.floor(row.started_at.getTime() / 1000)),
  );
  hash = ethers.id(`v2-current-redemption-fixture:${userId}`);
  receiptTimestamp = claimSeconds + 60;
  await runtime.reportSubmission(userId, {
    operationId: first.id,
    attemptNumber: 1,
    outcome: "submitted",
    submissionFingerprint: hash,
    errorCode: null,
  });
  assert.equal(
    (
      await quarantinePreClaimPositionActionReference(db, {
        userId,
        operationId: first.id,
        expectedTransactionHash: historicalHash,
        receiptEvidence: { receiptPrecedesClaim: true },
      })
    ).submissionFingerprint,
    hash,
    "a stale observer cannot erase a repaired reference",
  );
  assert.equal(
    (await runtime.reconcile(userId, first.id)).status,
    "completed",
    "remaining later fill does not strand exact redemption",
  );
  automaticRecovery = true;
  assert.equal(
    (await runtime.reconcile(userId, second.id)).status,
    "completed",
    "zero payout auto-recovers the current receipt while ignoring the pre-claim candidate, without another send",
  );
  const held = await db.query<{ size: string }>(
    "select size::text from positions where user_id=$1",
    [userId],
  );
  assert.ok(
    held.rows.every((row) => Number(row.size) === 1),
    "receipt does not incorrectly flatten remaining holdings",
  );
  const repaired = await db.query<{
    rejected: string;
    current_reference: string;
  }>(
    "select attempt_row.receipt_evidence->'quarantinedSubmission'->>'rejectedSubmissionFingerprint' as rejected, operation_row.submission_fingerprint as current_reference from position_action_operations operation_row join position_action_attempts attempt_row on attempt_row.action_operation_id=operation_row.id where operation_row.id=any($1::uuid[])",
    [operations.map((operation) => operation.id)],
  );
  assert.ok(
    repaired.rows.every(
      (row) =>
        row.rejected === historicalHash && row.current_reference === hash,
    ),
    "recovery preserves attribution diagnostics and binds only the current transaction",
  );
  for (const operation of operations)
    assert.equal(
      (
        await fetchPositionActionForUser(db, {
          userId,
          operationId: operation.id,
        })
      )?.postconditionStatus,
      "satisfied",
    );
  const finalEvidence = await db.query(
    "select receipt_evidence->>'blockHash' as block_hash, receipt_evidence->>'finality' as finality from position_action_attempts where action_operation_id=any($1::uuid[])",
    [operations.map((row) => row.id)],
  );
  assert.ok(
    finalEvidence.rows.every(
      (row) =>
        row.block_hash === canonicalBlockHash && row.finality === "finalized",
    ),
  );
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) from position_action_attempts where action_operation_id=any($1::uuid[])",
          [operations.map((row) => row.id)],
        )
      ).rows[0]?.count,
    ),
    2,
    "reconciliation never creates another submission attempt",
  );
  assert.deepEqual(
    (
      await db.query(
        "select action_operation_id, started_at from position_action_attempts where action_operation_id=any($1::uuid[]) order by action_operation_id",
        [operations.map((operation) => operation.id)],
      )
    ).rows,
    claimedTimes.rows,
    "claim retries and recovery do not move the durable attempt boundary",
  );
  console.log(
    "[polymarket-v2-redemption-runtime-integration-tests] PG16 bundled attribution, exact receipt, nonzero residual and zero payout passed",
  );
} finally {
  ethers.JsonRpcProvider.prototype.getTransactionReceipt = originalReceipt;
  globalThis.fetch = originalFetch;
  try {
    const ids = operations.map((operation) => operation.id);
    await db.query(
      "delete from position_action_effects where action_operation_id=any($1::uuid[])",
      [ids],
    );
    await db.query(
      "delete from position_action_attempts where action_operation_id=any($1::uuid[])",
      [ids],
    );
    await db.query(
      "delete from position_action_operations where id=any($1::uuid[])",
      [ids],
    );
    await db.query("delete from notifications where user_id=$1", [userId]);
    await db.query("delete from positions where user_id=$1", [userId]);
    await db.query("delete from users where id=$1", [userId]);
  } finally {
    await db.end();
  }
}
