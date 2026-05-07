import { HyperliquidClient } from "./hyperliquid-client.js";
import {
  dryRunHyperliquidTopBooks,
  fetchHotHyperliquidTokenIds,
  selectHyperliquidBookTargets,
  selectHyperliquidBookTargetsFromDb,
  syncHyperliquidMetadata,
  syncHyperliquidTopBooks,
} from "./bootstrap.js";
import { env } from "./env.js";
import { log } from "./log.js";
import {
  startHyperliquidMarketWS,
  updateHyperliquidMarketWSSubscriptions,
} from "./wsMarket.js";
import type { HyperliquidMappedSnapshot, HyperliquidNetwork } from "./types.js";

function readFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function readNetwork(): HyperliquidNetwork {
  const raw = readArg("--network");
  return raw === "testnet" ? "testnet" : "mainnet";
}

function infoUrlForNetwork(network: HyperliquidNetwork): string {
  return network === "testnet" ? env.testnetInfoUrl : env.mainnetInfoUrl;
}

function wsUrlForNetwork(network: HyperliquidNetwork): string {
  return network === "testnet" ? env.testnetWsUrl : env.mainnetWsUrl;
}

function makeClient(network: HyperliquidNetwork): HyperliquidClient {
  return new HyperliquidClient({
    infoUrl: infoUrlForNetwork(network),
    timeoutMs: env.requestTimeoutMs,
  });
}

async function idleForever(): Promise<never> {
  setInterval(() => undefined, 60 * 60 * 1000);
  return new Promise<never>(() => undefined);
}

let latestSnapshot: HyperliquidMappedSnapshot | null = null;
let metadataRunning = false;
let wsRefreshRunning = false;
let wsStarted = false;

async function loadDbAndRedis() {
  const [{ pool }, { ensureRedis, redis }] = await Promise.all([
    import("./db.js"),
    import("./redis.js"),
  ]);
  await ensureRedis();
  return { pool, redis };
}

async function safeFetchHotTokenIds(
  redis: Awaited<ReturnType<typeof loadDbAndRedis>>["redis"],
): Promise<string[]> {
  try {
    return await fetchHotHyperliquidTokenIds({
      redis,
      hotTokensMax: env.hotTokensMax,
      hotTokensTtlSec: env.hotTokensTtlSec,
      hotStreamTokensMax: env.hotStreamTokensMax,
      hotStreamTokensTtlSec: env.hotStreamTokensTtlSec,
    });
  } catch (error) {
    log.warn(
      "Hyperliquid hot-token lookup failed; falling back to rolling volume",
      error,
    );
    return [];
  }
}

async function refreshWsSubscriptions(params: {
  network: HyperliquidNetwork;
}): Promise<void> {
  if (!env.writeDb || !env.syncTopBooks) return;
  if (wsRefreshRunning) return;
  wsRefreshRunning = true;
  try {
    const { pool, redis } = await loadDbAndRedis();
    const hotTokenIds = await safeFetchHotTokenIds(redis);
    let targets =
      latestSnapshot != null
        ? selectHyperliquidBookTargets({
            snapshot: latestSnapshot,
            hotTokenIds,
            maxTokens: env.maxTopBookSyncTokens,
          })
        : [];
    if (targets.length === 0) {
      targets = await selectHyperliquidBookTargetsFromDb({
        pool,
        hotTokenIds,
        maxTokens: env.maxTopBookSyncTokens,
      });
    }
    if (targets.length === 0) {
      log.warn("Hyperliquid WS refresh skipped: no bbo targets");
      return;
    }
    if (!wsStarted) {
      const ws = startHyperliquidMarketWS({
        wsUrl: wsUrlForNetwork(params.network),
        pool,
        redis,
        targets,
      });
      wsStarted = ws != null;
      return;
    }
    updateHyperliquidMarketWSSubscriptions(targets);
  } catch (error) {
    log.warn("periodic Hyperliquid WS refresh failed", error);
  } finally {
    wsRefreshRunning = false;
  }
}

async function runOnce(params: {
  fixtureDir?: string;
  dryRun: boolean;
  network: HyperliquidNetwork;
  topBookDryRun: boolean;
}) {
  const shouldWrite = !params.dryRun && env.writeDb;
  const pool = shouldWrite ? (await import("./db.js")).pool : undefined;
  const client =
    params.fixtureDir != null ? undefined : makeClient(params.network);
  const snapshot = await syncHyperliquidMetadata({
    client,
    fixtureDir: params.fixtureDir,
    pool,
    network: params.network,
    dryRun: !shouldWrite,
  });
  latestSnapshot = snapshot;

  if (params.topBookDryRun && client) {
    const topResult = await dryRunHyperliquidTopBooks({
      client,
      snapshot,
      maxTokens: env.maxTopBookSyncTokens,
      concurrency: env.topBookSyncConcurrency,
    });
    log.info("Hyperliquid top-book dry-run complete", topResult);
  }

  if (shouldWrite && env.syncTopBooks && !params.fixtureDir && client && pool) {
    const { redis } = await loadDbAndRedis();
    const hotTokenIds = await safeFetchHotTokenIds(redis);
    const topResult = await syncHyperliquidTopBooks({
      client,
      pool,
      redis,
      snapshot,
      hotTokenIds,
      maxTokens: env.maxTopBookSyncTokens,
      concurrency: env.topBookSyncConcurrency,
    });
    log.info("Hyperliquid top-book sync complete", topResult);
    await refreshWsSubscriptions({ network: params.network });
  }

  log.info("Hyperliquid metadata sync complete", {
    dryRun: !shouldWrite,
    network: params.network,
    diagnostics: snapshot.diagnostics,
  });
}

async function periodicRun(params: {
  fixtureDir?: string;
  dryRun: boolean;
  network: HyperliquidNetwork;
  topBookDryRun: boolean;
}) {
  if (metadataRunning) return;
  metadataRunning = true;
  try {
    await runOnce(params);
  } finally {
    metadataRunning = false;
  }
}

async function main() {
  const fixtureDir = readArg("--fixture-dir");
  const topBookDryRun = readFlag("--dry-run-top-books");
  const dryRun = readFlag("--dry-run") || topBookDryRun || fixtureDir != null;
  const watch = readFlag("--watch");
  const once = readFlag("--once") || fixtureDir != null || (dryRun && !watch);
  const network = readNetwork();

  if (!fixtureDir && !env.hyperliquidEnabled) {
    log.warn("Hyperliquid indexer disabled (HYPERLIQUID_ENABLED=false)");
    await idleForever();
  }

  if (!fixtureDir && !env.writeDb && !dryRun) {
    log.warn(
      "Hyperliquid DB writes disabled; use --dry-run for one-shot diagnostics or set HYPERLIQUID_WRITE_DB=true",
    );
    await idleForever();
  }

  try {
    await periodicRun({ fixtureDir, dryRun, network, topBookDryRun });
  } catch (error) {
    if (once) throw error;
    log.warn(
      "initial Hyperliquid metadata sync failed; continuing with DB-backed WS fallback",
      error,
    );
    await refreshWsSubscriptions({ network });
  }
  if (once) return;

  setInterval(() => {
    void periodicRun({
      dryRun,
      network,
      topBookDryRun,
    }).catch((error) => {
      log.warn("periodic Hyperliquid metadata sync failed", error);
    });
  }, env.refreshSec * 1000);
  if (env.writeDb && env.syncTopBooks) {
    setInterval(() => {
      void refreshWsSubscriptions({ network });
    }, env.wsRefreshSec * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
