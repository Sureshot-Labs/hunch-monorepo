import { tx, type Pool, type PoolClient } from "@hunch/infra";
import type { TelegramAppHandoffV2TradeVenue } from "../services/telegram-app-handoff-v2-contract.js";

/**
 * Persistence boundary for a v2 Mini App Buy.
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
    authorityFingerprint: string;
    policyRevision: string;
    telegramUserId: string;
    venue: TelegramAppHandoffV2TradeVenue;
  }>,
) => Promise<boolean>;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/iu;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RAW_RE = /^(?:0|[1-9][0-9]*)$/u;

type SealedDirectTradeScope = Readonly<{
  amountUsd: number;
  controllerWalletAddress: string;
  marketId: string;
  maxSpendUsd: number;
  minReceiveShares: number | null;
  outcomeTokenId: string;
  venue: TelegramAppHandoffV2TradeVenue;
}>;

type LockedDirectTrade = Readonly<{
  authorityFingerprint: string;
  fundingOperationId: string | null;
  fundingReservationId: string | null;
  handoffId: string;
  intentId: string;
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
      | "plan_changed",
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
  if (!isRecord(trade) || trade.action !== "buy") {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  const venue = trade.venue;
  const marketId = requiredString(trade.marketId);
  const outcomeTokenId = requiredString(trade.outcomeTokenId);
  const controllerWalletAddress = requiredString(trade.controllerWalletAddress);
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
  // Polymarket gives us its signed order hash while Limitless CLOB gives us a
  // deterministic client order id.  Both are exact, mutually-exclusive CLOB
  // recovery identities; rejecting the former would break already-supported
  // Polymarket direct handoffs.
  const validClob =
    keys.tradeType === "clob" &&
    ((hasClientOrderId && !hasOrderHash) ||
      (hasOrderHash && !hasClientOrderId));
  const validAmm = keys.tradeType === "amm" && hasOrderHash && !hasClientOrderId;
  if (!validClob && !validAmm) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
}

/**
 * Limitless CLOB's FOK protocol has no signed minimum-receive field:
 * `takerAmount = 1` is only the venue's market-order sentinel. Its sealed
 * direct Buy is therefore constrained by identity and maximum spend, not an
 * unrelated preview-share estimate. Every other direct consumer has an exact
 * minimum to enforce.
 */
export function requiresTelegramAppHandoffV2MinimumReceive(input: Readonly<{
  executionKind: TelegramAppHandoffV2DirectTradeSubmission["executionKind"];
  venue: TelegramAppHandoffV2TradeVenue;
}>): boolean {
  return !(input.venue === "limitless" && input.executionKind === "clob");
}

function validateSubmission(
  scope: SealedDirectTradeScope,
  submission: TelegramAppHandoffV2DirectTradeSubmission,
): void {
  if (
    scope.venue !== submission.venue ||
    scope.marketId !== submission.marketId ||
    scope.outcomeTokenId !== submission.outcomeTokenId ||
    scope.controllerWalletAddress !== submission.signer.trim().toLowerCase() ||
    !/^0x[0-9a-f]{40}$/iu.test(submission.signer) ||
    !RAW_RE.test(submission.spendRaw) ||
    !RAW_RE.test(submission.receiveRaw) ||
    BigInt(submission.spendRaw) <= 0n ||
    BigInt(submission.receiveRaw) <= 0n
  ) {
    throw new TelegramAppHandoffV2DirectTradeError("order_out_of_scope");
  }
  const minimumSpendRaw = decimalToRaw(scope.amountUsd, 6, "ceil");
  const maximumSpendRaw = decimalToRaw(scope.maxSpendUsd, 6, "floor");
  const minimumReceiveRaw =
    scope.minReceiveShares == null
      ? null
      : decimalToRaw(scope.minReceiveShares, 6, "ceil");
  const requiresMinimumReceive = requiresTelegramAppHandoffV2MinimumReceive({
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
  return marker.version === 2 && marker.handoffId === handoffId;
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
  locked: LockedDirectTrade;
  scope: SealedDirectTradeScope;
}): Promise<void> {
  if (!input.assertion) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  const valid = await input.assertion({
    authorityFingerprint: input.locked.authorityFingerprint,
    policyRevision: input.locked.policyRevision,
    telegramUserId: input.locked.telegramUserId,
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
    actual.clientOrderId === expected.clientOrderId
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
  input: Readonly<{
    assertCurrentScope: TelegramAppHandoffV2ScopeAssertion;
    binding: TelegramAppHandoffV2DirectTradeBinding;
    reconcileKeys: TelegramAppHandoffV2DirectTradeReconcileKeys;
    recoveryPayload: TelegramAppHandoffV2DirectTradeRecoveryPayload;
    submission: TelegramAppHandoffV2DirectTradeSubmission;
    userId: string;
  }>,
): Promise<void> {
  validateBinding(input.binding);
  validateReconcileKeys(input.reconcileKeys);
  if (!isRecord(input.recoveryPayload)) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
  await tx(pool, (client) =>
    claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(client, input),
  );
}

export async function claimTelegramAppHandoffV2DirectTradeSubmissionInTransaction(
  client: PoolClient,
  input: Readonly<{
    assertCurrentScope: TelegramAppHandoffV2ScopeAssertion;
    binding: TelegramAppHandoffV2DirectTradeBinding;
    reconcileKeys: TelegramAppHandoffV2DirectTradeReconcileKeys;
    recoveryPayload: TelegramAppHandoffV2DirectTradeRecoveryPayload;
    submission: TelegramAppHandoffV2DirectTradeSubmission;
    userId: string;
  }>,
): Promise<void> {
  validateBinding(input.binding);
  validateReconcileKeys(input.reconcileKeys);
  if (!isRecord(input.recoveryPayload)) {
    throw new TelegramAppHandoffV2DirectTradeError("plan_changed");
  }
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
    hasSameReconcileKeys(
      locked.intentPreparedSnapshot,
      input.reconcileKeys,
    )
  ) {
    return;
  }
  await assertLiveScope({
    assertion: input.assertCurrentScope,
    locked,
    scope,
  });
  if (locked.intentStatus !== "external_handoff") {
    throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
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
 * Verify the sealed Buy at the ordinary funding-reservation consumer boundary.
 * It has no state transition: the existing funding-trade attempt remains the
 * sole durable claim. The lock only protects the immutable handoff/intent
 * facts while the live authority check runs immediately before that claim.
 */
export async function assertTelegramAppHandoffV2FundedTradeSubmission(
  pool: Pool,
  input: Readonly<{
    assertCurrentScope: TelegramAppHandoffV2ScopeAssertion;
    binding: TelegramAppHandoffV2DirectTradeBinding;
    operationId: string;
    reservationId: string;
    submission: TelegramAppHandoffV2DirectTradeSubmission;
    userId: string;
  }>,
): Promise<void> {
  validateBinding(input.binding);
  await tx(pool, async (client) => {
    const locked = await lockDirectTrade(client, {
      handoffId: input.binding.handoffId.trim(),
      userId: input.userId,
    });
    if (
      locked.intentStatus !== "funding" ||
      locked.fundingOperationId !== input.operationId ||
      locked.fundingReservationId !== input.reservationId ||
      locked.planFingerprint !==
        input.binding.planFingerprint.trim().toLowerCase() ||
      !hasExecutionMarker(locked.intentResult, locked.handoffId)
    ) {
      throw new TelegramAppHandoffV2DirectTradeError("intent_changed");
    }
    const scope = parseSealedTradeScope(locked.planSnapshot, "funding");
    validateSubmission(scope, input.submission);
    await assertLiveScope({
      assertion: input.assertCurrentScope,
      locked,
      scope,
    });
  });
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
  assertCurrentDirectTrade({
    binding: input.order,
    locked,
    submission: input.order,
  });
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
