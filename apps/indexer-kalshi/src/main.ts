import { bootstrapKalshi } from "./bootstrap.js";
import { startMarketWS, updateMarketWSSubscriptions } from "./wsMarket.js";
import { log } from "./log.js";
import { env } from "./env.js";
import { formatPgError, isPgSetupIssue } from "@hunch/infra";

let bootstrapping = false;
let wsStarted = false;

async function bootstrapAndMaybeStartWs() {
  const tickers = await bootstrapKalshi();
  if (!wsStarted && tickers.length > 0) {
    startMarketWS(tickers);
    wsStarted = true;
  } else if (wsStarted) {
    updateMarketWSSubscriptions(tickers);
  }
}

async function periodicBootstrap() {
  if (bootstrapping) return; // skip if one is running
  bootstrapping = true;
  try {
    await bootstrapAndMaybeStartWs();
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
  if (env.kalshiEnabledSetting === true && !env.kalshiConfigured) {
    log.err(
      `Kalshi indexer enabled but not configured: ${env.kalshiIssues.join("; ")}`,
    );
    process.exit(1);
  }

  if (!env.kalshiEnabled) {
    const extra =
      env.kalshiIssues.length > 0 ? ` (${env.kalshiIssues.join("; ")})` : "";
    log.warn(`Kalshi indexer disabled${extra}`);
    log.warn(
      "Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH in ../../.env (and ensure the key file exists) to enable.",
    );
    return;
  }

  await periodicBootstrap();
  // 3) Keep refreshing background data every 5 minutes to catch new/changed markets.
  setInterval(periodicBootstrap, 10 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
