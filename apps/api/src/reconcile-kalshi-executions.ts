#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import { pool } from "./db.js";
import {
  reconcileKalshiExecutions,
  type ReconcileKalshiExecutionsOptions,
} from "./services/kalshi-execution-reconcile.js";

export type { ReconcileKalshiExecutionsOptions } from "./services/kalshi-execution-reconcile.js";

const DEFAULT_LIMIT = 50;
const DEFAULT_MIN_AGE_SEC = 15;

export function parseReconcileKalshiExecutionsArgs(
  args: string[] = process.argv.slice(2),
): ReconcileKalshiExecutionsOptions {
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };

  const limitRaw = getValue("--limit");
  const minAgeRaw = getValue("--min-age-sec");
  const limit = limitRaw ? Number(limitRaw) : DEFAULT_LIMIT;
  const minAgeSec = minAgeRaw ? Number(minAgeRaw) : DEFAULT_MIN_AGE_SEC;

  return {
    dryRun: args.includes("--dry-run"),
    limit:
      Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_LIMIT,
    minAgeSec:
      Number.isFinite(minAgeSec) && minAgeSec >= 0
        ? Math.trunc(minAgeSec)
        : DEFAULT_MIN_AGE_SEC,
  };
}

export async function runReconcileKalshiExecutions(
  options: ReconcileKalshiExecutionsOptions,
) {
  const summary = await reconcileKalshiExecutions(pool, {
    ...options,
    logger:
      options.logger ??
      ({
        error(obj: unknown, msg?: string) {
          console.error("[kalshi:reconcile-executions:error]", msg ?? "", obj);
        },
        warn(obj: unknown, msg?: string) {
          console.warn("[kalshi:reconcile-executions:warn]", msg ?? "", obj);
        },
        info(obj: unknown, msg?: string) {
          console.log("[kalshi:reconcile-executions:info]", msg ?? "", obj);
        },
      } satisfies NonNullable<ReconcileKalshiExecutionsOptions["logger"]>),
  });
  console.log(
    [
      "Reconcile Kalshi executions",
      `checked=${summary.checked}`,
      `updated=${summary.updated}`,
      `fulfilled=${summary.fulfilled}`,
      `noFill=${summary.noFill}`,
      `failed=${summary.failed}`,
      `feeBackfilled=${summary.feeBackfilled}`,
      `skipped=${summary.skipped}`,
      `errors=${summary.errors}`,
      `dryRun=${options.dryRun ? 1 : 0}`,
    ].join(" "),
  );
  return summary;
}

function isDirectExecution(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return pathToFileURL(entrypoint).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  runReconcileKalshiExecutions(parseReconcileKalshiExecutionsArgs())
    .then(async () => {
      await pool.end();
    })
    .catch(async (error) => {
      console.error("[kalshi:reconcile-executions]", error);
      process.exitCode = 1;
      await pool.end();
    });
}
