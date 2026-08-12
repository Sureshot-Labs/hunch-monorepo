import { resolveContentRuntimeConfig } from "@hunch/config/content";
import type { Pool } from "@hunch/infra";

import { configureContentServiceRuntime } from "./content-service-runtime.js";
import { createIntegrationTestPool } from "./test-database-target.js";

export async function createContentTestPool(max: number): Promise<Pool> {
  // Content shares the integration database. Keep one DATABASE_URL contract,
  // but never let a directly-invoked mutating fixture run without an exact
  // disposable-database fence.
  return createIntegrationTestPool({ max });
}

export function configureContentTestRuntime(
  source: NodeJS.ProcessEnv = process.env,
): void {
  configureContentServiceRuntime(
    resolveContentRuntimeConfig(
      {
        ...source,
        CONTENT_ENABLED: source.CONTENT_ENABLED ?? "true",
        CONTENT_WORKER_ENABLED: source.CONTENT_WORKER_ENABLED ?? "true",
      },
      "test",
    ),
  );
}
