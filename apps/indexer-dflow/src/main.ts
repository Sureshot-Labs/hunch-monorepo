import { formatPgError, isPgSetupIssue } from "@hunch/infra";

import {
  processPriceRefreshQueue,
  syncCatchUpFromCursor,
  syncHotMarketStatuses,
  syncHotWindow,
  syncNonActiveSweep,
  syncRecentTrades,
  resolveHotTickersForWs,
} from "./bootstrap.js";
import { env } from "./env.js";
import { log } from "./log.js";
import { startMarketWS, updateMarketWSSubscriptions } from "./wsMarket.js";

let running = false;
let wsRefreshRunning = false;
let wsStarted = false;
let bootstrapRuns = 0;
let priceRefreshRunning = false;

async function periodicBootstrap() {
  if (running) return;
  running = true;
  const runNo = bootstrapRuns;
  bootstrapRuns += 1;
  try {
    await syncHotWindow();
    await syncHotMarketStatuses();
    if (env.nonActiveSweepEnabled && runNo % env.nonActiveSweepEvery === 0) {
      await syncNonActiveSweep();
    }
    await syncRecentTrades();
  } catch (e) {
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
  try {
    const tickers = await resolveHotTickersForWs();
    if (!wsStarted && tickers.length > 0) {
      const ws = startMarketWS(tickers);
      wsStarted = ws != null;
      return;
    }
    updateMarketWSSubscriptions(tickers);
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
  await periodicBootstrap();
  await periodicPriceRefresh();
  const tickers = await resolveHotTickersForWs();
  const ws = startMarketWS(tickers);
  wsStarted = ws != null;

  void syncCatchUpFromCursor().catch((e) => {
    if (isPgSetupIssue(e)) {
      log.warn(`catch-up blocked: ${formatPgError(e)}`);
      log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    } else {
      log.warn("catch-up err", e);
    }
  });

  setInterval(periodicBootstrap, env.refreshMinutes * 60 * 1000);
  setInterval(periodicWsRefresh, env.wsRefreshSec * 1000);
  setInterval(periodicPriceRefresh, env.priceRefreshQueueIntervalMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
