import { formatPgError, isPgSetupIssue } from "@hunch/infra";

import {
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
let bootstrapRuns = 0;

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
    const tickers = await resolveHotTickersForWs();
    updateMarketWSSubscriptions(tickers);
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

async function main() {
  await periodicBootstrap();
  const tickers = await resolveHotTickersForWs();
  startMarketWS(tickers);

  void syncCatchUpFromCursor().catch((e) => {
    if (isPgSetupIssue(e)) {
      log.warn(`catch-up blocked: ${formatPgError(e)}`);
      log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    } else {
      log.warn("catch-up err", e);
    }
  });

  setInterval(periodicBootstrap, env.refreshMinutes * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
