import { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { rm } from "node:fs/promises";
import { HEARTBEAT_PATH, markHealthy } from "./health.js";
import {
  readMatchingPolicy,
  approvalRevision,
  matchingWorkerEnabled,
  runJob,
  warmInterest,
  runDiscovery,
  revalidateLinks,
} from "@hunch/market-matching";

// Run using the repository run-with-secrets bootstrap; never import API env.
const command = process.argv[2] ?? "run";
const readOnly = command === "status" || command === "report";
if (
  !readOnly &&
  command !== "run" &&
  process.env.MATCHING_WORKER_ENABLED === "false"
) {
  console.log(
    JSON.stringify({ status: "disabled", reason: "environment_kill_switch" }),
  );
} else {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    statement_timeout: 30_000,
  });
  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });
  process.on("SIGINT", () => {
    stopped = true;
  });
  try {
    if (command === "status") {
      const matching = await readMatchingPolicy(pool);
      const [jobs, budget, halted, selection] = await Promise.all([
        pool.query(
          "select status,entity_kind,count(*)::int as jobs from market_matching_jobs group by status,entity_kind",
        ),
        pool.query(
          "select budget_day::text,reserved_usd,spent_usd,request_count,lazy_reserved_usd,lazy_spent_usd,lazy_request_count from market_matching_budget where budget_day=(now() at time zone 'UTC')::date",
        ),
        pool.query(
          "select state_key,payload from market_matching_state where state_key in ('model_drift','cost_drift')",
        ),
        pool.query(
          "select payload,updated_at from market_matching_state where state_key='warm'",
        ),
      ]);
      console.log(
        JSON.stringify({
          policy: matching,
          approvalRevision: approvalRevision(matching),
          workerEnabled: matchingWorkerEnabled(matching),
          jobs: jobs.rows,
          budget: budget.rows[0] ?? null,
          halted: halted.rows,
          selection: selection.rows[0] ?? null,
        }),
      );
    } else if (command === "report") {
      console.log(
        JSON.stringify(
          (
            await pool.query(
              "select entity_kind,decision,disposition,count(*)::int as evaluations,sum(cost_usd) as cost_usd from matching_evaluations group by entity_kind,decision,disposition",
            )
          ).rows,
        ),
      );
    } else if (["run", "run-once", "scan"].includes(command)) {
      if (command === "run") await rm(HEARTBEAT_PATH, { force: true });
      let nextScan = 0;
      do {
        const matching = await readMatchingPolicy(pool);
        if (command === "run") await markHealthy();
        if (!matchingWorkerEnabled(matching)) {
          if (command !== "run") {
            console.log(
              JSON.stringify({ status: "disabled", policy: "market_matching" }),
            );
            break;
          }
          await delay(5000);
          continue;
        }
        if (Date.now() >= nextScan) {
          try {
            await warmInterest(pool);
          } catch {
            console.warn("matching_warm_deferred");
          }
          try {
            await revalidateLinks(pool);
          } catch {
            console.warn("matching_revalidation_deferred");
          }
          nextScan = Date.now() + 60_000;
        }
        await runDiscovery(pool);
        if (command !== "scan") {
          const budget = Number(
            process.env.MATCHING_DAILY_BUDGET_USD ?? matching.dailyBudgetUsd,
          );
          if (!Number.isFinite(budget) || budget < 0)
            throw new Error("invalid_matching_budget");
          const results = await Promise.allSettled(
            Array.from({ length: matching.concurrency }, () =>
              runJob(pool, {
                key: process.env.OPENROUTER_API_KEY ?? "",
                dailyBudget: budget,
              }),
            ),
          );
          for (const result of results) {
            if (result.status === "rejected") throw result.reason;
            console.log(JSON.stringify({ job: result.value }));
          }
        }
        if (command !== "run") break;
        await delay(1000);
      } while (!stopped);
    } else
      throw new Error("Unknown command: run, run-once, scan, status, report");
  } finally {
    await pool.end();
  }
}
