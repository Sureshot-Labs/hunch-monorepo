import {
  formatPgError,
  isPgSetupIssue,
  updateIndexerStats,
} from "@hunch/infra";

import {
  loadDflowMaintenanceTargets,
  processPriceRefreshQueue,
  syncCatchUpFromCursor,
  syncHotMarketStatuses,
  syncHotWindow,
  syncNonActiveSweep,
  syncRecentTrades,
  syncDflowMaintenanceTargets,
  resolveHotTickersForWs,
} from "./bootstrap.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { log } from "./log.js";
import { ensureRedis, redis } from "./redis.js";
import {
  startMarketWS,
  stopMarketWS,
  updateMarketWSSubscriptions,
} from "./wsMarket.js";
import {
  resolveDflowRuntimeMode,
  type DflowRuntimeMode,
} from "./runtime-mode.js";

let running = false;
let wsRefreshRunning = false;
let wsStarted = false;
let bootstrapRuns = 0;
let priceRefreshRunning = false;
let lastMode: DflowRuntimeMode["mode"] | null = null;
let lastModeTransitionAt: string | null = null;
let catchupRevision: string | null = null;

type PriceRefreshResult = Awaited<ReturnType<typeof processPriceRefreshQueue>>;

async function writeStats(
  patch: Parameters<typeof updateIndexerStats>[2],
): Promise<void> {
  try {
    await ensureRedis();
    await updateIndexerStats(redis, "dflow", patch);
  } catch (error) {
    log.warn("DFlow indexer stats update failed", { error });
  }
}

function aggregatePriceRefreshResults(results: PriceRefreshResult[]) {
  return results.reduce(
    (acc, result) => ({
      claimed: acc.claimed + result.claimed,
      refreshed: acc.refreshed + result.refreshed,
      failed: acc.failed + result.failed,
      backlog: Math.max(acc.backlog, result.backlog),
      freshSkipped: acc.freshSkipped + (result.freshSkipped ?? 0),
      stale: acc.stale + (result.stale ?? 0),
      marketRefreshed: acc.marketRefreshed + (result.marketRefreshed ?? 0),
      topRefreshed: acc.topRefreshed + (result.topRefreshed ?? 0),
      httpFallback: acc.httpFallback + (result.httpFallback ?? 0),
      policySkipped: acc.policySkipped + (result.policySkipped ?? 0),
      claimedBySide: {
        oldest:
          acc.claimedBySide.oldest +
          (result.side === "oldest" ? result.claimed : 0),
        newest:
          acc.claimedBySide.newest +
          (result.side === "newest" ? result.claimed : 0),
      },
    }),
    {
      claimed: 0,
      refreshed: 0,
      failed: 0,
      backlog: 0,
      freshSkipped: 0,
      stale: 0,
      marketRefreshed: 0,
      topRefreshed: 0,
      httpFallback: 0,
      policySkipped: 0,
      claimedBySide: { oldest: 0, newest: 0 },
    },
  );
}

async function readRuntimeMode(): Promise<DflowRuntimeMode> {
  const runtime = await resolveDflowRuntimeMode(pool, {
    dflowEnabled: env.dflowEnabled,
  });
  if (lastMode !== runtime.mode) {
    lastMode = runtime.mode;
    lastModeTransitionAt = new Date().toISOString();
    log.info("DFlow lifecycle mode changed", {
      mode: runtime.mode,
      revision: runtime.revision,
      source: runtime.source,
    });
  }
  return runtime;
}

async function writeLifecycleStats(runtime: DflowRuntimeMode): Promise<void> {
  await writeStats({
    lifecycle: {
      mode: runtime.mode,
      source: runtime.source,
      policyRevision: runtime.revision,
      lastModeTransition: lastModeTransitionAt,
    },
  });
}

function ensureFullCatchup(runtime: DflowRuntimeMode): void {
  if (runtime.mode !== "full" || catchupRevision === runtime.revision) return;
  catchupRevision = runtime.revision;
  void syncCatchUpFromCursor().catch((e) => {
    catchupRevision = null;
    if (isPgSetupIssue(e)) {
      log.warn(`catch-up blocked: ${formatPgError(e)}`);
      log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    } else {
      log.warn("catch-up err", e);
    }
  });
}

function priceRefreshSideForConsumer(index: number): "oldest" | "newest" {
  return index % 2 === 0 ? "oldest" : "newest";
}

async function periodicBootstrap() {
  if (running) return;
  running = true;
  const runNo = bootstrapRuns;
  bootstrapRuns += 1;
  const startedAt = Date.now();
  try {
    const runtime = await readRuntimeMode();
    await writeLifecycleStats(runtime);
    if (runtime.mode === "off") {
      stopMarketWS();
      wsStarted = false;
      return;
    }
    if (runtime.mode === "maintenance") {
      const targets = await loadDflowMaintenanceTargets();
      const maintenance = await syncDflowMaintenanceTargets(targets);
      await writeStats({
        maintenance: {
          lastSuccessfulMaintenance: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          targetCount: targets.marketIds.length,
          targetCountByReason: targets.reasons,
          targetTickers: targets.tickers.length,
          targetTokens: targets.tokenIds.length,
          blockedNewMarkets: maintenance.blockedNewMarkets,
          processedMarkets: maintenance.processedMarkets,
          publishedTokenTops: maintenance.publishedTokenTops,
          tradeCount: maintenance.tradeCount,
        },
        lastError: null,
      });
      return;
    }
    ensureFullCatchup(runtime);
    const hot = await syncHotWindow();
    const status = await syncHotMarketStatuses();
    if (env.nonActiveSweepEnabled && runNo % env.nonActiveSweepEvery === 0) {
      await syncNonActiveSweep();
    }
    await syncRecentTrades();
    await writeStats({
      hotRefresh: {
        lastRunAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        processedEvents: hot.processedEvents,
        processedMarkets: hot.processedMarkets,
        pages: hot.pages,
        publishedMarkets: hot.publishedMarkets,
        statusMarkets: status.processedMarkets,
      },
      lastError: null,
    });
  } catch (e) {
    await writeStats({
      lastError: {
        phase: "hot_refresh",
        message: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      },
    });
    if (isPgSetupIssue(e)) {
      log.warn(`bootstrap blocked: ${formatPgError(e)}`);
      log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    } else {
      log.warn("periodic bootstrap err", e);
    }
  } finally {
    running = false;
  }
}

async function periodicWsRefresh() {
  if (wsRefreshRunning) return;
  wsRefreshRunning = true;
  const startedAt = Date.now();
  try {
    const runtime = await readRuntimeMode();
    await writeLifecycleStats(runtime);
    if (runtime.mode === "off") {
      stopMarketWS();
      wsStarted = false;
      return;
    }
    const tickers =
      runtime.mode === "maintenance"
        ? (await loadDflowMaintenanceTargets()).tickers
        : await resolveHotTickersForWs();
    if (tickers.length === 0) {
      stopMarketWS();
      wsStarted = false;
      return;
    }
    if (!wsStarted && tickers.length > 0) {
      const ws = startMarketWS(tickers);
      wsStarted = ws != null;
      await writeStats({
        ws: {
          lastSyncAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          desiredTickers: tickers.length,
          started: wsStarted,
        },
        lastError: null,
      });
      return;
    }
    updateMarketWSSubscriptions(tickers);
    await writeStats({
      ws: {
        lastSyncAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        desiredTickers: tickers.length,
        started: wsStarted,
      },
      lastError: null,
    });
  } catch (e) {
    await writeStats({
      lastError: {
        phase: "ws_refresh",
        message: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      },
    });
    if (isPgSetupIssue(e)) {
      log.warn(`ws refresh blocked: ${formatPgError(e)}`);
      log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    } else {
      log.warn("periodic ws refresh err", e);
    }
  } finally {
    wsRefreshRunning = false;
  }
}

async function periodicPriceRefresh() {
  if (!env.priceRefreshQueueEnabled || priceRefreshRunning) return;
  priceRefreshRunning = true;
  const startedAt = Date.now();
  try {
    const runtime = await readRuntimeMode();
    await writeLifecycleStats(runtime);
    if (runtime.mode === "off") return;
    const allowedTokenIds =
      runtime.mode === "maintenance"
        ? new Set((await loadDflowMaintenanceTargets()).tokenIds)
        : undefined;
    const consumers = env.priceRefreshQueueConsumers;
    const results = await Promise.all(
      Array.from({ length: consumers }, (_, consumerIndex) =>
        processPriceRefreshQueue({
          allowedTokenIds,
          side: priceRefreshSideForConsumer(consumerIndex),
          logSuccess: false,
        }),
      ),
    );
    const aggregate = aggregatePriceRefreshResults(results);
    const durationMs = Date.now() - startedAt;
    if (
      aggregate.claimed > 0 ||
      aggregate.failed > 0 ||
      aggregate.backlog > 0
    ) {
      log.info("DFlow price refresh queue wave processed", {
        consumers,
        batch: env.priceRefreshQueueBatch,
        claimed: aggregate.claimed,
        claimedBySide: aggregate.claimedBySide,
        freshSkipped: aggregate.freshSkipped,
        stale: aggregate.stale,
        refreshed: aggregate.refreshed,
        marketRefreshed: aggregate.marketRefreshed,
        topRefreshed: aggregate.topRefreshed,
        httpFallback: aggregate.httpFallback,
        policySkipped: aggregate.policySkipped,
        skippedQueueItems: aggregate.policySkipped,
        failed: aggregate.failed,
        backlog: aggregate.backlog,
        durationMs,
      });
    }
    await writeStats({
      priceRefresh: {
        lastRunAt: new Date(startedAt).toISOString(),
        durationMs,
        consumers,
        batch: env.priceRefreshQueueBatch,
        ...aggregate,
        skippedQueueItems: aggregate.policySkipped,
      },
      lastError: null,
    });
  } catch (e) {
    await writeStats({
      lastError: {
        phase: "price_refresh",
        message: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      },
    });
    if (isPgSetupIssue(e)) {
      log.warn(`price refresh blocked: ${formatPgError(e)}`);
      log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    } else {
      log.warn("periodic price refresh err", e);
    }
  } finally {
    priceRefreshRunning = false;
  }
}

async function main() {
  await periodicBootstrap();
  await periodicPriceRefresh();
  await periodicWsRefresh();

  setInterval(periodicBootstrap, env.refreshMinutes * 60 * 1000);
  setInterval(periodicWsRefresh, env.wsRefreshSec * 1000);
  setInterval(periodicPriceRefresh, env.priceRefreshQueueIntervalMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
