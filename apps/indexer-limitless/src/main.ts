import { bootstrapLimitless } from "./bootstrap.js";
import { log } from "./log.js";

async function main() {
  // 1) Initial bootstrap: get the list of markets/token IDs and prep any caches.
  const _tokenIds = await bootstrapLimitless();
  // 2) Start streaming updates for those markets. Should handle reconnects internally.
  //   startMarketWS(_tokenIds);
  // 3) Keep refreshing background data every 5 minutes to catch new/changed markets.
  setInterval(
    () =>
      bootstrapLimitless().catch((e) => log.warn("periodic bootstrap err", e)),
    5 * 60 * 1000,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
