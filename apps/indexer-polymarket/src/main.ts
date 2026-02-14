import {
  selectHotTokenIds,
  selectWsTokenIds,
  snapshotBooks,
  syncCatchUpFromCursor,
  syncHotEventStatuses,
  syncHotWindow,
} from "./bootstrap.js";
import { startMarketWS, updateMarketWSSubscriptions } from "./wsMarket.js";
import { log } from "./log.js";
import { formatPgError, isPgSetupIssue } from "@hunch/infra";
import { env } from "./env.js";

let running = false;
let wsStarted = false;
let wsRefreshRunning = false;

async function periodicBootstrap() {
  if (running) return; // skip if one is running
  running = true;
  try {
    await syncHotWindow();
    await syncHotEventStatuses();
    if (wsStarted) {
      const hotTokenIds = await selectHotTokenIds();
      log.info("Polymarket hot refresh snapshot", {
        hotTokens: hotTokenIds.length,
      });
      if (hotTokenIds.length > 0) await snapshotBooks(hotTokenIds);
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

async function periodicWsRefresh() {
  if (wsRefreshRunning) return;
  wsRefreshRunning = true;
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
      return;
    }
    if (wsStarted) updateMarketWSSubscriptions(tokenIds);
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

async function main() {
  await periodicBootstrap();
  await periodicWsRefresh();
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
