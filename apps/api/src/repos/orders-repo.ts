import type { Pool, PoolClient } from "@hunch/infra";
import type { OrderHistoryRow, OrderRow, PgParams } from "../server-types.js";

export async function findOrderVenueForUser(
  pool: Pool,
  inputs: { orderId: string; userId: string; walletAddress: string },
): Promise<string | null> {
  const { rows } = await pool.query<{ venue: string }>(
    "SELECT venue FROM orders WHERE id = $1 AND user_id = $2 AND (wallet_address IS NULL OR wallet_address = $3)",
    [inputs.orderId, inputs.userId, inputs.walletAddress],
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

  paramCount++;
  whereClause += ` AND (wallet_address IS NULL OR wallet_address = $${paramCount})`;
  params.push(inputs.walletAddress);

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
  | { kind: "exists" }
  | {
      kind: "stored";
      order: {
        id: string;
        venue_order_id: string;
        status: string;
        posted_at: Date;
      };
    };

async function storeOrderInTx(
  client: PoolClient,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: string;
    venueOrderId: string;
    tokenId: string | null;
    side: string | null;
    orderType?: "GTC" | "GTD" | "FAK" | "FOK";
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
  },
): Promise<StoreOrderResult> {
  const existingOrder = await client.query<{
    id: string;
    wallet_address: string | null;
  }>(
    `SELECT id, wallet_address
     FROM orders
     WHERE venue = $1 AND venue_order_id = $2 AND user_id = $3
       AND (wallet_address IS NULL OR wallet_address = $4)
     LIMIT 1`,
    [inputs.venue, inputs.venueOrderId, inputs.userId, inputs.walletAddress],
  );

  if (existingOrder.rows.length > 0) {
    const existing = existingOrder.rows[0];
    if (!existing.wallet_address) {
      await client.query(
        "UPDATE orders SET wallet_address = $1 WHERE id = $2",
        [inputs.walletAddress, existing.id],
      );
    }
    return { kind: "exists" };
  }

  const orderType = inputs.orderType ?? "GTC";

  const result = await client.query<{
    id: string;
    venue_order_id: string;
    status: string;
    posted_at: Date;
  }>(
    `INSERT INTO orders (
        id, user_id, wallet_address, venue, venue_order_id, token_id, side, order_type,
        price, size, status, filled_size, error_message, raw_error,
        order_hash, fee_bps, fee_auth, fee_auth_sig, fee_collector_address, fee_deadline,
        posted_at, last_update
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12,
        $13, $14, $15, $16, $17, $18,
        now(), now()
      ) RETURNING id, venue_order_id, status, posted_at`,
    [
      inputs.userId,
      inputs.walletAddress,
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
      inputs.orderHash ?? null,
      inputs.feeBps ?? null,
      inputs.feeAuth ?? null,
      inputs.feeAuthSig ?? null,
      inputs.feeCollectorAddress ?? null,
      inputs.feeDeadline ?? null,
    ],
  );

  return { kind: "stored", order: result.rows[0] };
}

export async function storeOrder(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: string;
    venueOrderId: string;
    tokenId: string | null;
    side: string | null;
    orderType?: "GTC" | "GTD" | "FAK" | "FOK";
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

    paramCount++;
    whereClause += ` AND (wallet_address IS NULL OR wallet_address = $${paramCount})`;
    params.push(inputs.walletAddress);

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
