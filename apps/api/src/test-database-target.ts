import { createPgPool, type Pool } from "@hunch/infra";

export type IntegrationDatabaseTarget = Readonly<{
  databaseUrl: string;
  expectedDatabase: string;
}>;

export function requireIntegrationDatabaseTarget(input: {
  databaseUrl?: string;
  expectedDatabase?: string;
}): IntegrationDatabaseTarget {
  const databaseUrl = input.databaseUrl?.trim();
  const expectedDatabase = input.expectedDatabase?.trim();
  if (!databaseUrl || !expectedDatabase) {
    throw new Error(
      "integration tests require an explicit database URL and expected database",
    );
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u.test(expectedDatabase)) {
    throw new Error("expected integration database name is invalid");
  }
  const parsedUrl = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
    throw new Error("integration test database must be PostgreSQL");
  }
  const urlDatabase = decodeURIComponent(
    parsedUrl.pathname.replace(/^\//u, ""),
  );
  if (urlDatabase !== expectedDatabase) {
    throw new Error(
      "integration test database URL does not match expected name",
    );
  }
  return { databaseUrl, expectedDatabase };
}

export function integrationDatabaseTargetFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): IntegrationDatabaseTarget {
  return requireIntegrationDatabaseTarget({
    databaseUrl: source.DATABASE_URL,
    expectedDatabase: source.HUNCH_TEST_EXPECT_DATABASE,
  });
}

export async function verifyIntegrationDatabaseTarget(
  db: Pick<Pool, "query">,
  target: IntegrationDatabaseTarget,
): Promise<void> {
  const { rows } = await db.query<{ current_database: string }>(
    "select current_database() as current_database",
  );
  if (rows[0]?.current_database !== target.expectedDatabase) {
    throw new Error("integration test database target mismatch");
  }
}

export async function createIntegrationTestPool(
  input: Readonly<{
    max: number;
    options?: string;
  }>,
): Promise<Pool> {
  const target = integrationDatabaseTargetFromEnv();
  const pool = createPgPool({
    connectionString: target.databaseUrl,
    max: input.max,
    ...(input.options ? { options: input.options } : {}),
  });
  try {
    await verifyIntegrationDatabaseTarget(pool, target);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
