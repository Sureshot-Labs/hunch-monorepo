export const log = {
  info: (...a: any[]) => console.log("[indexer]", ...a),
  warn: (...a: any[]) => console.warn("[indexer]", ...a),
  err: (...a: any[]) => console.error("[indexer]", ...a),
};
