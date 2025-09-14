import { bootstrapPolymarket } from "./bootstrap";
import { startMarketWS } from "./wsMarket";
import { log } from "./log";

async function main() {
  // 1) Initial bootstrap: get the list of markets/token IDs and prep any caches.
  const tokenIds = await bootstrapPolymarket();
  // 2) Start streaming updates for those markets. Should handle reconnects internally.
  startMarketWS(tokenIds);
  // 3) Keep refreshing background data every 5 minutes to catch new/changed markets.
  setInterval(
    () =>
      bootstrapPolymarket().catch((e) => log.warn("periodic bootstrap err", e)),
    5 * 60 * 1000
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
