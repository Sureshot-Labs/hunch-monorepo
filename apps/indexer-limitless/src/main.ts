import {
  bootstrapLimitless,
  resolveHotSlugsForWs,
  syncHotLimitlessMarkets,
} from "./bootstrap.js";
import { log } from "./log.js";
import { formatPgError, isPgSetupIssue } from "@hunch/infra";
import { env } from "./env.js";
import { startMarketWS, updateMarketWSSubscriptions } from "./wsMarket.js";

let bootstrapping = false;

async function periodicBootstrap() {
  if (bootstrapping) return; // skip if one is running
  bootstrapping = true;
  try {
    await bootstrapLimitless();
    await syncHotLimitlessMarkets();
    const slugs = await resolveHotSlugsForWs();
    updateMarketWSSubscriptions(slugs);
  } catch (e) {
    if (isPgSetupIssue(e)) {
      log.warn(`bootstrap blocked: ${formatPgError(e)}`);
      log.warn("Start infra with `pnpm infra:up` and run `pnpm migrate`.");
    } else {
      log.warn("periodic bootstrap err", e);
    }
  } finally {
    bootstrapping = false;
  }
}

async function main() {
  if (!env.limitlessEnabled) {
    log.warn("Limitless indexer disabled (LIMITLESS_ENABLED=false)");
    return;
  }

  await periodicBootstrap();
  const slugs = await resolveHotSlugsForWs();
  startMarketWS(slugs);
  // Keep refreshing background data every 5 minutes to catch new/changed markets.
  setInterval(periodicBootstrap, env.refreshMinutes * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
