import {
  backfillHotLimitlessAmmPrices,
  bootstrapLimitless,
  ensureStartupWsTargets,
  processPriceRefreshQueue,
  resolveHotWsTargets,
  syncHotLimitlessMarkets,
} from "./bootstrap.js";
import { log } from "./log.js";
import {
  formatPgError,
  isPgSetupIssue,
  updateIndexerStats,
} from "@hunch/infra";
import { env } from "./env.js";
import { ensureRedis, redis } from "./redis.js";
import {
  resubscribeMarketWSSubscriptions,
  startMarketWS,
  updateMarketWSSubscriptions,
} from "./wsMarket.js";

let fullBootstrapping = false;
let hotRefreshing = false;
let wsRefreshRunning = false;
let priceRefreshRunning = false;

type PriceRefreshResult = Awaited<ReturnType<typeof processPriceRefreshQueue>>;

async function writeStats(
  patch: Parameters<typeof updateIndexerStats>[2],
): Promise<void> {
  try {
    await ensureRedis();
    await updateIndexerStats(redis, "limitless", patch);
  } catch (error) {
    log.warn("Limitless indexer stats update failed", { error });
  }
}

function aggregatePriceRefreshResults(results: PriceRefreshResult[]) {
  return results.reduce(
    (acc, result) => ({
      claimed: acc.claimed + result.claimed,
      refreshed: acc.refreshed + result.refreshed,
      failed: acc.failed + result.failed,
      backlog: Math.max(acc.backlog, result.backlog),
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
      claimedBySide: { oldest: 0, newest: 0 },
    },
  );
}

function priceRefreshSideForConsumer(index: number): "oldest" | "newest" {
  return index % 2 === 0 ? "oldest" : "newest";
}

async function periodicHotRefresh() {
  if (hotRefreshing) return;
  hotRefreshing = true;
  const startedAt = Date.now();
  try {
    log.info("Limitless hot refresh started");
    const marketResult = await syncHotLimitlessMarkets();
    const ammResult = await backfillHotLimitlessAmmPrices();
    if (marketResult.processedMarkets > 0) {
      resubscribeMarketWSSubscriptions();
    }
    log.info("Limitless hot refresh finished", {
      markets: marketResult.processedMarkets,
      ammDemandedMarkets: ammResult.demandedMarkets,
      ammScannedMarkets: ammResult.scannedMarkets,
      ammUpdatedMarkets: ammResult.updatedMarkets,
      ammSkippedCooldownMarkets: ammResult.skippedCooldownMarkets,
      durationMs: Date.now() - startedAt,
    });
    await writeStats({
      hotRefresh: {
        lastRunAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        processedMarkets: marketResult.processedMarkets,
        ammDemandedMarkets: ammResult.demandedMarkets,
        ammScannedMarkets: ammResult.scannedMarkets,
        ammUpdatedMarkets: ammResult.updatedMarkets,
        ammSkippedCooldownMarkets: ammResult.skippedCooldownMarkets,
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
      log.warn(`hot refresh blocked: ${formatPgError(e)}`);
      log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    } else {
      log.warn("periodic hot refresh err", e);
    }
  } finally {
    hotRefreshing = false;
  }
}

async function periodicFullBootstrap() {
  if (fullBootstrapping) return;
  fullBootstrapping = true;
  const startedAt = Date.now();
  try {
    log.info("Limitless full bootstrap started");
    await bootstrapLimitless();
    resubscribeMarketWSSubscriptions();
    log.info("Limitless full bootstrap finished", {
      durationMs: Date.now() - startedAt,
    });
    await writeStats({
      hotRefresh: {
        fullBootstrapLastRunAt: new Date(startedAt).toISOString(),
        fullBootstrapDurationMs: Date.now() - startedAt,
      },
      lastError: null,
    });
  } catch (e) {
    await writeStats({
      lastError: {
        phase: "full_bootstrap",
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
    fullBootstrapping = false;
  }
}

async function periodicWsRefresh() {
  if (wsRefreshRunning) return;
  wsRefreshRunning = true;
  const startedAt = Date.now();
  try {
    const targets = await resolveHotWsTargets();
    updateMarketWSSubscriptions(targets);
    await writeStats({
      ws: {
        lastSyncAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        slugs: targets.slugs.length,
        addresses: targets.addresses.length,
        total: targets.slugs.length + targets.addresses.length,
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
      log.info("Limitless price refresh queue wave processed", {
        consumers,
        batch: env.priceRefreshQueueBatch,
        claimed: aggregate.claimed,
        claimedBySide: aggregate.claimedBySide,
        refreshed: aggregate.refreshed,
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
  if (!env.limitlessEnabled) {
    log.warn("Limitless indexer disabled (LIMITLESS_ENABLED=false)");
    return;
  }

  const targets = await ensureStartupWsTargets();
  log.info("Limitless startup: WS targets ready", {
    slugs: targets.slugs.length,
    addresses: targets.addresses.length,
  });
  startMarketWS(targets);
  await periodicPriceRefresh();
  void (async () => {
    log.info("Limitless startup: running initial hot refresh");
    try {
      await periodicHotRefresh();
    } catch (e) {
      if (isPgSetupIssue(e)) {
        log.warn(`hot refresh blocked: ${formatPgError(e)}`);
        log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
      } else {
        log.warn("startup hot refresh err", e);
      }
    }

    log.info("Limitless startup: running initial full bootstrap");
    void periodicFullBootstrap();
  })();
  // Frequent hot refresh for live markets and stream-marked tokens.
  setInterval(periodicHotRefresh, env.refreshMinutes * 60 * 1000);
  // Slower full sweep for completeness and new-market discovery.
  setInterval(periodicFullBootstrap, env.fullRefreshMinutes * 60 * 1000);
  // Refresh WS desired subscriptions independently from HTTP refresh cadence.
  setInterval(periodicWsRefresh, env.wsRefreshSec * 1000);
  setInterval(periodicPriceRefresh, env.priceRefreshQueueIntervalMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
