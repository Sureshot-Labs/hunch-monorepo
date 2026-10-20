import { createPgPool, type Pool } from "@hunch/infra";
import { env } from "./env.js";
import {
  createHip4ObserverRunner,
  type Hip4ObserverCadence,
} from "./hip4-observer-cadence.js";

type AccountModule = {
  readHip4FinancialReadCadence(pool: Pool): Promise<Hip4ObserverCadence>;
  runHip4FinancialReadPass(
    pool: Pool,
    fetcher?: typeof fetch,
    accountFirst?: boolean,
    options?: { skipAccounts?: boolean },
  ): Promise<{
    claimed: number;
    updated: number;
    errors: number;
    leaseLost: number;
    budgetExhausted: number;
    nextIntervalSeconds: number;
    nextAccountIntervalSeconds: number;
    orderObservation?: {
      claimed: number;
      saved: number;
      errors: number;
      leaseLost: number;
      budgetExhausted: number;
    };
  }>;
};
let accountModule: Promise<AccountModule> | null = null;
let accountPool: Pool | null = null;

async function loadAccountObserver() {
  accountModule ??= import(
    import.meta.url.endsWith(".ts")
      ? new URL("../../api/src/hip4-account-worker-entry.ts", import.meta.url)
          .href
      : "api/hip4-account-worker"
  ) as Promise<AccountModule>;
  if (!env.databaseUrl)
    throw new Error("Account observer requires DATABASE_URL");
  if (!accountPool) {
    accountPool = createPgPool({
      connectionString: env.databaseUrl,
      max: env.fundingReconciliationPoolSize,
      connectionTimeoutMillis: 2000,
      options:
        "-c application_name=hunch-hip4-account-observer -c statement_timeout=15000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000",
    });
    accountPool.on("error", () =>
      console.error("[hip4-account-observer] database connection error"),
    );
  }
  return { pool: accountPool, observer: await accountModule };
}

function createObserverRunner() {
  return createHip4ObserverRunner({
    readCadence: async () => {
      const { pool, observer } = await loadAccountObserver();
      return observer.readHip4FinancialReadCadence(pool);
    },
    runPass: async (accountFirst, options) => {
      const { pool, observer } = await loadAccountObserver();
      return observer.runHip4FinancialReadPass(
        pool,
        undefined,
        accountFirst,
        options,
      );
    },
  });
}
let observerRunner = createObserverRunner();

export function runHip4AccountReadJob() {
  // Scheduler timeout does not end provider work; hold single-flight until it
  // actually settles. SQL leases protect concurrent API/worker instances.
  return observerRunner.run();
}
export async function closeHip4AccountReadPool() {
  await observerRunner.waitForIdle();
  const pool = accountPool;
  accountPool = null;
  if (pool) await pool.end();
  observerRunner = createObserverRunner();
}
