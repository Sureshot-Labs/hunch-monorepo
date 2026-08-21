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
] as const;

export type TelegramAppHandoffV2TradeVenue =
  (typeof TELEGRAM_APP_HANDOFF_V2_TRADE_VENUES)[number];

export function isTelegramAppHandoffV2TradeVenue(
  venue: unknown,
): venue is TelegramAppHandoffV2TradeVenue {
  return (
    typeof venue === "string" &&
    (TELEGRAM_APP_HANDOFF_V2_TRADE_VENUES as readonly string[]).includes(venue)
  );
}

/**
 * Direct Buy is limited to venues whose ordinary web order endpoint makes a
 * durable single-flight claim before it calls the venue. This is deliberately
 * separate from server-bot execution: the Mini App signs its own order.
 *
 * A venue entry is not by itself a market-mode capability. The Telegram
 * selector also rejects any execution mode that has no matching consumer;
 * currently that excludes Limitless AMM from the direct CLOB contract.
 */
export const TELEGRAM_APP_HANDOFF_V2_DIRECT_TRADE_VENUES = [
  "polymarket",
  "limitless",
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
