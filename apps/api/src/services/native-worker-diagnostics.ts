/** Only machine error codes enter worker diagnostics, never messages or SQL. */
export function nativeWorkerErrorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  if (typeof code !== "string") return "unknown";
  if (/^[0-9A-Z]{5}$/.test(code)) return code;
  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
  ].includes(code)
    ? code
    : "unknown";
}

export type NativeStatisticsDiagnostics = {
  claimed: number;
  updated: number;
  failed: number;
  retryScheduled: number;
  retryStoreFailed: number;
  leaseLost: number;
  pendingDrained: number;
  policyScanned: number;
  completed: boolean;
  durationMs: number;
  errors: { stage: string; code: string; count: number }[];
};
