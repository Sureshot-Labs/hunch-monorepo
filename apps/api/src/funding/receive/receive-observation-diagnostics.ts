type ReceiveFailureStage =
  | "variants"
  | "quarantine"
  | "batch_scan"
  | "evm_scan"
  | "solana_scan"
  | "session";

function classify(error: unknown) {
  let current = error;
  // Providers sometimes wrap the original transport error. Do not serialize
  // any layer: error messages can include URLs, addresses and RPC payloads.
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const { code, status, statusCode, name, cause } = current as Record<
      string,
      unknown
    >;
    if (status === 429 || statusCode === 429 || code === 429)
      return "rate_limit";
    if (status === 408 || statusCode === 408) return "timeout";
    if (code === "57014") return "sql_cancelled";
    if (code === "55P03") return "sql_lock";
    if (code === "40P01" || code === "40001") return "sql_concurrency";
    if (
      name === "TimeoutError" ||
      code === "ETIMEDOUT" ||
      code === "UND_ERR_CONNECT_TIMEOUT"
    )
      return "timeout";
    if (name === "AbortError") return "aborted";
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "EAI_AGAIN" ||
      code === "ENOTFOUND"
    )
      return "transport";
    if (typeof status === "number" && status >= 500 && status < 600)
      return "upstream_5xx";
    if (typeof statusCode === "number" && statusCode >= 500 && statusCode < 600)
      return "upstream_5xx";
    current = cause;
  }
  return "unknown";
}

export function addReceiveObservationFailure(
  counts: Record<string, number>,
  stage: ReceiveFailureStage,
  error: unknown,
  count = 1,
) {
  if (count <= 0) return;
  let kind: ReturnType<typeof classify> = "unknown";
  try {
    kind = classify(error);
  } catch {
    // Error-like provider objects may have throwing accessors. Telemetry must
    // not interrupt observation of other receive sessions.
  }
  const key = `${stage}.${kind}`;
  counts[key] = (counts[key] ?? 0) + count;
}
