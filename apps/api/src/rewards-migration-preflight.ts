#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { pool, type DbQuery } from "./db.js";

export const MUTABLE_REWARDS_MIGRATIONS = [
  "0073_rewards_points_awarded.sql",
  "0074_rewards_multiplier_policy.sql",
  "0075_rewards_treasury_sweep_ledger.sql",
  "0076_rewards_claims_usdc_scale.sql",
  "0077_fee_events_frozen_liability_snapshot.sql",
  "0078_fee_events_frozen_cutover_default.sql",
] as const;

export function resolveBlockedRewardsMigrations(
  appliedMigrations: readonly string[],
): string[] {
  const appliedSet = new Set(appliedMigrations);
  return MUTABLE_REWARDS_MIGRATIONS.filter((filename) =>
    appliedSet.has(filename),
  );
}

async function fetchAppliedRewardsMigrations(db: DbQuery): Promise<string[]> {
  const { rows: tableRows } = await db.query<{ table_name: string | null }>(
    `select to_regclass('public.schema_migrations')::text as table_name`,
  );
  if (!tableRows[0]?.table_name) return [];

  const { rows } = await db.query<{ filename: string }>(
    `
      select filename
      from public.schema_migrations
      where filename = any($1::text[])
      order by filename asc
    `,
    [Array.from(MUTABLE_REWARDS_MIGRATIONS)],
  );

  return rows.map((row) => row.filename);
}

export async function getBlockedRewardsMigrations(
  db: DbQuery,
): Promise<string[]> {
  const applied = await fetchAppliedRewardsMigrations(db);
  return resolveBlockedRewardsMigrations(applied);
}

export function formatRewardsMigrationPreflightError(
  blocked: readonly string[],
): string {
  return [
    "Rewards migration preflight failed.",
    "The squashed mutable migration set cannot be applied because these migrations are already recorded:",
    ...blocked.map((filename) => `- ${filename}`),
    "Use forward-only migrations instead of rewriting the mutable set.",
  ].join("\n");
}

export async function assertRewardsMigrationPreflight(
  db: DbQuery,
): Promise<void> {
  const blocked = await getBlockedRewardsMigrations(db);
  if (!blocked.length) return;
  throw new Error(formatRewardsMigrationPreflightError(blocked));
}

async function main(): Promise<void> {
  try {
    await assertRewardsMigrationPreflight(pool);
    console.log(
      JSON.stringify(
        {
          ok: true,
          checked: Array.from(MUTABLE_REWARDS_MIGRATIONS),
          blocked: [],
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

function isDirectExecution(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return pathToFileURL(entrypoint).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error("[rewards-migration-preflight]", error);
    process.exitCode = 1;
  });
}
