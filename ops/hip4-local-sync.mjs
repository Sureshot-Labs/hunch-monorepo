import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CATALOG_SYNC_PAGE_DEFAULTS,
  LOCAL_DATABASE,
  LOCAL_REDIS,
  validateCatalogPageBudget,
  validateDatabaseTarget,
} from "./hip4-local.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseSyncArguments(argv) {
  const names = new Map([
    ["--venue", "venue"],
    ["--database-url", "databaseUrl"],
    ["--expect-database", "expectedDatabase"],
    ["--redis-url", "redisUrl"],
    ["--max-pages", "maxPages"],
  ]);
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = names.get(argv[i]);
    if (!key || Object.hasOwn(options, key))
      throw new Error("Unknown or duplicate local sync option");
    if (!argv[i + 1] || argv[i + 1].startsWith("--"))
      throw new Error("Missing local sync option value");
    options[key] = argv[++i];
  }
  if (!["polymarket", "limitless"].includes(options.venue))
    throw new Error("Local catalog sync requires polymarket or limitless");
  options.databaseUrl = validateDatabaseTarget(
    options.databaseUrl,
    options.expectedDatabase,
  );
  if (options.redisUrl !== LOCAL_REDIS)
    throw new Error("Local catalog sync requires the fixed local Redis target");
  options.maxPages = validateCatalogPageBudget(
    options.maxPages ?? CATALOG_SYNC_PAGE_DEFAULTS[options.venue],
  );
  return options;
}

/** Validate before importing production env/db modules: their root dotenv fallback
 * must never get an opportunity to override the explicit local targets. */
export function validateSyncEnvironment(options, environment = process.env) {
  const target = validateDatabaseTarget(
    options.databaseUrl,
    options.expectedDatabase,
  );
  const budgetKey =
    options.venue === "polymarket"
      ? "POLYMARKET_HOT_MAX_PAGES"
      : "LIMITLESS_MAX_PAGES";
  if (
    !["polymarket", "limitless"].includes(options.venue) ||
    options.redisUrl !== LOCAL_REDIS ||
    environment.DATABASE_URL !== target ||
    environment.REDIS_URL !== LOCAL_REDIS ||
    environment.HUNCH_RUNTIME_SECRETS_LOADED !== "1" ||
    environment.HUNCH_SECRETS_MODE !== "off" ||
    environment.HUNCH_SECRET_BUNDLES !== "" ||
    environment[budgetKey] !==
      String(validateCatalogPageBudget(options.maxPages))
  )
    throw new Error(
      "Run catalog sync through ops/hip4-local.mjs with its sanitized local bootstrap",
    );
}

async function loadProductionModules(venue) {
  const entry = (name) =>
    pathToFileURL(path.join(ROOT, `apps/indexer-${venue}/dist/${name}.js`))
      .href;
  const bootstrap = await import(entry("bootstrap"));
  const { pool } = await import(entry("db"));
  const { redis } = await import(entry("redis"));
  return { bootstrap, pool, redis };
}

async function closeResources({ pool, redis }) {
  const closed = await Promise.allSettled([
    Promise.resolve().then(() => pool.end()),
    Promise.resolve().then(async () => {
      if (!redis.isOpen) return;
      try {
        await redis.quit();
      } catch {
        await redis.disconnect();
      }
    }),
  ]);
  if (closed.some((result) => result.status === "rejected"))
    throw new Error("Local catalog sync resource cleanup failed");
}

function polymarketSummary(options, hot, catalog, repairs) {
  const lanes = hot.lanes.map((lane) => ({
    version: lane.version,
    closed: lane.closed,
    failed: Boolean(lane.error),
    pages: lane.result?.pages ?? 0,
  }));
  const failedLanes = lanes.filter((lane) => lane.failed).length;
  const budgetFilledLanes = lanes.filter(
    (lane) => lane.pages >= options.maxPages,
  ).length;
  const catalogCheckpointComplete = catalog.checkpoint.phase === "complete";
  const complete =
    catalogCheckpointComplete &&
    !catalog.offsetCapReached &&
    !failedLanes &&
    !budgetFilledLanes &&
    repairs.remaining === 0;
  return {
    component: "hip4-local-sync",
    venue: "polymarket",
    database: LOCAL_DATABASE,
    complete,
    partial: !complete,
    resumable: !catalog.offsetCapReached,
    rerunnable: true,
    pageBudget: {
      perHotLane: options.maxPages,
      hotLanes: 4,
      catalogRequests: options.maxPages,
    },
    hot: {
      processedEvents: hot.processedEvents,
      processedMarkets: hot.processedMarkets,
      pages: hot.pages,
      failedLanes,
      budgetFilledLanes,
      lanes,
    },
    catalog: {
      checkpoint: {
        phase: catalog.checkpoint.phase,
        offset: catalog.checkpoint.offset,
      },
      checkpointComplete: catalogCheckpointComplete,
      unfinished: catalog.unfinished,
      offsetCapReached: catalog.offsetCapReached,
      pages: catalog.pages,
      received: catalog.received,
      processedEvents: catalog.processedEvents,
      processedMarkets: catalog.processedMarkets,
      skippedEvents: catalog.skippedEvents,
    },
    repairs: {
      requested: repairs.requested,
      processed: repairs.processed,
      remaining: repairs.remaining,
      missingEvents: repairs.missingIds.length,
      failedEvents: repairs.failedIds.length,
    },
    advice: catalog.offsetCapReached
      ? "The production Gamma offset cap was reached; do not reset Redis or claim full coverage. Hot refresh and live indexers remain useful."
      : "Rerun this command to resume the existing production V2 checkpoint and refresh current markets. A partial catalog is not a startup blocker; keep local Redis to retain progress.",
  };
}

function limitlessSummary(options, result) {
  const processingFailedEvents = Math.max(
    0,
    result.coverage.uniqueMarkets - result.eventCount,
  );
  const complete = result.coverage.complete && processingFailedEvents === 0;
  return {
    component: "hip4-local-sync",
    venue: "limitless",
    database: LOCAL_DATABASE,
    complete,
    partial: !complete,
    resumable: false,
    rerunnable: true,
    pageBudget: options.maxPages,
    processedEvents: result.eventCount,
    processedMarkets: result.marketCount,
    processingFailedEvents,
    coverage: result.coverage,
    advice:
      "The production Limitless bootstrap starts at the newest page each time; it does not persist a catalog cursor. Rerun to retry errors, or use a larger --max-pages for capReached. Partial catalog coverage does not block local startup.",
  };
}

export async function runLocalCatalogSync(options, dependencies = {}) {
  validateSyncEnvironment(options, dependencies.environment ?? process.env);
  const modules = await (dependencies.loadModules ?? loadProductionModules)(
    options.venue,
  );
  try {
    if (options.venue === "limitless")
      return limitlessSummary(
        options,
        await modules.bootstrap.bootstrapLimitless(),
      );
    // These are the production upsert/mapping/public-read paths, not copied seed
    // data or a test allowlist. Each hot lane and V2 pass has the explicit budget.
    const hot = await modules.bootstrap.syncHotWindow();
    const catalog = await modules.bootstrap.syncV2CatchUp();
    const repairs = await modules.bootstrap.syncGammaEventRepairs();
    return polymarketSummary(options, hot, catalog, repairs);
  } finally {
    await closeResources(modules);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runLocalCatalogSync(parseSyncArguments(argv));
  console.log(JSON.stringify(result, null, 2));
  // Partial derived coverage is a visible, recoverable result, not a guard that
  // prevents starting the manual local stack. Provider/DB failures still throw.
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch(() => {
    console.error(
      "Local catalog sync failed; verify local targets, built indexers and public-provider availability. No credentials or raw errors are printed.",
    );
    process.exitCode = 1;
  });
}
