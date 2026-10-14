import { z } from "zod";
import {
  hip4Identity,
  hip4RawUnits,
  parseHip4Coin,
  type Hip4Environment,
} from "@hunch/shared";
import { formatUnsignedDecimal } from "../account-value/decimal.js";

const amount = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const wireOrder = z.object({
  coin: z.string(),
  oid: timestamp,
  side: z.enum(["A", "B"]),
  limitPx: amount,
  sz: amount,
  origSz: amount,
  timestamp,
  orderType: z.string(),
  isTrigger: z.boolean(),
  reduceOnly: z.boolean(),
});
export const hip4OpenOrderSchema = z
  .object({
    orderId: z.string().regex(/^\d+$/),
    coin: z.string(),
    marketId: z.string(),
    tokenId: z.string(),
    sideIndex: z.number().int().min(0).max(1),
    side: z.enum(["A", "B"]),
    price: amount,
    originalQuantity: amount,
    remainingQuantity: amount,
    filledQuantity: amount,
    time: timestamp,
    orderType: z.string(),
    isTrigger: z.boolean(),
    reduceOnly: z.boolean(),
  })
  .strict();
export const hip4OpenOrdersSnapshotSchema = z
  .object({
    version: z.literal(1),
    source: z.literal("hyperliquid_frontend_open_orders"),
    observedAt: z.string().datetime(),
    // Protocol maximum, not a product threshold or a truncated local page.
    items: z.array(hip4OpenOrderSchema).max(5000),
  })
  .strict();

export function projectHip4OpenOrders(
  environment: Hip4Environment,
  value: unknown,
  now: number,
) {
  const rows = z
    .array(z.record(z.string(), z.unknown()))
    .max(5000)
    .parse(value);
  const seen = new Set<string>();
  const items = rows
    .filter((row) => typeof row.coin === "string" && row.coin.startsWith("#"))
    .map((value) => {
      const row = wireOrder.parse(value);
      const parsed = parseHip4Coin(row.coin);
      const identity = hip4Identity(environment, parsed.outcome);
      const original = hip4RawUnits(row.origSz, 5);
      const remaining = hip4RawUnits(row.sz, 5);
      if (
        seen.has(String(row.oid)) ||
        remaining > original ||
        row.timestamp > now ||
        hip4RawUnits(row.limitPx, 8) > 100_000_000n
      )
        throw new Error("invalid_open_order");
      seen.add(String(row.oid));
      return {
        orderId: String(row.oid),
        coin: row.coin,
        marketId: identity.marketId,
        tokenId: identity.sides[parsed.sideIndex].tokenId,
        sideIndex: parsed.sideIndex,
        side: row.side,
        price: row.limitPx,
        originalQuantity: row.origSz,
        remainingQuantity: row.sz,
        filledQuantity: formatUnsignedDecimal(original - remaining, 5),
        time: row.timestamp,
        orderType: row.orderType,
        isTrigger: row.isTrigger,
        reduceOnly: row.reduceOnly,
      };
    });
  return hip4OpenOrdersSnapshotSchema.parse({
    version: 1,
    source: "hyperliquid_frontend_open_orders",
    observedAt: new Date(now).toISOString(),
    items,
  });
}
