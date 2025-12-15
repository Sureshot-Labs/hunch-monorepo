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

function parseOptionalBool(v: string | undefined): boolean | undefined {
  if (!v) return undefined;
  switch (v.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

const limitlessEnabledSetting = parseOptionalBool(
  process.env.LIMITLESS_ENABLED,
);

const pageSizeRaw = Number(process.env.LIMITLESS_PAGE_SIZE ?? "25");
const bootstrapPageSize = Math.min(
  25,
  Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 25),
);

const maxPagesRaw = Number(process.env.LIMITLESS_MAX_PAGES ?? "10");
const bootstrapMaxPages = Math.max(
  0,
  Number.isFinite(maxPagesRaw) ? maxPagesRaw : 10,
);

const refreshMinutesRaw = Number(process.env.LIMITLESS_REFRESH_MIN ?? "5");
const refreshMinutes = Math.max(
  1,
  Number.isFinite(refreshMinutesRaw) ? refreshMinutesRaw : 5,
);

export const env = {
  dbUrl: req("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "",

  limitlessEnabledSetting,
  limitlessEnabled: limitlessEnabledSetting ?? true,

  limitlessBase: process.env.LIMITLESS_BASE ?? "https://api.limitless.exchange",
  // how many markets we’ll pull per bootstrap tick
  bootstrapPageSize,
  bootstrapMaxPages,
  // minutes between refreshes
  refreshMinutes,

  // prices are % (0..100). convert to 0..1
  writePriceSnapshots: (process.env.LIMITLESS_SNAPSHOTS ?? "true") === "true",

  venueName: "limitless",
  venueId: Number(process.env.LIMITLESS_VENUE_ID ?? "3"),
};
