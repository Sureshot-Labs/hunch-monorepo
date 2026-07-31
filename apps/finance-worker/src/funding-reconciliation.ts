import { createPgPool, type Pool } from "@hunch/infra";
import os from "node:os";

import { env } from "./env.js";

type FundingReconciliationOptions = {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  retryDelayMs?: number;
  pollDelayMs?: number;
  idlePollDelayMs?: number;
  recoveryPollDelayMs?: number;
  receivePollDelayMs?: number;
  maxAttempts?: number;
  terminalTimeoutMs?: number;
  referenceProtection?: Readonly<{
    credentialsEncryptionKey: string;
    referenceLookupHmacKey: string;
    referenceKeyVersion: number;
  }>;
  relay?: Readonly<{
    apiKey: string;
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
  receiveObservation?: Readonly<{
    sessionsPolled: number;
    receiptsRecorded: number;
    recoveriesRequired: number;
    retryableErrors: number;
  }> | null;
  receiveRouting?: Readonly<{
    receiptsInspected: number;
    operationsCreated: number;
    receiptsReady: number;
    recoveriesRequired: number;
    reviewsRequired: number;
    retriesScheduled: number;
    retryableErrors: number;
  }> | null;
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
    ...(input.relayRequestTimeoutMs
      ? { timeoutMs: input.relayRequestTimeoutMs }
      : {}),
  };
}

export function fundingReferenceProtectionConfig(
  input: Pick<
    typeof env,
    | "credentialsEncryptionKey"
    | "fundingReferenceLookupHmacKey"
    | "fundingReferenceLookupKeyVersion"
  >,
): FundingReconciliationOptions["referenceProtection"] {
  if (!input.credentialsEncryptionKey || !input.fundingReferenceLookupHmacKey) {
    return undefined;
  }
  return {
    credentialsEncryptionKey: input.credentialsEncryptionKey,
    referenceLookupHmacKey: input.fundingReferenceLookupHmacKey,
    referenceKeyVersion: input.fundingReferenceLookupKeyVersion,
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
  const referenceProtection = fundingReferenceProtectionConfig(env);
  return module.runFundingReconciliationJob(getFundingPool(), {
    workerId: fundingWorkerId(),
    limit: env.fundingReconciliationBatchSize,
    leaseSeconds: env.fundingReconciliationLeaseSec,
    retryDelayMs: env.fundingReconciliationRetrySec * 1_000,
    pollDelayMs: env.fundingReconciliationPollSec * 1_000,
    idlePollDelayMs: env.fundingReconciliationIdlePollSec * 1_000,
    recoveryPollDelayMs: env.fundingReconciliationRecoveryPollSec * 1_000,
    receivePollDelayMs: env.fundingReceivePollSec * 1_000,
    maxAttempts: env.fundingReconciliationMaxAttempts,
    terminalTimeoutMs: env.fundingReconciliationTerminalTimeoutSec * 1_000,
    ...(referenceProtection ? { referenceProtection } : {}),
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
