import { bootstrapKalshi } from "./bootstrap";
import { startMarketWS } from "./wsMarket";
import { log } from "../../indexer-polymarket/src/log";

let bootstrapping = false;

async function periodicBootstrap() {
  if (bootstrapping) return; // skip if one is running
  bootstrapping = true;
  try {
    await bootstrapKalshi();
  } catch (e) {
    log.warn("periodic bootstrap err", e);
  } finally {
    bootstrapping = false;
  }
}

async function main() {
  // 1) Initial bootstrap: get the list of markets/token IDs and prep any caches.
  const tokenIds = await bootstrapKalshi();
  // 2) Start streaming updates for those markets. Should handle reconnects internally.
  startMarketWS(tokenIds);
  // 3) Keep refreshing background data every 5 minutes to catch new/changed markets.
  setInterval(periodicBootstrap, 5 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
