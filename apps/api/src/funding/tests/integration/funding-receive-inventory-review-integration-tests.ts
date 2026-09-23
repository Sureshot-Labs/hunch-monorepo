#!/usr/bin/env tsx

// @api-integration
// Synthetic IDs and addresses mirror the historical Solana-zero,
// Polygon-zero, and Base-partial receive-review shapes. This entire fixture
// rolls back; it never calls a provider or submits a transaction.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { FundingReceiveSessionObserver } from "../../receive/receive-session-observer.js";
import {
  claimExpiredFundingReceiveInventoryReviews,
  listFundingReceiveReceiptsForUser,
  resolveFundingReceiveInventoryReviewInTransaction,
  setFundingReceiveReceiptReviewQuote,
} from "../../persistence/funding-receive-session-repository.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const userId = crypto.randomUUID();
const now = new Date();
const hour = 60 * 60_000;
const observedAt = new Date(now.getTime() - 10 * 24 * hour);
const quoteId = crypto.randomUUID();

type Fixture = Readonly<{
  receiptId?: string;
  networkId: string;
  assetId: string;
  address: string;
  raw: string;
  confirmedRaw?: string;
  height: string;
  observeUntil?: Date;
}>;

async function addReview(input: Fixture) {
  const sessionId = crypto.randomUUID();
  const receiptId = input.receiptId ?? crypto.randomUUID();
  const locationId = `synthetic_location_${sessionId}`;
  const variantId = `synthetic_variant_${sessionId}`;
  const variants = [
    {
      variantId,
      destinationLocationId: locationId,
      destinationAddress: input.address,
      networkId: input.networkId,
      asset: {
        networkId: input.networkId,
        assetId: input.assetId,
        decimals: 6,
      },
    },
  ];
  await client.query(
    `insert into funding_receive_sessions (
       id, user_id, status, owner_channel, venue_id,
       destination_option_id, venue_binding_option_id, destination_asset,
       destination_target_snapshot, venue_binding_snapshot, funding_methods,
       receive_targets, observation_variants, observation_start_variants,
       automation_policy, policy_version, policy_revision, ownership_revision,
       opened_at, expires_at, observe_until, created_at, updated_at
     ) values (
       $1, $2, 'review_required', 'web', 'polymarket',
       $3, $4, $5::jsonb,
       '{}'::jsonb, '{}'::jsonb, '[{}]'::jsonb,
       '[{}]'::jsonb, $6::jsonb, $6::jsonb,
       '{"stableConversion":"automatic_within_caps","volatileConversion":"review_required","maximumFeeUsd":"10","maximumFeeBps":2000,"maximumSlippageBps":100}'::jsonb,
       1, 'synthetic_policy_v1', 'synthetic_ownership_v1',
       $7, $8, $9, $7, $7
     )`,
    [
      sessionId,
      userId,
      `synthetic_destination_${sessionId}`,
      `synthetic_binding_${sessionId}`,
      JSON.stringify({
        networkId: "evm:137",
        assetId: "0x0000000000000000000000000000000000000001",
        decimals: 6,
      }),
      JSON.stringify(variants),
      observedAt,
      new Date(observedAt.getTime() + 24 * hour),
      input.observeUntil ?? new Date(observedAt.getTime() + 8 * 24 * hour),
    ],
  );
  await client.query(
    `insert into funding_receive_receipts (
       id, receive_session_id, user_id, variant_id, network_id, asset_id,
       asset_decimals, destination_address, raw_amount, observation_revision,
       tx_hash, event_index, ledger_height, block_hash, observed_at,
       status, handling, routing_disposition, routing_last_error_code,
       evidence, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6,
       6, $7, $8::numeric, $9,
       $10, '0', $11::numeric, $12, $13,
       'review_required', 'automatic_conversion', 'review_required',
       'child_operation_failed_before_broadcast', $14::jsonb, $13, $13
     )`,
    [
      receiptId,
      sessionId,
      userId,
      variantId,
      input.networkId,
      input.assetId,
      input.address,
      input.raw,
      `synthetic_observation_${receiptId}`,
      `0x${crypto.randomBytes(32).toString("hex")}`,
      input.height,
      `0x${crypto.randomBytes(32).toString("hex")}`,
      observedAt,
      JSON.stringify({
        reviewQuotePlan: {
          confirmedSourceAmount: { raw: input.confirmedRaw ?? input.raw },
        },
      }),
    ],
  );
  return { sessionId, receiptId, locationId };
}

try {
  await client.query("begin");
  await client.query(
    `insert into users (id, email, is_active, is_verified)
     values ($1, $2, true, true)`,
    [userId, `inventory-review-${userId}@example.com`],
  );
  const sol = await addReview({
    networkId: "solana:mainnet",
    assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    address: "9xQeWvG816bUx9EPjHmaT23yvVMZq4XFmYdWkP3vZC8V",
    raw: "100000",
    height: "440854275",
  });
  const polygon = await addReview({
    networkId: "evm:137",
    assetId: "0x000000000000000000000000000000000000aBcD",
    address: "0x000000000000000000000000000000000000FfFf",
    raw: "1000000",
    height: "70000000",
  });
  const base = await addReview({
    networkId: "evm:8453",
    assetId: "0x000000000000000000000000000000000000ABcd",
    address: "0x000000000000000000000000000000000000DeF0",
    raw: "2218560",
    height: "35000000",
  });
  const stillObserving = await addReview({
    networkId: "evm:8453",
    assetId: "0x000000000000000000000000000000000000ABcd",
    address: "0x000000000000000000000000000000000000abc1",
    raw: "2000000",
    height: "35000001",
    observeUntil: new Date(now.getTime() + hour),
  });
  const malformed = await addReview({
    receiptId: "00000000-0000-0000-0000-000000000001",
    networkId: "evm:137",
    assetId: "0x000000000000000000000000000000000000ABcd",
    address: "0x000000000000000000000000000000000000ab12",
    raw: "1000000",
    confirmedRaw: "1",
    height: "70000001",
  });
  const futureObserveUntil = new Date(now.getTime() + 2 * hour);
  const notYetOld = await addReview({
    receiptId: "00000000-0000-0000-0000-000000000002",
    networkId: "evm:8453",
    assetId: "0x000000000000000000000000000000000000ABcd",
    address: "0x000000000000000000000000000000000000ab13",
    raw: "1000000",
    height: "35000001",
    observeUntil: futureObserveUntil,
  });
  const firstCandidate = await claimExpiredFundingReceiveInventoryReviews(
    client,
    {
      limit: 1,
      minimumPollIntervalMs: hour,
      now,
    },
  );
  assert.equal(firstCandidate.length, 1);
  const firstClaimedReceipt = firstCandidate[0];
  assert.ok(firstClaimedReceipt);
  assert.ok(
    [sol.receiptId, polygon.receiptId, base.receiptId].includes(
      firstClaimedReceipt.receiptId,
    ),
    "an immature or malformed review cannot consume the sole claim slot",
  );
  const deferred = await client.query<{
    id: string;
    last_inventory_review_checked_at: Date | null;
  }>(
    `select id, last_inventory_review_checked_at
       from funding_receive_receipts where id = any($1::uuid[])
       order by id`,
    [[malformed.receiptId, notYetOld.receiptId]],
  );
  assert.equal(deferred.rows[0]?.last_inventory_review_checked_at, null);
  assert.equal(deferred.rows[1]?.last_inventory_review_checked_at, null);
  const candidates = await claimExpiredFundingReceiveInventoryReviews(client, {
    limit: 25,
    minimumPollIntervalMs: hour,
    now,
  });
  assert.deepEqual(
    new Set([...firstCandidate, ...candidates].map((entry) => entry.receiptId)),
    new Set([sol.receiptId, polygon.receiptId, base.receiptId]),
    "all expired historical networks are eligible, but the live observer is not",
  );
  assert.ok(
    !candidates.some((entry) => entry.receiptId === stillObserving.receiptId),
  );
  assert.equal(
    (
      await claimExpiredFundingReceiveInventoryReviews(client, {
        limit: 25,
        minimumPollIntervalMs: hour,
        now,
      })
    ).length,
    0,
    "a successful inventory check is rate-limited per receipt",
  );
  const claimedCandidates = [...firstCandidate, ...candidates];
  const solCandidate = claimedCandidates.find(
    (entry) => entry.receiptId === sol.receiptId,
  );
  const polygonCandidate = claimedCandidates.find(
    (entry) => entry.receiptId === polygon.receiptId,
  );
  const baseCandidate = claimedCandidates.find(
    (entry) => entry.receiptId === base.receiptId,
  );
  assert.ok(solCandidate && polygonCandidate && baseCandidate);

  let inventoryReads = 0;
  const inventoryObserver = new FundingReceiveSessionObserver({
    readFinalizedInventoryBalance: async ({ minimumHeight, sourceEvent }) => {
      inventoryReads += 1;
      assert.match(sourceEvent.txHash, /^0x[0-9a-f]{64}$/i);
      assert.match(sourceEvent.sourceRaw, /^[1-9][0-9]*$/);
      assert.ok(
        BigInt(minimumHeight) >= BigInt(sourceEvent.sourceLedgerHeight),
      );
      return { raw: "999999999999999999", height: minimumHeight };
    },
  });
  assert.deepEqual(
    await inventoryObserver.pollInventoryReviewBatch(
      client as unknown as typeof pool,
      { now: new Date(now.getTime() + hour + 1_000) },
    ),
    { sessionsPolled: 1, resolved: 0, retryableErrors: 0 },
    "one available-source review is read without a conversion or terminalization",
  );
  assert.equal(inventoryReads, 1);

  // Source still present: do not fabricate a debit, success, or terminal state.
  assert.equal(
    await resolveFundingReceiveInventoryReviewInTransaction(client, {
      ...solCandidate,
      observedBalanceRaw: "100000",
      observedHeight: "440854300",
      now,
    }),
    false,
  );
  assert.equal(
    (
      await listFundingReceiveReceiptsForUser(client, {
        userId,
        receiveSessionId: sol.sessionId,
      })
    )[0]?.status,
    "review_required",
  );

  // A later known credit invalidates an older chain snapshot, including when
  // the EVM token/address use mixed-case spelling in different records.
  await client.query(
    `insert into funding_receive_canonical_events (
       network_id, asset_id, asset_decimals, destination_address,
       source_address, raw_amount, tx_hash, event_index, ledger_height,
       block_hash, observed_at
     ) values ('evm:137', lower($1), 6, lower($2), $3, 1,
       $4, '0', 70000005, $5, $6)`,
    [
      polygonCandidate.assetId,
      polygonCandidate.destinationAddress,
      "0x0000000000000000000000000000000000000002",
      `0x${crypto.randomBytes(32).toString("hex")}`,
      `0x${crypto.randomBytes(32).toString("hex")}`,
      observedAt,
    ],
  );
  assert.equal(
    await resolveFundingReceiveInventoryReviewInTransaction(client, {
      ...polygonCandidate,
      observedBalanceRaw: "0",
      observedHeight: "70000004",
      now,
    }),
    false,
    "the latest known credit must be finalized before closing a review",
  );
  assert.equal(
    await resolveFundingReceiveInventoryReviewInTransaction(client, {
      ...polygonCandidate,
      observedBalanceRaw: "0",
      observedHeight: "70000005",
      now,
    }),
    true,
  );
  assert.equal(
    (
      await listFundingReceiveReceiptsForUser(client, {
        userId,
        receiveSessionId: polygon.sessionId,
      })
    )[0]?.sourceUnavailable,
    true,
  );

  // An active user quote owns the review. Its fresh explicit-consent path
  // must not be replaced by a background wallet snapshot.
  await client.query(
    `insert into funding_quotes (
       id, user_id, discovery_projection_id, selected_source_option_snapshot,
       destination_option_snapshot, plan_snapshot, policy_version,
       policy_revision, canonical_request_hash, plan_hash, consent_token_hash,
       expires_at, created_at
     ) values ($1, $2, 'synthetic_projection', '{}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, 1, 'synthetic_policy_v1',
       $3, $3, $4, $5, $6)`,
    [
      quoteId,
      userId,
      "a".repeat(64),
      crypto.randomBytes(32).toString("hex"),
      new Date(now.getTime() + hour),
      observedAt,
    ],
  );
  assert.equal(
    await setFundingReceiveReceiptReviewQuote(client, {
      receiptId: base.receiptId,
      userId,
      quoteId,
      previousQuoteId: null,
      now,
    }),
    true,
  );
  assert.equal(
    await resolveFundingReceiveInventoryReviewInTransaction(client, {
      ...baseCandidate,
      observedBalanceRaw: "1165519",
      observedHeight: "35000001",
      now,
    }),
    false,
  );
  await client.query(
    `update funding_receive_receipts set review_quote_id = null where id = $1`,
    [base.receiptId],
  );
  const operationId = crypto.randomUUID();
  await client.query(
    `insert into funding_operations (
       id, user_id, quote_id, purpose, status, progress_stage,
       experience_mode, plan_kind, idempotency_key, commit_request_hash,
       plan_hash, policy_version, policy_revision, destination_target_snapshot,
       placement_snapshot, quote_snapshot, consent_snapshot,
       original_subject_lookup_hmac, subject_lookup_key_version,
       expires_at, created_at
     ) values (
       $1, $2, $3, 'add_funds', 'awaiting_user', 'source_action',
       'prepare_first', 'wallet_route', $4, $5, $5, 1,
       'synthetic_policy_v1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, $5, 1, $6, $7
     )`,
    [
      operationId,
      userId,
      quoteId,
      crypto.randomUUID(),
      "b".repeat(64),
      new Date(now.getTime() + hour),
      observedAt,
    ],
  );
  const reservation = await client.query<{ id: string }>(
    `insert into balance_reservations (
       user_id, operation_id, component_id, location_id,
       network_id, asset_id, asset_decimals, raw_amount, mode,
       state, expires_at
     ) values (
       $1, $2, 'synthetic_active_inventory_hold', $3,
       $4, $5, 6, '1000', 'subtract_available',
       'active', $6
     ) returning id`,
    [
      userId,
      operationId,
      base.locationId,
      baseCandidate.networkId,
      baseCandidate.assetId.toLowerCase(),
      new Date(now.getTime() + hour),
    ],
  );
  assert.ok(reservation.rows[0]?.id);
  assert.equal(
    await resolveFundingReceiveInventoryReviewInTransaction(client, {
      ...baseCandidate,
      observedBalanceRaw: "1165519",
      observedHeight: "35000001",
      now,
    }),
    false,
    "an active physical source hold, even with different EVM casing, owns the review",
  );
  await client.query(
    `update balance_reservations
        set state = 'released', released_at = $2,
            outcome_reason = 'source_not_spent'
      where id = $1`,
    [reservation.rows[0]?.id, now],
  );
  assert.equal(
    await resolveFundingReceiveInventoryReviewInTransaction(client, {
      ...baseCandidate,
      observedBalanceRaw: "1165519",
      observedHeight: "35000001",
      now,
    }),
    true,
  );
  assert.equal(
    await resolveFundingReceiveInventoryReviewInTransaction(client, {
      ...baseCandidate,
      observedBalanceRaw: "1165519",
      observedHeight: "35000001",
      now,
    }),
    false,
    "terminalizing an unavailable source is idempotent",
  );
  assert.equal(
    await resolveFundingReceiveInventoryReviewInTransaction(client, {
      ...solCandidate,
      observedBalanceRaw: "0",
      observedHeight: "440854300",
      now,
    }),
    true,
  );
  const resolvedSol = await listFundingReceiveReceiptsForUser(client, {
    userId,
    receiveSessionId: sol.sessionId,
  });
  assert.equal(resolvedSol[0]?.sourceUnavailable, true);
  assert.equal(resolvedSol[0]?.childFundingOperationId, null);
  await client.query("rollback");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
