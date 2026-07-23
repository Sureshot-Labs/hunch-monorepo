import { createPgPool, type Pool } from "@hunch/infra";
import os from "node:os";

import { env } from "./env.js";

type FundingReconciliationOptions = {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  retryDelayMs?: number;
  pollDelayMs?: number;
  maxAttempts?: number;
  relay?: Readonly<{
    apiKey: string;
    credentialsEncryptionKey: string;
    referenceLookupHmacKey: string;
    referenceKeyVersion: number;
    timeoutMs?: number;
  }>;
};

type FundingReconciliationResult = {
  claimed: number;
  completed: number;
  requeued: number;
  failed: number;
  deadLettered: number;
  operationIds: readonly string[];
  skipped?: true;
  skipReason?: string;
};

type FundingWorkerModule = {
  runFundingReconciliationJob: (
    pool: Pool,
    options: FundingReconciliationOptions,
  ) => Promise<FundingReconciliationResult>;
};

type FundingWorkerModuleLoader = () => Promise<FundingWorkerModule>;

export function relayFundingWorkerConfig(
  input: Pick<
    typeof env,
    | "relayApiKey"
    | "relayRequestTimeoutMs"
    | "credentialsEncryptionKey"
    | "fundingReferenceLookupHmacKey"
    | "fundingReferenceLookupKeyVersion"
  >,
): FundingReconciliationOptions["relay"] {
  if (
    !input.relayApiKey ||
    !input.credentialsEncryptionKey ||
    !input.fundingReferenceLookupHmacKey
  ) {
    return undefined;
  }
  return {
    apiKey: input.relayApiKey,
    credentialsEncryptionKey: input.credentialsEncryptionKey,
    referenceLookupHmacKey: input.fundingReferenceLookupHmacKey,
    referenceKeyVersion: input.fundingReferenceLookupKeyVersion,
    ...(input.relayRequestTimeoutMs
      ? { timeoutMs: input.relayRequestTimeoutMs }
      : {}),
  };
}

let fundingModulePromise: Promise<FundingWorkerModule> | null = null;
let fundingPool: Pool | null = null;
let fundingModuleLoader: FundingWorkerModuleLoader =
  loadFundingWorkerModuleDefault;

async function loadFundingWorkerModuleDefault(): Promise<FundingWorkerModule> {
  const isTsxRuntime = import.meta.url.endsWith(".ts");
  if (isTsxRuntime) {
    const sourceUrl = new URL(
      "../../api/src/funding/worker/funding-reconciliation-worker.ts",
      import.meta.url,
    );
    return (await import(sourceUrl.href)) as FundingWorkerModule;
  }
  const moduleId: string = "api/funding-worker";
  return (await import(moduleId)) as FundingWorkerModule;
}

function getFundingPool(): Pool {
  if (fundingPool) return fundingPool;
  if (!env.databaseUrl) {
    throw new Error(
      "Funding reconciliation requires DATABASE_URL in finance-worker",
    );
  }
  fundingPool = createPgPool({
    connectionString: env.databaseUrl,
    options: "-c jit=off",
    max: env.fundingReconciliationPoolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });
  fundingPool.on("error", (error: unknown) => {
    console.error("[funding-reconciliation-pg] error", error);
  });
  return fundingPool;
}

async function getFundingWorkerModule(): Promise<FundingWorkerModule> {
  if (!fundingModulePromise) {
    fundingModulePromise = fundingModuleLoader();
  }
  return fundingModulePromise;
}

export function fundingWorkerId(): string {
  return `${os.hostname()}:${process.pid}`;
}

export async function runFundingReconciliationJob(): Promise<FundingReconciliationResult> {
  const module = await getFundingWorkerModule();
  const relay = relayFundingWorkerConfig(env);
  return module.runFundingReconciliationJob(getFundingPool(), {
    workerId: fundingWorkerId(),
    limit: env.fundingReconciliationBatchSize,
    leaseSeconds: env.fundingReconciliationLeaseSec,
    retryDelayMs: env.fundingReconciliationRetrySec * 1_000,
    pollDelayMs: env.fundingReconciliationPollSec * 1_000,
    maxAttempts: env.fundingReconciliationMaxAttempts,
    ...(relay ? { relay } : {}),
  });
}

export async function closeFundingReconciliationPool(): Promise<void> {
  const pool = fundingPool;
  fundingPool = null;
  if (pool) await pool.end();
}

export function setFundingWorkerModuleLoaderForTests(
  loader: FundingWorkerModuleLoader,
  pool: Pool,
): void {
  fundingModulePromise = null;
  fundingModuleLoader = loader;
  fundingPool = pool;
}

export function resetFundingWorkerModuleLoaderForTests(): void {
  fundingModulePromise = null;
  fundingModuleLoader = loadFundingWorkerModuleDefault;
  fundingPool = null;
}
