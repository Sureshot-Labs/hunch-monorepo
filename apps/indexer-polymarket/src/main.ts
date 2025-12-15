import { bootstrapPolymarket } from "./bootstrap";
import { startMarketWS } from "./wsMarket";
import { log } from "./log";
import { formatPgError, isPgSetupIssue } from "@hunch/infra";

let bootstrapping = false;
let wsStarted = false;

async function bootstrapAndMaybeStartWs() {
  const tokenIds = await bootstrapPolymarket();
  if (!wsStarted && tokenIds.length > 0) {
    startMarketWS(tokenIds);
    wsStarted = true;
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
  await periodicBootstrap();
  // 3) Keep refreshing background data every 5 minutes to catch new/changed markets.
  setInterval(periodicBootstrap, 10 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
