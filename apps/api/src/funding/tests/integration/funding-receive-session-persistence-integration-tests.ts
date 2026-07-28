#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "../../../db.js";
import {
  createOrReuseFundingReceiveSession,
  expireFundingReceiveSessions,
  fetchFundingReceiveSessionForUser,
  insertFundingReceiveReceipt,
  listFundingReceiveReceiptsForUser,
  settleFundingReceiveReceiptRouting,
} from "../../persistence/funding-receive-session-repository.js";

const NOW = new Date("2026-07-27T18:00:00.000Z");
const DESTINATION_OPTION_ID = "destination_receive_persistence_12345678";
const VENUE_BINDING_OPTION_ID = "binding_receive_persistence_12345678";
const RUN_ID = crypto.randomUUID();

function uniqueHash(label: string): string {
  return `0x${crypto.createHash("sha256").update(`${RUN_ID}:${label}`).digest("hex")}`;
}

async function insertUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`funding-receive-${crypto.randomUUID()}@example.com`],
  );
  const userId = rows[0]?.id;
  assert.ok(userId);
  return userId;
}

function sessionInput(userId: string) {
  const asset = {
    networkId: "evm:137",
    assetId: "0x0000000000000000000000000000000000000001",
    decimals: 6,
  } as const;
  const receiveTarget = {
    receiveTargetId: "receive_target_persistence_12345678",
    networkId: asset.networkId,
    destinationAddress: "0x0000000000000000000000000000000000000002",
    acceptedAssets: [{ asset, handling: "direct" as const }],
    safeInstructions: ["Send only the displayed asset."],
  } as const;
  return {
    userId,
    venueId: "polymarket",
    destinationOptionId: DESTINATION_OPTION_ID,
    venueBindingOptionId: VENUE_BINDING_OPTION_ID,
    destinationAsset: asset,
    destinationTargetSnapshot: { locationId: "location_receive_12345678" },
    venueBindingSnapshot: { bindingId: VENUE_BINDING_OPTION_ID },
    methods: [
      {
        methodId: "receive_method_manual_12345678",
        kind: "manual" as const,
        safeLabel: "Send crypto",
        ingress: {
          ingressKind: "manual" as const,
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [receiveTarget],
          recommendedReceiveTargetId: receiveTarget.receiveTargetId,
          destinationOptionId: DESTINATION_OPTION_ID,
          destinationAddress: receiveTarget.destinationAddress,
          requestedAmount: null,
          amountSemantics: "minimum" as const,
          expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
          safeInstructions: ["Send only the displayed asset."],
        },
      },
    ],
    receiveTargets: [receiveTarget],
    observationVariants: [
      {
        variantId: "ingress_variant_persistence_12345678",
        networkId: asset.networkId,
        asset,
        destinationAddress: "0x0000000000000000000000000000000000000002",
        destinationLocationId: "location_receive_12345678",
        baselineRaw: "0",
        baselineRevision: "baseline_revision_receive_12345678",
        observation: {
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: { balanceKey: "erc20:receive-test" },
        },
        completion: { kind: "direct_destination_credit" as const },
      },
    ],
    selectedReceiveTargetId: "receive_target_persistence_12345678",
    automationPolicy: {
      stableConversion: "automatic_within_caps" as const,
      volatileConversion: "review_required" as const,
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 1,
    policyRevision: "policy_revision_receive_12345678",
    ownershipRevision: "ownership_revision_receive_12345678",
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    observeUntil: new Date(NOW.getTime() + 8 * 86_400_000),
    now: NOW,
  } as const;
}

const userId = await insertUser();
try {
  const [first, second] = await Promise.all([
    createOrReuseFundingReceiveSession(pool, sessionInput(userId)),
    createOrReuseFundingReceiveSession(pool, sessionInput(userId)),
  ]);

  assert.equal(
    first.snapshot.session.receiveSessionId,
    second.snapshot.session.receiveSessionId,
  );
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);

  const restored = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: first.snapshot.session.receiveSessionId,
  });
  assert.equal(
    restored?.session.receiveSessionId,
    first.snapshot.session.receiveSessionId,
  );
  assert.equal(restored?.session.observeUntil, "2026-08-04T18:00:00.000Z");
  assert.deepEqual(
    restored?.session.automationPolicy,
    sessionInput(userId).automationPolicy,
  );
  assert.deepEqual(restored?.session.methods, [
    {
      methodId: "receive_method_manual_12345678",
      kind: "manual",
      safeLabel: "Send crypto",
      ingress: sessionInput(userId).methods[0]?.ingress,
    },
  ]);

  const replacement = await createOrReuseFundingReceiveSession(pool, {
    ...sessionInput(userId),
    policyRevision: "policy_revision_receive_changed_12345678",
    now: new Date(NOW.getTime() + 1_000),
    expiresAt: new Date(NOW.getTime() + 86_401_000),
    observeUntil: new Date(NOW.getTime() + 8 * 86_400_000 + 1_000),
  });
  assert.equal(replacement.replayed, false);
  assert.notEqual(
    replacement.snapshot.session.receiveSessionId,
    first.snapshot.session.receiveSessionId,
  );

  const { rows } = await pool.query<{ status: string }>(
    `
      select status
      from funding_receive_sessions
      where id = $1
    `,
    [first.snapshot.session.receiveSessionId],
  );
  assert.equal(rows[0]?.status, "expired");

  const client = await pool.connect();
  try {
    await client.query("begin");
    const canonicalEvent = {
      transactionHash: uniqueHash("global-replay-transaction"),
      eventIndex: "7",
      ledgerHeight: "12345678",
      blockHash: uniqueHash("global-replay-block"),
      sourceAddress: "0x0000000000000000000000000000000000000003",
    };
    const firstReceipt = await insertFundingReceiveReceipt(client, {
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      variantId: "ingress_variant_event_a_12345678",
      asset: sessionInput(userId).destinationAsset,
      destinationAddress:
        sessionInput(userId).receiveTargets[0].destinationAddress,
      rawAmount: "1000000",
      observationRevision: "evm_event_revision_a_12345678",
      canonicalEvent,
      observedAt: NOW,
      status: "ready",
      handling: "direct",
      evidence: { canonical: true },
      now: NOW,
    });
    const replay = await insertFundingReceiveReceipt(client, {
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      variantId: "ingress_variant_event_b_12345678",
      asset: sessionInput(userId).destinationAsset,
      destinationAddress:
        sessionInput(userId).receiveTargets[0].destinationAddress,
      rawAmount: "1000000",
      observationRevision: "evm_event_revision_b_12345678",
      canonicalEvent,
      observedAt: NOW,
      status: "ready",
      handling: "direct",
      evidence: { canonical: true },
      now: NOW,
    });
    assert.equal(firstReceipt.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.receipt.receiptId, firstReceipt.receipt.receiptId);
  } finally {
    await client.query("rollback");
    client.release();
  }

  const firstRoutedReceipt = await pool.connect();
  let firstRoutedReceiptId: string;
  try {
    await firstRoutedReceipt.query("begin");
    const inserted = await insertFundingReceiveReceipt(firstRoutedReceipt, {
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      variantId: "ingress_variant_multi_receipt_a_12345678",
      asset: sessionInput(userId).destinationAsset,
      destinationAddress:
        sessionInput(userId).receiveTargets[0].destinationAddress,
      rawAmount: "1000000",
      observationRevision: "evm_event_multi_receipt_a_12345678",
      canonicalEvent: {
        transactionHash: uniqueHash("first-routed-transaction"),
        eventIndex: "1",
        ledgerHeight: "12345679",
        blockHash: uniqueHash("first-routed-block"),
        sourceAddress: "0x0000000000000000000000000000000000000004",
      },
      observedAt: NOW,
      status: "observed",
      handling: "automatic_conversion",
      evidence: { canonical: true },
      now: NOW,
    });
    firstRoutedReceiptId = inserted.receipt.receiptId;
    await firstRoutedReceipt.query(
      `
        update funding_receive_receipts
        set status = 'routing'
        where id = $1
      `,
      [firstRoutedReceiptId],
    );
    await firstRoutedReceipt.query("commit");
  } catch (error) {
    await firstRoutedReceipt.query("rollback");
    throw error;
  } finally {
    firstRoutedReceipt.release();
  }

  assert.equal(
    await settleFundingReceiveReceiptRouting(pool, {
      receiptId: firstRoutedReceiptId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      status: "ready",
      now: new Date(NOW.getTime() + 2_000),
    }),
    true,
  );
  const afterFirstReceipt = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.equal(
    afterFirstReceipt?.session.status,
    "open",
    "a routed receipt must not close an amount-free receive session",
  );

  const secondReceiptClient = await pool.connect();
  try {
    await secondReceiptClient.query("begin");
    const secondReceipt = await insertFundingReceiveReceipt(
      secondReceiptClient,
      {
        receiveSessionId: replacement.snapshot.session.receiveSessionId,
        userId,
        variantId: "ingress_variant_multi_receipt_b_12345678",
        asset: sessionInput(userId).destinationAsset,
        destinationAddress:
          sessionInput(userId).receiveTargets[0].destinationAddress,
        rawAmount: "2000000",
        observationRevision: "evm_event_multi_receipt_b_12345678",
        canonicalEvent: {
          transactionHash: uniqueHash("second-receipt-transaction"),
          eventIndex: "2",
          ledgerHeight: "12345680",
          blockHash: uniqueHash("second-receipt-block"),
          sourceAddress: "0x0000000000000000000000000000000000000005",
        },
        observedAt: new Date(NOW.getTime() + 3_000),
        status: "ready",
        handling: "direct",
        evidence: { canonical: true },
        now: new Date(NOW.getTime() + 3_000),
      },
    );
    assert.equal(secondReceipt.replayed, false);
    await secondReceiptClient.query("commit");
  } catch (error) {
    await secondReceiptClient.query("rollback");
    throw error;
  } finally {
    secondReceiptClient.release();
  }
  const { rows: multiReceiptRows } = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from funding_receive_receipts
      where receive_session_id = $1
        and status = 'ready'
    `,
    [replacement.snapshot.session.receiveSessionId],
  );
  assert.equal(multiReceiptRows[0]?.count, "2");

  const reviewReceiptClient = await pool.connect();
  try {
    await reviewReceiptClient.query("begin");
    const reviewReceipt = await insertFundingReceiveReceipt(
      reviewReceiptClient,
      {
        receiveSessionId: replacement.snapshot.session.receiveSessionId,
        userId,
        variantId: "ingress_variant_review_receipt_12345678",
        asset: sessionInput(userId).destinationAsset,
        destinationAddress:
          sessionInput(userId).receiveTargets[0].destinationAddress,
        rawAmount: "3000000",
        observationRevision: "evm_event_review_receipt_12345678",
        canonicalEvent: {
          transactionHash: uniqueHash("review-receipt-transaction"),
          eventIndex: "3",
          ledgerHeight: "12345681",
          blockHash: uniqueHash("review-receipt-block"),
          sourceAddress: "0x0000000000000000000000000000000000000006",
        },
        observedAt: new Date(NOW.getTime() + 4_000),
        status: "review_required",
        handling: "review_required",
        evidence: { canonical: true },
        now: new Date(NOW.getTime() + 4_000),
      },
    );
    assert.equal(reviewReceipt.receipt.status, "review_required");
    assert.equal(reviewReceipt.receipt.handling, "review_required");
    await reviewReceiptClient.query("commit");
  } catch (error) {
    await reviewReceiptClient.query("rollback");
    throw error;
  } finally {
    reviewReceiptClient.release();
  }

  await pool.query(
    `
      update funding_receive_sessions
      set status = 'review_required'
      where id = $1
    `,
    [replacement.snapshot.session.receiveSessionId],
  );
  const reviewSnapshot = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.equal(reviewSnapshot?.session.status, "review_required");
  const reviewReceipts = await listFundingReceiveReceiptsForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.ok(
    reviewReceipts.some(
      (receipt) =>
        receipt.status === "review_required" &&
        receipt.handling === "review_required",
    ),
  );

  const concurrentStableReceiptClient = await pool.connect();
  let concurrentStableReceiptId = "";
  try {
    await concurrentStableReceiptClient.query("begin");
    const concurrentStableReceipt = await insertFundingReceiveReceipt(
      concurrentStableReceiptClient,
      {
        receiveSessionId: replacement.snapshot.session.receiveSessionId,
        userId,
        variantId: "ingress_variant_concurrent_stable_12345678",
        asset: sessionInput(userId).destinationAsset,
        destinationAddress:
          sessionInput(userId).receiveTargets[0].destinationAddress,
        rawAmount: "4000000",
        observationRevision: "evm_event_concurrent_stable_12345678",
        canonicalEvent: {
          transactionHash: uniqueHash("concurrent-stable-transaction"),
          eventIndex: "4",
          ledgerHeight: "12345682",
          blockHash: uniqueHash("concurrent-stable-block"),
          sourceAddress: "0x0000000000000000000000000000000000000007",
        },
        observedAt: new Date(NOW.getTime() + 5_000),
        status: "observed",
        handling: "automatic_conversion",
        evidence: { canonical: true },
        now: new Date(NOW.getTime() + 5_000),
      },
    );
    concurrentStableReceiptId = concurrentStableReceipt.receipt.receiptId;
    await concurrentStableReceiptClient.query(
      `
        update funding_receive_receipts
        set status = 'routing'
        where id = $1
      `,
      [concurrentStableReceiptId],
    );
    await concurrentStableReceiptClient.query("commit");
  } catch (error) {
    await concurrentStableReceiptClient.query("rollback");
    throw error;
  } finally {
    concurrentStableReceiptClient.release();
  }

  assert.equal(
    await settleFundingReceiveReceiptRouting(pool, {
      receiptId: concurrentStableReceiptId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      status: "ready",
      now: new Date(NOW.getTime() + 6_000),
    }),
    true,
  );
  const afterConcurrentStableReceipt = await fetchFundingReceiveSessionForUser(
    pool,
    {
      userId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
    },
  );
  assert.equal(
    afterConcurrentStableReceipt?.session.status,
    "review_required",
    "settling a stable receipt must not hide an unresolved volatile-asset review",
  );

  assert.equal(
    await expireFundingReceiveSessions(pool, {
      now: new Date(NOW.getTime() + 86_402_000),
    }),
    1,
  );
  const expiredProcessing = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.equal(expiredProcessing?.session.status, "expired");

  console.log(
    "[funding-receive-session-persistence-integration-tests] concurrent open, durable restore, global canonical-event replay, multi-receipt continuation, review-required persistence, policy replacement, and active-session expiry passed",
  );
} finally {
  const cleanup = await pool.connect();
  try {
    await cleanup.query("begin");
    await cleanup.query("set local session_replication_role = replica");
    await cleanup.query(
      "delete from funding_receive_receipts where user_id = $1",
      [userId],
    );
    await cleanup.query(
      "delete from funding_receive_sessions where user_id = $1",
      [userId],
    );
    await cleanup.query("delete from users where id = $1", [userId]);
    await cleanup.query("commit");
  } catch (error) {
    await cleanup.query("rollback");
    assert.fail(
      `receive-session test cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    cleanup.release();
  }
}
