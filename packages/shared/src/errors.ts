export function isRpcRateLimit(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || message.includes("Too Many Requests");
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
