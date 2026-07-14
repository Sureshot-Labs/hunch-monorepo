#!/usr/bin/env tsx

import { pool } from "./db.js";
import { readPositiveInt } from "./lib/cli-args.js";
import { loadHolderResearchObservationCalibration } from "./services/holder-research-observations.js";

async function main() {
  const argv = process.argv.slice(2);
  const lookbackDays = readPositiveInt(argv, "lookback-days", 90);
  const limit = readPositiveInt(argv, "limit", 25_000);
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    const report = await loadHolderResearchObservationCalibration(client, {
      lookbackDays,
      limit,
    });
    await client.query("commit");
    console.log(JSON.stringify({ lookbackDays, limit, report }, null, 2));
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error: unknown) => {
    console.error("[holder-research:observations] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
