export const log = {
  info: (...args: unknown[]) => console.log("[INFO]", ...args),
  warn: (...args: unknown[]) => console.warn("[WARN]", ...args),
  err: (...args: unknown[]) => console.error("[ERROR]", ...args),
};
