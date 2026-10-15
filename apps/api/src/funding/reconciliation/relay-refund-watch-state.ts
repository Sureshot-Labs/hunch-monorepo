import { isRecord } from "../../lib/type-guards.js";

/** Scheduling only; never evidence of money or authority to resume a Buy. */
export function exactRefundWatchPending(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  const state = metadata.exactRefundCanonicalWatch;
  return (
    isRecord(state) &&
    state.version === 1 &&
    (state.pending === true ||
      (typeof state.afterId === "string" &&
        /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(
          state.afterId,
        )))
  );
}
