import { tx, type Pool, type PoolClient } from "@hunch/infra";
import {
  normalizePolymarketAssetId,
  parsePolymarketAssetContext,
} from "@hunch/shared";
import {
  isEvmAddress,
  normalizeOptionalWalletForStorage,
  normalizeWalletForStorage,
} from "../lib/wallet-address.js";
import { isRecord } from "../lib/type-guards.js";
import {
  buildLimitlessClobSubmissionContext,
  LIMITLESS_COLLATERAL_ATTEMPT_PROGRAM,
  LIMITLESS_RECEIPT_LOCATOR_HASHES_KEY,
  limitlessClobFrozenContext,
  limitlessClobSubmittedOrder,
  normalizeLimitlessReceiptLocatorHashes,
  readRetainedLimitlessClobSubmission,
  withoutLimitlessRecoverySignatures,
  type LimitlessClobSubmissionContext,
} from "../services/limitless-clob-evidence-identity.js";
import { consumeFundingReservationForLinkedConsumerInTransaction } from "../funding/persistence/funding-evidence-repository.js";
import { persistedTradeTerminalOutcome } from "../funding/persistence/funding-trade-consumer-status.js";
import { recoverFundingTradeAttemptForOrderInTransaction } from "../funding/persistence/funding-trade-attempt-repository.js";
import {
  linkTelegramAppHandoffV2DirectTradeOrderInTransaction,
  type TelegramAppHandoffV2DirectTradeOrder,
} from "./telegram-app-handoff-v2-direct-trade-repository.js";
import type { OrderHistoryRow, OrderRow, PgParams } from "../server-types.js";
import { acquirePositionMutationLock } from "./positions-repo.js";
import {
  appendLimitlessObservedLocatorSql,
  readLimitlessObservedLocator,
  type LimitlessHistoryObservation,
} from "./limitless-observed-locator.js";
import {
  lockLimitlessFokScope,
  readOtherPendingLimitlessFok,
} from "./limitless-fok-submit-fence.js";
import {
  limitlessFrozenCollateralSql,
  limitlessHistoryClientIdSql,
  limitlessHistoryProviderIdSql,
} from "./limitless-history-receipt-locators.js";

const POSITION_DELTA_APPLIED_MARKER = "_hunchPositionDeltaAppliedAt";
const LIMITLESS_CLOB_CONTEXT_KEY = "_hunchLimitlessClob";
const LIMITLESS_HISTORY_TX_KEY = "_hunchLimitlessHistoryTxHashes";

const LIMITLESS_HISTORY_FALLBACK_STATUSES = [
  "submitted",
  "open",
  "pending",
  "matched",
  "filled",
  "expired",
  "live",
  "active",
  "delayed",
  "unconfirmed",
  "partial_filled",
  "partially_filled",
];

/** Provider/client payloads cannot grant themselves server-owned provenance. */
function withoutIncomingLimitlessClobContext(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const sanitized = { ...payload };
  delete sanitized[LIMITLESS_CLOB_CONTEXT_KEY];
  delete sanitized._hunchLimitlessReceiptSearchV1;
  delete sanitized[LIMITLESS_HISTORY_TX_KEY];
  delete sanitized[LIMITLESS_RECEIPT_LOCATOR_HASHES_KEY];
  delete sanitized._hunchLimitlessDirectLocator;
  delete sanitized._hunchLimitlessDirectObservedAt;
  for (const key of [
    "_hunchSubmitted",
    "submitted",
    "payload",
    "order",
    "_hunchUpstream",
    "data",
    "history",
  ]) {
    if (isRecord(sanitized[key]))
      sanitized[key] = withoutIncomingLimitlessClobContext(sanitized[key]);
  }
  return sanitized;
}

function validatedLimitlessClobContext(
  payload: unknown,
  context: unknown,
): {
  context: LimitlessClobSubmissionContext;
  signedOrder: Record<string, unknown>;
} {
  const signedOrder = isRecord(payload)
    ? limitlessClobSubmittedOrder(payload)
    : null;
  if (
    !signedOrder ||
    !isRecord(context) ||
    context.contextVersion !== 1 ||
    context.chainId !== 8453 ||
    typeof context.exchangeAddress !== "string" ||
    typeof context.orderHash !== "string"
  )
    throw new Error("Invalid server-owned Limitless CLOB submission context");
  const expected = buildLimitlessClobSubmissionContext(
    context.exchangeAddress,
    signedOrder,
    typeof context.collateralFeeModule === "string"
      ? context.collateralFeeModule
      : undefined,
  );
  if (expected.orderHash !== context.orderHash.toLowerCase())
    throw new Error(
      "Limitless CLOB submission context does not match signed order",
    );
  if (expected.collateralFeeModule) {
    const side = String(signedOrder.side);
    const retained =
      (side === "0" || side === "1") &&
      readRetainedLimitlessClobSubmission(
        { order: signedOrder, context: expected },
        {
          walletAddress: String(signedOrder.maker),
          tokenId: String(signedOrder.tokenId),
          side: side === "0" ? "BUY" : "SELL",
        },
      );
    if (!retained)
      throw new Error("Invalid server-owned Limitless collateral submission");
    const clientOrderId =
      signedOrder.clientOrderId ??
      (isRecord(payload) ? payload.clientOrderId : null);
    return {
      context: retained.context,
      signedOrder: {
        ...retained.order,
        ...(typeof clientOrderId === "string" ? { clientOrderId } : {}),
      },
    };
  }
  return { context: expected, signedOrder };
}

function limitlessStoredUpstreamPayloadSqlExpression(
  payloadExpression = "order_payload",
): string {
  return `coalesce(
    ${payloadExpression}->'_hunchUpstream',
    ${payloadExpression}->'submitted'->'_hunchUpstream',
    ${payloadExpression}->'payload'->'_hunchUpstream',
    ${payloadExpression}->'submitted'->'payload'->'_hunchUpstream'
  )`;
}

function limitlessStoredExecutionSqlExpression(
  payloadExpression = "order_payload",
): string {
  const upstream =
    limitlessStoredUpstreamPayloadSqlExpression(payloadExpression);
  return `coalesce(
    (${upstream})->'execution',
    (${upstream})->'order'->'execution',
    (${upstream})->'data'->'execution',
    (${upstream})->'data'->'order'->'execution'
  )`;
}

function limitlessStoredMarketSlugSqlExpression(
  payloadExpression = "order_payload",
): string {
  return `coalesce(
    nullif(${payloadExpression}->>'marketSlug', ''),
    nullif(${payloadExpression}->'submitted'->>'marketSlug', ''),
    nullif(${payloadExpression}->'payload'->>'marketSlug', ''),
    nullif(${payloadExpression}->'submitted'->'payload'->>'marketSlug', ''),
    ''
  )`;
}

export function positionDeltaAppliedSqlExpression(
  payloadExpression = "order_payload",
): string {
  return `coalesce(
    ${payloadExpression} ? '${POSITION_DELTA_APPLIED_MARKER}',
    (${payloadExpression}->'submitted') ? '${POSITION_DELTA_APPLIED_MARKER}',
    (${payloadExpression}->'payload') ? '${POSITION_DELTA_APPLIED_MARKER}',
    (${payloadExpression}->'submitted'->'payload') ? '${POSITION_DELTA_APPLIED_MARKER}',
    false
  )`;
}

function positionDeltaAppliedAtSqlExpression(
  payloadExpression = "order_payload",
): string {
  return `coalesce(
    ${payloadExpression}->'${POSITION_DELTA_APPLIED_MARKER}',
    ${payloadExpression}->'submitted'->'${POSITION_DELTA_APPLIED_MARKER}',
    ${payloadExpression}->'payload'->'${POSITION_DELTA_APPLIED_MARKER}',
    ${payloadExpression}->'submitted'->'payload'->'${POSITION_DELTA_APPLIED_MARKER}'
  )`;
}

function isFrozenCollateralFokSql(orderRow: string): string {
  return `(${orderRow}.venue='limitless' and ${orderRow}.order_type is not distinct from 'FOK'
    and ${limitlessFrozenCollateralSql(`${orderRow}.order_payload`)})`;
}

function sameLimitlessHistoryScopeSql(
  primary: string,
  history: string,
): string {
  return `${history}.venue='limitless' and ${history}.venue_order_id like 'history:%'
    and ${history}.user_id=${primary}.user_id
    and lower(${history}.wallet_address)=lower(${primary}.wallet_address)
    and ${history}.token_id=${primary}.token_id and ${history}.side=${primary}.side`;
}

function exactLimitlessHistoryIdentitySql(
  primary: string,
  history: string,
): string {
  const providerId = limitlessHistoryProviderIdSql(`${history}.order_payload`);
  const historyClientId = limitlessHistoryClientIdSql(
    `${history}.order_payload`,
  );
  const primaryClientId = limitlessHistoryClientIdSql(
    `${primary}.order_payload`,
  );
  return `coalesce((${primary}.venue_order_id=${providerId}
    and (${historyClientId} is null or ${primaryClientId} is null or ${primaryClientId}=${historyClientId}))
    or (${primaryClientId}=${historyClientId} and ${providerId} is null),false)`;
}

function unboundLimitlessHistorySql(history: string): string {
  return `nullif(${limitlessHistoryProviderIdSql(`${history}.order_payload`)},'') is null
    and nullif(${limitlessHistoryClientIdSql(`${history}.order_payload`)},'') is null`;
}

/** Call under the same advisory lock as the position write. Both order
 * representations are marked so retries and later alias deletion stay safe. */
export async function inheritLimitlessPositionDeltaFromOrderAlias(
  client: Pick<PoolClient, "query">,
  orderId: string,
  historyVenueOrderId?: string,
): Promise<"inherited" | "unbound" | "none"> {
  const targetIsPrimary = isFrozenCollateralFokSql("target_scope");
  const aliasIsPrimary = isFrozenCollateralFokSql("alias_order");
  const targetMatches = exactLimitlessHistoryIdentitySql(
    "target_scope",
    "alias_order",
  );
  const aliasMatches = exactLimitlessHistoryIdentitySql(
    "alias_order",
    "target_scope",
  );
  const result = await client.query<{
    resolution: "inherited" | "unbound" | "none";
  }>(
    `with target_scope as materialized (
      select * from orders where id=$1 and venue='limitless'
    ), matching_marker as materialized (
      select ${positionDeltaAppliedAtSqlExpression("alias_order.order_payload")} as applied_at,
             case when ${targetIsPrimary} then ${targetMatches} else ${aliasMatches} end as exact_match
      from target_scope
      join orders alias_order on alias_order.user_id=target_scope.user_id
        and alias_order.venue='limitless'
        and lower(alias_order.wallet_address)=lower(target_scope.wallet_address)
        and alias_order.token_id=target_scope.token_id and alias_order.side=target_scope.side
      where alias_order.id<>target_scope.id
        and (${positionDeltaAppliedSqlExpression("alias_order.order_payload")})
        and (
          (${targetIsPrimary}
            and ($2::text is null or alias_order.venue_order_id=$2)
            and ${sameLimitlessHistoryScopeSql("target_scope", "alias_order")}
            and (${targetMatches} or ($2::text is null
                 and alias_order.order_hash=target_scope.order_hash
                 and ${unboundLimitlessHistorySql("alias_order")})))
          or ($2::text is null and ${aliasIsPrimary}
            and ${sameLimitlessHistoryScopeSql("alias_order", "target_scope")}
            and (${aliasMatches} or (alias_order.order_hash=target_scope.order_hash
                 and ${unboundLimitlessHistorySql("target_scope")})))
        )
      order by exact_match desc
      limit 1
    ), inherited_marker as (
    update orders target_order
    set order_payload = case when jsonb_typeof(target_order.order_payload)='object'
      then target_order.order_payload else jsonb_build_object('payload',target_order.order_payload) end
      || jsonb_build_object('${POSITION_DELTA_APPLIED_MARKER}',matching_marker.applied_at)
    from matching_marker
    where target_order.id=$1 and matching_marker.exact_match
      and not (${positionDeltaAppliedSqlExpression("target_order.order_payload")})
    returning target_order.id
    )
    select case when exists(select 1 from inherited_marker) then 'inherited'
           when exists(select 1 from matching_marker where not exact_match) then 'unbound'
           else 'none' end as resolution`,
    [orderId, historyVenueOrderId ?? null],
  );
  return result.rows[0]?.resolution ?? "none";
}

function positionDeltaPreservingPayloadUpdateSql(param: string): string {
  return `order_payload = case
          when ${positionDeltaAppliedSqlExpression()} then
            case
              when jsonb_typeof(${param}::jsonb) = 'object' then
                ${param}::jsonb || jsonb_build_object(
                  '${POSITION_DELTA_APPLIED_MARKER}',
                  ${positionDeltaAppliedAtSqlExpression()}
                )
              else
                jsonb_build_object(
                  'payload',
                  ${param}::jsonb,
                  '${POSITION_DELTA_APPLIED_MARKER}',
                  ${positionDeltaAppliedAtSqlExpression()}
                )
            end
          else ${param}::jsonb
        end`;
}

function extractPayloadAddress(
  payload: unknown,
  key: "maker" | "signer",
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const candidates =
    key === "maker"
      ? [record.maker, record.maker_address]
      : [record.signer, record.signer_address];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!isEvmAddress(trimmed)) continue;
    return trimmed;
  }
  return null;
}

function collectPayloadClientOrderIds(payload: unknown, depth = 0): string[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    depth > 4
  ) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const result: string[] = [];
  if (
    typeof record.clientOrderId === "string" &&
    record.clientOrderId.trim().length >= 8
  ) {
    result.push(record.clientOrderId.trim());
  }
  for (const key of [
    "submitted",
    "payload",
    "_hunchSubmitted",
    "_hunchUpstream",
    "execution",
    "order",
    "data",
    "reconcileKeys",
  ]) {
    result.push(...collectPayloadClientOrderIds(record[key], depth + 1));
  }
  return result;
}

export function hasPositionDeltaApplied(payload: unknown, depth = 0): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  if (depth > 2) return false;
  const record = payload as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(record, "_hunchPositionDeltaAppliedAt")
  ) {
    return true;
  }
  return ["submitted", "payload"].some((key) =>
    hasPositionDeltaApplied(record[key], depth + 1),
  );
}

export async function findOrderVenueForUser(
  pool: Pool,
  inputs: { orderId: string; userId: string; walletAddress: string },
): Promise<string | null> {
  const walletAddress = normalizeWalletForStorage(inputs.walletAddress);
  const { rows } = await pool.query<{ venue: string }>(
    `SELECT venue
     FROM orders
     WHERE id = $1
       AND user_id = $2
       AND (
         wallet_address IS NULL
         OR wallet_address = $3
         OR signer_address = $3
         OR lower(coalesce(wallet_address, '')) = lower($3)
         OR lower(coalesce(signer_address, '')) = lower($3)
       )`,
    [inputs.orderId, inputs.userId, walletAddress],
  );

  return rows.length ? rows[0].venue : null;
}

export async function fetchOrderHistoryRows(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue?: string;
    status?: string;
    limit: number;
    offset: number;
  },
): Promise<OrderHistoryRow[]> {
  let whereClause = "WHERE user_id = $1";
  const params: PgParams = [inputs.userId];
  let paramCount = 1;
  const walletAddress = normalizeWalletForStorage(inputs.walletAddress);

  paramCount++;
  whereClause += ` AND (
    wallet_address IS NULL
    OR wallet_address = $${paramCount}
    OR signer_address = $${paramCount}
    OR lower(coalesce(wallet_address, '')) = lower($${paramCount})
    OR lower(coalesce(signer_address, '')) = lower($${paramCount})
  )`;
  params.push(walletAddress);

  if (inputs.venue) {
    paramCount++;
    whereClause += ` AND venue = $${paramCount}`;
    params.push(inputs.venue);
  }

  if (inputs.status) {
    paramCount++;
    whereClause += ` AND status = $${paramCount}`;
    params.push(inputs.status);
  }

  const limit = inputs.limit;
  const offset = inputs.offset;

  const { rows } = await pool.query<OrderHistoryRow>(
    `
      SELECT
        id, user_id, venue, venue_order_id, token_id, side, order_type,
        price, size, status, filled_size, average_fill_price,
        expires_at, created_at, updated_at, filled_at, cancelled_at,
        error_message, raw_error
      FROM orders
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `,
    [...params, limit, offset],
  );

  return rows;
}

export type StoreOrderResult =
  | {
      kind: "exists";
      order: {
        id: string;
        venue_order_id: string;
        status: string;
        posted_at: Date;
        position_delta_applied: boolean;
      };
    }
  | {
      kind: "stored";
      order: {
        id: string;
        venue_order_id: string;
        status: string;
        posted_at: Date;
        position_delta_applied: boolean;
      };
    };

export type StoreOrderInput = {
  userId: string;
  walletAddress: string;
  signerAddress?: string | null;
  venue: string;
  venueOrderId: string;
  tokenId: string | null;
  side: string | null;
  orderType?: "GTC" | "GTD" | "FAK" | "FOK" | null;
  price: number | null;
  size: number | null;
  status: string;
  errorMessage: string | null;
  rawError: string | null;
  orderHash?: string | null;
  feeBps?: number | null;
  feeAuth?: unknown | null;
  feeAuthSig?: string | null;
  feeCollectorAddress?: string | null;
  feeDeadline?: number | null;
  feePolicySnapshot?: unknown | null;
  orderPayload?: unknown | null;
  /** Only the server-prepared CLOB submission may supply this, never request/history JSON. */
  limitlessClobSubmissionContext?: LimitlessClobSubmissionContext;
  /** Previously observed server-side hashes, as receipt candidates only. */
  limitlessReceiptLocatorHashes?: readonly unknown[];
  orderPayloadVersion?: string | null;
  fundingReservation?: Readonly<{
    operationId: string;
    reservationId: string;
  }> | null;
  fundingTradeAttemptId?: string | null;
  fundingTradeReconciliationClaimToken?: string | null;
  /** Evidence repair links funding separately under its immutable claim fence. */
  fundingRecoveryMode?: "explicit_only";
  /**
   * A direct v2 Mini App trade has no FundingOperation. Its sealed Telegram
   * handoff is instead linked atomically when this ordinary order is stored.
   */
  telegramAppHandoffV2DirectTrade?: TelegramAppHandoffV2DirectTradeOrder | null;
  postedAt?: Date | null;
  lastUpdate?: Date | null;
  filledAt?: Date | null;
  cancelledAt?: Date | null;
};

export async function storeOrderInTransaction(
  client: PoolClient,
  inputs: StoreOrderInput,
): Promise<StoreOrderResult> {
  const incomingOrderPayload =
    inputs.venue === "limitless"
      ? withoutIncomingLimitlessClobContext(inputs.orderPayload)
      : inputs.orderPayload;
  if (inputs.limitlessClobSubmissionContext && inputs.venue !== "limitless")
    throw new Error(
      "Limitless CLOB submission context requires a Limitless order",
    );
  const limitlessSubmission = inputs.limitlessClobSubmissionContext
    ? validatedLimitlessClobContext(
        incomingOrderPayload,
        inputs.limitlessClobSubmissionContext,
      )
    : null;
  const receiptLocatorHashes = limitlessSubmission?.context.collateralFeeModule
    ? normalizeLimitlessReceiptLocatorHashes(
        inputs.limitlessReceiptLocatorHashes ?? [],
      ).slice(0, 8)
    : [];
  const mergeReceiptLocators = (payload: Record<string, unknown>) => {
    if (!receiptLocatorHashes.length) return payload;
    const stored = payload[LIMITLESS_RECEIPT_LOCATOR_HASHES_KEY];
    return {
      ...payload,
      [LIMITLESS_RECEIPT_LOCATOR_HASHES_KEY]:
        normalizeLimitlessReceiptLocatorHashes([
          ...(Array.isArray(stored) ? stored : []),
          ...receiptLocatorHashes,
        ]).slice(0, 8),
    };
  };
  const incomingPersistedPayload = limitlessSubmission
    ? mergeReceiptLocators({
        ...((limitlessSubmission.context.collateralFeeModule
          ? withoutLimitlessRecoverySignatures(incomingOrderPayload)
          : incomingOrderPayload) as Record<string, unknown>),
        [LIMITLESS_CLOB_CONTEXT_KEY]: limitlessSubmission.context,
        _hunchSubmitted: limitlessSubmission.signedOrder,
      })
    : incomingOrderPayload;
  const payloadMaker = extractPayloadAddress(inputs.orderPayload, "maker");
  const payloadSigner = extractPayloadAddress(inputs.orderPayload, "signer");
  const inputWalletAddress = normalizeWalletForStorage(inputs.walletAddress);
  const resolvedWalletAddress =
    payloadMaker &&
    normalizeWalletForStorage(payloadMaker) !== inputWalletAddress
      ? normalizeWalletForStorage(payloadMaker)
      : inputWalletAddress;
  const resolvedSignerAddress = normalizeOptionalWalletForStorage(
    inputs.signerAddress ?? payloadSigner,
  );
  let resolvedFundingReservation = inputs.fundingReservation ?? null;
  let resolvedFundingTradeAttemptId = inputs.fundingTradeAttemptId ?? null;
  let implicitlyRecoveredFunding = false;
  const directHandoffTrade = inputs.telegramAppHandoffV2DirectTrade ?? null;
  if (directHandoffTrade && resolvedFundingReservation) {
    throw new Error(
      "A direct Telegram handoff cannot also consume a funding reservation",
    );
  }
  if (
    directHandoffTrade &&
    inputs.side?.trim().toUpperCase() !==
      (directHandoffTrade.action ?? "buy").toUpperCase()
  ) {
    throw new Error(
      "A direct Telegram handoff order side does not match its sealed action",
    );
  }
  // Every writer for this exact venue order serializes before taking funding
  // locks. The order row itself is locked only after an implicit funding scope
  // has acquired intent -> operation -> reservation -> attempt.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `orders:${inputs.userId}:${inputs.venue}:${inputs.venueOrderId}`,
  ]);
  const existingOrderPreflight = await client.query<{ status: string }>(
    `select status
       from orders
      where venue = $1 and venue_order_id = $2 and user_id = $3
      order by
        (price is not null)::int desc,
        (size is not null)::int desc,
        (order_payload is not null)::int desc,
        posted_at desc nulls last,
        id desc
      limit 1`,
    [inputs.venue, inputs.venueOrderId, inputs.userId],
  );
  const preflightOutcome = persistedTradeTerminalOutcome(
    "web_order",
    existingOrderPreflight.rows[0]?.status ?? inputs.status,
  );
  if (
    !resolvedFundingReservation &&
    inputs.fundingRecoveryMode !== "explicit_only" &&
    !resolvedFundingTradeAttemptId &&
    !directHandoffTrade &&
    (preflightOutcome == null || preflightOutcome === "filled") &&
    inputs.side === "BUY" &&
    inputs.tokenId
  ) {
    const recovered = await recoverFundingTradeAttemptForOrderInTransaction(
      client,
      {
        userId: inputs.userId,
        venueId: inputs.venue,
        tokenId: inputs.tokenId,
        externalReferences: [
          inputs.orderHash ?? "",
          inputs.venueOrderId,
          ...collectPayloadClientOrderIds(inputs.orderPayload),
        ],
      },
    );
    if (recovered) {
      resolvedFundingReservation = {
        operationId: recovered.operationId,
        reservationId: recovered.reservationId,
      };
      resolvedFundingTradeAttemptId = recovered.attemptId;
      implicitlyRecoveredFunding = true;
    }
  }
  const existingOrder = await client.query<{
    id: string;
    token_id: string | null;
    wallet_address: string | null;
    signer_address: string | null;
    price: number | null;
    size: number | null;
    status: string;
    posted_at: Date | null;
    order_payload: unknown | null;
    order_payload_version: string | null;
    fee_policy_snapshot: unknown | null;
    funding_operation_id: string | null;
    funding_reservation_id: string | null;
    funding_trade_attempt_id: string | null;
  }>(
    `SELECT id, token_id, wallet_address, signer_address, price, size, status, posted_at, order_payload, order_payload_version, fee_policy_snapshot,
            funding_operation_id, funding_reservation_id, funding_trade_attempt_id
     FROM orders
     WHERE venue = $1 AND venue_order_id = $2 AND user_id = $3
     ORDER BY
       (price IS NOT NULL)::int DESC,
       (size IS NOT NULL)::int DESC,
       (order_payload IS NOT NULL)::int DESC,
       posted_at DESC NULLS LAST,
       id DESC
     LIMIT 1
     FOR UPDATE`,
    [inputs.venue, inputs.venueOrderId, inputs.userId],
  );

  const existing = existingOrder.rows[0] ?? null;
  const persistedOutcome = persistedTradeTerminalOutcome(
    "web_order",
    existing?.status ?? inputs.status,
  );
  // Lock and inspect the durable order before implicit lost-response recovery.
  // A stale open-status replay must never consume funding for an order that is
  // already terminal no-fill/failed in the database.
  const canRecoverFundingTradeAttempt =
    persistedOutcome == null || persistedOutcome === "filled";
  if (implicitlyRecoveredFunding && !canRecoverFundingTradeAttempt) {
    resolvedFundingReservation = null;
    resolvedFundingTradeAttemptId = null;
  }

  if (existing) {
    const updates: string[] = [];
    const params: PgParams = [];
    let paramCount = 0;
    const signerAddress = resolvedSignerAddress;
    const funding = resolvedFundingReservation;
    if (
      funding &&
      ((existing.funding_operation_id &&
        existing.funding_operation_id !== funding.operationId) ||
        (existing.funding_reservation_id &&
          existing.funding_reservation_id !== funding.reservationId))
    ) {
      throw new Error("Order is already linked to another funding reservation");
    }
    if (
      resolvedFundingTradeAttemptId &&
      existing.funding_trade_attempt_id &&
      existing.funding_trade_attempt_id !== resolvedFundingTradeAttemptId
    ) {
      throw new Error(
        "Order is already linked to another funding trade attempt",
      );
    }

    if (
      !existing.wallet_address ||
      (signerAddress && existing.wallet_address === signerAddress)
    ) {
      paramCount += 1;
      updates.push(`wallet_address = $${paramCount}`);
      params.push(resolvedWalletAddress);
    }
    if (signerAddress && !existing.signer_address) {
      paramCount += 1;
      updates.push(`signer_address = $${paramCount}`);
      params.push(signerAddress);
    }
    if (existing.price == null && inputs.price != null) {
      paramCount += 1;
      updates.push(`price = $${paramCount}`);
      params.push(inputs.price);
    }
    if (existing.size == null && inputs.size != null) {
      paramCount += 1;
      updates.push(`size = $${paramCount}`);
      params.push(inputs.size);
    }
    const incomingPayload =
      incomingPersistedPayload &&
      typeof incomingPersistedPayload === "object" &&
      !Array.isArray(incomingPersistedPayload)
        ? (incomingPersistedPayload as Record<string, unknown>)
        : null;
    const existingPayload =
      existing.order_payload &&
      typeof existing.order_payload === "object" &&
      !Array.isArray(existing.order_payload)
        ? (existing.order_payload as Record<string, unknown>)
        : null;
    const incomingContext =
      inputs.venue === "polymarket"
        ? parsePolymarketAssetContext(incomingPayload?.assetContext)
        : null;
    const existingContext =
      inputs.venue === "polymarket"
        ? parsePolymarketAssetContext(existingPayload?.assetContext)
        : null;
    const existingLimitlessContext = existingPayload
      ? limitlessClobFrozenContext(existingPayload)
      : undefined;
    if (limitlessSubmission && existingLimitlessContext !== undefined) {
      const stored = validatedLimitlessClobContext(
        existingPayload,
        existingLimitlessContext,
      );
      if (
        JSON.stringify(stored.context) !==
        JSON.stringify(limitlessSubmission.context)
      )
        throw new Error(
          "Limitless order conflicts with its stored CLOB submission context",
        );
    }
    if (
      incomingContext &&
      (normalizePolymarketAssetId(inputs.tokenId) !== incomingContext.assetId ||
        normalizePolymarketAssetId(existing.token_id) !==
          incomingContext.assetId ||
        (existingPayload?.assetContext != null && !existingContext) ||
        (existingContext &&
          JSON.stringify(existingContext) !== JSON.stringify(incomingContext)))
    )
      throw new Error(
        "Polymarket order ledger identity conflicts with its stored context",
      );
    if (
      limitlessSubmission &&
      existing.order_payload != null &&
      existingLimitlessContext === undefined
    ) {
      if (
        limitlessSubmission.context.collateralFeeModule &&
        inputs.orderType === "FOK"
      )
        updates.push("order_type = 'FOK'");
      const localClientOrderId = limitlessSubmission.signedOrder.clientOrderId;
      if (
        typeof localClientOrderId === "string" &&
        existingPayload?.clientOrderId != null &&
        existingPayload.clientOrderId !== localClientOrderId
      )
        throw new Error(
          "Limitless order conflicts with its stored client order ID",
        );
      // History sync may have inserted this order first. Keep every upstream
      // fact/marker and freeze the original local signed order under the same
      // row lock as its exchange/hash; history must never become its authority.
      paramCount += 1;
      updates.push(positionDeltaPreservingPayloadUpdateSql(`$${paramCount}`));
      params.push(
        JSON.stringify(
          mergeReceiptLocators({
            ...((limitlessSubmission.context.collateralFeeModule
              ? withoutLimitlessRecoverySignatures(
                  existingPayload ?? { payload: existing.order_payload },
                )
              : (existingPayload ?? {
                  payload: existing.order_payload,
                })) as Record<string, unknown>),
            ...(typeof localClientOrderId === "string"
              ? { clientOrderId: localClientOrderId }
              : {}),
            [LIMITLESS_CLOB_CONTEXT_KEY]: limitlessSubmission.context,
            _hunchSubmitted: limitlessSubmission.signedOrder,
          }),
        ),
      );
    } else if (existingPayload && receiptLocatorHashes.length) {
      const merged = mergeReceiptLocators(existingPayload);
      if (
        JSON.stringify(merged[LIMITLESS_RECEIPT_LOCATOR_HASHES_KEY]) !==
        JSON.stringify(existingPayload[LIMITLESS_RECEIPT_LOCATOR_HASHES_KEY])
      ) {
        paramCount += 1;
        updates.push(positionDeltaPreservingPayloadUpdateSql(`$${paramCount}`));
        params.push(JSON.stringify(merged));
      }
    } else if (existingPayload && incomingContext && !existingContext) {
      // Sync can win the race with signed-submit persistence. Enrich only the
      // missing immutable identity under this row lock; preserve original
      // upstream facts and optimistic-delta markers, never replace a ledger.
      paramCount += 1;
      updates.push(
        `order_payload = order_payload || jsonb_build_object('assetContext', $${paramCount}::jsonb)`,
      );
      params.push(JSON.stringify(incomingContext));
    } else if (!existing.order_payload && incomingPersistedPayload != null) {
      paramCount += 1;
      updates.push(positionDeltaPreservingPayloadUpdateSql(`$${paramCount}`));
      params.push(JSON.stringify(incomingPersistedPayload));
    }
    if (!existing.order_payload_version && inputs.orderPayloadVersion) {
      paramCount += 1;
      updates.push(`order_payload_version = $${paramCount}`);
      params.push(inputs.orderPayloadVersion);
    }
    if (!existing.fee_policy_snapshot && inputs.feePolicySnapshot != null) {
      paramCount += 1;
      updates.push(`fee_policy_snapshot = $${paramCount}`);
      params.push(JSON.stringify(inputs.feePolicySnapshot));
    }
    if (funding && !existing.funding_operation_id) {
      paramCount += 1;
      updates.push(`funding_operation_id = $${paramCount}`);
      params.push(funding.operationId);
      paramCount += 1;
      updates.push(`funding_reservation_id = $${paramCount}`);
      params.push(funding.reservationId);
    }
    if (updates.length) {
      paramCount += 1;
      params.push(existing.id);
      await client.query(
        `UPDATE orders SET ${updates.join(", ")} WHERE id = $${paramCount}`,
        params,
      );
    }
    if (funding) {
      await consumeFundingReservationForLinkedConsumerInTransaction(client, {
        userId: inputs.userId,
        reservationId: funding.reservationId,
        tradeAttemptId: resolvedFundingTradeAttemptId,
        tradeAttemptReconciliationClaimToken:
          inputs.fundingTradeReconciliationClaimToken,
        consumer: { kind: "web_order", orderId: existing.id },
        outcomeReason: "trade_order_recorded",
      });
    }
    if (directHandoffTrade) {
      await linkTelegramAppHandoffV2DirectTradeOrderInTransaction(client, {
        order: directHandoffTrade,
        orderId: existing.id,
        orderStatus: existing.status ?? inputs.status,
        userId: inputs.userId,
        venueOrderId: inputs.venueOrderId,
      });
    }
    return {
      kind: "exists",
      order: {
        id: existing.id,
        venue_order_id: inputs.venueOrderId,
        status: existing.status ?? inputs.status,
        posted_at: existing.posted_at ?? inputs.postedAt ?? new Date(),
        position_delta_applied: hasPositionDeltaApplied(existing.order_payload),
      },
    };
  }

  const orderType = inputs.orderType === undefined ? "GTC" : inputs.orderType;

  const result = await client.query<{
    id: string;
    venue_order_id: string;
    status: string;
    posted_at: Date;
  }>(
    `INSERT INTO orders (
        id, user_id, wallet_address, signer_address, venue, venue_order_id, token_id, side, order_type,
        price, size, status, filled_size, error_message, raw_error,
        order_payload, order_payload_version, order_hash, fee_bps, fee_auth, fee_auth_sig, fee_collector_address, fee_deadline, fee_policy_snapshot,
        funding_operation_id, funding_reservation_id,
        filled_at, cancelled_at, posted_at, last_update
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21,
        $22, $23, $24, $25, $26, COALESCE($27, now()), COALESCE($28, now())
      ) RETURNING id, venue_order_id, status, posted_at`,
    [
      inputs.userId,
      resolvedWalletAddress,
      resolvedSignerAddress,
      inputs.venue,
      inputs.venueOrderId,
      inputs.tokenId,
      inputs.side,
      orderType,
      inputs.price,
      inputs.size,
      inputs.status,
      inputs.errorMessage,
      inputs.rawError,
      incomingPersistedPayload ?? null,
      inputs.orderPayloadVersion ?? null,
      inputs.orderHash ?? null,
      inputs.feeBps ?? null,
      inputs.feeAuth ?? null,
      inputs.feeAuthSig ?? null,
      inputs.feeCollectorAddress ?? null,
      inputs.feeDeadline ?? null,
      inputs.feePolicySnapshot ?? null,
      resolvedFundingReservation?.operationId ?? null,
      resolvedFundingReservation?.reservationId ?? null,
      inputs.filledAt ?? null,
      inputs.cancelledAt ?? null,
      inputs.postedAt ?? null,
      inputs.lastUpdate ?? null,
    ],
  );
  const inserted = result.rows[0];
  if (!inserted) throw new Error("Failed to store order");
  if (resolvedFundingReservation) {
    await consumeFundingReservationForLinkedConsumerInTransaction(client, {
      userId: inputs.userId,
      reservationId: resolvedFundingReservation.reservationId,
      tradeAttemptId: resolvedFundingTradeAttemptId,
      tradeAttemptReconciliationClaimToken:
        inputs.fundingTradeReconciliationClaimToken,
      consumer: { kind: "web_order", orderId: inserted.id },
      outcomeReason: "trade_order_recorded",
    });
  }
  if (directHandoffTrade) {
    await linkTelegramAppHandoffV2DirectTradeOrderInTransaction(client, {
      order: directHandoffTrade,
      orderId: inserted.id,
      orderStatus: inserted.status,
      userId: inputs.userId,
      venueOrderId: inputs.venueOrderId,
    });
  }

  return {
    kind: "stored",
    order: {
      ...inserted,
      position_delta_applied: false,
    },
  };
}

export async function storeOrder(
  pool: Pool,
  inputs: StoreOrderInput,
): Promise<StoreOrderResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await storeOrderInTransaction(client, inputs);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readLimitlessDirectOrderJournal(
  db: Pick<Pool, "query">,
  userId: string,
  clientOrderId: string,
  walletAddress?: string,
): Promise<{ id: string; venue_order_id: string; status: string } | null> {
  const { rows } = await db.query<{
    id: string;
    venue_order_id: string;
    status: string;
  }>(
    `select id,venue_order_id,status from orders
      where venue='limitless' and user_id=$1
        and ${limitlessHistoryClientIdSql()}=$2
        and ($3::text is null or lower(wallet_address)=lower($3))
        and venue_order_id not like 'history:%'
        and funding_operation_id is null
        and ${limitlessFrozenCollateralSql()}
      order by (venue_order_id like 'client:%'), id limit 1`,
    [userId, clientOrderId, walletAddress ?? null],
  );
  return rows[0] ?? null;
}

/** Commit an unsigned observation journal before dispatch, once per exact
 * signed FOK. A caller racing this claim never reaches the provider POST. */
export async function readPendingLimitlessDirectScope(
  db: Pick<Pool, "query">,
  input: {
    userId: string;
    walletAddress: string;
    tokenId: string | null;
    side: string | null;
  },
): Promise<string | null> {
  const pending = await db.query<{ venue_order_id: string }>(
    `select venue_order_id from orders
      where user_id=$1 and venue='limitless' and lower(wallet_address)=lower($2)
        and token_id=$3 and side=$4 and status='submitted'
        and venue_order_id like 'client:hunch-direct-%' limit 1`,
    [input.userId, input.walletAddress, input.tokenId, input.side],
  );
  return pending.rows[0]?.venue_order_id.slice("client:".length) ?? null;
}

export async function claimLimitlessDirectOrderJournal(
  pool: Pool,
  clientOrderId: string,
  input: StoreOrderInput,
): Promise<
  StoreOrderResult | { kind: "prior_pending"; clientOrderId: string } | null
> {
  return tx(pool, async (db) => {
    const wallet = normalizeWalletForStorage(input.walletAddress);
    // Reloading a client can generate a different salt for the same retry.
    // Serialize only an unresolved submission for this wallet/token/side.
    if (!input.tokenId || (input.side !== "BUY" && input.side !== "SELL"))
      throw new Error("Limitless FOK journal requires an exact token and side");
    const scope = {
      userId: input.userId,
      walletAddress: wallet,
      tokenId: input.tokenId,
      side: input.side,
      clientOrderId,
    } as const;
    await lockLimitlessFokScope(db, scope);
    if (await readLimitlessDirectOrderJournal(db, input.userId, clientOrderId))
      return null;
    const pending = await readPendingLimitlessDirectScope(db, input);
    if (pending) return { kind: "prior_pending", clientOrderId: pending };
    if (await readOtherPendingLimitlessFok(db, scope)) return null;
    return storeOrderInTransaction(db, {
      ...input,
      status: "submitted",
      venueOrderId: `client:${clientOrderId}`,
      fundingRecoveryMode: "explicit_only",
    });
  });
}

export async function promoteLimitlessDirectOrderJournal(
  pool: Pool,
  input: {
    userId: string;
    journalId: string;
    clientOrderId: string;
    providerOrderId?: string | null;
    status: string;
    orderHash?: string | null;
    price?: number | null;
    size?: number | null;
    filledAt?: Date | null;
    negativeCheckedHashes?: readonly string[];
    rejectConcurrentOrderEvidence?: boolean;
    expectedDirectLocator?: unknown;
  },
): Promise<boolean> {
  return tx(pool, async (db) => {
    if (input.providerOrderId)
      await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `orders:${input.userId}:limitless:${input.providerOrderId}`,
      ]);
    const updated = await db.query(
      `update orders journal_order
       set venue_order_id=coalesce($4,venue_order_id),status=$5,
           order_hash=coalesce($6,order_hash),price=coalesce($7,price),size=coalesce($8,size),
           filled_at=coalesce($9,filled_at),last_update=now(),
           filled_size=case when $9::timestamptz is not null then coalesce($8,filled_size) else filled_size end,
           average_fill_price=case when $9::timestamptz is not null then coalesce($7,average_fill_price) else average_fill_price end
       where id=$1 and user_id=$2 and venue='limitless' and venue_order_id=concat('client:',$3::text)
         and status='submitted' and ${limitlessHistoryClientIdSql("journal_order.order_payload")}=$3
         and ${limitlessFrozenCollateralSql("journal_order.order_payload")}
         and ($12::jsonb is null or
              coalesce(journal_order.order_payload->'_hunchLimitlessDirectLocator','null'::jsonb)=$12)
         and ($4::text is null or coalesce(journal_order.order_payload #>> '{_hunchLimitlessDirectLocator,providerOrderId}',$4)=$4)
         and ($4::text is null or not exists(
           select 1 from orders existing_order where existing_order.venue='limitless'
            and existing_order.user_id=$2 and existing_order.venue_order_id=$4
         ))
         and ($4::text is not null or not exists(
           select 1 from orders history_order
           where ${sameLimitlessHistoryScopeSql("journal_order", "history_order")}
             and (${limitlessHistoryClientIdSql("history_order.order_payload")}=$3
               or ${limitlessHistoryProviderIdSql("history_order.order_payload")} =
                  journal_order.order_payload #>> '{_hunchLimitlessDirectLocator,providerOrderId}')
             and history_order.order_hash ~* '^0x[0-9a-f]{64}$'
         ))
         and ($4::text is not null or (
           not coalesce(order_payload #>> '{_hunchLimitlessDirectLocator,overflow}'='true',false)
           and (not $11::boolean or (
             order_payload #>> '{_hunchLimitlessDirectLocator,providerOrderId}' is null
             and not coalesce(order_payload #>> '{_hunchLimitlessDirectLocator,exactIdentityUnresolved}'='true',false)))
           and (order_payload #>> '{_hunchLimitlessDirectLocator,txHash}' is null
                or lower(order_payload #>> '{_hunchLimitlessDirectLocator,txHash}')=any($10::text[]))
           and not exists(select 1 from jsonb_array_elements_text(coalesce(
               order_payload #> '{_hunchLimitlessDirectLocator,txHashes}','[]'::jsonb)) exact_locator(tx_hash)
               where lower(exact_locator.tx_hash)<>all($10::text[]))
         ))`,
      [
        input.journalId,
        input.userId,
        input.clientOrderId,
        input.providerOrderId ?? null,
        input.status,
        input.orderHash ?? null,
        input.price ?? null,
        input.size ?? null,
        input.filledAt ?? null,
        input.negativeCheckedHashes ?? [],
        input.rejectConcurrentOrderEvidence ?? false,
        input.expectedDirectLocator === undefined
          ? null
          : JSON.stringify(input.expectedDirectLocator),
      ],
    );
    if (updated.rowCount === 1) return true;
    if (!input.providerOrderId) return false;
    // Open-order sync can store the provider UUID before the journal
    // resolves. Adopt that exact scoped row under its existing order lock.
    const adoption = await db.query<{
      id: string;
      wallet_address: string;
      signer_address: string | null;
      token_id: string;
      side: "BUY" | "SELL";
      retained_payload: unknown;
    }>(
      `select provider_order.id,journal_order.wallet_address,journal_order.signer_address,
          journal_order.token_id,journal_order.side,journal_order.order_payload as retained_payload
        from orders journal_order join orders provider_order on
          provider_order.user_id=journal_order.user_id and provider_order.venue='limitless'
          and provider_order.venue_order_id=$4
          and lower(provider_order.wallet_address)=lower(journal_order.wallet_address)
          and provider_order.token_id=journal_order.token_id and provider_order.side=journal_order.side
        where journal_order.id=$1 and journal_order.user_id=$2 and journal_order.venue='limitless'
          and journal_order.venue_order_id=concat('client:',$3::text)
          and journal_order.status='submitted' and journal_order.side in ('BUY','SELL')
          and ${limitlessHistoryClientIdSql("journal_order.order_payload")}=$3
          and coalesce(journal_order.order_payload #>> '{_hunchLimitlessDirectLocator,providerOrderId}',$4)=$4
          and ($5::jsonb is null or (
            coalesce(journal_order.order_payload->'_hunchLimitlessDirectLocator','null'::jsonb)=$5
            and (provider_order.order_hash is null or lower(provider_order.order_hash)=lower($6::text))
          ))
          and (${limitlessHistoryClientIdSql("provider_order.order_payload")} is null
            or ${limitlessHistoryClientIdSql("provider_order.order_payload")}=$3)
          and provider_order.funding_operation_id is null and provider_order.funding_reservation_id is null
        limit 2 for update of journal_order,provider_order`,
      [
        input.journalId,
        input.userId,
        input.clientOrderId,
        input.providerOrderId,
        input.expectedDirectLocator === undefined
          ? null
          : JSON.stringify(input.expectedDirectLocator),
        input.orderHash ?? null,
      ],
    );
    if (adoption.rows.length !== 1) return false;
    const target = adoption.rows[0];
    if (!isRecord(target.retained_payload)) return false;
    const retained = readRetainedLimitlessClobSubmission(
      {
        context: limitlessClobFrozenContext(target.retained_payload),
        order: limitlessClobSubmittedOrder(target.retained_payload),
      },
      {
        walletAddress: target.wallet_address,
        tokenId: target.token_id,
        side: target.side,
      },
    );
    if (!retained?.context.collateralFeeModule) return false;
    const removed = await db.query(
      `delete from orders draft_order where draft_order.id=$1 and draft_order.user_id=$2
        and draft_order.venue_order_id=concat('client:',$3::text)
        and draft_order.funding_operation_id is null and draft_order.funding_reservation_id is null
        and not exists(select 1 from order_fills fill_row where fill_row.order_id=draft_order.id)
        and not exists(select 1 from order_logs log_row where log_row.order_id=draft_order.id)
        and not exists(select 1 from user_theses thesis_row where thesis_row.order_id=draft_order.id)
        and not exists(select 1 from copy_attributions copy_row where copy_row.order_id=draft_order.id)
        and not exists(select 1 from venue_fee_accruals fee_row where fee_row.order_id=draft_order.id)
        and not exists(select 1 from venue_fee_backfill_attempts attempt_row where attempt_row.order_id=draft_order.id)
        and not exists(select 1 from limitless_contract_fee_receivables receipt_row where receipt_row.order_id=draft_order.id)
        and not exists(select 1 from telegram_trade_intents intent_row where intent_row.order_id=draft_order.id)`,
      [input.journalId, input.userId, input.clientOrderId],
    );
    if (!removed.rowCount) return false;
    const canonical = await storeOrderInTransaction(db, {
      userId: input.userId,
      walletAddress: target.wallet_address,
      signerAddress: target.signer_address,
      venue: "limitless",
      venueOrderId: input.providerOrderId,
      tokenId: target.token_id,
      side: target.side,
      orderType: "FOK",
      status: input.status,
      errorMessage: null,
      rawError: null,
      price: input.price ?? null,
      size: input.size ?? null,
      orderHash: input.orderHash ?? null,
      orderPayload: {
        ...target.retained_payload,
        order: retained.order,
        clientOrderId: input.clientOrderId,
      },
      limitlessClobSubmissionContext: retained.context,
      limitlessReceiptLocatorHashes: readLimitlessObservedLocator(
        target.retained_payload._hunchLimitlessDirectLocator,
      ).hashes,
      fundingRecoveryMode: "explicit_only",
    });
    if (canonical.order.id !== target.id)
      throw new Error("Limitless direct order adoption changed identity");
    await updateOrderFromHistory(db, {
      id: target.id,
      status: input.status,
      price: input.price ?? null,
      size: input.size ?? null,
      orderHash: input.orderHash ?? null,
      filledAt: input.filledAt ?? null,
      lastUpdate: new Date(),
    });
    return true;
  });
}

export async function noteLimitlessDirectOrderLocator(
  db: Pick<Pool, "query">,
  input: {
    userId: string;
    journalId: string;
    clientOrderId: string;
    providerOrderId: string | null;
    txHash?: string | null;
    history?: LimitlessHistoryObservation;
  },
): Promise<void> {
  await db.query(
    `update orders set order_payload=order_payload || jsonb_build_object(
       '_hunchLimitlessDirectLocator',${appendLimitlessObservedLocatorSql("order_payload -> '_hunchLimitlessDirectLocator'", "$4::text", "$5::text", "$6::jsonb")})
     where id=$1 and user_id=$2 and venue='limitless' and status='submitted'
       and venue_order_id=concat('client:',$3::text)
       and ($4::text is null or coalesce(order_payload #>> '{_hunchLimitlessDirectLocator,providerOrderId}',$4)=$4)`,
    [
      input.journalId,
      input.userId,
      input.clientOrderId,
      input.providerOrderId,
      input.txHash ?? null,
      input.history ? JSON.stringify(input.history) : null,
    ],
  );
}

/** Preserve exact fee-status locators as hints without writing settlement or
 * refreshing the order's business timestamps. Scope and merge under row lock. */
export async function retainLimitlessFeeReceiptLocators(
  db: Pick<Pool, "query">,
  input: {
    orderId: string;
    userId: string;
    venueOrderId: string;
    hashes: readonly string[];
  },
): Promise<void> {
  const hashes = normalizeLimitlessReceiptLocatorHashes(input.hashes);
  if (!hashes.length) return;
  const locatorKey = LIMITLESS_RECEIPT_LOCATOR_HASHES_KEY;
  const existing = `order_payload->'${locatorKey}'`;
  const merged = `(${appendLimitlessObservedLocatorSql(
    `jsonb_build_object('txHashes',${existing})`,
    "null::text",
    "null::text",
    "$4::jsonb",
  )} -> 'txHashes')`;
  await db.query(
    `update orders set order_payload=order_payload||jsonb_build_object('${locatorKey}',${merged})
     where id=$1 and user_id=$2 and venue_order_id=$3 and venue='limitless'
       and ${isFrozenCollateralFokSql("orders")}
       and ${existing} is distinct from ${merged}`,
    [
      input.orderId,
      input.userId,
      input.venueOrderId,
      JSON.stringify({ hashes }),
    ],
  );
}

export async function findLimitlessHistoryMatch(
  pool: Pool,
  inputs: {
    clientOrderId?: string | null;
    orderHash?: string | null;
    userId: string;
    venueOrderId?: string | null;
    walletAddress: string;
    tokenId: string;
    side: string;
    orderType: string | null;
    postedAt: Date;
    windowMs?: number;
  },
): Promise<{
  id: string;
  venueOrderId: string | null;
  status: string | null;
  postedAt: Date | null;
  positionDeltaApplied: boolean;
} | null> {
  const walletAddress = normalizeWalletForStorage(inputs.walletAddress);
  if (inputs.venueOrderId || inputs.orderHash || inputs.clientOrderId) {
    const exact = await pool.query<{
      id: string;
      venue_order_id: string | null;
      status: string | null;
      posted_at: Date | null;
      position_delta_applied: boolean;
    }>(
      `
        select
          id,
          venue_order_id,
          status,
          posted_at,
          ${positionDeltaAppliedSqlExpression()} as position_delta_applied
        from orders
        where user_id = $1
          and venue = 'limitless'
          and token_id = $2
          and side = $3
          and (wallet_address is null or wallet_address = $4 or signer_address = $4)
          and ($5::text is null or order_type is null or order_type = $5)
          and (venue_order_id is null or (venue_order_id not like 'history:%' and venue_order_id not like 'client:hunch-direct-%'))
          and (
            ($6::text is not null and venue_order_id = $6)
            or ($7::text is not null and order_hash = $7 and not (${isFrozenCollateralFokSql("orders")}))
            or (
              $8::text is not null
              and order_payload is not null
              and jsonb_typeof(order_payload) = 'object'
              and (
                order_payload->>'clientOrderId' = $8
                or order_payload->'submitted'->>'clientOrderId' = $8
                or order_payload->'payload'->>'clientOrderId' = $8
                or order_payload->'submitted'->'payload'->>'clientOrderId' = $8
                or order_payload->'_hunchSubmitted'->>'clientOrderId' = $8
                or order_payload->'_hunchUpstream'->'execution'->>'clientOrderId' = $8
                or order_payload->'_hunchUpstream'->'order'->'execution'->>'clientOrderId' = $8
                or order_payload->'reconcileKeys'->>'clientOrderId' = $8
                or order_payload->'submitted'->'reconcileKeys'->>'clientOrderId' = $8
                or order_payload->'payload'->'reconcileKeys'->>'clientOrderId' = $8
                or order_payload->'submitted'->'payload'->'reconcileKeys'->>'clientOrderId' = $8
              )
            )
          )
        order by posted_at desc nulls last
        limit 2
      `,
      [
        inputs.userId,
        inputs.tokenId,
        inputs.side,
        walletAddress,
        inputs.orderType,
        inputs.venueOrderId ?? null,
        inputs.orderHash ?? null,
        inputs.clientOrderId ?? null,
      ],
    );

    if (exact.rows.length === 1) {
      return {
        id: exact.rows[0].id,
        venueOrderId: exact.rows[0].venue_order_id ?? null,
        status: exact.rows[0].status ?? null,
        postedAt: exact.rows[0].posted_at ?? null,
        positionDeltaApplied: exact.rows[0].position_delta_applied,
      };
    }
  }

  const windowMs = inputs.windowMs ?? 2 * 60 * 1000;
  const from = new Date(inputs.postedAt.getTime() - windowMs);
  const to = new Date(inputs.postedAt.getTime() + windowMs);

  const { rows } = await pool.query<{
    id: string;
    venue_order_id: string | null;
    status: string | null;
    posted_at: Date | null;
    position_delta_applied: boolean;
  }>(
    `
      select
        id,
        venue_order_id,
        status,
        posted_at,
        ${positionDeltaAppliedSqlExpression()} as position_delta_applied
      from orders
      where user_id = $1
        and venue = 'limitless'
        and token_id = $2
        and side = $3
        and (wallet_address is null or wallet_address = $4 or signer_address = $4)
        and ($5::text is null or order_type is null or order_type = $5)
        and status = any($8::text[])
        and (venue_order_id is null or (venue_order_id not like 'history:%' and venue_order_id not like 'client:hunch-direct-%'))
        and not (${isFrozenCollateralFokSql("orders")})
        and posted_at between $6 and $7
      order by posted_at desc nulls last
      limit 2
    `,
    [
      inputs.userId,
      inputs.tokenId,
      inputs.side,
      walletAddress,
      inputs.orderType,
      from,
      to,
      LIMITLESS_HISTORY_FALLBACK_STATUSES,
    ],
  );

  if (rows.length !== 1) return null;
  return {
    id: rows[0].id,
    venueOrderId: rows[0].venue_order_id ?? null,
    status: rows[0].status ?? null,
    postedAt: rows[0].posted_at ?? null,
    positionDeltaApplied: rows[0].position_delta_applied,
  };
}

export async function markOrderPositionDeltaApplied(
  pool: Pool,
  inputs: { id: string; appliedAt?: Date },
): Promise<boolean> {
  const appliedAt = (inputs.appliedAt ?? new Date()).toISOString();
  const result = await pool.query(
    `
      update orders
      set
        order_payload = case
          when order_payload is null then
            jsonb_build_object('_hunchPositionDeltaAppliedAt', $2::text)
          when jsonb_typeof(order_payload) = 'object' then
            (
              order_payload
              - '_hunchPositionDeltaApplyClaimId'
              - '_hunchPositionDeltaApplyClaimedAt'
            ) || jsonb_build_object('_hunchPositionDeltaAppliedAt', $2::text)
          else
            jsonb_build_object(
              'payload',
              order_payload,
              '_hunchPositionDeltaAppliedAt',
              $2::text
            )
        end
      where id = $1
        and not (${positionDeltaAppliedSqlExpression()})
      returning id
    `,
    [inputs.id, appliedAt],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function claimOrderPositionDeltaApplication(
  pool: Pool,
  inputs: {
    id: string;
    claimId: string;
    claimedAt?: Date;
    staleAfterMs?: number;
  },
): Promise<boolean> {
  const claimedDate = inputs.claimedAt ?? new Date();
  const claimedAt = claimedDate.toISOString();
  const staleAfterMs = Math.max(1, inputs.staleAfterMs ?? 10 * 60 * 1000);
  const staleClaimCutoff = new Date(
    claimedDate.getTime() - staleAfterMs,
  ).toISOString();
  const result = await pool.query(
    `
      update orders
      set
        order_payload = case
          when order_payload is null then
            jsonb_build_object(
              '_hunchPositionDeltaApplyClaimId', $2::text,
              '_hunchPositionDeltaApplyClaimedAt', $3::text
            )
          when jsonb_typeof(order_payload) = 'object' then
            order_payload || jsonb_build_object(
              '_hunchPositionDeltaApplyClaimId', $2::text,
              '_hunchPositionDeltaApplyClaimedAt', $3::text
            )
          else
            jsonb_build_object(
              'payload',
              order_payload,
              '_hunchPositionDeltaApplyClaimId',
              $2::text,
              '_hunchPositionDeltaApplyClaimedAt',
              $3::text
            )
        end
      where id = $1
        and not (${positionDeltaAppliedSqlExpression()})
        and (
          not (
            order_payload is not null
            and jsonb_typeof(order_payload) = 'object'
            and order_payload ? '_hunchPositionDeltaApplyClaimId'
          )
          or (
            order_payload->>'_hunchPositionDeltaApplyClaimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
            and (order_payload->>'_hunchPositionDeltaApplyClaimedAt')::timestamptz <= $4::timestamptz
          )
        )
      returning id
    `,
    [inputs.id, inputs.claimId, claimedAt, staleClaimCutoff],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function clearOrderPositionDeltaApplicationClaim(
  pool: Pool,
  inputs: { id: string; claimId: string },
): Promise<boolean> {
  const result = await pool.query(
    `
      update orders
      set order_payload = order_payload
        - '_hunchPositionDeltaApplyClaimId'
        - '_hunchPositionDeltaApplyClaimedAt'
      where id = $1
        and order_payload is not null
        and jsonb_typeof(order_payload) = 'object'
        and order_payload->>'_hunchPositionDeltaApplyClaimId' = $2
        and not (${positionDeltaAppliedSqlExpression()})
      returning id
    `,
    [inputs.id, inputs.claimId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteHistoryOrder(
  pool: Pool,
  inputs: {
    userId: string;
    venue: string;
    venueOrderId: string;
    replacementOrderId?: string;
    latestLimitlessHistory?: {
      providerOrderId: string | null;
      clientOrderId: string | null;
      txHash: string | null;
    };
  },
): Promise<void> {
  await tx(pool, async (db) => {
    if (inputs.replacementOrderId) {
      if (inputs.venue === "limitless") {
        await acquirePositionMutationLock(db, {
          userId: inputs.userId,
          venue: "limitless",
        });
        const latest = inputs.latestLimitlessHistory;
        if (
          latest?.txHash &&
          (latest.providerOrderId || latest.clientOrderId)
        ) {
          // A first history delivery may omit IDs. Bind its exact local
          // alias to the newest scoped observation before transferring the
          // position marker; never discard the only copy of that marker.
          await db.query(
            `with primary_scope as materialized (select * from orders where id=$4 and user_id=$1)
              update orders history_order set order_payload=history_order.order_payload ||
                jsonb_strip_nulls(jsonb_build_object('orderId',$5::text,'clientOrderId',$6::text))
              from primary_scope primary_order
              where history_order.user_id=$1 and history_order.venue=$2 and history_order.venue_order_id=$3
                and ${isFrozenCollateralFokSql("primary_order")}
                and ${sameLimitlessHistoryScopeSql("primary_order", "history_order")}
                and lower(history_order.order_hash)=lower($7)
                and ${unboundLimitlessHistorySql("history_order")}
                and ($5::text is null or primary_order.venue_order_id=$5)
                and ($6::text is null or ${limitlessHistoryClientIdSql("primary_order.order_payload")}=$6)`,
            [
              inputs.userId,
              inputs.venue,
              inputs.venueOrderId,
              inputs.replacementOrderId,
              latest.providerOrderId,
              latest.clientOrderId,
              latest.txHash,
            ],
          );
        }
        await inheritLimitlessPositionDeltaFromOrderAlias(
          db,
          inputs.replacementOrderId,
          inputs.venueOrderId,
        );
      }
      for (const table of ["user_theses", "copy_attributions"] as const)
        await db.query(
          `update ${table} social_reference set order_id=target_order.id
      from orders source_order join orders target_order on target_order.id=$4 and target_order.user_id=source_order.user_id
        and source_order.verified_buy_facts->>'canonicalPurchaseKey'=target_order.verified_buy_facts->>'canonicalPurchaseKey'
        and source_order.verified_buy_state='verified' and target_order.verified_buy_state='verified'
      where source_order.user_id=$1 and source_order.venue=$2 and source_order.venue_order_id=$3
        and source_order.venue_order_id like 'history:%' and social_reference.order_id=source_order.id`,
          [
            inputs.userId,
            inputs.venue,
            inputs.venueOrderId,
            inputs.replacementOrderId,
          ],
        );
    }
    await db.query(
      `
      delete from orders
      where user_id = $1
        and venue = $2
        and venue_order_id = $3
        and venue_order_id like 'history:%'
        and not (
          ${positionDeltaAppliedSqlExpression("orders.order_payload")}
          and exists(select 1 from orders primary_order where primary_order.id=$4::uuid
            and primary_order.user_id=$1 and ${isFrozenCollateralFokSql("primary_order")}
            and not (${positionDeltaAppliedSqlExpression("primary_order.order_payload")}))
        )
        and not exists(select 1 from user_theses social_thesis where social_thesis.order_id=orders.id)
        and not exists(select 1 from copy_attributions attribution_row where attribution_row.order_id=orders.id)
    `,
      [
        inputs.userId,
        inputs.venue,
        inputs.venueOrderId,
        inputs.replacementOrderId ?? null,
      ],
    );
  });
}

export async function updateOrderFromHistory(
  pool: Pick<Pool, "query">,
  inputs: {
    id: string;
    status: string;
    price: number | null;
    size: number | null;
    filledAt: Date | null;
    lastUpdate: Date | null;
    orderHash: string | null;
    orderPayload?: unknown | null;
  },
): Promise<void> {
  const filledSize = inputs.size;
  const wakeFeeObservation = Boolean(
    inputs.orderHash && /^0x[0-9a-f]{64}$/i.test(inputs.orderHash),
  );
  const updatedPayload = `case
    when $9::jsonb is null then order_payload
    when order_payload is null then $9::jsonb
    when order_payload ? 'history' then order_payload
    else jsonb_build_object('submitted', order_payload, 'history', $9::jsonb)
         || case when ${positionDeltaAppliedSqlExpression()} then jsonb_build_object(
            '_hunchPositionDeltaAppliedAt', ${positionDeltaAppliedAtSqlExpression()})
            else '{}'::jsonb end
    end`;
  await pool.query(
    `
      ${
        wakeFeeObservation
          ? `with previous_fee_locator as materialized (
        select old_order.id, ${isFrozenCollateralFokSql("old_order")} and
          lower(coalesce(old_order.order_hash,'')) <> lower($8::text) and
          not coalesce(old_order.order_payload->'${LIMITLESS_HISTORY_TX_KEY}' ? lower($8::text),false) as is_new
          from orders old_order where old_order.id=$1 for update
      ), updated_order as (`
          : ""
      }
      update orders
      set
        status = $2,
        error_message = case
          when lower($2) in ('filled', 'matched')
            then null
          else error_message
        end,
        price = coalesce($3, price),
        size = coalesce($4, size),
        filled_size = coalesce($5, filled_size),
        average_fill_price = coalesce($3, average_fill_price),
        filled_at = coalesce($6, filled_at),
        last_update = coalesce($7, last_update),
        order_hash = case when ${isFrozenCollateralFokSql("orders")}
          then coalesce(order_hash, $8) else coalesce($8, order_hash) end,
        order_payload = case
          when ${isFrozenCollateralFokSql("orders")} and $8::text ~* '^0x[0-9a-f]{64}$' then
            (${updatedPayload}) || jsonb_build_object('${LIMITLESS_HISTORY_TX_KEY}', (
              select to_jsonb(array(
                select receipt_ref.tx_hash
                from (
                  select lower($8::text) as tx_hash, 0::bigint as rank_in_history
                  union all
                  select lower(prior_ref.tx_hash), prior_ref.rank_in_history
                  from jsonb_array_elements_text(case
                    when jsonb_typeof(order_payload->'${LIMITLESS_HISTORY_TX_KEY}')='array'
                    then order_payload->'${LIMITLESS_HISTORY_TX_KEY}'
                    else '[]'::jsonb end) with ordinality as prior_ref(tx_hash,rank_in_history)
                  where lower(prior_ref.tx_hash) <> lower($8::text)
                ) receipt_ref
                order by receipt_ref.rank_in_history
                limit 6
              ))
            ))
          else ${updatedPayload}
        end
      where id = $1
      ${
        wakeFeeObservation
          ? `and exists(select 1 from previous_fee_locator)
        returning id
      ) update venue_fee_backfill_attempts fee_attempt
          set status='retry', attempts=0, next_attempt_at=clock_timestamp()
        from previous_fee_locator, updated_order
        where fee_attempt.order_id=updated_order.id and previous_fee_locator.id=updated_order.id
          and previous_fee_locator.is_new and fee_attempt.venue='limitless'
          and fee_attempt.fee_program='${LIMITLESS_COLLATERAL_ATTEMPT_PROGRAM}'
          and fee_attempt.status in ('retry','failed')`
          : ""
      }
    `,
    [
      inputs.id,
      inputs.status,
      inputs.price,
      inputs.size,
      filledSize,
      inputs.filledAt,
      inputs.lastUpdate,
      inputs.orderHash,
      inputs.orderPayload == null
        ? null
        : JSON.stringify(
            withoutIncomingLimitlessClobContext(inputs.orderPayload),
          ),
    ],
  );
}

export async function expireStaleLimitlessFokOrders(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    marketSlug: string;
    activeVenueOrderIds: string[];
    olderThanMs?: number;
  },
): Promise<number> {
  const olderThanMs = inputs.olderThanMs ?? 2 * 60 * 1000;
  const cutoff = new Date(Date.now() - olderThanMs);
  const walletAddress = normalizeWalletForStorage(inputs.walletAddress);
  const storedExecution = limitlessStoredExecutionSqlExpression();
  const storedMarketSlug = limitlessStoredMarketSlugSqlExpression();
  const { rowCount } = await pool.query(
    `
      update orders
      set status = 'expired',
          last_update = now()
      where user_id = $1
        and venue = 'limitless'
        and order_type = 'FOK'
        and lower(coalesce(status, '')) in ('submitted', 'pending', 'open', 'live')
        -- Absence from open orders is not no-fill evidence for an accepted
        -- BUY. DELAYED orders can already have a matching canonical receipt.
        -- Their ordinary evidence observer owns recovery, never re-submission.
        and upper(coalesce(side,'')) <> 'BUY'
        and not (${isFrozenCollateralFokSql("orders")})
        and not (
          coalesce(${storedExecution}->>'matched', 'false') = 'true'
          and upper(coalesce(
            ${storedExecution}->>'settlementStatus',
            ''
          )) in ('MINED', 'CONFIRMED')
        )
        and (wallet_address is null or wallet_address = $2 or signer_address = $2)
        and ${storedMarketSlug} = $3
        and (venue_order_id is null or venue_order_id <> all($4::text[]))
        and (venue_order_id is null or (
          venue_order_id not like 'amm:%'
          and venue_order_id not like 'history:%'
        ))
        and posted_at < $5
    `,
    [
      inputs.userId,
      walletAddress,
      inputs.marketSlug,
      inputs.activeVenueOrderIds,
      cutoff,
    ],
  );

  return rowCount ?? 0;
}

export type LimitlessFokExecutionRepairCandidate = {
  id: string;
  orderHash: string | null;
  upstreamPayload: unknown;
};

export async function fetchLimitlessFokExecutionRepairCandidates(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    marketSlug: string;
    limit?: number;
  },
): Promise<LimitlessFokExecutionRepairCandidate[]> {
  const walletAddress = normalizeWalletForStorage(inputs.walletAddress);
  const limit = Math.max(1, Math.min(inputs.limit ?? 100, 100));
  const storedUpstream = limitlessStoredUpstreamPayloadSqlExpression();
  const storedExecution = limitlessStoredExecutionSqlExpression();
  const storedMarketSlug = limitlessStoredMarketSlugSqlExpression();
  const { rows } = await pool.query<{
    id: string;
    order_hash: string | null;
    upstream_payload: unknown;
  }>(
    `
      select
        id,
        order_hash,
        ${storedUpstream} as upstream_payload
      from orders
      where user_id = $1
        and venue = 'limitless'
        and order_type = 'FOK'
        and lower(coalesce(status, '')) in ('submitted', 'pending', 'open', 'live')
        and (wallet_address is null or wallet_address = $2 or signer_address = $2)
        and ${storedMarketSlug} = $3
        and coalesce(${storedExecution}->>'matched', 'false') = 'true'
        and upper(coalesce(${storedExecution}->>'settlementStatus', ''))
          in ('MINED', 'CONFIRMED')
      order by posted_at asc nulls first, id
      limit $4
    `,
    [inputs.userId, walletAddress, inputs.marketSlug, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    orderHash: row.order_hash,
    upstreamPayload: row.upstream_payload,
  }));
}

export async function markLimitlessFokFilledFromStoredExecution(
  pool: Pool,
  inputs: {
    id: string;
    price: number | null;
    size: number | null;
    filledAt: Date;
    orderHash: string | null;
  },
): Promise<boolean> {
  const storedExecution = limitlessStoredExecutionSqlExpression();
  const result = await pool.query(
    `
      update orders
      set status = 'filled',
          price = coalesce($2, price),
          size = coalesce($3, size),
          filled_size = coalesce($3, filled_size, size),
          average_fill_price = coalesce($2, average_fill_price, price),
          filled_at = coalesce(filled_at, $4),
          last_update = $4,
          order_hash = coalesce($5, order_hash)
      where id = $1
        and venue = 'limitless'
        and order_type = 'FOK'
        and lower(coalesce(status, '')) in ('submitted', 'pending', 'open', 'live')
        and coalesce(${storedExecution}->>'matched', 'false') = 'true'
        and upper(coalesce(${storedExecution}->>'settlementStatus', ''))
          in ('MINED', 'CONFIRMED')
      returning id
    `,
    [inputs.id, inputs.price, inputs.size, inputs.filledAt, inputs.orderHash],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function normalizeLimitlessFokOrderSizesForMarket(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    marketSlug: string;
  },
): Promise<number> {
  const walletAddress = normalizeWalletForStorage(inputs.walletAddress);
  const { rowCount } = await pool.query(
    `
      update orders
      set size = ((order_payload->'order'->>'makerAmount')::numeric / 1000000),
          last_update = now()
      where user_id = $1
        and venue = 'limitless'
        and order_type = 'FOK'
        and side = 'SELL'
        and size is not null
        and size >= 1000
        and (wallet_address is null or wallet_address = $2 or signer_address = $2)
        and coalesce(order_payload->>'marketSlug', '') = $3
        and (order_payload->'order'->>'makerAmount') ~ '^[0-9]+$'
    `,
    [inputs.userId, walletAddress, inputs.marketSlug],
  );

  return rowCount ?? 0;
}

export async function fetchOrdersForUser(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    status?: string;
    venue?: string;
    limit: number;
    offset: number;
  },
): Promise<{ rows: OrderRow[]; total: number }> {
  const client = await pool.connect();
  try {
    let whereClause = "WHERE user_id = $1";
    const params: PgParams = [inputs.userId];
    let paramCount = 1;
    const walletAddress = normalizeWalletForStorage(inputs.walletAddress);

    paramCount++;
    whereClause += ` AND (
      wallet_address IS NULL
      OR wallet_address = $${paramCount}
      OR signer_address = $${paramCount}
      OR lower(coalesce(wallet_address, '')) = lower($${paramCount})
      OR lower(coalesce(signer_address, '')) = lower($${paramCount})
    )`;
    params.push(walletAddress);

    if (inputs.status) {
      paramCount++;
      whereClause += ` AND status = $${paramCount}`;
      params.push(inputs.status);
    }

    if (inputs.venue) {
      paramCount++;
      whereClause += ` AND venue = $${paramCount}`;
      params.push(inputs.venue);
    }

    const limit = inputs.limit;
    const offset = inputs.offset;

    const ordersResult = await client.query<OrderRow>(
      `SELECT
          id, venue_order_id, venue, token_id, side, order_type,
          price, size, status, filled_size, average_fill_price,
          posted_at, last_update, filled_at, cancelled_at
        FROM orders
        ${whereClause}
        ORDER BY posted_at DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      [...params, limit, offset],
    );

    const countResult = await client.query<{ total: string }>(
      `SELECT COUNT(*) as total FROM orders ${whereClause}`,
      params,
    );

    return {
      rows: ordersResult.rows,
      total: parseInt(countResult.rows[0]?.total ?? "0"),
    };
  } finally {
    client.release();
  }
}

export async function fetchStoredOrderWalletContext(
  pool: Pool,
  inputs: {
    userId: string;
    venue: string;
    venueOrderId: string;
  },
): Promise<{
  walletAddress: string | null;
  signerAddress: string | null;
} | null> {
  const { rows } = await pool.query<{
    wallet_address: string | null;
    signer_address: string | null;
  }>(
    `
      select wallet_address, signer_address
      from orders
      where user_id = $1
        and venue = $2
        and venue_order_id = $3
      order by
        (signer_address is not null)::int desc,
        (wallet_address is not null)::int desc,
        posted_at desc nulls last,
        id desc
      limit 1
    `,
    [inputs.userId, inputs.venue, inputs.venueOrderId],
  );

  if (rows.length === 0) return null;
  return {
    walletAddress: rows[0].wallet_address,
    signerAddress: rows[0].signer_address,
  };
}
