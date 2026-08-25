import type { SignalBotTestSignalOutcome } from "./signal-bot-contracts.js";

export const SIGNAL_BOT_QUOTE_MAX_AGE_MS = 10 * 60_000;

export function normalizeTestSignalOutcome(
  value: boolean | SignalBotTestSignalOutcome,
): SignalBotTestSignalOutcome {
  return typeof value === "boolean"
    ? { reason: value ? null : "no_eligible_note", sent: value }
    : value;
}

export function isSignalBotQuoteFresh(
  quoteTimestampMs: number,
  nowMs: number,
): boolean {
  return (
    Number.isFinite(quoteTimestampMs) &&
    Number.isFinite(nowMs) &&
    nowMs - quoteTimestampMs <= SIGNAL_BOT_QUOTE_MAX_AGE_MS
  );
}
