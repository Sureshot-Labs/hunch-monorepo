import {
  selectWsTokenIds,
  snapshotBooks,
  syncCatchUpFromCursor,
  syncHotWindow,
} from "./bootstrap";
import { startMarketWS, updateMarketWSSubscriptions } from "./wsMarket";
import { log } from "./log";
import { formatPgError, isPgSetupIssue } from "@hunch/infra";
import { env } from "./env";

let running = false;
let wsStarted = false;

async function periodicBootstrap() {
  if (running) return; // skip if one is running
  running = true;
  try {
    await syncHotWindow();
    const tokenIds = await selectWsTokenIds();

    if (!wsStarted && tokenIds.length > 0) {
      await snapshotBooks(tokenIds);
      startMarketWS(tokenIds);
      wsStarted = true;
    } else if (wsStarted) {
      updateMarketWSSubscriptions(tokenIds);
    }
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
