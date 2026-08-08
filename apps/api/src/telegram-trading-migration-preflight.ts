#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { createPgPool } from "@hunch/infra";

import type { DbQuery } from "./db.js";

export const TELEGRAM_CUSTOM_SELL_MIGRATION =
  "0202_telegram_custom_sell_amount.sql";

export type TelegramTradingMigrationPreflightReport = Readonly<{
  blockers: readonly string[];
  constraintDefinition: string | null;
  migrationApplied: boolean;
}>;

function normalizeDefinition(value: string | null | undefined): string | null {
  return (
    value
      ?.replaceAll('"', "")
      .replaceAll(/::(?:numeric|text)/g, "")
      .replaceAll(/\((-?\d+(?:\.\d+)?)\)/g, "$1")
      .replaceAll(/\(([a-z_][a-z0-9_]*)\)/g, "$1")
      .replaceAll(/\s+/g, " ")
      .trim()
      .toLowerCase() ?? null
  );
}

function hasExpectedConstraint(definition: string | null): boolean {
  if (!definition) return false;
  return [
    "action = 'buy'",
    "action = 'sell'",
    "action = 'redeem'",
    "amount_usd is not null",
    "amount_usd > 0",
    "amount_usd is null",
    "sell_percent is null",
    "sell_percent > 0",
    "sell_percent <= 100",
    "shares_raw is not null",
    "shares_raw ~ '^[0-9]+$'",
    "shares_raw is null",
    "shares_raw > 0",
    "side is null",
  ].every((fragment) => definition.includes(fragment));
}

export async function inspectTelegramTradingMigrationPreflight(
  db: DbQuery,
): Promise<TelegramTradingMigrationPreflightReport> {
  const applied = await db.query<{ applied: boolean }>(
    `select exists (
       select 1
         from public.schema_migrations
        where filename = $1
     ) as applied`,
    [TELEGRAM_CUSTOM_SELL_MIGRATION],
  );
  const constraint = await db.query<{ definition: string | null }>(
    `select pg_get_constraintdef(oid) as definition
       from pg_constraint
      where conrelid = 'public.telegram_trade_intents'::regclass
        and conname = 'telegram_trade_intents_action_payload_check'`,
  );
  const migrationApplied = applied.rows[0]?.applied === true;
  const constraintDefinition = normalizeDefinition(
    constraint.rows[0]?.definition,
  );
  const constraintReady = hasExpectedConstraint(constraintDefinition);
  const blockers = [
    !migrationApplied
      ? `${TELEGRAM_CUSTOM_SELL_MIGRATION} is not recorded`
      : null,
    migrationApplied && !constraintReady
      ? "0202 is recorded but the Telegram sell payload constraint is incomplete"
      : null,
    !migrationApplied && constraintReady
      ? "Telegram custom sell constraint exists before 0202 is recorded"
      : null,
  ].filter((value): value is string => value != null);
  return { blockers, constraintDefinition, migrationApplied };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = createPgPool({
    connectionString: databaseUrl,
    options: "-c jit=off",
    max: 1,
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("begin read only");
    transactionOpen = true;
    const report = await inspectTelegramTradingMigrationPreflight(client);
    console.log(
      process.argv.includes("--json")
        ? JSON.stringify(report, null, 2)
        : [
            `Telegram trading migration preflight: ${report.blockers.length === 0 ? "OK" : "BLOCKED"}`,
            `0202 recorded: ${report.migrationApplied ? "yes" : "no"}`,
            ...report.blockers.map((blocker) => `- ${blocker}`),
          ].join("\n"),
    );
    if (report.blockers.length > 0) process.exitCode = 1;
    await client.query("rollback");
    transactionOpen = false;
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  main().catch((error) => {
    console.error("[telegram-trading-migration-preflight]", error);
    process.exitCode = 1;
  });
}
