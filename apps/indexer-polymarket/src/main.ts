import {
  processPriceRefreshQueue,
  selectHotTokenIds,
  selectWsTokenIds,
  snapshotBooks,
  syncCatchUpFromCursor,
  syncHotEventStatuses,
  syncHotWindow,
} from "./bootstrap.js";
import { startMarketWS, updateMarketWSSubscriptions } from "./wsMarket.js";
import { log } from "./log.js";
import {
  formatPgError,
  isPgSetupIssue,
  updateIndexerStats,
} from "@hunch/infra";
import { env } from "./env.js";
import { ensureRedis, redis } from "./redis.js";

let running = false;
let wsStarted = false;
let wsRefreshRunning = false;
let priceRefreshRunning = false;

type PriceRefreshResult = Awaited<ReturnType<typeof processPriceRefreshQueue>>;

async function writeStats(
  patch: Parameters<typeof updateIndexerStats>[2],
): Promise<void> {
  try {
    await ensureRedis();
    await updateIndexerStats(redis, "polymarket", patch);
  } catch (error) {
    log.warn("Polymarket indexer stats update failed", { error });
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
      marketRefreshed:
        acc.marketRefreshed + (result.marketRefreshed ?? 0),
      topRefreshed: acc.topRefreshed + (result.topRefreshed ?? 0),
      httpFallback: acc.httpFallback + (result.httpFallback ?? 0),
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
      claimedBySide: { oldest: 0, newest: 0 },
    },
  );
}

function priceRefreshSideForConsumer(index: number): "oldest" | "newest" {
  return index % 2 === 0 ? "oldest" : "newest";
}

async function periodicBootstrap() {
  if (running) return; // skip if one is running
  running = true;
  const startedAt = Date.now();
  try {
    const hot = await syncHotWindow();
    await syncHotEventStatuses();
    if (wsStarted) {
      const hotTokenIds = await selectHotTokenIds();
      log.info("Polymarket hot refresh snapshot", {
        hotTokens: hotTokenIds.length,
      });
      if (hotTokenIds.length > 0) await snapshotBooks(hotTokenIds);
    }
    await writeStats({
      hotRefresh: {
        lastRunAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        processedEvents: hot.processedEvents,
        processedMarkets: hot.processedMarkets,
        pages: hot.pages,
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
    const tokenIds = await selectWsTokenIds();
    if (!wsStarted && tokenIds.length > 0) {
      const hotTokenIds = await selectHotTokenIds();
      const combined =
        hotTokenIds.length > 0
          ? Array.from(new Set([...hotTokenIds, ...tokenIds]))
          : tokenIds;
      log.info("Polymarket bootstrap snapshot", {
        wsTokens: tokenIds.length,
        hotTokens: hotTokenIds.length,
        snapshotTokens: combined.length,
      });
      await snapshotBooks(combined);
      startMarketWS(tokenIds);
      wsStarted = true;
      await writeStats({
        ws: {
          lastSyncAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          desiredTokens: tokenIds.length,
          hotTokens: hotTokenIds.length,
          snapshotTokens: combined.length,
          started: true,
        },
        lastError: null,
      });
      return;
    }
    if (wsStarted) updateMarketWSSubscriptions(tokenIds);
    await writeStats({
      ws: {
        lastSyncAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        desiredTokens: tokenIds.length,
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
    const consumers = env.priceRefreshQueueConsumers;
    const results = await Promise.all(
      Array.from({ length: consumers }, (_, consumerIndex) =>
        processPriceRefreshQueue({
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
      log.info("Polymarket price refresh queue wave processed", {
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
  void periodicBootstrap();
  void periodicPriceRefresh();
  void periodicWsRefresh();
  void syncCatchUpFromCursor().catch((e) => {
    if (isPgSetupIssue(e)) {
      log.warn(`catch-up blocked: ${formatPgError(e)}`);
      log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    } else {
      log.warn("catch-up err", e);
    }
  });

  // Keep refreshing background data to catch new/changed markets.
  setInterval(periodicBootstrap, env.refreshMinutes * 60 * 1000);
  // Refresh WS desired subscriptions independently from HTTP refresh cadence.
  setInterval(periodicWsRefresh, env.wsRefreshSec * 1000);
  setInterval(periodicPriceRefresh, env.priceRefreshQueueIntervalMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
