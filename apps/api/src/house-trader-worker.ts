import {
  loadHouseTraderKey,
  readHouseTraderPublicSettings,
} from "./services/house-trader-key.js";

let stopping = false;
let wake: (() => void) | undefined;
let close: (() => Promise<void>) | undefined;
let stage = "public_settings";
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    wake?.();
  });
}
try {
  const checkConfig =
    process.argv[2] === "--check-config" && process.argv.length === 3;
  if (process.argv.length > 2 && !checkConfig)
    throw new Error("unknown_house_trader_argument");
  const { expected } = readHouseTraderPublicSettings(process.env);
  stage = "aws_key";
  const { privateKey, controller } = await loadHouseTraderKey(expected);
  if (checkConfig) {
    console.info(
      JSON.stringify({
        ok: true,
        controller,
      }),
    );
  } else {
    // Load common application config separately; the dedicated key stays out
    // of process.env and is never taken from a common bundle.
    stage = "common_bundles";
    const { loadRuntimeSecrets } = await import("@hunch/config/secrets");
    process.env.HUNCH_SECRETS_MODE = "strict";
    process.env.HUNCH_SECRET_BUNDLES =
      "aws-sm:/hunch/prod/shared,aws-sm:/hunch/prod/api,aws-sm:/hunch/prod/polymarket-builder,aws-sm:/hunch/prod/ai";
    process.env.HUNCH_SECRET_REQUIRED_KEYS =
      "DATABASE_URL,JWT_SECRET,PRIVY_APP_ID,PRIVY_APP_SECRET,CREDENTIALS_ENCRYPTION_KEY,POLYGON_RPC_URL,POLYMARKET_BUILDER_API_KEY,POLYMARKET_BUILDER_API_SECRET,POLYMARKET_BUILDER_API_PASSPHRASE";
    await loadRuntimeSecrets({
      envPath: "/dev/null",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      forbiddenBundleKeys: new Set(["HUNCH_HOUSE_TRADER_PRIVATE_KEY"]),
    });
    stage = "runtime";
    const [{ pool }, { houseTick }, { HouseWallet }] = await Promise.all([
      import("./db.js"),
      import("./services/house-trader-runner.js"),
      import("./services/house-trader-wallet.js"),
    ]);
    close = () => pool.end();
    const wallet = new HouseWallet(privateKey);
    console.info("house_trader_started");
    while (!stopping) {
      try {
        await houseTick(pool, wallet);
      } catch {
        console.warn("house_trader_tick_failed");
      }
      if (!stopping)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = undefined;
            resolve();
          }, 60_000);
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
    }
  }
} catch {
  // Provider/SDK errors may contain secrets or URLs. Never log the exception.
  console.error("house_trader_configuration_failed", stage);
  process.exitCode = 1;
} finally {
  await close?.();
}
