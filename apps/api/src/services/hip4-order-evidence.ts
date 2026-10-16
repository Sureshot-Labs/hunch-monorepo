import { hip4RawUnits } from "@hunch/shared";
import { z } from "zod";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import {
  hip4AccountFillSchema,
  hip4HistoricalOrderObservationSchema,
} from "./hip4-account-contract.js";
import {
  hip4SignedAmount,
  projectHip4Execution,
} from "./hip4-account-projection.js";
import { hip4BasisFillFingerprint } from "./hip4-position-accounting.js";
import { hip4AccountAddressSchema } from "../schemas/hip4-account.js";
import {
  prepareHip4TradeSigning,
  type Hip4TradeSigningInput,
} from "./hip4-trade-signing.js";

// Official /info orderStatus (oid OR cloid), not an exchange ACK or open-order
// snapshot. Unknown status/identity remains repairable and never releases funds.
const statusResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknownOid") }).strict(),
  z.object({
    status: z.literal("order"),
    order: hip4HistoricalOrderObservationSchema,
  }),
]);
const acceptedStatuses = new Set([
  "open",
  "filled",
  "canceled",
  "scheduledCancel",
  "delistedCanceled",
  "selfTradeCanceled",
  "outcomeSettledCanceled",
  "internalCancel",
]);
const rejectedStatuses = new Set([
  "rejected",
  "tickRejected",
  "minTradeNtlRejected",
  "badAloPxRejected",
  "iocCancelRejected",
  "marketOrderNoLiquidityRejected",
  "insufficientSpotBalanceRejected",
  "tooManyOpenOrdersRejected",
]);

// orderStatus acceptance is independent of execution/fee coverage. In
// particular, iocCancelRejected is a placement rejection, not a cancellation
// of an accepted order. Never infer acceptance from terminal=true alone.
export function classifyHip4NativeOrderStatus(status: string) {
  return acceptedStatuses.has(status)
    ? "accepted"
    : rejectedStatuses.has(status)
      ? "rejected"
      : "unknown";
}

/** Local provider-read ordering, NOT a block/finality cursor. A fresh account
 * read must start strictly after this barrier. The ordinary official-API
 * capacity trust model still applies (replica lag cannot be proved away by
 * local timestamps). Legacy/malformed metadata provides no inclusion credit. */
export type Hip4OrderBalanceBarrier = {
  state: "accepted_observed" | "terminal_observed" | "invalidated";
  responseAt: number;
};
export function advanceHip4OrderBalanceBarrier(input: {
  previous: unknown;
  exactTerminal: boolean;
  exactOpen?: boolean;
  statusError: string | null;
  responseAt: number;
}): Hip4OrderBalanceBarrier | null {
  const parsed = z
    .object({
      state: z.enum(["accepted_observed", "terminal_observed", "invalidated"]),
      responseAt: z.number().int().nonnegative().safe(),
    })
    .safeParse(input.previous);
  const previous = parsed.success ? parsed.data : null;
  if (input.statusError === "order_not_observed") return previous;
  if (input.statusError !== null)
    return previous ? { ...previous, state: "invalidated" } : null;
  const state = input.exactTerminal
    ? "terminal_observed"
    : input.exactOpen
      ? "accepted_observed"
      : null;
  if (state === null) return null;
  return previous?.state === state
    ? previous
    : { state, responseAt: input.responseAt };
}
function frozenOrder(envelope: Hip4TradeSigningInput) {
  const prepared = prepareHip4TradeSigning(envelope);
  if (
    prepared.environment !== "mainnet" ||
    prepared.vaultAddress !== null ||
    prepared.action.type !== "order" ||
    prepared.action.orders.length !== 1
  )
    throw new Error("hip4_evidence_order_scope_invalid");
  const wire = prepared.action.orders[0];
  const coin = `#${wire.a - 100_000_000}`;
  return { wire, coin };
}

export function interpretHip4ExactOrderStatus(input: {
  envelope: Hip4TradeSigningInput;
  body: unknown;
  /** OID previously bound from the first ACK or an exact observation. */
  knownOrderId: string | null;
}) {
  const { wire, coin } = frozenOrder(input.envelope);
  const parsed = statusResponse.safeParse(input.body);
  const pending = (reason: string) => ({ kind: "pending" as const, reason });
  if (!parsed.success) return pending("invalid_order_status");
  if (parsed.data.status === "unknownOid") return pending("order_not_observed");
  const { order, status, statusTimestamp } = parsed.data.order;
  try {
    if (
      order.coin !== coin ||
      order.cloid?.toLowerCase() !== wire.c ||
      order.side !== (wire.b ? "B" : "A") ||
      order.reduceOnly !== false ||
      (order.isTrigger !== undefined && order.isTrigger !== false) ||
      (order.isPositionTpsl !== undefined && order.isPositionTpsl !== false) ||
      (input.knownOrderId !== null &&
        String(order.oid) !== input.knownOrderId) ||
      hip4RawUnits(order.limitPx, 5) !== hip4RawUnits(wire.p, 5) ||
      hip4RawUnits(order.origSz, 5) !== hip4RawUnits(wire.s, 5) ||
      hip4RawUnits(order.sz, 5) > hip4RawUnits(order.origSz, 5) ||
      (order.tif !== undefined && order.tif !== wire.t.limit.tif) ||
      statusTimestamp < order.timestamp ||
      order.timestamp < input.envelope.nonce ||
      (input.envelope.expiresAfter != null &&
        order.timestamp > input.envelope.expiresAfter)
    )
      return pending("order_identity_conflict");
  } catch {
    return pending("order_amount_invalid");
  }
  if (classifyHip4NativeOrderStatus(status) === "unknown")
    return pending("order_status_unknown");
  return {
    kind: "observed" as const,
    orderId: String(order.oid),
    coin,
    cloid: wire.c,
    status,
    terminal: status !== "open",
    observedStatusTime: statusTimestamp,
    orderTime: order.timestamp,
    remainingQuantityRaw: hip4RawUnits(order.sz, 5).toString(),
    originalQuantityRaw: hip4RawUnits(order.origSz, 5).toString(),
    // Remaining qty on a cancelled order is NOT a historical fill quantity.
    executionQuantityRaw: null,
  };
}

/** Caller must query fills for the exact environment/account, using the owned
 * stored order. A provider fill has no account field of its own. This pure
 * interpreter never claims complete time coverage or mutates a reservation.
 * It reuses P2 execution projection, including signed actual fees/rebates. */
export function interpretHip4ExactOrderFills(input: {
  envelope: Hip4TradeSigningInput;
  accountAddress: string;
  orderId: string;
  fills: unknown[];
}) {
  const { wire, coin } = frozenOrder(input.envelope);
  const accountAddress = hip4AccountAddressSchema.parse(input.accountAddress);
  const pending = (reason: string) => ({ kind: "pending" as const, reason });
  if (!/^(0|[1-9]\d*)$/u.test(input.orderId))
    return pending("order_id_invalid");
  const seen = new Map<string, string>();
  const executions: ReturnType<typeof projectHip4Execution>[] = [];
  let quantity = 0n;
  for (const candidate of input.fills) {
    const parsed = hip4AccountFillSchema.safeParse(candidate);
    if (!parsed.success) return pending("fill_invalid");
    const fill = parsed.data;
    if (
      fill.coin !== coin ||
      String(fill.oid) !== input.orderId ||
      fill.side !== (wire.b ? "B" : "A") ||
      fill.dir !== (wire.b ? "Buy" : "Sell") ||
      (fill.cloid != null && fill.cloid.toLowerCase() !== wire.c)
    )
      return pending("fill_identity_conflict");
    // Native tid/oid/time identity is shared with the P2 execution ledger.
    const key = `${fill.time}:${fill.coin}:${fill.tid}:${fill.oid}`;
    try {
      const price = hip4RawUnits(fill.px, 5),
        limit = hip4RawUnits(wire.p, 5);
      const size = hip4RawUnits(fill.sz, 5);
      if (
        size <= 0n ||
        price <= 0n ||
        price >= 100000n ||
        (wire.b ? price > limit : price < limit)
      )
        return pending("fill_amount_conflict");
      if (fill.time < input.envelope.nonce)
        return pending("fill_time_conflict");
      const execution = projectHip4Execution("mainnet", accountAddress, fill);
      const basis = hip4BasisFillFingerprint(fill);
      if (basis === null) return pending("fill_amount_invalid");
      const fingerprint = canonicalJsonHash({ execution, basis });
      const prior = seen.get(key);
      if (prior) {
        if (prior !== fingerprint) return pending("fill_identity_conflict");
        continue;
      }
      seen.set(key, fingerprint);
      quantity += size;
      executions.push(execution);
    } catch {
      return pending("fill_amount_invalid");
    }
  }
  const original = hip4RawUnits(wire.s, 5);
  if (quantity > original) return pending("fill_quantity_exceeded");
  // Derive the receipt from the exact, deduplicated P2 facts checked above.
  // Keep decimal arithmetic and rebates; unknown denominations are not USDC.
  const gross = executions.reduce(
    (sum, entry) => sum + hip4RawUnits(entry.grossNotional, 13),
    0n,
  );
  const feesKnown = executions.every(
    (entry) => entry.feeToken === "USDC" && entry.netQuoteCash !== null,
  );
  const fee = feesKnown
    ? executions.reduce(
        (sum, entry) =>
          sum +
          hip4RawUnits(entry.fee.replace(/^-/, ""), 8) *
            (entry.fee.startsWith("-") ? -1n : 1n),
        0n,
      )
    : null;
  return {
    kind: "observed" as const,
    executions,
    quantityRaw: quantity.toString(),
    fullQuantityObserved: quantity === original,
    // Even terminal orders need independently verified coverage before an empty
    // or partial fill list can release unspent collateral.
    historyCoverage: "not_asserted" as const,
    executionSummary: executions.length
      ? {
          version: 1 as const,
          source: "hyperliquid_user_fills" as const,
          quantity: hip4SignedAmount(quantity, 5),
          grossNotional: hip4SignedAmount(gross, 13),
          fee: fee === null ? null : hip4SignedAmount(fee, 8),
          feeToken: feesKnown ? ("USDC" as const) : null,
          netQuoteCash:
            fee === null
              ? null
              : hip4SignedAmount(
                  (wire.b ? -gross : gross) - fee * 100_000n,
                  13,
                ),
          executionCount: executions.length,
          fullQuantityObserved: quantity === original,
        }
      : null,
  };
}
