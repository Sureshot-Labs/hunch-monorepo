#!/usr/bin/env tsx

import { pool } from "./db.js";
import { refreshSportsFixtures } from "./services/sports-fixtures.js";

type Args = {
  sport: string;
  competitionKey: string;
  season: string;
  fixtureKey?: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sport: "soccer",
    competitionKey: "fifa_world_cup",
    season: "2026",
    dryRun: false,
  };
  for (const entry of argv.slice(2)) {
    if (entry === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const eq = entry.indexOf("=");
    if (!entry.startsWith("--") || eq <= 2) continue;
    const key = entry.slice(2, eq);
    const value = entry.slice(eq + 1).trim();
    if (!value) continue;
    if (key === "sport") args.sport = value;
    if (key === "competition") args.competitionKey = value;
    if (key === "season") args.season = value;
    if (key === "fixture-key") args.fixtureKey = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await refreshSportsFixtures(pool, args);
  console.log(
    `[sports:fixtures:refresh] provider=${result.provider} sport=${result.sport} competition=${result.competitionKey} season=${result.season} fetched=${result.fetched} upserted=${result.upserted} dryRun=${result.dryRun ? 1 : 0}`,
  );
}

main()
  .catch((error) => {
    console.error("[sports:fixtures:refresh] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
