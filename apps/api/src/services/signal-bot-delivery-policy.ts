export const SIGNAL_BOT_QUOTE_MAX_AGE_MS = 10 * 60_000;

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
