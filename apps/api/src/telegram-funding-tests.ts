#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stableWalletOpaqueId } from "./account-value/canonical.js";
import { listFundingReceiveReceiptsForRouting } from "./funding/persistence/funding-receive-session-repository.js";
import { fundingSidecarRuntimeConfig } from "./funding/runtime/sidecar-runtime-config.js";
import { compileFundingIntentPolicy } from "./funding/policies/funding-policy-v2.js";
import { RELAY_PINNED_ASSETS } from "./funding-providers/relay/mappings.js";
import { isFundingReconciliationSchemaReady } from "./funding/worker/funding-reconciliation-worker.js";
import { isTelegramFundingReceiveControllerCurrent } from "./funding/execution/telegram-funding-managed-wallet.js";
import { parseTelegramRelayEvmAutomationPolicyV3 } from "./funding/execution/telegram-funding-automation-policy.js";
import { resolveFundingReceiveSelectedTargetId } from "./funding/receive/receive-session-service.js";
import type {
  FundingQuoteSummary,
  FundingReceiveReceipt,
  FundingReceiveSession,
} from "./funding/domain/types.js";
import type { FundingReceiveReceiptRoutingTarget } from "./funding/persistence/funding-receive-session-repository.js";
import type { DirectIngressObservationVariant } from "./funding/reconciliation/direct-ingress-observer.js";
import {
  parseTelegramFundingCallbackRoute,
  telegramFundingCallbackData,
  type TelegramFundingMessage,
  type TelegramFundingProgressProjection,
} from "./services/telegram-funding-contracts.js";
import {
  buildTelegramFundingChangeBuyAmountButton,
  buildTelegramFundingReviewBuyButton,
  resolveTelegramFundingBuyContinuationAdapter,
  resolveTelegramFundingBuyContinuationCapability,
} from "./services/telegram-funding-buy-continuation.js";
import {
  buildTelegramFundingActiveElsewhereMessage,
  buildTelegramFundingBuyReturnAttachedMessage,
  buildTelegramFundingDeliveryQueuedMessage,
  buildTelegramFundingProgressMessage,
  buildTelegramFundingReviewQuoteMessage,
  buildTelegramFundingTargetMessage,
} from "./services/telegram-funding-presentation.js";
import {
  parseTelegramFundingProgressProjection,
  projectTelegramFundingProgress,
  projectTelegramFundingUnavailable,
  telegramFundingProgressFingerprint,
} from "./services/telegram-funding-progress.js";
import type {
  TelegramFundingConsent,
  TelegramFundingSessionContext,
} from "./services/telegram-funding-sessions.js";
import {
  fetchActiveTelegramFundingReviewResponse,
  finalizeSupersededTelegramFundingSessionInTransaction,
  lockActiveTelegramFundingReviewByConsentToken,
  lockActiveTelegramFundingReviewTarget,
  prepareTelegramFundingSessionOpenInTransaction,
  recordTelegramFundingReviewMutation,
  reuseActiveTelegramFundingSession,
  TelegramFundingPersistenceError,
} from "./services/telegram-funding-sessions.js";
import {
  classifyTelegramRelayFrozenCapability,
  relayEvmFrozenConsentConfiguration,
  resolveTelegramFundingReceiptDisposition,
  telegramFundingRouteDescriptorForChoiceToken,
  telegramFundingRouteDescriptorForRouteKey,
  telegramSolanaRetainedDepositRouteForPolicy,
  telegramPolygonFundingPresentation,
} from "./services/telegram-funding-route.js";
import {
  buildTelegramFundingBuyReturnRequestFingerprint,
  buildTelegramFundingTargetMessageForSession,
  canAttachTelegramFundingBuyReturn,
  canDiscloseTelegramFundingAddress,
  canonicalTelegramFundingBuySpend,
  loadTelegramFundingReceiveSession,
  resolveTelegramDirectPusdChoice,
  resolveTelegramFundingTargetChoice,
  telegramFundingConsentPresentationMode,
} from "./services/telegram-funding.js";
import {
  createTelegramFundingBuyContinuationDecorator,
  telegramBotTradingTestHooks,
} from "./services/telegram-bot-trading.js";
import {
  createTelegramFundingRenderCoordinator,
  deliverTelegramFundingActions,
  requiresCurrentFundingPolicyForAddressDelivery,
} from "./services/telegram-funding-delivery.js";
import {
  claimSignalBotMenuRender,
  createSignalBotMenuRenderGuard,
} from "./services/telegram-bot-menu-state.js";
import { classifyTelegramEditFailure } from "./services/signal-bot-telegram-client.js";
import {
  drainSignalBotFundingOpenTasks,
  handleSignalBotInteractiveMenuCallback,
} from "./services/telegram-bot-menu-actions.js";
import {
  getDefaultSignalBotPolicy,
  normalizeSignalBotPolicy,
  signalBotSchema,
} from "./services/signal-bot-trading-policy.js";

const contextId = "123e4567-e89b-42d3-a456-426614174000";
const receiveSessionId = "223e4567-e89b-42d3-a456-426614174000";
const reviewReceiptId = "323e4567-e89b-42d3-a456-426614174001";
const receiveTargetId = "receive_target_telegram_pusd_12345678";

{
  const activeElsewhere = buildTelegramFundingActiveElsewhereMessage();
  assert.deepEqual(activeElsewhere.reply_markup?.inline_keyboard, [
    [{ callback_data: "hm:v1:deposit", text: "Open Deposit" }],
    [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
  ]);
  const cancellableElsewhere = buildTelegramFundingActiveElsewhereMessage({
    canCancel: true,
  });
  assert.deepEqual(cancellableElsewhere.reply_markup?.inline_keyboard[1], [
    {
      callback_data: "hm:v1:deposit_cancel_active",
      text: "Cancel active Deposit",
    },
  ]);
}

function supersedeSessionPool(
  receiveCanClose: boolean,
  activeConsentRevision: number | null = null,
  liveRouting = false,
) {
  const statements: string[] = [];
  let openMutation: Record<string, unknown> | null = null;
  const client = {
    query: async (sql: string, parameters?: readonly unknown[]) => {
      const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
      statements.push(normalized);
      if (
        normalized.includes("from telegram_funding_sessions context") &&
        normalized.includes("for update of context, receive")
      ) {
        return {
          rows: [
            {
              active_consent_revision: activeConsentRevision,
              address_delivered_revision: 0,
              address_disclosure_attempt_revision: 0,
              address_disclosure_message_id: null,
              address_redacted_revision: 0,
              cancelled_at: null,
              chat_id: "42",
              created_at: new Date("2026-08-12T11:00:00.000Z"),
              event_id: null,
              expires_at: new Date("2026-08-13T12:00:00.000Z"),
              id: contextId,
              idempotency_key: "old-open",
              last_delivered_revision: 0,
              latest_progress_projection: null,
              latest_terminal_projection: null,
              latest_terminal_revision: null,
              market_id: null,
              origin: "generic_add_funds",
              progress_revision: 0,
              receive_owner_channel: "telegram",
              receive_session_id: receiveSessionId,
              requested_spend_usd: null,
              resume_generation: 0,
              resume_intent_id: null,
              resumed_at: null,
              side: null,
              telegram_account_id: "423e4567-e89b-42d3-a456-426614174000",
              telegram_message_id: "100",
              telegram_user_id: "42",
              updated_at: new Date("2026-08-12T11:00:00.000Z"),
              user_id: "323e4567-e89b-42d3-a456-426614174000",
            },
          ],
        };
      }
      if (
        normalized.startsWith("select exists (") &&
        normalized.includes("from funding_receive_receipts receive_receipt")
      ) {
        return { rows: [{ live_routing: liveRouting }] };
      }
      if (normalized.startsWith("update funding_receive_sessions")) {
        return { rows: receiveCanClose ? [{ id: receiveSessionId }] : [] };
      }
      if (normalized.startsWith("insert into telegram_funding_mutations")) {
        openMutation = {
          action: "open",
          consent_revision: null,
          funding_context_id: String(parameters?.[0]),
          idempotency_key: String(parameters?.[1]),
          request_fingerprint: String(parameters?.[2]),
          response_payload: { fundingContextId: String(parameters?.[0]) },
          review_quote_id: null,
          review_receipt_id: null,
        };
        return { rows: [], rowCount: 1 };
      }
      if (
        normalized.includes("from telegram_funding_mutations") &&
        normalized.includes("where idempotency_key = $1")
      ) {
        return { rows: openMutation ? [openMutation] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client },
    statements,
  };
}

const supersedeInput = {
  userId: "323e4567-e89b-42d3-a456-426614174000",
  telegramAccountId: "423e4567-e89b-42d3-a456-426614174000",
  telegramUserId: "42",
  chatId: "42",
  telegramMessageId: 101,
  venueId: "polymarket",
  idempotencyKey: "open-on-new-message",
  requestFingerprint: "a".repeat(64),
  now: new Date("2026-08-12T12:00:00.000Z"),
} as const;

{
  const fake = supersedeSessionPool(true);
  assert.equal(
    await reuseActiveTelegramFundingSession(fake.pool as never, supersedeInput),
    null,
    "a new menu message supersedes an empty context instead of editing the old screen",
  );
  assert.equal(
    fake.statements.some((sql) => sql.startsWith("update funding_receive")),
    false,
    "the fast preflight is read-only; the final persistence transaction owns supersession",
  );
}

{
  const fake = supersedeSessionPool(true);
  const client = await fake.pool.connect();
  const superseded = await prepareTelegramFundingSessionOpenInTransaction(
    client as never,
    {
      ...supersedeInput,
      destinationOptionId: "polymarket-deposit",
      venueBindingOptionId: "polymarket-wallet",
    },
  );
  assert.equal(superseded?.id, contextId);
  assert.equal(
    fake.statements.some((sql) => sql.startsWith("update funding_receive")),
    true,
  );
  assert.doesNotMatch(
    fake.statements.find((sql) =>
      sql.includes("from telegram_funding_sessions context"),
    ) ?? "",
    /and context\.origin\s*=/u,
    "Deposit and Buy-shortfall contexts must share one message-ownership gate",
  );
}

{
  const fake = supersedeSessionPool(true);
  const client = await fake.pool.connect();
  await assert.rejects(
    prepareTelegramFundingSessionOpenInTransaction(client as never, {
      ...supersedeInput,
      destinationOptionId: "polymarket-deposit",
      telegramMessageId: 99,
      venueBindingOptionId: "polymarket-wallet",
    }),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_session_active_elsewhere",
    "a delayed older card must not supersede the newer active message",
  );
  assert.equal(
    fake.statements.some((sql) => sql.startsWith("update funding_receive")),
    false,
  );
}

{
  const fake = supersedeSessionPool(false);
  const client = await fake.pool.connect();
  await assert.rejects(
    prepareTelegramFundingSessionOpenInTransaction(client as never, {
      ...supersedeInput,
      destinationOptionId: "polymarket-deposit",
      venueBindingOptionId: "polymarket-wallet",
    }),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_session_active_elsewhere",
    "an in-flight context must remain visible instead of being silently replaced",
  );
}

{
  const fake = supersedeSessionPool(true, 1);
  const client = await fake.pool.connect();
  await assert.rejects(
    prepareTelegramFundingSessionOpenInTransaction(client as never, {
      ...supersedeInput,
      destinationOptionId: "polymarket-deposit",
      venueBindingOptionId: "polymarket-wallet",
    }),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_session_active_elsewhere",
    "a consented address remains active until its receive lifecycle ends",
  );
  assert.equal(
    fake.statements.some((sql) => sql.startsWith("update funding_receive")),
    false,
  );
}

{
  const fake = supersedeSessionPool(false, 1, true);
  const presented = await reuseActiveTelegramFundingSession(
    fake.pool as never,
    {
      ...supersedeInput,
      presentAcrossMessages: true,
    },
  );
  assert.equal(presented?.telegramMessageId, 100);
  assert.equal(
    fake.statements.some((sql) =>
      sql.startsWith("update telegram_funding_sessions"),
    ),
    false,
    "a status mirror must not move the address-owning Telegram message",
  );
}

{
  const fake = supersedeSessionPool(false, 1, true);
  const client = await fake.pool.connect();
  const reused = await prepareTelegramFundingSessionOpenInTransaction(
    client as never,
    {
      ...supersedeInput,
      destinationOptionId: "polymarket-deposit",
      reuseActiveContextForBuyReturn: true,
      telegramMessageId: 101,
      venueBindingOptionId: "polymarket-wallet",
    },
  );
  assert.equal(reused?.id, contextId);
  assert.equal(
    reused?.telegramMessageId,
    100,
    "Buy attachment must preserve the earlier funding card as message owner",
  );
  assert.equal(
    fake.statements.some((sql) => sql.startsWith("update funding_receive")),
    false,
    "Buy attachment must not cancel or replace the active receive session",
  );
}

{
  const fake = supersedeSessionPool(true, 1, false);
  const client = await fake.pool.connect();
  const reused = await prepareTelegramFundingSessionOpenInTransaction(
    client as never,
    {
      ...supersedeInput,
      destinationOptionId: "polymarket-deposit",
      reuseActiveContextForBuyReturn: true,
      telegramMessageId: 101,
      venueBindingOptionId: "polymarket-wallet",
    },
  );
  assert.equal(
    reused,
    null,
    "an address or consent without deposited funds must not absorb a new Buy",
  );
}

{
  const fake = supersedeSessionPool(true, 1, false);
  const client = await fake.pool.connect();
  const superseded = await prepareTelegramFundingSessionOpenInTransaction(
    client as never,
    {
      ...supersedeInput,
      destinationOptionId: "polymarket-deposit",
      supersedeInactiveContextForBuyReturn: true,
      telegramMessageId: 101,
      venueBindingOptionId: "polymarket-wallet",
    },
  );
  assert.equal(superseded?.id, contextId);
  assert.equal(
    fake.statements.some((sql) =>
      sql.startsWith("update funding_receive_sessions"),
    ),
    true,
    "an inactive receive shell is retired before a fresh Buy context opens",
  );
}

{
  const fake = supersedeSessionPool(false, 1);
  const client = await fake.pool.connect();
  await assert.rejects(
    prepareTelegramFundingSessionOpenInTransaction(client as never, {
      ...supersedeInput,
      destinationOptionId: "polymarket-deposit",
      reuseActiveContextForBuyReturn: true,
      telegramAccountId: "523e4567-e89b-42d3-a456-426614174000",
      venueBindingOptionId: "polymarket-wallet",
    }),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_session_unavailable",
    "Buy attachment must not cross a Telegram account relink",
  );
}

{
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
      statements.push(normalized);
      parameters.push(values);
      if (normalized.startsWith("update telegram_funding_sessions")) {
        return {
          rows: [
            {
              progress_revision: 1,
              telegram_account_id: "423e4567-e89b-42d3-a456-426614174000",
              telegram_message_id: "100",
              telegram_user_id: "42",
              user_id: "323e4567-e89b-42d3-a456-426614174000",
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await finalizeSupersededTelegramFundingSessionInTransaction(client as never, {
    context: {
      activeConsentRevision: null,
      addressDeliveredRevision: 0,
      addressDisclosureAttemptRevision: 0,
      addressDisclosureMessageId: null,
      addressRedactedRevision: 0,
      cancelledAt: null,
      chatId: "42",
      createdAt: "2026-08-12T11:00:00.000Z",
      initialEventId: null,
      initialMarketId: null,
      initialRequestedSpendUsd: null,
      initialSide: null,
      expiresAt: "2026-08-13T12:00:00.000Z",
      id: contextId,
      lastDeliveredRevision: 0,
      latestProgressProjection: null,
      latestTerminalProjection: null,
      latestTerminalRevision: null,
      origin: "generic_add_funds",
      progressRevision: 0,
      receiveSessionId,
      resumeGeneration: 0,
      resumeIntentId: null,
      resumedAt: null,
      telegramAccountId: "423e4567-e89b-42d3-a456-426614174000",
      telegramMessageId: 100,
      telegramUserId: "42",
      updatedAt: "2026-08-12T11:00:00.000Z",
      userId: "323e4567-e89b-42d3-a456-426614174000",
    },
    fingerprint: "b".repeat(64),
    now: new Date("2026-08-12T12:00:00.000Z"),
    projection: { state: "cancelled", terminal: true },
  });
  assert.equal(statements.length, 4);
  assert.match(statements[0] ?? "", /latest_terminal_projection = \$4::jsonb/u);
  assert.match(statements[1] ?? "", /status in \('pending', 'retry'\)/u);
  assert.match(statements[2] ?? "", /action = 'funding_qr'/u);
  assert.match(statements[3] ?? "", /values \('funding_edit'/u);
  assert.equal(JSON.parse(String(parameters[0]?.[3])).terminal, true);
  assert.equal(parameters[3]?.[4], 1);
}

for (const [label, lock] of [
  [
    "issue",
    (client: never) =>
      lockActiveTelegramFundingReviewTarget(client, {
        receiptId: reviewReceiptId,
        userId: "323e4567-e89b-42d3-a456-426614174000",
        telegramAccountId: "423e4567-e89b-42d3-a456-426614174000",
        telegramUserId: "42",
        telegramMessageId: 100,
        chatId: "42",
        now: new Date("2026-08-05T12:00:00.000Z"),
      }),
  ],
  [
    "commit",
    (client: never) =>
      lockActiveTelegramFundingReviewByConsentToken(client, {
        userId: "323e4567-e89b-42d3-a456-426614174000",
        telegramAccountId: "423e4567-e89b-42d3-a456-426614174000",
        telegramUserId: "42",
        telegramMessageId: 100,
        chatId: "42",
        consentToken: `consent_${"a".repeat(43)}`,
        now: new Date("2026-08-05T12:00:00.000Z"),
      }),
  ],
] as const) {
  let sql = "";
  const target = await lock({
    query: async (statement: string) => {
      sql = statement;
      return {
        rowCount: 1,
        rows: [
          {
            context_id: contextId,
            quote_id:
              label === "issue"
                ? "623e4567-e89b-42d3-a456-426614174000"
                : undefined,
            receipt_id: "523e4567-e89b-42d3-a456-426614174000",
            receive_session_id: receiveSessionId,
            ...(label === "commit"
              ? { quote_id: "623e4567-e89b-42d3-a456-426614174000" }
              : {}),
          },
        ],
      };
    },
  } as never);
  assert.ok(target);
  assert.match(sql, /context\.latest_terminal_projection is null/u);
  assert.match(
    sql,
    /context\.telegram_message_id is not distinct from \$\d::bigint/u,
  );
  assert.match(sql, /context\.cancelled_at is null/u);
  assert.match(sql, /context\.expires_at > \$\d/u);
  assert.match(sql, /for update of context, receive, receipt/u);
  if (label === "issue") {
    assert.equal(
      target.quoteId,
      "623e4567-e89b-42d3-a456-426614174000",
      "review issuance must see the receipt's current quote under the same lock",
    );
  }
}

{
  const quoteId = "623e4567-e89b-42d3-a456-426614174000";
  const requestFingerprint = "review-request-fingerprint-12345678";
  const responsePayload = {
    fundingContextId: contextId,
    parse_mode: "MarkdownV2",
    text: "Exact conversion quote",
  } as const;
  const mutationRow = {
    funding_context_id: contextId,
    action: "review_conversion",
    idempotency_key: "funding:review:exact-replay",
    request_fingerprint: requestFingerprint,
    response_payload: responsePayload,
    consent_revision: null,
    review_receipt_id: reviewReceiptId,
    review_quote_id: quoteId,
  };
  let insertCount = 0;
  const stored = await recordTelegramFundingReviewMutation(
    {
      query: async (statement: string) => {
        if (statement.includes("insert into telegram_funding_mutations")) {
          insertCount += 1;
          return { rowCount: 1, rows: [] };
        }
        if (statement.includes("from telegram_funding_mutations")) {
          return { rowCount: 1, rows: [mutationRow] };
        }
        assert.fail(`unexpected review mutation query: ${statement}`);
      },
    } as never,
    {
      contextId,
      idempotencyKey: mutationRow.idempotency_key,
      quoteId,
      receiptId: reviewReceiptId,
      requestFingerprint,
      responsePayload,
      now: new Date("2026-08-05T12:00:00.000Z"),
    },
  );
  assert.equal(insertCount, 1);
  assert.deepEqual(stored, responsePayload);
  let activeSql = "";
  const activeResponse = await fetchActiveTelegramFundingReviewResponse(
    {
      query: async (statement: string) => {
        activeSql = statement;
        return { rowCount: 1, rows: [mutationRow] };
      },
    } as never,
    {
      contextId,
      quoteId,
      receiptId: reviewReceiptId,
      userId: "323e4567-e89b-42d3-a456-426614174000",
      now: new Date("2026-08-05T12:00:00.000Z"),
    },
  );
  assert.deepEqual(activeResponse, responsePayload);
  assert.match(activeSql, /quote\.expires_at > \$\d/u);
  assert.match(activeSql, /quote\.consumed_at is null/u);
  assert.match(activeSql, /quote\.invalidated_at is null/u);
  assert.doesNotMatch(
    activeSql,
    /and mutation\.request_fingerprint\s*=/u,
    "presentation fingerprints must not replace a still-active financial quote",
  );
  await assert.rejects(
    recordTelegramFundingReviewMutation(
      {
        query: async (statement: string) =>
          statement.includes("insert into telegram_funding_mutations")
            ? { rowCount: 0, rows: [] }
            : { rowCount: 1, rows: [mutationRow] },
      } as never,
      {
        contextId,
        idempotencyKey: mutationRow.idempotency_key,
        quoteId,
        receiptId: "723e4567-e89b-42d3-a456-426614174000",
        requestFingerprint,
        responsePayload,
        now: new Date("2026-08-05T12:00:00.000Z"),
      },
    ),
    (error: unknown) =>
      error instanceof TelegramFundingPersistenceError &&
      error.code === "telegram_funding_idempotency_conflict",
    "one callback key must never replay another receipt's quote token",
  );
}

{
  const lockOrder: string[] = [];
  const locked =
    await telegramBotTradingTestHooks.lockTelegramFundingReturnBeforeMarket(
      {
        query: async (statement: string) => {
          if (statement.includes("select receive_session_id")) {
            lockOrder.push("context_lookup");
            return {
              rowCount: 1,
              rows: [{ receive_session_id: receiveSessionId }],
            };
          }
          if (statement.includes("from funding_receive_sessions")) {
            lockOrder.push("receive_lock");
            return { rowCount: 1, rows: [{ id: receiveSessionId }] };
          }
          if (statement.includes("from telegram_funding_sessions")) {
            lockOrder.push("context_lock");
            return { rowCount: 1, rows: [{ id: contextId }] };
          }
          if (statement.includes("pg_advisory_xact_lock")) {
            lockOrder.push("market_lock");
            return { rowCount: 1, rows: [{}] };
          }
          assert.fail(`unexpected lock query: ${statement}`);
        },
      } as never,
      {
        fundingContextId: contextId,
        marketId: "market-lock-order",
        telegramUserId: "42",
      },
    );
  assert.equal(locked, true);
  assert.deepEqual(lockOrder, [
    "context_lookup",
    "receive_lock",
    "context_lock",
    "market_lock",
  ]);
}

const pUsd = {
  networkId: "evm:137",
  assetId: fundingSidecarRuntimeConfig.polymarketPusdAddress,
  decimals: 6,
} as const;
const usdce = {
  networkId: "evm:137",
  assetId: fundingSidecarRuntimeConfig.polymarketUsdceAddress,
  decimals: 6,
} as const;
const baseUsdc = {
  networkId: "evm:8453",
  assetId: fundingSidecarRuntimeConfig.limitlessUsdcAddress,
  decimals: 6,
} as const;
const sol = {
  networkId: "solana:mainnet",
  assetId: RELAY_PINNED_ASSETS.solanaNative,
  decimals: 9,
} as const;
const address = "0x1111111111111111111111111111111111111111";
const solanaAddress = "9xQeWvG816bUx9EPjHmaT23yvVMX2wQ3a4K8Z2ZXyvN8";
const expiresAt = "2026-08-06T12:00:00.000Z";
const renderCoordinator = {
  claim: async () => {},
  isCurrent: async () => true,
  runExclusive: async <T>(input: { deliver: () => Promise<T> }) => ({
    status: "completed" as const,
    value: await input.deliver(),
  }),
};

for (const networkId of ["evm:137", "evm:8453"] as const) {
  const expectedControllerWalletId = stableWalletOpaqueId({
    walletType: "ethereum",
    networkId,
    address,
  });
  assert.equal(
    await isTelegramFundingReceiveControllerCurrent(
      {
        query: async (sql: string) =>
          sql.includes("from funding_receive_sessions")
            ? {
                rows: [
                  {
                    controller_wallet_id: expectedControllerWalletId,
                    destination_network_id: networkId,
                  },
                ],
              }
            : {
                rows: [
                  {
                    privy_wallet_id: "privy-wallet-network-test",
                    user_wallet_id: "user-wallet-network-test",
                    wallet_address: address,
                  },
                ],
              },
      } as never,
      {
        receiveSessionId,
        telegramAccountId: "723e4567-e89b-42d3-a456-426614174000",
        telegramUserId: "42",
        userId: "823e4567-e89b-42d3-a456-426614174000",
      },
    ),
    true,
    `the same managed EVM wallet must derive its exact ${networkId} controller identity`,
  );
}

function successfulTelegramCounter() {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      editMessageText: async () => {
        calls += 1;
        return { ok: true as const, messageId: 100 };
      },
      sendMessage: async () => {
        calls += 1;
        return { ok: true as const, messageId: 101 };
      },
    },
  };
}

assert.equal(
  await isFundingReconciliationSchemaReady({
    query: async (sql: string) => {
      assert.match(sql, /telegram_funding_sessions/);
      assert.match(sql, /telegram_funding_consents/);
      assert.match(sql, /telegram_funding_authorizations/);
      assert.match(sql, /telegram_funding_mutations/);
      assert.doesNotMatch(sql, /telegram_funding_buy_return_revisions/);
      assert.doesNotMatch(sql, /active_buy_return_revision/);
      assert.match(sql, /owner_channel/);
      assert.match(sql, /delivery_attempt_id/);
      assert.match(sql, /address_disclosure_attempt_revision/);
      assert.match(sql, /address_delivered_revision/);
      assert.match(sql, /telegram_funding_sessions_address_delivery_check/);
      assert.match(sql, /telegram_bot_action_outbox_funding_qr_unique/);
      assert.match(sql, /telegram_bot_action_outbox_delivery_unknown_check/);
      assert.match(sql, /funding_qr/);
      return { rows: [{ ready: true }] };
    },
  } as never),
  true,
  "the worker requires the Slice C migration marker while remaining independent from additive Buy-return columns",
);

assert.equal(canonicalTelegramFundingBuySpend("1.000000"), "1");
assert.equal(canonicalTelegramFundingBuySpend("1.250000"), "1.25");
assert.deepEqual(
  telegramBotTradingTestHooks.resolveTelegramFundingBuyDepositRequirement({
    executableFundsUsd: 12.65,
    maximumSpendUsd: 15.216001,
  }),
  {
    availableUsd: 12.65,
    sendAtLeastPusd: 2.57,
    state: "deposit",
  },
  "Buy-return deposit guidance uses fresh maximum spend and rounds the pUSD shortfall up",
);
assert.deepEqual(
  telegramBotTradingTestHooks.resolveTelegramFundingBuyDepositRequirement({
    executableFundsUsd: 15.216001,
    maximumSpendUsd: 15.216001,
  }),
  {
    availableUsd: 15.216001,
    sendAtLeastPusd: 0,
    state: "ready",
  },
  "an already funded Buy never renders a zero-value deposit instruction",
);
assert.equal(
  telegramBotTradingTestHooks.shouldOpenTelegramFundingBuyReturn({
    amountUsd: 5,
    buyContinuationEnabled: false,
    fundingState: "deposit",
    hasOpener: true,
  }),
  false,
  "Slice B OFF keeps the ordinary shortfall flow and never attaches funding",
);
assert.equal(
  telegramBotTradingTestHooks.resolveTelegramCallbackMessageId("100", 200),
  200,
  "funding replay fingerprints the card that was actually clicked after a send fallback",
);
assert.equal(
  telegramBotTradingTestHooks.resolveTelegramCallbackMessageId("100", null),
  100,
);
{
  const base = {
    destinationOptionId: "destination",
    identity: { chatId: "42", telegramUserId: "42" },
    link: { linkId: contextId, userId: receiveSessionId },
    request: {
      authorizationId: contextId,
      chatId: "42",
      eventId: null,
      idempotencyKey: "funding-fingerprint-test",
      marketId: "polymarket:test",
      requestedSpendUsd: "1",
      side: "YES" as const,
      sourceIntentId: receiveSessionId,
      telegramMessageId: 1,
      telegramUserId: "42",
      venue: "polymarket" as const,
    },
    venueBindingOptionId: "binding",
  };
  assert.equal(
    buildTelegramFundingBuyReturnRequestFingerprint(base),
    buildTelegramFundingBuyReturnRequestFingerprint({
      ...base,
      request: { ...base.request, requestedSpendUsd: "1.000000" },
    }),
    "equivalent numeric inputs share one idempotency fingerprint",
  );
}

{
  const future = new Date(Date.now() + 60_000);
  const policy: ReturnType<typeof getDefaultSignalBotPolicy> = {
    ...getDefaultSignalBotPolicy(),
    buyContinuationEnabled: true,
    fundingReceiveEnabled: true,
    tradingActions: ["buy"],
    tradingEnabled: true,
    tradingVenues: ["polymarket"],
  };
  const market = {
    accepting_orders: true,
    close_time: future,
    event_end_time: future,
    event_id: "polymarket:event",
    expiration_time: future,
    metadata: {},
    status: "ACTIVE",
    venue: "polymarket" as const,
  };
  const current = {
    currentPolicyRevision: "policy-1",
    eventId: market.event_id,
    initialPolicyRevision: "policy-1",
    lifecycleAllowed: true,
    market,
    policy,
    venue: "polymarket" as const,
  };
  assert.equal(canAttachTelegramFundingBuyReturn(current), true);
  assert.equal(
    canAttachTelegramFundingBuyReturn({
      ...current,
      eventId: "limitless:event",
      market: {
        ...market,
        event_id: "limitless:event",
        venue: "limitless",
      },
      venue: "limitless",
    }),
    true,
    "Limitless app handoff may attach funding without enabling bot submission for that venue",
  );
  assert.equal(
    canAttachTelegramFundingBuyReturn({
      ...current,
      currentPolicyRevision: "policy-2",
    }),
    false,
    "a policy change during handoff must not cancel the source Buy or solicit funding",
  );
  assert.equal(
    canAttachTelegramFundingBuyReturn({
      ...current,
      policy: { ...policy, tradingEnabled: false },
    }),
    false,
  );
  assert.equal(
    canAttachTelegramFundingBuyReturn({
      ...current,
      market: { ...market, status: "CLOSED" },
    }),
    false,
  );
}

{
  const values = new Map<string, string>();
  const redis = {
    eval: async (
      script: string,
      options: { arguments: string[]; keys: string[] },
    ) => {
      const key = options.keys[0] ?? "";
      if (script.includes("string.sub(current")) {
        const current = values.get(key);
        if (
          current &&
          !current.startsWith("funding:") &&
          !current.startsWith("trade-lifecycle:")
        ) {
          return 0;
        }
        if (
          current?.startsWith("trade-lifecycle:") &&
          options.arguments[0]?.startsWith("funding:")
        ) {
          return 0;
        }
        values.set(key, options.arguments[0] ?? "");
        return 1;
      }
      if (values.get(key) !== options.arguments[0]) return 0;
      values.delete(key);
      return 1;
    },
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string, options?: { NX?: boolean }) => {
      if (options?.NX && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
  };
  await claimSignalBotMenuRender({
    chatId: "42",
    messageId: 100,
    redis,
    renderToken: "callback",
  });
  assert.equal(
    await createTelegramFundingRenderCoordinator(redis).claimBackground?.({
      chatId: "42",
      messageId: 100,
      renderToken: "funding:newer-background",
    }),
    false,
    "background delivery must not replace a user-owned menu generation",
  );
  await claimSignalBotMenuRender({
    chatId: "42",
    messageId: 102,
    redis,
    renderToken: "trade-lifecycle:callback:confirm",
  });
  assert.equal(
    await createTelegramFundingRenderCoordinator(redis).claimBackground?.({
      chatId: "42",
      messageId: 102,
      renderToken: "funding:older-projection",
    }),
    false,
    "funding delivery cannot replace a lifecycle-owned trade card",
  );
  assert.equal(
    await createTelegramFundingRenderCoordinator(redis).claimBackground?.({
      chatId: "42",
      messageId: 102,
      renderToken: "trade-lifecycle:projected-state",
    }),
    true,
    "a confirm callback hands its Processing card back to lifecycle delivery",
  );
  const callbackGuard = createSignalBotMenuRenderGuard({
    chatId: "42",
    messageId: 100,
    redis,
    renderToken: "callback",
  });
  await createTelegramFundingRenderCoordinator(redis).claim({
    chatId: "42",
    messageId: 100,
    renderToken: "newer-user-render",
  });
  assert.equal(
    await callbackGuard(),
    false,
    "a newer explicit render must supersede a stale callback render",
  );

  let markBackgroundEntered: () => void = () => undefined;
  let releaseBackground: () => void = () => undefined;
  const backgroundEntered = new Promise<void>((resolve) => {
    markBackgroundEntered = resolve;
  });
  const backgroundGate = new Promise<void>((resolve) => {
    releaseBackground = resolve;
  });
  const coordinator = createTelegramFundingRenderCoordinator(redis);
  const order: string[] = [];
  await coordinator.claim({
    chatId: "42",
    messageId: 101,
    renderToken: "background-edit",
  });
  const background = coordinator.runExclusive({
    chatId: "42",
    messageId: 101,
    renderToken: "background-edit",
    deliver: async () => {
      markBackgroundEntered();
      await backgroundGate;
      order.push("background");
    },
  });
  await backgroundEntered;
  await coordinator.claim({
    chatId: "42",
    messageId: 101,
    renderToken: "newer-callback",
  });
  const callback = coordinator.runExclusive({
    chatId: "42",
    messageId: 101,
    renderToken: "newer-callback",
    deliver: async () => {
      order.push("callback");
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    order,
    [],
    "the newer callback must wait for the active edit",
  );
  releaseBackground();
  assert.equal((await background).status, "completed");
  assert.equal((await callback).status, "completed");
  assert.deepEqual(order, ["background", "callback"]);
}

const context: TelegramFundingSessionContext = {
  id: contextId,
  userId: "user-1",
  telegramAccountId: "telegram-account-1",
  telegramUserId: "42",
  chatId: "42",
  telegramMessageId: 100,
  receiveSessionId,
  origin: "generic_add_funds",
  initialMarketId: null,
  initialEventId: null,
  initialSide: null,
  initialRequestedSpendUsd: null,
  resumeGeneration: 0,
  resumeIntentId: null,
  resumedAt: null,
  activeConsentRevision: 1,
  expiresAt,
  cancelledAt: null,
  progressRevision: 0,
  latestProgressProjection: null,
  latestTerminalRevision: null,
  latestTerminalProjection: null,
  lastDeliveredRevision: 0,
  addressDisclosureAttemptRevision: 0,
  addressDisclosureMessageId: null,
  addressDeliveredRevision: 0,
  addressRedactedRevision: 0,
  createdAt: "2026-08-05T12:00:00.000Z",
  updatedAt: "2026-08-05T12:00:00.000Z",
};

const session: FundingReceiveSession = {
  receiveSessionId,
  status: "open",
  venueId: "polymarket",
  destinationOptionId: "destination-option-1",
  venueBindingOptionId: "venue-binding-1",
  destinationAsset: pUsd,
  methods: [],
  receiveTargets: [
    {
      receiveTargetId,
      networkId: "evm:137",
      destinationAddress: address,
      acceptedAssets: [
        { asset: pUsd, handling: "direct", senderNativeFeeRequirement: null },
        {
          asset: usdce,
          handling: "automatic_conversion",
          senderNativeFeeRequirement: null,
        },
      ],
      safeInstructions: [],
    },
  ],
  selectedReceiveTargetId: null,
  automationPolicy: {
    stableConversion: "automatic_within_caps",
    volatileConversion: "review_required",
    maximumFeeUsd: "1",
    maximumFeeBps: 100,
    maximumSlippageBps: 100,
  },
  version: 1,
  openedAt: "2026-08-05T12:00:00.000Z",
  lastObservedAt: null,
  expiresAt,
  observeUntil: "2026-08-07T12:00:00.000Z",
  closedAt: null,
};

const limitlessSession: FundingReceiveSession = {
  ...session,
  venueId: "limitless",
  destinationOptionId: "destination-limitless-1",
  venueBindingOptionId: "venue-binding-limitless-1",
  destinationAsset: baseUsdc,
  receiveTargets: [
    {
      receiveTargetId: "receive-target-limitless-base-usdc",
      networkId: "evm:8453",
      destinationAddress: address,
      acceptedAssets: [
        {
          asset: baseUsdc,
          handling: "direct",
          senderNativeFeeRequirement: null,
        },
      ],
      safeInstructions: [],
    },
  ],
};

const variant = (
  variantId: string,
  asset: typeof pUsd | typeof usdce,
): DirectIngressObservationVariant => ({
  variantId,
  networkId: "evm:137",
  asset,
  destinationAddress: address,
  destinationLocationId: "location-1",
  baselineRaw: "0",
  baselineRevision: "baseline-1",
  observation: {
    adapterId: "owned_wallet_liquid_balances_v1",
    payload: { eventIdentity: "evm_erc20_transfer_v1" },
  },
  completion:
    asset === usdce
      ? { kind: "committed_venue_preparation", stepOrdinal: 0 }
      : { kind: "direct_destination_credit" },
});

const limitlessVariant: DirectIngressObservationVariant = {
  variantId: "variant-limitless-base-usdc",
  networkId: "evm:8453",
  asset: baseUsdc,
  destinationAddress: address,
  destinationLocationId: "location-limitless-1",
  baselineRaw: "0",
  baselineRevision: "baseline-limitless-1",
  observation: {
    adapterId: "owned_wallet_liquid_balances_v1",
    payload: { eventIdentity: "evm_erc20_transfer_v1" },
  },
  completion: { kind: "direct_destination_credit" },
};

const solanaRetainedVariant: DirectIngressObservationVariant = {
  variantId: "variant-solana-native-sol-retained",
  networkId: "solana:mainnet",
  asset: sol,
  destinationAddress: solanaAddress,
  destinationLocationId: "location-solana-native-sol",
  baselineRaw: "0",
  baselineRevision: "baseline-solana-native-sol",
  observation: {
    adapterId: "owned_wallet_liquid_balances_v1",
    payload: { eventIdentity: "solana_native_transfer_v1" },
  },
  completion: { kind: "retained_owned_source_credit" },
};

const polymarketSolanaRetainedSession: FundingReceiveSession = {
  ...session,
  receiveTargets: [
    ...session.receiveTargets,
    {
      receiveTargetId: "receive-target-polymarket-solana-sol",
      networkId: "solana:mainnet",
      destinationAddress: solanaAddress,
      acceptedAssets: [
        {
          asset: sol,
          handling: "direct",
          senderNativeFeeRequirement: null,
        },
      ],
      safeInstructions: [],
    },
  ],
};

const relayBaseReceiveTargetId = "receive-target-polymarket-base-usdc";
const relayBaseSession: FundingReceiveSession = {
  ...session,
  receiveTargets: [
    ...session.receiveTargets,
    {
      receiveTargetId: relayBaseReceiveTargetId,
      networkId: "evm:8453",
      destinationAddress: address,
      acceptedAssets: [
        {
          asset: baseUsdc,
          handling: "automatic_conversion",
          senderNativeFeeRequirement: null,
        },
      ],
      safeInstructions: [],
    },
  ],
};
const relayBaseVariant: DirectIngressObservationVariant = {
  variantId: "variant-polymarket-base-usdc",
  networkId: "evm:8453",
  asset: baseUsdc,
  destinationAddress: address,
  destinationLocationId: "location-polymarket-base-usdc",
  baselineRaw: "0",
  baselineRevision: "baseline-polymarket-base-usdc",
  observation: {
    adapterId: "owned_wallet_liquid_balances_v1",
    payload: { eventCursorBlock: "100" },
  },
  completion: { kind: "child_funding_operation" },
};
const relayBaseChoice = resolveTelegramFundingTargetChoice({
  automaticConversionEnabled: true,
  session: relayBaseSession,
  observationVariants: [relayBaseVariant],
  routeKey: "polymarket_base_usdc_relay_v1",
});
assert.equal(relayBaseChoice?.mode, "base_usdc_relay_automatic");
assert.equal(relayBaseChoice?.receiveTargetId, relayBaseReceiveTargetId);
assert.deepEqual(
  relayBaseChoice?.asset,
  pUsd,
  "Relay consent binds the destination asset while its receive target accepts Base USDC",
);

const directPusdChoice = resolveTelegramFundingTargetChoice({
  automaticConversionEnabled: true,
  session,
  observationVariants: [
    variant("variant-usdce", usdce),
    variant("variant-pusd", pUsd),
  ],
  routeKey: "polymarket_polygon_pusd_direct_v1",
});
assert.equal(directPusdChoice?.mode, "pusd_direct");
assert.equal(directPusdChoice?.automaticConversion, false);
assert.deepEqual(directPusdChoice?.asset, pUsd);
assert.deepEqual(directPusdChoice?.variantIds, ["variant-pusd"]);

const limitlessChoice = resolveTelegramFundingTargetChoice({
  automaticConversionEnabled: false,
  session: limitlessSession,
  observationVariants: [limitlessVariant],
  routeKey: "limitless_base_usdc_direct_v1",
});
assert.equal(limitlessChoice?.mode, "limitless_base_usdc_direct");
assert.equal(limitlessChoice?.automaticConversion, false);
assert.deepEqual(limitlessChoice?.variantIds, [limitlessVariant.variantId]);
const polymarketSolanaRetainedChoice = resolveTelegramFundingTargetChoice({
  automaticConversionEnabled: false,
  session: polymarketSolanaRetainedSession,
  observationVariants: [solanaRetainedVariant],
  routeKey: "polymarket_solana_sol_retained_v1",
});
assert.equal(
  polymarketSolanaRetainedChoice?.mode,
  "polymarket_solana_sol_retained",
);
assert.equal(polymarketSolanaRetainedChoice?.automaticConversion, false);
assert.deepEqual(polymarketSolanaRetainedChoice?.asset, sol);
assert.deepEqual(polymarketSolanaRetainedChoice?.variantIds, [
  solanaRetainedVariant.variantId,
]);
assert.equal(
  telegramFundingRouteDescriptorForChoiceToken("ps")?.routeKey,
  "polymarket_solana_sol_retained_v1",
);
assert.equal(
  telegramFundingRouteDescriptorForRouteKey("polymarket_solana_sol_retained_v1")
    ?.choiceToken,
  "ps",
);
const solReceivePolicy = (venues: readonly ("limitless" | "polymarket")[]) =>
  compileFundingIntentPolicy({
    version: 2,
    venues: [...venues],
    receive: { assets: ["solana:sol"], privy: false },
    paused: false,
  });
assert.equal(
  telegramSolanaRetainedDepositRouteForPolicy(
    solReceivePolicy(["polymarket", "limitless"]),
  )?.choiceToken,
  "ps",
);
assert.equal(
  telegramSolanaRetainedDepositRouteForPolicy(solReceivePolicy(["limitless"]))
    ?.choiceToken,
  "ls",
);
assert.equal(
  telegramSolanaRetainedDepositRouteForPolicy(
    compileFundingIntentPolicy({
      version: 2,
      venues: ["polymarket"],
      receive: { assets: [], privy: false },
      paused: false,
    }),
  ),
  null,
);
const limitlessTargetMessage = buildTelegramFundingTargetMessageForSession({
  contextId,
  expiresAt,
  session: limitlessSession,
  targets: limitlessChoice
    ? [
        {
          address: limitlessChoice.address,
          destinationAsset: limitlessChoice.asset,
          automaticSourceAsset: null,
          mode: limitlessChoice.mode,
          presentation: limitlessChoice.presentation,
          receiveTargetId: limitlessChoice.receiveTargetId,
        },
      ]
    : [],
});
assert.match(limitlessTargetMessage.text, /Limitless/u);
assert.match(limitlessTargetMessage.text, /Base/u);
assert.match(limitlessTargetMessage.text, /USDC/u);
assert.equal(
  limitlessTargetMessage.reply_markup?.inline_keyboard
    .flat()
    .some(
      (button) =>
        "callback_data" in button &&
        button.callback_data === `hm:v1:fund:select:${contextId}:ld`,
    ),
  true,
);

const consent: TelegramFundingConsent = {
  id: "consent-1",
  fundingContextId: contextId,
  revision: 1,
  receiveTargetId,
  asset: pUsd,
  variantIds: ["variant-pusd"],
  automationEnabled: false,
  maximumAutomaticRaw: null,
  policySnapshot: {
    presentationMode: "pusd_direct",
    presentation: telegramPolygonFundingPresentation("pusd_direct"),
  },
  fingerprint: "fingerprint-1",
  consentedAt: "2026-08-05T12:01:00.000Z",
};
const automaticPolicySnapshot = {
  version: 2,
  kind: "polymarket_usdce_full_receipt_wrap",
  profileId: "polymarket_deposit_usdce_wrap_v1",
  fullReceipt: true,
  authorizationId: "funding-authorization-v2",
  authorizationFingerprint: "authorization-fingerprint-v2",
  signerId: "wrap-signer-v1",
  signerFingerprint: "signer-fingerprint-v1",
  policyId: "wrap-policy-v1",
  policyFingerprint: "policy-fingerprint-v1",
  fundingPolicyRevision: "funding-policy-revision-v1",
  venueId: "polymarket",
  destinationOptionId: "polymarket-deposit",
  venueBindingOptionId: "polymarket-deposit-wallet",
  sourceAsset: usdce,
  destinationAsset: pUsd,
  presentationMode: "pusd_or_usdce_automatic",
  presentation: telegramPolygonFundingPresentation("pusd_or_usdce_automatic"),
  variantCursors: [
    {
      variantId: "variant-usdce",
      networkId: "evm:137",
      ledgerHeightExclusive: "100",
    },
  ],
} as const;

assert.ok(relayBaseChoice);
const relayBaseConsent: TelegramFundingConsent = {
  ...consent,
  id: "consent-relay-base",
  receiveTargetId: relayBaseReceiveTargetId,
  variantIds: [relayBaseVariant.variantId],
  automationEnabled: true,
  maximumAutomaticRaw: "25000000",
  policySnapshot: {
    version: 3,
    kind: "polymarket_base_usdc_relay",
    profileId: "telegram_relay_evm_funding_v1",
    fullReceipt: false,
    maxSourceRaw: "25000000",
    authorizationId: "relay-authorization",
    authorizationFingerprint: "relay-authorization-fingerprint",
    signerId: "relay-signer",
    signerFingerprint: "relay-signer-fingerprint",
    policyId: "relay-policy",
    policyFingerprint: "relay-policy-fingerprint",
    fundingPolicyRevision: "relay-funding-policy-revision",
    venueId: "polymarket",
    destinationOptionId: session.destinationOptionId,
    venueBindingOptionId: session.venueBindingOptionId,
    sourceAsset: baseUsdc,
    destinationAsset: pUsd,
    variantCursors: [
      {
        variantId: relayBaseVariant.variantId,
        networkId: "evm:8453",
        ledgerHeightExclusive: "100",
      },
    ],
    presentationMode: relayBaseChoice.mode,
    presentation: relayBaseChoice.presentation,
  },
  fingerprint: "fingerprint-relay-base",
};

const relayBasePolicy = parseTelegramRelayEvmAutomationPolicyV3(
  relayBaseConsent.policySnapshot,
);
assert.ok(relayBasePolicy);
const deliverySidecarConfiguration = relayEvmFrozenConsentConfiguration(
  {
    enabled: true,
    profileId: "telegram_relay_evm_funding_v1",
    signerId: "",
    signerFingerprint: "s".repeat(64),
    policyId: "combined-policy",
    policyFingerprint: "p".repeat(64),
    maxSourceRaw: "25000000",
    minimumSequentialTtlMs: 45_000,
  },
  relayBasePolicy,
);
assert.equal(deliverySidecarConfiguration.signerId, relayBasePolicy.signerId);
assert.equal(
  relayEvmFrozenConsentConfiguration(
    { ...deliverySidecarConfiguration, signerId: "current-runtime-signer" },
    relayBasePolicy,
  ).signerId,
  "current-runtime-signer",
  "a configured runtime signer must never be replaced by frozen consent data",
);
assert.equal(
  classifyTelegramRelayFrozenCapability(relayBasePolicy, {
    authorization: null,
    decision: {
      kind: "soft_paused",
      reasonCode: "delegated_profile_unavailable",
    },
    fundingPolicyRevision: "relay-funding-policy-revision",
  }).decision.kind,
  "soft_paused",
  "a delivery sidecar missing execution-only profile material must not hard-invalidate an exact frozen Relay consent",
);
assert.equal(
  classifyTelegramRelayFrozenCapability(relayBasePolicy, {
    authorization: null,
    decision: {
      kind: "hard_invalid",
      reasonCode: "delegated_authority_invalid",
    },
    fundingPolicyRevision: "relay-funding-policy-revision",
  }).decision.kind,
  "hard_invalid",
  "a real authority invalidation must remain fail closed",
);

const relayBaseWaiting = projectTelegramFundingProgress({
  automaticConversionAvailable: true,
  consent: relayBaseConsent,
  context,
  receipts: [],
  session: relayBaseSession,
  now: new Date("2026-08-05T12:03:00.000Z"),
});
assert.equal(relayBaseWaiting?.state, "waiting_for_transfer");
assert.equal(relayBaseWaiting?.receiveAddress, address);
assert.ok(relayBaseWaiting);
const relayBaseWaitingMessage =
  buildTelegramFundingProgressMessage(relayBaseWaiting);
assert.match(relayBaseWaitingMessage.text, /Verified receive address/u);
assert.match(relayBaseWaitingMessage.text, new RegExp(address, "u"));
assert.equal(
  relayBaseWaitingMessage.reply_markup?.inline_keyboard
    .flat()
    .some(
      (button) => "copy_text" in button && button.copy_text.text === address,
    ),
  true,
);
assert.equal(
  relayBaseWaitingMessage.reply_markup?.inline_keyboard
    .flat()
    .some(
      (button) =>
        "callback_data" in button &&
        button.callback_data === `hm:v1:fund:qr:${contextId}`,
    ),
  true,
);

assert.equal(
  telegramFundingConsentPresentationMode(
    {
      ...consent,
      policySnapshot: {
        presentationMode: "pusd_direct",
        presentation: telegramPolygonFundingPresentation("pusd_direct"),
      },
    },
    "pusd_or_usdce_automatic",
  ),
  "pusd_direct",
  "new live authorization must not broaden a frozen direct-only consent",
);
assert.equal(
  telegramFundingConsentPresentationMode(
    {
      ...consent,
      automationEnabled: true,
      variantIds: ["variant-pusd", "variant-usdce"],
      policySnapshot: {
        ...automaticPolicySnapshot,
        presentationMode: "pusd_or_usdce_automatic",
      },
    },
    "pusd_or_usdce_automatic",
  ),
  "pusd_or_usdce_automatic",
  "a soft pause must preserve the exact frozen automatic presentation",
);
assert.equal(
  telegramFundingConsentPresentationMode(
    {
      ...consent,
      policySnapshot: { presentationMode: "pusd_or_usdce_automatic" },
    },
    "pusd_or_usdce_automatic",
  ),
  null,
  "a mislabeled direct-only consent must not advertise automatic conversion",
);
assert.equal(
  telegramFundingConsentPresentationMode(
    {
      ...consent,
      automationEnabled: true,
      policySnapshot: {},
    },
    "pusd_or_usdce_automatic",
  ),
  null,
  "missing frozen presentation state must never be invented from live capability",
);
assert.equal(
  telegramFundingConsentPresentationMode(
    {
      ...consent,
      policySnapshot: { presentationMode: "unexpected" },
    },
    "pusd_direct",
  ),
  null,
  "malformed frozen presentation state must fail closed",
);
assert.equal(
  telegramFundingConsentPresentationMode(
    {
      ...consent,
      automationEnabled: true,
      variantIds: ["variant-usdce", "variant-usdce"],
      policySnapshot: {
        ...automaticPolicySnapshot,
        presentationMode: "pusd_or_usdce_automatic",
      },
    },
    "pusd_or_usdce_automatic",
  ),
  null,
  "duplicate automatic variants must not impersonate a combined frozen consent",
);
assert.equal(
  telegramFundingConsentPresentationMode(
    {
      ...consent,
      policySnapshot: {
        presentationMode: "pusd_direct",
        presentation: {
          ...telegramPolygonFundingPresentation("pusd_direct"),
          venueLabel: "Polymarket Prediction Markets",
          networkLabel: "Polygon PoS",
          destinationAssetSymbol: "Polygon USD",
          acceptedAssetSymbols: ["Polygon USD"],
        },
      },
    },
    "pusd_direct",
  ),
  "pusd_direct",
  "frozen display-label renames must not invalidate immutable route identity",
);

const receipt = (
  input: Partial<FundingReceiveReceipt> &
    Pick<FundingReceiveReceipt, "asset" | "handling" | "status">,
): FundingReceiveReceipt => ({
  receiptId: input.receiptId ?? "receipt-1",
  receiveSessionId,
  variantId: input.variantId ?? "variant-pusd",
  asset: input.asset,
  destinationAddress: input.destinationAddress ?? address,
  rawAmount: input.rawAmount ?? "2500000",
  observationRevision: "observation-1",
  observedAt: input.observedAt ?? "2026-08-05T12:02:00.000Z",
  status: input.status,
  handling: input.handling,
  childFundingOperationId: input.childFundingOperationId ?? null,
  ...(input.reviewContinuation
    ? { reviewContinuation: input.reviewContinuation }
    : {}),
  ...(input.reviewQuotePlan ? { reviewQuotePlan: input.reviewQuotePlan } : {}),
});

const selectionCallback = telegramFundingCallbackData({
  contextId,
  kind: "select",
  choiceToken: "p",
});
assert.ok(Buffer.byteLength(selectionCallback, "utf8") <= 64);
assert.deepEqual(
  parseTelegramFundingCallbackRoute(selectionCallback.slice(6)),
  {
    kind: "select",
    contextId,
    choiceToken: "p",
  },
);
for (const kind of ["refresh", "cancel", "qr", "hide_qr"] as const) {
  const callback = telegramFundingCallbackData({ contextId, kind });
  assert.ok(Buffer.byteLength(callback, "utf8") <= 64);
  assert.deepEqual(parseTelegramFundingCallbackRoute(callback.slice(6)), {
    kind,
    contextId,
  });
}
const reviewConversionCallback = telegramFundingCallbackData({
  receiptId: reviewReceiptId,
  kind: "review_conversion",
});
assert.deepEqual(
  parseTelegramFundingCallbackRoute(reviewConversionCallback.slice(6)),
  { receiptId: reviewReceiptId, kind: "review_conversion" },
);
const consentToken = `consent_${"a".repeat(43)}`;
const confirmConversionCallback = telegramFundingCallbackData({
  consentToken,
  kind: "confirm_conversion",
});
assert.equal(Buffer.byteLength(confirmConversionCallback, "utf8"), 64);
assert.deepEqual(
  parseTelegramFundingCallbackRoute(confirmConversionCallback.slice(6)),
  { consentToken, kind: "confirm_conversion" },
);
const continuationToken = "AbCdEfGhIjKlMnOpQrStUv";
const reviewBuyCallback = telegramFundingCallbackData({
  continuationToken,
  kind: "review_buy",
});
assert.ok(Buffer.byteLength(reviewBuyCallback, "utf8") <= 64);
assert.deepEqual(
  parseTelegramFundingCallbackRoute(reviewBuyCallback.slice(6)),
  {
    kind: "review_buy",
    continuationToken,
  },
);
assert.equal(
  parseTelegramFundingCallbackRoute(`fund:review:${contextId}:1`),
  null,
  "the callback carries one opaque token rather than mutable generation data",
);
assert.deepEqual(buildTelegramFundingReviewBuyButton({ continuationToken }), {
  callback_data: reviewBuyCallback,
  text: "Review Buy",
});
const changeBuyAmountCallback = telegramFundingCallbackData({
  continuationToken,
  kind: "change_buy_amount",
});
assert.ok(Buffer.byteLength(changeBuyAmountCallback, "utf8") <= 64);
assert.deepEqual(
  parseTelegramFundingCallbackRoute(changeBuyAmountCallback.slice(6)),
  {
    kind: "change_buy_amount",
    continuationToken,
  },
);
assert.deepEqual(
  buildTelegramFundingChangeBuyAmountButton({ continuationToken }),
  {
    callback_data: changeBuyAmountCallback,
    text: "Change amount",
  },
);
assert.deepEqual(
  resolveTelegramFundingBuyContinuationCapability({
    activeReturnAttached: true,
    buyContinuationEnabled: false,
    progressState: "ready",
  }),
  { available: false, reason: "disabled" },
);
assert.deepEqual(
  resolveTelegramFundingBuyContinuationCapability({
    activeReturnAttached: false,
    buyContinuationEnabled: true,
    progressState: "ready",
  }),
  { available: false, reason: "no_active_return" },
);
assert.deepEqual(
  resolveTelegramFundingBuyContinuationCapability({
    activeReturnAttached: true,
    buyContinuationEnabled: true,
    progressState: "funds_received",
  }),
  { available: false, reason: "not_ready" },
);
assert.deepEqual(
  resolveTelegramFundingBuyContinuationCapability({
    activeReturnAttached: true,
    buyContinuationEnabled: true,
    progressState: "ready",
  }),
  { available: true },
);
assert.deepEqual(
  resolveTelegramFundingBuyContinuationAdapter({
    destinationAsset: pUsd,
    venueId: "polymarket",
  }),
  {
    id: "polymarket_destination_pusd_v1",
    tradingVenue: "polymarket",
  },
);
for (const unsupported of [
  { destinationAsset: pUsd, venueId: "limitless" },
  { destinationAsset: usdce, venueId: "polymarket" },
  {
    destinationAsset: { ...pUsd, networkId: "evm:8453" },
    venueId: "polymarket",
  },
  {
    destinationAsset: { ...pUsd, decimals: 18 },
    venueId: "polymarket",
  },
  {
    destinationAsset: {
      ...pUsd,
      assetId: "0x1111111111111111111111111111111111111111",
    },
    venueId: "polymarket",
  },
]) {
  assert.equal(resolveTelegramFundingBuyContinuationAdapter(unsupported), null);
}
assert.deepEqual(
  parseTelegramFundingCallbackRoute(`fund:select:${contextId}:usdce`),
  { kind: "select", contextId, choiceToken: "usdce" },
  "the parser accepts opaque tokens; the API selection service owns the allow-list",
);

{
  let requestedAction = "";
  let requestedToken = "";
  let rendered = "";
  const handled = await handleSignalBotInteractiveMenuCallback({
    callbackPrefix: "hm:v1:",
    chatId: "42",
    idempotencyKey: "callback-review-buy-1",
    loadFunding: async (input) => {
      requestedAction = input.action;
      requestedToken = input.continuationToken ?? "";
      return {
        parse_mode: "MarkdownV2",
        text: "Fresh Buy confirmation",
      };
    },
    messageId: 100,
    redis: { get: async () => null },
    render: async (message) => {
      rendered = message.text;
    },
    renderExpiredSearch: async () => undefined,
    route: { continuationToken, kind: "review_buy" },
    telegramUserId: 42,
  });
  assert.equal(handled, true);
  assert.equal(requestedAction, "resume_buy");
  assert.equal(requestedToken, continuationToken);
  assert.equal(rendered, "Fresh Buy confirmation");
}

for (const expected of [
  {
    action: "review_conversion",
    route: { receiptId: reviewReceiptId, kind: "review_conversion" as const },
    token: reviewReceiptId,
  },
  {
    action: "confirm_conversion",
    route: { consentToken, kind: "confirm_conversion" as const },
    token: consentToken,
  },
]) {
  let requestedAction = "";
  let requestedToken = "";
  const handled = await handleSignalBotInteractiveMenuCallback({
    callbackPrefix: "hm:v1:",
    chatId: "42",
    loadFunding: async (input) => {
      requestedAction = input.action;
      requestedToken =
        input.contextId ?? input.receiptId ?? input.consentToken ?? "";
      return { text: "Conversion review" };
    },
    messageId: 100,
    redis: { get: async () => null },
    render: async () => undefined,
    renderExpiredSearch: async () => undefined,
    route: expected.route,
    telegramUserId: 42,
  });
  assert.equal(handled, true);
  assert.equal(requestedAction, expected.action);
  assert.equal(requestedToken, expected.token);
}

const targetMessage = buildTelegramFundingTargetMessage({
  automaticConversion: false,
  contextId,
  expiresAt,
  presentation: telegramPolygonFundingPresentation("pusd_direct"),
});
assert.match(targetMessage.text, /pUSD/);
assert.match(targetMessage.text, /Receive window.*24 hours/u);
assert.equal(targetMessage.text.includes("2026\\-08\\-06 12:00:00 UTC"), true);
assert.doesNotMatch(targetMessage.text, /Session expires/u);
assert.doesNotMatch(targetMessage.text, /pUSD \/ USDC\.e/);
assert.equal(targetMessage.text.includes(address), false);
assert.equal(
  targetMessage.reply_markup?.inline_keyboard
    .flat()
    .some((button) => "text" in button && button.text.includes("USDC.e")),
  false,
);

const queuedDeliveryMessage = buildTelegramFundingDeliveryQueuedMessage({
  contextId,
});
assert.equal(queuedDeliveryMessage.durableFundingDeliveryRequired, true);
assert.equal(queuedDeliveryMessage.fundingContextId, contextId);
const attachedBuyMessage = buildTelegramFundingBuyReturnAttachedMessage();
assert.equal(attachedBuyMessage.fundingContextId, undefined);
assert.match(attachedBuyMessage.text, /Buy linked to active funding/u);
assert.match(attachedBuyMessage.text, /No trade was submitted/u);
assert.equal(
  attachedBuyMessage.reply_markup,
  undefined,
  "the new Buy message must not duplicate callbacks owned by the earlier funding card",
);
assert.equal(queuedDeliveryMessage.qrText, undefined);
assert.doesNotMatch(
  queuedDeliveryMessage.text,
  new RegExp(address, "u"),
  "interactive durable acknowledgements must never carry the address",
);

const reviewContinuation = {
  version: 1,
  kind: "convert",
  confirmation: "fresh_quote",
  label: "Convert to pUSD",
} as const;
const multipleReviewProjection = projectTelegramFundingProgress({
  consent,
  context,
  receipts: [
    receipt({
      receiptId: "423e4567-e89b-42d3-a456-426614174001",
      asset: {
        networkId: "solana:mainnet",
        assetId: "So11111111111111111111111111111111111111112",
        decimals: 9,
      },
      handling: "review_required",
      observedAt: "2026-08-05T12:03:00.000Z",
      reviewContinuation,
      status: "review_required",
    }),
    receipt({
      receiptId: reviewReceiptId,
      asset: {
        networkId: "solana:mainnet",
        assetId: "11111111111111111111111111111111",
        decimals: 9,
      },
      handling: "review_required",
      observedAt: "2026-08-05T12:02:00.000Z",
      reviewContinuation,
      status: "review_required",
    }),
  ],
  session: { ...session, status: "review_required" },
  now: new Date("2026-08-05T12:04:00.000Z"),
});
assert.equal(
  multipleReviewProjection?.reviewReceiptId,
  reviewReceiptId,
  "multiple volatile receipts must expose one deterministic receipt-bound continuation",
);
const reviewProjection: TelegramFundingProgressProjection = {
  version: 2,
  fundingContextId: contextId,
  state: "needs_attention",
  terminal: false,
  presentation: {
    ...telegramPolygonFundingPresentation("pusd_direct"),
    reviewAction: reviewContinuation,
  },
  assetSymbol: "SOL",
  rawAmount: "1000000000",
  receiveAddress: null,
  expiresAt,
  observedAt: "2026-08-05T12:02:00.000Z",
  reviewContinuation,
  reviewReceiptId,
};
const reviewMessage = buildTelegramFundingProgressMessage(reviewProjection);
const reviewButton = reviewMessage.reply_markup?.inline_keyboard[0]?.[0];
assert.equal(
  reviewButton && "callback_data" in reviewButton
    ? reviewButton.callback_data
    : null,
  reviewConversionCallback,
);
assert.equal(
  parseTelegramFundingProgressProjection(reviewProjection)?.reviewContinuation
    ?.confirmation,
  "fresh_quote",
);
const reviewDisposition = resolveTelegramFundingReceiptDisposition({
  destinationAsset: {
    networkId: "evm:137",
    assetId: "0x0000000000000000000000000000000000000001",
    decimals: 6,
  },
  receipt: {
    handling: "review_required",
    asset: {
      networkId: "solana:mainnet",
      assetId: "11111111111111111111111111111111",
      decimals: 9,
    },
    rawAmount: "1000000000",
  },
  telegramAutomationPolicy: {
    presentation: reviewProjection.presentation,
  },
} as unknown as FundingReceiveReceiptRoutingTarget);
assert.deepEqual(reviewDisposition, {
  kind: "hard_invalid",
  reasonCode: "funding_review_action_unavailable",
});
const reviewQuoteMessage = buildTelegramFundingReviewQuoteMessage({
  contextId,
  quote: {
    quoteId: "quote-review",
    liquidityProjectionId: "projection-review",
    selectedSourceOptionId: "source-review",
    destinationOptionId: "destination-review",
    venueBindingOptionId: "binding-review",
    planKind: "wallet_route",
    experienceMode: "prepare_first",
    consentMode: "explicit_economic_review",
    sourceAmounts: [
      { safeLabel: "SOL", amount: { asset: pUsd, raw: "1000000" } },
    ],
    expectedDestination: { asset: pUsd, raw: "990000" },
    minimumDestination: { asset: pUsd, raw: "980000" },
    fees: [],
    eta: null,
    requiredActions: [],
    ingress: null,
    planHash: "plan-review",
    consentToken: `consent_${"a".repeat(43)}`,
    expiresAt: "2026-08-05T12:05:00.000Z",
    policyVersion: 1,
  } satisfies FundingQuoteSummary,
});
assert.match(reviewQuoteMessage.text, /Minimum received/u);
assert.equal(
  reviewQuoteMessage.reply_markup?.inline_keyboard[0]?.[0] &&
    "callback_data" in reviewQuoteMessage.reply_markup.inline_keyboard[0][0]
    ? reviewQuoteMessage.reply_markup.inline_keyboard[0][0].callback_data
    : null,
  telegramFundingCallbackData({
    consentToken: `consent_${"a".repeat(43)}`,
    kind: "confirm_conversion",
  }),
);

const choice = resolveTelegramDirectPusdChoice({
  session,
  observationVariants: [
    variant("variant-usdce", usdce),
    variant("variant-pusd", pUsd),
  ],
});
assert.deepEqual(choice, {
  address,
  asset: pUsd,
  automaticConversion: false,
  mode: "pusd_direct",
  presentation: telegramPolygonFundingPresentation("pusd_direct"),
  receiveTargetId,
  automaticVariants: [],
  variantIds: ["variant-pusd"],
});
const firstReceiveTarget = session.receiveTargets[0];
assert.ok(firstReceiveTarget);
const automaticUsdceAcceptedAsset = firstReceiveTarget.acceptedAssets.find(
  (accepted) => accepted.handling === "automatic_conversion",
);
assert.ok(automaticUsdceAcceptedAsset);
const usdceOnlySession = {
  ...session,
  receiveTargets: [
    {
      ...firstReceiveTarget,
      acceptedAssets: [automaticUsdceAcceptedAsset],
    },
  ],
};
assert.equal(
  resolveTelegramDirectPusdChoice({
    session: usdceOnlySession,
    observationVariants: [variant("variant-usdce", usdce)],
  }),
  null,
  "Telegram must not expose automatic USDC.e until a durable server executor exists",
);
assert.equal(
  resolveTelegramFundingTargetChoice({
    automaticConversionEnabled: true,
    session: usdceOnlySession,
    observationVariants: [variant("variant-usdce", usdce)],
  }),
  null,
  "Telegram must never expose an automatic-only Polygon choice without direct pUSD",
);
const usdceOnlyTargetMessage = buildTelegramFundingTargetMessageForSession({
  contextId,
  expiresAt,
  session: usdceOnlySession,
});
assert.match(usdceOnlyTargetMessage.text, /Receive unavailable/u);
assert.doesNotMatch(usdceOnlyTargetMessage.text, /pUSD/u);
assert.equal(usdceOnlyTargetMessage.reply_markup, undefined);
const combinedTargetMessage = buildTelegramFundingTargetMessageForSession({
  contextId,
  expiresAt,
  session,
  automaticConversionEnabled: true,
});
assert.ok(combinedTargetMessage.text.includes("pUSD / USDC\\.e"));
assert.doesNotMatch(
  combinedTargetMessage.text,
  /Choose the network and asset/u,
);
assert.ok(combinedTargetMessage.reply_markup);
const combinedChoice = resolveTelegramFundingTargetChoice({
  automaticConversionEnabled: true,
  session,
  observationVariants: [
    variant("variant-usdce", usdce),
    variant("variant-pusd", pUsd),
  ],
});
assert.ok(combinedChoice);
assert.equal(combinedChoice.address, address);
assert.equal(combinedChoice.mode, "pusd_or_usdce_automatic");
assert.equal(combinedChoice.automaticConversion, true);
assert.deepEqual(combinedChoice.variantIds, ["variant-pusd", "variant-usdce"]);
assert.equal(
  resolveTelegramDirectPusdChoice({
    session: {
      ...session,
      receiveTargets: [
        ...session.receiveTargets,
        {
          ...firstReceiveTarget,
          receiveTargetId: "receive_target_duplicate_pusd_12345678",
        },
      ],
    },
    observationVariants: [variant("variant-pusd", pUsd)],
  }),
  null,
);
assert.equal(
  resolveTelegramDirectPusdChoice({
    session,
    observationVariants: [
      variant("variant-wrong-decimals", { ...pUsd, decimals: 18 } as never),
    ],
  }),
  null,
);

const waiting = projectTelegramFundingProgress({
  consent,
  context,
  receipts: [],
  session,
  now: new Date("2026-08-05T12:03:00.000Z"),
});
assert.equal(waiting?.state, "waiting_for_transfer");
assert.equal(waiting?.receiveAddress, address);
assert.equal(
  parseTelegramFundingProgressProjection({
    ...waiting,
    version: 1,
    presentation: undefined,
  }),
  null,
  "runtime parsing must never reconstruct a legacy projection from live labels",
);

const ready = projectTelegramFundingProgress({
  consent,
  context,
  receipts: [receipt({ asset: pUsd, handling: "direct", status: "ready" })],
  session: { ...session, status: "completed" },
});
assert.equal(ready?.state, "ready");
assert.equal(ready?.terminal, true);
const buyContext: TelegramFundingSessionContext = {
  ...context,
  origin: "buy_return_context",
  initialMarketId: "market-buy-return",
  initialSide: "YES",
  initialRequestedSpendUsd: "18",
  initialMinimumFundingUsd: "3",
};
const partialBuyReady = projectTelegramFundingProgress({
  consent,
  context: buyContext,
  receipts: [
    receipt({
      asset: pUsd,
      handling: "direct",
      rawAmount: "2500000",
      status: "ready",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(partialBuyReady?.state, "funds_received");
assert.equal(partialBuyReady?.terminal, false);
assert.equal(partialBuyReady?.returnToMarketAvailable, true);
assert.deepEqual(
  parseTelegramFundingProgressProjection(partialBuyReady),
  partialBuyReady,
);
const sufficientBuyReady = projectTelegramFundingProgress({
  consent,
  context: buyContext,
  receipts: [
    receipt({
      asset: pUsd,
      handling: "direct",
      rawAmount: "2500000",
      status: "ready",
    }),
    receipt({
      asset: pUsd,
      handling: "direct",
      rawAmount: "500000",
      receiptId: "receipt-buy-top-up",
      status: "ready",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(sufficientBuyReady?.state, "ready");
assert.equal(sufficientBuyReady?.terminal, true);
assert.equal(sufficientBuyReady?.rawAmount, "3000000");

const solanaRetainedConsent: TelegramFundingConsent = {
  ...consent,
  id: "consent-solana-native-sol-retained",
  receiveTargetId: "receive-target-polymarket-solana-sol",
  asset: sol,
  variantIds: [solanaRetainedVariant.variantId],
  policySnapshot: {
    version: 1,
    mode: "direct",
    automationEnabled: false,
    telegramPolicyRevision: "telegram-policy-sol-retained",
    receiveAutomationPolicy:
      polymarketSolanaRetainedSession.automationPolicy as never,
    presentationMode: "polymarket_solana_sol_retained",
    presentation: telegramPolygonFundingPresentation(
      "polymarket_solana_sol_retained",
    ),
  },
};
const solanaRetainedReceipt = receipt({
  asset: sol,
  destinationAddress: solanaAddress,
  handling: "direct",
  rawAmount: "52000000",
  status: "ready",
  variantId: solanaRetainedVariant.variantId,
});
const waitingForSolanaRetained = projectTelegramFundingProgress({
  consent: solanaRetainedConsent,
  context,
  now: new Date("2026-08-05T12:03:00.000Z"),
  receipts: [],
  session: { ...polymarketSolanaRetainedSession, status: "open", version: 2 },
});
assert.equal(waitingForSolanaRetained?.state, "waiting_for_transfer");
assert.equal(waitingForSolanaRetained?.receiveAddress, solanaAddress);
assert.ok(waitingForSolanaRetained);
const waitingForSolanaRetainedMessage = buildTelegramFundingProgressMessage(
  waitingForSolanaRetained,
);
assert.match(
  waitingForSolanaRetainedMessage.text,
  new RegExp(solanaAddress, "u"),
);
assert.equal(
  waitingForSolanaRetainedMessage.reply_markup?.inline_keyboard
    .flat()
    .some(
      (button) =>
        "copy_text" in button && button.copy_text.text === solanaAddress,
    ),
  true,
);
assert.equal(
  waitingForSolanaRetainedMessage.reply_markup?.inline_keyboard
    .flat()
    .some(
      (button) =>
        "callback_data" in button &&
        button.callback_data === `hm:v1:fund:qr:${contextId}`,
    ),
  true,
);
const genericSolanaRetained = projectTelegramFundingProgress({
  consent: solanaRetainedConsent,
  context,
  receipts: [solanaRetainedReceipt],
  session: { ...polymarketSolanaRetainedSession, status: "open", version: 2 },
});
assert.equal(genericSolanaRetained?.state, "ready");
assert.equal(genericSolanaRetained?.terminal, true);
assert.equal(genericSolanaRetained?.assetSymbol, "SOL");
assert.ok(genericSolanaRetained);
const genericSolanaRetainedMessage = buildTelegramFundingProgressMessage(
  genericSolanaRetained,
);
assert.match(genericSolanaRetainedMessage.text, /SOL received/u);
assert.match(genericSolanaRetainedMessage.text, /kept in your Solana wallet/u);
assert.doesNotMatch(
  genericSolanaRetainedMessage.text,
  /available at Polymarket/u,
);
const retainedSolTestNow = new Date("2026-08-05T12:03:00.000Z");
const retainedSolPresentation = {
  consent: solanaRetainedConsent,
  context,
  message: genericSolanaRetainedMessage,
  now: retainedSolTestNow,
  presentationMode: "polymarket_solana_sol_retained" as const,
  progress: genericSolanaRetained,
  session: polymarketSolanaRetainedSession,
};
let retainedSolEstimateRaw: string | null = null;
const retainedSolEstimatedMessage =
  await telegramBotTradingTestHooks.decorateRetainedSolReceiptEstimate({
    estimateRetainedSolUsd: async (raw) => {
      retainedSolEstimateRaw = raw;
      return "5.2";
    },
    invalidateAccountValue: (userId) => assert.equal(userId, context.userId),
    presentation: retainedSolPresentation,
  });
assert.equal(retainedSolEstimateRaw, "52000000");
assert.match(retainedSolEstimatedMessage.text, /Approximate value/u);
assert.match(retainedSolEstimatedMessage.text.replaceAll("\\", ""), /\$5\.20/u);
const retainedSolHandoffPlan = {
  executionContractVersion: 2,
  funding: {
    discoveryRequest: {
      deadline: "2026-08-05T12:05:00.000Z",
      destinationOptionId: "destination-pm",
      marketContextId: "market-context",
      maxFeeUsd: "0.15",
      maxSlippageBps: 500,
      purpose: "trade_shortfall",
      requestedDestinationAmount: { asset: pUsd, raw: "5000000" },
      serverAdditionalDestinationAmount: { asset: pUsd, raw: "1200000" },
      venueBindingOptionId: "binding-pm",
      withdrawalRecipientId: null,
      confirmedSourceAmount: null,
    },
    destination: {
      controllerWalletId: "controller-pm",
      destinationOptionId: "destination-pm",
      requiredAsset: pUsd,
      topology: "solana_relay_polygon_pusd",
      venueBindingId: "venue-binding-pm",
      venueBindingOptionId: "binding-pm",
      venueId: "polymarket",
    },
    fundingPolicyRevision: "funding-policy-test",
    sourceDebits: [
      {
        asset: sol,
        locationId: "location-solana",
        maximumRaw: "52000000",
        sourceFingerprint: "a".repeat(64),
      },
    ],
  },
  kind: "funding",
  trade: {},
  version: 2,
} as never;
const retainedSolHandoffReview = (
  await telegramBotTradingTestHooks.buildTelegramAppHandoffFundingReviewLines({
    estimateRetainedSolUsd: async (raw) => {
      assert.equal(raw, "52000000");
      return "5.2";
    },
    plan: retainedSolHandoffPlan,
  })
)
  .join("\n")
  .replaceAll("\\", "");
assert.match(retainedSolHandoffReview, /0\.052 SOL on Solana/u);
assert.match(retainedSolHandoffReview, /≈ \$5\.20/u);
assert.match(retainedSolHandoffReview, /≈ \$100\.00\/SOL/u);
assert.match(retainedSolHandoffReview, /at least 1\.2 pUSD on Polygon/u);
assert.match(retainedSolHandoffReview, /Maximum funding fees/u);
const unpricedSolHandoffReview = (
  await telegramBotTradingTestHooks.buildTelegramAppHandoffFundingReviewLines({
    estimateRetainedSolUsd: async () => null,
    plan: retainedSolHandoffPlan,
  })
)
  .join("\n")
  .replaceAll("\\", "");
assert.match(unpricedSolHandoffReview, /0\.052 SOL on Solana/u);
assert.doesNotMatch(unpricedSolHandoffReview, /\/SOL/u);

const buySolanaRetained = projectTelegramFundingProgress({
  consent: solanaRetainedConsent,
  context: buyContext,
  receipts: [solanaRetainedReceipt],
  session: { ...polymarketSolanaRetainedSession, status: "open", version: 2 },
});
assert.equal(buySolanaRetained?.state, "funds_received");
assert.equal(buySolanaRetained?.terminal, false);
assert.equal(buySolanaRetained?.rawAmount, "52000000");
assert.deepEqual(
  buySolanaRetained &&
    parseTelegramFundingProgressProjection(buySolanaRetained),
  buySolanaRetained,
);
assert.ok(buySolanaRetained);
assert.match(
  buildTelegramFundingProgressMessage(buySolanaRetained).text,
  /preparing the Mini App funding route/u,
);
const buySolanaRetainedMessage =
  buildTelegramFundingProgressMessage(buySolanaRetained);
for (const closedPresentation of [
  {
    consent: solanaRetainedConsent,
    context: {
      ...buyContext,
      cancelledAt: retainedSolTestNow.toISOString(),
    },
    message: buySolanaRetainedMessage,
    now: retainedSolTestNow,
    presentationMode: "polymarket_solana_sol_retained" as const,
    progress: buySolanaRetained,
    session: {
      ...polymarketSolanaRetainedSession,
      status: "cancelled" as const,
    },
  },
  {
    consent: solanaRetainedConsent,
    context: {
      ...buyContext,
      expiresAt: retainedSolTestNow.toISOString(),
    },
    message: buySolanaRetainedMessage,
    now: retainedSolTestNow,
    presentationMode: "polymarket_solana_sol_retained" as const,
    progress: buySolanaRetained,
    session: { ...polymarketSolanaRetainedSession, status: "expired" as const },
  },
]) {
  let closedContextQueries = 0;
  const closedMessage = await createTelegramFundingBuyContinuationDecorator({
    pool: {
      query: async () => {
        closedContextQueries += 1;
        throw new Error("closed funding must not inspect a Buy continuation");
      },
    } as never,
    trading: {} as never,
  })(closedPresentation);
  assert.equal(closedContextQueries, 0);
  assert.deepEqual(closedMessage, buySolanaRetainedMessage);
}

const solanaRetainedTargetMessage = buildTelegramFundingTargetMessageForSession(
  {
    contextId,
    expiresAt,
    session: polymarketSolanaRetainedSession,
    targets: polymarketSolanaRetainedChoice
      ? [
          {
            address: polymarketSolanaRetainedChoice.address,
            destinationAsset: pUsd,
            automaticSourceAsset: sol,
            mode: polymarketSolanaRetainedChoice.mode,
            presentation: polymarketSolanaRetainedChoice.presentation,
            receiveTargetId: polymarketSolanaRetainedChoice.receiveTargetId,
          },
        ]
      : [],
  },
);
assert.equal(
  solanaRetainedTargetMessage.reply_markup?.inline_keyboard
    .flat()
    .some(
      (button) =>
        "callback_data" in button &&
        button.callback_data === `hm:v1:fund:select:${contextId}:ps`,
    ),
  true,
);
assert.ok(ready);
assert.deepEqual(parseTelegramFundingProgressProjection(ready), ready);
for (const malformed of [
  { ...ready, unexpected: true },
  { ...ready, expiresAt: "invalid" },
  { ...ready, rawAmount: "-1" },
  { ...ready, terminal: false },
  { ...ready, receiveAddress: address },
]) {
  assert.equal(
    parseTelegramFundingProgressProjection(malformed),
    null,
    "persisted progress must be exact, canonical, and semantically consistent",
  );
}
const readyMessage = buildTelegramFundingProgressMessage(ready);
assert.match(readyMessage.text, /pUSD ready/);
assert.doesNotMatch(readyMessage.text, /Receive window/u);
assert.doesNotMatch(readyMessage.text, /Expires at/u);
assert.equal(
  readyMessage.reply_markup?.inline_keyboard
    .flat()
    .some(
      (button) =>
        "callback_data" in button && button.callback_data === "hm:v1:home",
    ),
  true,
  "terminal funding cards must retain a direct way back to Home",
);
assert.deepEqual(
  await createTelegramFundingBuyContinuationDecorator({
    pool: {
      query: async (sql: string) => {
        assert.match(sql, /telegram_funding_buy_return_revisions/u);
        return { rows: [] };
      },
    } as never,
    trading: {} as never,
  })({
    consent,
    context: { ...context, progressRevision: 1 },
    message: readyMessage,
    now: new Date("2026-08-05T12:03:00.000Z"),
    presentationMode: "pusd_direct",
    progress: ready,
    session: { ...session, status: "completed" },
  }),
  readyMessage,
  "generic ready delivery remains available without a Buy return",
);
await assert.rejects(
  createTelegramFundingBuyContinuationDecorator({
    pool: {
      query: async () => {
        throw new Error("transient continuation database failure");
      },
    } as never,
    trading: {} as never,
  })({
    consent,
    context: { ...context, progressRevision: 1 },
    message: readyMessage,
    now: new Date("2026-08-05T12:03:00.000Z"),
    presentationMode: "pusd_direct",
    progress: ready,
    session: { ...session, status: "completed" },
  }),
  /transient continuation database failure/u,
  "a transient continuation dependency failure must keep durable delivery retryable",
);
assert.ok(waiting);
const waitingMessage = buildTelegramFundingProgressMessage(waiting);
assert.match(waitingMessage.text, /Receive window.*24 hours/u);
assert.equal(waitingMessage.text.includes("2026\\-08\\-06 12:00:00 UTC"), true);
assert.equal(
  waitingMessage.reply_markup?.inline_keyboard
    .flat()
    .some(
      (button) =>
        "callback_data" in button && button.callback_data === "hm:v1:home",
    ),
  true,
  "the durable initial funding card must expose Home before Refresh",
);
const futureSolanaProjection: TelegramFundingProgressProjection = {
  version: 2,
  fundingContextId: contextId,
  state: "waiting_for_transfer",
  terminal: false,
  presentation: {
    version: 1,
    routeKey: "polymarket_solana_sol_relay_v1",
    venueId: "polymarket",
    venueLabel: "Polymarket",
    networkId: "solana:mainnet",
    networkLabel: "Solana",
    destinationAssetSymbol: "pUSD",
    acceptedAssetSymbols: ["SOL"],
    automaticSourceAssetSymbol: "SOL",
    decimals: 9,
  },
  assetSymbol: "SOL",
  rawAmount: null,
  receiveAddress: "11111111111111111111111111111111",
  expiresAt,
  observedAt: null,
  automaticConversionEnabled: true,
};
const futureSolanaMessage = buildTelegramFundingProgressMessage(
  futureSolanaProjection,
);
const activeMirror = buildTelegramFundingActiveElsewhereMessage({
  projection: futureSolanaProjection,
  venue: "polymarket",
});
assert.match(activeMirror.text, /Active Deposit/u);
assert.doesNotMatch(activeMirror.text, /11111111111111111111111111111111/u);
assert.deepEqual(activeMirror.reply_markup?.inline_keyboard[0], [
  {
    callback_data: "hm:v1:deposit:polymarket",
    text: "🔄 Refresh active Deposit",
  },
]);
const futureSolanaTargetMessage = buildTelegramFundingTargetMessage({
  automaticConversion: true,
  contextId,
  expiresAt,
  presentation: futureSolanaProjection.presentation,
});
assert.match(futureSolanaMessage.text, /Network.*Solana/u);
assert.match(futureSolanaMessage.text, /Asset.*SOL/u);
assert.doesNotMatch(futureSolanaMessage.text, /Polygon|USDC\.e/u);
assert.match(futureSolanaTargetMessage.text, /Network.*Solana/u);
assert.match(futureSolanaTargetMessage.text, /Asset.*SOL/u);
assert.doesNotMatch(futureSolanaTargetMessage.text, /Polygon|USDC\.e/u);
const unavailable = projectTelegramFundingUnavailable(
  context,
  telegramPolygonFundingPresentation("pusd_direct"),
);
const unavailableMessage = buildTelegramFundingProgressMessage(unavailable);
assert.equal(unavailable.receiveAddress, null);
assert.equal(unavailable.terminal, true);
assert.match(unavailableMessage.text, /Receive unavailable/u);
assert.doesNotMatch(unavailableMessage.text, new RegExp(address, "u"));

const unexpectedUsdce = projectTelegramFundingProgress({
  consent,
  context,
  receipts: [
    receipt({
      asset: usdce,
      handling: "automatic_conversion",
      status: "observed",
      variantId: "variant-usdce",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(unexpectedUsdce?.state, "needs_attention");
assert.equal(unexpectedUsdce?.assetSymbol, "USDC.e");
assert.ok(unexpectedUsdce);
assert.match(
  buildTelegramFundingProgressMessage(unexpectedUsdce).text,
  /did not complete.*preserved.*needs review/u,
);
assert.doesNotMatch(
  buildTelegramFundingProgressMessage(unexpectedUsdce).text,
  /No routing transaction was submitted/u,
);
assert.notEqual(
  telegramFundingProgressFingerprint(ready),
  telegramFundingProgressFingerprint(unexpectedUsdce),
);
const automaticConsent: TelegramFundingConsent = {
  ...consent,
  revision: 2,
  variantIds: ["variant-pusd", "variant-usdce"],
  automationEnabled: true,
  policySnapshot: {
    ...automaticPolicySnapshot,
  },
};
const waitingAfterCapabilityLoss = projectTelegramFundingProgress({
  automaticConversionAvailable: false,
  consent: automaticConsent,
  context,
  receipts: [],
  session,
  now: new Date("2026-08-05T12:03:00.000Z"),
});
assert.ok(waitingAfterCapabilityLoss);
assert.equal(waitingAfterCapabilityLoss.automaticConversionEnabled, true);
assert.equal(waitingAfterCapabilityLoss.automaticConversionPaused, true);
assert.match(
  buildTelegramFundingProgressMessage(waitingAfterCapabilityLoss).text,
  /Asset.*pUSD.*USDC/u,
);
assert.match(
  buildTelegramFundingProgressMessage(waitingAfterCapabilityLoss).text,
  /conversion is paused.*will resume/u,
  "a resumable pause must preserve the exact combined consent presentation",
);
const waitingWithLiveCapability = projectTelegramFundingProgress({
  automaticConversionAvailable: true,
  consent: automaticConsent,
  context,
  receipts: [],
  session,
  now: new Date("2026-08-05T12:03:00.000Z"),
});
assert.ok(waitingWithLiveCapability);
assert.equal(waitingWithLiveCapability?.automaticConversionEnabled, true);
assert.equal(waitingWithLiveCapability?.automaticConversionPaused, undefined);
assert.equal(
  buildTelegramFundingProgressMessage(waitingWithLiveCapability).text.includes(
    "USDC",
  ),
  true,
);
const waitingAfterHardInvalidation = projectTelegramFundingProgress({
  automaticConversionMode: "hard_invalid",
  consent: automaticConsent,
  context,
  receipts: [],
  session,
  now: new Date("2026-08-05T12:03:00.000Z"),
});
assert.equal(waitingAfterHardInvalidation?.state, "needs_attention");
assert.equal(waitingAfterHardInvalidation?.terminal, true);
assert.equal(waitingAfterHardInvalidation?.receiveAddress, null);
const detectedAfterReady = projectTelegramFundingProgress({
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      receiptId: "receipt-ready-pusd-before-usdce",
      asset: pUsd,
      handling: "direct",
      status: "ready",
      variantId: "variant-pusd",
    }),
    receipt({
      receiptId: "receipt-detected-usdce",
      asset: usdce,
      handling: "automatic_conversion",
      status: "observed",
      variantId: "variant-usdce",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(
  detectedAfterReady?.state,
  "funds_received",
  "new USDC.e evidence must not be hidden by an older ready pUSD receipt",
);
assert.equal(detectedAfterReady?.assetSymbol, "USDC.e");
const detectedWhilePaused = projectTelegramFundingProgress({
  automaticConversionMode: "soft_paused",
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      asset: usdce,
      handling: "automatic_conversion",
      status: "observed",
      variantId: "variant-usdce",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(detectedWhilePaused?.state, "waiting_for_routing");
assert.equal(detectedWhilePaused?.terminal, false);
assert.ok(detectedWhilePaused);
assert.match(
  buildTelegramFundingProgressMessage(detectedWhilePaused).text,
  /waiting for automatic routing to resume/u,
);
const detectedAfterHardInvalidation = projectTelegramFundingProgress({
  automaticConversionMode: "hard_invalid",
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      asset: usdce,
      handling: "automatic_conversion",
      status: "observed",
      variantId: "variant-usdce",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(detectedAfterHardInvalidation?.state, "needs_attention");
assert.equal(detectedAfterHardInvalidation?.terminal, true);
const convertingUsdce = projectTelegramFundingProgress({
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      asset: usdce,
      handling: "automatic_conversion",
      status: "routing",
      variantId: "variant-usdce",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(convertingUsdce?.state, "converting");
assert.ok(convertingUsdce);
assert.match(
  buildTelegramFundingProgressMessage(convertingUsdce).text,
  /Converting USDC/u,
);
const finalizingUsdce = projectTelegramFundingProgress({
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      asset: usdce,
      handling: "automatic_conversion",
      rawAmount: "10000",
      status: "routing",
      variantId: "variant-usdce",
    }),
    receipt({
      asset: pUsd,
      handling: "direct",
      rawAmount: "10000",
      status: "ready",
      variantId: "variant-pusd",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(finalizingUsdce?.state, "converting");
assert.ok(finalizingUsdce);
const finalizingUsdceMessage =
  buildTelegramFundingProgressMessage(finalizingUsdce).text;
assert.match(finalizingUsdceMessage, /Finalizing pUSD funding/u);
assert.match(finalizingUsdceMessage, /pUSD was detected/u);
assert.match(finalizingUsdceMessage, /Converting.*0\\\.01 USDC\\\.e/u);
assert.doesNotMatch(finalizingUsdceMessage, /original transfer/u);
const routingWhilePaused = projectTelegramFundingProgress({
  automaticConversionMode: "soft_paused",
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      asset: usdce,
      handling: "automatic_conversion",
      status: "routing",
      variantId: "variant-usdce",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(routingWhilePaused?.state, "waiting_for_routing");
assert.equal(routingWhilePaused?.terminal, false);
assert.match(
  buildTelegramFundingProgressMessage(routingWhilePaused).text,
  /waiting for automatic routing to resume/u,
);
const routingAfterHardInvalidation = projectTelegramFundingProgress({
  automaticConversionMode: "hard_invalid",
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      asset: usdce,
      handling: "automatic_conversion",
      status: "routing",
      variantId: "variant-usdce",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(routingAfterHardInvalidation?.state, "needs_attention");
assert.equal(routingAfterHardInvalidation?.terminal, true);
const routingReceiptAfterBoundary = receipt({
  receiptId: "receipt-routing-after-boundary",
  asset: usdce,
  handling: "automatic_conversion",
  status: "routing",
  variantId: "variant-usdce",
});
for (const automaticConversionMode of [
  "soft_paused",
  "hard_invalid",
] as const) {
  const routingAfterBoundary = projectTelegramFundingProgress({
    afterBroadcastBoundaryReceiptIds: [routingReceiptAfterBoundary.receiptId],
    automaticConversionMode,
    consent: automaticConsent,
    context,
    receipts: [routingReceiptAfterBoundary],
    session: { ...session, status: "processing" },
  });
  assert.equal(
    routingAfterBoundary?.state,
    "converting",
    "current capability must not reclassify a route after its durable broadcast boundary",
  );
  assert.equal(routingAfterBoundary?.terminal, false);
}
const routingAfterBoundaryWithPriorRecovery = projectTelegramFundingProgress({
  afterBroadcastBoundaryReceiptIds: [routingReceiptAfterBoundary.receiptId],
  automaticConversionMode: "hard_invalid",
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      receiptId: "receipt-prior-recovery",
      asset: pUsd,
      handling: "direct",
      status: "recovery_required",
      variantId: "variant-pusd",
    }),
    routingReceiptAfterBoundary,
  ],
  session: { ...session, status: "recovery_required" },
});
assert.equal(
  routingAfterBoundaryWithPriorRecovery?.state,
  "converting",
  "a durable in-flight route must not be masked by older recovery evidence",
);
assert.equal(routingAfterBoundaryWithPriorRecovery?.terminal, false);
const sequentialUsdce = projectTelegramFundingProgress({
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      receiptId: "receipt-ready-usdce",
      asset: usdce,
      handling: "automatic_conversion",
      status: "ready",
      variantId: "variant-usdce",
    }),
    receipt({
      receiptId: "receipt-routing-usdce",
      asset: usdce,
      handling: "automatic_conversion",
      status: "routing",
      variantId: "variant-usdce",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(
  sequentialUsdce?.state,
  "converting",
  "a later receipt keeps progress nonterminal until its own wrap completes",
);
const sourceReceiptInputs = [
  {
    receiptId: "receipt-source-001",
    rawAmount: "10000",
    observedAt: "2026-08-05T12:02:00.000Z",
  },
  {
    receiptId: "receipt-source-002",
    rawAmount: "40000",
    observedAt: "2026-08-05T12:03:00.000Z",
  },
  {
    receiptId: "receipt-source-003",
    rawAmount: "50000",
    observedAt: "2026-08-05T12:04:00.000Z",
  },
] as const;
const partialMultiReceipt = projectTelegramFundingProgress({
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      ...sourceReceiptInputs[0],
      asset: usdce,
      handling: "automatic_conversion",
      status: "ready",
      variantId: "variant-usdce",
    }),
    receipt({
      ...sourceReceiptInputs[1],
      asset: usdce,
      handling: "automatic_conversion",
      status: "routing",
      variantId: "variant-usdce",
    }),
    receipt({
      ...sourceReceiptInputs[2],
      asset: usdce,
      handling: "automatic_conversion",
      status: "observed",
      variantId: "variant-usdce",
    }),
    receipt({
      receiptId: "receipt-destination-001",
      asset: pUsd,
      handling: "direct",
      rawAmount: "10000",
      status: "ready",
      variantId: "variant-pusd",
    }),
  ],
  session: { ...session, status: "processing" },
});
assert.equal(partialMultiReceipt?.state, "converting");
assert.deepEqual(partialMultiReceipt?.receiptBreakdown, {
  sourceAssetSymbol: "USDC.e",
  sourceDecimals: 6,
  totalSourceRaw: "100000",
  queuedSourceRaw: "50000",
  convertingSourceRaw: "40000",
  readySourceRaw: "10000",
  attentionSourceRaw: "0",
  sourceReceiptCount: 3,
  destinationAssetSymbol: "pUSD",
  destinationDecimals: 6,
  readyDestinationRaw: "10000",
  destinationReceiptCount: 1,
  transfers: [
    { rawAmount: "10000", state: "ready" },
    { rawAmount: "40000", state: "converting" },
    { rawAmount: "50000", state: "queued" },
  ],
  hiddenTransferCount: 0,
});
assert.ok(partialMultiReceipt);
const partialMultiReceiptMessage =
  buildTelegramFundingProgressMessage(partialMultiReceipt);
assert.match(
  partialMultiReceiptMessage.text,
  /Total received.*0\\\.1 USDC\\\.e/u,
);
assert.match(partialMultiReceiptMessage.text, /Ready.*0\\\.01 pUSD/u);
assert.match(partialMultiReceiptMessage.text, /Converting.*0\\\.04 USDC\\\.e/u);
assert.match(partialMultiReceiptMessage.text, /Queued.*0\\\.05 USDC\\\.e/u);
assert.match(partialMultiReceiptMessage.text, /Transfers.*3/u);

const completedMultiReceipt = projectTelegramFundingProgress({
  consent: automaticConsent,
  context,
  receipts: [
    ...sourceReceiptInputs.map((source) =>
      receipt({
        ...source,
        asset: usdce,
        handling: "automatic_conversion",
        status: "ready",
        variantId: "variant-usdce",
      }),
    ),
    ...sourceReceiptInputs.map((destination, index) =>
      receipt({
        ...destination,
        receiptId: `receipt-destination-00${index + 1}`,
        asset: pUsd,
        handling: "direct",
        status: "ready",
        variantId: "variant-pusd",
      }),
    ),
  ],
  session: { ...session, status: "completed" },
});
assert.ok(completedMultiReceipt);
assert.equal(completedMultiReceipt.state, "ready");
assert.equal(
  completedMultiReceipt.rawAmount,
  "100000",
  "ready totals must never add source USDC.e and destination pUSD together",
);
assert.equal(completedMultiReceipt.sourceRawAmount, "100000");
assert.equal(
  completedMultiReceipt.receiptBreakdown?.readyDestinationRaw,
  "100000",
);
assert.deepEqual(
  parseTelegramFundingProgressProjection(completedMultiReceipt),
  completedMultiReceipt,
);
assert.equal(
  parseTelegramFundingProgressProjection({
    ...completedMultiReceipt,
    receiptBreakdown: {
      ...completedMultiReceipt.receiptBreakdown,
      totalSourceRaw: "100001",
    },
  }),
  null,
  "persisted receipt buckets must exactly reconcile to the source total",
);
const completedMultiReceiptMessage = buildTelegramFundingProgressMessage(
  completedMultiReceipt,
);
assert.match(
  completedMultiReceiptMessage.text,
  /0\\\.1 pUSD is now available/u,
);
assert.doesNotMatch(completedMultiReceiptMessage.text, /0\\\.2 pUSD/u);
const mixedRecovery = projectTelegramFundingProgress({
  consent: automaticConsent,
  context,
  receipts: [
    receipt({
      receiptId: "receipt-recovery-pusd",
      asset: pUsd,
      handling: "direct",
      status: "recovery_required",
      variantId: "variant-pusd",
    }),
    receipt({
      receiptId: "receipt-recovery-usdce",
      asset: usdce,
      handling: "automatic_conversion",
      status: "recovery_required",
      variantId: "variant-usdce",
    }),
  ],
  session: { ...session, status: "recovery_required" },
});
assert.equal(mixedRecovery?.assetSymbol, "Multiple assets");
assert.equal(mixedRecovery?.rawAmount, null);
assert.deepEqual(
  classifyTelegramEditFailure({
    description: "Bad Request: message is not modified",
    messageId: 100,
    responseOk: false,
    status: 400,
  }),
  { messageId: 100, ok: true },
);
assert.deepEqual(
  classifyTelegramEditFailure({
    description: "Bad Gateway",
    messageId: 100,
    responseOk: false,
    status: 502,
  }),
  { error: "ambiguous", message: "Bad Gateway", ok: false },
);

const cancelled = projectTelegramFundingProgress({
  consent,
  context: { ...context, cancelledAt: "2026-08-05T12:04:00.000Z" },
  receipts: [],
  session: { ...session, status: "cancelled" },
});
assert.equal(cancelled?.state, "cancelled");
assert.ok(cancelled);
const cancelledAfterReceipt = projectTelegramFundingProgress({
  consent,
  context: { ...context, cancelledAt: "2026-08-05T12:04:00.000Z" },
  receipts: [receipt({ asset: pUsd, handling: "direct", status: "observed" })],
  session: { ...session, status: "processing" },
});
assert.equal(
  cancelledAfterReceipt?.state,
  "cancelled",
  "cancellation must terminate a non-ready receipt projection",
);
const readyAfterCancellation = projectTelegramFundingProgress({
  consent,
  context: { ...context, cancelledAt: "2026-08-05T12:04:00.000Z" },
  receipts: [receipt({ asset: pUsd, handling: "direct", status: "ready" })],
  session: { ...session, status: "cancelled" },
});
assert.equal(
  readyAfterCancellation?.state,
  "ready",
  "late direct pUSD evidence remains visible without granting automation authority",
);
assert.equal(
  canDiscloseTelegramFundingAddress({
    context,
    now: new Date("2026-08-05T12:03:00.000Z"),
    projection: waiting,
    session,
  }),
  true,
);
for (const terminalCase of [
  {
    context: { ...context, cancelledAt: "2026-08-05T12:04:00.000Z" },
    now: new Date("2026-08-05T12:05:00.000Z"),
    projection: cancelled,
    session: { ...session, status: "cancelled" as const },
  },
  {
    context: { ...context, expiresAt: "2026-08-05T12:00:00.000Z" },
    now: new Date("2026-08-05T12:05:00.000Z"),
    projection: null,
    session: { ...session, status: "expired" as const },
  },
  {
    context,
    now: new Date("2026-08-05T12:05:00.000Z"),
    projection: ready,
    session: { ...session, status: "completed" as const },
  },
]) {
  assert.equal(
    canDiscloseTelegramFundingAddress(terminalCase),
    false,
    "terminal QR callbacks must not redisclose the receive address",
  );
}
assert.equal(
  projectTelegramFundingProgress({
    consent: null,
    context: { ...context, expiresAt: "2026-08-05T11:00:00.000Z" },
    receipts: [],
    session: { ...session, status: "expired" },
    now: new Date("2026-08-05T12:00:00.000Z"),
  }),
  null,
  "an unselected context must not create an unsolicited late expiry card",
);

const defaultPolicy = getDefaultSignalBotPolicy();
assert.equal(defaultPolicy.buyContinuationEnabled, false);
assert.equal(defaultPolicy.fundingReceiveEnabled, false);
assert.equal(defaultPolicy.customTradeInputEnabled, false);
assert.equal(defaultPolicy.miniAppHandoffContractVersion, 1);
assert.equal(defaultPolicy.miniAppHandoffMode, "off");
const {
  buyContinuationEnabled: _legacyMissingBuyContinuationEnabled,
  customTradeInputEnabled: _legacyMissingCustomTradeInputEnabled,
  fundingReceiveEnabled: _legacyMissingFundingReceiveEnabled,
  miniAppHandoffContractVersion: _legacyMissingMiniAppHandoffContractVersion,
  miniAppHandoffMode: _legacyMissingMiniAppHandoffMode,
  ...productionLegacyPolicyPayload
} = defaultPolicy;
assert.equal(_legacyMissingFundingReceiveEnabled, false);
assert.equal(_legacyMissingCustomTradeInputEnabled, false);
assert.equal(_legacyMissingBuyContinuationEnabled, false);
assert.equal(_legacyMissingMiniAppHandoffContractVersion, 1);
assert.equal(_legacyMissingMiniAppHandoffMode, "off");
assert.deepEqual(signalBotSchema.parse({ buyContinuationEnabled: "true" }), {
  buyContinuationEnabled: true,
});
assert.deepEqual(signalBotSchema.parse({ miniAppHandoffMode: "fallback" }), {
  miniAppHandoffMode: "fallback",
});
assert.deepEqual(signalBotSchema.parse({ miniAppHandoffContractVersion: 2 }), {
  miniAppHandoffContractVersion: 2,
});
assert.equal(
  signalBotSchema.safeParse({ miniAppHandoffMode: "when_possible" }).success,
  false,
  "the Mini App handoff policy accepts only explicit delivery modes",
);
assert.equal(
  signalBotSchema.safeParse({ buyContinuationEnabled: "enabled" }).success,
  false,
  "the admin/runtime schema accepts only strict boolean policy values",
);
const productionLegacyPolicy = normalizeSignalBotPolicy({
  ...productionLegacyPolicyPayload,
  autoEnableOnTelegramLink: true,
  tradingEnabled: true,
  tradingActions: ["buy", "sell"],
  tradingVenues: ["polymarket"],
});
assert.equal(productionLegacyPolicy.tradingEnabled, true);
assert.equal(productionLegacyPolicy.autoEnableOnTelegramLink, true);
assert.equal(productionLegacyPolicy.buyContinuationEnabled, false);
assert.equal(productionLegacyPolicy.fundingReceiveEnabled, false);
assert.equal(productionLegacyPolicy.customTradeInputEnabled, false);
assert.equal(productionLegacyPolicy.miniAppHandoffContractVersion, 1);
assert.equal(productionLegacyPolicy.miniAppHandoffMode, "off");
const alwaysHandoffPolicy = normalizeSignalBotPolicy({
  ...defaultPolicy,
  miniAppHandoffMode: "always",
});
assert.equal(alwaysHandoffPolicy.miniAppHandoffMode, "always");
const receiveOnlyPolicy = normalizeSignalBotPolicy({
  ...defaultPolicy,
  fundingReceiveEnabled: true,
  tradingEnabled: false,
  tradingActions: [],
  tradingVenues: [],
});
assert.equal(receiveOnlyPolicy.fundingReceiveEnabled, true);
assert.equal(receiveOnlyPolicy.tradingEnabled, false);
const continuationOnlyPolicy = normalizeSignalBotPolicy({
  ...defaultPolicy,
  buyContinuationEnabled: true,
});
assert.equal(continuationOnlyPolicy.buyContinuationEnabled, true);
assert.equal(
  resolveFundingReceiveSelectedTargetId(undefined, receiveTargetId),
  receiveTargetId,
  "web omission preserves the recommended default",
);
assert.equal(
  resolveFundingReceiveSelectedTargetId(null, receiveTargetId),
  receiveTargetId,
  "public web null preserves the existing recommended-target behavior",
);
assert.equal(
  resolveFundingReceiveSelectedTargetId(null, receiveTargetId, "telegram"),
  null,
  "Telegram explicit null opens without a selected target",
);
{
  let requestedOwner: string | null = null;
  await loadTelegramFundingReceiveSession(
    {
      get: async (_userId, _receiveSessionId, ownerChannel) => {
        requestedOwner = ownerChannel ?? null;
        return null;
      },
    },
    "user-1",
    receiveSessionId,
  );
  assert.equal(
    requestedOwner,
    "telegram",
    "all Telegram session reads must stay isolated from web ownership",
  );
}

{
  let routingSql = "";
  await listFundingReceiveReceiptsForRouting(
    {
      query: async (sql: string) => {
        routingSql = sql.replace(/\s+/gu, " ").toLowerCase();
        return { rows: [], rowCount: 0 };
      },
    } as never,
    { limit: 1, now: new Date() },
  );
  assert.match(
    routingSql,
    /session\.owner_channel = 'web' and session\.selected_receive_target_id is not null/u,
    "web authority must be selected explicitly by the canonical owner channel",
  );
  assert.match(
    routingSql,
    /consent\.consented_at <= canonical_event\.first_observed_at/u,
    "Telegram routing must use consent already present at immutable first observation",
  );
  assert.match(
    routingSql,
    /order by consent\.consented_at desc, consent\.revision desc/u,
    "Telegram routing must choose the latest exact historical consent",
  );
  assert.match(
    routingSql,
    /receipt\.ledger_height > .*ledgerheightexclusive/u,
    "prospective authority must compare the canonical event height to the frozen cursor",
  );
  assert.doesNotMatch(
    routingSql,
    /consent\.revision = telegram_context\.active_consent_revision/u,
    "a later active consent must never retroactively authorize an old transfer",
  );
}

{
  let finishOpen!: (
    value: ReturnType<typeof buildTelegramFundingTargetMessage>,
  ) => void;
  const slowOpen = new Promise<
    ReturnType<typeof buildTelegramFundingTargetMessage>
  >((resolve) => {
    finishOpen = resolve;
  });
  let loads = 0;
  let renders = 0;
  const loadFunding = async () => {
    loads += 1;
    return slowOpen;
  };
  const handled = await handleSignalBotInteractiveMenuCallback({
    callbackPrefix: "hm:v1:",
    chatId: "42",
    idempotencyKey: "callback-open-1",
    loadFunding,
    messageId: 100,
    redis: { get: async () => null },
    render: async () => {
      renders += 1;
    },
    renderExpiredSearch: async () => undefined,
    route: { kind: "deposit", showQr: false, venue: "polymarket" },
    telegramUserId: 42,
  });
  const replayed = await handleSignalBotInteractiveMenuCallback({
    callbackPrefix: "hm:v1:",
    chatId: "42",
    idempotencyKey: "callback-open-2",
    loadFunding,
    messageId: 100,
    redis: { get: async () => null },
    render: async () => {
      renders += 1;
    },
    renderExpiredSearch: async () => undefined,
    route: { kind: "deposit", showQr: false, venue: "polymarket" },
    telegramUserId: 42,
  });
  assert.equal(handled, true);
  assert.equal(replayed, true);
  assert.equal(loads, 1, "same-card funding opens must share one API request");
  assert.equal(renders, 0, "session open must not block the update loop");
  finishOpen(
    buildTelegramFundingTargetMessage({
      automaticConversion: false,
      contextId,
      expiresAt,
      presentation: telegramPolygonFundingPresentation("pusd_direct"),
    }),
  );
  assert.equal(await drainSignalBotFundingOpenTasks(1_000), true);
  assert.equal(
    renders,
    2,
    "the latest callback gets a render after coalescing",
  );
}

{
  let finishOpen!: (
    value: ReturnType<typeof buildTelegramFundingTargetMessage>,
  ) => void;
  const slowOpen = new Promise<
    ReturnType<typeof buildTelegramFundingTargetMessage>
  >((resolve) => {
    finishOpen = resolve;
  });
  let loads = 0;
  for (let index = 0; index < 4; index += 1) {
    await handleSignalBotInteractiveMenuCallback({
      callbackPrefix: "hm:v1:",
      chatId: String(100 + index),
      idempotencyKey: `callback-capacity-${index}`,
      loadFunding: async () => {
        loads += 1;
        return slowOpen;
      },
      messageId: 200 + index,
      redis: { get: async () => null },
      render: async () => undefined,
      renderExpiredSearch: async () => undefined,
      route: { kind: "deposit", showQr: false, venue: "polymarket" },
      telegramUserId: 100 + index,
    });
  }
  let busyText = "";
  await handleSignalBotInteractiveMenuCallback({
    callbackPrefix: "hm:v1:",
    chatId: "999",
    idempotencyKey: "callback-capacity-busy",
    loadFunding: async () => {
      assert.fail("a saturated funding-open pool must fail fast");
    },
    messageId: 999,
    redis: { get: async () => null },
    render: async (message) => {
      busyText = message.text;
    },
    renderExpiredSearch: async () => undefined,
    route: { kind: "deposit", showQr: false, venue: "polymarket" },
    telegramUserId: 999,
  });
  assert.equal(loads, 4);
  assert.match(busyText, /Receive busy/u);
  assert.equal(await drainSignalBotFundingOpenTasks(1), false);
  finishOpen(
    buildTelegramFundingTargetMessage({
      automaticConversion: false,
      contextId,
      expiresAt,
      presentation: telegramPolygonFundingPresentation("pusd_direct"),
    }),
  );
  assert.equal(await drainSignalBotFundingOpenTasks(1_000), true);
}

{
  const addressMessage = buildTelegramFundingDeliveryQueuedMessage({
    contextId,
  });
  let renders = 0;
  const handled = await handleSignalBotInteractiveMenuCallback({
    callbackPrefix: "hm:v1:",
    chatId: "42",
    idempotencyKey: "callback-durable-qr-1",
    loadFunding: async () => addressMessage,
    messageId: 100,
    redis: { get: async () => null },
    render: async () => {
      renders += 1;
    },
    renderExpiredSearch: async () => undefined,
    route: { contextId, kind: "qr" },
    telegramUserId: 42,
  });
  assert.equal(handled, true);
  assert.equal(renders, 0);
}

{
  const fundingServiceSource = readFileSync(
    new URL("./services/telegram-funding.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    fundingServiceSource,
    /or telegram_bot_action_outbox\.status = 'sent'\s+returning id/u,
    "an explicit QR callback must re-arm a previously delivered photo after Hide",
  );
}

{
  const terminalMessage = buildTelegramFundingProgressMessage(cancelled);
  let renderedText = "";
  const handled = await handleSignalBotInteractiveMenuCallback({
    callbackPrefix: "hm:v1:",
    chatId: "42",
    idempotencyKey: "callback-terminal-qr-1",
    loadFunding: async () => terminalMessage,
    messageId: 100,
    redis: { get: async () => null },
    render: async (message) => {
      renderedText = message.text;
    },
    renderExpiredSearch: async () => undefined,
    route: { contextId, kind: "qr" },
    telegramUserId: 42,
  });
  assert.equal(handled, true);
  assert.doesNotMatch(renderedText, new RegExp(address, "u"));
  assert.match(
    renderedText,
    /Receive cancelled/u,
    "a terminal QR callback must render the safe terminal card",
  );
}

function deliveryPool(input: {
  action?:
    | "funding_edit"
    | "funding_replacement"
    | "funding_send"
    | "funding_qr";
  controllerCurrent?: boolean;
  currentTelegramAccountId?: string | null;
  currentProgressRevision?: number;
  currentProjection?: TelegramFundingProgressProjection;
  deliveryCas?: boolean;
  attemptCount?: number;
  outboxTelegramMessageId?: number | null;
  projection?: TelegramFundingProgressProjection;
  destinations: Array<{
    active_buy_return_revision: number | null;
    address_disclosure_attempt_revision: number;
    address_disclosure_message_id: number | null;
    address_delivered_revision: number;
    address_redacted_revision: number;
    automation_enabled: boolean;
    cancelled_at: Date | null;
    destination_option_id: string;
    expires_at: Date;
    policy_snapshot: unknown;
    receive_status: string;
    receive_session_id: string;
    telegram_account_id: string | null;
    telegram_user_id: string;
    telegram_message_id: number | null;
    latest_terminal_projection?: unknown;
    progress_revision: number;
    user_id: string;
    venue_binding_option_id: string;
  } | null>;
}) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const destinations = [...input.destinations];
  const fallbackProjection = input.projection ?? ready;
  assert.ok(fallbackProjection);
  const query = async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
    statements.push(normalized);
    parameters.push(params);
    if (
      normalized === "begin" ||
      normalized === "commit" ||
      normalized === "rollback"
    ) {
      return { rows: [], rowCount: null };
    }
    if (normalized.startsWith("with unknown as")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes("select pg_advisory_xact_lock(")) {
      return { rows: [{ locked: null }], rowCount: 1 };
    }
    if (normalized.includes("select destination_target_snapshot #>>")) {
      return {
        rows: [
          {
            controller_wallet_id:
              input.controllerCurrent === false
                ? "wallet_previous_controller"
                : deliveryControllerWalletId,
            destination_network_id: "evm:137",
          },
        ],
        rowCount: 1,
      };
    }
    if (
      normalized.includes(
        "from telegram_bot_trading_authorizations trading_authorization",
      )
    ) {
      return {
        rows: [
          {
            privy_wallet_id: "privy-wallet-1",
            user_wallet_id: "user-wallet-1",
            wallet_address: address,
          },
        ],
        rowCount: 1,
      };
    }
    if (
      normalized.startsWith("select") &&
      normalized.includes("from telegram_bot_action_outbox outbox") &&
      normalized.includes("order by outbox.next_attempt_at")
    ) {
      return {
        rows: [
          {
            id: "outbox-1",
            action: input.action ?? "funding_edit",
            funding_session_id: contextId,
            state_revision: 1,
            payload: fallbackProjection,
            attempt_count: Math.max(0, (input.attemptCount ?? 1) - 1),
            telegram_message_id: input.outboxTelegramMessageId ?? null,
            user_id: "user-1",
          },
        ],
        rowCount: 1,
      };
    }
    if (
      normalized.startsWith("update telegram_funding_sessions") &&
      normalized.includes("set delivery_lease_outbox_id = $2")
    ) {
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith("update telegram_bot_action_outbox") &&
      normalized.includes("set status = 'sending'")
    ) {
      return {
        rows: [{ attempt_count: input.attemptCount ?? 1 }],
        rowCount: 1,
      };
    }
    if (
      normalized.startsWith("select") &&
      normalized.includes("from telegram_funding_sessions context") &&
      normalized.includes("join user_telegram_accounts account")
    ) {
      const destination = destinations.shift() ?? null;
      return {
        rows: destination
          ? [
              {
                ...destination,
                latest_terminal_projection:
                  destination.latest_terminal_projection !== undefined
                    ? destination.latest_terminal_projection
                    : fallbackProjection.terminal
                      ? fallbackProjection
                      : null,
                latest_progress_projection: fallbackProjection,
                user_id: "user-1",
              },
            ]
          : [],
        rowCount: destination ? 1 : 0,
      };
    }
    if (normalized.startsWith("select desired_enabled")) {
      return {
        rows: [{ desired_enabled: true, funding_operator_revoked_at: null }],
        rowCount: 1,
      };
    }
    if (normalized.includes("from runtime_policies")) {
      return { rows: [], rowCount: 0 };
    }
    if (
      normalized.includes(
        "from telegram_funding_authorizations funding_authorization",
      )
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      normalized.startsWith("select") &&
      normalized.includes("from telegram_bot_action_outbox outbox") &&
      normalized.includes("join user_telegram_accounts account")
    ) {
      const destination = destinations.shift() ?? null;
      return {
        rows: destination
          ? [
              {
                ...destination,
                latest_terminal_projection:
                  destination.latest_terminal_projection !== undefined
                    ? destination.latest_terminal_projection
                    : fallbackProjection.terminal
                      ? fallbackProjection
                      : null,
                latest_progress_projection: fallbackProjection,
                user_id: "user-1",
              },
            ]
          : [],
        rowCount: destination ? 1 : 0,
      };
    }
    if (
      normalized.startsWith("select") &&
      normalized.includes("from telegram_bot_action_outbox outbox") &&
      normalized.includes("for update of outbox, context")
    ) {
      return {
        rows:
          input.deliveryCas === false
            ? []
            : [
                {
                  current_telegram_account_id:
                    input.currentTelegramAccountId === undefined
                      ? "telegram-account-1"
                      : input.currentTelegramAccountId,
                  latest_progress_projection:
                    input.currentProjection ?? fallbackProjection,
                  progress_revision: input.currentProgressRevision ?? 1,
                  telegram_user_id: "42",
                  user_id: "user-1",
                },
              ],
        rowCount: input.deliveryCas === false ? 0 : 1,
      };
    }
    if (
      normalized.startsWith("update telegram_funding_sessions context") &&
      normalized.includes("last_delivered_revision")
    ) {
      return { rows: [{ progress_revision: 1 }], rowCount: 1 };
    }
    if (normalized.startsWith("insert into telegram_bot_action_outbox")) {
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update telegram_bot_action_outbox")) {
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update telegram_funding_sessions")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected delivery SQL: ${normalized}`);
  };
  const client = { query, release() {} };
  return {
    pool: { query, connect: async () => client } as never,
    parameters,
    statements,
  };
}

const destination = {
  active_buy_return_revision: 1,
  address_disclosure_attempt_revision: 0,
  address_disclosure_message_id: null,
  address_delivered_revision: 0,
  address_redacted_revision: 0,
  automation_enabled: false,
  cancelled_at: null,
  destination_option_id: "polymarket-deposit",
  expires_at: new Date("2099-01-01T00:00:00.000Z"),
  policy_snapshot: {},
  receive_status: "open",
  receive_session_id: "receive-session-1",
  telegram_account_id: "telegram-account-1",
  telegram_user_id: "42",
  telegram_message_id: 100,
  progress_revision: 1,
  user_id: "user-1",
  venue_binding_option_id: "polymarket-deposit-wallet",
};

assert.equal(
  requiresCurrentFundingPolicyForAddressDelivery({
    action: "funding_edit",
    addressDeliveredRevision: 0,
  }),
  true,
  "the first address edit must match its frozen Funding Policy revision",
);
assert.equal(
  requiresCurrentFundingPolicyForAddressDelivery({
    action: "funding_edit",
    addressDeliveredRevision: 1,
  }),
  false,
  "an already disclosed card may still be edited into a soft-paused state",
);
for (const action of [
  "funding_send",
  "funding_replacement",
  "funding_qr",
] as const) {
  assert.equal(
    requiresCurrentFundingPolicyForAddressDelivery({
      action,
      addressDeliveredRevision: 1,
    }),
    true,
    `${action} materializes the address again and requires the frozen revision`,
  );
}
const deliveryControllerWalletId = stableWalletOpaqueId({
  walletType: "ethereum",
  networkId: "evm:137",
  address,
});

{
  const fake = deliveryPool({ destinations: [destination] });
  class StatefulTelegramClient {
    readonly baseUrl = "https://api.telegram.test";
    edits = 0;

    async editMessageText() {
      assert.equal(
        this.baseUrl,
        "https://api.telegram.test",
        "funding delivery must preserve the Telegram client receiver",
      );
      this.edits += 1;
      return { ok: true as const, messageId: 100 };
    }

    async sendMessage() {
      assert.fail("a successful bound edit must not fall back to send");
      return { ok: true as const, messageId: 101 };
    }
  }
  const telegram = new StatefulTelegramClient();
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram,
  });
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(telegram.edits, 1);
}

{
  // The main address edit records its durable redaction obligation first.
  const fake = deliveryPool({
    destinations: [destination, destination, destination],
    projection: waiting,
  });
  let boundaryCommittedBeforeDelivery = false;
  let disclosureMarkedBeforeDelivery = false;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        const markIndex = fake.statements.findIndex((statement) =>
          statement.includes("set address_disclosure_attempt_revision"),
        );
        boundaryCommittedBeforeDelivery =
          markIndex >= 0 &&
          fake.statements.slice(markIndex + 1).includes("commit");
        disclosureMarkedBeforeDelivery = fake.statements.some((statement) =>
          statement.includes("set address_disclosure_attempt_revision"),
        );
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        assert.fail("an editable address card must not fall back to send");
      },
    },
  });
  assert.equal(result.sent, 1);
  assert.equal(
    boundaryCommittedBeforeDelivery,
    true,
    "the disclosure CAS must commit before Telegram network I/O",
  );
  assert.equal(
    disclosureMarkedBeforeDelivery,
    true,
    "the durable redaction obligation must precede Telegram address egress",
  );
  const disclosureCasSql = fake.statements.find((statement) =>
    statement.includes("set address_disclosure_attempt_revision"),
  );
  assert.match(disclosureCasSql ?? "", /context\.cancelled_at is null/u);
  assert.match(disclosureCasSql ?? "", /context\.expires_at > now\(\)/u);
  assert.match(
    disclosureCasSql ?? "",
    /not exists \( select 1 from telegram_funding_sessions newer/u,
  );
  assert.match(disclosureCasSql ?? "", /receive\.status = 'open'/u);
  assert.match(disclosureCasSql ?? "", /receive\.expires_at > now\(\)/u);
  assert.equal(
    fake.statements.some((statement) =>
      statement.includes("select pg_advisory_lock("),
    ),
    false,
    "address delivery must not hold session advisory locks over Telegram I/O",
  );
  const addressProofUpdate = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_funding_sessions context") &&
      statement.includes("address_delivered_revision"),
  );
  assert.ok(addressProofUpdate >= 0);
  assert.equal(fake.parameters[addressProofUpdate]?.[7], true);
  const claimSql = fake.statements.find((statement) =>
    statement.includes("order by outbox.next_attempt_at"),
  );
  assert.match(claimSql ?? "", /delivery_unknown/u);
  assert.match(
    claimSql ?? "",
    /address_disclosure_attempt_revision > context\.address_redacted_revision/u,
  );
  assert.match(claimSql ?? "", /outbox\.payload->>'terminal' = 'true'/u);
  assert.match(claimSql ?? "", /receiveaddress/u);
}

for (const closedDestination of [
  { ...destination, cancelled_at: new Date("2026-08-05T12:00:01.000Z") },
  { ...destination, expires_at: new Date("2026-08-05T11:59:59.000Z") },
  { ...destination, receive_status: "cancelled" },
]) {
  const fake = deliveryPool({
    destinations: [closedDestination],
    projection: waiting,
  });
  let edits = 0;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        edits += 1;
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        assert.fail("a closed receive context must never disclose an address");
      },
    },
  });
  assert.equal(edits, 0);
  assert.equal(result.skipped, 1);
}

{
  const fake = deliveryPool({
    destinations: [destination, destination],
    projection: waiting,
  });
  let markedBeforeAmbiguousEdit = false;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        markedBeforeAmbiguousEdit = fake.statements.some((statement) =>
          statement.includes("set address_disclosure_attempt_revision"),
        );
        throw new Error("transport outcome unknown");
      },
      sendMessage: async () => {
        assert.fail("an address edit must not fall back to send");
      },
    },
  });
  assert.equal(markedBeforeAmbiguousEdit, true);
  assert.equal(result.failed, 1);
  assert.equal(
    fake.statements.some(
      (statement) =>
        statement.includes("last_delivered_revision") &&
        statement.includes("address_delivered_revision"),
    ),
    false,
    "an unacknowledged edit must retain only the disclosure obligation",
  );
}

{
  const buyWaiting = {
    ...waiting,
    minimumFundingUsd: "0.37",
  } satisfies TelegramFundingProgressProjection;
  const fake = deliveryPool({
    action: "funding_qr",
    destinations: [destination, destination],
    projection: buyWaiting,
  });
  let qrPhoto: number[] = [];
  let qrCaption = "";
  let qrReplyMarkup: TelegramFundingMessage["reply_markup"];
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        assert.fail("a PNG QR must not replace the funding card text");
      },
      sendMessage: async () => {
        assert.fail("a PNG QR must use Telegram sendPhoto");
      },
      sendPhoto: async (message) => {
        qrPhoto = Array.from(message.photo);
        qrCaption = message.caption ?? "";
        qrReplyMarkup = message.reply_markup;
        return { ok: true, messageId: 150 };
      },
    },
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(
    qrPhoto.slice(0, 8),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.match(qrCaption, /Polymarket funding QR/u);
  assert.match(qrCaption, /Minimum to add:\* \$0\\\.37/u);
  assert.doesNotMatch(qrCaption, new RegExp(address, "u"));
  assert.deepEqual(qrReplyMarkup, {
    inline_keyboard: [
      [
        {
          callback_data: telegramFundingCallbackData({
            contextId,
            kind: "hide_qr",
          }),
          text: "🙈 Hide",
        },
      ],
    ],
  });
  const contextAttachIndex = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_funding_sessions context") &&
      statement.includes("last_delivered_revision"),
  );
  assert.equal(
    fake.parameters[contextAttachIndex]?.[9],
    false,
    "a QR photo must not advance the funding card delivery watermark",
  );
}

{
  const detectedForQrCleanup = {
    ...waiting,
    observedAt: "2026-08-05T12:02:00.000Z",
    rawAmount: "10000",
    receiveAddress: null,
    state: "funds_received",
  } satisfies TelegramFundingProgressProjection;
  const fake = deliveryPool({
    action: "funding_qr",
    destinations: [destination],
    outboxTelegramMessageId: 153,
    projection: detectedForQrCleanup,
  });
  let deletedMessageId: number | null = null;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      deleteMessage: async (message) => {
        deletedMessageId = message.message_id;
        return { ok: true, messageId: message.message_id };
      },
      sendMessage: async () => {
        assert.fail("a detected receipt must delete the tracked QR");
      },
    },
  });
  assert.equal(result.sent, 1);
  assert.equal(deletedMessageId, 153);
}

{
  const fake = deliveryPool({
    action: "funding_qr",
    currentTelegramAccountId: "telegram-account-2",
    destinations: [destination, destination],
    projection: waiting,
  });
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      sendMessage: async () => {
        assert.fail("a QR must use sendPhoto");
      },
      sendPhoto: async () => ({ ok: true, messageId: 152 }),
    },
  });
  assert.equal(result.sent, 1);
  const accountChangeIndex = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_funding_sessions") &&
      statement.includes("$8::boolean"),
  );
  assert.equal(
    fake.parameters[accountChangeIndex]?.[7],
    false,
    "a QR photo must never become the funding card edit target",
  );
}

{
  const fake = deliveryPool({
    action: "funding_qr",
    currentProgressRevision: 2,
    currentProjection: cancelled,
    destinations: [destination, destination],
    projection: waiting,
  });
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      sendMessage: async () => assert.fail("a QR must use sendPhoto"),
      sendPhoto: async () => ({ ok: true, messageId: 151 }),
    },
  });
  assert.equal(result.sent, 1);
  const rearmIndex = fake.statements.findIndex((statement) =>
    statement.includes("set status = case when $5::boolean"),
  );
  assert.equal(fake.parameters[rearmIndex]?.[4], true);
  assert.equal(fake.parameters[rearmIndex]?.[5], 2);
  assert.equal(
    JSON.parse(String(fake.parameters[rearmIndex]?.[6])).terminal,
    true,
    "a QR accepted during Cancel must immediately become a tracked deletion",
  );
}

{
  const fake = deliveryPool({
    action: "funding_qr",
    destinations: [
      {
        ...destination,
        latest_terminal_projection: cancelled,
        receive_status: "cancelled",
      },
    ],
    outboxTelegramMessageId: 150,
    projection: cancelled,
  });
  let deletedMessageId: number | null = null;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      deleteMessage: async (message) => {
        deletedMessageId = message.message_id;
        return { ok: true, messageId: message.message_id };
      },
      sendMessage: async () => {
        assert.fail("terminal QR cleanup must delete the tracked photo");
      },
    },
  });
  assert.equal(result.sent, 1);
  assert.equal(deletedMessageId, 150);
  const claimSql = fake.statements.find((statement) =>
    statement.includes("unknown.status = 'delivery_unknown'"),
  );
  assert.match(
    claimSql ?? "",
    /outbox\.action = 'funding_qr'.*outbox\.telegram_message_id is not null.*outbox\.payload->>'terminal' = 'true'/u,
    "an unrelated unknown card delivery must not block idempotent QR deletion",
  );
}

{
  const fake = deliveryPool({
    action: "funding_qr",
    destinations: [
      {
        ...destination,
        latest_terminal_projection: cancelled,
        receive_status: "cancelled",
      },
    ],
    outboxTelegramMessageId: 150,
    projection: cancelled,
  });
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      deleteMessage: async () => ({
        error: "blocked_or_missing",
        message: "bot was blocked",
        ok: false,
      }),
      sendMessage: async () => {
        assert.fail("terminal QR cleanup must never send a replacement");
      },
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(result.blocked, 0);
  const finishIndex = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_bot_action_outbox") &&
      statement.includes("set status = $3"),
  );
  assert.equal(fake.parameters[finishIndex]?.[2], "retry");
}

{
  const fake = deliveryPool({
    controllerCurrent: false,
    destinations: [destination],
  });
  let edits = 0;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        edits += 1;
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        assert.fail("a stale managed-wallet projection must not be sent");
      },
    },
  });
  assert.equal(edits, 0);
  assert.equal(result.skipped, 1);
}

{
  const fake = deliveryPool({
    controllerCurrent: false,
    currentTelegramAccountId: null,
    destinations: [
      {
        ...destination,
        active_buy_return_revision: null,
        address_disclosure_attempt_revision: 1,
        address_disclosure_message_id: 100,
        telegram_account_id: null,
      },
    ],
    projection: unavailable,
  });
  let redactionText = "";
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async (message) => {
        redactionText = message.text;
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        assert.fail("an unlinked address card must be redacted in place");
      },
    },
  });
  assert.equal(result.sent, 1);
  assert.match(redactionText, /Receive unavailable/u);
  assert.doesNotMatch(redactionText, new RegExp(address, "u"));
}

{
  const fake = deliveryPool({
    controllerCurrent: false,
    currentTelegramAccountId: null,
    destinations: [
      {
        ...destination,
        address_disclosure_attempt_revision: 1,
        address_disclosure_message_id: 100,
        telegram_account_id: null,
      },
    ],
    projection: unavailable,
  });
  let resolved = 0;
  let redactionText = "";
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    resolveMessage: async () => {
      resolved += 1;
      throw new Error("unlinked Buy continuation is unavailable");
    },
    telegram: {
      editMessageText: async (message) => {
        redactionText = message.text;
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        assert.fail("safe redaction must remain an edit of the frozen card");
      },
    },
  });
  assert.equal(result.sent, 1);
  assert.equal(
    resolved,
    0,
    "safe redaction must not depend on a live account or Buy decorator",
  );
  assert.match(redactionText, /Receive unavailable/u);
  assert.doesNotMatch(redactionText, new RegExp(address, "u"));
}

{
  const fake = deliveryPool({
    attemptCount: 8,
    controllerCurrent: false,
    currentTelegramAccountId: null,
    destinations: [
      {
        ...destination,
        active_buy_return_revision: null,
        address_disclosure_attempt_revision: 1,
        address_disclosure_message_id: 100,
        telegram_account_id: null,
      },
    ],
    projection: unavailable,
  });
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => ({
        error: "ambiguous",
        message: "transport outcome unknown",
        ok: false,
      }),
      sendMessage: async () => {
        assert.fail("redaction must remain an edit of the known card");
      },
    },
  });
  assert.equal(result.failed, 1);
  const finishIndex = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_bot_action_outbox") &&
      statement.includes("set status = $3"),
  );
  assert.ok(finishIndex >= 0);
  assert.equal(
    fake.parameters[finishIndex]?.[2],
    "retry",
    "a transient redaction failure remains retryable beyond the ordinary cap",
  );
}

{
  const fake = deliveryPool({
    controllerCurrent: false,
    currentTelegramAccountId: null,
    destinations: [
      {
        ...destination,
        active_buy_return_revision: null,
        address_disclosure_attempt_revision: 1,
        address_disclosure_message_id: 100,
        telegram_account_id: null,
      },
    ],
    projection: unavailable,
  });
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => ({
        error: "message_not_editable",
        message: "message to edit not found",
        ok: false,
      }),
      sendMessage: async () => {
        assert.fail("redaction must not send an address-free replacement");
      },
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(
    fake.statements.some((statement) =>
      statement.startsWith("insert into telegram_bot_action_outbox"),
    ),
    false,
    "a replacement card cannot prove that the old address was redacted",
  );
}

{
  const fake = deliveryPool({
    destinations: [
      {
        ...destination,
        automation_enabled: true,
        policy_snapshot: automaticPolicySnapshot,
      },
    ],
    projection: waitingWithLiveCapability,
  });
  const telegram = successfulTelegramCounter();
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: telegram.client,
  });
  assert.equal(result.skipped, 1);
  assert.equal(
    telegram.calls(),
    0,
    "queued automatic address delivery must recheck its frozen authority",
  );
}

{
  const fake = deliveryPool({
    destinations: [{ ...destination, active_buy_return_revision: null }],
  });
  let resolved = 0;
  let deliveredText = "";
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    resolveMessage: async () => {
      resolved += 1;
      throw new Error("trading API unavailable");
    },
    telegram: {
      editMessageText: async (message) => {
        deliveredText = message.text;
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        assert.fail("generic funding edit must not send a replacement");
      },
    },
  });
  assert.equal(result.sent, 1);
  assert.equal(resolved, 0, "generic funding never depends on trading API");
  assert.equal(deliveredText, buildTelegramFundingProgressMessage(ready).text);
}

{
  const fake = deliveryPool({ destinations: [destination] });
  let edits = 0;
  let sends = 0;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        edits += 1;
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        sends += 1;
        return { ok: true, messageId: 101 };
      },
    },
  });
  assert.deepEqual(result, {
    claimed: 1,
    sent: 1,
    skipped: 0,
    failed: 0,
    blocked: 0,
    unknown: 0,
  });
  assert.equal(edits, 1);
  assert.equal(sends, 0);
  const contextAttachIndex = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_funding_sessions context") &&
      statement.includes("last_delivered_revision"),
  );
  assert.ok(contextAttachIndex >= 0);
  assert.equal(
    fake.parameters[contextAttachIndex]?.[6],
    false,
    "funding_edit success must not reattach its stale message id",
  );
}

{
  const fake = deliveryPool({ destinations: [destination] });
  let edits = 0;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator: {
      claimBackground: async () => true,
      claim: async () => {},
      isCurrent: async () => false,
      runExclusive: async () => ({ status: "superseded" as const }),
    },
    telegram: {
      editMessageText: async () => {
        edits += 1;
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        assert.fail("a superseded edit must not fall back to send");
      },
    },
  });
  assert.equal(edits, 0);
  assert.equal(result.skipped, 1);
}

{
  const fake = deliveryPool({
    deliveryCas: false,
    destinations: [destination],
  });
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => ({ ok: true, messageId: 100 }),
      sendMessage: async () => {
        assert.fail("a successful edit must never use fallback send");
      },
    },
  });
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
}

{
  const fake = deliveryPool({ destinations: [destination, destination] });
  let sends = 0;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => ({
        ok: false,
        error: "message_not_editable",
        message: "message to edit not found",
      }),
      sendMessage: async () => {
        sends += 1;
        return { ok: true, messageId: 102 };
      },
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(sends, 0, "a missing owner message must never be copy-sent");
  assert.equal(
    fake.statements.some((statement) =>
      statement.startsWith("insert into telegram_bot_action_outbox"),
    ),
    false,
  );
  const finishIndex = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_bot_action_outbox") &&
      statement.includes("set status = $3"),
  );
  assert.equal(
    fake.parameters[finishIndex]?.[3],
    "funding_owner_message_not_editable",
  );
}

{
  const fake = deliveryPool({
    destinations: [destination, destination, destination],
    projection: waiting,
  });
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => ({
        ok: false,
        error: "message_not_editable",
        message: "message to edit not found",
      }),
      sendMessage: async () => {
        assert.fail("an address-bearing edit must never become a new message");
      },
    },
  });
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 1);
  assert.equal(
    fake.statements.some((statement) =>
      statement.startsWith("insert into telegram_bot_action_outbox"),
    ),
    false,
  );
  const finishIndex = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_bot_action_outbox") &&
      statement.includes("set status = $3"),
  );
  assert.equal(
    fake.parameters[finishIndex]?.[3],
    "funding_owner_message_not_editable",
  );
  assert.equal(
    fake.statements.some(
      (statement) =>
        statement.startsWith("update telegram_funding_sessions") &&
        statement.includes("set telegram_message_id = null"),
    ),
    false,
    "the immutable known edit target must be retained for redaction/recovery",
  );
}

{
  const fake = deliveryPool({ destinations: [destination, null] });
  let sends = 0;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => ({
        ok: false,
        error: "message_not_editable",
        message: "message to edit not found",
      }),
      sendMessage: async () => {
        sends += 1;
        return { ok: true, messageId: 103 };
      },
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(sends, 0, "a superseded revision must not use fallback send");
  const finishIndex = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_bot_action_outbox") &&
      statement.includes("set status = $3"),
  );
  assert.equal(
    fake.parameters[finishIndex]?.[3],
    "funding_owner_message_not_editable",
  );
}

{
  const fake = deliveryPool({
    action: "funding_replacement",
    destinations: [],
    projection: ready,
  });
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      editMessageText: async () => {
        assert.fail("historical replacement must not edit");
      },
      sendMessage: async () => {
        assert.fail("historical replacement must not send");
      },
    },
  });
  assert.equal(result.failed, 1);
  const finishIndex = fake.statements.findIndex(
    (statement) =>
      statement.startsWith("update telegram_bot_action_outbox") &&
      statement.includes("set status = $3"),
  );
  assert.equal(
    fake.parameters[finishIndex]?.[3],
    "funding_owner_scoped_replacement_disabled",
  );
}

{
  const fake = deliveryPool({
    action: "funding_send",
    destinations: [],
    projection: waiting,
  });
  let sends = 0;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      sendMessage: async () => {
        sends += 1;
        return { ok: true, messageId: 101 };
      },
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(sends, 0);
}

{
  const fake = deliveryPool({
    action: "funding_send",
    destinations: [destination, destination],
  });
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      sendMessage: async () => ({
        ok: false,
        error: "blocked_or_missing",
        message: "bot was blocked",
      }),
    },
  });
  assert.equal(result.blocked, 1);
  assert.ok(
    fake.statements.some(
      (statement) =>
        statement.startsWith("update telegram_bot_action_outbox") &&
        statement.includes("set status = $3"),
    ),
  );
}

{
  const fake = deliveryPool({
    action: "funding_send",
    destinations: [destination],
  });
  let sends = 0;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: {
      sendMessage: async () => {
        sends += 1;
        return {
          ok: false,
          error: "ambiguous",
          message: "transport timed out after the request was written",
        };
      },
    },
  });
  assert.deepEqual(result, {
    claimed: 1,
    sent: 0,
    skipped: 0,
    failed: 0,
    blocked: 0,
    unknown: 1,
  });
  assert.equal(sends, 1, "an ambiguous send performs one external call");
  assert.ok(
    fake.statements.some(
      (statement) =>
        statement.startsWith("update telegram_bot_action_outbox") &&
        statement.includes("set status = $3"),
    ),
    "the attempt is finalized without re-entering the claimable queue",
  );
}

{
  const fake = deliveryPool({ destinations: [destination] });
  let resolved = 0;
  let deliveredText = "";
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    resolveMessage: async ({ contextId: resolvedContextId, projection }) => {
      resolved += 1;
      assert.equal(resolvedContextId, contextId);
      assert.deepEqual(
        projection,
        ready,
        "Buy decoration receives the frozen outbox projection",
      );
      return {
        ...buildTelegramFundingProgressMessage(ready),
        text: "dynamically resolved Review Buy presentation",
      };
    },
    telegram: {
      editMessageText: async (message) => {
        deliveredText = message.text;
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        assert.fail("a successful dynamic edit must not send a replacement");
      },
    },
  });
  assert.equal(result.sent, 1);
  assert.equal(resolved, 1);
  assert.equal(deliveredText, "dynamically resolved Review Buy presentation");
}

{
  const fake = deliveryPool({
    destinations: [
      {
        ...destination,
        address_disclosure_attempt_revision: 1,
        address_redacted_revision: 1,
        latest_terminal_projection: unavailable,
      },
    ],
    projection: unavailable,
  });
  const telegram = successfulTelegramCounter();
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    resolveMessage: async () =>
      buildTelegramFundingProgressMessage(waitingWithLiveCapability),
    telegram: telegram.client,
  });
  assert.equal(result.failed, 1);
  assert.equal(telegram.calls(), 0);
  assert.ok(
    fake.parameters.some((params) =>
      params.includes("funding_presentation_changed_address_surface"),
    ),
    "Buy decoration cannot replace a terminal card with live address output",
  );
}

{
  const fake = deliveryPool({
    destinations: [{ ...destination, latest_terminal_projection: unavailable }],
    projection: waitingWithLiveCapability,
  });
  const telegram = successfulTelegramCounter();
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    telegram: telegram.client,
  });
  assert.equal(result.skipped, 1);
  assert.equal(
    telegram.calls(),
    0,
    "raw terminal evidence blocks a historical address-bearing projection",
  );
}

{
  const fake = deliveryPool({ destinations: [destination] });
  const telegram = successfulTelegramCounter();
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    resolveMessage: async () => {
      throw new Error("policy source unavailable");
    },
    telegram: telegram.client,
  });
  assert.equal(result.failed, 1);
  assert.equal(result.sent, 0);
  assert.equal(telegram.calls(), 0);
  assert.ok(
    fake.parameters.some((params) =>
      params.includes("funding_presentation_unavailable"),
    ),
  );
}

console.log(
  "[telegram-funding-tests] safe callbacks, direct pUSD choice, progress projections, consent isolation, default-off policy, and guarded delivery passed",
);
