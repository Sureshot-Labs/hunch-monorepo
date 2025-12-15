function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getPgErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

export function formatPgError(error: unknown): string {
  const code = getPgErrorCode(error);
  const message =
    error instanceof Error ? error.message : error ? String(error) : "unknown";
  return code ? `${code}: ${message}` : message;
}

export function isPgUnavailableError(error: unknown): boolean {
  const code = getPgErrorCode(error);
  if (code) {
    if (code.startsWith("08")) return true; // connection exception
    if (["28000", "28P01", "3D000", "57P03", "53300"].includes(code))
      return true;
    if (
      ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"].includes(code)
    )
      return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    /connect ECONNREFUSED/i.test(message) ||
    /password authentication failed/i.test(message) ||
    /no pg_hba\.conf entry/i.test(message) ||
    /role ".+?" does not exist/i.test(message)
  );
}

export function isPgSchemaError(error: unknown): boolean {
  const code = getPgErrorCode(error);
  if (code && ["42P01", "42703", "42501"].includes(code)) return true;

  const message = error instanceof Error ? error.message : String(error);
  return (
    /relation ".+?" does not exist/i.test(message) ||
    /permission denied for relation/i.test(message) ||
    /column ".+?" does not exist/i.test(message)
  );
}

export function isPgSetupIssue(error: unknown): boolean {
  return isPgUnavailableError(error) || isPgSchemaError(error);
}
