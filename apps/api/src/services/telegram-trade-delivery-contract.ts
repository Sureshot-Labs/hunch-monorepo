/**
 * Historical storage identifier for the revisioned Telegram trade card.
 * The payload now covers the whole trade lifecycle, not only funding.
 */
export const TELEGRAM_TRADE_LIFECYCLE_OUTBOX_ACTION = "trade_funding_edit";

/**
 * A terminal trade is delivered either by the revisioned lifecycle edit or by
 * the generic notification fallback. Persisting the fallback owner on the
 * intent prevents both delivery paths from presenting the same fill.
 */
export const TELEGRAM_TRADE_TERMINAL_DELIVERY_OWNER_RESULT_KEY =
  "telegramTerminalDeliveryOwner";
export const TELEGRAM_TRADE_GENERIC_NOTIFICATION_OWNER = "generic_notification";
