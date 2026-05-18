export function isPgStatementTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "57014"
  );
}

export function isSearchStatementTimeout(
  error: unknown,
  q: string | undefined,
): boolean {
  return Boolean(q?.trim()) && isPgStatementTimeoutError(error);
}
