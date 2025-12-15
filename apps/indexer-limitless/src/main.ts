import { bootstrapLimitless } from "./bootstrap.js";
import { log } from "./log.js";
import { formatPgError, isPgSetupIssue } from "@hunch/infra";

let bootstrapping = false;

async function periodicBootstrap() {
  if (bootstrapping) return; // skip if one is running
  bootstrapping = true;
  try {
    await bootstrapLimitless();
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
  // 2) Start streaming updates for those markets. Should handle reconnects internally.
  //   startMarketWS(_tokenIds);
  // 3) Keep refreshing background data every 5 minutes to catch new/changed markets.
  setInterval(periodicBootstrap, 5 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
