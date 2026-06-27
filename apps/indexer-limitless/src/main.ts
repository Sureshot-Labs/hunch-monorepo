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
  diffLimitlessWsDemandEventStats,
  getLimitlessWsDemandEventStats,
  resubscribeMarketWSSubscriptions,
  startMarketWS,
  updateMarketWSSubscriptions,
} from "./wsMarket.js";

let fullBootstrapping = false;
let hotRefreshing = false;
let wsRefreshRunning = false;
let priceRefreshRunning = false;

type PriceRefreshResult = Awaited<ReturnType<typeof processPriceRefreshQueue>>;
type PriceRefreshAggregate = {
  claimed: number;
  refreshed: number;
  failed: number;
  backlog: number;
  freshSkipped: number;
  stale: number;
  marketRefreshed: number;
  topRefreshed: number;
  httpFallback: number;
  wsDemandRequested: number;
  wsDemandFilled: number;
  resolvedTopUpdated: number;
  resolvedEventsHandled: number;
  derivedSiblingTopUpdated: number;
  derivedSiblingTopSkippedRecentDirect: number;
  wsDemandTargetsByTradeType: Record<string, number>;
  wsDemandTokensByTradeType: Record<string, number>;
  wsDemandFilledByTradeType: Record<string, number>;
  wsDemandStillStaleByTradeType: Record<string, number>;
  httpFallbackByTradeType: Record<string, number>;
  httpFallbackReasons: Record<string, number>;
  httpFallbackNoTopSamples: NonNullable<
    PriceRefreshResult["httpFallbackNoTopSamples"]
  >;
  claimedBySide: { oldest: number; newest: number };
};

function mergeCountRecords(
  left: Record<string, number>,
  right: Record<string, number> | undefined,
): Record<string, number> {
  const out = { ...left };
  for (const [key, value] of Object.entries(right ?? {})) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

function noTopSampleKey(
  sample: NonNullable<PriceRefreshResult["httpFallbackNoTopSamples"]>[number],
): string {
  return `${sample.marketId}:${sample.reason}`;
}

function mergeNoTopSamples(
  left: NonNullable<PriceRefreshResult["httpFallbackNoTopSamples"]>,
  right: PriceRefreshResult["httpFallbackNoTopSamples"],
): NonNullable<PriceRefreshResult["httpFallbackNoTopSamples"]> {
  const out = [...left];
  const seen = new Set(out.map(noTopSampleKey));
  for (const sample of right ?? []) {
    const key = noTopSampleKey(sample);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sample);
    if (out.length >= 3) break;
  }
  return out;
}

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
  return results.reduce<PriceRefreshAggregate>(
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
      wsDemandRequested:
        acc.wsDemandRequested + (result.wsDemandRequested ?? 0),
      wsDemandFilled: acc.wsDemandFilled + (result.wsDemandFilled ?? 0),
      resolvedTopUpdated:
        acc.resolvedTopUpdated + (result.resolvedTopUpdated ?? 0),
      resolvedEventsHandled:
        acc.resolvedEventsHandled + (result.resolvedEventsHandled ?? 0),
      derivedSiblingTopUpdated:
        acc.derivedSiblingTopUpdated +
        (result.derivedSiblingTopUpdated ?? 0),
      derivedSiblingTopSkippedRecentDirect:
        acc.derivedSiblingTopSkippedRecentDirect +
        (result.derivedSiblingTopSkippedRecentDirect ?? 0),
      wsDemandTargetsByTradeType: mergeCountRecords(
        acc.wsDemandTargetsByTradeType,
        result.wsDemandTargetsByTradeType,
      ),
      wsDemandTokensByTradeType: mergeCountRecords(
        acc.wsDemandTokensByTradeType,
        result.wsDemandTokensByTradeType,
      ),
      wsDemandFilledByTradeType: mergeCountRecords(
        acc.wsDemandFilledByTradeType,
        result.wsDemandFilledByTradeType,
      ),
      wsDemandStillStaleByTradeType: mergeCountRecords(
        acc.wsDemandStillStaleByTradeType,
        result.wsDemandStillStaleByTradeType,
      ),
      httpFallbackByTradeType: mergeCountRecords(
        acc.httpFallbackByTradeType,
        result.httpFallbackByTradeType,
      ),
      httpFallbackReasons: mergeCountRecords(
        acc.httpFallbackReasons,
        result.httpFallbackReasons,
      ),
      httpFallbackNoTopSamples: mergeNoTopSamples(
        acc.httpFallbackNoTopSamples,
        result.httpFallbackNoTopSamples,
      ),
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
      wsDemandRequested: 0,
      wsDemandFilled: 0,
      resolvedTopUpdated: 0,
      resolvedEventsHandled: 0,
      derivedSiblingTopUpdated: 0,
      derivedSiblingTopSkippedRecentDirect: 0,
      wsDemandTargetsByTradeType: {},
      wsDemandTokensByTradeType: {},
      wsDemandFilledByTradeType: {},
      wsDemandStillStaleByTradeType: {},
      httpFallbackByTradeType: {},
      httpFallbackReasons: {},
      httpFallbackNoTopSamples: [],
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
      resolvedTopUpdated: marketResult.resolvedTopUpdated,
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
        resolvedTopUpdated: marketResult.resolvedTopUpdated,
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
    const wsDemandEventStatsBefore = getLimitlessWsDemandEventStats();
    const results = await Promise.all(
      Array.from({ length: consumers }, (_, consumerIndex) =>
        processPriceRefreshQueue({
          side: priceRefreshSideForConsumer(consumerIndex),
          logSuccess: false,
        }),
      ),
    );
    const aggregate = aggregatePriceRefreshResults(results);
    const wsDemandEvents = diffLimitlessWsDemandEventStats(
      wsDemandEventStatsBefore,
    );
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
        freshSkipped: aggregate.freshSkipped,
        stale: aggregate.stale,
        refreshed: aggregate.refreshed,
        marketRefreshed: aggregate.marketRefreshed,
        topRefreshed: aggregate.topRefreshed,
        httpFallback: aggregate.httpFallback,
        wsDemandRequested: aggregate.wsDemandRequested,
        wsDemandFilled: aggregate.wsDemandFilled,
        resolvedTopUpdated: aggregate.resolvedTopUpdated,
        resolvedEventsHandled: aggregate.resolvedEventsHandled,
        derivedSiblingTopUpdated: aggregate.derivedSiblingTopUpdated,
        derivedSiblingTopSkippedRecentDirect:
          aggregate.derivedSiblingTopSkippedRecentDirect,
        wsDemandTargetsByTradeType: aggregate.wsDemandTargetsByTradeType,
        wsDemandTokensByTradeType: aggregate.wsDemandTokensByTradeType,
        wsDemandFilledByTradeType: aggregate.wsDemandFilledByTradeType,
        wsDemandStillStaleByTradeType:
          aggregate.wsDemandStillStaleByTradeType,
        wsDemandEvents,
        httpFallbackByTradeType: aggregate.httpFallbackByTradeType,
        httpFallbackReasons: aggregate.httpFallbackReasons,
        httpFallbackNoTopSamples: aggregate.httpFallbackNoTopSamples,
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
        wsDemandEvents,
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
