import { createPgPool, type Pool } from "@hunch/infra";
import { env } from "./env.js";

type AccountModule = {
  runHip4FinancialReadPass(
    pool: Pool,
    fetcher?: typeof fetch,
    accountFirst?: boolean,
  ): Promise<{
    claimed: number;
    updated: number;
    errors: number;
    leaseLost: number;
    budgetExhausted: number;
    nextIntervalSeconds: number;
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
let accountFirstNext = true;
let running: Promise<
  Awaited<ReturnType<AccountModule["runHip4FinancialReadPass"]>>
> | null = null;

async function runPass() {
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
  const accountFirst = accountFirstNext;
  // Flip only for an actual pass, never a scheduler timeout's single-flight
  // replay. Restart defaults to existing P2 priority, then alternates.
  accountFirstNext = !accountFirstNext;
  return (await accountModule).runHip4FinancialReadPass(
    accountPool,
    undefined,
    accountFirst,
  );
}

export function runHip4AccountReadJob() {
  // Scheduler timeout does not end provider work; hold single-flight until it
  // actually settles. SQL leases protect concurrent API/worker instances.
  running ??= runPass().finally(() => {
    running = null;
  });
  return running;
}
export async function closeHip4AccountReadPool() {
  await running?.catch(() => undefined);
  const pool = accountPool;
  accountPool = null;
  if (pool) await pool.end();
}
