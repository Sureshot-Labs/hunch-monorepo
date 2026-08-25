import { tx, type Pool, type PoolClient } from "@hunch/infra";
import {
  claimFundingTradeAttempt,
  claimFundingTradeAttemptInTransaction,
  type FundingTradeExecutionPath,
} from "../funding/persistence/funding-trade-attempt-repository.js";
import type { FundingTradeConsumerIntent } from "../funding/persistence/funding-trade-consumer-intent.js";
import { isRawAmount } from "../funding/domain/raw-amount.js";
import type { TelegramAppHandoffV2TradeVenue } from "../services/telegram-app-handoff-v2-contract.js";

/**
 * Persistence boundary for a v2 Mini App direct trade.
 *
 * This deliberately mirrors only the sealed direct-trade fields instead of
 * importing the v2 materializer: ordinary order persistence must stay usable
 * by API workers without pulling in funding planning/runtime dependencies.
 */
export type TelegramAppHandoffV2DirectTradeBinding = Readonly<{
  handoffId: string;
  planFingerprint: string;
}>;

export type TelegramAppHandoffV2DirectTradeSubmission = Readonly<{
  /**
   * Older Buy callers did not persist this field.  Its absence deliberately
   * means Buy so existing sealed v2 rows remain replayable.
   */
  action?: "buy" | "sell";
  /** The venue boundary determines whether the sealed minimum is enforceable. */
  executionKind: "amm" | "clob";
  marketId: string;
  outcomeTokenId: string;
  receiveRaw: string;
  /** Normalized controller that authenticated and signed this web order. */
  signer: string;
  spendRaw: string;
  venue: TelegramAppHandoffV2TradeVenue;
}>;

export type TelegramAppHandoffV2DirectTradeOrder =
  TelegramAppHandoffV2DirectTradeBinding &
    TelegramAppHandoffV2DirectTradeSubmission;

type FundingTradeAttemptClaimInput = Parameters<
  typeof claimFundingTradeAttemptInTransaction
>[1];

/**
 * The sealed handoff proof is optional only because ordinary web funding
 * consumers use the same venue endpoints.  When it is present, this helper
 * owns the full atomic handoff → intent → reservation claim boundary; callers
 * must never select that path independently.
 */
export type TelegramAppHandoffV2FundedTradeClaim = Readonly<{
  assertCurrentScope: TelegramAppHandoffV2ScopeAssertion;
  binding: TelegramAppHandoffV2DirectTradeBinding;
  submission: TelegramAppHandoffV2DirectTradeSubmission;
}>;

/**
 * Durable provider lookup key written before a direct provider call.
 * Polymarket exposes its signed order hash; Limitless CLOB exposes a client
 * order id; Limitless AMM uses the hash of the client-signed raw transaction
 * that the API broadcasts after claiming this row.
 */
export type TelegramAppHandoffV2DirectTradeReconcileKeys =
  | Readonly<{
      orderHash: string;
      tradeType: "clob";
    }>
  | Readonly<{
      clientOrderId: string;
      /** Hash of the exact signed CLOB order submitted with this client id. */
      orderFingerprint: string;
      tradeType: "clob";
    }>
  | Readonly<{
      orderHash: string;
      tradeType: "amm";
    }>;

/**
 * Data needed only to persist an order discovered after a provider response
 * was lost. It is recorded before the provider call; it is never replayed as
 * an order request.
 */
export type TelegramAppHandoffV2DirectTradeRecoveryPayload = Readonly<
  Record<string, unknown>
>;

/** Revalidates current policy and controller immediately before a provider call. */
export type TelegramAppHandoffV2ScopeAssertion = (
  input: Readonly<{
    action: "buy" | "sell";
    authorityFingerprint: string;
    /** Query-only view of the caller's existing transaction. */
    db: Pick<PoolClient, "query">;
    policyRevision: string;
    telegramUserId: string;
    tradeIntentId: string;
    venue: TelegramAppHandoffV2TradeVenue;
  }>,
) => Promise<boolean>;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/iu;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type SealedBuyDirectTradeScope = Readonly<{
  action: "buy";
  amountUsd: number;
  controllerWalletAddress: string;
  marketId: string;
  maxSpendUsd: number;
  minReceiveShares: number | null;
  outcomeTokenId: string;
  venue: TelegramAppHandoffV2TradeVenue;
}>;

type SealedSellDirectTradeScope = Readonly<{
  action: "sell";
  controllerWalletAddress: string;
  marketId: string;
  /** Exact outcome-token debit cap, in the token's six-decimal raw units. */
  maximumSharesRaw: string;
  /**
   * Sell quote floor in destination-cash raw units. It is enforceable only
   * when the selected venue payload has a corresponding bound.
   */
  minimumReceiveRaw: string;
  outcomeTokenId: string;
  venue: TelegramAppHandoffV2TradeVenue;
}>;

type SealedDirectTradeScope =
  | SealedBuyDirectTradeScope
  | SealedSellDirectTradeScope;

type LockedDirectTrade = Readonly<{
  authorityFingerprint: string;
  fundingOperationId: string | null;
  fundingReservationId: string | null;
  handoffId: string;
  intentId: string;
  intentAction: string;
  intentPreparedSnapshot: unknown;
  intentResult: unknown;
  intentStatus: string;
  planFingerprint: string;
  planSnapshot: unknown;
  policyRevision: string;
  telegramUserId: string;
}>;

export class TelegramAppHandoffV2DirectTradeError extends Error {
  constructor(
    readonly code:
      | "handoff_not_ready"
      | "intent_changed"
      | "order_out_of_scope"
      | "plan_changed"
      | "sell_position_unavailable",
  ) {
    super(code);
    this.name = "TelegramAppHandoffV2DirectTradeError";
  }
}

type DirectTradeTerminalReason = Readonly<{
  code: string;
  message: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decimalToRaw(
  value: number,
  decimals: number,
  rounding: "ceil" | "floor",
) {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(decimals)) {
    return null;
  }
  const text = String(value);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(text);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const scale = 10n ** BigInt(decimals);
  const retained = fraction.slice(0, decimals).padEnd(decimals, "0");
  const discarded = fraction.slice(decimals);
  let raw = BigInt(whole) * scale + BigInt(retained || "0");
  if (rounding === "ceil" && /[1-9]/u.test(discarded)) raw += 1n;
  return raw;
}

function parseSealedTradeScope(
  snapshot: unknown,
  expectedKind: "direct_trade" | "funding",
): SealedDirectTradeScope {
  if (
    !isRecord(snapshot) ||
    snapshot.version !== 2 ||
    snapshot.kind !== expectedKind
  ) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  const trade = snapshot.trade;
  if (!isRecord(trade) || (trade.action !== "buy" && trade.action !== "sell")) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  const venue = trade.venue;
  const marketId = requiredString(trade.marketId);
  const outcomeTokenId = requiredString(trade.outcomeTokenId);
  const controllerWalletAddress = requiredString(trade.controllerWalletAddress);
  if (trade.action === "sell") {
    const maximumSharesRaw =
      typeof trade.sharesRaw === "string" ? trade.sharesRaw : null;
    const minimumReceiveRaw =
      typeof trade.minimumReceiveRaw === "string"
        ? trade.minimumReceiveRaw
        : null;
    if (
      (venue !== "polymarket" && venue !== "limitless") ||
      !marketId ||
      !outcomeTokenId ||
      !controllerWalletAddress ||
      !/^0x[0-9a-f]{40}$/iu.test(controllerWalletAddress) ||
      !maximumSharesRaw ||
      !minimumReceiveRaw ||
      !isRawAmount(maximumSharesRaw) ||
      !isRawAmount(minimumReceiveRaw) ||
      BigInt(maximumSharesRaw) <= 0n ||
      BigInt(minimumReceiveRaw) <= 0n
    ) {
      throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
    }
    return {
      action: "sell",
      controllerWalletAddress: controllerWalletAddress.toLowerCase(),
      marketId,
      maximumSharesRaw,
      minimumReceiveRaw,
      outcomeTokenId,
      venue,
    };
  }
  const amountUsd = trade.amountUsd;
  const maxSpendUsd = trade.maxSpendUsd;
  const minReceiveShares = trade.minReceiveShares;
  if (
    (venue !== "polymarket" && venue !== "limitless") ||
    !marketId ||
    !outcomeTokenId ||
    !controllerWalletAddress ||
    !/^0x[0-9a-f]{40}$/iu.test(controllerWalletAddress) ||
    typeof amountUsd !== "number" ||
    !Number.isFinite(amountUsd) ||
    amountUsd <= 0 ||
    typeof maxSpendUsd !== "number" ||
    !Number.isFinite(maxSpendUsd) ||
    maxSpendUsd < amountUsd ||
    !(
      minReceiveShares == null ||
      (typeof minReceiveShares === "number" &&
        Number.isFinite(minReceiveShares) &&
        minReceiveShares >= 0)
    )
  ) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  return {
    action: "buy",
    amountUsd,
    controllerWalletAddress: controllerWalletAddress.toLowerCase(),
    marketId,
    maxSpendUsd,
    minReceiveShares: minReceiveShares ?? null,
    outcomeTokenId,
    venue,
  };
}

function validateBinding(
  binding: TelegramAppHandoffV2DirectTradeBinding,
): void {
  if (!UUID_RE.test(binding.handoffId.trim())) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  if (!SHA256_HEX_RE.test(binding.planFingerprint.trim())) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
}

function validateReconcileKeys(
  keys: TelegramAppHandoffV2DirectTradeReconcileKeys,
): void {
  const hasOrderHash =
    "orderHash" in keys && /^0x[0-9a-f]{64}$/iu.test(keys.orderHash);
  const hasClientOrderId =
    "clientOrderId" in keys &&
    /^hunch-th2-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      keys.clientOrderId,
    );
  const hasOrderFingerprint =
    "orderFingerprint" in keys && SHA256_HEX_RE.test(keys.orderFingerprint);
  // Polymarket gives us its signed order hash while Limitless CLOB gives us a
  // deterministic client order id.  Both are exact, mutually-exclusive CLOB
  // recovery identities; rejecting the former would break already-supported
  // Polymarket direct handoffs.
  const validClob =
    keys.tradeType === "clob" &&
    ((hasClientOrderId && hasOrderFingerprint && !hasOrderHash) ||
      (hasOrderHash && !hasClientOrderId));
  const validAmm =
    keys.tradeType === "amm" && hasOrderHash && !hasClientOrderId;
  if (!validClob && !validAmm) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
}

function validateClaimInput(
  input: TelegramAppHandoffV2DirectTradeClaimInput,
): void {
  validateBinding(input.binding);
  validateReconcileKeys(input.reconcileKeys);
  if (!isRecord(input.recoveryPayload)) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
}

type TelegramAppHandoffV2DirectTradeClaimInput = Readonly<{
  assertCurrentScope: TelegramAppHandoffV2ScopeAssertion;
  binding: TelegramAppHandoffV2DirectTradeBinding;
  reconcileKeys: TelegramAppHandoffV2DirectTradeReconcileKeys;
  recoveryPayload: TelegramAppHandoffV2DirectTradeRecoveryPayload;
  /**
   * Reads the current lock-adjusted outcome balance after the durable Sell
   * lane is held. Passing a sampled balance would reopen a gap between that
   * read and the direct claim/order-link transitions.
   */
  readSellPositionAvailableRaw?: () => Promise<string>;
  submission: TelegramAppHandoffV2DirectTradeSubmission;
  userId: string;
}>;

async function lockDirectSellLaneInTransaction(input: {
  client: PoolClient;
  scope: SealedSellDirectTradeScope;
}): Promise<void> {
  await input.client.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    [
      [
        "telegram_app_handoff_direct_sell",
        input.scope.venue,
        input.scope.controllerWalletAddress,
        input.scope.outcomeTokenId,
      ].join(":"),
    ],
  );
}

async function reserveUnpersistedDirectSellCapacityInTransaction(input: {
  availableRaw: string;
  client: PoolClient;
  currentIntentId: string;
  scope: SealedSellDirectTradeScope;
  requestedRaw: string;
}): Promise<void> {
  if (!isRawAmount(input.availableRaw)) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  const pending = await input.client.query<{ reserved_raw: string }>(
    `select coalesce(
       sum(
         case
           when handoff_row.plan_snapshot -> 'trade' ->> 'sharesRaw' ~ '^[0-9]+$'
             then (handoff_row.plan_snapshot -> 'trade' ->> 'sharesRaw')::numeric
           else 0
         end
       ),
       0
     )::text as reserved_raw
       from telegram_trade_intents intent
       join telegram_app_handoffs handoff_row
         on handoff_row.trade_intent_id = intent.id
        and handoff_row.user_id = intent.user_id
      where intent.id <> $1::uuid
        and intent.action = 'sell'
        and intent.delivery_mode = 'app_handoff'
        and intent.funding_operation_id is null
        and intent.order_id is null
        and intent.status in ('executing', 'submitted', 'reconcile_required')
        and handoff_row.state = 'committed'
        and handoff_row.plan_snapshot ->> 'version' = '2'
        and handoff_row.plan_snapshot ->> 'kind' = 'direct_trade'
        and lower(handoff_row.plan_snapshot -> 'trade' ->> 'controllerWalletAddress') = $2
        and handoff_row.plan_snapshot -> 'trade' ->> 'outcomeTokenId' = $3`,
    [
      input.currentIntentId,
      input.scope.controllerWalletAddress,
      input.scope.outcomeTokenId,
    ],
  );
  const reservedRaw = BigInt(pending.rows[0]?.reserved_raw ?? "0");
  if (BigInt(input.requestedRaw) + reservedRaw > BigInt(input.availableRaw)) {
    throw new TelegramAppHandoffV2DirectTradeError("sell_position_unavailable");
  }
}

/**
 * Limitless CLOB's FOK protocol has no signed minimum-receive field:
 * `takerAmount = 1` is only the venue's market-order sentinel. Its sealed
 * direct trade is therefore constrained by identity and source debit, not an
 * unrelated preview estimate. Consumers with an on-venue minimum field still
 * enforce the sealed floor.
 */
export function requiresTelegramAppHandoffV2MinimumReceive(
  input: Readonly<{
    action?: "buy" | "sell";
    executionKind: TelegramAppHandoffV2DirectTradeSubmission["executionKind"];
    venue: TelegramAppHandoffV2TradeVenue;
  }>,
): boolean {
  // Limitless CLOB's FOK payload cannot encode a minimum for either side.
  // It is bounded by the exact source debit and immediate-or-no-fill semantics.
  return !(input.venue === "limitless" && input.executionKind === "clob");
}

function validateSubmission(
  scope: SealedDirectTradeScope,
  submission: TelegramAppHandoffV2DirectTradeSubmission,
): void {
  const action = submission.action ?? "buy";
  if (
    scope.venue !== submission.venue ||
    scope.marketId !== submission.marketId ||
    scope.outcomeTokenId !== submission.outcomeTokenId ||
    scope.controllerWalletAddress !== submission.signer.trim().toLowerCase() ||
    !/^0x[0-9a-f]{40}$/iu.test(submission.signer) ||
    !isRawAmount(submission.spendRaw) ||
    !isRawAmount(submission.receiveRaw) ||
    BigInt(submission.spendRaw) <= 0n ||
    BigInt(submission.receiveRaw) <= 0n
  ) {
    throw new TelegramAppHandoffV2DirectTradeError("order_out_of_scope");
  }
  if (scope.action !== action) {
    throw new TelegramAppHandoffV2DirectTradeError("order_out_of_scope");
  }
  if (scope.action === "sell") {
    if (
      BigInt(submission.spendRaw) !== BigInt(scope.maximumSharesRaw) ||
      (requiresTelegramAppHandoffV2MinimumReceive({
        action,
        executionKind: submission.executionKind,
        venue: scope.venue,
      }) &&
        BigInt(submission.receiveRaw) < BigInt(scope.minimumReceiveRaw))
    ) {
      throw new TelegramAppHandoffV2DirectTradeError("order_out_of_scope");
    }
    return;
  }
  const minimumSpendRaw = decimalToRaw(scope.amountUsd, 6, "ceil");
  const maximumSpendRaw = decimalToRaw(scope.maxSpendUsd, 6, "floor");
  const minimumReceiveRaw =
    scope.minReceiveShares == null
      ? null
      : decimalToRaw(scope.minReceiveShares, 6, "ceil");
  const requiresMinimumReceive = requiresTelegramAppHandoffV2MinimumReceive({
    action,
    executionKind: submission.executionKind,
    venue: scope.venue,
  });
  if (
    minimumSpendRaw == null ||
    maximumSpendRaw == null ||
    (minimumReceiveRaw == null && scope.minReceiveShares != null) ||
    BigInt(submission.spendRaw) < minimumSpendRaw ||
    BigInt(submission.spendRaw) > maximumSpendRaw ||
    (requiresMinimumReceive &&
      minimumReceiveRaw != null &&
      BigInt(submission.receiveRaw) < minimumReceiveRaw)
  ) {
    throw new TelegramAppHandoffV2DirectTradeError("order_out_of_scope");
  }
}

function hasExecutionMarker(result: unknown, handoffId: string): boolean {
  if (!isRecord(result) || !isRecord(result.appHandoffExecution)) return false;
  const marker = result.appHandoffExecution;
  // Early v2 Buy markers predate `kind`; retain their compatibility while a
  // direct-trade consumer never accepts a funding marker as its own claim.
  return (
    marker.version === 2 &&
    marker.handoffId === handoffId &&
    (marker.kind == null || marker.kind === "direct_trade")
  );
}

function hasFundingExecutionMarker(
  result: unknown,
  handoffId: string,
): boolean {
  if (!isRecord(result) || !isRecord(result.appHandoffExecution)) return false;
  const marker = result.appHandoffExecution;
  // Early v2 Buy markers predate `kind`. They remain compatible only at the
  // funding consumer boundary; a direct trade claim never accepts them here.
  return (
    marker.version === 2 &&
    marker.handoffId === handoffId &&
    (marker.kind == null || marker.kind === "funding")
  );
}

function hasSameOrderMarker(input: {
  orderId: string;
  result: unknown;
  handoffId: string;
}): boolean {
  if (
    !isRecord(input.result) ||
    !isRecord(input.result.appHandoffDirectTrade)
  ) {
    return false;
  }
  const marker = input.result.appHandoffDirectTrade;
  return (
    marker.version === 2 &&
    marker.handoffId === input.handoffId &&
    marker.orderId === input.orderId
  );
}

async function lockDirectTrade(
  client: PoolClient,
  input: Readonly<{ handoffId: string; userId: string }>,
): Promise<LockedDirectTrade> {
  const { rows } = await client.query<{
    authority_fingerprint: string;
    funding_operation_id: string | null;
    funding_reservation_id: string | null;
    handoff_id: string;
    intent_id: string;
    intent_action: string;
    intent_prepared_snapshot: unknown;
    intent_result: unknown;
    intent_status: string;
    plan_fingerprint: string;
    plan_snapshot: unknown;
    policy_revision: string;
    telegram_user_id: string;
  }>(
    `select handoff_row.id::text as handoff_id,
            handoff_row.authority_fingerprint,
            handoff_row.policy_revision,
            intent.id::text as intent_id,
            intent.action as intent_action,
            intent.prepared_snapshot as intent_prepared_snapshot,
            intent.result as intent_result,
            intent.status as intent_status,
            intent.funding_operation_id::text as funding_operation_id,
            intent.funding_reservation_id::text as funding_reservation_id,
            intent.telegram_user_id::text as telegram_user_id,
            handoff_row.plan_fingerprint,
            handoff_row.plan_snapshot
       from telegram_app_handoffs handoff_row
       join telegram_trade_intents intent
         on intent.id = handoff_row.trade_intent_id
        and intent.user_id = handoff_row.user_id
      where handoff_row.id = $1::uuid
        and handoff_row.user_id = $2::uuid
        and handoff_row.state = 'committed'
        and handoff_row.plan_snapshot->>'version' = '2'
      for update of handoff_row, intent`,
    [input.handoffId, input.userId],
  );
  const row = rows[0];
  if (!row) throw new TelegramAppHandoffV2DirectTradeError("handoff_not_ready");
  return {
    authorityFingerprint: row.authority_fingerprint,
    fundingOperationId: row.funding_operation_id,
    fundingReservationId: row.funding_reservation_id,
    handoffId: row.handoff_id,
    intentId: row.intent_id,
    intentAction: row.intent_action,
    intentPreparedSnapshot: row.intent_prepared_snapshot,
    intentResult: row.intent_result,
    intentStatus: row.intent_status,
    planFingerprint: row.plan_fingerprint,
    planSnapshot: row.plan_snapshot,
    policyRevision: row.policy_revision,
    telegramUserId: row.telegram_user_id,
  };
}

async function assertLiveScope(input: {
  assertion?: TelegramAppHandoffV2ScopeAssertion;
  client: PoolClient;
  locked: LockedDirectTrade;
  scope: SealedDirectTradeScope;
}): Promise<void> {
  if (!input.assertion) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  const valid = await input.assertion({
    action: input.scope.action,
    authorityFingerprint: input.locked.authorityFingerprint,
    // Strip PoolClient.connect(): the scope helper must participate in this
    // transaction, never mistake an acquired client for a Pool and nest BEGIN.
    db: { query: input.client.query.bind(input.client) },
    policyRevision: input.locked.policyRevision,
    telegramUserId: input.locked.telegramUserId,
    tradeIntentId: input.locked.intentId,
    venue: input.scope.venue,
  });
  if (!valid) throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
}

function assertCurrentDirectTrade(input: {
  binding: TelegramAppHandoffV2DirectTradeBinding;
  locked: LockedDirectTrade;
  submission: TelegramAppHandoffV2DirectTradeSubmission;
}): SealedDirectTradeScope {
  if (
    input.locked.planFingerprint !==
      input.binding.planFingerprint.trim().toLowerCase() ||
    !hasExecutionMarker(input.locked.intentResult, input.locked.handoffId)
  ) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  const scope = parseSealedTradeScope(
    input.locked.planSnapshot,
    "direct_trade",
  );
  if (scope.action !== input.locked.intentAction) {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
  }
  validateSubmission(scope, input.submission);
  return scope;
}

function hasSameReconcileKeys(
  snapshot: unknown,
  expected: TelegramAppHandoffV2DirectTradeReconcileKeys,
): boolean {
  if (!isRecord(snapshot) || !isRecord(snapshot.reconcileKeys)) return false;
  const actual = snapshot.reconcileKeys;
  if ("orderHash" in expected) {
    return (
      actual.tradeType === expected.tradeType &&
      typeof actual.orderHash === "string" &&
      actual.orderHash.toLowerCase() === expected.orderHash.toLowerCase()
    );
  }
  return (
    actual.tradeType === "clob" &&
    "clientOrderId" in expected &&
    typeof actual.clientOrderId === "string" &&
    actual.clientOrderId === expected.clientOrderId &&
    typeof actual.orderFingerprint === "string" &&
    actual.orderFingerprint.toLowerCase() ===
      expected.orderFingerprint.toLowerCase()
  );
}

/**
 * Claim the single direct web submission immediately before the venue request.
 * A user may still close the Mini App beforehand; once this claim succeeds we
 * keep the intent in normal `executing` reconciliation rather than allowing a
 * concurrent Telegram cancel to race a signed venue order.
 */
export async function claimTelegramAppHandoffV2DirectTradeSubmission(
  pool: Pool,
  input: TelegramAppHandoffV2DirectTradeClaimInput,
): Promise<void> {
  validateClaimInput(input);
  await tx(pool, (client) =>
    claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, input),
  );
}

export async function claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(
  client: PoolClient,
  input: TelegramAppHandoffV2DirectTradeClaimInput,
): Promise<void> {
  validateClaimInput(input);
  const locked = await lockDirectTrade(client, {
    handoffId: input.binding.handoffId.trim(),
    userId: input.userId,
  });
  const scope = assertCurrentDirectTrade({
    binding: input.binding,
    locked,
    submission: input.submission,
  });
  // A retry with the same provider identity must be harmless.  In particular,
  // a caller can safely re-broadcast the same signed AMM transaction after a
  // response loss; the chain deduplicates its hash and this row remains the
  // only claim.  A changed identity still fails closed below.
  if (
    locked.intentStatus === "executing" &&
    hasSameReconcileKeys(locked.intentPreparedSnapshot, input.reconcileKeys)
  ) {
    return;
  }
  await assertLiveScope({
    assertion: input.assertCurrentScope,
    client,
    locked,
    scope,
  });
  if (locked.intentStatus !== "external_handoff") {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
  }
  if (scope.action === "sell") {
    await lockDirectSellLaneInTransaction({ client, scope });
    if (!input.readSellPositionAvailableRaw) {
      throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
    }
    await reserveUnpersistedDirectSellCapacityInTransaction({
      availableRaw: await input.readSellPositionAvailableRaw(),
      client,
      currentIntentId: locked.intentId,
      requestedRaw: input.submission.spendRaw,
      scope,
    });
  }
  const claimed = await client.query(
    `update telegram_trade_intents intent
        set status = 'executing',
            submit_started_at = coalesce(intent.submit_started_at, clock_timestamp()),
            result = coalesce(intent.result, '{}'::jsonb)
              || jsonb_build_object(
                'appHandoffDirectTradeClaim',
                jsonb_build_object(
                  'handoffId', $2::uuid,
                  'planFingerprint', $3::text,
                  'version', 2
                )
              ),
            prepared_snapshot = jsonb_build_object(
              'authorizationMode', 'client_signed',
              'preparedId', concat('handoff-v2:', $2::uuid),
              'reconcileKeys', $4::jsonb,
              'recoveryPayload', $5::jsonb
            ),
            updated_at = clock_timestamp()
      where intent.id = $1::uuid
        and intent.status = 'external_handoff'`,
    [
      locked.intentId,
      locked.handoffId,
      input.binding.planFingerprint.trim().toLowerCase(),
      JSON.stringify(input.reconcileKeys),
      JSON.stringify(input.recoveryPayload),
    ],
  );
  if ((claimed.rowCount ?? 0) !== 1) {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
  }
}

/**
 * Claims a ready funding reservation for one ordinary venue consumer.
 *
 * The v2 handoff variant deliberately lives beside the generic claim rather
 * than in each venue service.  This keeps the cancellation-safe atomic
 * boundary uniform for Polymarket, Limitless CLOB and Limitless AMM, while
 * preserving the ordinary web path when no sealed handoff is attached.
 */
export async function claimFundingTradeAttemptForVenueConsumer(
  pool: Pool,
  input: Readonly<
    Omit<FundingTradeAttemptClaimInput, "allowTelegramAppHandoffV2"> & {
      handoff: TelegramAppHandoffV2FundedTradeClaim | null;
    }
  >,
): ReturnType<typeof claimFundingTradeAttemptInTransaction> {
  const { handoff, ...claimInput } = input;
  if (!handoff) {
    return claimFundingTradeAttempt(pool, claimInput);
  }
  return claimTelegramAppHandoffV2FundedTradeAttempt(pool, {
    ...claimInput,
    assertCurrentScope: handoff.assertCurrentScope,
    binding: handoff.binding,
    submission: handoff.submission,
  });
}

/**
 * Atomically claim a funded v2 Buy at the ordinary venue boundary.
 *
 * The handoff, intent and funding reservation must be checked and claimed in
 * one transaction. Otherwise a Telegram cancellation can win after the scope
 * check but before the provider request is durably owned.
 */
export async function claimTelegramAppHandoffV2FundedTradeAttempt(
  pool: Pool,
  input: Readonly<{
    assertCurrentScope: TelegramAppHandoffV2ScopeAssertion;
    binding: TelegramAppHandoffV2DirectTradeBinding;
    canonicalFingerprint: string;
    consumerIntent: FundingTradeConsumerIntent;
    executionPath: FundingTradeExecutionPath;
    externalReference?: string | null;
    idempotencyKey: string;
    marketId: string;
    operationId: string;
    reservationId: string;
    submission: TelegramAppHandoffV2DirectTradeSubmission;
    userId: string;
    now?: Date;
  }>,
): ReturnType<typeof claimFundingTradeAttemptInTransaction> {
  validateBinding(input.binding);
  return tx(pool, (client) =>
    claimTelegramAppHandoffV2FundedTradeAttemptInTransaction(client, input),
  );
}

export async function claimTelegramAppHandoffV2FundedTradeAttemptInTransaction(
  client: PoolClient,
  input: Readonly<{
    assertCurrentScope: TelegramAppHandoffV2ScopeAssertion;
    binding: TelegramAppHandoffV2DirectTradeBinding;
    canonicalFingerprint: string;
    consumerIntent: FundingTradeConsumerIntent;
    executionPath: FundingTradeExecutionPath;
    externalReference?: string | null;
    idempotencyKey: string;
    marketId: string;
    operationId: string;
    reservationId: string;
    submission: TelegramAppHandoffV2DirectTradeSubmission;
    userId: string;
    now?: Date;
  }>,
): ReturnType<typeof claimFundingTradeAttemptInTransaction> {
  validateBinding(input.binding);
  const locked = await lockDirectTrade(client, {
    handoffId: input.binding.handoffId.trim(),
    userId: input.userId,
  });
  // `external_handoff` is accepted only with the same exact committed funding
  // operation, reservation, plan fingerprint and funding execution marker
  // checked below. Older status callbacks could relabel a ready funded intent
  // while rebuilding its Mini App link; accepting that label here repairs the
  // state without widening the sealed source or trade scope.
  if (
    !["funding", "external_handoff", "executing"].includes(
      locked.intentStatus,
    ) ||
    locked.fundingOperationId !== input.operationId ||
    locked.fundingReservationId !== input.reservationId ||
    locked.planFingerprint !==
      input.binding.planFingerprint.trim().toLowerCase() ||
    !hasFundingExecutionMarker(locked.intentResult, locked.handoffId)
  ) {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
  }
  const scope = parseSealedTradeScope(locked.planSnapshot, "funding");
  validateSubmission(scope, input.submission);
  await assertLiveScope({
    assertion: input.assertCurrentScope,
    client,
    locked,
    scope,
  });
  const claim = await claimFundingTradeAttemptInTransaction(client, {
    allowTelegramAppHandoffV2: true,
    canonicalFingerprint: input.canonicalFingerprint,
    consumerIntent: input.consumerIntent,
    executionPath: input.executionPath,
    externalReference: input.externalReference,
    idempotencyKey: input.idempotencyKey,
    marketId: input.marketId,
    now: input.now,
    operationId: input.operationId,
    reservationId: input.reservationId,
    userId: input.userId,
    venueId: scope.venue,
  });
  if (!claim.claimed) return claim;
  const marked = await client.query(
    `update telegram_trade_intents intent
          set status = 'executing',
              submit_started_at = coalesce(intent.submit_started_at, clock_timestamp()),
              error_code = case
                when intent.error_code = 'external_handoff_required' then null
                else intent.error_code
              end,
              error_message = case
                when intent.error_code = 'external_handoff_required' then null
                else intent.error_message
              end,
              result = coalesce(intent.result, '{}'::jsonb)
                || jsonb_build_object(
                  'appHandoffTradeExecution',
                  jsonb_build_object(
                    'attemptId', $4::uuid,
                    'handoffId', $2::uuid,
                    'planFingerprint', $3::text,
                    'version', 2
                  )
                ),
              updated_at = clock_timestamp()
        where intent.id = $1::uuid
          and intent.status in ('funding', 'external_handoff', 'executing')
          and intent.funding_operation_id = $5::uuid
          and intent.funding_reservation_id = $6::uuid`,
    [
      locked.intentId,
      locked.handoffId,
      input.binding.planFingerprint.trim().toLowerCase(),
      claim.attempt.id,
      input.operationId,
      input.reservationId,
    ],
  );
  if ((marked.rowCount ?? 0) !== 1) {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
  }
  return claim;
}

/**
 * Runs inside `storeOrderInTransaction` after an ordinary web order exists.
 * The original Telegram intent becomes the durable consumer exactly once;
 * retrying the same venue order is an idempotent no-op.
 */
export async function linkTelegramAppHandoffV2DirectTradeOrderInTransaction(
  client: PoolClient,
  input: Readonly<{
    order: TelegramAppHandoffV2DirectTradeOrder;
    orderId: string;
    orderStatus: string;
    userId: string;
    venueOrderId: string;
  }>,
): Promise<void> {
  validateBinding(input.order);
  const locked = await lockDirectTrade(client, {
    handoffId: input.order.handoffId.trim(),
    userId: input.userId,
  });
  const scope = assertCurrentDirectTrade({
    binding: input.order,
    locked,
    submission: input.order,
  });
  if (scope.action === "sell") {
    // The direct claim holds this lane while it reads the live balance. Taking
    // it here makes the unpersisted-claim → order-lock transition indivisible
    // to the next Sell admission.
    await lockDirectSellLaneInTransaction({ client, scope });
  }
  if (
    hasSameOrderMarker({
      handoffId: locked.handoffId,
      orderId: input.orderId,
      result: locked.intentResult,
    })
  ) {
    return;
  }
  if (locked.intentStatus !== "executing") {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
  }
  const terminalFill = ["filled", "matched"].includes(
    input.orderStatus.trim().toLowerCase(),
  );
  const linked = await client.query(
    `update telegram_trade_intents intent
        set status = $4::text,
            order_id = $2::uuid,
            venue_order_id = $3::text,
            submitted_at = coalesce(intent.submitted_at, clock_timestamp()),
            result = coalesce(intent.result, '{}'::jsonb)
              || jsonb_build_object(
                'appHandoffDirectTrade',
                jsonb_build_object(
                  'handoffId', $5::uuid,
                  'orderId', $2::uuid,
                  'planFingerprint', $6::text,
                  'venueOrderId', $3::text,
                  'version', 2
                )
              ),
            updated_at = clock_timestamp()
      where intent.id = $1::uuid
        and intent.status = 'executing'
        and (intent.order_id is null or intent.order_id = $2::uuid)`,
    [
      locked.intentId,
      input.orderId,
      input.venueOrderId,
      terminalFill ? "filled" : "submitted",
      locked.handoffId,
      input.order.planFingerprint.trim().toLowerCase(),
    ],
  );
  if ((linked.rowCount ?? 0) !== 1) {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
  }
}

/**
 * Close only a conclusively rejected direct submission. Transport and 5xx
 * outcomes deliberately do not call this function: once the venue may have
 * accepted an order, the intent must remain reconcilable rather than being
 * reopened for a second Buy.
 */
export async function failTelegramAppHandoffV2DirectTradeSubmission(
  pool: Pool,
  input: Readonly<{
    binding: TelegramAppHandoffV2DirectTradeBinding;
    reason: DirectTradeTerminalReason;
    submission: TelegramAppHandoffV2DirectTradeSubmission;
    userId: string;
  }>,
): Promise<void> {
  validateBinding(input.binding);
  await tx(pool, (client) =>
    failTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, input),
  );
}

export async function failTelegramAppHandoffV2DirectTradeSubmissionInTransaction(
  client: PoolClient,
  input: Readonly<{
    binding: TelegramAppHandoffV2DirectTradeBinding;
    reason: DirectTradeTerminalReason;
    submission: TelegramAppHandoffV2DirectTradeSubmission;
    userId: string;
  }>,
): Promise<void> {
  validateBinding(input.binding);
  const code = input.reason.code.trim();
  const message = input.reason.message.trim();
  if (!code || !message) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  const locked = await lockDirectTrade(client, {
    handoffId: input.binding.handoffId.trim(),
    userId: input.userId,
  });
  assertCurrentDirectTrade({
    binding: input.binding,
    locked,
    submission: input.submission,
  });
  if (locked.intentStatus === "failed") return;
  if (locked.intentStatus !== "executing") {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
  }
  const failed = await client.query(
    `update telegram_trade_intents intent
        set status = 'failed',
            error_code = $2::text,
            error_message = $3::text,
            result = coalesce(intent.result, '{}'::jsonb)
              || jsonb_build_object(
                'appHandoffDirectTradeFailure',
                jsonb_build_object(
                  'code', $2::text,
                  'handoffId', $4::uuid,
                  'planFingerprint', $5::text,
                  'version', 2
                )
              ),
            updated_at = clock_timestamp()
      where intent.id = $1::uuid
        and intent.status = 'executing'`,
    [
      locked.intentId,
      code,
      message,
      locked.handoffId,
      input.binding.planFingerprint.trim().toLowerCase(),
    ],
  );
  if ((failed.rowCount ?? 0) !== 1) {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
  }
}
