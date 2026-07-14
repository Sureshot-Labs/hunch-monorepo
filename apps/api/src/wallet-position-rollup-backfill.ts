#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import { pool } from "./db.js";
import {
  compareWalletPositionRollups,
  refreshWalletPositionExposure,
} from "./wallet-intel-refresh.js";

type CliOptions = {
  batch: number;
  limit: number | null;
  execute: boolean;
};

function readValue(args: string[], index: number): string | null {
  const argument = args[index] ?? "";
  const equalsIndex = argument.indexOf("=");
  if (equalsIndex >= 0) return argument.slice(equalsIndex + 1);
  const next = args[index + 1];
  return next && !next.startsWith("--") ? next : null;
}

function positiveInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function parseWalletPositionRollupBackfillArgs(
  args: string[],
): CliOptions {
  let batch = 250;
  let limit: number | null = null;
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--execute") {
      execute = true;
    } else if (argument === "--batch" || argument.startsWith("--batch=")) {
      batch = positiveInteger(readValue(args, index), batch);
    } else if (argument === "--limit" || argument.startsWith("--limit=")) {
      limit = positiveInteger(readValue(args, index), 0) || null;
    }
  }
  return { batch, limit, execute };
}

async function countRemaining(limit: number | null): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from (
        select w.id
        from wallets w
        join wallet_intel_selector_snapshot selector
          on selector.wallet_id = w.id
        left join wallet_position_exposure exposure
          on exposure.wallet_id = w.id
        where coalesce(exposure.open_positions_version, 0) < 1
        order by w.id
        limit $1::integer
      ) pending
    `,
    [limit],
  );
  return Number(rows[0]?.count ?? 0);
}

async function main() {
  const options = parseWalletPositionRollupBackfillArgs(process.argv.slice(2));
  const total = await countRemaining(options.limit);
  console.log("[wallet-position-rollup-backfill] selected", {
    total,
    batch: options.batch,
    limit: options.limit,
    execute: options.execute,
  });
  if (!options.execute || total === 0) {
    console.log("[wallet-position-rollup-backfill] dry-run", {
      total,
      processed: 0,
      matched: 0,
      failed: 0,
      remaining: total,
    });
    return;
  }

  const client = await pool.connect();
  let processed = 0;
  let matched = 0;
  let failed = 0;
  try {
    while (processed < total) {
      const batchLimit = Math.min(options.batch, total - processed);
      let selectedWalletIds: string[] = [];
      await client.query("begin");
      try {
        const { rows } = await client.query<{ wallet_id: string }>(
          `
            select w.id::text as wallet_id
            from wallets w
            join wallet_intel_selector_snapshot selector
              on selector.wallet_id = w.id
            left join wallet_position_exposure exposure
              on exposure.wallet_id = w.id
            where coalesce(exposure.open_positions_version, 0) < 1
            order by w.id
            limit $1::integer
            for update of w skip locked
          `,
          [batchLimit],
        );
        selectedWalletIds = rows.map((row) => row.wallet_id);
        if (selectedWalletIds.length === 0) {
          await client.query("rollback");
          break;
        }
        const asOf = new Date();
        await refreshWalletPositionExposure(client, {
          walletIds: selectedWalletIds,
          asOf,
        });
        const comparison = await compareWalletPositionRollups(client, {
          walletIds: selectedWalletIds,
          asOf,
        });
        if (
          comparison.comparedWallets !== selectedWalletIds.length ||
          comparison.mismatchedWallets > 0
        ) {
          throw new Error(
            `rollup golden comparison failed: ${JSON.stringify(comparison)}`,
          );
        }
        await client.query("commit");
        processed += selectedWalletIds.length;
        matched += comparison.matchedWallets;
        console.log("[wallet-position-rollup-backfill] batch", {
          processed,
          total,
          matched,
          failed,
          comparison,
        });
      } catch (error) {
        await client.query("rollback").catch(() => {});
        failed += selectedWalletIds.length || batchLimit;
        console.error("[wallet-position-rollup-backfill] batch failed", {
          processed,
          failed,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  } finally {
    client.release();
  }

  const remaining = await countRemaining(null);
  console.log("[wallet-position-rollup-backfill] done", {
    total,
    processed,
    matched,
    failed,
    remaining,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .catch((error) => {
      console.error("[wallet-position-rollup-backfill] failed", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
