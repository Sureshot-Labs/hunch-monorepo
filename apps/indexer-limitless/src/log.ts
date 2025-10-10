export const log = {
  info: (...args: any[]) => console.log("[INFO]", ...args),
  warn: (...args: any[]) => console.warn("[WARN]", ...args),
  err: (...args: any[]) => console.error("[ERROR]", ...args),
};
