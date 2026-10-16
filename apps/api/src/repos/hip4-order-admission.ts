import type { Pool, PoolClient } from "@hunch/infra";
import { fetchActiveRuntimePolicy } from "@hunch/db";
import {
  hip4Identity,
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  venueLifecyclePolicySchema,
  venueHasLifecycleCapability,
} from "@hunch/shared";
import { z } from "zod";
import { hypercoreSpotAccountLocation } from "../account-value/canonical.js";
import {
  loadFundingPhysicalNativeSnapshotDebits,
  FundingSnapshotDebitEvidenceError,
} from "../account-value/funding-snapshot-debits.js";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";
import type { WalletExecutionProfile } from "../funding/domain/types.js";
import { lockFundingControllerWallet } from "../funding/execution/funding-controller-wallet-lock.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { lockFundingPhysicalSource } from "../funding/persistence/funding-operation-repository.js";
import {
  claimFundingTradeAttemptInTransaction,
  markFundingTradeAttemptSubmissionStartedInTransaction,
} from "../funding/persistence/funding-trade-attempt-repository.js";
import {
  buildFundingTradeConsumerIntent,
  compareFundingTradeConsumerIntentToConfirmedBound,
  type FundingTradeConsumerIntent,
} from "../funding/persistence/funding-trade-consumer-intent.js";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-sidecar.js";
import { calculateHip4OrderAmounts } from "../services/hip4-order-amounts.js";
import { readHip4TradingPolicy } from "./hip4-trading-policy.js";
import {
  assertHip4CurrentFeeConsent,
  quoteHip4OrderFees,
  type Hip4OrderFeeObservation,
} from "../services/hip4-order-fees.js";
import {
  bindHip4TradeSignature,
  prepareHip4TradeSigning,
  type Hip4TradeSigningInput,
} from "../services/hip4-trade-signing.js";
import {
  HIP4_FUNDING_CASH_HOLDS_SQL,
  readHip4OrderHoldRaw,
} from "./hip4-order-holds.js";
import type { classifyHip4SingleTradeReply } from "../services/hip4-trade-reply.js";
import {
  readTelegramAppHandoffV2Binding,
  telegramAppHandoffV2BindingSchema,
} from "../services/telegram-app-handoff-v2-contract.js";
import {
  lockTelegramAppHandoffV2ConsumerAuthorityInTransaction,
  claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction,
  claimTelegramAppHandoffV2FundedTradeAttemptInTransaction,
  linkTelegramAppHandoffV2DirectTradeOrderInTransaction,
  linkTelegramAppHandoffV2NativeFundedOrderInTransaction,
  type TelegramAppHandoffV2ScopeAssertion,
  type TelegramAppHandoffV2DirectTradeSubmission,
} from "./telegram-app-handoff-v2-direct-trade-repository.js";
import {
  telegramAppHandoffNativeTradeSchema,
  telegramAppHandoffNativeRequestedAmounts,
} from "../services/telegram-app-handoff-native-trade.js";
import type { SocialSourceRef } from "../schemas/social-trade.js";
import {
  assertHip4CopyAttribution,
  buildHip4CopyPreparedTrade,
} from "../services/hip4-copy-attribution.js";
import {
  retainCopyBeforeSubmissionInTransaction,
  markCopySubmissionStarted,
  linkPersistedCopy,
  assertSocialCopyPolicy,
  type RetainedCopyAttempt,
} from "../services/social-copy.js";
import {
  buildHip4NativeInstrument,
  currentHip4NativeInstrument,
} from "../services/hip4-native-instrument.js";
import { verifiedBuyFactsSchema } from "../schemas/social-trade.js";

export type Hip4AdmissionContext = {
  profile: WalletExecutionProfile;
  feeCapRaw: string | null;
  feeObservation?: Hip4OrderFeeObservation;
  capacity: null | {
    assetId: string;
    decimals: number;
    availableRaw: string;
    observedAt: string;
    expiresAt: string;
  };
};
type StoredAction = {
  id: string;
  order_id: string;
  user_id: string;
  token_id: string;
  canonical_market_id: string;
  signer_address: string;
  cloid: string;
  unsigned_envelope: Hip4TradeSigningInput;
  state: "prepared" | "abandoned";
  action_fingerprint: string;
  preparation_snapshot: {
    [key: string]: unknown;
    consentedDebitCapRaw?: string;
    profile?: WalletExecutionProfile;
    amounts?: { debitCapRaw?: string; feeCapRaw?: string | null };
    feeQuote?: unknown;
  };
};
export type Hip4SubmissionRecord = {
  action_id: string;
  state: "submission_started" | "reconcile_required" | "rejected";
  funding_trade_attempt_id: string | null;
  signature_fingerprint: string;
  admission_snapshot: {
    funding: unknown;
    telegramAppHandoff?: unknown;
    copy?: RetainedCopyAttempt | null;
  };
  reply_summary: ReturnType<typeof classifyHip4SingleTradeReply> | null;
};
export const HIP4_OWNED_ACTION_SQL = `select action_row.*,order_row.user_id
  from hip4_order_actions action_row join orders order_row on order_row.id=action_row.order_id
  where action_row.id=$1 and order_row.user_id=$2`;
export const HIP4_OWNED_SUBMISSION_SQL = `select submission_row.*
  from hip4_order_submissions submission_row
  join hip4_order_actions action_row on action_row.id=submission_row.action_id
  join orders order_row on order_row.id=action_row.order_id
  where submission_row.action_id=$1 and order_row.user_id=$2`;

export type Hip4OrderSubmitReference = {
  sourceRef?: SocialSourceRef;
  copyIdempotencyKey?: string;
  userId: string;
  actionId: string;
  signature: string;
  actor: string;
  telegramAppHandoffId?: string;
  telegramAppHandoffPlanFingerprint?: string;
  funding?: {
    operationId: string;
    reservationId: string;
  };
};
export type Hip4OrderSubmitRequest = Omit<
  Hip4OrderSubmitReference,
  "funding"
> & {
  funding?: NonNullable<Hip4OrderSubmitReference["funding"]> & {
    confirmedIntent: FundingTradeConsumerIntent;
  };
};

/** Shared read-before-observe / locked-admission lookup. No policy, provider IO,
 * capacity or frozen profile is required to replay an owned durable result.
 * This read never grants POST authority; admission re-runs it under its locks. */
export async function readHip4OrderSubmissionAttempt(
  db: Pick<Pool, "query">,
  input: Hip4OrderSubmitReference | Hip4OrderSubmitRequest,
) {
  if (input.actor !== "web_app")
    throw new Error("hip4_client_submission_required");
  const userId = z.string().uuid().parse(input.userId).toLowerCase();
  const actionId = z.string().uuid().parse(input.actionId).toLowerCase();
  const found = await db.query<StoredAction>(HIP4_OWNED_ACTION_SQL, [
    actionId,
    userId,
  ]);
  const row = found.rows[0];
  if (!row) throw new Error("hip4_preparation_not_found");
  assertHip4CopyAttribution(input, row.preparation_snapshot);
  const request = bindHip4TradeSignature(
    row.unsigned_envelope,
    input.signature,
    row.signer_address,
  );
  const signatureFingerprint = canonicalJsonHash(request);
  const prior = (
    await db.query<Hip4SubmissionRecord>(HIP4_OWNED_SUBMISSION_SQL, [
      actionId,
      userId,
    ])
  ).rows[0];
  if (prior) {
    const requestedHandoff = readTelegramAppHandoffV2Binding(input);
    const storedHandoff = telegramAppHandoffV2BindingSchema
      .nullish()
      .parse(prior.admission_snapshot.telegramAppHandoff);
    const stored = z
      .object({
        operationId: z.string().uuid(),
        reservationId: z.string().uuid(),
        intent: z.string(),
      })
      .nullable()
      .parse(prior.admission_snapshot.funding);
    if (
      prior.signature_fingerprint !== signatureFingerprint ||
      (storedHandoff?.handoffId ?? null) !==
        (requestedHandoff?.handoffId ?? null) ||
      (storedHandoff?.planFingerprint ?? null) !==
        (requestedHandoff?.planFingerprint ?? null) ||
      (stored?.operationId ?? null) !==
        (input.funding?.operationId.toLowerCase() ?? null) ||
      (stored?.reservationId ?? null) !==
        (input.funding?.reservationId.toLowerCase() ?? null) ||
      (input.funding &&
        "confirmedIntent" in input.funding &&
        stored?.intent !== input.funding.confirmedIntent.fingerprint)
    )
      throw new Error("hip4_submission_conflict");
  }
  return { row, request, signatureFingerprint, prior };
}

export function inspectHip4PreparedAction(row: StoredAction) {
  const prepared = prepareHip4TradeSigning(row.unsigned_envelope);
  const now = Date.now();
  if (
    row.state !== "prepared" ||
    prepared.environment !== "mainnet" ||
    prepared.vaultAddress !== null ||
    prepared.expiresAfter === null ||
    prepared.expiresAfter <= now ||
    prepared.nonce > now ||
    canonicalJsonHash(row.unsigned_envelope) !== row.action_fingerprint
  )
    throw new Error("hip4_preparation_unavailable");
  const wire =
    prepared.action.type === "order" ? prepared.action.orders[0] : null;
  const side: "BUY" | "SELL" | "CANCEL" = wire
    ? wire.b
      ? "BUY"
      : "SELL"
    : "CANCEL";
  const identity = hip4Identity(
    "mainnet",
    Number(row.canonical_market_id.split(":").at(-1)),
  );
  const token = identity.sides.find((item) => item.tokenId === row.token_id);
  if (
    !token ||
    (wire &&
      (prepared.action.type !== "order" ||
        prepared.action.orders.length !== 1 ||
        wire.a !== token.assetId ||
        wire.c !== row.cloid))
  )
    throw new Error("hip4_preparation_identity_invalid");
  return {
    prepared: { ...prepared, expiresAfter: prepared.expiresAfter },
    wire,
    side,
    identity,
    token,
  };
}

export async function readHip4TradeLifecycle(
  db: Pick<Pool, "query">,
  side: "BUY" | "SELL" | "CANCEL",
  capabilityCheck: typeof venueHasLifecycleCapability = venueHasLifecycleCapability,
) {
  const row = await fetchActiveRuntimePolicy(
    db,
    "venue_lifecycle",
    new Date(),
    { missingTable: "error" },
  );
  const policy = venueLifecyclePolicySchema.parse(
    row?.payload ?? DEFAULT_VENUE_LIFECYCLE_POLICY,
  );
  if (
    !capabilityCheck(
      policy,
      "hyperliquid",
      side === "BUY"
        ? "increaseExposure"
        : side === "SELL"
          ? "reduceExposure"
          : "cancel",
    )
  )
    throw new Error("hip4_lifecycle_disabled");
  return { row, policy };
}

/** Internal boundary. Context MUST be freshly resolved by server runtime, never
 * taken from prepared.venuePayload or the submit request. Public integration is
 * intentionally separate. Transaction caller must roll back on any rejection.
 * Signature is verified here but is never returned to the database or logged.
 * A replay has no new POST authority, including after the quote expires.
 */
export async function admitHip4OrderActionInTransaction(
  db: PoolClient,
  input: Hip4OrderSubmitRequest & {
    context: Hip4AdmissionContext;
    /** Trusted API dependency, never a request field or client permission. */
    telegramAppHandoffScope?: TelegramAppHandoffV2ScopeAssertion;
  },
  capabilityCheck: typeof venueHasLifecycleCapability = venueHasLifecycleCapability,
) {
  if (input.actor !== "web_app")
    throw new Error("hip4_client_submission_required");
  const userId = z.string().uuid().parse(input.userId).toLowerCase();
  const actionId = z.string().uuid().parse(input.actionId).toLowerCase();
  // Serialize with native funding before locking users/consumer operations.
  // No provider reads or signing occur while these locks are held.
  await lockFundingPolicyForTransaction(db);
  const handoff = readTelegramAppHandoffV2Binding(input);
  // A prior committed submission owns the response-loss path even if policy,
  // funding readiness, handoff TTL or current wallet observations have changed.
  const { row, request, signatureFingerprint, prior } =
    await readHip4OrderSubmissionAttempt(db, input);
  if (prior) return { admitted: false as const, submission: prior };
  const handoffScope = input.telegramAppHandoffScope;
  if (handoff) {
    if (!handoffScope) throw new Error("hip4_handoff_scope_unavailable");
    // Same envelope as other venue consumers, BEFORE the native user lock.
    await lockTelegramAppHandoffV2ConsumerAuthorityInTransaction(db, {
      userId,
      binding: handoff,
      assertCurrentScope: handoffScope,
    });
  }
  // The shared Copy owner locks source author and copier in sorted order, before
  // the ordinary native user/controller/order locks. A failed admission rolls
  // back this retention too: no detached authorization or extra BUY exists.
  const copyInput = buildHip4CopyPreparedTrade({
    userId,
    actionId,
    marketId: row.canonical_market_id,
    tokenId: row.token_id,
    signerAddress: row.signer_address,
    cloid: row.cloid,
    actionFingerprint: row.action_fingerprint,
    envelope: row.unsigned_envelope,
    snapshot: row.preparation_snapshot,
  });
  const copyAttempt = copyInput
    ? await retainCopyBeforeSubmissionInTransaction(db, copyInput)
    : null;
  const user = await db.query(
    "select id from users where id=$1 and coalesce(is_active,true) for update",
    [userId],
  );
  if (user.rows.length !== 1) throw new Error("hip4_owner_unavailable");
  const fundingBinding = input.funding
    ? {
        operationId: input.funding.operationId.toLowerCase(),
        reservationId: input.funding.reservationId.toLowerCase(),
        intent: input.funding.confirmedIntent.fingerprint,
      }
    : null;
  const context = input.context;
  if (
    context.profile.networkId !== "hyperliquid:mainnet" ||
    context.profile.address.toLowerCase() !== row.signer_address
  )
    throw new Error("hip4_controller_changed");
  await lockFundingControllerWallet(db, userId, context.profile);
  const { prepared, wire, side, token } = inspectHip4PreparedAction(row);
  if (handoff && !wire) throw new Error("hip4_handoff_order_required");
  // Uncached common venue policy at the durable boundary, not a client flag or
  // the policy snapshot returned by a previous quote.
  const readLifecycle = () => readHip4TradeLifecycle(db, side, capabilityCheck);
  let lifecycle = await readLifecycle();
  let debitRaw: string | null = null;
  const assetId =
    side === "BUY" ? HYPERCORE_MAINNET_USDC.assetId : row.token_id;
  const decimals = side === "BUY" ? 8 : 5;
  let tradingPolicy = wire?.b ? await readHip4TradingPolicy(db) : undefined;
  const feeQuote =
    wire && context.feeObservation
      ? quoteHip4OrderFees({
          observation: context.feeObservation,
          address: row.signer_address,
          action: prepared.action,
        })
      : null;
  if (wire && (feeQuote || row.preparation_snapshot.feeQuote)) {
    if (!feeQuote) throw new Error("hip4_fee_observation_unavailable");
    assertHip4CurrentFeeConsent(row.preparation_snapshot.feeQuote, feeQuote);
  }
  const currentFees = feeQuote
    ? {
        feeCapRaw: feeQuote.buyFeeCapRaw,
        ...(side === "SELL"
          ? { sellFeeEstimateAtLimitRaw: feeQuote.estimatedFeeAtLimitRaw }
          : {}),
      }
    : { feeCapRaw: context.feeCapRaw };
  if (wire) {
    const amounts = calculateHip4OrderAmounts({
      environment: "mainnet",
      side: wire.b ? "BUY" : "SELL",
      timeInForce: wire.t.limit.tif,
      quantity: wire.s,
      limitPrice: wire.p,
      policy: tradingPolicy,
      ...currentFees,
      // The frozen authorization caps the debit, not a newly expanded quote.
      consentedDebitCapRaw: row.preparation_snapshot.amounts?.debitCapRaw ?? "",
    });
    if (amounts.kind !== "calculated" || !amounts.validation.valid)
      throw new Error("hip4_current_amounts_invalid");
    // SELL's debit cap authorizes shares, not an arbitrary fee withheld from
    // proceeds. A higher refreshed fee needs a new user-reviewed preparation.
    // BUY already bounds fees through its frozen total cash debit above.
    const authorizedFee = row.preparation_snapshot.amounts?.feeCapRaw;
    if (
      side === "SELL" &&
      !feeQuote &&
      (typeof authorizedFee !== "string" ||
        !/^(0|[1-9]\d{0,127})$/u.test(authorizedFee) ||
        amounts.feeCapRaw === null ||
        BigInt(amounts.feeCapRaw) > BigInt(authorizedFee))
    )
      throw new Error("hip4_fee_consent_changed");
    debitRaw = amounts.debitCapRaw;
    const market = await db.query(
      "select id from unified_markets where id=$1 and venue='hyperliquid' and status='ACTIVE' for share",
      [row.canonical_market_id],
    );
    if (market.rows.length !== 1) throw new Error("hip4_market_unavailable");
  } else if (input.funding) throw new Error("hip4_cancel_funding_invalid");

  let nativeHandoffSubmission: TelegramAppHandoffV2DirectTradeSubmission | null =
    null;
  if (handoff && wire && debitRaw) {
    const nativeTrade = telegramAppHandoffNativeTradeSchema.parse({
      version: "hip4-ioc-v1",
      environment: prepared.environment,
      marketId: row.canonical_market_id,
      outcomeTokenId: row.token_id,
      outcomeSide: token.sideIndex === 0 ? "YES" : "NO",
      controllerWalletRef: context.profile.controllerWalletRef,
      side,
      timeInForce: wire.t.limit.tif,
      quantity: wire.s,
      limitPrice: wire.p,
      consentedDebitCapRaw: row.preparation_snapshot.consentedDebitCapRaw,
    });
    const amounts = telegramAppHandoffNativeRequestedAmounts(nativeTrade);
    nativeHandoffSubmission = {
      action: side === "BUY" ? "buy" : "sell",
      executionKind: "hyperliquid_ioc",
      venue: "hyperliquid",
      marketId: row.canonical_market_id,
      outcomeTokenId: row.token_id,
      signer: row.signer_address,
      nativeTrade,
      spendRaw: debitRaw,
      receiveRaw:
        side === "BUY"
          ? String(amounts.tokenRaw)
          : String(amounts.grossQuoteRaw),
    };
  }
  let fundingAttemptId: string | null = null;
  if (input.funding) {
    if (side !== "BUY" || !debitRaw)
      throw new Error("hip4_funding_buy_required");
    const actual = buildFundingTradeConsumerIntent({
      venueId: "hyperliquid",
      marketId: row.canonical_market_id,
      marketContextId: row.token_id.slice("hyperliquid:".length),
      spend: { asset: HYPERCORE_MAINNET_USDC, raw: debitRaw },
      ...(copyInput
        ? {
            sourceRef: copyInput.prepared.intent.sourceRef,
            copyIdempotencyKey: copyInput.prepared.intent.copyIdempotencyKey,
          }
        : {}),
    });
    if (
      compareFundingTradeConsumerIntentToConfirmedBound(
        input.funding.confirmedIntent,
        actual,
      ) !== "matched"
    )
      throw new Error("hip4_funding_scope_changed");
    const claimInput = {
      userId,
      operationId: input.funding.operationId,
      reservationId: input.funding.reservationId,
      venueId: "hyperliquid",
      marketId: row.canonical_market_id,
      executionPath: "hyperliquid_outcome" as const,
      idempotencyKey: `hip4:${actionId}`,
      canonicalFingerprint: row.action_fingerprint,
      consumerIntent: input.funding.confirmedIntent,
      externalReference: row.cloid,
    };
    const claimed =
      handoff && handoffScope && nativeHandoffSubmission
        ? await claimTelegramAppHandoffV2FundedTradeAttemptInTransaction(db, {
            ...claimInput,
            binding: handoff,
            assertCurrentScope: handoffScope,
            submission: nativeHandoffSubmission,
          })
        : await claimFundingTradeAttemptInTransaction(db, claimInput);
    if (!claimed.claimed)
      throw new Error("hip4_funding_reconciliation_required");
    const fundedLocation = hypercoreSpotAccountLocation({
      accountId: userId,
      address: row.signer_address,
      controllerWalletId: context.profile.walletId,
    }).location;
    // The same Hunch user can own several native wallets. Market/amount alone
    // cannot consume wallet A's funding reservation for wallet B's purchase.
    const destination = await db.query<{
      location_id: string;
      asset_id: string;
      network_id: string;
      asset_decimals: number;
    }>(
      `select location_id,asset_id,network_id,asset_decimals from balance_reservations
       where id=$1 and user_id=$2 and operation_id=$3`,
      [input.funding.reservationId, userId, input.funding.operationId],
    );
    const reserved = destination.rows[0];
    if (
      !reserved ||
      reserved.location_id !== fundedLocation.locationId ||
      reserved.asset_id !== HYPERCORE_MAINNET_USDC.assetId ||
      reserved.network_id !== HYPERCORE_MAINNET_USDC.networkId ||
      reserved.asset_decimals !== 8
    )
      throw new Error("hip4_funding_destination_changed");
    await markFundingTradeAttemptSubmissionStartedInTransaction(db, {
      userId,
      operationId: input.funding.operationId,
      reservationId: input.funding.reservationId,
      attemptId: claimed.attempt.id,
      claimToken: claimed.attempt.claimToken,
    });
    fundingAttemptId = claimed.attempt.id;
  } else if (handoff && handoffScope && nativeHandoffSubmission) {
    await claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(db, {
      userId,
      binding: handoff,
      assertCurrentScope: handoffScope,
      submission: nativeHandoffSubmission,
      reconcileKeys: {
        tradeType: "hyperliquid",
        actionId,
        orderId: row.order_id,
        cloid: row.cloid,
      },
      recoveryPayload: {},
    });
  }
  // Consumer chain precedes order row locks (as for the existing venues).
  const locked = await db.query<StoredAction>(
    `${HIP4_OWNED_ACTION_SQL} for update of order_row,action_row`,
    [actionId, userId],
  );
  if (locked.rows[0]?.state !== "prepared")
    throw new Error("hip4_preparation_unavailable");
  if (wire && debitRaw) {
    const capacity = context.capacity;
    if (
      !capacity ||
      capacity.assetId !== assetId ||
      capacity.decimals !== decimals ||
      !/^(0|[1-9]\d*)$/u.test(capacity.availableRaw) ||
      !Number.isFinite(Date.parse(capacity.observedAt)) ||
      Date.parse(capacity.observedAt) > Date.now() ||
      Date.parse(capacity.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(capacity.expiresAt)) ||
      Date.parse(capacity.expiresAt) <= Date.parse(capacity.observedAt)
    )
      throw new Error("hip4_capacity_unavailable");
    const cash = hypercoreSpotAccountLocation({
      accountId: userId,
      address: row.signer_address,
      controllerWalletId: context.profile.walletId,
    }).location;
    await lockFundingPhysicalSource(db, userId, {
      locationId: cash.locationId,
      networkId: "hyperliquid:mainnet",
      assetId,
      assetDecimals: decimals,
    });
    let held = await readHip4OrderHoldRaw(
      db,
      userId,
      row.signer_address,
      assetId,
      capacity.observedAt,
    );
    if (side === "BUY") {
      const reservations = await db.query<{
        raw_amount: string;
        asset_decimals: number;
      }>(HIP4_FUNDING_CASH_HOLDS_SQL, [
        userId,
        cash.locationId,
        assetId,
        input.funding?.reservationId ?? null,
      ]);
      if (reservations.rows.some((item) => item.asset_decimals !== 8))
        throw new Error("hip4_capacity_identity_changed");
      held += reservations.rows.reduce(
        (sum, item) => sum + BigInt(item.raw_amount),
        0n,
      );
      const debits = await loadFundingPhysicalNativeSnapshotDebits(
        db,
        userId,
        cash,
        capacity.observedAt,
      ).catch((error) => {
        if (error instanceof FundingSnapshotDebitEvidenceError)
          throw new Error("hip4_capacity_unavailable");
        throw error;
      });
      held += debits.reduce((sum, item) => sum + BigInt(item.raw_amount), 0n);
    }
    if (
      held + BigInt(debitRaw) > BigInt(capacity.availableRaw) ||
      Date.parse(capacity.expiresAt) <= Date.now()
    )
      throw new Error("hip4_capacity_reserved");
  }
  // Copy policy can itself wait on its row lock. Resolve it before the final
  // current-market read and wall-clock fence, independently of ordinary orders.
  const copyPolicyRevision = copyInput
    ? (await assertSocialCopyPolicy(db, "hyperliquid")).revision
    : null;
  const latest = wire
    ? (
        await db.query<{
          metadata: unknown;
          status: string;
          expiration_time: Date | null;
        }>(
          "select metadata,status,expiration_time from unified_markets where id=$1 and venue='hyperliquid' for share",
          [row.canonical_market_id],
        )
      ).rows[0]
    : null;
  // A scheduled threshold can become effective during any lock wait above.
  // Recheck at the final admission boundary, not from caller/preparation data.
  // SELL and cancel do not depend on this BUY-only product threshold.
  if (wire?.b) {
    tradingPolicy = await readHip4TradingPolicy(db);
    const current = calculateHip4OrderAmounts({
      environment: "mainnet",
      side: "BUY",
      timeInForce: wire.t.limit.tif,
      quantity: wire.s,
      limitPrice: wire.p,
      policy: tradingPolicy,
      ...currentFees,
      consentedDebitCapRaw: row.preparation_snapshot.amounts?.debitCapRaw ?? "",
    });
    if (current.kind !== "calculated" || !current.validation.valid)
      throw new Error("hip4_current_amounts_invalid");
  }
  // Lifecycle is shared with every venue, and scheduled changes can also take
  // effect during the waits. Validate exits/cancel as well as new exposure;
  // replay above remains readable even after the venue has been disabled.
  lifecycle = await readLifecycle();
  if (wire && context.feeObservation)
    quoteHip4OrderFees({
      observation: context.feeObservation,
      address: row.signer_address,
      action: prepared.action,
    });
  // Row/advisory locks above may have waited longer than the signing window.
  // PostgreSQL wall clock (not transaction-start now()) fences the final write.
  const clock = (
    await db.query<{ checked_at: Date }>(
      "select clock_timestamp() as checked_at",
    )
  ).rows[0].checked_at.getTime();
  if (
    prepared.expiresAfter <= clock ||
    (wire &&
      context.capacity &&
      Date.parse(context.capacity.expiresAt) <= clock) ||
    (wire && feeQuote && Date.parse(feeQuote.expiresAt) <= clock)
  )
    throw new Error("hip4_preparation_expired");
  if (wire) {
    const outcome = token.sideIndex === 0 ? "YES" : "NO";
    const frozen = verifiedBuyFactsSchema.shape.instrument.safeParse(
      row.preparation_snapshot.nativeInstrument ??
        row.preparation_snapshot.socialInstrument,
    );
    const rebuilt = frozen.success
      ? buildHip4NativeInstrument({
          marketId: row.canonical_market_id,
          tokenId: row.token_id,
          outcome,
          expiry: frozen.data.expiry,
          snapshot:
            row.preparation_snapshot.nativeInstrumentSnapshot ??
            row.preparation_snapshot.socialInstrumentSnapshot,
        })
      : null;
    const current = latest
      ? currentHip4NativeInstrument({
          marketId: row.canonical_market_id,
          tokenId: row.token_id,
          outcome,
          expiry: latest.expiration_time?.toISOString() ?? null,
          metadata: latest.metadata,
          status: latest.status,
          now: clock,
        })
      : null;
    if (
      !frozen.success ||
      !rebuilt ||
      canonicalJsonHash(rebuilt) !== canonicalJsonHash(frozen.data)
    )
      throw new Error("hip4_preparation_unavailable");
    if (!current || canonicalJsonHash(current) !== canonicalJsonHash(rebuilt))
      throw new Error(
        copyInput
          ? "hip4_copy_instrument_unavailable"
          : "hip4_market_unavailable",
      );
    // Older unadmitted envelopes may have frozen valid native metadata but a
    // signing window extending beyond its known expiry. Never renew or mutate
    // those signed bytes; a fresh Review produces the capped envelope instead.
    if (current.expiry && prepared.expiresAfter > Date.parse(current.expiry))
      throw new Error("hip4_preparation_unavailable");
  }
  if (copyAttempt) await markCopySubmissionStarted(db, userId, copyAttempt);
  const saved = await db.query<Hip4SubmissionRecord>(
    `insert into hip4_order_submissions
    (action_id,funding_trade_attempt_id,signature_fingerprint,signer_address,admission_snapshot,debit_asset_id,debit_decimals,debit_raw)
    values($1,$2,$3,$4,$5::jsonb,$6,$7,$8) returning *`,
    [
      actionId,
      fundingAttemptId,
      signatureFingerprint,
      row.signer_address,
      {
        policy: tradingPolicy ?? null,
        lifecycle: {
          id: lifecycle.row?.id ?? null,
          effective: lifecycle.policy.venues.hyperliquid,
        },
        capacity: context.capacity,
        feeCapRaw: currentFees.feeCapRaw,
        feeQuote,
        funding: fundingBinding,
        telegramAppHandoff: handoff,
        ...(copyAttempt ? { copy: copyAttempt, copyPolicyRevision } : {}),
      },
      wire ? assetId : null,
      wire ? decimals : null,
      debitRaw,
    ],
  );
  if (wire)
    await db.query(
      `update orders set status='submitted',funding_operation_id=$2,
      funding_reservation_id=$3,funding_trade_attempt_id=$4 where id=$1`,
      [
        row.order_id,
        input.funding?.operationId ?? null,
        input.funding?.reservationId ?? null,
        fundingAttemptId,
      ],
    );
  if (copyInput)
    await linkPersistedCopy(db, {
      userId,
      idempotencyKey: copyInput.prepared.intent.idempotencyKey,
      persisted: {
        venue: "hyperliquid",
        orderId: row.order_id,
        executionId: null,
        venueOrderId: null,
        status: "submitted",
      },
    });
  if (handoff && nativeHandoffSubmission && !input.funding) {
    await linkTelegramAppHandoffV2DirectTradeOrderInTransaction(db, {
      userId,
      order: { ...handoff, ...nativeHandoffSubmission },
      orderId: row.order_id,
      orderStatus: "submitted",
      venueOrderId: null,
    });
  } else if (
    handoff &&
    nativeHandoffSubmission &&
    input.funding &&
    fundingAttemptId
  ) {
    await linkTelegramAppHandoffV2NativeFundedOrderInTransaction(db, {
      userId,
      order: { ...handoff, ...nativeHandoffSubmission },
      orderId: row.order_id,
      actionId,
      cloid: row.cloid,
      operationId: input.funding.operationId,
      reservationId: input.funding.reservationId,
      attemptId: fundingAttemptId,
    });
  }
  return {
    admitted: true as const,
    submission: saved.rows[0],
    request,
    environment: prepared.environment,
  };
}
