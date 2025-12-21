import {
  selectHotTokenIds,
  selectWsTokenIds,
  snapshotBooks,
  syncCatchUpFromCursor,
  syncHotEventStatuses,
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
    await syncHotEventStatuses();
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
    } else if (wsStarted) {
      updateMarketWSSubscriptions(tokenIds);
      const hotTokenIds = await selectHotTokenIds();
      log.info("Polymarket hot refresh snapshot", {
        wsTokens: tokenIds.length,
        hotTokens: hotTokenIds.length,
      });
      if (hotTokenIds.length > 0) {
        await snapshotBooks(hotTokenIds);
      }
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
