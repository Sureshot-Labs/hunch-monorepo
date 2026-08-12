#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import "../../../integration-test-database-guard.js";
import {
  fetchUser,
  FundingMergeConflictError,
  mergeUsers,
} from "../../../admin-merge-user-core.js";
import { AuthService } from "../../../auth.js";
import { pool } from "../../../db.js";
import {
  createOrReuseFundingReceiveSession,
  expireFundingReceiveSessions,
  fetchFundingReceiveReceiptForReview,
  fetchFundingReceiveSessionForUser,
  insertFundingReceiveReceipt,
  listFundingReceiveReceiptsForRouting,
  listFundingReceiveReceiptsForUser,
  recordFundingReceiveReceiptRoutingDisposition,
  settleFundingReceiveReceiptRouting,
} from "../../persistence/funding-receive-session-repository.js";

const NOW = new Date();
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
    assetId: "0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd",
    decimals: 6,
  } as const;
  const receiveTarget = {
    receiveTargetId: "receive_target_persistence_12345678",
    networkId: asset.networkId,
    destinationAddress: "0xDeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0",
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
        destinationAddress: "0xDeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0DeF0",
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
let mergeTargetId: string | null = null;
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
  assert.equal(
    restored?.session.observeUntil,
    new Date(NOW.getTime() + 8 * 86_400_000).toISOString(),
  );
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

  const receiptIdentity = {
    receive_session_id: replacement.snapshot.session.receiveSessionId,
    user_id: userId,
    variant_id: "ingress_variant_persistence_12345678",
    network_id: "evm:137",
    asset_id: sessionInput(userId).destinationAsset.assetId.toLowerCase(),
    asset_decimals: 6,
    destination_address:
      sessionInput(userId).receiveTargets[0].destinationAddress.toLowerCase(),
    handling: "direct",
  };
  const matchesFrozenVariant = async (candidate: object): Promise<boolean> => {
    const { rows } = await pool.query<{ matches: boolean }>(
      `select funding_receive_receipt_matches_frozen_variant(
         jsonb_populate_record(null::funding_receive_receipts, $1::jsonb)
       ) as matches`,
      [JSON.stringify(candidate)],
    );
    return rows[0]?.matches === true;
  };
  assert.equal(await matchesFrozenVariant(receiptIdentity), true);
  assert.equal(
    await matchesFrozenVariant({
      ...receiptIdentity,
      asset_id: receiptIdentity.asset_id.replace(/^0x/u, "0X"),
    }),
    false,
    "malformed EVM-looking asset IDs must not alias a valid frozen asset",
  );
  const { rows: identityRows } = await pool.query<{
    evm_alias: boolean;
    malformed_exact: boolean;
    solana_exact: boolean;
  }>(
    `
      select
        funding_account_identifier_equal(
          'evm:137',
          '0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd',
          '0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd'
        ) as evm_alias,
        funding_account_identifier_equal(
          'evm:137',
          '0XAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd',
          '0Xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd'
        ) as malformed_exact,
        funding_account_identifier_equal(
          'solana:mainnet',
          'So11111111111111111111111111111111111111112',
          'so11111111111111111111111111111111111111112'
        ) as solana_exact
    `,
  );
  assert.equal(identityRows[0]?.evm_alias, true);
  assert.equal(identityRows[0]?.malformed_exact, false);
  assert.equal(identityRows[0]?.solana_exact, false);

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

  await assert.rejects(
    settleFundingReceiveReceiptRouting(pool, {
      receiptId: firstRoutedReceiptId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      childOperationId: crypto.randomUUID(),
      childOperationStatus: "failed",
      status: "review_required",
      now: new Date(NOW.getTime() + 1_500),
    }),
    /adapter review evidence/i,
  );
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
  let reviewReceiptId = "";
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
    await assert.rejects(
      recordFundingReceiveReceiptRoutingDisposition(pool, {
        receiptId: reviewReceipt.receipt.receiptId,
        receiveSessionId: replacement.snapshot.session.receiveSessionId,
        userId,
        disposition: "review_required",
        errorCode: "economic_review_required",
        now: new Date(NOW.getTime() + 3_500),
      }),
      /adapter continuation and quote plan/i,
    );
    reviewReceiptId = reviewReceipt.receipt.receiptId;
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
  const routableReviews = await listFundingReceiveReceiptsForRouting(pool, {
    limit: 100,
    now: new Date(NOW.getTime() + 5_000),
  });
  assert.ok(
    routableReviews.some(
      (target) => target.receipt.receiptId === reviewReceiptId,
    ),
    "web review receipts without an adapter plan must reach the channel-neutral disposition resolver",
  );
  await pool.query(
    `
      update funding_receive_receipts
      set evidence = evidence || jsonb_build_object(
        'reviewContinuation', jsonb_build_object(
          'version', 2,
          'kind', 'convert',
          'label', 'Convert',
          'confirmation', 'fresh_quote'
        ),
        'reviewQuotePlan', jsonb_build_object(
          'version', 1,
          'confirmedSourceAmount', null,
          'requestedDestinationAmount', jsonb_build_object(
            'asset', jsonb_build_object(
              'networkId', 'evm:137',
              'assetId', 'malformed-plan',
              'decimals', -1
            ),
            'raw', '3000000'
          ),
          'venuePreparation', false
        )
      )
      where id = $1
    `,
    [reviewReceiptId],
  );
  const malformedReviews = await listFundingReceiveReceiptsForRouting(pool, {
    limit: 100,
    now: new Date(NOW.getTime() + 5_500),
  });
  assert.ok(
    malformedReviews.some(
      (target) => target.receipt.receiptId === reviewReceiptId,
    ),
    "present but structurally invalid review evidence must remain repairable",
  );
  assert.equal(
    await recordFundingReceiveReceiptRoutingDisposition(pool, {
      receiptId: reviewReceiptId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      userId,
      disposition: "review_required",
      errorCode: "economic_review_required",
      reviewContinuation: {
        version: 1,
        kind: "convert",
        label: "Convert",
        confirmation: "fresh_quote",
      },
      reviewQuotePlan: {
        version: 1,
        confirmedSourceAmount: null,
        requestedDestinationAmount: {
          asset: sessionInput(userId).destinationAsset,
          raw: "3000000",
        },
        venuePreparation: false,
      },
      now: new Date(NOW.getTime() + 6_000),
    }),
    true,
  );
  const reviewReceipts = await listFundingReceiveReceiptsForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.ok(
    reviewReceipts.some(
      (receipt) =>
        receipt.status === "review_required" &&
        receipt.handling === "review_required" &&
        receipt.reviewContinuation?.version === 1 &&
        receipt.reviewQuotePlan?.version === 1,
    ),
  );
  const webReviewTarget = await fetchFundingReceiveReceiptForReview(pool, {
    userId,
    ownerChannel: "web",
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
    receiptId: reviewReceiptId,
  });
  assert.ok(webReviewTarget);
  assert.equal(
    webReviewTarget.receiptVariantSnapshot,
    null,
    "review targets preserve an explicit null when no frozen variant matches",
  );
  assert.equal(
    await fetchFundingReceiveReceiptForReview(pool, {
      userId,
      ownerChannel: "telegram",
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
      receiptId: reviewReceiptId,
    }),
    null,
    "a channel must never quote or commit another channel's receipt",
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

  assert.ok(
    (await expireFundingReceiveSessions(pool, {
      now: new Date(NOW.getTime() + 86_402_000),
    })) >= 1,
    "the global expiry sweep must include this test's expired session",
  );
  const expiredProcessing = await fetchFundingReceiveSessionForUser(pool, {
    userId,
    receiveSessionId: replacement.snapshot.session.receiveSessionId,
  });
  assert.equal(expiredProcessing?.session.status, "expired");
  mergeTargetId = await insertUser();
  const [sourceUser, targetUser] = await Promise.all([
    fetchUser(userId),
    fetchUser(mergeTargetId),
  ]);
  assert.ok(sourceUser);
  assert.ok(targetUser);
  await assert.rejects(
    mergeUsers(
      sourceUser,
      targetUser,
      { dryRun: false, keepSource: false },
      pool,
    ),
    (error: unknown) => {
      assert.ok(error instanceof FundingMergeConflictError);
      assert.ok(error.conflicts.receiveEvidence > 0);
      return true;
    },
  );
  const deletion = await AuthService.deleteUser(userId);
  assert.equal(deletion.disposition, "deactivated");
  assert.equal(deletion.activeMovement, true);
  assert.equal(deletion.privyDeletionAllowed, false);
  assert.ok(deletion.protectedReasons.includes("receive_evidence"));
  assert.ok(deletion.protectedReasons.includes("active_receive_session"));
  assert.ok(
    await fetchFundingReceiveSessionForUser(pool, {
      userId,
      receiveSessionId: replacement.snapshot.session.receiveSessionId,
    }),
    "account deletion must preserve receive sessions and receipts",
  );

  console.log(
    "[funding-receive-session-persistence-integration-tests] concurrent open, durable restore, global canonical-event replay, multi-receipt continuation, review-required persistence, policy replacement, late-window account retention, and active-session expiry passed",
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
    if (mergeTargetId) {
      await cleanup.query("delete from users where id = $1", [mergeTargetId]);
    }
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
