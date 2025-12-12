export const log = {
  info: (...args: unknown[]) => console.log("[indexer-kalshi]", ...args),
  warn: (...args: unknown[]) => console.warn("[indexer-kalshi]", ...args),
  err: (...args: unknown[]) => console.error("[indexer-kalshi]", ...args),
};
