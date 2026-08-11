export type MigrationTargetOptions = {
  databaseUrl: string | null;
  expectedDatabase: string | null;
};

function readOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } {
  const argument = args[index];
  const inlinePrefix = `${option}=`;
  if (argument?.startsWith(inlinePrefix)) {
    return { value: argument.slice(inlinePrefix.length), nextIndex: index };
  }
  const value = args[index + 1];
  if (argument !== option || value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function validateDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--database-url must be a valid PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("--database-url must use postgres: or postgresql:.");
  }
  if (parsed.pathname.length <= 1) {
    throw new Error("--database-url must name a database.");
  }
  return value;
}

function validateExpectedDatabase(value: string): string {
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (
    normalized.length === 0 ||
    normalized.length > 63 ||
    hasControlCharacter
  ) {
    throw new Error(
      "--expect-database must be a valid PostgreSQL database name.",
    );
  }
  return normalized;
}

export function parseMigrationTargetOptions(
  args: readonly string[],
): MigrationTargetOptions {
  let databaseUrl: string | null = null;
  let expectedDatabase: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    const option = argument?.split("=", 1)[0];
    if (option !== "--database-url" && option !== "--expect-database") {
      throw new Error(`Unknown migration argument: ${argument ?? ""}`);
    }
    const parsed = readOptionValue(args, index, option);
    index = parsed.nextIndex;
    if (option === "--database-url") {
      if (databaseUrl !== null) {
        throw new Error("--database-url may be provided only once.");
      }
      databaseUrl = validateDatabaseUrl(parsed.value);
      continue;
    }
    if (expectedDatabase !== null) {
      throw new Error("--expect-database may be provided only once.");
    }
    expectedDatabase = validateExpectedDatabase(parsed.value);
  }

  if (databaseUrl !== null && expectedDatabase === null) {
    throw new Error(
      "--database-url requires --expect-database so the target is verified before DDL.",
    );
  }

  return { databaseUrl, expectedDatabase };
}
