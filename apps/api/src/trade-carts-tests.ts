#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DbQuery } from "./db.js";
import {
  addTradeCartItemIdempotent,
  createTradeCart,
  getTradeCartDetail,
  listTradeCarts,
  patchTradeCartItem,
  type JsonObject,
  type TradeCartOrderType,
  type TradeCartSide,
  type TradeCartSourceType,
  type TradeCartStatus,
  type TradeCartVenue,
  type TradeCartItemStatus,
} from "./repos/trade-carts-repo.js";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

type MockCartRow = {
  id: string;
  user_id: string;
  status: TradeCartStatus;
  name: string | null;
  source_type: TradeCartSourceType;
  source_id: string | null;
  metadata: JsonObject;
  created_at: Date;
  updated_at: Date;
};

type MockItemRow = {
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
  limit_price: string | null;
  amount_raw: string | null;
  allocation_weight: string | null;
  wallet_address: string | null;
  signer_address: string | null;
  funder_address: string | null;
  status: TradeCartItemStatus;
  intent_snapshot: JsonObject;
  created_at: Date;
  updated_at: Date;
};

type MockDb = DbQuery & {
  carts: MockCartRow[];
  items: MockItemRow[];
};

const tests: TestCase[] = [];

function test(name: string, run: TestCase["run"]) {
  tests.push({ name, run });
}

function createMockDb(): MockDb {
  const carts: MockCartRow[] = [];
  const items: MockItemRow[] = [];
  let cartSeq = 0;
  let itemSeq = 0;

  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> => {
    const normalizedSql = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalizedSql.startsWith("insert into trade_carts")) {
      cartSeq += 1;
      const now = new Date(`2026-06-16T00:00:${String(cartSeq).padStart(2, "0")}Z`);
      const row: MockCartRow = {
        id: `00000000-0000-4000-8000-${String(cartSeq).padStart(12, "0")}`,
        user_id: String(params?.[0]),
        status: "draft",
        name: (params?.[1] as string | null | undefined) ?? null,
        source_type:
          (params?.[2] as TradeCartSourceType | undefined) ?? "manual",
        source_id: (params?.[3] as string | null | undefined) ?? null,
        metadata:
          typeof params?.[4] === "string"
            ? (JSON.parse(params[4]) as JsonObject)
            : {},
        created_at: now,
        updated_at: now,
      };
      carts.push(row);
      return { rows: [row as unknown as T] };
    }

    if (normalizedSql.startsWith("select *, count(*) over() as total_count")) {
      const userId = String(params?.[0]);
      const hasStatusFilter = normalizedSql.includes("status = $2");
      const status = hasStatusFilter
        ? (params?.[1] as TradeCartStatus)
        : undefined;
      const filteredRows = carts
        .filter((cart) => cart.user_id === userId)
        .filter((cart) =>
          status ? cart.status === status : cart.status !== "abandoned",
        );
      const rows = filteredRows
        .map((cart) => ({
          ...cart,
          total_count: String(filteredRows.length),
        }));
      return { rows: rows as unknown as T[] };
    }

    if (
      normalizedSql.startsWith("select * from trade_carts") &&
      normalizedSql.includes("where id = $1 and user_id = $2")
    ) {
      const row = carts.find(
        (cart) => cart.id === params?.[0] && cart.user_id === params?.[1],
      );
      return { rows: row ? ([row] as unknown as T[]) : [] };
    }

    if (normalizedSql.startsWith("insert into trade_cart_items")) {
      const cartId = String(params?.[0]);
      const userId = String(params?.[1]);
      const clientItemId = String(params?.[2]);
      const cart = carts.find(
        (candidate) => candidate.id === cartId && candidate.user_id === userId,
      );
      if (!cart) return { rows: [] };
      const existing = items.find(
        (item) => item.cart_id === cartId && item.client_item_id === clientItemId,
      );
      if (existing) return { rows: [] };

      itemSeq += 1;
      const now = new Date(`2026-06-16T00:01:${String(itemSeq).padStart(2, "0")}Z`);
      const row: MockItemRow = {
        id: `10000000-0000-4000-8000-${String(itemSeq).padStart(12, "0")}`,
        cart_id: cartId,
        client_item_id: clientItemId,
        venue: params?.[3] as TradeCartVenue,
        market_id: (params?.[4] as string | null | undefined) ?? null,
        token_id: (params?.[5] as string | null | undefined) ?? null,
        market_slug: (params?.[6] as string | null | undefined) ?? null,
        outcome: (params?.[7] as string | null | undefined) ?? null,
        side: params?.[8] as TradeCartSide,
        order_type: (params?.[9] as TradeCartOrderType | null | undefined) ?? null,
        limit_price: params?.[10] == null ? null : String(params[10]),
        amount_raw: (params?.[11] as string | null | undefined) ?? null,
        allocation_weight: params?.[12] == null ? null : String(params[12]),
        wallet_address: (params?.[13] as string | null | undefined) ?? null,
        signer_address: (params?.[14] as string | null | undefined) ?? null,
        funder_address: (params?.[15] as string | null | undefined) ?? null,
        status: "draft",
        intent_snapshot:
          typeof params?.[16] === "string"
            ? (JSON.parse(params[16]) as JsonObject)
            : {},
        created_at: now,
        updated_at: now,
      };
      items.push(row);
      return { rows: [row as unknown as T] };
    }

    if (
      normalizedSql.startsWith("select i.* from trade_cart_items") &&
      normalizedSql.includes("i.client_item_id = $3")
    ) {
      const cartId = String(params?.[0]);
      const userId = String(params?.[1]);
      const clientItemId = String(params?.[2]);
      const cart = carts.find(
        (candidate) => candidate.id === cartId && candidate.user_id === userId,
      );
      if (!cart) return { rows: [] };
      const row = items.find(
        (item) => item.cart_id === cartId && item.client_item_id === clientItemId,
      );
      return { rows: row ? ([row] as unknown as T[]) : [] };
    }

    if (
      normalizedSql.startsWith("select i.* from trade_cart_items") &&
      normalizedSql.includes("$3::boolean")
    ) {
      const cartId = String(params?.[0]);
      const userId = String(params?.[1]);
      const includeRemoved = Boolean(params?.[2]);
      const cart = carts.find(
        (candidate) => candidate.id === cartId && candidate.user_id === userId,
      );
      if (!cart) return { rows: [] };
      return {
        rows: items
          .filter((item) => item.cart_id === cartId)
          .filter((item) => includeRemoved || item.status !== "removed")
          .sort((left, right) => left.created_at.getTime() - right.created_at.getTime()) as unknown as T[],
      };
    }

    if (normalizedSql.startsWith("update trade_cart_items i")) {
      const itemId = params?.[params.length - 3];
      const cartId = params?.[params.length - 2];
      const userId = params?.[params.length - 1];
      const cart = carts.find(
        (candidate) => candidate.id === cartId && candidate.user_id === userId,
      );
      const item = cart
        ? items.find(
            (candidate) =>
              candidate.id === itemId && candidate.cart_id === cartId,
          )
        : null;
      if (!item) return { rows: [] };
      if (normalizedSql.includes("status = $1")) {
        item.status = params?.[0] as TradeCartItemStatus;
      }
      if (normalizedSql.includes("amount_raw = $1")) {
        item.amount_raw = params?.[0] as string | null;
      }
      item.updated_at = new Date("2026-06-16T00:02:00Z");
      return { rows: [item as unknown as T] };
    }

    if (normalizedSql.startsWith("update trade_carts set updated_at")) {
      const cart = carts.find(
        (candidate) => candidate.id === params?.[0] && candidate.user_id === params?.[1],
      );
      if (cart) cart.updated_at = new Date("2026-06-16T00:03:00Z");
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in mock: ${sql}`);
  };

  return { query: query as unknown as DbQuery["query"], carts, items };
}

test("migration creates full cart core schema in one file", async () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const migrationPath = resolve(
    currentDir,
    "../../../packages/db/migrations/0160_trade_cart_core.sql",
  );
  const sql = await readFile(migrationPath, "utf8");

  for (const table of [
    "trade_carts",
    "trade_cart_items",
    "trade_cart_executions",
    "trade_cart_execution_items",
    "trade_cart_execution_attempts",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"));
  }

  for (const column of [
    "cart_id",
    "cart_item_id",
    "cart_execution_id",
    "cart_execution_item_id",
    "cart_execution_attempt_id",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i"));
  }

  const itemTableBlock = sql.match(
    /CREATE TABLE IF NOT EXISTS trade_cart_items \([\s\S]*?\n\);/i,
  )?.[0];
  assert.ok(itemTableBlock);
  assert.doesNotMatch(itemTableBlock, /needs_funding/i);
  assert.doesNotMatch(itemTableBlock, /ready/i);
});

test("add item is idempotent on cart id and client item id", async () => {
  const db = createMockDb();
  const cart = await createTradeCart(db, { userId: "user-1" });

  const first = await addTradeCartItemIdempotent(db, {
    userId: "user-1",
    cartId: cart.id,
    clientItemId: "client-item-1",
    venue: "polymarket",
    tokenId: "token-1",
    side: "BUY",
  });
  const second = await addTradeCartItemIdempotent(db, {
    userId: "user-1",
    cartId: cart.id,
    clientItemId: "client-item-1",
    venue: "polymarket",
    tokenId: "token-2",
    side: "BUY",
  });

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.id, second.id);
  assert.equal(second.tokenId, "token-1");
  assert.equal(db.items.length, 1);
});

test("cart detail is owner scoped and excludes removed items", async () => {
  const db = createMockDb();
  const cart = await createTradeCart(db, { userId: "user-1" });
  const otherCart = await createTradeCart(db, { userId: "user-2" });

  const item = await addTradeCartItemIdempotent(db, {
    userId: "user-1",
    cartId: cart.id,
    clientItemId: "client-item-1",
    venue: "limitless",
    side: "BUY",
  });
  assert.ok(item);

  const otherUserItem = await addTradeCartItemIdempotent(db, {
    userId: "user-1",
    cartId: otherCart.id,
    clientItemId: "client-item-2",
    venue: "limitless",
    side: "BUY",
  });
  assert.equal(otherUserItem, null);

  await patchTradeCartItem(db, {
    userId: "user-1",
    cartId: cart.id,
    itemId: item.id,
    patch: { status: "removed" },
  });

  const detail = await getTradeCartDetail(db, {
    userId: "user-1",
    cartId: cart.id,
  });
  assert.ok(detail);
  assert.equal(detail.items.length, 0);

  const forbiddenDetail = await getTradeCartDetail(db, {
    userId: "user-2",
    cartId: cart.id,
  });
  assert.equal(forbiddenDetail, null);
});

test("list carts is user scoped and excludes abandoned by default", async () => {
  const db = createMockDb();
  const active = await createTradeCart(db, { userId: "user-1" });
  const abandoned = await createTradeCart(db, { userId: "user-1" });
  await createTradeCart(db, { userId: "user-2" });

  const abandonedRow = db.carts.find((cart) => cart.id === abandoned.id);
  assert.ok(abandonedRow);
  abandonedRow.status = "abandoned";

  const result = await listTradeCarts(db, {
    userId: "user-1",
    limit: 50,
    offset: 0,
  });

  assert.deepEqual(
    result.carts.map((cart) => cart.id),
    [active.id],
  );
  assert.equal(result.total, 1);
});

for (const { name, run } of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
