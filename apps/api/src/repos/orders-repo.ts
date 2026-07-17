import type { Pool, PoolClient } from "@hunch/infra";
import {
  isEvmAddress,
  normalizeOptionalWalletForStorage,
  normalizeWalletForStorage,
} from "../lib/wallet-address.js";
import type { OrderHistoryRow, OrderRow, PgParams } from "../server-types.js";

const POSITION_DELTA_APPLIED_MARKER = "_hunchPositionDeltaAppliedAt";
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

async function storeOrderInTx(
  client: PoolClient,
  inputs: {
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
    orderPayloadVersion?: string | null;
    postedAt?: Date | null;
    lastUpdate?: Date | null;
    filledAt?: Date | null;
    cancelledAt?: Date | null;
  },
): Promise<StoreOrderResult> {
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
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `orders:${inputs.userId}:${inputs.venue}:${inputs.venueOrderId}`,
  ]);

  const existingOrder = await client.query<{
    id: string;
    wallet_address: string | null;
    signer_address: string | null;
    price: number | null;
    size: number | null;
    status: string;
    posted_at: Date | null;
    order_payload: unknown | null;
    order_payload_version: string | null;
    fee_policy_snapshot: unknown | null;
  }>(
    `SELECT id, wallet_address, signer_address, price, size, status, posted_at, order_payload, order_payload_version, fee_policy_snapshot
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

  if (existingOrder.rows.length > 0) {
    const existing = existingOrder.rows[0];
    const updates: string[] = [];
    const params: PgParams = [];
    let paramCount = 0;
    const signerAddress = resolvedSignerAddress;

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
    if (!existing.order_payload && inputs.orderPayload != null) {
      paramCount += 1;
      updates.push(positionDeltaPreservingPayloadUpdateSql(`$${paramCount}`));
      params.push(JSON.stringify(inputs.orderPayload));
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
    if (updates.length) {
      paramCount += 1;
      params.push(existing.id);
      await client.query(
        `UPDATE orders SET ${updates.join(", ")} WHERE id = $${paramCount}`,
        params,
      );
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
        filled_at, cancelled_at, posted_at, last_update
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21,
        $22, $23, $24, COALESCE($25, now()), COALESCE($26, now())
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
      inputs.orderPayload ?? null,
      inputs.orderPayloadVersion ?? null,
      inputs.orderHash ?? null,
      inputs.feeBps ?? null,
      inputs.feeAuth ?? null,
      inputs.feeAuthSig ?? null,
      inputs.feeCollectorAddress ?? null,
      inputs.feeDeadline ?? null,
      inputs.feePolicySnapshot ?? null,
      inputs.filledAt ?? null,
      inputs.cancelledAt ?? null,
      inputs.postedAt ?? null,
      inputs.lastUpdate ?? null,
    ],
  );

  return {
    kind: "stored",
    order: {
      ...result.rows[0],
      position_delta_applied: false,
    },
  };
}

export async function storeOrder(
  pool: Pool,
  inputs: {
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
    orderPayloadVersion?: string | null;
    postedAt?: Date | null;
    lastUpdate?: Date | null;
    filledAt?: Date | null;
    cancelledAt?: Date | null;
  },
): Promise<StoreOrderResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await storeOrderInTx(client, inputs);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
          and (venue_order_id is null or venue_order_id not like 'history:%')
          and (
            ($6::text is not null and venue_order_id = $6)
            or ($7::text is not null and order_hash = $7)
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
        and (venue_order_id is null or venue_order_id not like 'history:%')
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
  },
): Promise<void> {
  await pool.query(
    `
      delete from orders
      where user_id = $1
        and venue = $2
        and venue_order_id = $3
        and venue_order_id like 'history:%'
    `,
    [inputs.userId, inputs.venue, inputs.venueOrderId],
  );
}

export async function updateOrderFromHistory(
  pool: Pool,
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
  await pool.query(
    `
      update orders
      set
        status = $2,
        price = coalesce($3, price),
        size = coalesce($4, size),
        filled_size = coalesce($5, filled_size),
        average_fill_price = coalesce($3, average_fill_price),
        filled_at = coalesce($6, filled_at),
        last_update = coalesce($7, last_update),
        order_hash = coalesce($8, order_hash),
        order_payload = case
          when $9::jsonb is null then order_payload
          when order_payload is null then $9::jsonb
          when order_payload ? 'history' then order_payload
          else
            jsonb_build_object('submitted', order_payload, 'history', $9::jsonb)
            ||
            case
              when ${positionDeltaAppliedSqlExpression()} then jsonb_build_object(
                '_hunchPositionDeltaAppliedAt',
                ${positionDeltaAppliedAtSqlExpression()}
              )
              else '{}'::jsonb
            end
        end
      where id = $1
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
      inputs.orderPayload == null ? null : JSON.stringify(inputs.orderPayload),
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
  const { rowCount } = await pool.query(
    `
      update orders
      set status = 'expired',
          last_update = now()
      where user_id = $1
        and venue = 'limitless'
        and order_type = 'FOK'
        and lower(coalesce(status, '')) in ('submitted', 'pending', 'open', 'live')
        and not (
          coalesce(order_payload->'_hunchUpstream'->'execution'->>'matched', 'false') = 'true'
          and upper(coalesce(
            order_payload->'_hunchUpstream'->'execution'->>'settlementStatus',
            ''
          )) in ('MINED', 'CONFIRMED')
        )
        and (wallet_address is null or wallet_address = $2 or signer_address = $2)
        and coalesce(order_payload->>'marketSlug', '') = $3
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
