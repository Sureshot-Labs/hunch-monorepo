import { isRecord } from "../lib/type-guards.js";

export function isDefinitiveSubmitRejection(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.code === "trade_submission_failed" && Number(error.statusCode) === 400
  );
}
