import { config } from "dotenv";
import { resolve } from "path";

const cwd = process.cwd(); // apps/indexer-limitless
config({ path: resolve(cwd, "../../.env"), override: true });

// nuke pg envs so Pool uses connectionString you provided
["PGHOST", "PGUSER", "PGPASSWORD", "PGPORT", "PGDATABASE", "PGSSLMODE"].forEach(
  (k) => delete process.env[k],
);

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[env] Missing ${name}. Put it in ../../.env`);
    process.exit(1);
  }
  return v;
}

export const env = {
  dbUrl: req("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "",

  limitlessBase: process.env.LIMITLESS_BASE ?? "https://api.limitless.exchange",
  // how many markets we’ll pull per bootstrap tick
  bootstrapPageSize: Number(process.env.LIMITLESS_PAGE_SIZE ?? "100"),
  bootstrapMaxPages: Number(process.env.LIMITLESS_MAX_PAGES ?? "10"),
  // minutes between refreshes
  refreshMinutes: Number(process.env.LIMITLESS_REFRESH_MIN ?? "5"),

  // prices are % (0..100). convert to 0..1
  writePriceSnapshots: (process.env.LIMITLESS_SNAPSHOTS ?? "true") === "true",

  venueName: "limitless",
  venueId: Number(process.env.LIMITLESS_VENUE_ID ?? "3"),
};
