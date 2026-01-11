import { formatPgError, isPgSetupIssue } from "@hunch/infra";

import {
  syncCatchUpFromCursor,
  syncHotMarketStatuses,
  syncHotWindow,
  syncRecentTrades,
  resolveHotTickersForWs,
} from "./bootstrap";
import { env } from "./env";
import { log } from "./log";
import { startMarketWS, updateMarketWSSubscriptions } from "./wsMarket";

let running = false;

async function periodicBootstrap() {
  if (running) return;
  running = true;
  try {
    await syncHotWindow();
    await syncHotMarketStatuses();
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
