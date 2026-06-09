import { HyperliquidClient } from "./hyperliquid-client.js";
import {
  dryRunHyperliquidTopBooks,
  fetchHotHyperliquidTokenIds,
  publishHyperliquidMarketMetadata,
  selectHyperliquidBookTargets,
  selectHyperliquidBookTargetsFromDb,
  syncHyperliquidMetadata,
  syncHyperliquidTopBooks,
} from "./bootstrap.js";
import {
  formatPgError,
  isPgSetupIssue,
  updateIndexerStats,
  type IndexerStatsPatch,
} from "@hunch/infra";
import { env } from "./env.js";
import { log } from "./log.js";
import { parseHyperliquidRunMode } from "./run-mode.js";
import {
  startHyperliquidMarketWS,
  updateHyperliquidMarketWSSubscriptions,
} from "./wsMarket.js";
import type { HyperliquidMappedSnapshot, HyperliquidNetwork } from "./types.js";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logIndexerError(context: string, error: unknown): void {
  if (isPgSetupIssue(error)) {
    log.warn(`${context} blocked: ${formatPgError(error)}`);
    log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    return;
  }
  log.warn(`${context} failed`, error);
}

async function writeStats(patch: IndexerStatsPatch): Promise<void> {
  try {
    const { ensureRedis, redis } = await import("./redis.js");
    await ensureRedis();
    await updateIndexerStats(redis, "hyperliquid", patch);
  } catch (error) {
    log.warn("Hyperliquid indexer stats update failed", { error });
  }
}

async function writeLastError(
  phase: string,
  error: unknown,
): Promise<void> {
  await writeStats({
    lastError: {
      phase,
      message: errorMessage(error),
      at: new Date().toISOString(),
    },
  });
}

async function loadDbAndRedis() {
  const [{ pool }, redis] = await Promise.all([
    import("./db.js"),
    loadRedisOnly(),
  ]);
  return { pool, redis };
}

async function loadRedisOnly() {
  const { ensureRedis, redis } = await import("./redis.js");
  await ensureRedis();
  return redis;
}

async function closeOneShotResources(): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (env.writeDb) {
    tasks.push(import("./db.js").then(({ closePool }) => closePool()));
  }
  if (env.writeDb) {
    tasks.push(import("./redis.js").then(({ closeRedis }) => closeRedis()));
  }

  await Promise.all(
    tasks.map((task) =>
      task.catch((error) => {
        log.warn("Hyperliquid one-shot resource cleanup failed", error);
      }),
    ),
  );
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
  const startedAt = Date.now();
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
      await writeStats({
        ws: {
          lastSyncAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          desiredTokens: 0,
          hotTokens: hotTokenIds.length,
          started: wsStarted,
        },
        lastError: null,
      });
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
      await writeStats({
        ws: {
          lastSyncAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          desiredTokens: targets.length,
          hotTokens: hotTokenIds.length,
          started: wsStarted,
        },
        lastError: null,
      });
      return;
    }
    updateHyperliquidMarketWSSubscriptions(targets);
    await writeStats({
      ws: {
        lastSyncAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        desiredTokens: targets.length,
        hotTokens: hotTokenIds.length,
        started: wsStarted,
      },
      lastError: null,
    });
  } catch (error) {
    await writeLastError("ws_refresh", error);
    logIndexerError("Hyperliquid WS refresh", error);
  } finally {
    wsRefreshRunning = false;
  }
}

async function runOnce(params: {
  fixtureDir?: string;
  dryRun: boolean;
  network: HyperliquidNetwork;
  topBookDryRun: boolean;
  startWs: boolean;
}) {
  const startedAt = Date.now();
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
  let metadataPublish:
    | Awaited<ReturnType<typeof publishHyperliquidMarketMetadata>>
    | undefined;
  let topBookSync:
    | Awaited<ReturnType<typeof syncHyperliquidTopBooks>>
    | undefined;

  let redis: Awaited<ReturnType<typeof loadRedisOnly>> | null = null;
  if (shouldWrite) {
    try {
      redis = await loadRedisOnly();
    } catch (error) {
      await writeLastError("metadata_publish", error);
      logIndexerError("Hyperliquid Redis live publish setup", error);
    }
  }
  if (shouldWrite && redis) {
    try {
      metadataPublish = await publishHyperliquidMarketMetadata({
        redis,
        snapshot,
      });
      log.info("Hyperliquid market metadata publish complete", metadataPublish);
    } catch (error) {
      await writeLastError("metadata_publish", error);
      logIndexerError("Hyperliquid market metadata publish", error);
    }
  }

  if (params.topBookDryRun && client) {
    const topResult = await dryRunHyperliquidTopBooks({
      client,
      snapshot,
      maxTokens: env.maxTopBookSyncTokens,
      concurrency: env.topBookSyncConcurrency,
    });
    log.info("Hyperliquid top-book dry-run complete", topResult);
  }

  if (
    shouldWrite &&
    env.syncTopBooks &&
    !params.fixtureDir &&
    client &&
    pool
  ) {
    redis ??= await loadRedisOnly();
    const hotTokenIds = await safeFetchHotTokenIds(redis);
    topBookSync = await syncHyperliquidTopBooks({
      client,
      pool,
      redis,
      snapshot,
      hotTokenIds,
      maxTokens: env.maxTopBookSyncTokens,
      concurrency: env.topBookSyncConcurrency,
    });
    log.info("Hyperliquid top-book sync complete", topBookSync);
    if (params.startWs) {
      await refreshWsSubscriptions({ network: params.network });
    }
  }

  log.info("Hyperliquid metadata sync complete", {
    dryRun: !shouldWrite,
    network: params.network,
    diagnostics: snapshot.diagnostics,
  });
  if (shouldWrite) {
    await writeStats({
      metadataRefresh: {
        lastRunAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        network: params.network,
        diagnostics: snapshot.diagnostics,
        publishedMarkets: metadataPublish?.markets ?? 0,
        publishedTokens: metadataPublish?.tokens ?? 0,
        publishFailures: metadataPublish?.failed ?? 0,
      },
      ...(topBookSync
        ? {
            topBookSync: {
              lastRunAt: new Date(startedAt).toISOString(),
              ...topBookSync,
            },
          }
        : {}),
      lastError: null,
    });
  }
}

async function periodicRun(params: {
  fixtureDir?: string;
  dryRun: boolean;
  network: HyperliquidNetwork;
  topBookDryRun: boolean;
  startWs: boolean;
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
  const { fixtureDir, topBookDryRun, dryRun, once, network, startWs } =
    parseHyperliquidRunMode(process.argv);

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
    await periodicRun({
      fixtureDir,
      dryRun,
      network,
      topBookDryRun,
      startWs,
    });
  } catch (error) {
    if (once) throw error;
    await writeLastError("metadata_refresh", error);
    logIndexerError("initial Hyperliquid metadata sync", error);
    log.warn("Continuing with DB-backed Hyperliquid WS fallback");
    await refreshWsSubscriptions({ network });
  }
  if (once) {
    await closeOneShotResources();
    return;
  }

  setInterval(() => {
    void periodicRun({
      dryRun,
      network,
      topBookDryRun,
      startWs: true,
    }).catch((error) => {
      void writeLastError("metadata_refresh", error);
      logIndexerError("periodic Hyperliquid metadata sync", error);
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
