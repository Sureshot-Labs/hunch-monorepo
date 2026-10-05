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
const hash = ethers.id(`v2-redemption-fixture:${userId}`);
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
  globalThis.fetch = async () => {
    throw new Error("Network forbidden in V2 runtime fixtures");
  };
  ethers.JsonRpcProvider.prototype.getTransactionReceipt = async () =>
    ({
      status: 1,
      blockNumber: 100,
      hash,
      logs: receiptLogs,
    }) as unknown as ethers.TransactionReceipt;
  const first = operations[0];
  const second = operations[1];
  assert.ok(first && second);
  const fullReceipt = receiptLogs;
  receiptLogs = fullReceipt.filter((_, index) => index !== 1);
  assert.equal(
    (await runtime.reconcile(userId, first.id)).status,
    "reconcile_required",
    "generic credit cannot substitute for module burn",
  );
  receiptLogs = fullReceipt;
  assert.equal(
    (await runtime.reconcile(userId, first.id)).status,
    "completed",
    "remaining later fill does not strand exact redemption",
  );
  assert.equal(
    (await runtime.reconcile(userId, second.id)).status,
    "completed",
    "zero payout completes from exact consumption proof",
  );
  const held = await db.query<{ size: string }>(
    "select size::text from positions where user_id=$1",
    [userId],
  );
  assert.ok(
    held.rows.every((row) => Number(row.size) === 1),
    "receipt does not incorrectly flatten remaining holdings",
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
