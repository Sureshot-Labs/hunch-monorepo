import { createPgPool, type Pool } from "@hunch/infra";
import { env } from "./env.js";

type AccountModule = {
  runHip4AccountReadPass(pool: Pool): Promise<{
    claimed: number;
    updated: number;
    errors: number;
    leaseLost: number;
    budgetExhausted: number;
    nextIntervalSeconds: number;
  }>;
};
let accountModule: Promise<AccountModule> | null = null;
let accountPool: Pool | null = null;
let running: Promise<
  Awaited<ReturnType<AccountModule["runHip4AccountReadPass"]>>
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
  return (await accountModule).runHip4AccountReadPass(accountPool);
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
