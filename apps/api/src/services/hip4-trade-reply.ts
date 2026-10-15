import { hip4RawUnits } from "@hunch/shared";
import { z } from "zod";
import { compareUnsignedDecimals } from "../account-value/decimal.js";
import {
  canonicalHip4TradeAction,
  type Hip4TradeAction,
} from "./hip4-trade-signing.js";

const oid = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z
  .string()
  .max(128)
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/u);
const responseSchema = z.object({
  status: z.literal("ok"),
  response: z.object({
    type: z.enum(["order", "cancel"]),
    data: z.object({ statuses: z.array(z.unknown()).length(1) }),
  }),
});
const cloid = z
  .string()
  .regex(/^0x[0-9a-f]{32}$/u)
  .optional();
const fillSchema = z
  .object({
    filled: z.object({ oid, totalSz: decimal, avgPx: decimal, cloid }),
  })
  .strict();
const restSchema = z.object({ resting: z.object({ oid, cloid }) }).strict();
const errorSchema = z.object({ error: z.string() }).strict();

export type Hip4TradeReply =
  | {
      kind: "reconcile_required";
      reason: "unrecognized_reply" | "cancel_state_unknown";
    }
  | { kind: "resting"; orderId: string }
  // Summary only. Actual fills/fees and partial remainder come from exact
  // order/fill reconciliation; an ACK must not create a second execution.
  | {
      kind: "filled_summary";
      orderId: string;
      filledQuantity: string;
      averagePrice: string;
      fullSize: boolean;
    }
  | { kind: "cancel_acknowledged" }
  | { kind: "no_fill"; reason: "ioc_no_match" }
  | { kind: "rejected"; reason: "tick" | "minimum" | "balance" | "post_only" };

/** Interpret one admitted order/cancel, never an arbitrary HTTP error string.
 * Unknown nonce/cloid/transport errors require reconciliation of the SAME
 * admitted identity, not another purchase. Cancel ACK never erases fills. */
export function classifyHip4SingleTradeReply(
  actionInput: Hip4TradeAction,
  payload: unknown,
): Hip4TradeReply {
  const action = canonicalHip4TradeAction(actionInput);
  const unknown = (): Hip4TradeReply => ({
    kind: "reconcile_required",
    reason: "unrecognized_reply",
  });
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) return unknown();
  const response = parsed.data.response;
  const status = response.data.statuses[0];
  if (action.type !== "order") {
    if (action.cancels.length !== 1 || response.type !== "cancel")
      return unknown();
    return status === "success"
      ? { kind: "cancel_acknowledged" }
      : { kind: "reconcile_required", reason: "cancel_state_unknown" };
  }
  const order = action.orders[0];
  if (action.orders.length !== 1 || !order || response.type !== "order")
    return unknown();
  const rest = restSchema.safeParse(status);
  if (rest.success)
    return order.t.limit.tif === "Ioc" ||
      (rest.data.resting.cloid !== undefined &&
        rest.data.resting.cloid !== order.c)
      ? unknown()
      : { kind: "resting", orderId: String(rest.data.resting.oid) };
  const fill = fillSchema.safeParse(status);
  if (fill.success) {
    try {
      const { totalSz, avgPx, oid: orderId } = fill.data.filled;
      const quantity = hip4RawUnits(totalSz, 5),
        requested = hip4RawUnits(order.s, 5);
      const limitComparison = compareUnsignedDecimals(avgPx, order.p);
      if (
        quantity <= 0n ||
        quantity > requested ||
        compareUnsignedDecimals(avgPx, "0") <= 0 ||
        compareUnsignedDecimals(avgPx, "1") >= 0 ||
        (order.b ? limitComparison > 0 : limitComparison < 0) ||
        (fill.data.filled.cloid !== undefined &&
          fill.data.filled.cloid !== order.c)
      )
        return unknown();
      return {
        kind: "filled_summary",
        orderId: String(orderId),
        filledQuantity: totalSz,
        averagePrice: avgPx,
        fullSize: quantity === requested,
      };
    } catch {
      return unknown();
    }
  }
  const failure = errorSchema.safeParse(status);
  if (!failure.success) return unknown();
  const message = failure.data.error;
  if (
    message ===
      "Order could not immediately match against any resting orders." &&
    order.t.limit.tif === "Ioc"
  )
    return { kind: "no_fill", reason: "ioc_no_match" };
  if (message === "Price must be divisible by tick size.")
    return { kind: "rejected", reason: "tick" };
  // The number is provider-reported rejection text, NOT Hunch's minimum policy.
  if (
    /^Order must have minimum value of (?:\$\d+(?:\.\d+)?|\d+(?:\.\d+)? USDC)\.$/u.test(
      message,
    )
  )
    return { kind: "rejected", reason: "minimum" };
  if (message === "Order has insufficient spot balance to trade")
    return { kind: "rejected", reason: "balance" };
  if (
    /^Post only order would have immediately matched, bbo was /u.test(
      message,
    ) &&
    order.t.limit.tif === "Alo"
  )
    return { kind: "rejected", reason: "post_only" };
  return unknown();
}
