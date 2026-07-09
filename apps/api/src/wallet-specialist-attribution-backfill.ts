#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import { pool } from "./db.js";
import { resolveWalletIntelAttributionPolicy } from "./services/runtime-policies.js";
import { refreshWalletSpecialistAttribution } from "./services/wallet-attribution.js";

type CliOptions = {
  batch: number;
  limit: number | null;
  dryRun: boolean;
};

function readFlagValue(args: string[], index: number): string | null {
  const raw = args[index];
  const equalsIndex = raw.indexOf("=");
  if (equalsIndex >= 0) return raw.slice(equalsIndex + 1);
  return args[index + 1] && !args[index + 1].startsWith("--")
    ? args[index + 1]
    : null;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function parseCliOptions(args: string[]): CliOptions {
  let batch = 500;
  let limit: number | null = null;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--batch" || arg.startsWith("--batch=")) {
      batch = parsePositiveInt(readFlagValue(args, index), batch);
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      limit = parsePositiveInt(readFlagValue(args, index), 0);
      if (limit <= 0) limit = null;
    }
  }
  return { batch, limit, dryRun };
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const client = await pool.connect();
  try {
    const attributionPolicy = await resolveWalletIntelAttributionPolicy(client);
    const walletRows = await client.query<{ wallet_id: string }>(
      `
        select wallet_id
        from (
          select distinct wah.wallet_id
          from wallet_activity_hourly wah
          where wah.activity_type in ('delta', 'trade')
            and wah.hour_bucket >= now() - interval '30 days'
        ) active
        order by wallet_id
        limit $1
      `,
      [options.limit],
    );
    const walletIds = walletRows.rows.map((row) => row.wallet_id);
    console.log("[wallets:intel:attribution-backfill] selected", {
      wallets: walletIds.length,
      batch: options.batch,
      limit: options.limit,
      dryRun: options.dryRun,
    });
    if (options.dryRun) return;

    const startedAt = Date.now();
    let processed = 0;
    let updated = 0;
    const asOf = new Date();
    for (let index = 0; index < walletIds.length; index += options.batch) {
      const batchIds = walletIds.slice(index, index + options.batch);
      const result = await refreshWalletSpecialistAttribution(client, {
        walletIds: batchIds,
        policy: attributionPolicy.effective,
        asOf,
      });
      processed += result.processed;
      updated += result.updated;
      console.log("[wallets:intel:attribution-backfill] batch", {
        processed,
        selected: walletIds.length,
        updated,
        policyHash: result.policyHash,
      });
    }
    console.log("[wallets:intel:attribution-backfill] done", {
      processed,
      updated,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error("[wallets:intel:attribution-backfill] failed", error);
    process.exitCode = 1;
  });
}
