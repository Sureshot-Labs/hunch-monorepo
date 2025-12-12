export const log = {
  info: (...a: unknown[]) => console.log("[indexer]", ...a),
  warn: (...a: unknown[]) => console.warn("[indexer]", ...a),
  err: (...a: unknown[]) => console.error("[indexer]", ...a),
};
