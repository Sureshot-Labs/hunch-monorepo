import type { DbQuery } from "../db.js";

export type TradeCartStatus =
  | "draft"
  | "executing"
  | "partially_executed"
  | "completed"
  | "abandoned";

export type TradeCartSourceType = "manual" | "proposal" | "session";
export type TradeCartItemStatus = "draft" | "skipped" | "removed";
export type TradeCartVenue = "polymarket" | "kalshi" | "limitless";
export type TradeCartSide = "BUY" | "SELL";
export type TradeCartOrderType = "GTC" | "GTD" | "FAK" | "FOK";
export type JsonObject = Record<string, unknown>;

export type TradeCart = {
  id: string;
  userId: string;
  status: TradeCartStatus;
  name: string | null;
  sourceType: TradeCartSourceType;
  sourceId: string | null;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
};

export type TradeCartItem = {
  id: string;
  cartId: string;
  clientItemId: string;
  venue: TradeCartVenue;
  marketId: string | null;
  tokenId: string | null;
  marketSlug: string | null;
  outcome: string | null;
  side: TradeCartSide;
  orderType: TradeCartOrderType | null;
  limitPrice: string | null;
  amountRaw: string | null;
  allocationWeight: string | null;
  walletAddress: string | null;
  signerAddress: string | null;
  funderAddress: string | null;
  status: TradeCartItemStatus;
  intentSnapshot: JsonObject;
  createdAt: Date;
  updatedAt: Date;
};

type TradeCartRow = {
  id: string;
  user_id: string;
  status: TradeCartStatus;
  name: string | null;
  source_type: TradeCartSourceType;
  source_id: string | null;
  metadata: JsonObject | null;
  created_at: Date;
  updated_at: Date;
};

type TradeCartItemRow = {
  id: string;
  cart_id: string;
  client_item_id: string;
  venue: TradeCartVenue;
  market_id: string | null;
  token_id: string | null;
  market_slug: string | null;
  outcome: string | null;
  side: TradeCartSide;
  order_type: TradeCartOrderType | null;
  limit_price: unknown;
  amount_raw: string | null;
  allocation_weight: unknown;
  wallet_address: string | null;
  signer_address: string | null;
  funder_address: string | null;
  status: TradeCartItemStatus;
  intent_snapshot: JsonObject | null;
  created_at: Date;
  updated_at: Date;
};

export function mapTradeCart(row: TradeCartRow): TradeCart {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    name: row.name,
    sourceType: row.source_type,
    sourceId: row.source_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapTradeCartItem(row: TradeCartItemRow): TradeCartItem {
  return {
    id: row.id,
    cartId: row.cart_id,
    clientItemId: row.client_item_id,
    venue: row.venue,
    marketId: row.market_id,
    tokenId: row.token_id,
    marketSlug: row.market_slug,
    outcome: row.outcome,
    side: row.side,
    orderType: row.order_type,
    limitPrice: row.limit_price == null ? null : String(row.limit_price),
    amountRaw: row.amount_raw,
    allocationWeight:
      row.allocation_weight == null ? null : String(row.allocation_weight),
    walletAddress: row.wallet_address,
    signerAddress: row.signer_address,
    funderAddress: row.funder_address,
    status: row.status,
    intentSnapshot: row.intent_snapshot ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createTradeCart(
  db: DbQuery,
  input: {
    userId: string;
    name?: string | null;
    sourceType?: TradeCartSourceType;
    sourceId?: string | null;
    metadata?: JsonObject;
  },
): Promise<TradeCart> {
  const result = await db.query<TradeCartRow>(
    `
    insert into trade_carts (user_id, name, source_type, source_id, metadata)
    values ($1, $2, $3, $4, $5::jsonb)
    returning *
    `,
    [
      input.userId,
      input.name ?? null,
      input.sourceType ?? "manual",
      input.sourceId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  return mapTradeCart(result.rows[0]);
}

export async function listTradeCarts(
  db: DbQuery,
  input: {
    userId: string;
    status?: TradeCartStatus;
    limit: number;
    offset: number;
  },
): Promise<{ carts: TradeCart[]; total: number }> {
  const where = ["user_id = $1"];
  const params: unknown[] = [input.userId];

  if (input.status) {
    params.push(input.status);
    where.push(`status = $${params.length}`);
  } else {
    where.push(`status <> 'abandoned'`);
  }

  params.push(input.limit);
  const limitParam = params.length;
  params.push(input.offset);
  const offsetParam = params.length;

  const result = await db.query<TradeCartRow & { total_count: string }>(
    `
    select *, count(*) over() as total_count
    from trade_carts
    where ${where.join(" and ")}
    order by updated_at desc, created_at desc
    limit $${limitParam} offset $${offsetParam}
    `,
    params,
  );

  const total =
    result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
  return {
    carts: result.rows.map(mapTradeCart),
    total,
  };
}

export async function getTradeCart(
  db: DbQuery,
  input: { userId: string; cartId: string },
): Promise<TradeCart | null> {
  const result = await db.query<TradeCartRow>(
    `
    select *
    from trade_carts
    where id = $1 and user_id = $2
    `,
    [input.cartId, input.userId],
  );

  return result.rows[0] ? mapTradeCart(result.rows[0]) : null;
}

export async function listTradeCartItems(
  db: DbQuery,
  input: { userId: string; cartId: string; includeRemoved?: boolean },
): Promise<TradeCartItem[]> {
  const result = await db.query<TradeCartItemRow>(
    `
    select i.*
    from trade_cart_items i
    join trade_carts c on c.id = i.cart_id
    where c.id = $1
      and c.user_id = $2
      and ($3::boolean or i.status <> 'removed')
    order by i.created_at asc, i.id asc
    `,
    [input.cartId, input.userId, Boolean(input.includeRemoved)],
  );

  return result.rows.map(mapTradeCartItem);
}

export async function getTradeCartDetail(
  db: DbQuery,
  input: { userId: string; cartId: string },
): Promise<{ cart: TradeCart; items: TradeCartItem[] } | null> {
  const cart = await getTradeCart(db, input);
  if (!cart) return null;

  const items = await listTradeCartItems(db, input);
  return { cart, items };
}

export async function addTradeCartItemIdempotent(
  db: DbQuery,
  input: {
    userId: string;
    cartId: string;
    clientItemId: string;
    venue: TradeCartVenue;
    marketId?: string | null;
    tokenId?: string | null;
    marketSlug?: string | null;
    outcome?: string | null;
    side: TradeCartSide;
    orderType?: TradeCartOrderType | null;
    limitPrice?: number | null;
    amountRaw?: string | null;
    allocationWeight?: number | null;
    walletAddress?: string | null;
    signerAddress?: string | null;
    funderAddress?: string | null;
    intentSnapshot?: JsonObject;
  },
): Promise<TradeCartItem | null> {
  const insertResult = await db.query<TradeCartItemRow>(
    `
    insert into trade_cart_items (
      cart_id,
      client_item_id,
      venue,
      market_id,
      token_id,
      market_slug,
      outcome,
      side,
      order_type,
      limit_price,
      amount_raw,
      allocation_weight,
      wallet_address,
      signer_address,
      funder_address,
      intent_snapshot
    )
    select
      c.id,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15,
      $16,
      $17::jsonb
    from trade_carts c
    where c.id = $1 and c.user_id = $2
    on conflict (cart_id, client_item_id) do nothing
    returning *
    `,
    [
      input.cartId,
      input.userId,
      input.clientItemId,
      input.venue,
      input.marketId ?? null,
      input.tokenId ?? null,
      input.marketSlug ?? null,
      input.outcome ?? null,
      input.side,
      input.orderType ?? null,
      input.limitPrice ?? null,
      input.amountRaw ?? null,
      input.allocationWeight ?? null,
      input.walletAddress ?? null,
      input.signerAddress ?? null,
      input.funderAddress ?? null,
      JSON.stringify(input.intentSnapshot ?? {}),
    ],
  );

  if (insertResult.rows[0]) {
    await db.query(
      `
      update trade_carts
      set updated_at = now()
      where id = $1 and user_id = $2
      `,
      [input.cartId, input.userId],
    );
    return mapTradeCartItem(insertResult.rows[0]);
  }

  const existingResult = await db.query<TradeCartItemRow>(
    `
    select i.*
    from trade_cart_items i
    join trade_carts c on c.id = i.cart_id
    where c.id = $1
      and c.user_id = $2
      and i.client_item_id = $3
    `,
    [input.cartId, input.userId, input.clientItemId],
  );

  return existingResult.rows[0] ? mapTradeCartItem(existingResult.rows[0]) : null;
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export async function patchTradeCartItem(
  db: DbQuery,
  input: {
    userId: string;
    cartId: string;
    itemId: string;
    patch: {
      marketId?: string | null;
      tokenId?: string | null;
      marketSlug?: string | null;
      outcome?: string | null;
      orderType?: TradeCartOrderType | null;
      limitPrice?: number | null;
      amountRaw?: string | null;
      allocationWeight?: number | string | null;
      walletAddress?: string | null;
      signerAddress?: string | null;
      funderAddress?: string | null;
      status?: TradeCartItemStatus;
      intentSnapshot?: JsonObject;
    };
  },
): Promise<TradeCartItem | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  const addSet = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  if (hasOwn(input.patch, "marketId")) addSet("market_id", input.patch.marketId);
  if (hasOwn(input.patch, "tokenId")) addSet("token_id", input.patch.tokenId);
  if (hasOwn(input.patch, "marketSlug")) {
    addSet("market_slug", input.patch.marketSlug);
  }
  if (hasOwn(input.patch, "outcome")) addSet("outcome", input.patch.outcome);
  if (hasOwn(input.patch, "orderType")) {
    addSet("order_type", input.patch.orderType);
  }
  if (hasOwn(input.patch, "limitPrice")) {
    addSet("limit_price", input.patch.limitPrice);
  }
  if (hasOwn(input.patch, "amountRaw")) {
    addSet("amount_raw", input.patch.amountRaw);
  }
  if (hasOwn(input.patch, "allocationWeight")) {
    addSet("allocation_weight", input.patch.allocationWeight);
  }
  if (hasOwn(input.patch, "walletAddress")) {
    addSet("wallet_address", input.patch.walletAddress);
  }
  if (hasOwn(input.patch, "signerAddress")) {
    addSet("signer_address", input.patch.signerAddress);
  }
  if (hasOwn(input.patch, "funderAddress")) {
    addSet("funder_address", input.patch.funderAddress);
  }
  if (hasOwn(input.patch, "status")) addSet("status", input.patch.status);
  if (hasOwn(input.patch, "intentSnapshot")) {
    addSet(
      "intent_snapshot",
      JSON.stringify(input.patch.intentSnapshot ?? {}),
      "::jsonb",
    );
  }

  if (sets.length === 0) return null;

  params.push(input.itemId);
  const itemIdParam = params.length;
  params.push(input.cartId);
  const cartIdParam = params.length;
  params.push(input.userId);
  const userIdParam = params.length;

  const result = await db.query<TradeCartItemRow>(
    `
    update trade_cart_items i
    set ${sets.join(", ")}
    where i.id = $${itemIdParam}
      and i.cart_id = $${cartIdParam}
      and exists (
        select 1
        from trade_carts c
        where c.id = i.cart_id
          and c.user_id = $${userIdParam}
      )
    returning i.*
    `,
    params,
  );

  if (!result.rows[0]) return null;

  await db.query(
    `
    update trade_carts
    set updated_at = now()
    where id = $1 and user_id = $2
    `,
    [input.cartId, input.userId],
  );

  return mapTradeCartItem(result.rows[0]);
}
