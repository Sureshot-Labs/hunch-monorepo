#!/usr/bin/env tsx

import { pool } from "./db.js";
import { reconcileSolanaFeeEvents } from "./services/fee-reconcile.js";

type ScriptOptions = {
  dryRun: boolean;
  limit: number;
  minAgeSec: number;
};

const DEFAULT_LIMIT = 25;
const DEFAULT_MIN_AGE_SEC = 60;

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
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
    limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_LIMIT,
    minAgeSec:
      Number.isFinite(minAgeSec) && minAgeSec >= 0
        ? Math.trunc(minAgeSec)
        : DEFAULT_MIN_AGE_SEC,
  };
}

async function main() {
  const options = parseArgs();
  const summary = await reconcileSolanaFeeEvents(pool, options);
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
  await pool.end();
}

main().catch((error) => {
  console.error("[fees:reconcile]", error);
  process.exitCode = 1;
  void pool.end();
});
