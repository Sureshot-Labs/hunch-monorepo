#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { listFundingReceiveReceiptsForRouting } from "./funding/persistence/funding-receive-session-repository.js";
import { fundingSidecarRuntimeConfig } from "./funding/runtime/sidecar-runtime-config.js";
import { isFundingReconciliationSchemaReady } from "./funding/worker/funding-reconciliation-worker.js";
import { resolveFundingReceiveSelectedTargetId } from "./funding/receive/receive-session-service.js";
import type {
  FundingReceiveReceipt,
  FundingReceiveSession,
} from "./funding/domain/types.js";
import type { DirectIngressObservationVariant } from "./funding/reconciliation/direct-ingress-observer.js";
import {
  parseTelegramFundingCallbackRoute,
  telegramFundingCallbackData,
} from "./services/telegram-funding-contracts.js";
import {
  buildTelegramFundingReviewBuyButton,
  resolveTelegramFundingBuyContinuationAdapter,
  resolveTelegramFundingBuyContinuationCapability,
} from "./services/telegram-funding-buy-continuation.js";
import {
  buildTelegramFundingAddressMessage,
  buildTelegramFundingProgressMessage,
  buildTelegramFundingTargetMessage,
} from "./services/telegram-funding-presentation.js";
import {
  projectTelegramFundingProgress,
  telegramFundingProgressFingerprint,
} from "./services/telegram-funding-progress.js";
import type {
  TelegramFundingConsent,
  TelegramFundingSessionContext,
} from "./services/telegram-funding-sessions.js";
import {
  buildTelegramFundingBuyReturnRequestFingerprint,
  canAttachTelegramFundingBuyReturn,
  canDiscloseTelegramFundingAddress,
  canonicalTelegramFundingBuySpend,
  loadTelegramFundingReceiveSession,
  resolveTelegramDirectPusdChoice,
} from "./services/telegram-funding.js";
import {
  createTelegramFundingBuyContinuationDecorator,
  telegramBotTradingTestHooks,
} from "./services/telegram-bot-trading.js";
import {
  createTelegramFundingRenderCoordinator,
  deliverTelegramFundingActions,
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
const receiveTargetId = "receive_target_telegram_pusd_12345678";

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
const address = "0x1111111111111111111111111111111111111111";
const expiresAt = "2026-08-06T12:00:00.000Z";
const renderCoordinator = {
  claim: async () => {},
  isCurrent: async () => true,
  runExclusive: async <T>(input: { deliver: () => Promise<T> }) => ({
    status: "completed" as const,
    value: await input.deliver(),
  }),
};

assert.equal(
  await isFundingReconciliationSchemaReady({
    query: async (sql: string) => {
      assert.match(sql, /telegram_funding_sessions/);
      assert.match(sql, /telegram_funding_consents/);
      assert.match(sql, /telegram_funding_mutations/);
      assert.doesNotMatch(sql, /telegram_funding_buy_return_revisions/);
      assert.doesNotMatch(sql, /active_buy_return_revision/);
      assert.match(sql, /owner_channel/);
      assert.match(sql, /delivery_attempt_id/);
      return { rows: [{ ready: true }] };
    },
  } as never),
  true,
  "the A1 worker remains available before additive 0203 while Slice B is off",
);

assert.equal(canonicalTelegramFundingBuySpend("1.000000"), "1");
assert.equal(canonicalTelegramFundingBuySpend("1.250000"), "1.25");
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
      _script: string,
      options: { arguments: string[]; keys: string[] },
    ) => {
      const key = options.keys[0] ?? "";
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
  const callbackGuard = createSignalBotMenuRenderGuard({
    chatId: "42",
    messageId: 100,
    redis,
    renderToken: "callback",
  });
  await createTelegramFundingRenderCoordinator(redis).claim({
    chatId: "42",
    messageId: 100,
    renderToken: "background",
  });
  assert.equal(
    await callbackGuard(),
    false,
    "background funding delivery must supersede a stale callback render",
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
  completion: { kind: "direct_destination_credit" },
});

const consent: TelegramFundingConsent = {
  id: "consent-1",
  fundingContextId: contextId,
  revision: 1,
  receiveTargetId,
  asset: pUsd,
  variantIds: ["variant-pusd"],
  automationEnabled: false,
  maximumAutomaticRaw: null,
  policySnapshot: {},
  fingerprint: "fingerprint-1",
  consentedAt: "2026-08-05T12:01:00.000Z",
};

const receipt = (
  input: Partial<FundingReceiveReceipt> &
    Pick<FundingReceiveReceipt, "asset" | "handling" | "status">,
): FundingReceiveReceipt => ({
  receiptId: input.receiptId ?? "receipt-1",
  receiveSessionId,
  variantId: input.variantId ?? "variant-pusd",
  asset: input.asset,
  destinationAddress: address,
  rawAmount: input.rawAmount ?? "2500000",
  observationRevision: "observation-1",
  observedAt: input.observedAt ?? "2026-08-05T12:02:00.000Z",
  status: input.status,
  handling: input.handling,
  childFundingOperationId: input.childFundingOperationId ?? null,
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
for (const kind of ["refresh", "cancel", "qr"] as const) {
  const callback = telegramFundingCallbackData({ contextId, kind });
  assert.ok(Buffer.byteLength(callback, "utf8") <= 64);
  assert.deepEqual(parseTelegramFundingCallbackRoute(callback.slice(6)), {
    kind,
    contextId,
  });
}
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

const targetMessage = buildTelegramFundingTargetMessage({
  contextId,
  expiresAt,
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

const addressMessage = buildTelegramFundingAddressMessage({
  address,
  contextId,
  expiresAt,
});
assert.equal(addressMessage.qrText, address);
assert.match(addressMessage.text, new RegExp(address));
assert.doesNotMatch(addressMessage.text, /pUSD \/ USDC\.e/);
assert.doesNotMatch(addressMessage.text, /USDC\.e/);
assert.match(addressMessage.text, /Receive window.*24 hours/u);
assert.equal(addressMessage.text.includes("2026\\-08\\-06 12:00:00 UTC"), true);
assert.equal(
  addressMessage.reply_markup?.inline_keyboard[0]?.[0] &&
    "copy_text" in addressMessage.reply_markup.inline_keyboard[0][0]
    ? addressMessage.reply_markup.inline_keyboard[0][0].copy_text.text
    : null,
  address,
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
  receiveTargetId,
  variantIds: ["variant-pusd"],
});
const firstReceiveTarget = session.receiveTargets[0];
assert.ok(firstReceiveTarget);
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

const ready = projectTelegramFundingProgress({
  consent,
  context,
  receipts: [receipt({ asset: pUsd, handling: "direct", status: "ready" })],
  session: { ...session, status: "completed" },
});
assert.equal(ready?.state, "ready");
assert.equal(ready?.terminal, true);
assert.ok(ready);
const readyMessage = buildTelegramFundingProgressMessage(ready);
assert.match(readyMessage.text, /pUSD ready/);
assert.doesNotMatch(readyMessage.text, /Receive window/u);
assert.doesNotMatch(readyMessage.text, /Expires at/u);
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
  /No routing transaction was submitted/,
);
assert.notEqual(
  telegramFundingProgressFingerprint(ready),
  telegramFundingProgressFingerprint(unexpectedUsdce),
);
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
const {
  buyContinuationEnabled: _legacyMissingBuyContinuationEnabled,
  customTradeInputEnabled: _legacyMissingCustomTradeInputEnabled,
  fundingReceiveEnabled: _legacyMissingFundingReceiveEnabled,
  ...productionLegacyPolicyPayload
} = defaultPolicy;
assert.equal(_legacyMissingFundingReceiveEnabled, false);
assert.equal(_legacyMissingCustomTradeInputEnabled, false);
assert.equal(_legacyMissingBuyContinuationEnabled, false);
assert.deepEqual(signalBotSchema.parse({ buyContinuationEnabled: "true" }), {
  buyContinuationEnabled: true,
});
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
    /consent\.consented_at <= receipt\.observed_at/u,
    "Telegram authority must be selected as of the immutable receipt time",
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
  finishOpen(buildTelegramFundingTargetMessage({ contextId, expiresAt }));
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
  finishOpen(buildTelegramFundingTargetMessage({ contextId, expiresAt }));
  assert.equal(await drainSignalBotFundingOpenTasks(1_000), true);
}

{
  const terminalMessage = buildTelegramFundingProgressMessage(cancelled);
  let renderedText = "";
  let photoCalls = 0;
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
    sendPhoto: async () => {
      photoCalls += 1;
      return { messageId: 504, ok: true };
    },
    telegramUserId: 42,
  });
  assert.equal(handled, true);
  assert.equal(photoCalls, 0, "a terminal QR callback must not send a photo");
  assert.doesNotMatch(renderedText, new RegExp(address, "u"));
  assert.match(
    renderedText,
    /Receive cancelled/u,
    "a terminal QR callback must render the safe terminal card",
  );
}

function deliveryPool(input: {
  action?: "funding_edit" | "funding_replacement" | "funding_send";
  deliveryCas?: boolean;
  destinations: Array<{
    active_buy_return_revision: number | null;
    telegram_account_id: string;
    telegram_user_id: string;
    telegram_message_id: number | null;
    progress_revision: number;
  } | null>;
}) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const destinations = [...input.destinations];
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
            payload: ready,
            attempt_count: 0,
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
      return { rows: [{ attempt_count: 1 }], rowCount: 1 };
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
                latest_progress_projection: ready,
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
      normalized.includes("join user_telegram_accounts account")
    ) {
      const destination = destinations.shift() ?? null;
      return {
        rows: destination
          ? [
              {
                ...destination,
                latest_progress_projection: ready,
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
                  current_telegram_account_id: "telegram-account-1",
                  latest_progress_projection: ready,
                  progress_revision: 1,
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
  telegram_account_id: "telegram-account-1",
  telegram_user_id: "42",
  telegram_message_id: 100,
  progress_revision: 1,
};

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
  assert.equal(result.skipped, 1);
  assert.equal(sends, 0, "a missing edit must enqueue a durable replacement");
  assert.ok(
    fake.statements.some((statement) =>
      statement.startsWith("insert into telegram_bot_action_outbox"),
    ),
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
  assert.equal(result.skipped, 1);
  assert.equal(sends, 0, "a superseded revision must not use fallback send");
  assert.ok(
    fake.statements.some(
      (statement) =>
        statement.startsWith("update telegram_bot_action_outbox") &&
        statement.includes("status = 'skipped'"),
    ),
  );
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
    resolveMessage: async ({ contextId: resolvedContextId }) => {
      resolved += 1;
      assert.equal(resolvedContextId, contextId);
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
  const fake = deliveryPool({ destinations: [destination] });
  let telegramCalls = 0;
  const result = await deliverTelegramFundingActions({
    pool: fake.pool,
    renderCoordinator,
    resolveMessage: async () => {
      throw new Error("policy source unavailable");
    },
    telegram: {
      editMessageText: async () => {
        telegramCalls += 1;
        return { ok: true, messageId: 100 };
      },
      sendMessage: async () => {
        telegramCalls += 1;
        return { ok: true, messageId: 101 };
      },
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(result.sent, 0);
  assert.equal(telegramCalls, 0);
  assert.ok(
    fake.parameters.some((params) =>
      params.includes("funding_presentation_unavailable"),
    ),
  );
}

console.log(
  "[telegram-funding-tests] safe callbacks, direct pUSD choice, progress projections, consent isolation, default-off policy, and guarded delivery passed",
);
