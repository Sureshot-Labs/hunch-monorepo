import {
  backfillHotLimitlessAmmPrices,
  bootstrapLimitless,
  ensureStartupWsTargets,
  processPriceRefreshQueue,
  resolveHotWsTargets,
  syncHotLimitlessMarkets,
} from "./bootstrap.js";
import { log } from "./log.js";
import { formatPgError, isPgSetupIssue } from "@hunch/infra";
import { env } from "./env.js";
import {
  resubscribeMarketWSSubscriptions,
  startMarketWS,
  updateMarketWSSubscriptions,
} from "./wsMarket.js";

let fullBootstrapping = false;
let hotRefreshing = false;
let wsRefreshRunning = false;
let priceRefreshRunning = false;

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
  } catch (e) {
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
  } catch (e) {
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
  try {
    const targets = await resolveHotWsTargets();
    updateMarketWSSubscriptions(targets);
  } catch (e) {
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
  try {
    await processPriceRefreshQueue();
  } catch (e) {
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
