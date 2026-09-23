#!/usr/bin/env tsx

// @api-integration
// Historical shape: two Solana USDC receive reviews (2,000,000 and 210,731
// raw), followed by finalized trades spending 1,112,645 and 1,093,827 raw
// from the same wallet. All identities here are synthetic; the fixture rolls
// back and never submits a transaction or contacts a provider.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { FundingReceiveSessionObserver } from "../../receive/receive-session-observer.js";
import {
  claimExpiredFundingReceiveInventoryReviews,
  claimExpiredFundingReceiveSpentReviews,
  listFundingReceiveSpentReviewCandidates,
  markFundingReceiveSpentReviewCandidatesChecked,
  resolveFundingReceiveSpentReviewInTransaction as resolveSpentReviewWithProof,
} from "../../persistence/funding-receive-session-repository.js";

const pool = await createIntegrationTestPool({ max: 2 });
const client = await pool.connect();
const userId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const assetId = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const networkId = "solana:mainnet";
const locationId = "location_spent_review_synthetic";
const address = "9xQeWvG816bUx9EPjHmaT23yvVMZq4XFmYdWkP3vZC8V";
const now = new Date();
const observedAt = new Date(now.getTime() - 36 * 60_000);
const stamp = (minutes: number) =>
  new Date(observedAt.getTime() + minutes * 60_000);

try {
  const resolveFundingReceiveSpentReviewInTransaction = (
    dbClient: typeof client,
    input: Omit<
      Parameters<typeof resolveSpentReviewWithProof>[1],
      "verifiedDebitRaw" | "verifiedDebitSlot"
    >,
  ) =>
    resolveSpentReviewWithProof(dbClient, {
      ...input,
      verifiedDebitRaw: input.spentRaw,
      verifiedDebitSlot: input.spentSlot,
    });
  await client.query("begin");
  await client.query(
    `insert into users (id, email, is_active, is_verified)
     values ($1, $2, true, true)`,
    [userId, `spent-review-${userId}@example.com`],
  );
  const variants = [
    {
      variantId: "synthetic_sol_usdc",
      destinationLocationId: locationId,
      destinationAddress: address,
      networkId,
      asset: { networkId, assetId, decimals: 6 },
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
       'synthetic_destination', 'synthetic_binding', $3::jsonb,
       '{}'::jsonb, '{}'::jsonb, '[{}]'::jsonb,
       '[{}]'::jsonb, $4::jsonb, $4::jsonb,
       '{"stableConversion":"automatic_within_caps","volatileConversion":"review_required","maximumFeeUsd":"10","maximumFeeBps":2000,"maximumSlippageBps":100}'::jsonb,
       1, 'synthetic_policy_v1', 'synthetic_ownership_v1',
       $5, $6, $7, $5, $5
     )`,
    [
      sessionId,
      userId,
      JSON.stringify({
        networkId: "evm:137",
        assetId: "0x0000000000000000000000000000000000000001",
        decimals: 6,
      }),
      JSON.stringify(variants),
      observedAt,
      stamp(60),
      stamp(120),
    ],
  );

  const receiptIds = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, rawAmount, reason, minutes] of [
    [0, "2000000", "child_operation_failed_before_broadcast", 0],
    [1, "210731", "automation_policy_exceeded", 5],
  ] as const) {
    await client.query(
      `insert into funding_receive_receipts (
         id, receive_session_id, user_id, variant_id, network_id, asset_id,
         asset_decimals, destination_address, raw_amount, observation_revision,
         tx_hash, event_index, ledger_height, block_hash,
         observed_at, status, handling, routing_disposition,
         routing_last_error_code, evidence, created_at, updated_at
       ) values (
         $1, $2, $3, 'synthetic_sol_usdc', $4, $5,
         6, $6, $7::numeric, $8,
         $9, $10, $11::numeric, $12,
         $13, 'review_required', 'automatic_conversion', 'review_required',
         $14, $15::jsonb, $13, $13
       )`,
      [
        receiptIds[index],
        sessionId,
        userId,
        networkId,
        assetId,
        address,
        rawAmount,
        `synthetic_observation_${index}`,
        `0x${"aa".repeat(31)}${index + 1}`,
        `${index}`,
        index === 0 ? "449675317" : "449676595",
        `0x${"bb".repeat(32)}`,
        stamp(minutes),
        reason,
        JSON.stringify({
          reviewQuotePlan: { confirmedSourceAmount: { raw: rawAmount } },
        }),
      ],
    );
  }

  async function addCompletedSpend(
    rawAmount: string,
    minutes: number,
    createdMinutes = minutes,
    actionKind = "svm_transaction",
  ) {
    const quoteId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const segmentId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
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
        stamp(90),
        stamp(createdMinutes),
      ],
    );
    await client.query(
      `insert into funding_operations (
         id, user_id, quote_id, purpose, status, progress_stage,
         experience_mode, plan_kind, idempotency_key, commit_request_hash,
         plan_hash, policy_version, policy_revision, destination_target_snapshot,
         placement_snapshot, quote_snapshot, consent_snapshot,
         original_subject_lookup_hmac, subject_lookup_key_version,
         expires_at, created_at, completed_at
       ) values (
         $1, $2, $3, 'trade_shortfall', 'completed', 'terminal',
         'instant', 'wallet_route', $4, $5, $5, 1, 'synthetic_policy_v1',
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
         $5, 1, $6, $7, $8
       )`,
      [
        operationId,
        userId,
        quoteId,
        crypto.randomUUID(),
        "b".repeat(64),
        stamp(90),
        stamp(createdMinutes),
        stamp(minutes + 1),
      ],
    );
    await client.query(
      `insert into funding_operation_segments (
         id, operation_id, ordinal, provider_id, adapter_id, adapter_version,
         segment_kind, status, source_snapshot, destination_target_snapshot,
         quoted_input, quoted_expected_output, quoted_min_output,
         lookup_key_version, quote_expires_at
       ) values ($1, $2, 0, 'synthetic', 'synthetic', 1,
         'cross_network_transfer', 'succeeded', '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, $3)`,
      [segmentId, operationId, stamp(90)],
    );
    const reservation = await client.query<{ id: string }>(
      `insert into balance_reservations (
         user_id, operation_id, segment_id, component_id, location_id,
         network_id, asset_id, asset_decimals, raw_amount, mode,
         state, expires_at, released_at, outcome_reason
       ) values ($1, $2, $3, $4, $5, $6, $7, 6, $8,
         'subtract_available', 'released', $9, $10, 'source_spent')
       returning id`,
      [
        userId,
        operationId,
        segmentId,
        `alias_${minutes}`,
        locationId,
        networkId,
        assetId,
        rawAmount,
        stamp(90),
        stamp(minutes + 1),
      ],
    );
    await client.query(
      `insert into funding_operation_steps (
         id, operation_id, segment_id, ordinal, step_kind, state,
         action_fingerprint, executor_id, payer_requirement,
         normalized_action, action_validation_result
       ) values ($1, $2, $3, 0, 'transaction', 'succeeded',
         $4, 'wallet_profile_svm_v1', 'user', $5::jsonb, $6::jsonb)`,
      [
        stepId,
        operationId,
        segmentId,
        "c".repeat(64),
        JSON.stringify({
          kind: actionKind,
          networkId,
          instructions: [
            {
              programId: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
            },
          ],
        }),
        JSON.stringify({ relayStepKind: "deposit", signerAddress: address }),
      ],
    );
    await client.query(
      `insert into funding_operation_step_attempts (
         id, step_id, attempt_number, canonical_action_fingerprint,
         executor_id, outcome, broadcast_may_have_occurred,
         started_at, finished_at
       ) values ($1, $2, 1, $3, 'wallet_profile_svm_v1',
         'ambiguous', true, $4, $5)`,
      [attemptId, stepId, "c".repeat(64), stamp(minutes), stamp(minutes + 1)],
    );
    const reservationId = reservation.rows[0]?.id;
    assert.ok(reservationId);
    return {
      quoteId,
      operationId,
      segmentId,
      stepId,
      attemptId,
      reservationId,
    };
  }

  const firstSpend = await addCompletedSpend("1112645", 1, -1);
  const secondSpend = await addCompletedSpend("1093827", 6, 4);
  const candidateInput = { userId, receiveSessionId: sessionId, limit: 10 };
  assert.equal(
    (await listFundingReceiveSpentReviewCandidates(client, candidateInput))
      .length,
    0,
    "completed status without a finalized source receipt is insufficient",
  );

  for (const [index, spend] of [firstSpend, secondSpend].entries()) {
    await client.query(
      `insert into funding_step_receipt_observations (
         operation_id, step_id, attempt_id, network_id, status,
         action_match, canonical, ledger_height, first_seen_at, observed_at, finalized_at,
         evidence
       ) values ($1, $2, $3, $4, 'finalized', true, true,
         $5, $6, $6, $6, $7::jsonb)`,
      [
        spend.operationId,
        spend.stepId,
        spend.attemptId,
        networkId,
        index === 0 ? "449675591" : "449676815",
        stamp(index === 0 ? 2 : 7),
        JSON.stringify({ transactionSignature: `synthetic_spend_${index}` }),
      ],
    );
  }
  const nonDebit = await addCompletedSpend("100000", 8, 7, "signature");
  await client.query(
    `insert into funding_step_receipt_observations (
       operation_id, step_id, attempt_id, network_id, status,
       action_match, canonical, ledger_height, first_seen_at, observed_at,
       finalized_at, evidence
     ) values ($1, $2, $3, $4, 'finalized', true, true,
       '449676850', $5, $5, $5, $6::jsonb)`,
    [
      nonDebit.operationId,
      nonDebit.stepId,
      nonDebit.attemptId,
      networkId,
      stamp(9),
      JSON.stringify({ transactionSignature: "synthetic_non_debit" }),
    ],
  );
  const candidates = await listFundingReceiveSpentReviewCandidates(
    client,
    candidateInput,
  );
  assert.deepEqual(
    candidates.map(({ sourceRaw }) => sourceRaw),
    ["2000000", "210731"],
  );
  assert.ok(
    candidates.every(({ spentSlot }) => spentSlot === "449676815"),
    "a newer finalized non-debit step must not become source proof",
  );
  await client.query("savepoint impossible_credit_slots");
  await client.query(
    `insert into funding_receive_canonical_events (
       network_id, asset_id, asset_decimals, destination_address,
       source_address, raw_amount, tx_hash, event_index, ledger_height,
       block_hash, observed_at
     ) values ($1, $2, 6, $3, 'synthetic-later-sender', 1,
       $4, '0', 9999999999999999999, $5, $6)`,
    [
      networkId,
      assetId,
      address,
      `0x${"ce".repeat(32)}`,
      `0x${"cf".repeat(32)}`,
      stamp(8),
    ],
  );
  await client.query(
    `insert into funding_observations (
       operation_id, segment_id, kind, network_id, asset_id, asset_decimals,
       tx_hash, event_index, to_address, raw_amount, ledger_height,
       observed_at, finality_status, finalized_at
     ) values ($1, $2, 'source_credit', $3, $4, 6, $5, '0', $6,
       '1', '9999999999999999999', $7, 'finalized', $7)`,
    [
      firstSpend.operationId,
      firstSpend.segmentId,
      networkId,
      assetId,
      `0x${"cd".repeat(32)}`,
      address,
      stamp(8),
    ],
  );
  assert.deepEqual(
    (await listFundingReceiveSpentReviewCandidates(client, candidateInput)).map(
      ({ requiredFinalizedSlot }) => requiredFinalizedSlot,
    ),
    ["449676815", "449676815"],
    "impossible historical slot values cannot poison a current RPC minimum slot",
  );
  await client.query("rollback to savepoint impossible_credit_slots");
  await client.query("savepoint malformed_spent_slot");
  await client.query(
    `update funding_step_receipt_observations
        set ledger_height='malformed-slot'
      where operation_id=$1 and status='finalized'`,
    [secondSpend.operationId],
  );
  assert.deepEqual(
    (await listFundingReceiveSpentReviewCandidates(client, candidateInput)).map(
      ({ sourceRaw }) => sourceRaw,
    ),
    ["2000000"],
    "malformed historical slot text is ignored without aborting the repair query",
  );
  await client.query("rollback to savepoint malformed_spent_slot");
  await client.query("savepoint receipt_review_fairness");
  const firstPage = await listFundingReceiveSpentReviewCandidates(client, {
    ...candidateInput,
    limit: 1,
  });
  assert.equal(firstPage[0]?.sourceRaw, "2000000");
  const firstPageReceipt = firstPage[0];
  assert.ok(firstPageReceipt);
  await markFundingReceiveSpentReviewCandidatesChecked(client, {
    userId,
    receiveSessionId: sessionId,
    receiptIds: [firstPageReceipt.receiptId],
    now,
  });
  const nextPage = await listFundingReceiveSpentReviewCandidates(client, {
    ...candidateInput,
    limit: 1,
  });
  assert.equal(
    nextPage[0]?.sourceRaw,
    "210731",
    "an unresolvable old receipt must not starve the next eligible receipt",
  );
  await client.query("rollback to savepoint receipt_review_fairness");
  const firstCandidate = candidates[0];
  const secondCandidate = candidates[1];
  assert.ok(firstCandidate);
  assert.ok(secondCandidate);
  await client.query("savepoint malformed_resolution_slot");
  await client.query(
    `update funding_step_receipt_observations
        set ledger_height='malformed-slot'
      where operation_id=$1 and status='finalized'`,
    [secondSpend.operationId],
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...secondCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676815",
      now,
    }),
    false,
    "a malformed current source receipt cannot be accepted by the resolver",
  );
  await client.query("rollback to savepoint malformed_resolution_slot");
  assert.equal(
    await resolveSpentReviewWithProof(client, {
      ...firstCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676815",
      verifiedDebitRaw: "1",
      verifiedDebitSlot: firstCandidate.spentSlot,
      now,
    }),
    false,
    "a different on-chain debit cannot close the review",
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...firstCandidate,
      sourceRaw: "invalid",
      observedBalanceRaw: "4259",
      observedSlot: "449676815",
      now,
    }),
    false,
    "malformed persisted source amounts never reach a BigInt comparison",
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...firstCandidate,
      observedBalanceRaw: "2000000",
      observedSlot: "449676815",
      now,
    }),
    false,
    "funds still present must remain available for the existing review",
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...firstCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449675591",
      now,
    }),
    false,
    "a balance slot before the latest finalized source spend cannot close a review",
  );

  const activeHold = await client.query<{ id: string }>(
    `insert into balance_reservations (
       user_id, operation_id, segment_id, component_id, location_id,
       network_id, asset_id, asset_decimals, raw_amount, mode,
       state, expires_at
     ) values ($1, $2, $3, 'synthetic_active_hold', $4, $5, $6,
       6, '1093827', 'subtract_available', 'active', $7)
     returning id`,
    [
      userId,
      secondSpend.operationId,
      secondSpend.segmentId,
      locationId,
      networkId,
      assetId,
      new Date(now.getTime() + 60_000),
    ],
  );
  const activeHoldId = activeHold.rows[0]?.id;
  assert.ok(activeHoldId);
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...secondCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676815",
      now,
    }),
    false,
    "an active reservation must not be automatically written off",
  );
  await client.query("savepoint finalized_stale_hold");
  await client.query(
    `insert into funding_observations (
       operation_id, segment_id, kind, network_id, asset_id, asset_decimals,
       tx_hash, event_index, to_address, raw_amount,
       observed_at, finality_status, finalized_at
     ) values ($1, $2, 'source_debit', $3, $4, 6, $5, '0', $6,
       '1093827', $7, 'finalized', $7)`,
    [
      secondSpend.operationId,
      secondSpend.segmentId,
      networkId,
      assetId,
      `0x${"ef".repeat(32)}`,
      address,
      stamp(7),
    ],
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...secondCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676815",
      now,
    }),
    true,
    "a stale active reservation with a finalized canonical debit is no longer a physical hold",
  );
  await client.query("rollback to savepoint finalized_stale_hold");
  await client.query(
    `update balance_reservations set state='released', released_at=$2,
       outcome_reason='synthetic_hold_released' where id=$1`,
    [activeHoldId, now],
  );

  await client.query(
    `update funding_receive_receipts set review_quote_id=$2 where id=$1`,
    [receiptIds[1], secondSpend.quoteId],
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...secondCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676815",
      now,
    }),
    false,
    "an unexpired user review quote must remain actionable",
  );
  await client.query(
    `update funding_receive_receipts set review_quote_id=null where id=$1`,
    [receiptIds[1]],
  );

  await client.query(
    `insert into funding_receive_canonical_events (
       network_id, asset_id, asset_decimals, destination_address,
       source_address, raw_amount, tx_hash, event_index, ledger_height,
       block_hash, observed_at
     ) values ($1, $2, 6, $3, $4, 1,
       $5, '0', 449676900, $6, $7)`,
    [
      networkId,
      assetId,
      address,
      "synthetic-later-sender",
      `0x${"cc".repeat(32)}`,
      `0x${"dd".repeat(32)}`,
      stamp(8),
    ],
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...firstCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676815",
      now,
    }),
    false,
    "a later known wallet credit invalidates a pre-credit balance proof",
  );
  const afterCredit = await listFundingReceiveSpentReviewCandidates(
    client,
    candidateInput,
  );
  assert.deepEqual(
    afterCredit.map(({ requiredFinalizedSlot }) => requiredFinalizedSlot),
    ["449676900", "449676900"],
  );

  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...firstCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676900",
      now,
    }),
    true,
  );
  await client.query(
    `update funding_receive_sessions
       set status='expired', expires_at=$2, observe_until=$3,
           closed_at=$2, last_spent_review_checked_at=$4
     where id=$1`,
    [sessionId, stamp(10), stamp(20), observedAt],
  );
  // A backlog of otherwise eligible old reviews without a finalized spend
  // must not consume the single chain-proof slot ahead of actionable work.
  const noSpendAddress = "11111111111111111111111111111111";
  const noSpendVariants = variants.map((entry) => ({
    ...entry,
    destinationAddress: noSpendAddress,
    destinationLocationId: "location_no_spend_synthetic",
  }));
  await client.query(
    `insert into funding_receive_sessions (
       id, user_id, status, owner_channel, venue_id,
       destination_option_id, venue_binding_option_id, destination_asset,
       destination_target_snapshot, venue_binding_snapshot, funding_methods,
       receive_targets, observation_variants, observation_start_variants,
       automation_policy, policy_version, policy_revision, ownership_revision,
       opened_at, expires_at, observe_until, closed_at, created_at, updated_at
     )
     select gen_random_uuid(), $1, 'expired', 'web', 'polymarket',
            'synthetic_destination_' || synthetic_index::text,
            'synthetic_binding_' || synthetic_index::text,
            $2::jsonb, '{}'::jsonb, '{}'::jsonb, '[{}]'::jsonb,
            '[{}]'::jsonb, $3::jsonb, $3::jsonb,
            '{"stableConversion":"automatic_within_caps","volatileConversion":"review_required","maximumFeeUsd":"10","maximumFeeBps":2000,"maximumSlippageBps":100}'::jsonb,
            1, 'synthetic_policy_v1', 'synthetic_ownership_v1',
            $4, $5, $6, $5, $4, $4
       from generate_series(1, 26) as synthetic_index`,
    [
      userId,
      JSON.stringify({
        networkId: "evm:137",
        assetId: "0x0000000000000000000000000000000000000001",
        decimals: 6,
      }),
      JSON.stringify(noSpendVariants),
      observedAt,
      stamp(10),
      stamp(20),
    ],
  );
  const backlogReceipts = await client.query(
    `insert into funding_receive_receipts (
       id, receive_session_id, user_id, variant_id, network_id, asset_id,
       asset_decimals, destination_address, raw_amount, observation_revision,
       tx_hash, event_index, ledger_height, block_hash, observed_at,
       status, handling, routing_disposition, routing_last_error_code,
       evidence, created_at, updated_at
     )
     select gen_random_uuid(), receive_session.id, $1, 'synthetic_sol_usdc',
            $2, $3, 6, $4, 1000000,
            'synthetic_no_spend_' || receive_session.id::text,
            '0x' || lpad(replace(receive_session.id::text, '-', ''), 64, '0'),
            '0', 449675317, '0x' || repeat('cc', 32), $5,
            'review_required', 'automatic_conversion', 'review_required',
            'economic_review_required',
            '{"reviewQuotePlan":{"confirmedSourceAmount":{"raw":"1000000"}}}'::jsonb,
            $5, $5
       from funding_receive_sessions receive_session
      where receive_session.user_id=$1
        and receive_session.destination_option_id like
            'synthetic_destination_%'`,
    [userId, networkId, assetId, noSpendAddress, observedAt],
  );
  assert.equal(backlogReceipts.rowCount, 26);
  await client.query("savepoint before_observation_grace_ends");
  const earlyReviews = await claimExpiredFundingReceiveSpentReviews(client, {
    limit: 5,
    minimumPollIntervalMs: 300_000,
    now: stamp(15),
  });
  assert.deepEqual(
    earlyReviews.map((entry) => entry.session.receiveSessionId),
    [sessionId],
    "a proven source spend is eligible after expiry while late-deposit observation continues",
  );
  await client.query("rollback to savepoint before_observation_grace_ends");
  const oldReviews = await claimExpiredFundingReceiveSpentReviews(client, {
    limit: 5,
    minimumPollIntervalMs: 300_000,
    now,
  });
  assert.deepEqual(
    oldReviews.map((entry) => entry.session.receiveSessionId),
    [sessionId],
    "a review is claimable without walking unrelated terminal sessions",
  );
  assert.equal(
    (
      await claimExpiredFundingReceiveSpentReviews(client, {
        limit: 5,
        minimumPollIntervalMs: 300_000,
        now,
      })
    ).length,
    0,
    "the expired-review lane is bounded by its own retry interval",
  );
  let verifiedCandidates = 0;
  const reviewObserver = new FundingReceiveSessionObserver({
    verifyFinalizedSourceDebit: async () => {
      verifiedCandidates += 1;
      return false;
    },
  });
  const separateReviewJob = await reviewObserver.pollSpentReviewBatch(
    client as unknown as typeof pool,
    {
      now: new Date(now.getTime() + 61_000),
    },
  );
  assert.deepEqual(separateReviewJob, {
    sessionsPolled: 1,
    resolved: 0,
    retryableErrors: 0,
  });
  assert.equal(
    verifiedCandidates,
    1,
    "the independent review job is bounded to one candidate per run",
  );
  await client.query(
    `update funding_receive_receipts
        set last_inventory_review_checked_at = $3
      where user_id = $1 and destination_address = $2`,
    [userId, noSpendAddress, new Date(now.getTime() + 2 * 60 * 60_000)],
  );
  const spentChecked = await client.query<{ id: string }>(
    `select id from funding_receive_receipts
      where id = any($1::uuid[])
        and last_spent_review_checked_at >= $2`,
    [receiptIds, new Date(now.getTime() + 61_000)],
  );
  assert.equal(spentChecked.rows.length, 1);
  const inventoryAfterUnprovableSpend =
    await claimExpiredFundingReceiveInventoryReviews(client, {
      limit: 5,
      minimumPollIntervalMs: 60 * 60_000,
      now: new Date(now.getTime() + 61_000),
    });
  assert.ok(
    inventoryAfterUnprovableSpend.some(
      ({ receiptId }) => receiptId === spentChecked.rows[0]?.id,
    ),
    "an unprovable spent review cannot postpone finalized inventory repair",
  );
  await client.query("savepoint terminal_receive_revision");
  const terminalBefore = await client.query<{ version: string }>(
    `select version from funding_receive_sessions where id=$1`,
    [sessionId],
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...secondCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676900",
      now,
    }),
    true,
  );
  const terminalAfter = await client.query<{
    status: string;
    version: string;
  }>(`select status, version from funding_receive_sessions where id=$1`, [
    sessionId,
  ]);
  assert.equal(terminalAfter.rows[0]?.status, "expired");
  assert.equal(
    BigInt(terminalAfter.rows[0]?.version ?? "0"),
    BigInt(terminalBefore.rows[0]?.version ?? "0") + 1n,
    "an expired receive review must wake durable Telegram projections",
  );
  await client.query("rollback to savepoint terminal_receive_revision");
  await client.query(
    `update funding_receive_sessions
       set status='review_required', expires_at=$2, observe_until=$3,
           closed_at=null
     where id=$1`,
    [sessionId, stamp(60), stamp(120)],
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...secondCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676900",
      now,
    }),
    true,
  );
  const state = await client.query<{
    status: string;
    routing_disposition: string;
  }>(
    `select status, routing_disposition from funding_receive_receipts
     where receive_session_id=$1 order by raw_amount desc`,
    [sessionId],
  );
  assert.deepEqual(state.rows, [
    { status: "recovery_required", routing_disposition: "recovery_required" },
    { status: "recovery_required", routing_disposition: "recovery_required" },
  ]);
  const session = await client.query<{ status: string }>(
    `select status from funding_receive_sessions where id=$1`,
    [sessionId],
  );
  assert.equal(
    session.rows[0]?.status,
    "recovery_required",
    "an unconverted receipt must remain readable and non-ready in older clients",
  );
  assert.equal(
    await resolveFundingReceiveSpentReviewInTransaction(client, {
      ...firstCandidate,
      observedBalanceRaw: "4259",
      observedSlot: "449676815",
      now,
    }),
    false,
    "resolved reviews are idempotent",
  );
  await client.query("rollback");

  // Re-create only the lock boundary as committed fixture data. A user review
  // can hold the receipt before requesting the receive-scope lock; the
  // background repair must skip that receipt rather than wait while holding
  // the scope and form a deadlock cycle.
  await client.query("begin");
  await client.query(
    `insert into users (id, email, is_active, is_verified)
     values ($1, $2, true, true)`,
    [userId, `spent-review-lock-${userId}@example.com`],
  );
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
       'synthetic_destination', 'synthetic_binding', $3::jsonb,
       '{}'::jsonb, '{}'::jsonb, '[{}]'::jsonb,
       '[{}]'::jsonb, $4::jsonb, $4::jsonb,
       '{"stableConversion":"automatic_within_caps","volatileConversion":"review_required","maximumFeeUsd":"10","maximumFeeBps":2000,"maximumSlippageBps":100}'::jsonb,
       1, 'synthetic_policy_v1', 'synthetic_ownership_v1',
       $5, $6, $7, $5, $5
     )`,
    [
      sessionId,
      userId,
      JSON.stringify({
        networkId: "evm:137",
        assetId: "0x0000000000000000000000000000000000000001",
        decimals: 6,
      }),
      JSON.stringify(variants),
      observedAt,
      stamp(60),
      stamp(120),
    ],
  );
  await client.query(
    `insert into funding_receive_receipts (
       id, receive_session_id, user_id, variant_id, network_id, asset_id,
       asset_decimals, destination_address, raw_amount,
       observation_revision, tx_hash, event_index, ledger_height,
       block_hash, observed_at, status, handling, routing_disposition,
       routing_last_error_code, evidence, created_at, updated_at
     ) values (
       $1, $2, $3, 'synthetic_sol_usdc', $4, $5,
       6, $6, 2000000, 'synthetic_lock_observation',
       $7, '0', 449675317, $8, $9,
       'review_required', 'automatic_conversion', 'review_required',
       'child_operation_failed_before_broadcast', $10::jsonb, $9, $9
     )`,
    [
      firstCandidate.receiptId,
      sessionId,
      userId,
      networkId,
      assetId,
      address,
      `0x${"ee".repeat(32)}`,
      `0x${"ff".repeat(32)}`,
      observedAt,
      JSON.stringify({
        reviewQuotePlan: { confirmedSourceAmount: { raw: "2000000" } },
      }),
    ],
  );
  await client.query("commit");
  let competingClient: typeof client | null = null;
  try {
    competingClient = await pool.connect();
    await client.query("begin");
    await client.query(
      `select id from funding_receive_receipts where id=$1 for update`,
      [firstCandidate.receiptId],
    );
    await competingClient.query("begin");
    await competingClient.query("set local statement_timeout='3000ms'");
    assert.equal(
      await resolveSpentReviewWithProof(competingClient, {
        ...firstCandidate,
        observedBalanceRaw: "4259",
        observedSlot: "449676815",
        verifiedDebitRaw: firstCandidate.spentRaw,
        verifiedDebitSlot: firstCandidate.spentSlot,
        now,
      }),
      false,
      "repair skips a user-locked receipt instead of waiting with the scope lock",
    );
  } finally {
    try {
      if (competingClient) await competingClient.query("rollback");
    } finally {
      competingClient?.release();
      await client.query("rollback");
    }
    await client.query("begin");
    // This test-only disposable DB fixture is committed solely to exercise
    // cross-connection locking. Production receipt identity forbids DELETE;
    // transaction-local replica mode permits exact fixture cleanup and resets
    // automatically at COMMIT/ROLLBACK.
    await client.query("set local session_replication_role = 'replica'");
    await client.query("delete from funding_receive_receipts where id=$1", [
      firstCandidate.receiptId,
    ]);
    await client.query("delete from funding_receive_sessions where id=$1", [
      sessionId,
    ]);
    await client.query("delete from users where id=$1", [userId]);
    await client.query("commit");
  }
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
