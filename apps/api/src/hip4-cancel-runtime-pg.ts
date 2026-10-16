// Invoked by the disposable runtime suite. Offline signer and mocked transport.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import type { Wallet } from "ethers";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  type VenueLifecycleMode,
} from "@hunch/shared";
import { createApiTradingApplicationService } from "./services/api-trading-service.js";
import type { ApiBotTradingExecutor } from "./services/api-trading-types.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";

export async function testHip4CommonCancel(input: {
  pool: Pool;
  common: ApiBotTradingExecutor;
  wallet: Pick<Wallet, "signTypedData">;
  userId: string;
  controllerWalletRef: string;
  orderId: string;
  marketId: string;
  orderActionId: string;
  orderActionOrderId: string;
  orderSignature: string;
  calls: string[];
}) {
  const { pool, common, userId, orderId, marketId, calls } = input;
  const policyIds: string[] = [];
  async function policy(key: string, payload: unknown) {
    const result = await pool.query(
      "insert into runtime_policies(policy_key,payload,effective_at) values($1,$2,clock_timestamp()) returning id",
      [key, payload],
    );
    policyIds.push(result.rows[0].id);
  }
  async function lifecycle(mode: VenueLifecycleMode) {
    const payload = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
    payload.venues.hyperliquid = { lifecycle: mode, indexerMode: "off" };
    await policy("venue_lifecycle", payload);
  }
  const request = {
    actor: { kind: "web_app" as const, userId },
    venue: "hyperliquid" as const,
    orderId,
    idempotencyKey: randomUUID(),
  };
  const beforeCalls = calls.length;
  const statusBefore = (
    await pool.query("select status from orders where id=$1", [orderId])
  ).rows[0].status;
  const fundingBefore = (
    await pool.query(
      "select count(*)::int as n from funding_trade_attempts where user_id=$1",
      [userId],
    )
  ).rows[0].n;
  try {
    await lifecycle("unreleased");
    await policy("hip4_trading", {
      minimumBuyNotionalUsd: "invalid BUY setting",
      cancelSignatureTtlMs: 30000,
    });
    await pool.query("update unified_markets set status='CLOSED' where id=$1", [
      marketId,
    ]);
    await assert.rejects(
      createApiTradingApplicationService({ pool }).prepareCancelOrder(request),
      /lifecycle_disabled/u,
      "ordinary unreleased lifecycle disables new cancellation preparation",
    );
    await lifecycle("exit-only");
    for (const kind of ["telegram_bot", "worker", "admin_test"] as const)
      await assert.rejects(
        common.prepareCancelOrder({ ...request, actor: { kind, userId } }),
        /Hunch app/u,
      );
    await assert.rejects(
      common.prepareCancelOrder({ ...request, venue: "limitless" }),
      /not supported/u,
    );
    await assert.rejects(
      common.prepareCancelOrder({
        ...request,
        actor: { kind: "web_app", userId: randomUUID() },
      }),
      /order_not_found/u,
    );
    const preparedPair = await Promise.all([
      common.prepareCancelOrder(request),
      common.prepareCancelOrder({
        ...request,
        idempotencyKey: request.idempotencyKey.toUpperCase(),
      }),
    ]);
    assert.deepEqual(preparedPair[0], preparedPair[1]);
    const prepared = preparedPair[0];
    assert.equal(
      calls.length,
      beforeCalls,
      "cancel preparation requires no fee/cash/provider request",
    );
    const stored = (
      await pool.query("select * from hip4_order_actions where id=$1", [
        prepared.preparedId,
      ])
    ).rows[0];
    assert.equal(
      stored.unsigned_envelope.expiresAfter - stored.unsigned_envelope.nonce,
      30000,
    );
    assert.match(
      stored.preparation_snapshot.policyRevision,
      /^hip4-cancel-v1-/u,
    );
    assert.equal(stored.order_id, orderId);
    const signing = prepareHip4TradeSigning(stored.unsigned_envelope);
    assert.equal(signing.action.type, "cancelByCloid");
    assert.deepEqual(
      prepared.authorizationRequests[0].input,
      signing.typedData,
    );
    const submission = {
      actor: request.actor,
      venue: request.venue,
      orderId,
      preparedId: prepared.preparedId,
      signature: await input.wallet.signTypedData(
        signing.typedData.domain,
        signing.typedData.types,
        signing.typedData.message,
      ),
    };
    await assert.rejects(
      common.prepareCancelOrder({ ...request, orderId: randomUUID() }),
      /preparation_conflict/u,
    );
    await assert.rejects(
      common.submitPreparedCancelOrder({
        ...submission,
        preparedId: input.orderActionId,
        orderId: input.orderActionOrderId,
        signature: input.orderSignature,
      }),
      /cancel_preparation_identity_invalid/u,
    );
    await assert.rejects(
      common.submitPreparedCancelOrder({
        ...submission,
        orderId: randomUUID(),
      }),
      /cancel_preparation_identity_invalid/u,
    );
    await assert.rejects(
      common.submitPreparedCancelOrder({
        ...submission,
        actor: { kind: "telegram_bot", userId },
      }),
      /Hunch app/u,
    );
    await lifecycle("unreleased");
    await policy("hip4_trading", { cancelSignatureTtlMs: 0 });
    await pool.query("update user_wallets set is_verified=false where id=$1", [
      input.controllerWalletRef,
    ]);
    assert.deepEqual(
      await common.prepareCancelOrder(request),
      prepared,
      "owned replay returns stored material, not renewed authority",
    );
    await assert.rejects(
      common.submitPreparedCancelOrder(submission),
      /lifecycle_disabled/u,
    );
    await lifecycle("exit-only");
    await assert.rejects(
      common.submitPreparedCancelOrder(submission),
      /controller wallet changed/u,
    );
    await pool.query("update user_wallets set is_verified=true where id=$1", [
      input.controllerWalletRef,
    ]);
    await assert.rejects(
      common.prepareCancelOrder({ ...request, idempotencyKey: randomUUID() }),
      /cancel_policy_invalid/u,
    );
    // An already-reviewed exact cancellation needs no new BUY/cancel TTL policy.
    const results = await Promise.all([
      common.submitPreparedCancelOrder(submission),
      common.submitPreparedCancelOrder(submission),
    ]);
    assert.ok(results.every((result) => result.status === "submitted"));
    assert.equal(
      results.filter((result) => (result.raw as { replayed: boolean }).replayed)
        .length,
      1,
    );
    assert.deepEqual(
      calls.slice(beforeCalls),
      ["exchange"],
      "one cancel POST, no balance/fee refresh or automatic signing",
    );
    assert.equal(
      (await pool.query("select status from orders where id=$1", [orderId]))
        .rows[0].status,
      statusBefore,
      "cancel ACK is not a cancelled/filled economic order",
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from funding_trade_attempts where user_id=$1",
          [userId],
        )
      ).rows[0].n,
      fundingBefore,
    );
    await lifecycle("unreleased");
    await pool.query("update user_wallets set is_verified=false where id=$1", [
      input.controllerWalletRef,
    ]);
    assert.equal(
      (await common.submitPreparedCancelOrder(submission)).status,
      "submitted",
    );
    assert.deepEqual(
      calls.slice(beforeCalls),
      ["exchange"],
      "durable replay does not resend after lost ownership/policy change",
    );
    await lifecycle("exit-only");
    await pool.query("update user_wallets set is_verified=true where id=$1", [
      input.controllerWalletRef,
    ]);
    await policy("hip4_trading", { cancelSignatureTtlMs: 45000 });
    const repaired = await common.prepareCancelOrder({
      ...request,
      idempotencyKey: randomUUID(),
    });
    assert.notEqual(repaired.preparedId, prepared.preparedId);
    console.log(
      "[hip4-common-cancel] exact identity, exit-only, policy/ownership recovery, closed market, concurrent replay and one mocked POST passed",
    );
  } finally {
    await pool.query("update unified_markets set status='ACTIVE' where id=$1", [
      marketId,
    ]);
    await pool.query("update user_wallets set is_verified=true where id=$1", [
      input.controllerWalletRef,
    ]);
    for (const id of policyIds)
      await pool.query("delete from runtime_policies where id=$1", [id]);
  }
}
