import type { Pool } from "@hunch/infra";

import { createContentPool } from "./content-db.js";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import { env } from "./env.js";

type ApiContentPools = {
  publicPool: Pool;
  adminPool: Pool;
};

let pools: ApiContentPools | null = null;

export function getApiContentPools(): ApiContentPools {
  if (!env.contentEnabled) {
    throw new Error("Content runtime is disabled");
  }
  configureContentServiceRuntime(env.content);
  pools ??= {
    publicPool: createContentPool({
      connectionString: env.contentDatabaseUrl,
      name: "public",
      max: env.contentDbPublicPoolMax,
      statementTimeoutMs: env.contentDbPublicStatementTimeoutMs,
      lockTimeoutMs: env.contentDbLockTimeoutMs,
      idleTransactionTimeoutMs: 5_000,
    }),
    adminPool: createContentPool({
      connectionString: env.contentDatabaseUrl,
      name: "admin",
      max: env.contentDbAdminPoolMax,
      statementTimeoutMs: env.contentDbAdminStatementTimeoutMs,
      lockTimeoutMs: env.contentDbLockTimeoutMs,
      idleTransactionTimeoutMs: 5_000,
    }),
  };
  return pools;
}

export async function closeApiContentPools(): Promise<void> {
  const active = pools;
  pools = null;
  if (!active) return;
  await Promise.all([active.publicPool.end(), active.adminPool.end()]);
}
