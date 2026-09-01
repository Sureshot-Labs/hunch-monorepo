#!/usr/bin/env tsx

// @api-integration

import assert from "node:assert/strict";
import crypto from "node:crypto";

import "../../../integration-test-database-guard.js";
import { pool, type DbQuery } from "../../../db.js";
import { SOLANA_NATIVE_ASSET } from "../../domain/network-fees.js";
import type { DirectIngressObservationVariant } from "../../reconciliation/direct-ingress-observer.js";
import type { FundingReceiveCanonicalEvent } from "../../receive/canonical-receive-event-scanner.js";
import { recordCanonicalReceiveDepositNotification } from "../../receive/receive-deposit-notification.js";
import { handlePrivyDepositWebhook } from "../../../services/deposit-events.js";

type TelegramBuyContextFixture = Readonly<{
  receiveSessionId: string;
  variantId: string;
}>;

async function createTelegramBuyContext(
  input: Readonly<{
    client: DbQuery;
    userId: string;
    telegramAccountId: string;
    marketId: string;
    wallet: string;
    suffix: string;
    readyTransactionHash?: string;
  }>,
): Promise<TelegramBuyContextFixture> {
  const receiveSessionId = crypto.randomUUID();
  const fundingContextId = crypto.randomUUID();
  const variantId = `por10-sol-variant-${input.suffix}`;
  const destinationOptionId = `por10-destination-${input.suffix}`;
  const venueBindingOptionId = `por10-binding-${input.suffix}`;
  const fixtureNow = Date.now();
  const expiresAt = new Date(fixtureNow + 86_400_000);
  const observeUntil = new Date(fixtureNow + 8 * 86_400_000);
  const observationVariants = [
    {
      variantId,
      networkId: SOLANA_NATIVE_ASSET.networkId,
      asset: SOLANA_NATIVE_ASSET,
      destinationAddress: input.wallet,
      destinationLocationId: `por10-location-${input.suffix}`,
      baselineRaw: "0",
      baselineRevision: `por10-baseline-${input.suffix}`,
      observation: {
        adapterId: "owned_wallet_liquid_balances_v1",
        payload: {
          eventCursorSlot: "443167474",
          eventConfirmations: 1,
          eventIdentity: "solana_transfer_v1",
        },
      },
      completion: { kind: "retained_owned_source_credit" },
    },
  ];

  await input.client.query(
    `
      insert into funding_receive_sessions (
        id, user_id, status, venue_id, destination_option_id,
        venue_binding_option_id, destination_asset,
        destination_target_snapshot, venue_binding_snapshot, funding_methods,
        receive_targets, observation_variants, automation_policy,
        policy_version, policy_revision, ownership_revision, version,
        expires_at, observe_until, observation_start_variants, owner_channel
      ) values (
        $1::uuid, $2::uuid, 'open', 'limitless', $3, $4,
        $5::jsonb, '{}'::jsonb, '{}'::jsonb, '[{}]'::jsonb,
        '[{}]'::jsonb, $6::jsonb, $7::jsonb, 1, $8, $9, 1,
        $10::timestamptz, $11::timestamptz, $6::jsonb, 'telegram'
      )
    `,
    [
      receiveSessionId,
      input.userId,
      destinationOptionId,
      venueBindingOptionId,
      JSON.stringify({
        networkId: "evm:8453",
        assetId: "0x0000000000000000000000000000000000000001",
        decimals: 6,
      }),
      JSON.stringify(observationVariants),
      JSON.stringify({
        maximumFeeBps: 500,
        maximumFeeUsd: "1",
        maximumSlippageBps: 100,
        stableConversion: "automatic_within_caps",
        volatileConversion: "review_required",
      }),
      `por10-policy-${input.suffix}`,
      `por10-ownership-${input.suffix}`,
      expiresAt,
      observeUntil,
    ],
  );
  await input.client.query(
    `
      insert into telegram_funding_sessions (
        id, user_id, telegram_account_id, telegram_user_id, chat_id,
        telegram_message_id, receive_session_id, origin, market_id, side,
        requested_spend_usd, idempotency_key, expires_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4, $4, 1, $5::uuid,
        'buy_return_context', $6, 'YES', 1, $7, $8::timestamptz
      )
    `,
    [
      fundingContextId,
      input.userId,
      input.telegramAccountId,
      `por10-telegram-${input.suffix}`,
      receiveSessionId,
      input.marketId,
      `por10-context-${input.suffix}`,
      expiresAt,
    ],
  );
  await input.client.query(
    `
      insert into telegram_funding_buy_return_revisions (
        telegram_funding_session_id, revision, parent_revision,
        telegram_account_id_snapshot, market_id, side, requested_spend_usd,
        source_authority_fingerprint, venue_id, destination_option_id,
        venue_binding_option_id, request_fingerprint, continuation_mode
      ) values (
        $1::uuid, 1, null, $2::uuid, $3, 'YES', 1, $4,
        'limitless', $5, $6, $7, 'app_handoff'
      )
    `,
    [
      fundingContextId,
      input.telegramAccountId,
      input.marketId,
      `por10-authority-${input.suffix}`,
      destinationOptionId,
      venueBindingOptionId,
      `por10-request-${input.suffix}`,
    ],
  );
  await input.client.query(
    `
      insert into telegram_funding_consents (
        telegram_funding_session_id, revision, selected_receive_target_id,
        selected_asset_network_id, selected_asset_id,
        selected_asset_decimals, consented_variant_ids, automation_enabled,
        max_auto_execute_source_raw, automation_policy_snapshot,
        consent_fingerprint
      ) values (
        $1::uuid, 1, $2, 'solana:mainnet', $3, 9,
        array[$4]::text[], false, null, '{}'::jsonb, $5
      )
    `,
    [
      fundingContextId,
      `por10-target-${input.suffix}`,
      SOLANA_NATIVE_ASSET.assetId,
      variantId,
      `por10-consent-${input.suffix}`,
    ],
  );
  await input.client.query(
    `
      update telegram_funding_sessions
      set active_buy_return_revision = 1,
          active_consent_revision = 1
      where id = $1::uuid
    `,
    [fundingContextId],
  );
  if (input.readyTransactionHash) {
    await input.client.query(
      `
        insert into funding_receive_receipts (
          receive_session_id, user_id, variant_id, network_id, asset_id,
          asset_decimals, destination_address, raw_amount,
          observation_revision, tx_hash, event_index, ledger_height,
          block_hash, observed_at, status, handling, evidence
        ) values (
          $1::uuid, $2::uuid, $3, 'solana:mainnet', $4, 9, $5,
          30000000, $6, $7, 'outer:2', 443167475,
          'por10-integration-block-hash', now(), 'ready', 'direct',
          jsonb_build_object('transactionHash', $7::text)
        )
      `,
      [
        receiveSessionId,
        input.userId,
        variantId,
        SOLANA_NATIVE_ASSET.assetId,
        input.wallet,
        `por10-observation-${input.suffix}`,
        input.readyTransactionHash,
      ],
    );
  }
  return { receiveSessionId, variantId };
}

function privyNativeSolDeposit(
  input: Readonly<{
    idempotencyKey: string;
    transactionHash: string;
    wallet: string;
  }>,
): Record<string, unknown> {
  return {
    type: "wallet.funds_deposited",
    wallet_id: "por10-privy-solana-wallet",
    idempotency_key: input.idempotencyKey,
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: { type: "native-token" },
    amount: "30000000",
    transaction_hash: input.transactionHash,
    sender: "7HKfQDSWEktGc6VGcGYi1B7HerHUpLD35aTpF8Q87UQm",
    recipient: input.wallet,
    block: { number: "443167475" },
  };
}

const client = await pool.connect();
try {
  await client.query("begin");
  const user = await client.query<{ id: string }>(
    `
      insert into users (email, is_active, is_verified)
      values ($1, true, true)
      returning id
    `,
    [`por10-${crypto.randomUUID()}@example.com`],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error("POR10 integration user was not created");

  const receiveSessionId = crypto.randomUUID();
  const canonicalEventId = crypto.randomUUID();
  const wallet = "9WAHHmDT2AK8HyYSHY52QbsWGbGNskVv4cbshT5NSgMR";
  const transactionHash =
    "eh9tPN7f8ddy9N1B4ysuh77JGKGT3eKDhwxA9G9sY7PT2deQ1WL1vE4tBaTCMLDZgKZYpdEpUupWoV9mrfBdkbB";
  const variant: DirectIngressObservationVariant = {
    variantId: "ingress_variant_por10_integration",
    networkId: "solana:mainnet",
    asset: SOLANA_NATIVE_ASSET,
    destinationAddress: wallet,
    destinationLocationId: "location_por10_integration",
    baselineRaw: "0",
    baselineRevision: "baseline_por10_integration",
    observation: {
      adapterId: "owned_wallet_liquid_balances_v1",
      payload: {
        eventCursorSlot: "443167474",
        eventConfirmations: 1,
        eventIdentity: "solana_transfer_v1",
      },
    },
    completion: { kind: "retained_owned_source_credit" },
  };
  const event: FundingReceiveCanonicalEvent = {
    variant,
    transactionHash,
    eventIndex: "outer:2",
    blockNumber: "443167475",
    blockHash: "por10-integration-block-hash",
    sourceAddress: "7HKfQDSWEktGc6VGcGYi1B7HerHUpLD35aTpF8Q87UQm",
    destinationAddress: wallet,
    rawAmount: "30000000",
    observedAt: "2026-08-31T13:53:10.000Z",
  };
  const input = {
    receiveSessionId,
    userId,
    ownerChannel: "telegram" as const,
    variant,
    event,
    canonicalEventId,
    now: new Date("2026-09-01T01:00:00.000Z"),
  };

  assert.equal(
    await recordCanonicalReceiveDepositNotification(client, input),
    "created",
  );
  assert.equal(
    await recordCanonicalReceiveDepositNotification(client, input),
    "deduplicated",
  );

  const notifications = await client.query<{
    body: string;
    count: string;
    data: Record<string, unknown>;
  }>(
    `
      select
        count(*) over ()::text as count,
        body,
        data
      from notifications
      where user_id = $1::uuid
        and type = 'deposit_received'
    `,
    [userId],
  );
  assert.equal(notifications.rows[0]?.count, "1");
  assert.equal(
    notifications.rows[0]?.body,
    "0.03 SOL deposit received on Solana",
  );
  assert.equal(notifications.rows[0]?.data.amountRaw, "30000000");
  assert.equal(notifications.rows[0]?.data.txHash, transactionHash);
  assert.equal(notifications.rows[0]?.data.receiveSessionId, receiveSessionId);

  await client.query(
    `
      insert into user_wallets (
        user_id, wallet_address, wallet_type, is_primary, is_verified
      ) values ($1::uuid, $2, 'solana', true, true)
    `,
    [userId, wallet],
  );
  const telegramAccountId = crypto.randomUUID();
  await client.query(
    `
      insert into user_telegram_accounts (
        id, user_id, privy_user_id, telegram_user_id, username
      ) values ($1::uuid, $2::uuid, $3, $4, $5)
    `,
    [
      telegramAccountId,
      userId,
      `did:privy:por10-${crypto.randomUUID()}`,
      `por10-telegram-${crypto.randomUUID()}`,
      `por10-${crypto.randomUUID()}`,
    ],
  );
  const eventId = `por10-event-${crypto.randomUUID()}`;
  const marketId = `por10-market-${crypto.randomUUID()}`;
  await client.query(
    `
      insert into unified_events (
        id, venue, venue_event_id, title, status, end_date
      ) values (
        $1, 'limitless', $2, 'POR10 integration event', 'ACTIVE',
        now() + interval '2 days'
      )
    `,
    [eventId, eventId],
  );
  await client.query(
    `
      insert into unified_markets (
        id, venue, venue_market_id, event_id, title, status, market_type,
        close_time, expiration_time, outcomes, clob_token_ids, metadata
      ) values (
        $1, 'limitless', $2, $3, 'POR10 integration market', 'ACTIVE',
        'binary', now() + interval '1 day', now() + interval '2 days',
        '["Yes","No"]'::jsonb, '["por10-yes","por10-no"]'::jsonb,
        '{}'::jsonb
      )
    `,
    [marketId, marketId, eventId],
  );

  const pendingTransactionHash =
    "4ewXNzyP1VPkxj6pLYGqH1bJBVuo1sJQGU4GKSoXLQp5D5pHZ1VCVRnsyn7UmPaY";
  await createTelegramBuyContext({
    client,
    userId,
    telegramAccountId,
    marketId,
    wallet,
    suffix: "pending-one",
  });
  const pendingResult = await handlePrivyDepositWebhook(
    client,
    privyNativeSolDeposit({
      idempotencyKey: "por10-privy-pending-one",
      transactionHash: pendingTransactionHash,
      wallet,
    }),
  );
  assert.equal(pendingResult.status, "ignored_funding");

  const exactTransactionHash =
    "5AqEJ8tvTozAKWDSXDYKjC5DhiQf7wYVYAuRwMJBpE8XrMeusisnUrRWLHzovFJp";
  await createTelegramBuyContext({
    client,
    userId,
    telegramAccountId,
    marketId,
    wallet,
    suffix: "ready-exact",
    readyTransactionHash: exactTransactionHash,
  });
  const exactResult = await handlePrivyDepositWebhook(
    client,
    privyNativeSolDeposit({
      idempotencyKey: "por10-privy-ready-exact",
      transactionHash: exactTransactionHash,
      wallet,
    }),
  );
  assert.equal(exactResult.status, "ignored_funding");

  await createTelegramBuyContext({
    client,
    userId,
    telegramAccountId,
    marketId,
    wallet,
    suffix: "pending-two",
  });
  const ambiguousTransactionHash =
    "3N6CqPWdgjBJPbgJ3rJCHNzc4UeMSjYJSSAMnwhmYFVSZN2x9Bn6z3WvP5fLZJ4U";
  const ambiguousIdempotencyKey = "por10-privy-pending-ambiguous";
  const seedNotification = await client.query<{ id: string }>(
    `
      insert into notifications (
        user_id, type, title, body, severity, data, dedupe_key
      ) values (
        $1::uuid, 'deposit_received', 'Seed', 'Seed', 'success',
        '{}'::jsonb, $2
      )
      returning id
    `,
    [userId, `por10-seed-${crypto.randomUUID()}`],
  );
  const ambiguousPayload = privyNativeSolDeposit({
    idempotencyKey: ambiguousIdempotencyKey,
    transactionHash: ambiguousTransactionHash,
    wallet,
  });
  await client.query(
    `
      insert into deposit_events (
        source, source_event_type, source_idempotency_key, privy_wallet_id,
        user_id, wallet_address, wallet_type, caip2, asset, amount_raw,
        transaction_hash, sender, recipient, status, notification_id, payload
      ) values (
        'privy', 'wallet.funds_deposited', $1, 'por10-privy-solana-wallet',
        $2::uuid, $3, 'solana',
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        '{"type":"native-token"}'::jsonb, '30000000', $4, $5, $3,
        'notified', $6::uuid, $7::jsonb
      )
    `,
    [
      ambiguousIdempotencyKey,
      userId,
      wallet,
      ambiguousTransactionHash,
      "7HKfQDSWEktGc6VGcGYi1B7HerHUpLD35aTpF8Q87UQm",
      seedNotification.rows[0]?.id,
      JSON.stringify(ambiguousPayload),
    ],
  );
  const ambiguousResult = await handlePrivyDepositWebhook(
    client,
    ambiguousPayload,
  );
  assert.equal(ambiguousResult.status, "notified");
  const ambiguousDeposit = await client.query<{ status: string }>(
    `
      select status
      from deposit_events
      where source = 'privy'
        and source_idempotency_key = $1
    `,
    [ambiguousIdempotencyKey],
  );
  assert.equal(ambiguousDeposit.rows[0]?.status, "notified");
} finally {
  await client.query("rollback");
  client.release();
}

console.log("[funding-receive-notification-integration-tests] complete");
