import { z } from "zod";
import type { SignalBotPolicy } from "./signal-bot-trading-policy.js";

/** Shared current policy contract for user-executed app handoffs, not an
 * unattended bot venue grant. Venue lifecycle is checked by ordinary trading. */
export function telegramAppHandoffPolicyAllows(input: {
  action: "buy" | "sell";
  executionContractVersion: 1 | 2;
  policy: SignalBotPolicy;
}): boolean {
  if (
    input.policy.miniAppHandoffMode === "off" ||
    input.policy.miniAppHandoffContractVersion < input.executionContractVersion
  )
    return false;
  return input.action === "buy"
    ? input.policy.buyContinuationEnabled && input.policy.fundingReceiveEnabled
    : input.policy.tradingEnabled &&
        input.policy.tradingActions.includes("sell");
}

export const telegramAppHandoffV2BindingSchema = z
  .object({
    handoffId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    planFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/iu)
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export function readTelegramAppHandoffV2Binding(input: {
  telegramAppHandoffId?: string;
  telegramAppHandoffPlanFingerprint?: string;
}) {
  if (
    input.telegramAppHandoffId === undefined &&
    input.telegramAppHandoffPlanFingerprint === undefined
  )
    return null;
  const parsed = telegramAppHandoffV2BindingSchema.safeParse({
    handoffId: input.telegramAppHandoffId,
    planFingerprint: input.telegramAppHandoffPlanFingerprint,
  });
  if (!parsed.success) throw new Error("hip4_handoff_binding_invalid");
  return parsed.data;
}

/**
 * Venue contract for the sealed Telegram → Mini App handoff.
 *
 * This is intentionally narrower than every venue Hunch knows about.  A venue
 * belongs here only after its ordinary web trade consumer can enforce a sealed
 * v2 handoff at its durable submission boundary.  Adding a string here does
 * not make a venue executable: its funding adapter and consumer still have to
 * implement that contract.
 */
export const TELEGRAM_APP_HANDOFF_V2_TRADE_VENUES = [
  "polymarket",
  "limitless",
  "hyperliquid",
] as const;

export type TelegramAppHandoffV2TradeVenue =
  (typeof TELEGRAM_APP_HANDOFF_V2_TRADE_VENUES)[number];

/** Durable consumer contract. Native admission is installed before exposing
 * its product entry; this does not expand unattended bot signing capability. */
export type TelegramAppHandoffV2ConsumerVenue =
  | TelegramAppHandoffV2TradeVenue
  | "hyperliquid";

/** Reader/consumer and product entries now use the same connected contract.
 * This is not an unattended Telegram signer capability. */
export function isTelegramAppHandoffV2ConsumerVenue(
  venue: unknown,
): venue is TelegramAppHandoffV2ConsumerVenue {
  return venue === "hyperliquid" || isTelegramAppHandoffV2TradeVenue(venue);
}

export function isTelegramAppHandoffV2TradeVenue(
  venue: unknown,
): venue is TelegramAppHandoffV2TradeVenue {
  return (
    typeof venue === "string" &&
    (TELEGRAM_APP_HANDOFF_V2_TRADE_VENUES as readonly string[]).includes(venue)
  );
}

/**
 * The policy gate is shared by market rendering and callback entrypoints.
 * Server-bot venue allowlists intentionally do not appear here: a v2 handoff
 * is signed by the user in the Mini App, not by the unattended bot signer.
 */
export function isTelegramAppHandoffV2EnabledForVenue(input: {
  contractVersion: number;
  mode: string;
  venue: unknown;
}): boolean {
  return (
    input.mode !== "off" &&
    input.contractVersion >= 2 &&
    isTelegramAppHandoffV2TradeVenue(input.venue)
  );
}

/**
 * Direct trade is limited to venues whose ordinary web order endpoint makes a
 * durable single-flight claim before it calls the venue. This is deliberately
 * separate from server-bot execution: the Mini App signs its own order.
 *
 * A venue entry is not by itself a market-mode capability. The Telegram
 * selector also rejects any execution mode that has no matching consumer.
 * Limitless has two such consumers: FOK CLOB and the exact signed AMM call.
 */
export const TELEGRAM_APP_HANDOFF_V2_DIRECT_TRADE_VENUES = [
  "polymarket",
  "limitless",
  "hyperliquid",
] as const;

export type TelegramAppHandoffV2DirectTradeVenue =
  (typeof TELEGRAM_APP_HANDOFF_V2_DIRECT_TRADE_VENUES)[number];

export function isTelegramAppHandoffV2DirectTradeVenue(
  venue: unknown,
): venue is TelegramAppHandoffV2DirectTradeVenue {
  return (
    typeof venue === "string" &&
    (TELEGRAM_APP_HANDOFF_V2_DIRECT_TRADE_VENUES as readonly string[]).includes(
      venue,
    )
  );
}
