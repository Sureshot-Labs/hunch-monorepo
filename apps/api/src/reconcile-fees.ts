#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { pool } from "./db.js";
import { reconcileSolanaFeeEvents } from "./services/fee-reconcile.js";
import { reconcileLimitlessVenueShareAccruals } from "./services/limitless-fee-accruals.js";
import { reconcilePolymarketBuilderFeeAccruals } from "./services/polymarket-builder-fees.js";

export type ReconcileFeesOptions = {
  dryRun: boolean;
  limit: number;
  minAgeSec: number;
};

const DEFAULT_LIMIT = 25;
const DEFAULT_MIN_AGE_SEC = 60;

export function parseReconcileFeesArgs(
  args: string[] = process.argv.slice(2),
): ReconcileFeesOptions {
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

export async function runReconcileFees(options: ReconcileFeesOptions) {
  const summary = await reconcileSolanaFeeEvents(pool, options);
  const polymarketBuilder = await reconcilePolymarketBuilderFeeAccruals(pool, {
    dryRun: options.dryRun,
    limit: options.limit,
  });
  const limitlessVenueShare = await reconcileLimitlessVenueShareAccruals(pool, {
    dryRun: options.dryRun,
    limit: options.limit,
    minAgeSec: options.minAgeSec,
  });
  console.log(
    [
      "Reconcile fees (Solana)",
      `checked=${summary.checked}`,
      `collected=${summary.collected}`,
      `failed=${summary.failed}`,
      `skipped=${summary.skipped}`,
      `errors=${summary.errors}`,
      `dryRun=${options.dryRun ? 1 : 0}`,
    ].join(" "),
  );
  console.log(
    [
      "Reconcile fees (Polymarket builder)",
      `checked=${polymarketBuilder.verify.checked}`,
      `verified=${polymarketBuilder.verify.verified}`,
      `failed=${polymarketBuilder.verify.failed}`,
      `skipped=${polymarketBuilder.verify.skipped}`,
      `unlockConsidered=${polymarketBuilder.unlock.considered}`,
      `unlocked=${polymarketBuilder.unlock.unlocked}`,
      `unlockSkipped=${polymarketBuilder.unlock.skipped}`,
      `budgetMicro=${polymarketBuilder.unlock.budgetMicro}`,
      `dryRun=${options.dryRun ? 1 : 0}`,
    ].join(" "),
  );
  console.log(
    [
      "Reconcile fees (Limitless venue share)",
      `backfillChecked=${limitlessVenueShare.backfill.checked}`,
      `backfillUpserted=${limitlessVenueShare.backfill.upserted}`,
      `backfillSkipped=${limitlessVenueShare.backfill.skipped}`,
      `checked=${limitlessVenueShare.verify.checked}`,
      `verified=${limitlessVenueShare.verify.verified}`,
      `failed=${limitlessVenueShare.verify.failed}`,
      `skipped=${limitlessVenueShare.verify.skipped}`,
      `unlockConsidered=${limitlessVenueShare.unlock.considered}`,
      `unlocked=${limitlessVenueShare.unlock.unlocked}`,
      `unlockSkipped=${limitlessVenueShare.unlock.skipped}`,
      `budgetMicro=${limitlessVenueShare.unlock.budgetMicro}`,
      `contractReceivablesChecked=${limitlessVenueShare.contractReceivables.checked}`,
      `contractReceivablesPending=${limitlessVenueShare.contractReceivables.pending}`,
      `contractReceivablesResolvedPayable=${limitlessVenueShare.contractReceivables.converted}`,
      `contractReceivablesSettledZero=${limitlessVenueShare.contractReceivables.settledZero}`,
      `contractReceivablesFailed=${limitlessVenueShare.contractReceivables.failed}`,
      `contractReceivablesSynced=${limitlessVenueShare.contractReceivableSync.synced}`,
      `dryRun=${options.dryRun ? 1 : 0}`,
    ].join(" "),
  );
  return { solana: summary, polymarketBuilder, limitlessVenueShare };
}

function isDirectExecution(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return pathToFileURL(entrypoint).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  runReconcileFees(parseReconcileFeesArgs())
    .then(async () => {
      await pool.end();
    })
    .catch(async (error) => {
      console.error("[fees:reconcile]", error);
      process.exitCode = 1;
      await pool.end();
    });
}
