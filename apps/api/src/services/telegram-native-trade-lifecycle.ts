import { formatUnits } from "ethers";
import { z } from "zod";
import { nativeHip4OrderReadSchema } from "../schemas/orders.js";
import { parseTelegramAppHandoffNativePlan } from "./telegram-app-handoff-native-trade.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramFieldMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";

/** Display facts only, not another economic authorization. In particular the
 * snapshot has no wallet credentials and never infers fills from requested
 * quantity, a cancel ACK or the terminal status of the linked intent. */
export const telegramNativeLifecycleSchema = z.object({
  quantity: z
    .string()
    .max(128)
    .regex(/^[1-9]\d*$/u)
    .nullable(),
  debitCapRaw: z
    .string()
    .max(128)
    .regex(/^[1-9]\d*$/u)
    .nullable(),
  side: z.enum(["BUY", "SELL"]),
  submissionBoundaryCrossed: z.boolean(),
  order: z
    .object({
      status: z.string(),
      terminal: z.boolean(),
      nativeOrder: nativeHip4OrderReadSchema,
    })
    .nullable(),
});
export type TelegramNativeLifecycle = z.infer<
  typeof telegramNativeLifecycleSchema
>;

export function telegramNativeLifecycleSnapshot(input: {
  action: string;
  result: Record<string, unknown>;
  orderId: string | null;
  submitStartedAt: Date | null;
  order: TelegramNativeLifecycle["order"];
}): TelegramNativeLifecycle {
  const envelope = input.result.appHandoffV2;
  const plan = parseTelegramAppHandoffNativePlan(
    envelope && typeof envelope === "object" && "plan" in envelope
      ? envelope.plan
      : null,
  );
  return {
    quantity: plan?.nativeTrade.quantity ?? null,
    debitCapRaw: plan?.nativeTrade.consentedDebitCapRaw ?? null,
    side: plan?.nativeTrade.side ?? (input.action === "sell" ? "SELL" : "BUY"),
    submissionBoundaryCrossed:
      input.orderId != null || input.submitStartedAt != null,
    order: input.order
      ? {
          status: input.order.status,
          terminal: input.order.terminal,
          nativeOrder: input.order.nativeOrder,
        }
      : null,
  };
}

export function telegramNativeLifecycleOrderState(
  snapshot: TelegramNativeLifecycle,
): "failed" | "filled" | "cancelled" | "confirming_trade" | null {
  const order = snapshot.order;
  if (!order)
    return snapshot.submissionBoundaryCrossed ? "confirming_trade" : null;
  if (order.nativeOrder.submissionState === "rejected") return "failed";
  if (!order.terminal || !order.nativeOrder.terminalConfirmed)
    return "confirming_trade";
  if (order.status === "cancelled") return "cancelled";
  // The current canonical fill summary, not a possibly older monotonic flag,
  // proves a full fill. Terminal-with-missing-fills keeps its ordinary repair.
  return order.status === "filled" &&
    order.nativeOrder.fullQuantityObserved &&
    order.nativeOrder.executionSummary?.fullQuantityObserved
    ? "filled"
    : "confirming_trade";
}

export function telegramNativeLifecycleAmount(
  snapshot: TelegramNativeLifecycle,
) {
  return snapshot.debitCapRaw == null
    ? null
    : formatUnits(snapshot.debitCapRaw, snapshot.side === "BUY" ? 8 : 5);
}

/** Same Markdown field/card presentation as other venues, with native units
 * and truthful IOC language. A partial or unobserved cancelled remainder is
 * not the claim "no order was submitted". */
export function telegramNativeLifecycleText(input: {
  state: string;
  marketTitle: string;
  sideLabel: string;
  nativeTrade: TelegramNativeLifecycle;
}) {
  const facts = input.nativeTrade;
  const side = facts.side === "BUY" ? "Buy" : "Sell";
  const summary = facts.order?.nativeOrder.executionSummary;
  const filled = facts.order?.nativeOrder.filledQuantity;
  const heading =
    input.state === "quote_expired"
      ? "Quote expired"
      : input.state === "filled"
        ? "Trade filled"
        : input.state === "cancelled"
          ? facts.submissionBoundaryCrossed
            ? "Order closed"
            : `${side} cancelled`
          : input.state === "failed"
            ? facts.order?.nativeOrder.submissionState === "rejected"
              ? "Order declined"
              : "Review stopped"
            : input.state === "awaiting_client"
              ? `Continue ${side} in Hunch`
              : `Checking ${side}`;
  const body =
    input.state === "quote_expired"
      ? "Refresh the quote and review the current price. This Review expired before order submission."
      : input.state === "filled"
        ? "The full order quantity is confirmed by recorded executions."
        : input.state === "cancelled" && facts.submissionBoundaryCrossed
          ? "The unfilled remainder is closed. Recorded executions are shown below; complete fill history is not asserted."
          : input.state === "cancelled"
            ? "This Review was cancelled before order submission."
            : input.state === "failed"
              ? facts.order?.nativeOrder.submissionState === "rejected"
                ? "The order was not accepted. No replacement order is sent automatically."
                : "This Review stopped before order submission."
              : input.state === "awaiting_client"
                ? "Continue in Hunch to review the current quote and sign within your original limits."
                : "Hunch is checking the original order and its executions. Do not submit a replacement while the result is uncertain.";
  const amount = telegramNativeLifecycleAmount(facts);
  return joinTelegramMarkdownV2Lines(
    [
      formatTelegramBoldMarkdownV2(heading),
      "",
      formatTelegramFieldMarkdownV2("Venue", "Hyperliquid"),
      formatTelegramFieldMarkdownV2("Market", input.marketTitle),
      formatTelegramFieldMarkdownV2("Side", input.sideLabel),
      formatTelegramFieldMarkdownV2(
        "Requested contracts",
        facts.quantity ?? "Unavailable",
      ),
      formatTelegramFieldMarkdownV2(
        facts.side === "BUY" ? "Maximum order debit" : "Maximum contracts sold",
        amount == null
          ? "Unavailable"
          : facts.side === "BUY"
            ? `${amount} USDC`
            : amount,
      ),
      "",
      escapeTelegramMarkdownV2(body),
      facts.submissionBoundaryCrossed
        ? formatTelegramFieldMarkdownV2(
            "Recorded contracts filled",
            filled ?? "Not yet available",
          )
        : null,
      summary
        ? formatTelegramFieldMarkdownV2(
            "Recorded gross value",
            `${summary.grossNotional} USDC`,
          )
        : null,
      summary
        ? formatTelegramFieldMarkdownV2(
            "Recorded fee",
            summary.fee == null ? "Unavailable" : `${summary.fee} USDC`,
          )
        : null,
    ].filter((line): line is string => line != null),
  );
}
