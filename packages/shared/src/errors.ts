export function isRpcRateLimit(error: unknown): boolean {
  if (!error) return false;
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("rate-limit") ||
    message.includes("quota exceeded")
  );
}

export function isRetryableHttpStatus(
  status: number | null | undefined,
): boolean {
  if (status == null || !Number.isFinite(status)) return false;
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.trunc(seconds * 1000);
  }

  const absoluteMs = Date.parse(trimmed);
  if (!Number.isFinite(absoluteMs)) return null;
  return Math.max(0, absoluteMs - nowMs);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error && typeof error === "object" && "name" in error) {
    return (error as { name?: string }).name === "AbortError";
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("AbortError") || message.includes("aborted")) {
    return true;
  }
  return false;
}
