import { createPgPool, type Pool } from "@hunch/infra";
import type { ContentRuntimeConfig } from "@hunch/config/content";

import { env } from "./env.js";

type ContentWorkerResult = {
  published: number;
  delivered: number;
  expiredUploads: number;
  deletedObjects: number;
  retainedRows: number;
};

type ContentWorkerModule = {
  configureContentServiceRuntime(config: ContentRuntimeConfig): void;
  runContentWorkerPass(
    pool: Pool,
    logger: {
      info(bindings: unknown, message?: string): void;
      warn(bindings: unknown, message?: string): void;
    },
    options: { workerId: string; runRetention: boolean },
  ): Promise<ContentWorkerResult>;
};

let modulePromise: Promise<ContentWorkerModule> | null = null;
let contentPool: Pool | null = null;
let nextRetentionAt = 0;

async function loadContentWorkerModule(): Promise<ContentWorkerModule> {
  if (import.meta.url.endsWith(".ts")) {
    const sourceUrl = new URL(
      "../../api/src/content-worker-entry.ts",
      import.meta.url,
    );
    return (await import(sourceUrl.href)) as ContentWorkerModule;
  }
  const moduleId: string = "api/content-worker";
  return (await import(moduleId)) as ContentWorkerModule;
}

function getContentPool(): Pool {
  if (contentPool) return contentPool;
  if (!env.databaseUrl) {
    throw new Error("Content worker requires DATABASE_URL");
  }
  const config = env.content;
  contentPool = createPgPool({
    connectionString: env.databaseUrl,
    options:
      "-c application_name=hunch-content-worker " +
      "-c jit=off " +
      `-c statement_timeout=${config.dbWorkerStatementTimeoutMs} ` +
      `-c lock_timeout=${config.dbLockTimeoutMs} ` +
      "-c idle_in_transaction_session_timeout=10000",
    max: config.dbWorkerPoolMax,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 2_000,
  });
  contentPool.on("error", (error: unknown) => {
    console.error("[content-pg:worker] error", error);
  });
  return contentPool;
}

function contentLogger() {
  return {
    info: (bindings: unknown, message?: string) => {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "content_worker_info",
          message,
          bindings,
        }),
      );
    },
    warn: (bindings: unknown, message?: string) => {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "content_worker_warn",
          message,
          bindings,
        }),
      );
    },
  };
}

export async function runContentWorkerJob(): Promise<ContentWorkerResult> {
  modulePromise ??= loadContentWorkerModule();
  const module = await modulePromise;
  module.configureContentServiceRuntime(env.content);
  const runRetention = Date.now() >= nextRetentionAt;
  if (runRetention) {
    // Advance before the query runs: a persistent retention error must not
    // turn the content cadence into a database query storm.
    nextRetentionAt = Date.now() + 6 * 60 * 60 * 1_000;
  }
  const result = await module.runContentWorkerPass(
    getContentPool(),
    contentLogger(),
    {
      workerId: `finance-worker:${process.pid}`,
      runRetention,
    },
  );
  return result;
}

export async function closeContentWorkerPool(): Promise<void> {
  const pool = contentPool;
  contentPool = null;
  if (pool) await pool.end();
}
