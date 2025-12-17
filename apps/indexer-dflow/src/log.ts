export const log = {
  info: (...args: unknown[]) => console.log("[indexer-dflow]", ...args),
  warn: (...args: unknown[]) => console.warn("[indexer-dflow]", ...args),
  err: (...args: unknown[]) => console.error("[indexer-dflow]", ...args),
};
